"""Append-only model price snapshots — the mechanism that makes historical
cost figures immutable.

Why this module exists
---------------------
``usage_tracker`` used to compute cost at *query* time from *current* prices.
That meant every historical report silently re-priced itself whenever a vendor
changed a rate: last month's spend moved. This store fixes that by recording
*when* each price came into effect, so a past event can always be priced with
the rate that was in effect when it happened.

The guarantee, in one sentence: **rows in ``model_prices`` are only ever
INSERTed.** There is no UPDATE and no DELETE anywhere in this module for that
table. A price change is a NEW row with a later ``effective_from``; the old row
stays exactly as it was, forever. ``price_for(model, at)`` therefore returns a
stable answer for any fixed ``at``, no matter how many times prices change
afterwards.

Timestamps are ISO8601 UTC strings and are compared *lexicographically* in SQL.
That is correct for the timestamps we produce (``datetime.isoformat()`` on a
UTC-aware datetime) and for Claude Code's JSONL timestamps
(``2026-07-19T10:00:00Z``), which share the same ``YYYY-MM-DDTHH:MM:SS`` prefix
ordering. We deliberately do not parse them: string ordering keeps the lookup a
single indexed SQL query.

Stdlib only (sqlite3, json, urllib, logging, threading).
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

logger = logging.getLogger("cockpit.pricing")

# Seeded reference rates carry no known change date -- they are hand-maintained
# list prices, so they are treated as having applied since the beginning of
# time. Without this, every already-ingested historical event would be
# "unpriced" and report $0.
EPOCH = "1970-01-01T00:00:00+00:00"
# Sentinel used for "the newest price on file, whatever its date".
_FUTURE = "9999-12-31T23:59:59+00:00"

OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
OPENROUTER_TIMEOUT = 15.0

SOURCE_OPENROUTER = "openrouter"
SOURCE_JSON = "pricing_models.json"
SOURCE_DEFAULT = "default"

PRICE_FIELDS = (
    "input_per_mtok",
    "output_per_mtok",
    "cache_read_per_mtok",
    "cache_write_per_mtok",
)

_PRICING_MODELS_PATH = Path(__file__).parent / "pricing_models.json"


def refresh_hours() -> float:
    """Poll cadence in hours (``COCKPIT_PRICING_REFRESH_HOURS``, default 24).

    A non-numeric or non-positive value falls back to 24 rather than either
    crashing or degenerating into a hot loop against OpenRouter.
    """
    raw = os.getenv("COCKPIT_PRICING_REFRESH_HOURS", "24")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        logger.warning("Invalid COCKPIT_PRICING_REFRESH_HOURS=%r -- using 24", raw)
        return 24.0
    if value <= 0:
        return 24.0
    return value


def _default_db_path() -> Path:
    # Sibling of usage.sqlite3 (see usage_tracker._default_db_path).
    return Path.home() / ".claude-cockpit" / "pricing.sqlite3"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# OpenRouter response parsing
# ---------------------------------------------------------------------------


def per_mtok(value) -> float | None:
    """Convert an OpenRouter per-TOKEN price to a per-MILLION-token float.

    OpenRouter reports prices as decimal *strings* per token
    (``"0.000003"`` = $3/Mtok). Two cases must not be conflated:

      * a **missing** field means "OpenRouter did not tell us the price" and
        becomes ``None`` -- reporting it as 0.0 would silently hide real money.
      * an explicit ``"0"`` means the model genuinely is **free** and becomes
        ``0.0`` -- reporting it as None would make a free model look unpriced.

    An unparsable string (or a negative sentinel like ``"-1"``, which
    OpenRouter uses for "variable pricing") is treated as unknown -> ``None``.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value).strip()
        if not text:
            return None
        try:
            number = float(text)
        except ValueError:
            return None
    if number < 0:
        return None
    return number * 1_000_000


