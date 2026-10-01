"""Agent sub-sessions: a session can spawn, prompt, watch and close its OWN worker panes.

The Plexar take on herdr's agent-native CLI. A coding agent running inside a Studio
pane gets two env vars from ``pty_manager.create_terminal``:

    PLEXAR_STUDIO_URL     http://127.0.0.1:<port>
    PLEXAR_STUDIO_TOKEN   a per-session secret

and drives ``/api/agent/*`` with ``X-Plexar-Session-Token: $PLEXAR_STUDIO_TOKEN``.
Workers it spawns are ordinary Studio sessions carrying ``parent_id``; the desktop
adopts them from ``GET /api/terminals`` and nests them under the parent in the sidebar.

**The token is the boundary, not loopback.** Studio's other 100+ routes are
unauthenticated on loopback; this surface is the one an AGENT drives on its own
initiative, so it must answer "which pane is asking". The token answers that and also
stops a browser page (which cannot learn it) and a sibling pane (which holds a
different one). Every route is scoped to the caller's own children: a worker cannot
be prompted, read or closed by a session that did not spawn it.

Deliberate limits, all refusals rather than silent clamps:
  * depth 1 -- a worker cannot spawn workers (runaway fan-out is the failure herdr
    leaves to the agent's judgement; here it is structural);
  * at most ``MAX_CHILDREN`` live workers per parent, inside the global MAX_SESSIONS;
  * a worker never gets MORE permission than its parent: bypass only if the parent
    bypasses.
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import re
import time
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("cockpit.agent")

router = APIRouter()

MAX_CHILDREN = 8
TOKEN_HEADER = "x-plexar-session-token"
_MAX_PROMPT_BYTES = 100_000
_READY_TIMEOUT = 60.0          # how long an initial prompt waits for a fresh worker's CLI
_ACTIVITY_GRACE = 5.0          # wait: how long to look for the prompt to start a turn
_WAIT_MAX_MS = 900_000
_POLL_S = 0.5                  # state re-check; a cadence per WAITING request, not per pane
_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")

# Wired by server.py (avoids a circular import of server from here).
_deps: dict[str, Any] = {}


def configure(*, pty_manager, create_from_body: Callable[..., Awaitable[dict]],
              paste_and_submit: Callable[[str, str], Awaitable[bool]],
              wait_for_idle: Callable[..., Awaitable[bool]]) -> None:
    _deps.update(pty=pty_manager, create=create_from_body,
                 paste=paste_and_submit, idle=wait_for_idle)


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


def _caller(request: Request):
    """The live session whose token is presented, else None. Constant-time compare."""
    token = request.headers.get(TOKEN_HEADER, "")
    if not token:
        return None
    for s in list(_deps["pty"].sessions.values()):
        if s.spawn_token and hmac.compare_digest(s.spawn_token, token):
            return s if s.alive else None
    return None


def _children(parent_id: str) -> list:
    return [s for s in list(_deps["pty"].sessions.values())
            if s.parent_id == parent_id and s.alive]


def _resolve_child(caller, ref: str):
    """A worker by terminal id or by its exact name (names are what an agent remembers)."""
    sessions = _deps["pty"].sessions
    if ref in sessions and sessions[ref].parent_id == caller.id:
        return sessions[ref]
    named = [s for s in _children(caller.id) if s.name == ref]
    return named[0] if len(named) == 1 else None


def _summary(s) -> dict:
    s.tracker.tick()
    return {"id": s.id, "name": s.name, "harness": s.harness, "model": s.model,
            "working_dir": s.working_dir, "parent_id": s.parent_id,
            "state": s.tracker.state, "alive": s.alive}


def _next_child_name(parent) -> str:
    taken = {s.name for s in _deps["pty"].sessions.values() if s.parent_id == parent.id}
    n = 1
    while f"{parent.name}.{n}" in taken:
        n += 1
    return f"{parent.name}.{n}"


async def _deliver_when_ready(child_id: str, text: str) -> None:
    """Initial prompt for a freshly spawned worker: wait for its CLI to settle, then
    paste-and-submit (two writes -- see bridge_manager._paste_and_submit)."""
    try:
        if not await _deps["idle"](child_id, timeout=_READY_TIMEOUT):
            logger.warning("Worker %s never became idle; initial prompt not delivered", child_id)
            return
        if not await _deps["paste"](child_id, text):
            logger.warning("Initial prompt write failed for worker %s", child_id)
    except Exception:
        logger.warning("Initial prompt delivery failed for worker %s", child_id, exc_info=True)


@router.get("/api/agent/whoami")
async def whoami(request: Request):
    caller = _caller(request)
    if caller is None:
        return _err(401, "missing or invalid X-Plexar-Session-Token")
    return JSONResponse({**_summary(caller), "can_spawn": caller.parent_id is None,
                         "max_children": MAX_CHILDREN})


@router.get("/api/agent/children")
async def list_children(request: Request):
    caller = _caller(request)
    if caller is None:
        return _err(401, "missing or invalid X-Plexar-Session-Token")
    return JSONResponse({"children": [_summary(s) for s in _children(caller.id)]})


@router.post("/api/agent/spawn")
async def spawn(request: Request):
    caller = _caller(request)
    if caller is None:
        return _err(401, "missing or invalid X-Plexar-Session-Token")
    if caller.parent_id is not None:
        return _err(403, "a worker cannot spawn workers (depth is limited to 1)")
    if len(_children(caller.id)) >= MAX_CHILDREN:
        return _err(409, f"this session already has {MAX_CHILDREN} live workers")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        return _err(400, "body must be a JSON object")
    prompt = body.get("prompt")
    if prompt is not None and (not isinstance(prompt, str) or len(prompt.encode()) > _MAX_PROMPT_BYTES):
        return _err(400, "prompt must be a string under 100 KB")
    name = body.get("name")
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 100):
        return _err(400, "name must be a non-empty string of at most 100 characters")
    name = name.strip() if name else _next_child_name(caller)
    if any(s.name == name for s in _children(caller.id)):
        return _err(409, f"this session already has a live worker named {name!r}")

    # Inherit, never escalate. Only the harness/model/effort/cwd may be chosen.
    spawn_body = {
        "name": name,
        "workdir": body.get("cwd") or caller.working_dir,
        "harness": body.get("harness") or caller.harness,
        "model": body.get("model") or caller.model,
        "effort": body.get("effort", caller.effort),
        "permissionMode": caller.permission_mode,
        "bypassPermissions": bool(caller.bypass_permissions),
    }
    if spawn_body["harness"] == caller.harness and caller.provider not in ("anthropic", ""):
        spawn_body["provider"] = caller.provider
    try:
        result = await _deps["create"](spawn_body, parent_id=caller.id)
    except Exception as exc:  # _CreateTerminalRefused or ValueError from the one spawn path
        status = getattr(exc, "status", 400)
        payload = getattr(exc, "payload", None) or {"error": str(exc)}
        return JSONResponse(payload, status_code=status)
    child_id = result.get("id")
    logger.info("Session %s spawned worker %s (%s)", caller.id, child_id, name)
    if prompt and child_id:
        asyncio.create_task(_deliver_when_ready(child_id, prompt))
    child = _deps["pty"].sessions.get(child_id)
    return JSONResponse({"worker": _summary(child) if child else result,
                         "prompt_queued": bool(prompt)}, status_code=201)


@router.post("/api/agent/{ref}/prompt")
async def prompt_child(ref: str, request: Request):
    caller = _caller(request)
    if caller is None:
        return _err(401, "missing or invalid X-Plexar-Session-Token")
    child = _resolve_child(caller, ref)
    if child is None or not child.alive:
        return _err(404, "no such worker of this session")
    try:
        body = await request.json()
    except Exception:
        return _err(400, "body must be JSON")
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text.encode()) > _MAX_PROMPT_BYTES:
        return _err(400, "text must be a non-empty string under 100 KB")
    if child.tracker.state == "waiting":
        return _err(409, "worker is blocked on a question or approval; read it and ask the user")
    if not await _deps["idle"](child.id, timeout=30.0):
        return _err(409, "worker did not become idle within 30s")
    if not await _deps["paste"](child.id, text):
        return _err(502, "prompt write failed")
    return JSONResponse({"ok": True, "worker": child.id})


@router.get("/api/agent/{ref}/wait")
async def wait_child(ref: str, request: Request, until: str = "settled", timeout_ms: int = 120_000):
    """Wait for a worker's state. ``settled`` = idle or waiting, after first seeing it
    leave idle (so a wait issued right after a prompt does not return on the stale
    pre-prompt idle). ``waiting`` = blocked on a question/approval. ``idle``."""
    caller = _caller(request)
    if caller is None:
        return _err(401, "missing or invalid X-Plexar-Session-Token")
    child = _resolve_child(caller, ref)
    if child is None:
        return _err(404, "no such worker of this session")
    if until not in ("settled", "idle", "waiting"):
        return _err(400, "until must be settled, idle or waiting")
    deadline = time.monotonic() + min(max(timeout_ms, 0), _WAIT_MAX_MS) / 1000
    grace_end = time.monotonic() + _ACTIVITY_GRACE
    saw_activity = False
    while True:
        child.tracker.tick()
        state = child.tracker.state if child.alive else "ended"
        if state in ("busy", "waiting", "starting"):
            saw_activity = saw_activity or state != "starting"
        done = (state == "ended"
                or (until == "waiting" and state == "waiting")
                or (until == "idle" and state == "idle")
                or (until == "settled" and state in ("idle", "waiting")
                    and (saw_activity or time.monotonic() >= grace_end)))
        if done:
            return JSONResponse({"state": state, "timed_out": False, "saw_activity": saw_activity})
        if time.monotonic() >= deadline:
            return JSONResponse({"state": state, "timed_out": True, "saw_activity": saw_activity})
        await asyncio.sleep(_POLL_S)


def _screen_tail(child, lines: int) -> str:
    raw = "".join(data for _, data, _ in list(child.history.chunks)[-400:])
    text = _ANSI_RE.sub("", raw).replace("\r\n", "\n").replace("\r", "\n")
    kept = [ln.rstrip() for ln in text.split("\n") if ln.strip()]
    return "\n".join(kept[-lines:])


def _latest_assistant(child) -> Optional[str]:
    if child.harness != "claude-code":
        return None
    from jsonl_watcher import read_all_messages
    path = _deps["pty"]._get_jsonl_path(child)
    if not path:
        return None
    for entry in reversed(read_all_messages(path)):
        if entry.get("type") != "assistant":
            continue
        parts = [b.get("text", "") for b in entry.get("content", [])
                 if isinstance(b, dict) and b.get("type") == "text"]
        joined = "\n".join(p for p in parts if p).strip()
        if joined:
            return joined
    return None


@router.get("/api/agent/{ref}/read")
async def read_child(ref: str, request: Request, lines: int = 80):
    """``latest_assistant`` is the clean answer (Claude Code transcript); ``screen`` is
    the ANSI-stripped output tail, which for a full-screen TUI is approximate."""
    caller = _caller(request)
    if caller is None:
        return _err(401, "missing or invalid X-Plexar-Session-Token")
    child = _resolve_child(caller, ref)
    if child is None:
        return _err(404, "no such worker of this session")
    lines = min(max(lines, 1), 1000)
    latest = await asyncio.to_thread(_latest_assistant, child)
    child.tracker.tick()
    return JSONResponse({"worker": child.id, "state": child.tracker.state,
                         "latest_assistant": latest,
                         "screen": await asyncio.to_thread(_screen_tail, child, lines)})


@router.delete("/api/agent/{ref}")
async def close_child(ref: str, request: Request):
    caller = _caller(request)
    if caller is None:
        return _err(401, "missing or invalid X-Plexar-Session-Token")
    child = _resolve_child(caller, ref)
    if child is None:
        return _err(404, "no such worker of this session")
    _deps["pty"].kill_terminal(child.id)
    return JSONResponse({"ok": True, "closed": child.id})
