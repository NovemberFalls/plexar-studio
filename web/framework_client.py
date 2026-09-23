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

    try:
        summary = _get_json(f"{validated}/api/summary")
        daemon = _get_json(f"{validated}/api/daemon")
    except urllib.error.HTTPError as exc:
        logger.info("framework /api/summary or /api/daemon refused: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": f"http {exc.code}"}
    except urllib.error.URLError as exc:
        logger.info("framework unreachable at %s: %s", validated, exc, exc_info=True)
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
        daemon_buckets = daemon.get("buckets") or {}
        summary_buckets = summary.get("buckets") or {}
        buckets: dict[str, Any] = {}
        names = set(daemon_buckets.keys()) | set(summary_buckets.keys())
        for name in names:
            d = daemon_buckets.get(name) or {}
            s = summary_buckets.get(name) or {}
            buckets[name] = {
                "cwd": d.get("cwd"),
                "pending_approvals": int(s.get("pending_approvals") or 0),
            }
    except (TypeError, ValueError, AttributeError) as exc:
        logger.info("framework summary/daemon had unexpected shape: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "bad response"}

    return {
        "up": True,
        "base": validated,
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
        logger.info("framework unreachable at %s: %s", validated, exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "unreachable"}
    except (TimeoutError, OSError) as exc:
        logger.info("framework request timed out or errored: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "timeout"}
    except (ValueError, json.JSONDecodeError, AttributeError) as exc:
        logger.info("framework returned unparseable/unexpected JSON: %s", exc, exc_info=True)
        return {"up": False, "base": validated, "reason": "bad response"}

    return {"up": True, "base": validated, "events": events, "cursor": cursor or (since or "")}
