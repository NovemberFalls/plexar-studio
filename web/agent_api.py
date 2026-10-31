"""Agent workers: a session can spawn, drive, watch and close its OWN worker panes.

The Plexar take on herdr's agent-native control surface. A coding agent running inside
a Studio pane gets three env vars from ``pty_manager.create_terminal``:

    PLEXAR_STUDIO_URL     http://127.0.0.1:<port>
    PLEXAR_STUDIO_TOKEN   a per-session secret
    PLEXAR_STUDIO_CLI     path to studio_cli.py (``python "$PLEXAR_STUDIO_CLI" --help``)

and drives ``/api/agent/*`` with ``X-Plexar-Session-Token: $PLEXAR_STUDIO_TOKEN``.
Workers it spawns are ordinary Studio sessions carrying ``parent_id``; the desktop
adopts them from ``GET /api/terminals`` and nests them under the parent in the sidebar.

A worker is an agent (``claude-code``, ``codex``, ``plexar-harness`` -- alias
``plexar``) or a plain ``shell`` that takes command lines via ``/run`` and is watched
with ``/wait-output``. Any worker can be given its own git worktree.

**The token is the boundary, not loopback.** Studio's other routes are
unauthenticated on loopback; this surface is the one an AGENT drives on its own
initiative, so it must answer "which pane is asking". The token answers that and also
stops a browser page (which cannot learn it) and a sibling pane (which holds a
different one). Every mutating or reading route is scoped to the caller's own
children: a worker cannot be prompted, read or closed by a session that did not spawn
it. ``/peers`` lists every other live session (another session's workers too)
read-only. Control of a session the caller did not spawn comes only through
``/adopt``, and only once the USER approves it in the desktop (see "Approvals").

Standing-agent support (2026-10-31): ``/clear`` resets a worker's conversation in
place and confirms it took; ``/self/refresh`` does the same to the caller after
approval; ``/events`` is a long-poll of worker idle/asking/ended transitions, built
for ``studio_cli.py events --follow`` under Claude Code's Monitor tool. A clear keeps
the pane, id, token, ``--name`` (the SendMessage name) and every worker, so an
orchestrator's roster survives its own refresh.

Deliberate limits, all refusals rather than silent clamps:
  * depth 1 -- a worker cannot spawn workers;
  * no per-parent worker cap (owner ruling 2026-10-06); only an explicit MAX_SESSIONS
    ceiling, if the user set one, bounds the total;
  * a worker never gets MORE permission than its parent: bypass only if the parent
    bypasses;
  * a worker blocked on a question is never prompted (409): the human answers it.
    Keys (``/keys``) still reach it, because Esc / Ctrl+C are how you get out.
"""
from __future__ import annotations

import asyncio
import collections
import hmac
import logging
import os
import re
import secrets
import subprocess
import time
from typing import Any, Awaitable, Callable, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("cockpit.agent")

router = APIRouter()

TOKEN_HEADER = "x-plexar-session-token"
_MAX_PROMPT_BYTES = 100_000
_READY_TIMEOUT = 60.0          # how long an initial prompt waits for a fresh worker's CLI
_ACTIVITY_GRACE = 5.0          # wait: how long to look for the prompt to start a turn
_WAIT_MAX_MS = 900_000
_POLL_S = 0.5                  # state re-check; a cadence per WAITING request, not per pane
_MAX_REGEX = 500
_HARNESS_ALIASES = {"plexar": "plexar-harness", "claude": "claude-code", "terminal": "shell"}
_BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$")
_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")

# Logical keys -> bytes. A whole list is validated before anything is written, so an
# unknown key in the middle never leaves half a sequence in the pane.
_KEYS = {
    "enter": "\r", "esc": "\x1b", "escape": "\x1b", "tab": "\t", "shift+tab": "\x1b[Z",
    "backspace": "\x7f", "space": " ", "up": "\x1b[A", "down": "\x1b[B",
    "right": "\x1b[C", "left": "\x1b[D", "home": "\x1b[H", "end": "\x1b[F",
    "pageup": "\x1b[5~", "pagedown": "\x1b[6~", "delete": "\x1b[3~",
}
_KEYS.update({f"ctrl+{c}": chr(ord(c) - 96) for c in "abcdefghijklmnopqrstuvwxyz"})
_KEYS.update({c: c for c in "abcdefghijklmnopqrstuvwxyz0123456789"})

# Wired by server.py (avoids a circular import of server from here).
_deps: dict[str, Any] = {}


def configure(*, pty_manager, create_from_body: Callable[..., Awaitable[dict]],
              paste_and_submit: Callable[[str, str], Awaitable[bool]],
              wait_for_idle: Callable[..., Awaitable[bool]]) -> None:
    _deps.update(pty=pty_manager, create=create_from_body, paste=paste_and_submit,
                 idle=wait_for_idle, write=pty_manager.write_pty_async)