def parse_openrouter_models(payload) -> list[dict]:
    """Turn an OpenRouter ``/v1/models`` payload into snapshot rows.

    Never raises on shape surprises: a payload that isn't the expected
    ``{"data": [...]}`` yields ``[]`` (the caller then writes nothing), and an
    individual malformed entry is skipped without discarding its siblings.
    """
    if not isinstance(payload, dict):
        return []
    data = payload.get("data")
    if not isinstance(data, list):
        return []

    rows: list[dict] = []
    for entry in data:
        if not isinstance(entry, dict):
            continue
        model = entry.get("id")
        if not isinstance(model, str) or not model.strip():
            continue
        model = model.strip()
        pricing = entry.get("pricing")
        if not isinstance(pricing, dict):
            pricing = {}
        row = {
            "model": model,
            "provider": model.split("/", 1)[0] if "/" in model else SOURCE_OPENROUTER,
            "input_per_mtok": per_mtok(pricing.get("prompt")),
            "output_per_mtok": per_mtok(pricing.get("completion")),
            "cache_read_per_mtok": per_mtok(pricing.get("input_cache_read")),
            "cache_write_per_mtok": per_mtok(pricing.get("input_cache_write")),
        }
        if all(row[f] is None for f in PRICE_FIELDS):
            # Nothing priced at all -- a row here would assert knowledge we
            # don't have. Skip; the model shows as unpriced downstream.
            continue
        rows.append(row)
    return rows


def load_json_seed_rows(path: Path | str | None = None) -> list[dict]:
    """Snapshot rows from the checked-in ``pricing_models.json``.

    Never raises: a missing/corrupt file yields ``[]``. Cache rates are left
    ``None`` -- the file does not publish them, and ``None`` means "derive from
    input" downstream rather than "free".
    """
    p = Path(path) if path is not None else _PRICING_MODELS_PATH
    try:
        raw = p.read_text(encoding="utf-8")
        data = json.loads(raw)
    except (OSError, json.JSONDecodeError, ValueError):
        logger.warning("Could not read pricing seed %s -- skipping seed", p, exc_info=True)
        return []

    models = data.get("models") if isinstance(data, dict) else data
    if not isinstance(models, list):
        return []

    rows: list[dict] = []
    for entry in models:
        if not isinstance(entry, dict):
            continue
        model = entry.get("id")
        if not isinstance(model, str) or not model.strip():
            continue
        inp = entry.get("input_per_mtok")
        out = entry.get("output_per_mtok")
        rows.append({
            "model": model.strip(),
            "provider": "anthropic",
            "input_per_mtok": float(inp) if isinstance(inp, (int, float)) else None,
            "output_per_mtok": float(out) if isinstance(out, (int, float)) else None,
            "cache_read_per_mtok": None,
            "cache_write_per_mtok": None,
        })
    return rows


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------


