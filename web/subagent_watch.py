"""Read-only view of Claude Code's IN-PROCESS subagents (the Agent tool), per session.

A Claude Code session that dispatches agents (e.g. /orch-code-anth) runs them inside its
own process -- no terminal, so Studio cannot show them as panes. Claude Code does write
each one to disk, beside the session's transcript:

    ~/.claude/projects/<proj>/<session-id>.jsonl                 the session
    ~/.claude/projects/<proj>/<session-id>/subagents/
        agent-<id>.meta.json   {"agentType","description","model","toolUseId",...}
        agent-<id>.jsonl       that agent's own transcript

Measured 2026-10-01 on Claude Code 2.1.283. This module turns that into rows the sidebar
can nest under the session: OBSERVE ONLY. Nothing here can prompt, stop or alter an agent.

status: "done" when the transcript's last record is an assistant message with
stop_reason "end_turn"; otherwise "running". A transcript that stopped moving without
finishing (the parent was interrupted) is reported "stopped" after STALE_AFTER_S, so the
sidebar never shows a dead agent as running forever.
"""
from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("cockpit.subagents")

TAIL_BYTES = 64 * 1024
# Windows a tail read grows through. Measured 2026-10-01: a trailing "attachment" record
# (system reminders) was ~65 KB on its own, so a single 64 KB tail started mid-line, parsed
# nothing and reported a FINISHED agent as running.
_TAIL_WINDOWS = (TAIL_BYTES, 512 * 1024, 4 * 1024 * 1024)
STALE_AFTER_S = 600          # no write for 10 min and not finished -> "stopped"
SHOW_FINISHED_FOR_S = 1800   # finished agents stay listed for 30 min
MAX_PER_SESSION = 12

_cache: dict[str, tuple[float, int, str]] = {}   # transcript path -> (mtime, size, status)


def subagents_dir(jsonl_path: Optional[str]) -> Optional[str]:
    if not jsonl_path or not jsonl_path.endswith(".jsonl"):
        return None
    d = os.path.join(jsonl_path[: -len(".jsonl")], "subagents")
    return d if os.path.isdir(d) else None


def _tail_records(path: str, want):
    """Yield complete records from the end of a JSONL file, newest first, widening the read
    window until ``want(record)`` is satisfied or the whole file has been read. Records
    are only yielded once complete: a window that starts mid-line drops that first line."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return None
    for window in _TAIL_WINDOWS + (size,):
        start = max(0, size - window)
        try:
            with open(path, "rb") as fh:
                fh.seek(start)
                data = fh.read().decode("utf-8", errors="replace")
        except OSError:
            return None
        lines = data.splitlines()
        if start > 0 and lines:
            lines = lines[1:]  # partial
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            verdict = want(rec)
            if verdict is not None:
                return verdict
        if start == 0:
            return None
    return None


def _finished(path: str) -> bool:
    """True when the transcript ends on an assistant end_turn (the agent reported back).
    Attachment records (reminders) interleave and never decide the state."""
    def decide(rec):
        kind = rec.get("type")
        if kind == "attachment":
            return None
        if kind != "assistant":
            return False
        return (rec.get("message") or {}).get("stop_reason") == "end_turn"
    return bool(_tail_records(path, decide))


def _status(path: str, now: float) -> str:
    try:
        st = os.stat(path)
    except OSError:
        return "stopped"
    hit = _cache.get(path)
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        base = hit[2]
    else:
        base = "done" if _finished(path) else "running"
        _cache[path] = (st.st_mtime, st.st_size, base)
    if base == "running" and now - st.st_mtime > STALE_AFTER_S:
        return "stopped"
    return base


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def list_subagents(jsonl_path: Optional[str], now: Optional[float] = None) -> list[dict]:
    """Rows for one session, oldest first; running ones always, finished ones for
    SHOW_FINISHED_FOR_S. Never raises: a missing or unreadable dir is an empty list."""
    d = subagents_dir(jsonl_path)
    if not d:
        return []
    now = time.time() if now is None else now
    rows = []
    try:
        names = os.listdir(d)
    except OSError:
        logger.debug("Could not list %s", d, exc_info=True)
        return []
    for name in names:
        if not (name.startswith("agent-") and name.endswith(".meta.json")):
            continue
        agent_id = name[len("agent-"): -len(".meta.json")]
        meta_path = os.path.join(d, name)
        transcript = os.path.join(d, f"agent-{agent_id}.jsonl")
        try:
            meta = json.load(open(meta_path, encoding="utf-8"))
            started = os.path.getmtime(meta_path)
            updated = os.path.getmtime(transcript) if os.path.exists(transcript) else started
        except (OSError, ValueError):
            logger.debug("Unreadable subagent meta %s", meta_path, exc_info=True)
            continue
        status = _status(transcript, now) if os.path.exists(transcript) else "running"
        if status != "running" and now - updated > SHOW_FINISHED_FOR_S:
            continue
        rows.append({
            "id": agent_id,
            "agent_type": meta.get("agentType") or "general-purpose",
            "description": meta.get("description") or "",
            "model": meta.get("model") or None,
            "status": status,
            "started_at": _iso(started),
            "updated_at": _iso(updated),
            "_started": started,
        })
    rows.sort(key=lambda r: r["_started"])
    for r in rows:
        r.pop("_started")
    return rows[-MAX_PER_SESSION:]


def latest_text(jsonl_path: Optional[str], agent_id: str) -> Optional[str]:
    """The agent's last assistant text (its report, once done), for the read-only view."""
    d = subagents_dir(jsonl_path)
    if not d or not agent_id.isalnum():
        return None
    path = os.path.join(d, f"agent-{agent_id}.jsonl")

    def text_of(rec):
        if rec.get("type") != "assistant":
            return None
        content = (rec.get("message") or {}).get("content", [])
        parts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if p).strip() or None
    return _tail_records(path, text_of)