def _err(status: int, msg: str) -> JSONResponse:
    return JSONResponse({"error": msg}, status_code=status)


_UNAUTH = "missing or invalid X-Plexar-Session-Token"
_NOT_MINE = "no such worker of this session"


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
    """A worker by terminal id or by its exact name (names are what an agent remembers).
    A non-child resolves to None and every route answers 404, never 403, so the
    surface is not an oracle for which terminal ids exist."""
    sessions = _deps["pty"].sessions
    if ref in sessions and sessions[ref].parent_id == caller.id:
        return sessions[ref]
    named = [s for s in _children(caller.id) if s.name == ref]
    return named[0] if len(named) == 1 else None


async def _authed_child(request: Request, ref: str, *, alive: bool = True):
    """(caller, child, None) or (None, None, refusal)."""
    caller = _caller(request)
    if caller is None:
        return None, None, _err(401, _UNAUTH)
    child = _resolve_child(caller, ref)
    if child is None or (alive and not child.alive):
        return None, None, _err(404, _NOT_MINE)
    return caller, child, None


async def _json_body(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:
        return {}
    return body if isinstance(body, dict) else {}


def _state(s) -> str:
    s.tracker.tick()
    # The tracker reads Claude/Codex TUI cues; a shell has none, so its "idle" would
    # be a guess. Shell workers are watched with /wait-output instead.
    return "n/a" if s.harness == "shell" else s.tracker.state


def _summary(s) -> dict:
    return {"id": s.id, "name": s.name, "harness": s.harness, "model": s.model,
            "working_dir": s.working_dir, "parent_id": s.parent_id,
            "state": _state(s), "alive": s.alive}


def _next_child_name(parent) -> str:
    taken = {s.name for s in _deps["pty"].sessions.values()
             if s.parent_id == parent.id or s.alive}
    n = 1
    while f"{parent.name}.{n}" in taken:
        n += 1
    return f"{parent.name}.{n}"


def _make_worktree(cwd: str, branch: str) -> str:
    """`git worktree add` a sibling checkout for a worker: <repo>-worktrees/<branch>.
    New branch from HEAD when it does not exist, else the existing branch. Raises
    ValueError with git's own message on failure (e.g. branch already checked out)."""
    top = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, timeout=15)
    if top.returncode != 0:
        raise ValueError(f"{cwd} is not inside a git repository")
    root = os.path.normpath(top.stdout.strip())
    path = os.path.join(os.path.dirname(root), f"{os.path.basename(root)}-worktrees",
                        branch.replace("/", "-"))
    if os.path.exists(path):
        raise ValueError(f"worktree path already exists: {path}")
    exists = subprocess.run(["git", "-C", root, "rev-parse", "--verify", "--quiet",
                             f"refs/heads/{branch}"],
                            capture_output=True, text=True, timeout=15).returncode == 0
    argv = ["git", "-C", root, "worktree", "add", path] + ([branch] if exists else ["-b", branch])
    res = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    if res.returncode != 0:
        raise ValueError((res.stderr or res.stdout).strip() or "git worktree add failed")
    return path


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
        return _err(401, _UNAUTH)
    return JSONResponse({**_summary(caller), "can_spawn": caller.parent_id is None,
                         "max_children": None})


@router.get("/api/agent/children")
async def list_children(request: Request):
    caller = _caller(request)
    if caller is None:
        return _err(401, _UNAUTH)
    return JSONResponse({"children": [_summary(s) for s in _children(caller.id)]})


@router.get("/api/agent/peers")
async def peers(request: Request):
    """Every other live Studio session, READ-ONLY -- including another session's workers.
    Hiding workers made a skill-spawned roster (/fw-agents spawns its agents as workers
    of whichever session ran it) invisible to every other agent (2026-10-31). Seeing a
    session never grants control of it: that takes /adopt, which the user approves."""
    caller = _caller(request)
    if caller is None:
        return _err(401, _UNAUTH)
    sessions = _deps["pty"].sessions
    out = []
    for s in list(sessions.values()):
        if s.id == caller.id or s.parent_id == caller.id or not s.alive:
            continue
        d = _summary(s)
        parent = sessions.get(s.parent_id) if s.parent_id else None
        out.append({**{k: d[k] for k in ("id", "name", "harness", "state", "working_dir")},
                    "parent_id": s.parent_id,
                    "parent_name": parent.name if parent else None,
                    "orphaned": bool(s.parent_id) and not (parent and parent.alive)})
    return JSONResponse({"peers": out})


