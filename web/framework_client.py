"""Client for Plexar-Framework (``plexar up``, default ``http://127.0.0.1:8430``).

Studio's TASKS view embeds the framework's own page in a Tauri webview (see
``HANDOFF-studio-framework-pilot.md`` section 3.1) — the framework builds the
UI, Studio only builds the frame. The one thing Studio's *frontend* cannot do
itself is read the framework's JSON for the rail badge and the bucket-deep-link
resolution: the framework sends no CORS headers, so a ``fetch`` from Studio's
webview origin cannot read the response. This module does those reads
SERVER-SIDE instead, and ``server.py`` exposes them as two small ``/api``
routes.

Hard rules (section 3.3 of the handoff)
----------------------------------------
- **Read-only.** Studio never calls a framework WRITE route from its own
  origin — the framework 403s cross-origin writes by design (PLAN D53), and
  writes happen only inside the embedded page. This module has no POST/PUT.
- **Never proxied off the machine.** The framework has no auth of its own, and
  a submitted prompt causes code to be written. Only loopback-style
  ``framework.url`` values are meaningful here; nothing in this module widens
  that.
- **A failure is never a 5xx.** Every fetch here is wrapped so any failure —
  connection refused, timeout, bad JSON, wrong shape — reports ``up: False``
  with a short reason. ``urllib.error.HTTPError`` is a subclass of
  ``URLError``, so the narrower exception is caught first (same trap
  documented in ``plexar_client.py``).
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

logger = logging.getLogger("cockpit.framework")

# Quick local read behind a UI poll -- keep it snappy so a dead framework
# never stalls the rail badge or the summary route.
_TIMEOUT = 2.0

_USER_AGENT = "PlexarStudio/1.0"

# Page size for /api/events pagination, and the hard cap on pages fetched per
# call -- a misbehaving framework emitting endless full pages must not turn
# one Studio poll into an unbounded loop.
_EVENTS_LIMIT = 200
_MAX_PAGES = 5



# The badge and toast polls hit an unreachable framework every few seconds; a full
# traceback per poll buried everything else in cockpit.log (241 in 20 minutes during
# 2.1.41 QA). "Not running" is an expected state: log the transition once, with the
# traceback, and stay quiet until it answers again.
_unreachable_logged: set[str] = set()


def _log_unreachable(base: str, exc: BaseException) -> None:
    if base in _unreachable_logged:
        return
    _unreachable_logged.add(base)
    logger.info("framework unreachable at %s (logged once until it answers): %s", base, exc, exc_info=True)


def _mark_reachable(base: str) -> None:
    if base in _unreachable_logged:
        _unreachable_logged.discard(base)
        logger.info("framework answering again at %s", base)

def _validate_base_url(url: str) -> Optional[str]:
    """Return *url* stripped of a trailing slash, or None if not http(s)."""
    if not url:
        return None
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return None
    return url.rstrip("/")


def _get_json(url: str) -> dict:
    """Blocking GET returning parsed JSON. Raises on any failure.

    Callers run this via ``asyncio.to_thread`` -- never call it directly from
    an async route body.
    """
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": _USER_AGENT})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        raw = resp.read()
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("framework response was not a JSON object")
    return data


def _merge_buckets(summary: dict, daemon: dict) -> dict[str, Any]:
    daemon_buckets = daemon.get("buckets") or {}
    summary_buckets = summary.get("buckets") or {}
    buckets: dict[str, Any] = {}
    for name in set(daemon_buckets.keys()) | set(summary_buckets.keys()):
        d = daemon_buckets.get(name) or {}
        s = summary_buckets.get(name) or {}
        buckets[name] = {
            "cwd": d.get("cwd"),
            "pending_approvals": int(s.get("pending_approvals") or 0),
        }
    return buckets


def _orch_running(validated: str) -> Optional[int]:
    """Open orch runs, or None when this framework has no orch surface.

    None covers every failure, deliberately: the caller then falls through to
    the legacy probe, which reports the real reason (unreachable, bad JSON...).
    """
    try:
        runs = _get_json(f"{validated}/api/orch/runs").get("runs")
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, AttributeError):
        logger.debug("framework has no /api/orch/runs at %s", validated, exc_info=True)
        return None
    return len(runs) if isinstance(runs, list) else None


def _legacy_buckets(validated: str) -> tuple[dict[str, Any], int]:
    """Buckets and pending approvals from the shims; empty when they are gone."""
    try:
        summary = _get_json(f"{validated}/api/summary")
        daemon = _get_json(f"{validated}/api/daemon")
        return _merge_buckets(summary, daemon), int(summary.get("pending_approvals") or 0)
    except (urllib.error.URLError, TimeoutError, OSError, ValueError, TypeError, AttributeError):
        logger.debug("framework summary/daemon unavailable at %s", validated, exc_info=True)
        return {}, 0


def fetch_summary(base: str) -> dict:
    """Merge ``GET {base}/api/summary`` and ``GET {base}/api/daemon``.

    BLOCKING (urllib) -- run via ``asyncio.to_thread``. Any failure (bad url,
    connection refused, timeout, non-JSON, wrong shape) is reported as
    ``{"up": False, "base": base, "reason": <short>}`` rather than raised, so
    the route this feeds can always answer 200.
    """
    validated = _validate_base_url(base)
    if validated is None:
        return {"up": False, "base": base, "reason": "bad url"}

    # The orch-era framework is asked first: /api/orch/runs is its own surface,
    # while /api/summary and /api/daemon survive there only as shims kept for
    # older Studio builds. An older framework 404s the orch route and is read
    # the way it always was, so either generation reports as up.
    orch_running = _orch_running(validated)
    if orch_running is not None:
        buckets, pending = _legacy_buckets(validated)
        _mark_reachable(validated)
        return {"up": True, "base": validated, "orch": True, "pending_approvals": pending,
                "running": orch_running, "buckets": buckets}

    try:
        summary = _get_json(f"{validated}/api/summary")
        daemon = _get_json(f"{validated}/api/daemon")
    except urllib.error.HTTPError as exc:
        logger.info("framework /api/summary or /api/daemon refused: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": f"http {exc.code}"}
    except urllib.error.URLError as exc:
        _log_unreachable(validated, exc)
        return {"up": False, "base": validated, "reason": "unreachable"}
    except (TimeoutError, OSError) as exc:
        logger.info("framework request timed out or errored: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "timeout"}
    except (ValueError, json.JSONDecodeError) as exc:
        logger.info("framework returned unparseable JSON: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "bad response"}

    try:
        pending_approvals = int(summary.get("pending_approvals") or 0)
        running = int(summary.get("running") or 0)
        buckets = _merge_buckets(summary, daemon)
    except (TypeError, ValueError, AttributeError) as exc:
        logger.info("framework summary/daemon had unexpected shape: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "bad response"}

    _mark_reachable(validated)
    return {
        "up": True,
        "base": validated,
        "orch": False,
        "pending_approvals": pending_approvals,
        "running": running,
        "buckets": buckets,
    }


def fetch_events(base: str, since: Optional[str]) -> dict:
    """Paginate ``GET {base}/api/events?since=&limit=200``.

    BLOCKING (urllib) -- run via ``asyncio.to_thread``. Loops while a page
    comes back full (``len(events) == limit``), up to ``_MAX_PAGES`` pages, so
    a caller polling with a stale cursor gets caught up without Studio
    re-reading everything on every poll and without an unbounded loop if the
    framework never returns a short page.
    """
    validated = _validate_base_url(base)
    if validated is None:
        return {"up": False, "base": base, "reason": "bad url"}

    events: list[dict] = []
    cursor = since
    try:
        for _page in range(_MAX_PAGES):
            params = {"limit": str(_EVENTS_LIMIT)}
            if cursor:
                params["since"] = cursor
            url = f"{validated}/api/events?{urllib.parse.urlencode(params)}"
            page = _get_json(url)
            page_events = page.get("events") or []
            if not isinstance(page_events, list):
                raise ValueError("events field was not a list")
            for ev in page_events:
                session_id = ev.get("session_id")
                if session_id == "":
                    session_id = None
                events.append({
                    "task_id": ev.get("task_id"),
                    "bucket": ev.get("bucket"),
                    "to": ev.get("to"),
                    "gate_exit": ev.get("gate_exit"),
                    "branch": ev.get("branch"),
                    "session_id": session_id,
                })
            cursor = page.get("cursor")
            if len(page_events) != _EVENTS_LIMIT or not cursor:
                break
    except urllib.error.HTTPError as exc:
        logger.info("framework /api/events refused: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": f"http {exc.code}"}
    except urllib.error.URLError as exc:
        _log_unreachable(validated, exc)
        return {"up": False, "base": validated, "reason": "unreachable"}
    except (TimeoutError, OSError) as exc:
        logger.info("framework request timed out or errored: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "timeout"}
    except (ValueError, json.JSONDecodeError, AttributeError) as exc:
        logger.info("framework returned unparseable/unexpected JSON: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "bad response"}

    _mark_reachable(validated)
    return {"up": True, "base": validated, "events": events, "cursor": cursor or (since or "")}


# Orch events (the framework's run feed). `kind` is non-null only for the moments
# worth telling the user about; ordinary transitions (dispatch, report, land) are
# dropped here so the page never has to know step names.
_ORCH_EVENT_FIELDS = ("id", "ts", "run_id", "session_id", "step", "ok", "worker", "rule",
                      "detail", "kind", "close_status")
_ORCH_PAGE = 200
_ORCH_SEED_PAGE = 500
# The feed keeps 2000 events; seeding at 500 a page needs four calls plus the
# empty one that ends it. The cap only bounds a framework that never runs dry.
_ORCH_SEED_MAX_PAGES = 8


def fetch_orch_events(base: str, since: Optional[int]) -> dict:
    """``GET {base}/api/orch/events?since=&limit=``, as ``{up, events, cursor}``.

    BLOCKING (urllib) -- run via ``asyncio.to_thread``. ``since=None`` SEEDS: the
    feed's ``cursor`` is the last event RETURNED, not the newest kept, so one call
    could leave the caller far behind and every later poll would toast history.
    Seeding therefore pages to the end, discards everything and returns only the
    final cursor. A framework without the route (404) is ``up: False``, which the
    page treats as silence.
    """
    validated = _validate_base_url(base)
    if validated is None:
        return {"up": False, "base": base, "reason": "bad url"}

    seeding = since is None
    cursor = 0 if seeding else int(since)
    limit = _ORCH_SEED_PAGE if seeding else _ORCH_PAGE
    events: list[dict] = []
    try:
        for _page in range(_ORCH_SEED_MAX_PAGES if seeding else _MAX_PAGES):
            params = urllib.parse.urlencode({"since": str(cursor), "limit": str(limit)})
            page = _get_json(f"{validated}/api/orch/events?{params}")
            page_events = page.get("events") or []
            if not isinstance(page_events, list):
                raise ValueError("events field was not a list")
            next_cursor = page.get("cursor")
            if isinstance(next_cursor, int) and not isinstance(next_cursor, bool) and next_cursor > cursor:
                cursor = next_cursor
            if not seeding:
                for ev in page_events:
                    if isinstance(ev, dict) and ev.get("kind"):
                        row = {k: ev.get(k) for k in _ORCH_EVENT_FIELDS}
                        row["session_id"] = row["session_id"] or None
                        events.append(row)
            if (not page_events) if seeding else (len(page_events) != limit):
                break
    except urllib.error.HTTPError as exc:
        logger.debug("framework /api/orch/events refused: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": f"http {exc.code}"}
    except urllib.error.URLError as exc:
        _log_unreachable(validated, exc)
        return {"up": False, "base": validated, "reason": "unreachable"}
    except (TimeoutError, OSError) as exc:
        logger.info("framework request timed out or errored: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "timeout"}
    except (ValueError, json.JSONDecodeError, AttributeError, TypeError) as exc:
        logger.info("framework returned unparseable/unexpected JSON: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "bad response"}

    _mark_reachable(validated)
    return {"up": True, "base": validated, "events": events, "cursor": cursor, "seeded": seeding}


_RUN_FIELDS = ("run_id", "state", "stage", "loop", "task", "cwd", "started_at", "updated_at")


def _shape_run(run: dict) -> dict:
    gate = run.get("gate")
    gate_exit = gate.get("exit") if isinstance(gate, dict) else None
    row = {k: run.get(k) for k in _RUN_FIELDS}
    row["orchestrator_session_id"] = run.get("orchestrator_session_id") or None
    row["gate_exit"] = gate_exit
    row["workers"] = [
        {"worker": w.get("worker"), "lane": w.get("lane"), "status": w.get("status")}
        for w in (run.get("workers") or []) if isinstance(w, dict)
    ]
    return row


def fetch_orch_runs(base: str) -> dict:
    """``GET {base}/api/orch/runs`` (open runs only), as ``{up, base, runs}``.

    BLOCKING (urllib) -- run via ``asyncio.to_thread``. Only the fields the
    orchestrators list and run dock read are kept; the framework's per-run event
    log and card paths are dropped here. A framework without the route is
    ``up: False, reason: "http 404"``.
    """
    validated = _validate_base_url(base)
    if validated is None:
        return {"up": False, "base": base, "reason": "bad url"}
    try:
        runs = _get_json(f"{validated}/api/orch/runs").get("runs")
        if not isinstance(runs, list):
            raise ValueError("runs field was not a list")
        shaped = [_shape_run(r) for r in runs if isinstance(r, dict) and r.get("run_id")]
    except urllib.error.HTTPError as exc:
        logger.debug("framework /api/orch/runs refused: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": f"http {exc.code}"}
    except urllib.error.URLError as exc:
        _log_unreachable(validated, exc)
        return {"up": False, "base": validated, "reason": "unreachable"}
    except (TimeoutError, OSError) as exc:
        logger.info("framework request timed out or errored: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "timeout"}
    except (ValueError, json.JSONDecodeError, AttributeError, TypeError) as exc:
        logger.info("framework returned unparseable/unexpected JSON: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "bad response"}
    _mark_reachable(validated)
    return {"up": True, "base": validated, "runs": shaped}
