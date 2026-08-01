"""Persistent per-session token/cost tracking for Claude Code sessions.

Ingests Claude Code JSONL conversation files into SQLite so that usage history
survives JSONL deletion. Stdlib only (sqlite3, json, pathlib, time, datetime,
logging, threading).
"""

from __future__ import annotations

import app_paths

import json
import logging
import re
import sqlite3
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath

import pricing_store as pricing_store_module
from pricing_store import PricingStore

_SUMMARY_WINDOWS = ("session", "24h", "7d", "lifetime")
# Reports page ranges (range_report) -- deliberately distinct from the
# dashboard's _SUMMARY_WINDOWS: calendar ranges, no per-process "session".
_RANGE_KEYS = ("24h", "7d", "30d", "all")

logger = logging.getLogger("cockpit.usage")

# Pricing in USD per 1M tokens. cache_write = 1.25x input, cache_read = 0.1x input.
PRICING = {
    "claude-fable-5":  {"input": 10.0, "output": 50.0},
    "claude-mythos":   {"input": 10.0, "output": 50.0},
    "claude-opus":     {"input": 5.0,  "output": 25.0},
    "claude-sonnet":   {"input": 3.0,  "output": 15.0},
    "claude-haiku":    {"input": 1.0,  "output": 5.0},
}
DEFAULT_PRICING = {"input": 5.0, "output": 25.0}

_CACHE_WRITE_MULT = 1.25
_CACHE_READ_MULT = 0.1


# price_source values stored on every usage_events row. These are the ONLY
# three values, and they map 1:1 onto the `cost_basis` counts reported by
# range_report -- so the UI can never imply a retroactively-priced figure was
# locked in at the time.
PRICE_SOURCE_EXACT = "exact"        # priced at ingest with the rate in effect then
PRICE_SOURCE_BACKFILL = "backfill"  # priced after the fact (pre-migration row)
PRICE_SOURCE_UNPRICED = "unpriced"  # no price on file at all -> contributes $0


def _pricing_for(model: str) -> dict:
    """Longest-matching-prefix lookup of the model id; fall back to DEFAULT_PRICING."""
    model = model or ""
    best_key = None
    for key in PRICING:
        if model.startswith(key):
            if best_key is None or len(key) > len(best_key):
                best_key = key
    if best_key is None:
        return DEFAULT_PRICING
    return PRICING[best_key]


def _row_cost(
    model: str,
    input_tokens: int,
    output_tokens: int,
    cache_creation_tokens: int,
    cache_read_tokens: int,
) -> float:
    """Cost in USD for a single usage row."""
    p = _pricing_for(model)
    in_price = p["input"]
    out_price = p["output"]
    total = (
        input_tokens * in_price
        + output_tokens * out_price
        + cache_creation_tokens * (in_price * _CACHE_WRITE_MULT)
        + cache_read_tokens * (in_price * _CACHE_READ_MULT)
    )
    return total / 1_000_000


def _cost_from_price(
    price: dict | None,
    input_tokens: int,
    output_tokens: int,
    cache_creation_tokens: int,
    cache_read_tokens: int,
) -> float:
    """Cost in USD from a *specific* price snapshot row (see pricing_store).

    ``price=None`` means "no price on file" and yields 0.0 -- we never invent a
    rate, because a fabricated cost is worse than a visibly missing one (the
    row is labelled ``unpriced`` and its tokens still appear).

    A ``None`` cache rate means the vendor does not publish one, so it is
    DERIVED from input at Anthropic's documented multipliers (write 1.25x, read
    0.1x) -- the same math ``_row_cost`` has always used. A cache rate of 0.0 is
    a real published "free" and is used as-is.
    """
    if price is None:
        return 0.0
    in_price = price.get("input_per_mtok")
    out_price = price.get("output_per_mtok")
    in_price = float(in_price) if in_price is not None else 0.0
    out_price = float(out_price) if out_price is not None else 0.0

    write_price = price.get("cache_write_per_mtok")
    write_price = float(write_price) if write_price is not None else in_price * _CACHE_WRITE_MULT
    read_price = price.get("cache_read_per_mtok")
    read_price = float(read_price) if read_price is not None else in_price * _CACHE_READ_MULT

    total = (
        input_tokens * in_price
        + output_tokens * out_price
        + cache_creation_tokens * write_price
        + cache_read_tokens * read_price
    )
    return total / 1_000_000


def _pricing_table_seed_rows() -> list[dict]:
    """The verified in-module PRICING table as pricing_store snapshot rows.

    PRICING stays the single source of truth for Anthropic family rates; this
    just projects it into the price store so ingest-time costing has something
    to look up. Cache rates are left None so ``_cost_from_price`` derives them
    with the same multipliers ``_row_cost`` uses -- the two paths agree to the
    cent.
    """
    rows = [
        {
            "model": key,
            "provider": "anthropic",
            "input_per_mtok": float(rates["input"]),
            "output_per_mtok": float(rates["output"]),
            "cache_read_per_mtok": None,
            "cache_write_per_mtok": None,
        }
        for key, rates in PRICING.items()
    ]
    return rows


def _default_db_path() -> Path:
    return app_paths.data_path("usage.sqlite3")