@router.post("/api/agent/spawn")
async def spawn(request: Request):
    caller = _caller(request)
    if caller is None:
        return _err(401, _UNAUTH)
    if caller.parent_id is not None:
        return _err(403, "a worker cannot spawn workers (depth is limited to 1)")
    body = await _json_body(request)
    prompt = body.get("prompt")
    if prompt is not None and (not isinstance(prompt, str) or len(prompt.encode()) > _MAX_PROMPT_BYTES):
        return _err(400, "prompt must be a string under 100 KB")
    name = body.get("name")
    if name is not None and (not isinstance(name, str) or not name.strip() or len(name) > 100):
        return _err(400, "name must be a non-empty string of at most 100 characters")
    name = name.strip() if name else _next_child_name(caller)
    if any(s.name == name for s in _children(caller.id)):
        return _err(409, f"this session already has a live worker named {name!r}")
    # A name is an address (Claude Code's SendMessage name is the --name Studio passes),
    # so two live sessions sharing one makes a message's destination a guess.
    twin = next((s for s in list(_deps["pty"].sessions.values())
                 if s.alive and s.name == name and s.id != caller.id), None)
    if twin is not None:
        return JSONResponse({"error": f"another live session is already named {name!r}; "
                                      "adopt it instead of spawning a twin",
                             "live_elsewhere": {"id": twin.id, "parent_id": twin.parent_id}},
                            status_code=409)

    harness = body.get("harness") or caller.harness
    harness = _HARNESS_ALIASES.get(harness, harness)
    same = harness == caller.harness
    if prompt and harness == "shell":
        return _err(400, "a shell worker takes command lines via /run, not a prompt")
    model = body.get("model")
    if not model:
        if same:
            model = caller.model
        elif harness in ("shell", "plexar-harness"):
            model = ""  # shell: none; Plexar Harness: the rig profile's own default
        else:
            return _err(400, f"model is required when the worker's harness ({harness}) differs from yours")

    cwd = body.get("cwd") or caller.working_dir
    worktree = body.get("worktree")
    if worktree is not None:
        if not isinstance(worktree, str) or not _BRANCH_RE.match(worktree) or ".." in worktree:
            return _err(400, "worktree must be a branch name")
        try:
            cwd = await asyncio.to_thread(_make_worktree, cwd, worktree)
        except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
            return _err(400, f"could not create worktree: {exc}")

    # Inherit, never escalate. Only the harness/model/effort/cwd may be chosen.
    spawn_body = {
        "name": name,
        "workdir": cwd,
        "harness": harness,
        "model": model,
        "effort": body.get("effort", caller.effort if same else ""),
        "permissionMode": caller.permission_mode,
        "bypassPermissions": bool(caller.bypass_permissions),
    }
    if same and caller.provider not in ("anthropic", ""):
        spawn_body["provider"] = caller.provider
    try:
        result = await _deps["create"](spawn_body, parent_id=caller.id)
    except Exception as exc:  # _CreateTerminalRefused or ValueError from the one spawn path
        status = getattr(exc, "status", 400)
        payload = getattr(exc, "payload", None) or {"error": str(exc)}
        return JSONResponse(payload, status_code=status)
    child_id = result.get("id")
    logger.info("Session %s spawned %s worker %s (%s)", caller.id, harness, child_id, name)
    if prompt and child_id:
        asyncio.create_task(_deliver_when_ready(child_id, prompt))
    child = _deps["pty"].sessions.get(child_id)
    return JSONResponse({"worker": _summary(child) if child else result,
                         "prompt_queued": bool(prompt)}, status_code=201)


@router.post("/api/agent/{ref}/prompt")
async def prompt_child(ref: str, request: Request):
    _, child, refusal = await _authed_child(request, ref)
    if refusal:
        return refusal
    if child.harness == "shell":
        return _err(409, "a shell worker takes command lines via /run")
    text = (await _json_body(request)).get("text")
    if not isinstance(text, str) or not text.strip() or len(text.encode()) > _MAX_PROMPT_BYTES:
        return _err(400, "text must be a non-empty string under 100 KB")
    if _state(child) == "waiting":
        return _err(409, "worker is blocked on a question or approval; read it and ask the user")
    if not await _deps["idle"](child.id, timeout=30.0):
        return _err(409, "worker did not become idle within 30s")
    if not await _deps["paste"](child.id, text):
        return _err(502, "prompt write failed")
    return JSONResponse({"ok": True, "worker": child.id})


@router.post("/api/agent/{ref}/keys")
async def send_keys(ref: str, request: Request):
    """Logical keys (`esc`, `ctrl+c`, `enter`, `up`, `y`, ...), all validated before any
    byte is written. Allowed on a blocked worker: Esc / Ctrl+C are how you get out."""
    _, child, refusal = await _authed_child(request, ref)
    if refusal:
        return refusal
    keys = (await _json_body(request)).get("keys")
    if isinstance(keys, str):
        keys = keys.split()
    if not isinstance(keys, list) or not keys or len(keys) > 64:
        return _err(400, "keys must be a non-empty list of at most 64 key names")
    unknown = [k for k in keys if not isinstance(k, str) or k.lower() not in _KEYS]
    if unknown:
        return _err(400, f"unknown keys: {unknown}")
    if not await _deps["write"](child.id, "".join(_KEYS[k.lower()] for k in keys)):
        return _err(502, "key write failed")
    return JSONResponse({"ok": True, "sent": len(keys)})


