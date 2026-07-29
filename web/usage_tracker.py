"""Persistent per-session token/cost tracking for Claude Code sessions.

Ingests Claude Code JSONL conversation files into SQLite so that usage history
survives JSONL deletion. Stdlib only (sqlite3, json, pathlib, time, datetime,
logging, threading).
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
from datetime import date, datetime, timedelta, timezone
from pathlib import Path, PurePosixPath, PureWindowsPath

_SUMMARY_WINDOWS = ("session", "24h", "7d", "lifetime")

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


def _default_db_path() -> Path:
    return Path.home() / ".claude-cockpit" / "usage.sqlite3"


class UsageTracker:
    def __init__(self, db_path: Path | None = None):
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
        self._init_schema()

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
                """
            )
            self._conn.commit()
            self._migrate_add_column("usage_events", "workdir", "TEXT")

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
        """Parse Claude Code JSONL; insert one row per assistant message with a
        usage block. Tracks per-file byte offset in memory for incremental reads
        (falls back to a full re-read if the file shrank). Returns number of new
        rows. Never raises on malformed lines — logs and skips."""
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
        for line in data.split("\n"):
            line = line.strip()
            if not line:
                continue
            row = self._parse_line(terminal_id, key, line, workdir)
            if row is not None:
                rows.append(row)

        inserted = 0
        if rows:
            with self._lock:
                try:
                    cur = self._conn.executemany(
                        """
                        INSERT OR IGNORE INTO usage_events
                          (terminal_id, jsonl_path, message_uuid, ts, model,
                           input_tokens, output_tokens,
                           cache_creation_tokens, cache_read_tokens, workdir)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        rows,
                    )
                    inserted = cur.rowcount if cur.rowcount is not None else 0
                    self._conn.commit()
                except sqlite3.Error:
                    logger.warning("Failed inserting usage rows for %s", terminal_id, exc_info=True)
                    inserted = 0

        self._offsets[key] = new_offset
        return inserted

    def _parse_line(self, terminal_id: str, jsonl_path: str, line: str, workdir: str | None = None) -> tuple | None:
        try:
            obj = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            logger.debug("Skipping malformed JSONL line in %s", jsonl_path, exc_info=True)
            return None
        if not isinstance(obj, dict):
            return None
        if obj.get("type") != "assistant":
            return None
        uuid = obj.get("uuid")
        if not uuid:
            return None
        msg = obj.get("message")
        if not isinstance(msg, dict):
            return None
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            return None

        def _int(v) -> int:
            try:
                return int(v or 0)
            except (TypeError, ValueError):
                return 0

        model = msg.get("model") or ""
        ts = obj.get("timestamp") or ""
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

    # -- summaries ------------------------------------------------------------

    def session_summary(self, terminal_id: str) -> dict:
        with self._lock:
            rows = self._conn.execute(
                "SELECT model, input_tokens, output_tokens, "
                "cache_creation_tokens, cache_read_tokens, ts "
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
            cost += _row_cost(
                r["model"], r["input_tokens"], r["output_tokens"],
                r["cache_creation_tokens"], r["cache_read_tokens"],
            )
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
                "cache_creation_tokens, cache_read_tokens "
                "FROM usage_events WHERE substr(ts, 1, 10) = ?",
                (day,),
            ).fetchall()

        inp = out = cc = cr = 0
        cost = 0.0
        by_model: dict[str, dict] = {}
        by_terminal: dict[str, float] = {}
        for r in rows:
            row_cost = _row_cost(
                r["model"], r["input_tokens"], r["output_tokens"],
                r["cache_creation_tokens"], r["cache_read_tokens"],
            )
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
        Cost is computed exclusively via the existing verified _row_cost /
        _pricing_for path — no reimplementation of token x rate here.

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
                    "cache_creation_tokens, cache_read_tokens FROM usage_events"
                ).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT model, input_tokens, output_tokens, "
                    "cache_creation_tokens, cache_read_tokens "
                    "FROM usage_events WHERE ts >= ?",
                    (cutoff,),
                ).fetchall()

        prompt_tokens = completion_tokens = 0
        cost = 0.0
        by_model: dict[str, dict] = {}
        for r in rows:
            row_cost = _row_cost(
                r["model"], r["input_tokens"], r["output_tokens"],
                r["cache_creation_tokens"], r["cache_read_tokens"],
            )
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
                    "cache_creation_tokens, cache_read_tokens, workdir "
                    "FROM usage_events"
                ).fetchall()
                local_rows = self._conn.execute(
                    "SELECT provider_id, model, input_tokens, output_tokens, workdir "
                    "FROM local_runs"
                ).fetchall()
            else:
                anthro_rows = self._conn.execute(
                    "SELECT model, input_tokens, output_tokens, "
                    "cache_creation_tokens, cache_read_tokens, workdir "
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
            entry["cost_usd"] += _row_cost(
                model, r["input_tokens"], r["output_tokens"],
                r["cache_creation_tokens"], r["cache_read_tokens"],
            )
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

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                logger.warning("Failed closing usage DB", exc_info=True)


# Module-level singleton.
usage_tracker = UsageTracker()