class UsageTracker:
    def __init__(self, db_path: Path | None = None, pricing: PricingStore | None = None):
        """Open (or create) the usage DB and bind a price store to it.

        The price store is what makes cost historically honest: cost is frozen
        onto each row at ingest using the rate that was in effect at the event's
        timestamp, and every report SUMS those stored values instead of
        recomputing from today's prices.

        Binding rules, chosen so tests are automatically isolated:
          * explicit ``pricing`` -> use it (caller owns its lifetime);
          * default ``db_path`` -> the process-wide ``pricing_store`` singleton;
          * custom ``db_path`` -> a PricingStore SIBLING of that file. A test
            pointing the usage DB at tmp_path must never read or write the real
            user's price history.
        """
        default_location = db_path is None
        if db_path is None:
            db_path = _default_db_path()
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # Per-file byte offset cache for incremental ingest (keyed by jsonl_path).
        self._offsets: dict[str, int] = {}
        # ISO timestamp captured at process start — powers the "session" window
        # for summary(): usage since this tracker instance came up.
        self._started_at = datetime.now(timezone.utc).isoformat()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.Error:
            logger.warning("Failed to set WAL mode on %s", self.db_path, exc_info=True)

        if pricing is not None:
            self._pricing = pricing
            self._owns_pricing = False
        elif default_location:
            self._pricing = pricing_store_module.pricing_store
            self._owns_pricing = False
        else:
            self._pricing = PricingStore(self.db_path.parent / "pricing.sqlite3")
            self._owns_pricing = True

        self._init_schema()
        self._seed_pricing()
        self._backfill_costs()

    # -- pricing ---------------------------------------------------------------

    def _seed_pricing(self) -> None:
        """Ensure baseline price snapshots exist (first run only, in effect).

        Both seeds are appended with ``effective_from = EPOCH`` because these
        are hand-maintained list prices with no known change date -- if they
        were stamped "now", every already-ingested historical event would price
        at $0. record_snapshot is change-only, so a second call writes nothing.
        Best-effort: pricing problems must never stop usage tracking.
        """
        try:
            written = self._pricing.seed(
                pricing_store_module.load_json_seed_rows(), pricing_store_module.SOURCE_JSON
            )
            written += self._pricing.seed(
                _pricing_table_seed_rows(), pricing_store_module.SOURCE_DEFAULT
            )
            if written:
                logger.info("Seeded %d baseline model price snapshot(s)", written)
        except Exception:
            logger.error("Failed seeding baseline model prices", exc_info=True)

    def _cost_for_event(
        self, model: str, ts: str,
        input_tokens: int, output_tokens: int,
        cache_creation_tokens: int, cache_read_tokens: int,
    ) -> tuple[float, str]:
        """(cost_usd, price_source) for an event, priced AS OF its own timestamp.

        This is the honesty fix: the rate used is the one that was in effect
        when the turn happened, and the result is written onto the row. A later
        vendor price change appends a new snapshot and cannot move this number.

        An empty/absent timestamp is priced as of now -- we are observing the
        event now, so "now" is the most defensible stand-in, and it keeps the
        row labelled ``exact`` rather than pretending it was backfilled.
        """
        at = ts or datetime.now(timezone.utc).isoformat()
        try:
            price = self._pricing.price_for(model, at)
        except Exception:
            logger.error("Price lookup failed for %s @ %s", model, at, exc_info=True)
            price = None
        if price is None:
            return 0.0, PRICE_SOURCE_UNPRICED
        return _cost_from_price(
            price, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
        ), PRICE_SOURCE_EXACT

    def _backfill_costs(self) -> int:
        """One-time pass: price rows that predate cost-at-ingest.

        These rows were written by a build that had no stored cost, so their
        true at-the-time price is unknowable from the DB alone. We use the best
        price available (the rate in effect at the event ts if we have one,
        otherwise the newest rate on file) and label the row ``backfill`` --
        NOT ``exact``. ``range_report`` surfaces those counts as
        ``cost_basis.backfilled`` so the UI can say "part of this range was
        priced retroactively" instead of implying every figure was locked in.

        Rows for a model with no price on file at all become ``unpriced`` with
        cost 0.0 and keep every token they had. Returns rows updated.
        """
        try:
            with self._lock:
                rows = self._conn.execute(
                    "SELECT id, ts, model, input_tokens, output_tokens, "
                    "cache_creation_tokens, cache_read_tokens "
                    "FROM usage_events WHERE cost_usd IS NULL"
                ).fetchall()
        except sqlite3.Error:
            logger.warning("Cost backfill: failed selecting unpriced rows", exc_info=True)
            return 0

        if not rows:
            return 0

        updates: list[tuple] = []
        for r in rows:
            model = r["model"] or ""
            inp = r["input_tokens"] or 0
            out = r["output_tokens"] or 0
            cw = r["cache_creation_tokens"] or 0
            cr = r["cache_read_tokens"] or 0
            price = None
            try:
                if r["ts"]:
                    price = self._pricing.price_for(model, r["ts"])
                if price is None:
                    price = self._pricing.latest_price(model)
            except Exception:
                logger.error("Cost backfill: price lookup failed for %s", model, exc_info=True)
                price = None
            if price is None:
                updates.append((0.0, PRICE_SOURCE_UNPRICED, r["id"]))
            else:
                updates.append((
                    _cost_from_price(price, inp, out, cw, cr),
                    PRICE_SOURCE_BACKFILL,
                    r["id"],
                ))

        with self._lock:
            try:
                self._conn.executemany(
                    "UPDATE usage_events SET cost_usd = ?, price_source = ? WHERE id = ?",
                    updates,
                )
                self._conn.commit()
            except sqlite3.Error:
                logger.warning("Cost backfill: failed writing %d row(s)", len(updates), exc_info=True)
                return 0
        logger.info("Backfilled frozen cost onto %d pre-existing usage row(s)", len(updates))
        return len(updates)

    def _init_schema(self) -> None:
        with self._lock:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS usage_events (
                  id INTEGER PRIMARY KEY,
                  terminal_id TEXT NOT NULL,
                  jsonl_path TEXT NOT NULL,
                  message_uuid TEXT NOT NULL,
                  ts TEXT NOT NULL,
                  model TEXT NOT NULL,
                  input_tokens INTEGER NOT NULL DEFAULT 0,
                  output_tokens INTEGER NOT NULL DEFAULT 0,
                  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
                  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                  /* Cost is FROZEN here at ingest, priced with the rate that
                     was in effect at `ts`. Reports SUM this column and never
                     recompute from current prices, so a vendor price change
                     cannot retroactively move a past report. NULL only ever
                     means "written by a build older than this column" and is
                     resolved once by _backfill_costs(). */
                  cost_usd REAL,
                  price_source TEXT,
                  UNIQUE(jsonl_path, message_uuid)
                );
                CREATE INDEX IF NOT EXISTS idx_usage_terminal ON usage_events(terminal_id);
                CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);

                CREATE TABLE IF NOT EXISTS local_runs (
                  id INTEGER PRIMARY KEY,
                  ts TEXT NOT NULL,
                  terminal_id TEXT,
                  workdir TEXT,
                  provider_id TEXT NOT NULL,
                  model TEXT,
                  input_tokens INTEGER,
                  output_tokens INTEGER,
                  wall_ms REAL
                );
                CREATE INDEX IF NOT EXISTS idx_local_runs_terminal ON local_runs(terminal_id);
                CREATE INDEX IF NOT EXISTS idx_local_runs_ts ON local_runs(ts);

                /* One row per tool_use content block in an assistant message.
                   An assistant turn can carry SEVERAL tool_use blocks, so the
                   message uuid alone is not a key -- (uuid, block_index) is.
                   That composite PK is what makes re-ingest idempotent: the
                   watcher routinely re-reads a JSONL (offset reset, file
                   rotation) and INSERT OR IGNORE must not inflate counters. */
                CREATE TABLE IF NOT EXISTS tool_events (
                  uuid TEXT NOT NULL,
                  block_index INTEGER NOT NULL,
                  terminal_id TEXT NOT NULL,
                  jsonl_path TEXT NOT NULL,
                  ts TEXT NOT NULL,
                  model TEXT NOT NULL DEFAULT '',
                  tool_name TEXT NOT NULL DEFAULT 'unknown',
                  workdir TEXT,
                  PRIMARY KEY (uuid, block_index)
                );
                CREATE INDEX IF NOT EXISTS idx_tool_events_terminal ON tool_events(terminal_id);
                CREATE INDEX IF NOT EXISTS idx_tool_events_ts ON tool_events(ts);
                CREATE INDEX IF NOT EXISTS idx_tool_events_name ON tool_events(tool_name);
                """
            )
            self._conn.commit()
            self._migrate_add_column("usage_events", "workdir", "TEXT")
            # An existing pre-migration DB gains these in place -- ALTER TABLE
            # ADD COLUMN only, no table rewrite, so no row is lost. Existing
            # rows read NULL until _backfill_costs() labels them.
            self._migrate_add_column("usage_events", "cost_usd", "REAL")
            self._migrate_add_column("usage_events", "price_source", "TEXT")

    def _migrate_add_column(self, table: str, column: str, coltype: str) -> None:
        """Add *column* to an existing *table* if it isn't already there.
        Never touches/recreates the table -- existing rows survive untouched.
        Safe to call on a fresh DB too (the CREATE TABLE above already has
        every current column, so this is then a no-op).
        """
        try:
            existing = {row[1] for row in self._conn.execute(f"PRAGMA table_info({table})").fetchall()}
            if column not in existing:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {coltype}")
                self._conn.commit()
        except sqlite3.Error:
            logger.warning("Failed migrating column %s.%s", table, column, exc_info=True)

    # -- ingestion ------------------------------------------------------------

    def record_local_run(
        self,
        *,
        terminal_id: str | None,
        provider_id: str,
        model: str | None,
        input_tokens: int | None,
        output_tokens: int | None,
        wall_ms: float | None,
        workdir: str | None = None,
    ) -> None:
        """Insert one row recording a completed local-provider run (vLLM or
        LM Studio, via the tagging shims). Best-effort -- NEVER raises into
        the request path; a failure here must not fail the user's request.

        ``input_tokens``/``output_tokens`` are stored as-observed: None when
        the upstream never reported usage (e.g. a streaming response whose
        upstream doesn't send a final usage chunk) rather than fabricated as
        0 -- matches the existing token-honesty convention (CLAUDE.md).
        """
        try:
            ts = datetime.now(timezone.utc).isoformat()
            with self._lock:
                self._conn.execute(
                    """
                    INSERT INTO local_runs
                      (ts, terminal_id, workdir, provider_id, model,
                       input_tokens, output_tokens, wall_ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (ts, terminal_id, workdir, provider_id, model,
                     input_tokens, output_tokens, wall_ms),
                )
                self._conn.commit()
        except Exception:
            logger.error("Failed recording local run for provider=%s terminal=%s", provider_id, terminal_id, exc_info=True)

    def ingest_jsonl(self, terminal_id: str, jsonl_path: str, workdir: str | None = None) -> int:
        """Parse Claude Code JSONL; insert one usage_events row per assistant
        message that carries a usage block, AND one tool_events row per
        ``tool_use`` content block in any assistant message. The two are
        independent: a turn may have usage without tools, tools without usage,
        or both. Tracks per-file byte offset in memory for incremental reads
        (falls back to a full re-read if the file shrank).

        Returns number of new *usage* rows (unchanged contract -- callers use
        this as a token-activity signal). Tool-event inserts are counted
        separately for logging only. Both inserts are INSERT OR IGNORE against
        their unique keys, so re-ingesting the same lines is idempotent.
        Never raises on malformed lines — logs and skips."""
        path = Path(jsonl_path)
        key = str(jsonl_path)
        try:
            current_size = path.stat().st_size
        except OSError:
            # File missing/unreadable — nothing new to ingest.
            return 0

        prev_offset = self._offsets.get(key, 0)
        if current_size < prev_offset:
            # File shrank/rotated → full re-read (INSERT OR IGNORE handles dedupe).
            prev_offset = 0

        if current_size == prev_offset:
            return 0

        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(prev_offset)
                data = f.read()
                new_offset = f.tell()
        except OSError:
            logger.warning("Failed reading JSONL %s", jsonl_path, exc_info=True)
            return 0

        rows = []
        tool_rows = []
        for line in data.split("\n"):
            line = line.strip()
            if not line:
                continue
            row, line_tools = self._parse_line(terminal_id, key, line, workdir)
            if row is not None:
                rows.append(row)
            if line_tools:
                tool_rows.extend(line_tools)

        inserted = 0
        if rows:
            with self._lock:
                try:
                    cur = self._conn.executemany(
                        """
                        INSERT OR IGNORE INTO usage_events
                          (terminal_id, jsonl_path, message_uuid, ts, model,
                           input_tokens, output_tokens,
                           cache_creation_tokens, cache_read_tokens, workdir,
                           cost_usd, price_source)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        rows,
                    )
                    inserted = cur.rowcount if cur.rowcount is not None else 0
                    self._conn.commit()
                except sqlite3.Error:
                    logger.warning("Failed inserting usage rows for %s", terminal_id, exc_info=True)
                    inserted = 0

        if tool_rows:
            with self._lock:
                try:
                    self._conn.executemany(
                        """
                        INSERT OR IGNORE INTO tool_events
                          (uuid, block_index, terminal_id, jsonl_path, ts,
                           model, tool_name, workdir)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        tool_rows,
                    )
                    self._conn.commit()
                except sqlite3.Error:
                    logger.warning("Failed inserting tool rows for %s", terminal_id, exc_info=True)

        self._offsets[key] = new_offset
        return inserted

    def _parse_line(
        self, terminal_id: str, jsonl_path: str, line: str, workdir: str | None = None
    ) -> tuple[tuple | None, list[tuple]]:
        """Parse one JSONL line into ``(usage_row_or_None, tool_rows)``.

        The two outputs are produced INDEPENDENTLY on purpose. An assistant turn
        that calls tools frequently carries no ``usage`` block, and a turn that
        reports usage frequently carries no tool_use blocks; an early ``return``
        on a missing ``usage`` (the previous behaviour) silently discarded every
        tool call on such turns. Nothing below may short-circuit past the other
        extractor.
        """
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            logger.debug("Skipping malformed JSONL line in %s", jsonl_path, exc_info=True)
            return None, []
        if not isinstance(obj, dict):
            return None, []
        if obj.get("type") != "assistant":
            return None, []
        uuid = obj.get("uuid")
        if not uuid:
            return None, []
        msg = obj.get("message")
        if not isinstance(msg, dict):
            return None, []

        model = msg.get("model") or ""
        ts = obj.get("timestamp") or ""

        usage_row = self._usage_row(terminal_id, jsonl_path, uuid, ts, model, msg, workdir)
        if usage_row is not None:
            # Freeze the cost onto the row NOW, at the rate in effect at `ts`.
            # Indices 5..8 are input/output/cache_creation/cache_read.
            cost, source = self._cost_for_event(
                model, ts, usage_row[5], usage_row[6], usage_row[7], usage_row[8]
            )
            usage_row = usage_row + (cost, source)
        tool_rows = self._tool_rows(terminal_id, jsonl_path, uuid, ts, model, msg, workdir)
        return usage_row, tool_rows

    @staticmethod
    def _usage_row(terminal_id, jsonl_path, uuid, ts, model, msg: dict, workdir) -> tuple | None:
        """usage_events row for this assistant message, or None if it reports no usage."""
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            return None

        def _int(v) -> int:
            try:
                return int(v or 0)
            except (TypeError, ValueError):
                return 0

        return (
            terminal_id,
            jsonl_path,
            uuid,
            ts,
            model,
            _int(usage.get("input_tokens")),
            _int(usage.get("output_tokens")),
            _int(usage.get("cache_creation_input_tokens")),
            _int(usage.get("cache_read_input_tokens")),
            workdir,
        )

    @staticmethod
    def _tool_rows(terminal_id, jsonl_path, uuid, ts, model, msg: dict, workdir) -> list[tuple]:
        """One tool_events row per ``tool_use`` content block.

        Block shape matches jsonl_watcher's reading of the same files: content
        is a list of blocks, a tool call is ``{"type": "tool_use", "name": ...,
        "id": ...}``. ``block_index`` is the block's position in that list, so
        several tool calls in one message get distinct keys and stay stable
        across re-ingest. A block whose ``name`` is missing/blank records
        ``"unknown"`` rather than being skipped -- a call still happened.
        A malformed individual block is skipped without aborting the rest.
        """
        content = msg.get("content")
        if not isinstance(content, list):
            return []
        rows: list[tuple] = []
        for idx, block in enumerate(content):
            try:
                if not isinstance(block, dict):
                    continue
                if block.get("type") != "tool_use":
                    continue
                name = block.get("name")
                tool_name = str(name).strip() if name is not None else ""
                if not tool_name:
                    tool_name = "unknown"
                rows.append((uuid, idx, terminal_id, jsonl_path, ts, model, tool_name, workdir))
            except Exception:
                logger.debug(
                    "Skipping malformed tool_use block %s[%s] in %s", uuid, idx, jsonl_path,
                    exc_info=True,
                )
                continue
        return rows

    # -- summaries ------------------------------------------------------------

    def latest_turn(self, terminal_id: str) -> dict | None:
        """The MOST RECENT assistant turn recorded for one terminal.

        Returns ``{"ts", "model", "input_tokens", "cache_read_tokens"}`` or
        ``None`` when the terminal has no usage_events rows at all.

        Additive read-only helper for the context ring: context occupancy is the
        size of the CURRENT prompt (``input_tokens + cache_read_tokens`` of the
        last turn), never a sum over turns — a sum measures cumulative traffic
        and grows past any window forever. Deliberately does NOT touch cost or
        pricing columns; it is not a summary and must not be used as one.

        Ordering is ``ts DESC, rowid DESC``: ISO-8601 timestamps sort
        lexicographically, and rowid breaks the tie when two turns share a
        timestamp (the later-ingested row is the later turn).
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT ts, model, input_tokens, cache_read_tokens "
                "FROM usage_events WHERE terminal_id = ? "
                "ORDER BY ts DESC, rowid DESC LIMIT 1",
                (terminal_id,),
            ).fetchone()
        if row is None:
            return None
        return {
            "ts": row["ts"],
            "model": row["model"],
            "input_tokens": row["input_tokens"] or 0,
            "cache_read_tokens": row["cache_read_tokens"] or 0,
        }

    def session_summary(self, terminal_id: str) -> dict:
        with self._lock:
            rows = self._conn.execute(
                "SELECT model, input_tokens, output_tokens, "
                "cache_creation_tokens, cache_read_tokens, ts, cost_usd "
                "FROM usage_events WHERE terminal_id = ?",
                (terminal_id,),
            ).fetchall()

        inp = out = cc = cr = 0
        cost = 0.0
        models: list[str] = []
        last_ts: str | None = None
        for r in rows:
            inp += r["input_tokens"]
            out += r["output_tokens"]
            cc += r["cache_creation_tokens"]
            cr += r["cache_read_tokens"]
            # Stored (frozen-at-ingest) cost -- never recomputed from current
            # prices, so this figure cannot drift when a rate changes.
            cost += r["cost_usd"] or 0.0
            m = r["model"]
            if m and m not in models:
                models.append(m)
            ts = r["ts"]
            if ts and (last_ts is None or ts > last_ts):
                last_ts = ts

        total = inp + out + cc + cr
        return {
            "terminal_id": terminal_id,
            "input_tokens": inp,
            "output_tokens": out,
            "cache_creation_tokens": cc,
            "cache_read_tokens": cr,
            "total_tokens": total,
            "est_cost_usd": round(cost, 4),
            "models": models,
            "last_event_ts": last_ts,
        }

    def daily_summary(self, day: str | None = None) -> dict:
        if day is None:
            day = date.today().isoformat()
        # Match rows whose ISO timestamp date component equals `day`.
        like = f"{day}%"
        with self._lock:
            rows = self._conn.execute(
                "SELECT terminal_id, model, input_tokens, output_tokens, "
                "cache_creation_tokens, cache_read_tokens, cost_usd "
                "FROM usage_events WHERE substr(ts, 1, 10) = ?",
                (day,),
            ).fetchall()

        inp = out = cc = cr = 0
        cost = 0.0
        by_model: dict[str, dict] = {}
        by_terminal: dict[str, float] = {}
        for r in rows:
            row_cost = r["cost_usd"] or 0.0
            inp += r["input_tokens"]
            out += r["output_tokens"]
            cc += r["cache_creation_tokens"]
            cr += r["cache_read_tokens"]
            cost += row_cost

            m = r["model"] or ""
            bm = by_model.setdefault(
                m, {"est_cost_usd": 0.0, "input_tokens": 0, "output_tokens": 0}
            )
            bm["est_cost_usd"] += row_cost
            bm["input_tokens"] += r["input_tokens"]
            bm["output_tokens"] += r["output_tokens"]

            tid = r["terminal_id"]
            by_terminal[tid] = by_terminal.get(tid, 0.0) + row_cost

        for m in by_model:
            by_model[m]["est_cost_usd"] = round(by_model[m]["est_cost_usd"], 4)
        for tid in by_terminal:
            by_terminal[tid] = round(by_terminal[tid], 4)

        return {
            "day": day,
            "est_cost_usd": round(cost, 4),
            "input_tokens": inp,
            "output_tokens": out,
            "cache_creation_tokens": cc,
            "cache_read_tokens": cr,
            "by_model": by_model,
            "by_terminal": by_terminal,
        }

    def summary(self, window: str = "lifetime") -> dict:
        """API-side usage summary for the Routing & Reporting dashboard.

        `window` in {'session','24h','7d','lifetime'}. Aggregates the same
        usage_events store as session_summary/daily_summary, filtered by ts.
        Cost is the SUM of each row's frozen-at-ingest `cost_usd` — never
        recomputed from current prices, so a vendor rate change cannot move a
        past window's total.

        The store does not carry TTFT or wall-clock timing, so ttft_ms and
        wall_ms are always emitted as null (per-percentile). errors_total is
        always 0 — the JSONL ingest only sees successful assistant turns.
        """
        if window not in _SUMMARY_WINDOWS:
            window = "lifetime"

        cutoff: str | None = None
        if window == "session":
            cutoff = self._started_at
        elif window == "24h":
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        elif window == "7d":
            cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

        with self._lock:
            if cutoff is None:
                rows = self._conn.execute(
                    "SELECT model, input_tokens, output_tokens, "
                    "cache_creation_tokens, cache_read_tokens, cost_usd FROM usage_events"
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT model, input_tokens, output_tokens, "
                    "cache_creation_tokens, cache_read_tokens, cost_usd "
                    "FROM usage_events WHERE ts >= ?",
                    (cutoff,),
                ).fetchall()

        prompt_tokens = completion_tokens = 0
        cost = 0.0
        by_model: dict[str, dict] = {}
        for r in rows:
            row_cost = r["cost_usd"] or 0.0
            prompt_tokens += r["input_tokens"]
            completion_tokens += r["output_tokens"]
            cost += row_cost

            m = r["model"] or ""
            bm = by_model.setdefault(m, {"model": m, "runs": 0, "tokens": 0, "cost_usd": 0.0})
            bm["runs"] += 1
            bm["tokens"] += (
                r["input_tokens"] + r["output_tokens"]
                + r["cache_creation_tokens"] + r["cache_read_tokens"]
            )
            bm["cost_usd"] += row_cost

        for m in by_model:
            by_model[m]["cost_usd"] = round(by_model[m]["cost_usd"], 4)

        return {
            "window": window,
            "runs": len(rows),
            "tokens": {"prompt": prompt_tokens, "completion": completion_tokens},
            "ttft_ms": {"p50": None, "p95": None},
            "wall_ms": {"p50": None, "p95": None},
            "errors_total": 0,
            "cost_usd": round(cost, 4),
            "by_model": sorted(by_model.values(), key=lambda b: b["tokens"], reverse=True),
        }

    # -- merged per-model report (Anthropic/OpenRouter + local) --------------

    _FAMILY_RE = re.compile(r"(opus|sonnet|haiku|fable|mythos)", re.IGNORECASE)

    @staticmethod
    def _repo_from_workdir(workdir: str | None) -> str:
        """Basename of *workdir* as the repo label; null/empty -> 'unknown'.
        Uses pathlib so both Windows (`C:\\Code\\foo`) and POSIX
        (`/home/x/bar`) paths resolve correctly regardless of host OS."""
        if not workdir:
            return "unknown"
        name = PureWindowsPath(workdir).name if "\\" in workdir else PurePosixPath(workdir).name
        return name or "unknown"

    @classmethod
    def _classify_anthropic_side(cls, model: str) -> tuple[str, str]:
        """Classify a usage_events model id as ('anthropic'|'openrouter', family).

        Cockpit can route a session through OpenRouter, and those runs land in
        the same JSONL / usage_events table as native Anthropic runs. OpenRouter
        model ids carry a "/" (e.g. "deepseek/deepseek-v4-pro"); native Anthropic
        ids never do. Anything without a "/" is treated as anthropic and further
        classified into a family via regex on opus/sonnet/haiku/fable/mythos.
        """
        if "/" in (model or ""):
            return "openrouter", model or "Other"
        m = cls._FAMILY_RE.search(model or "")
        family = m.group(1).capitalize() if m else "Other"
        return "anthropic", family

    def model_report(self, window: str = "lifetime") -> dict:
        """Merged, provider-tagged per-model usage view across every pipeline
        Cockpit actually observes: Anthropic + OpenRouter runs (usage_events,
        ingested from Claude Code JSONL) and local-provider runs (local_runs,
        recorded by the vLLM/LM Studio tagging shims). This is the merge point
        -- both pipelines are read here but neither is altered.

        Raises ValueError on an unrecognized window (unlike summary(), which
        silently falls back to lifetime) so the route can 400 instead of
        silently serving the wrong window.
        """
        if window not in _SUMMARY_WINDOWS:
            raise ValueError(f"window must be one of {_SUMMARY_WINDOWS}")

        cutoff: str | None = None
        if window == "session":
            cutoff = self._started_at
        elif window == "24h":
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat()
        elif window == "7d":
            cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

        with self._lock:
            if cutoff is None:
                anthro_rows = self._conn.execute(
                    "SELECT model, input_tokens, output_tokens, "
                    "cache_creation_tokens, cache_read_tokens, workdir, cost_usd "
                    "FROM usage_events"
                ).fetchall()
                local_rows = self._conn.execute(
                    "SELECT provider_id, model, input_tokens, output_tokens, workdir "
                    "FROM local_runs"
                ).fetchall()
            else:
                anthro_rows = self._conn.execute(
                    "SELECT model, input_tokens, output_tokens, "
                    "cache_creation_tokens, cache_read_tokens, workdir, cost_usd "
                    "FROM usage_events WHERE ts >= ?",
                    (cutoff,),
                ).fetchall()
                local_rows = self._conn.execute(
                    "SELECT provider_id, model, input_tokens, output_tokens, workdir "
                    "FROM local_runs WHERE ts >= ?",
                    (cutoff,),
                ).fetchall()

        # key -> accumulator
        acc: dict[tuple, dict] = {}

        for r in anthro_rows:
            model = r["model"] or ""
            provider, family = self._classify_anthropic_side(model)
            key = (provider, None, model)
            entry = acc.setdefault(key, {
                "model": model, "provider": provider, "provider_id": None,
                "family": family, "runs": 0,
                "input_tokens": 0, "output_tokens": 0, "tokens": 0,
                "cost_usd": 0.0, "_repo_runs": {}, "_repo_tokens": {},
                "_has_real_tokens": False,
            })
            entry["runs"] += 1
            entry["input_tokens"] += r["input_tokens"]
            entry["output_tokens"] += r["output_tokens"]
            row_tokens = (
                r["input_tokens"] + r["output_tokens"]
                + r["cache_creation_tokens"] + r["cache_read_tokens"]
            )
            entry["tokens"] += row_tokens
            if row_tokens:
                entry["_has_real_tokens"] = True
            entry["cost_usd"] += r["cost_usd"] or 0.0
            repo = self._repo_from_workdir(r["workdir"])
            entry["_repo_runs"][repo] = entry["_repo_runs"].get(repo, 0) + 1
            entry["_repo_tokens"][repo] = entry["_repo_tokens"].get(repo, 0) + row_tokens

        for r in local_rows:
            model = r["model"] or ""
            provider_id = r["provider_id"]
            key = ("local", provider_id, model)
            entry = acc.setdefault(key, {
                "model": model, "provider": "local", "provider_id": provider_id,
                "family": model or "Other", "runs": 0,
                "input_tokens": 0, "output_tokens": 0, "tokens": 0,
                "cost_usd": None, "_repo_runs": {}, "_repo_tokens": {},
                "_has_real_tokens": False,
            })
            entry["runs"] += 1
            it = r["input_tokens"] or 0
            ot = r["output_tokens"] or 0
            entry["input_tokens"] += it
            entry["output_tokens"] += ot
            row_tokens = it + ot
            entry["tokens"] += row_tokens
            if r["input_tokens"] or r["output_tokens"]:
                entry["_has_real_tokens"] = True
            repo = self._repo_from_workdir(r["workdir"])
            entry["_repo_runs"][repo] = entry["_repo_runs"].get(repo, 0) + 1
            entry["_repo_tokens"][repo] = entry["_repo_tokens"].get(repo, 0) + row_tokens

        models: list[dict] = []
        total_runs = 0
        total_tokens = 0
        any_real_tokens = False
        total_cost = 0.0
        any_cost = False

        for entry in acc.values():
            repos = []
            for repo in entry["_repo_runs"]:
                repos.append({
                    "repo": repo,
                    "runs": entry["_repo_runs"][repo],
                    "tokens": entry["_repo_tokens"][repo],
                })
            repos.sort(key=lambda b: (b["tokens"], b["runs"]), reverse=True)

            has_real_tokens = entry["_has_real_tokens"]
            out_tokens = entry["tokens"] if has_real_tokens else None
            out_input = entry["input_tokens"] if has_real_tokens else None
            out_output = entry["output_tokens"] if has_real_tokens else None

            cost_usd = entry["cost_usd"]
            if cost_usd is not None:
                cost_usd = round(cost_usd, 4)
                total_cost += cost_usd
                any_cost = True

            models.append({
                "model": entry["model"],
                "provider": entry["provider"],
                "provider_id": entry["provider_id"],
                "family": entry["family"],
                "runs": entry["runs"],
                "input_tokens": out_input,
                "output_tokens": out_output,
                "tokens": out_tokens,
                "cost_usd": cost_usd,
                "by_repo": repos,
            })

            total_runs += entry["runs"]
            if has_real_tokens:
                total_tokens += entry["tokens"]
                any_real_tokens = True

        # Biggest consumer first; null-token rows sort after real-token rows.
        models.sort(
            key=lambda m: (
                m["tokens"] if m["tokens"] is not None else -1,
                m["runs"],
            ),
            reverse=True,
        )

        return {
            "window": window,
            "models": models,
            "totals": {
                "runs": total_runs,
                "tokens": total_tokens if any_real_tokens else None,
                "cost_usd": round(total_cost, 4) if any_cost else None,
            },
        }

    # -- Reports page: one-shot range report -----------------------------------

    @staticmethod
    def _range_span(range_key: str) -> timedelta | None:
        """Length of *range_key* as a timedelta; None for 'all' (unbounded)."""
        return {
            "24h": timedelta(hours=24),
            "7d": timedelta(days=7),
            "30d": timedelta(days=30),
            "all": None,
        }[range_key]

    def _window_rows(self, start: str | None, end: str | None) -> tuple[list, list, list]:
        """Fetch usage/local/tool rows whose ts falls in ``[start, end)``.

        Either bound may be None (unbounded). This is the ONLY row-fetch path
        used by range_report, for both the current and the prior period, so the
        two periods can never diverge in what they count.
        """
        clauses: list[str] = []
        params: list[str] = []
        if start is not None:
            clauses.append("ts >= ?")
            params.append(start)
        if end is not None:
            clauses.append("ts < ?")
            params.append(end)
        where = (" WHERE " + " AND ".join(clauses)) if clauses else ""

        with self._lock:
            api_rows = self._conn.execute(
                "SELECT terminal_id, ts, model, input_tokens, output_tokens, "
                "cache_creation_tokens, cache_read_tokens, workdir, "
                "cost_usd, price_source "
                "FROM usage_events" + where,
                tuple(params),
            ).fetchall()
            local_rows = self._conn.execute(
                "SELECT terminal_id, ts, provider_id, model, input_tokens, "
                "output_tokens, workdir FROM local_runs" + where,
                tuple(params),
            ).fetchall()
            tool_rows = self._conn.execute(
                "SELECT terminal_id, ts, tool_name, workdir FROM tool_events" + where,
                tuple(params),
            ).fetchall()
        return api_rows, local_rows, tool_rows

    @staticmethod
    def _compute_kpis(api_rows: list, local_rows: list, tool_rows: list) -> dict:
        """The six headline KPIs for a window. Single source of truth -- the
        current period and the prior period both go through here, so a delta is
        always a comparison of two identically-computed numbers."""
        tot_in = tot_out = tot_cw = tot_cr = tot_local = 0
        tot_cost = 0.0
        for r in api_rows:
            inp = r["input_tokens"] or 0
            out = r["output_tokens"] or 0
            cw = r["cache_creation_tokens"] or 0
            cr = r["cache_read_tokens"] or 0
            tot_in += inp
            tot_out += out
            tot_cw += cw
            tot_cr += cr
            # Frozen-at-ingest cost. Deliberately NOT recomputed here: this is
            # the single point where a retroactive re-price would have leaked
            # into both the current and the prior period.
            tot_cost += r["cost_usd"] or 0.0
        for r in local_rows:
            tot_local += (r["input_tokens"] or 0) + (r["output_tokens"] or 0)

        total_tokens = tot_in + tot_out + tot_cw + tot_cr + tot_local
        cache_denom = tot_cr + tot_in
        return {
            "total_tokens": total_tokens,
            "cost": round(tot_cost, 4),
            "cache_hit_rate": round((tot_cr / cache_denom) if cache_denom else 0.0, 6),
            "local_share": round((tot_local / total_tokens) if total_tokens else 0.0, 6),
            "turns": len(api_rows) + len(local_rows),
            "tool_calls": len(tool_rows),
        }

    def _previous_period(self, range_key: str, now: datetime) -> dict:
        """The immediately preceding window of EQUAL length.

        24h -> the 24h before this 24h; 7d -> the 7 days before these 7 days.
        'all' has no meaningful prior period, and a window with genuinely no
        rows reports available=False so the UI renders no delta instead of a
        misleading +100%.
        """
        span = self._range_span(range_key)
        if span is None:
            return {"available": False, "kpis": None}
        end = (now - span).isoformat()
        start = (now - span - span).isoformat()
        api_rows, local_rows, tool_rows = self._window_rows(start, end)
        if not api_rows and not local_rows and not tool_rows:
            return {"available": False, "kpis": None}
        return {"available": True, "kpis": self._compute_kpis(api_rows, local_rows, tool_rows)}

    def _tool_events_since(self) -> str | None:
        """Earliest tool event ts in the WHOLE store, or None if none exist.

        Deliberately not range-scoped: rows ingested before tool tracking
        existed carry no tool events, so a range that predates this timestamp is
        only partially covered. The UI uses this to say "tool calls recorded
        since <date>" rather than implying full coverage.
        """
        try:
            with self._lock:
                row = self._conn.execute(
                    "SELECT MIN(ts) AS first_ts FROM tool_events WHERE ts != ''"
                ).fetchone()
            return row["first_ts"] if row and row["first_ts"] else None
        except sqlite3.Error:
            logger.warning("Failed reading earliest tool event ts", exc_info=True)
            return None

    def range_report(self, range_key: str = "7d") -> dict:
        """Everything the Reports page renders, in one query pass.

        `range_key` in {'24h','7d','30d','all'}; raises ValueError otherwise so
        the route can 400 rather than silently serving the wrong window.

        Formulas (single source of truth -- the UI must not recompute these):
          * cost            -- API-EQUIVALENT cost: the SUM of each event's
                               `cost_usd`, which was FROZEN at ingest using the
                               price in effect at that event's timestamp. It is
                               never recomputed from current prices, so a vendor
                               rate change appends a new price snapshot and
                               leaves every past report exactly where it was.
                               This is NOT a subscription bill; it is what the
                               same token volume would have cost at the list API
                               rates in effect at the time. A model with no
                               price on file contributes $0.00 but keeps all its
                               tokens; local-provider runs are costed at $0.00
                               and never contribute to `cost`.
          * cost_basis      -- {exact, backfilled, unpriced} counts of API
                               events in the window. `exact` = priced at ingest
                               with the then-current rate. `backfilled` = priced
                               after the fact (rows written before cost-at-
                               ingest existed) -- the UI must say part of the
                               range was priced retroactively rather than imply
                               those figures were locked in. `unpriced` = no
                               price on file; tokens counted, cost 0.
          * cache_hit_rate  = cache_read / (cache_read + input)   [0.0 when the
                               denominator is 0]
          * local_share     = local_tokens / total_tokens         [0.0 when
                               total_tokens is 0]
          * by_model.share  = model_tokens / total_tokens         [0.0 when
                               total_tokens is 0]
          * total_tokens    = input + output + cache_read + cache_write
                               (+ local input/output)
          * turns           = one row per assistant turn (usage_events) plus one
                               per recorded local run (local_runs)

        `by_day` is gap-filled: every calendar day (UTC) in the range is
        present, zero-valued where there was no activity, so a chart cannot
        misread a gap as the end of the data.

        `tool_calls` counts persisted ``tool_use`` blocks (tool_events). Rows
        ingested before tool tracking existed carry none, so `tool_events_since`
        reports the earliest tool event in the store -- a range starting before
        that timestamp is only partially covered, and the UI must say so rather
        than implying the whole range is accounted for.

        `previous` carries the same six KPIs for the immediately preceding
        window of equal length (see _previous_period).
        """
        if range_key not in _RANGE_KEYS:
            raise ValueError(f"range must be one of {_RANGE_KEYS}")

        now = datetime.now(timezone.utc)
        span = self._range_span(range_key)
        cutoff: str | None = (now - span).isoformat() if span is not None else None

        api_rows, local_rows, tool_rows = self._window_rows(cutoff, None)

        tot_local = 0
        by_day: dict[str, dict] = {}
        by_model: dict[tuple, dict] = {}
        sessions: dict[str, dict] = {}
        # How each API event in this window got its price. See range_report's
        # docstring -- this is what lets the UI avoid implying that a
        # retroactively-priced figure was locked in at the time.
        cost_basis = {"exact": 0, "backfilled": 0, "unpriced": 0}

        def _day_bucket(day: str) -> dict:
            return by_day.setdefault(day, {
                "day": day, "input": 0, "output": 0, "cache_read": 0,
                "cache_write": 0, "local": 0, "total": 0, "cost": 0.0,
            })

        def _session_bucket(tid: str, workdir) -> dict:
            b = sessions.get(tid)
            if b is None:
                b = sessions[tid] = {
                    "terminal_id": tid, "name": None,
                    "project": self._repo_from_workdir(workdir),
                    "model": None, "input": 0, "output": 0, "cache_read": 0,
                    "cache_write": 0, "local": 0, "total": 0, "turns": 0,
                    "cost": 0.0, "tool_calls": 0, "_models": {},
                }
            elif b["project"] == "unknown" and workdir:
                b["project"] = self._repo_from_workdir(workdir)
            return b

        for r in api_rows:
            inp = r["input_tokens"] or 0
            out = r["output_tokens"] or 0
            cw = r["cache_creation_tokens"] or 0
            cr = r["cache_read_tokens"] or 0
            row_total = inp + out + cw + cr
            model = r["model"] or ""
            row_cost = r["cost_usd"] or 0.0
            source = r["price_source"] or ""
            if source == PRICE_SOURCE_EXACT:
                cost_basis["exact"] += 1
            elif source == PRICE_SOURCE_BACKFILL:
                cost_basis["backfilled"] += 1
            else:
                # Includes NULL (a row a build older than the cost columns
                # wrote and that backfill has not yet touched) -- counted as
                # unpriced rather than quietly claimed as exact.
                cost_basis["unpriced"] += 1

            day = (r["ts"] or "")[:10] or now.date().isoformat()
            d = _day_bucket(day)
            d["input"] += inp
            d["output"] += out
            d["cache_read"] += cr
            d["cache_write"] += cw
            d["total"] += row_total
            d["cost"] += row_cost

            provider, _family = self._classify_anthropic_side(model)
            key = (provider, model)
            m = by_model.setdefault(key, {
                "model": model, "provider": provider, "tokens": 0,
                "cost": 0.0, "share": 0.0, "is_local": False,
            })
            m["tokens"] += row_total
            m["cost"] += row_cost

            s = _session_bucket(r["terminal_id"], r["workdir"])
            s["input"] += inp
            s["output"] += out
            s["cache_read"] += cr
            s["cache_write"] += cw
            s["total"] += row_total
            s["turns"] += 1
            s["cost"] += row_cost
            if model:
                s["_models"][model] = s["_models"].get(model, 0) + row_total

        for r in local_rows:
            inp = r["input_tokens"] or 0
            out = r["output_tokens"] or 0
            row_total = inp + out
            model = r["model"] or ""

            day = (r["ts"] or "")[:10] or now.date().isoformat()
            d = _day_bucket(day)
            d["local"] += row_total
            d["total"] += row_total

            key = ("local", model)
            m = by_model.setdefault(key, {
                "model": model, "provider": r["provider_id"] or "local",
                "tokens": 0, "cost": 0.0, "share": 0.0, "is_local": True,
            })
            m["tokens"] += row_total

            tid = r["terminal_id"]
            if tid:
                s = _session_bucket(tid, r["workdir"])
                s["local"] += row_total
                s["total"] += row_total
                s["turns"] += 1
                if model:
                    s["_models"][model] = s["_models"].get(model, 0) + row_total

        # -- tool events: totals, per-session, per-tool ------------------------
        by_tool: dict[str, int] = {}
        for r in tool_rows:
            name = r["tool_name"] or "unknown"
            by_tool[name] = by_tool.get(name, 0) + 1
            tid = r["terminal_id"]
            if tid:
                # A tool call can belong to a terminal that produced no usage
                # row in this window -- bucket it anyway rather than dropping it.
                s = _session_bucket(tid, r["workdir"])
                s["tool_calls"] += 1

        # Headline numbers come from the shared KPI function so that this period
        # and `previous` are computed by identical code.
        kpis = self._compute_kpis(api_rows, local_rows, tool_rows)
        total_tokens = kpis["total_tokens"]
        total_tool_calls = kpis["tool_calls"]

        tools_out = [
            {
                "tool_name": name,
                "calls": calls,
                "share": round(calls / total_tool_calls, 6) if total_tool_calls else 0.0,
            }
            for name, calls in by_tool.items()
        ]
        tools_out.sort(key=lambda t: (t["calls"], t["tool_name"]), reverse=True)

        # -- gap-fill the day series ------------------------------------------
        if range_key == "all":
            start_day = min(by_day) if by_day else now.date().isoformat()
        else:
            days_back = {"24h": 1, "7d": 7, "30d": 30}[range_key]
            start_day = (now.date() - timedelta(days=days_back - 1)).isoformat()
        end_day = now.date().isoformat()
        if by_day:
            start_day = min(start_day, min(by_day))
            end_day = max(end_day, max(by_day))

        series: list[dict] = []
        try:
            cursor = date.fromisoformat(start_day)
            last = date.fromisoformat(end_day)
        except ValueError:
            logger.debug("range_report: unparsable day bounds %s..%s", start_day, end_day, exc_info=True)
            cursor = last = None
        if cursor is not None:
            while cursor <= last:
                key = cursor.isoformat()
                b = by_day.get(key) or {
                    "day": key, "input": 0, "output": 0, "cache_read": 0,
                    "cache_write": 0, "local": 0, "total": 0, "cost": 0.0,
                }
                series.append({**b, "cost": round(b["cost"], 4)})
                cursor += timedelta(days=1)
        else:
            series = [{**b, "cost": round(b["cost"], 4)} for b in sorted(by_day.values(), key=lambda x: x["day"])]

        models_out = []
        for m in by_model.values():
            models_out.append({
                "model": m["model"],
                "provider": m["provider"],
                "tokens": m["tokens"],
                "cost": round(m["cost"], 4),
                "share": round(m["tokens"] / total_tokens, 6) if total_tokens else 0.0,
                "is_local": m["is_local"],
            })
        models_out.sort(key=lambda m: (m["tokens"], m["model"] or ""), reverse=True)

        sessions_out = []
        for s in sessions.values():
            picked = None
            if s["_models"]:
                picked = max(s["_models"].items(), key=lambda kv: kv[1])[0]
            sessions_out.append({
                "terminal_id": s["terminal_id"],
                "name": s["name"],
                "project": s["project"],
                "model": picked,
                "input": s["input"],
                "output": s["output"],
                "cache_read": s["cache_read"],
                "cache_write": s["cache_write"],
                "local": s["local"],
                "total": s["total"],
                "turns": s["turns"],
                "cost": round(s["cost"], 4),
                "tool_calls": s["tool_calls"],
            })
        sessions_out.sort(key=lambda s: (s["total"], s["turns"]), reverse=True)

        return {
            "range": range_key,
            "generated_at": now.isoformat(),
            "kpis": kpis,
            "cost_basis": cost_basis,
            "tool_events_since": self._tool_events_since(),
            "previous": self._previous_period(range_key, now),
            "by_day": series,
            "by_model": models_out,
            "by_tool": tools_out,
            "sessions": sessions_out,
        }

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                logger.warning("Failed closing usage DB", exc_info=True)
        # Only close a price store we created ourselves; the process-wide
        # singleton (and any caller-supplied store) outlives this tracker.
        if self._owns_pricing:
            self._pricing.close()


# Module-level singleton.
usage_tracker = UsageTracker()