@router.post("/api/agent/{ref}/run")
async def run_command(ref: str, request: Request):
    """One command line into a SHELL worker: text and Enter as one write. Returns
    `after`, the output sequence to pass to /wait-output so it sees only new output."""
    _, child, refusal = await _authed_child(request, ref)
    if refusal:
        return refusal
    if child.harness != "shell":
        return _err(409, "run is for shell workers; use /prompt for an agent worker")
    command = (await _json_body(request)).get("command")
    if (not isinstance(command, str) or not command.strip() or "\n" in command
            or "\r" in command or len(command) > 8000):
        return _err(400, "command must be one non-empty line under 8000 characters")
    mark = child.history.sequence
    if not await _deps["write"](child.id, command + "\r"):
        return _err(502, "command write failed")
    return JSONResponse({"ok": True, "after": mark})


@router.get("/api/agent/{ref}/wait")
async def wait_child(ref: str, request: Request, until: str = "settled", timeout_ms: int = 120_000):
    """Wait for an agent worker's state. ``settled`` = idle or waiting, after first
    seeing it leave idle (so a wait issued right after a prompt does not return on the
    stale pre-prompt idle). ``waiting`` = blocked on a question/approval. ``idle``.
    ``stalled: true`` = settled without ever seeing the turn start: the prompt may not
    have landed, so read before re-prompting."""
    _, child, refusal = await _authed_child(request, ref, alive=False)
    if refusal:
        return refusal
    if child.harness == "shell":
        return _err(409, "a shell worker has no agent state; use /wait-output")
    if until not in ("settled", "idle", "waiting"):
        return _err(400, "until must be settled, idle or waiting")
    deadline = time.monotonic() + min(max(timeout_ms, 0), _WAIT_MAX_MS) / 1000
    grace_end = time.monotonic() + _ACTIVITY_GRACE
    saw_activity = False
    while True:
        state = _state(child) if child.alive else "ended"
        if state in ("busy", "waiting"):
            saw_activity = True
        done = (state == "ended"
                or (until == "waiting" and state == "waiting")
                or (until == "idle" and state == "idle")
                or (until == "settled" and state in ("idle", "waiting")
                    and (saw_activity or time.monotonic() >= grace_end)))
        if done:
            stalled = until == "settled" and state != "ended" and not saw_activity
            return JSONResponse({"state": state, "timed_out": False,
                                 "saw_activity": saw_activity, "stalled": stalled})
        if time.monotonic() >= deadline:
            return JSONResponse({"state": state, "timed_out": True,
                                 "saw_activity": saw_activity, "stalled": False})
        await asyncio.sleep(_POLL_S)


def _output_text(child, after: Optional[int] = None, chunks: int = 400) -> str:
    raw = "".join(d for seq, d, _ in list(child.history.chunks)[-chunks:]
                  if after is None or seq > after)
    return _ANSI_RE.sub("", raw).replace("\r\n", "\n").replace("\r", "\n")


@router.get("/api/agent/{ref}/wait-output")
async def wait_output(ref: str, request: Request, match: Optional[str] = None,
                      regex: Optional[str] = None, after: Optional[int] = None,
                      timeout_ms: int = 120_000):
    """Wait until the worker's output (ANSI-stripped) contains `match` (literal) or
    matches `regex`. What is already there is searched first, so output that arrived
    before the call still matches; pass `after` (from /run) to search only newer output."""
    _, child, refusal = await _authed_child(request, ref, alive=False)
    if refusal:
        return refusal
    if (match is None) == (regex is None):
        return _err(400, "give exactly one of match or regex")
    if regex is not None:
        if len(regex) > _MAX_REGEX:
            return _err(400, "regex too long")
        try:
            pattern = re.compile(regex)
        except re.error as exc:
            return _err(400, f"invalid regex: {exc}")
    else:
        pattern = re.compile(re.escape(match))
    deadline = time.monotonic() + min(max(timeout_ms, 0), _WAIT_MAX_MS) / 1000
    while True:
        text = await asyncio.to_thread(_output_text, child, after)
        found = pattern.search(text)
        if found:
            start = text.rfind("\n", 0, found.start()) + 1
            end = text.find("\n", found.end())
            line = text[start:end if end != -1 else len(text)].strip()
            return JSONResponse({"matched": True, "line": line, "timed_out": False, "ended": False})
        if not child.alive:
            return JSONResponse({"matched": False, "line": None, "timed_out": False, "ended": True})
        if time.monotonic() >= deadline:
            return JSONResponse({"matched": False, "line": None, "timed_out": True, "ended": False})
        await asyncio.sleep(_POLL_S)