class PricingStore:
    """Append-only price history + refresh bookkeeping.

    Two tables:

      * ``model_prices`` -- APPEND ONLY. One row per (model, effective_from).
        This is the immutable history; nothing in this class updates or deletes
        from it.
      * ``refresh_log`` -- mutable bookkeeping only (when did we last poll).
        It holds no prices, so mutating it cannot move a historical figure. It
        exists because an unchanged daily poll writes *no* price row, so
        ``model_prices`` alone cannot tell us whether we already polled today.
    """

    def __init__(self, db_path: Path | str | None = None):
        if db_path is None:
            db_path = _default_db_path()
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # Distinct model ids, cached for prefix resolution; invalidated on write.
        self._models_cache: list[str] | None = None
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.Error:
            logger.warning("Failed to set WAL mode on %s", self.db_path, exc_info=True)
        self._init_schema()

    def _init_schema(self) -> None:
        with self._lock:
            try:
                self._conn.executescript(
                    """
                    CREATE TABLE IF NOT EXISTS model_prices (
                      model TEXT NOT NULL,
                      provider TEXT NOT NULL DEFAULT '',
                      input_per_mtok REAL,
                      output_per_mtok REAL,
                      cache_read_per_mtok REAL,
                      cache_write_per_mtok REAL,
                      effective_from TEXT NOT NULL,
                      source TEXT NOT NULL,
                      PRIMARY KEY (model, effective_from)
                    );
                    CREATE INDEX IF NOT EXISTS idx_model_prices_model
                      ON model_prices(model, effective_from);
                    CREATE INDEX IF NOT EXISTS idx_model_prices_source
                      ON model_prices(source);

                    /* Bookkeeping only -- carries no prices. */
                    CREATE TABLE IF NOT EXISTS refresh_log (
                      source TEXT PRIMARY KEY,
                      last_attempt TEXT,
                      last_success TEXT,
                      models_seen INTEGER,
                      rows_written INTEGER,
                      last_error TEXT
                    );
                    """
                )
                self._conn.commit()
            except sqlite3.Error:
                logger.error("Failed initialising pricing schema at %s", self.db_path, exc_info=True)

    # -- reads ---------------------------------------------------------------

    # NOTE on locking: sqlite3 is opened with check_same_thread=False and is
    # touched from several threads (the usage-ingest executor thread and the
    # refresh thread), so every statement runs under self._lock. threading.Lock
    # is NOT reentrant, so helpers that assume the lock is already held are
    # suffixed ``_locked`` and must never take it themselves.

    def _known_models_locked(self) -> list[str]:
        if self._models_cache is not None:
            return self._models_cache
        try:
            rows = self._conn.execute("SELECT DISTINCT model FROM model_prices").fetchall()
            self._models_cache = [r["model"] for r in rows]
        except sqlite3.Error:
            logger.warning("Failed listing priced models", exc_info=True)
            self._models_cache = []
        return self._models_cache

    def _resolve_model_locked(self, model: str) -> str | None:
        """Map an observed model id onto a stored price key.

        Exact match first. Failing that, the LONGEST stored id that is a prefix
        of *model* -- this preserves the family-prefix behaviour Anthropic ids
        rely on (``claude-opus-4-20260101`` -> ``claude-opus``) while keeping
        OpenRouter's fully-qualified ids (``deepseek/deepseek-v4-pro``) exact.
        """
        if not model:
            return None
        known = self._known_models_locked()
        if model in known:
            return model
        best: str | None = None
        for candidate in known:
            if candidate and model.startswith(candidate):
                if best is None or len(candidate) > len(best):
                    best = candidate
        return best

    def price_for(self, model: str, at_iso: str) -> dict | None:
        """The price that was in effect for *model* at *at_iso*.

        Returns the row with the greatest ``effective_from <= at_iso``, or None
        when we have no price on file that was already in effect then. Because
        ``model_prices`` is append-only, the answer for a fixed *at_iso* can
        never change -- that is the whole anti-retroactive guarantee.
        """
        if not model or not at_iso:
            return None
        with self._lock:
            try:
                key = self._resolve_model_locked(model)
                if key is None:
                    return None
                row = self._conn.execute(
                    "SELECT model, provider, input_per_mtok, output_per_mtok, "
                    "cache_read_per_mtok, cache_write_per_mtok, effective_from, source "
                    "FROM model_prices WHERE model = ? AND effective_from <= ? "
                    "ORDER BY effective_from DESC LIMIT 1",
                    (key, at_iso),
                ).fetchone()
            except sqlite3.Error:
                logger.warning("Price lookup failed for %s @ %s", model, at_iso, exc_info=True)
                return None
        return dict(row) if row is not None else None

    def latest_price(self, model: str) -> dict | None:
        """The newest price on file for *model*, whatever its effective date.

        Used ONLY by the one-time backfill of pre-existing rows, which is
        labelled ``backfill`` precisely because it may use a rate that was not
        in effect at the time.
        """
        return self.price_for(model, _FUTURE)

    def latest_prices(self) -> list[dict]:
        """Current effective price per model (newest row each), for the UI."""
        try:
            with self._lock:
                rows = self._conn.execute(
                    """
                    SELECT mp.model, mp.provider, mp.input_per_mtok, mp.output_per_mtok,
                           mp.cache_read_per_mtok, mp.cache_write_per_mtok,
                           mp.effective_from, mp.source
                    FROM model_prices mp
                    WHERE mp.effective_from = (
                        SELECT MAX(effective_from) FROM model_prices p2
                        WHERE p2.model = mp.model
                    )
                    ORDER BY mp.model
                    """
                ).fetchall()
        except sqlite3.Error:
            logger.warning("Failed reading latest prices", exc_info=True)
            return []
        return [dict(r) for r in rows]

    def price_history(self, model: str) -> list[dict]:
        """Every snapshot for *model*, oldest first. Diagnostics / tests."""
        try:
            with self._lock:
                rows = self._conn.execute(
                    "SELECT model, provider, input_per_mtok, output_per_mtok, "
                    "cache_read_per_mtok, cache_write_per_mtok, effective_from, source "
                    "FROM model_prices WHERE model = ? ORDER BY effective_from",
                    (model,),
                ).fetchall()
        except sqlite3.Error:
            logger.warning("Failed reading price history for %s", model, exc_info=True)
            return []
        return [dict(r) for r in rows]

    def count_rows(self) -> int:
        try:
            with self._lock:
                row = self._conn.execute("SELECT COUNT(*) AS n FROM model_prices").fetchone()
            return int(row["n"]) if row else 0
        except sqlite3.Error:
            logger.warning("Failed counting price rows", exc_info=True)
            return 0

    def last_refresh(self, source: str) -> str | None:
        """ISO timestamp of the last SUCCESSFUL refresh for *source*, or None.

        Read from ``refresh_log``, not from ``model_prices``: a poll that finds
        every price unchanged writes no price row, and treating that as "never
        refreshed" would re-poll on every startup forever.
        """
        try:
            with self._lock:
                row = self._conn.execute(
                    "SELECT last_success FROM refresh_log WHERE source = ?", (source,)
                ).fetchone()
        except sqlite3.Error:
            logger.warning("Failed reading refresh log for %s", source, exc_info=True)
            return None
        if row is None:
            return None
        value = row["last_success"]
        return value if value else None

    def refresh_log(self) -> dict:
        """``{source: {last_attempt, last_success, models_seen, rows_written, last_error}}``."""
        try:
            with self._lock:
                rows = self._conn.execute("SELECT * FROM refresh_log").fetchall()
        except sqlite3.Error:
            logger.warning("Failed reading refresh log", exc_info=True)
            return {}
        out = {}
        for r in rows:
            d = dict(r)
            source = d.pop("source")
            out[source] = d
        return out

    # -- writes (model_prices: INSERT ONLY) ----------------------------------

    def record_snapshot(self, rows, source: str, now_iso: str | None = None) -> int:
        """Append price rows for the models whose price actually CHANGED.

        A model whose four price fields equal its most recent stored row gets
        NO new row -- otherwise a daily poll over ~1000 OpenRouter models would
        add ~1000 rows a day forever. Returns the number of rows written.

        Never UPDATEs: a changed price is a new (model, effective_from) row, and
        the previous row remains readable by ``price_for`` at any earlier
        timestamp. Uses INSERT OR IGNORE so re-running with the same
        ``now_iso`` (e.g. two manual refreshes in the same instant) is
        idempotent rather than an error.
        """
        if not rows:
            return 0
        stamp = now_iso or _now_iso()
        with self._lock:
            to_insert: list[tuple] = []
            for row in rows:
                if not isinstance(row, dict):
                    continue
                model = row.get("model")
                if not isinstance(model, str) or not model.strip():
                    continue
                model = model.strip()
                values = {f: row.get(f) for f in PRICE_FIELDS}
                current = self._latest_row_exact_locked(model)
                if current is not None and all(
                    _same_price(current.get(f), values[f]) for f in PRICE_FIELDS
                ):
                    continue  # unchanged -- append nothing
                to_insert.append((
                    model,
                    str(row.get("provider") or ""),
                    values["input_per_mtok"],
                    values["output_per_mtok"],
                    values["cache_read_per_mtok"],
                    values["cache_write_per_mtok"],
                    stamp,
                    source,
                ))

            if not to_insert:
                return 0

            try:
                cur = self._conn.executemany(
                    "INSERT OR IGNORE INTO model_prices "
                    "(model, provider, input_per_mtok, output_per_mtok, "
                    " cache_read_per_mtok, cache_write_per_mtok, effective_from, source) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    to_insert,
                )
                written = cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
                self._conn.commit()
            except sqlite3.Error:
                logger.warning("Failed appending %d price snapshot(s)", len(to_insert), exc_info=True)
                return 0
            self._models_cache = None
        return written

    def _latest_row_exact_locked(self, model: str) -> dict | None:
        """Newest stored row for exactly *model* (no prefix fallback)."""
        try:
            row = self._conn.execute(
                "SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, "
                "cache_write_per_mtok FROM model_prices WHERE model = ? "
                "ORDER BY effective_from DESC LIMIT 1",
                (model,),
            ).fetchone()
        except sqlite3.Error:
            logger.warning("Failed reading latest row for %s", model, exc_info=True)
            return None
        return dict(row) if row is not None else None

    def seed(self, rows, source: str) -> int:
        """Append seed rows effective since EPOCH.

        Seeds are hand-maintained list prices with no known change date, so
        they apply from the beginning of time -- otherwise every already-stored
        historical event would price at $0. Idempotent via ``record_snapshot``:
        a second call with the same rates writes nothing.
        """
        return self.record_snapshot(rows, source, EPOCH)

    def mark_refresh(
        self,
        source: str,
        *,
        at_iso: str,
        ok: bool,
        models_seen: int = 0,
        rows_written: int = 0,
        error: str | None = None,
    ) -> None:
        """Record a refresh attempt. Bookkeeping only -- no prices involved."""
        try:
            with self._lock:
                self._conn.execute(
                    """
                    INSERT INTO refresh_log
                      (source, last_attempt, last_success, models_seen, rows_written, last_error)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(source) DO UPDATE SET
                      last_attempt = excluded.last_attempt,
                      last_success = COALESCE(excluded.last_success, refresh_log.last_success),
                      models_seen  = excluded.models_seen,
                      rows_written = excluded.rows_written,
                      last_error   = excluded.last_error
                    """,
                    (source, at_iso, at_iso if ok else None, models_seen, rows_written, error),
                )
                self._conn.commit()
        except sqlite3.Error:
            logger.warning("Failed recording refresh for %s", source, exc_info=True)

    # -- the daily OpenRouter poll ------------------------------------------

    def _fetch_openrouter(self) -> dict:
        """Blocking GET of OpenRouter's public models list.

        Kept a separate method (and using stdlib urllib, matching server.py's
        ``_broker_get``) so tests monkeypatch this one seam instead of the
        network. Auth is OPTIONAL: the models endpoint is public, so a missing
        key must not stop the refresh. Run via ``asyncio.to_thread``.
        """
        headers = {"Accept": "application/json"}
        try:
            import settings_store

            key, _source = settings_store.resolve_openrouter_key()
            if key:
                headers["Authorization"] = f"Bearer {key}"
        except Exception:
            # No key configured, or settings unavailable -- the endpoint is
            # public, so carry on unauthenticated rather than failing.
            logger.debug("No OpenRouter key available for pricing refresh", exc_info=True)

        req = urllib.request.Request(OPENROUTER_MODELS_URL, headers=headers)
        with urllib.request.urlopen(req, timeout=OPENROUTER_TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def refresh_openrouter(self, now_iso: str | None = None) -> dict:
        """Poll OpenRouter and append snapshots for any CHANGED prices.

        Best-effort by contract: a network failure, a non-JSON body, or a
        payload in an unexpected shape logs a warning, writes NOTHING, and
        returns ``ok=False``. It never raises and never mutates history.
        """
        stamp = now_iso or _now_iso()
        try:
            payload = self._fetch_openrouter()
        except (urllib.error.URLError, OSError, json.JSONDecodeError, ValueError) as exc:
            logger.warning("OpenRouter pricing refresh failed: %s", exc)
            self.mark_refresh(SOURCE_OPENROUTER, at_iso=stamp, ok=False, error=str(exc)[:400])
            return {"ok": False, "source": SOURCE_OPENROUTER, "at": stamp,
                    "models_seen": 0, "rows_written": 0, "error": str(exc)[:400]}
        except Exception as exc:  # defensive: never let a poll kill its caller
            logger.error("OpenRouter pricing refresh raised unexpectedly", exc_info=True)
            self.mark_refresh(SOURCE_OPENROUTER, at_iso=stamp, ok=False, error=str(exc)[:400])
            return {"ok": False, "source": SOURCE_OPENROUTER, "at": stamp,
                    "models_seen": 0, "rows_written": 0, "error": str(exc)[:400]}

        rows = parse_openrouter_models(payload)
        if not rows:
            msg = "OpenRouter response carried no usable pricing"
            logger.warning("%s -- nothing recorded", msg)
            self.mark_refresh(SOURCE_OPENROUTER, at_iso=stamp, ok=False, error=msg)
            return {"ok": False, "source": SOURCE_OPENROUTER, "at": stamp,
                    "models_seen": 0, "rows_written": 0, "error": msg}

        written = self.record_snapshot(rows, SOURCE_OPENROUTER, stamp)
        self.mark_refresh(
            SOURCE_OPENROUTER, at_iso=stamp, ok=True,
            models_seen=len(rows), rows_written=written,
        )
        logger.info(
            "OpenRouter pricing refresh: %d model(s) seen, %d price change(s) recorded",
            len(rows), written,
        )
        return {"ok": True, "source": SOURCE_OPENROUTER, "at": stamp,
                "models_seen": len(rows), "rows_written": written, "error": None}

    def refresh_due(self, source: str = SOURCE_OPENROUTER, now: datetime | None = None) -> bool:
        """True when the last successful refresh is older than the cadence.

        An unparsable stored timestamp is treated as "due" (refresh, don't
        wedge). Never raises.
        """
        last = self.last_refresh(source)
        if not last:
            return True
        try:
            parsed = datetime.fromisoformat(last.replace("Z", "+00:00"))
        except ValueError:
            logger.warning("Unparsable last_refresh %r for %s -- refreshing", last, source)
            return True
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        reference = now or datetime.now(timezone.utc)
        age_hours = (reference - parsed).total_seconds() / 3600.0
        return age_hours >= refresh_hours()

    def next_refresh(self, source: str = SOURCE_OPENROUTER) -> str | None:
        """ISO timestamp of the next scheduled refresh, or None if due now."""
        last = self.last_refresh(source)
        if not last:
            return None
        try:
            parsed = datetime.fromisoformat(last.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return (parsed + timedelta(hours=refresh_hours())).isoformat()

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                logger.warning("Failed closing pricing DB", exc_info=True)


def _same_price(a, b) -> bool:
    """Price equality that treats None as a distinct value from 0.0.

    ``None`` (unknown) and ``0.0`` (free) are different facts, so a model going
    from unknown to free IS a change and must append a row.
    """
    if a is None or b is None:
        return a is None and b is None
    try:
        return float(a) == float(b)
    except (TypeError, ValueError):
        return False


# Module-level singleton (mirrors usage_tracker.usage_tracker).
pricing_store = PricingStore()