def _tail(child, lines: int, ansi: bool) -> str:
    if ansi:
        raw = "".join(d for _, d, _ in list(child.history.chunks)[-400:])
        return "\n".join(raw.replace("\r\n", "\n").split("\n")[-lines:])
    kept = [ln.rstrip() for ln in _output_text(child).split("\n") if ln.strip()]
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
async def read_child(ref: str, request: Request, lines: int = 80, format: str = "text"):
    """``latest_assistant`` is the clean last answer (Claude Code transcript). ``screen``
    is the output tail: ``format=text`` strips ANSI (approximate for a full-screen TUI),
    ``format=ansi`` keeps colours and styling as evidence."""
    _, child, refusal = await _authed_child(request, ref, alive=False)
    if refusal:
        return refusal
    if format not in ("text", "ansi"):
        return _err(400, "format must be text or ansi")
    lines = min(max(lines, 1), 1000)
    latest = await asyncio.to_thread(_latest_assistant, child)
    return JSONResponse({"worker": child.id, "state": _state(child) if child.alive else "ended",
                         "latest_assistant": latest,
                         "screen": await asyncio.to_thread(_tail, child, lines, format == "ansi")})


@router.delete("/api/agent/{ref}")
async def close_child(ref: str, request: Request):
    _, child, refusal = await _authed_child(request, ref, alive=False)
    if refusal:
        return refusal
    _deps["pty"].kill_terminal(child.id)
    return JSONResponse({"ok": True, "closed": child.id})


# ── Clear: reset a worker's conversation, confirmed ──────────────────────────
#
# The pane, its terminal id, its token, its name and its workers all survive a clear;
# only the CLI's conversation resets. That is what lets an orchestrator refresh a
# standing agent (or itself) without its SendMessage name or its roster changing.

_CLEAR_COMMANDS = {"claude-code": "/clear", "codex": "/new"}
_CLEAR_CONFIRM_S = 15.0
# Codex only, and UNVERIFIED against a live Codex: a TUI that resets its conversation is
# expected to repaint from scratch (erase-display or a full reset). Claude Code does NOT
# (measured 2026-10-31), which is why it is confirmed by its transcript instead.
_CLEAR_SCREEN_RE = re.compile(r"\x1b\[[23]J|\x1bc")
_CLEAR_RECORD = "<command-name>/clear</command-name>"


def _transcript_dir(s) -> Optional[str]:
    """~/.claude/projects/<project-id>, derived exactly as pty_manager._get_jsonl_path."""
    if not s.working_dir:
        return None
    project_id = s.working_dir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
    return os.path.join(os.path.expanduser("~"), ".claude", "projects", project_id)


def _transcripts(d: Optional[str]) -> set[str]:
    try:
        return {f for f in os.listdir(d) if f.endswith(".jsonl")} if d else set()
    except OSError:
        return set()


def _cleared_transcript(s, d: Optional[str], before: set[str]) -> Optional[str]:
    """A transcript that appeared after the clear and opens with the /clear command
    record: Claude Code's /clear starts a NEW conversation file (measured 2026-10-31:
    the first user records are the local-command caveat and `<command-name>/clear`).
    Files other live sessions hold are never claimed (the bug #15 family)."""
    held = {f"{o.claude_session_id}.jsonl" for o in list(_deps["pty"].sessions.values())
            if o.id != s.id and getattr(o, "claude_session_id", None)}
    for f in _transcripts(d) - before - held:
        try:
            with open(os.path.join(d, f), encoding="utf-8", errors="replace") as fh:
                head = fh.read(16_384)
        except OSError:
            continue
        if _CLEAR_RECORD in head:
            return f[:-len(".jsonl")]
    return None


async def _clear_session(s, then_prompt: Optional[str] = None) -> dict:
    """Submit the harness's reset command, CONFIRM it took, then optionally prompt.

    Claude Code is confirmed by the new transcript /clear opens, and the session is
    re-pointed at it, so usage, `read`'s latest_assistant and the sidebar follow the
    new conversation instead of reporting the old one. Codex is confirmed by a
    full-screen repaint. Unconfirmed is reported, never assumed: a clear swallowed by
    a composer leaves the old context in place, and an orchestrator that believed
    otherwise would brief an agent that still remembers the last sprint."""
    command = _CLEAR_COMMANDS[s.harness]
    if not await _deps["idle"](s.id, timeout=30.0):
        return {"ok": False, "error": "session did not become idle within 30s"}
    mark = s.history.sequence
    tdir = _transcript_dir(s) if s.harness == "claude-code" else None
    before = await asyncio.to_thread(_transcripts, tdir)
    if not await _deps["paste"](s.id, command):
        return {"ok": False, "error": f"{command} write failed"}
    confirmed = False
    deadline = time.monotonic() + _CLEAR_CONFIRM_S
    while True:
        if s.harness == "claude-code":
            new_id = await asyncio.to_thread(_cleared_transcript, s, tdir, before)
            if new_id:
                logger.info("Session %s cleared: conversation %s -> %s",
                            s.id, getattr(s, "claude_session_id", None), new_id)
                s.claude_session_id = new_id
                confirmed = True
                break
        else:
            raw = "".join(d for seq, d, _ in list(s.history.chunks) if seq > mark)
            if _CLEAR_SCREEN_RE.search(raw):
                confirmed = True
                break
        if time.monotonic() >= deadline:
            break
        await asyncio.sleep(_POLL_S)
    prompted = False
    if then_prompt:
        if not await _deps["idle"](s.id, timeout=30.0):
            return {"ok": False, "confirmed": confirmed,
                    "error": "cleared, but the session did not become idle for the prompt"}
        prompted = await _deps["paste"](s.id, then_prompt)
        if not prompted:
            return {"ok": False, "confirmed": confirmed, "error": "prompt write failed"}
    return {"ok": True, "confirmed": confirmed, "command": command, "prompted": prompted}


def _check_clearable(s) -> Optional[str]:
    if s.harness not in _CLEAR_COMMANDS:
        return f"clear is not supported for a {s.harness} session"
    if _state(s) == "waiting":
        return "session is blocked on a question or approval; read it and ask the user"
    return None


def _prompt_arg(body: dict, key: str) -> tuple[Optional[str], Optional[JSONResponse]]:
    v = body.get(key)
    if v is None:
        return None, None
    if not isinstance(v, str) or not v.strip() or len(v.encode()) > _MAX_PROMPT_BYTES:
        return None, _err(400, f"{key} must be a non-empty string under 100 KB")
    return v, None


@router.post("/api/agent/{ref}/clear")
async def clear_child(ref: str, request: Request):
    """Reset a worker's conversation (/clear, or /new under Codex), confirm it took, then
    optionally submit `then_prompt` (its boot line). Same pane, id, name and token."""
    _, child, refusal = await _authed_child(request, ref)
    if refusal:
        return refusal
    why = _check_clearable(child)
    if why:
        return _err(409, why)
    then_prompt, bad = _prompt_arg(await _json_body(request), "then_prompt")
    if bad:
        return bad
    result = await _clear_session(child, then_prompt)
    logger.info("Worker %s cleared (confirmed=%s)", child.id, result.get("confirmed"))
    return JSONResponse({**result, "worker": child.id}, status_code=200 if result["ok"] else 502)


# ── Approvals: what an agent may do only once the human says so ──────────────
#
# Two acts are gated: ADOPTING a session the agent did not spawn (it gains prompt,
# keys, clear and close over it) and SELF-REFRESH (the agent wipes its own context).
# The agent files a request; the desktop shows it (the pending list rides the
# /api/terminals poll, so there is no new poller) and the user answers in an in-app
# dialog through the ordinary origin-guarded /api/agent-approvals routes.
#
# HONEST LIMIT: those routes are loopback and unauthenticated like Studio's others, so
# an agent determined to approve its own request could curl them. The gate stops an
# agent acting on its own initiative through this API; it is not a sandbox against a
# hostile process on the machine, which nothing on loopback is.

_APPROVAL_TTL_S = 900.0
_approvals: dict[str, dict] = {}


def _expire_approvals() -> None:
    now = time.time()
    for a in _approvals.values():
        if a["status"] == "pending" and now - a["created_at"] > _APPROVAL_TTL_S:
            a["status"], a["detail"] = "expired", "no answer within 15 minutes"
    # Finished records stay an hour so a waiting agent can still read its verdict.
    for aid in [k for k, a in _approvals.items()
                if a["status"] != "pending" and now - a["created_at"] > 3600]:
        del _approvals[aid]


def _public_approval(a: dict) -> dict:
    return {k: a[k] for k in ("id", "kind", "caller_id", "caller_name", "target_id",
                              "target_name", "prompt", "status", "detail", "created_at")}


def pending_approvals() -> list[dict]:
    """For the /api/terminals poll: what the user still has to answer."""
    _expire_approvals()
    return [_public_approval(a) for a in _approvals.values() if a["status"] == "pending"]


def _file_approval(kind: str, caller, target, prompt: Optional[str] = None) -> dict:
    _expire_approvals()
    for a in _approvals.values():
        if (a["status"] == "pending" and a["kind"] == kind and a["caller_id"] == caller.id
                and a["target_id"] == target.id):
            a["prompt"] = prompt  # a re-request replaces the boot line, not the queue slot
            return a
    a = {"id": secrets.token_hex(6), "kind": kind, "caller_id": caller.id,
         "caller_name": caller.name, "target_id": target.id, "target_name": target.name,
         "prompt": prompt, "status": "pending", "detail": None, "created_at": time.time()}
    _approvals[a["id"]] = a
    logger.info("Session %s requested %s of %s (approval %s)", caller.id, kind, target.id, a["id"])
    return a


def _adopt_refusal(caller, target) -> Optional[tuple[int, str]]:
    """Checked when the request is filed AND again when it is approved: the world may
    have moved in between (the target spawned workers, a session closed)."""
    if not (caller.alive and target.alive and target.id in _deps["pty"].sessions):
        return 404, "session is gone"
    if caller.parent_id is not None:
        return 403, "a worker cannot adopt workers (depth is limited to 1)"
    if target.id == caller.id:
        return 400, "a session cannot adopt itself"
    if _children(target.id):
        return 409, (f"{target.name!r} has live workers of its own; depth is limited to 1, "
                     "so it cannot become a worker")
    if target.bypass_permissions and not caller.bypass_permissions:
        return 403, (f"{target.name!r} runs with bypassed permissions and this session does "
                     "not; adopting it would escalate")
    return None


def _resolve_peer(caller, ref: str):
    """Any live session but the caller, by id or exact unique name -> (session, None)
    or (None, (status, why))."""
    sessions = _deps["pty"].sessions
    if ref in sessions and sessions[ref].alive and ref != caller.id:
        return sessions[ref], None
    named = [s for s in list(sessions.values()) if s.alive and s.name == ref and s.id != caller.id]
    if len(named) > 1:
        return None, (409, f"{len(named)} live sessions are named {ref!r}; use an id from peers")
    if not named:
        return None, (404, "no such live session")
    return named[0], None


async def _run_self_refresh(a: dict) -> None:
    """After approval: wait for the requester's own turn to end (it is still running the
    tool call that filed the request), then clear it and submit its boot line."""
    s = _deps["pty"].sessions.get(a["caller_id"])
    try:
        if s is None or not s.alive:
            a["status"], a["detail"] = "failed", "session is gone"
            return
        a["status"] = "running"
        if not await _deps["idle"](s.id, timeout=1800.0):
            a["status"], a["detail"] = "failed", "session never became idle (30 min)"
            return
        result = await _clear_session(s, a["prompt"])
        a["status"] = "done" if result["ok"] else "failed"
        a["detail"] = result.get("error") or ("confirmed" if result.get("confirmed")
                                              else "clear submitted but NOT confirmed")
    except Exception:
        logger.warning("Self-refresh %s failed", a["id"], exc_info=True)
        a["status"], a["detail"] = "failed", "internal error; see cockpit.log"


@router.post("/api/agent/adopt")
async def adopt(request: Request):
    """Ask the user to make a live session (top-level, or another session's worker) one
    of the caller's workers. 202 + a pending approval; poll /api/agent/approvals/{id}."""
    caller = _caller(request)
    if caller is None:
        return _err(401, _UNAUTH)
    ref = (await _json_body(request)).get("peer")
    if not isinstance(ref, str) or not ref.strip():
        return _err(400, "peer must be a session id or name")
    ref = ref.strip()
    mine = _resolve_child(caller, ref)
    if mine is not None:
        return JSONResponse({"already": True, "worker": _summary(mine)})
    target, miss = _resolve_peer(caller, ref)
    if miss:
        return _err(*miss)
    why = _adopt_refusal(caller, target)
    if why:
        return _err(*why)
    return JSONResponse({"approval": _public_approval(_file_approval("adopt", caller, target))},
                        status_code=202)


@router.post("/api/agent/self/refresh")
async def self_refresh(request: Request):
    """Ask the user to let the caller clear ITS OWN conversation and restart on `prompt`
    (its hand-off file is its state). Runs after approval, once the caller's turn ends.
    Its workers are untouched and stay its workers: same pane, same id."""
    caller = _caller(request)
    if caller is None:
        return _err(401, _UNAUTH)
    prompt, bad = _prompt_arg(await _json_body(request), "prompt")
    if bad:
        return bad
    if not prompt:
        return _err(400, "prompt (the boot line to restart on) is required")
    if caller.harness not in _CLEAR_COMMANDS:
        return _err(409, f"clear is not supported for a {caller.harness} session")
    a = _file_approval("self_refresh", caller, caller, prompt)
    return JSONResponse({"approval": _public_approval(a)}, status_code=202)


@router.get("/api/agent/approvals/{approval_id}")
async def approval_status(approval_id: str, request: Request, wait_ms: int = 0):
    """The caller's own request. `wait_ms` long-polls until it leaves `pending`."""
    caller = _caller(request)
    if caller is None:
        return _err(401, _UNAUTH)
    deadline = time.monotonic() + min(max(wait_ms, 0), _WAIT_MAX_MS) / 1000
    while True:
        _expire_approvals()
        a = _approvals.get(approval_id)
        if a is None or a["caller_id"] != caller.id:
            return _err(404, "no such approval request of this session")
        if a["status"] != "pending" or time.monotonic() >= deadline:
            return JSONResponse({"approval": _public_approval(a)})
        await asyncio.sleep(_POLL_S)


@router.get("/api/agent-approvals")
async def list_approvals():
    """Desktop: requests awaiting the user (also carried on GET /api/terminals)."""
    return JSONResponse({"approvals": pending_approvals()})


@router.post("/api/agent-approvals/{approval_id}")
async def answer_approval(approval_id: str, request: Request):
    """Desktop: {"approve": true|false}. An adopt is re-checked at this moment."""
    approve = (await _json_body(request)).get("approve")
    if not isinstance(approve, bool):
        return _err(400, "approve must be true or false")
    _expire_approvals()
    a = _approvals.get(approval_id)
    if a is None or a["status"] != "pending":
        return _err(404, "no such pending request")
    if not approve:
        a["status"], a["detail"] = "denied", "the user declined"
        logger.info("Approval %s (%s) denied", a["id"], a["kind"])
        return JSONResponse({"approval": _public_approval(a)})
    sessions = _deps["pty"].sessions
    caller, target = sessions.get(a["caller_id"]), sessions.get(a["target_id"])
    if caller is None or target is None:
        a["status"], a["detail"] = "failed", "session is gone"
        return JSONResponse({"approval": _public_approval(a)}, status_code=409)
    if a["kind"] == "adopt":
        why = _adopt_refusal(caller, target)
        if why:
            a["status"], a["detail"] = "failed", why[1]
            return JSONResponse({"approval": _public_approval(a)}, status_code=409)
        previous = target.parent_id
        target.parent_id = caller.id
        a["status"], a["detail"] = "done", f"adopted (previous parent: {previous or 'none'})"
        logger.info("Session %s adopted %s (previous parent %s)", caller.id, target.id, previous)
    else:
        a["status"] = "approved"
        asyncio.create_task(_run_self_refresh(a))
    return JSONResponse({"approval": _public_approval(a)})


# ── Events: push instead of poll ─────────────────────────────────────────────
#
# A long-poll over the caller's workers' state transitions. `studio_cli.py events
# --follow` prints one JSON line per event, which is exactly the shape Claude Code's
# Monitor tool turns into a wake-up -- so an orchestrator is told when a worker
# finishes or asks, instead of sitting in `wait` on one worker while others idle.
# Transitions are detected while someone listens; a gap between calls is diffed
# against the last state seen, so a finished turn is not missed, only merged.

_EVENT_KINDS = {"idle": "idle", "waiting": "asking", "ended": "ended"}
_event_state: dict[str, dict] = {}


def _collect_events(caller) -> dict:
    st = _event_state.setdefault(caller.id, {"seq": 0, "last": None,
                                             "log": collections.deque(maxlen=500)})
    sessions = _deps["pty"].sessions
    current = {s.id: (_state(s) if s.alive else "ended") for s in list(sessions.values())
               if s.parent_id == caller.id and s.harness != "shell"}
    seeding = st["last"] is None
    last = st["last"] or {}

    def emit(wid, event, state, prev):
        st["seq"] += 1
        s = sessions.get(wid)
        st["log"].append({"seq": st["seq"], "event": event, "worker": wid,
                          "name": s.name if s else wid, "state": state, "previous": prev,
                          "at": time.time()})

    for wid, state in current.items():
        prev = last.get(wid)
        if prev == state or state not in _EVENT_KINDS:
            continue
        # On the first look only a blocked worker is news; the rest is a baseline.
        if seeding and state != "waiting":
            continue
        emit(wid, _EVENT_KINDS[state], state, prev)
    for wid, prev in last.items():
        if wid not in current and prev != "ended":  # purged, or adopted away
            emit(wid, "gone", "gone", prev)
    st["last"] = current
    return st


@router.get("/api/agent/events")
async def events(request: Request, after: Optional[int] = None, timeout_ms: int = 60_000):
    """Worker events with seq > `after`: idle (a turn finished), asking (blocked on a
    question/approval), ended, gone. Returns as soon as there is one, else at timeout.
    Pass the returned `next` as the following call's `after`. With no `after`, the
    first call reports workers already blocked and then follows from now."""
    caller = _caller(request)
    if caller is None:
        return _err(401, _UNAUTH)
    if after is None:
        prior = _event_state.get(caller.id)
        after = prior["seq"] if prior else 0
    deadline = time.monotonic() + min(max(timeout_ms, 0), _WAIT_MAX_MS) / 1000
    while True:
        st = _collect_events(caller)
        found = [e for e in st["log"] if e["seq"] > after]
        if found or time.monotonic() >= deadline or not caller.alive:
            return JSONResponse({"events": found, "next": st["seq"]})
        await asyncio.sleep(_POLL_S)
