"""The `plexar-harness` session kind: one `HarnessRuntime` per workspace.

Not a PTY. The harness speaks ACP over the child's stdio; `plexar_harness_client`
(vendored byte-for-byte, contract v3) is the whole wire. This module owns the
Studio side: the key, the per-workspace runtime registry, the update pump, the
permission round-trip to the browser, per-session labels and idle stop.

Rules that are load-bearing (harness docs/plexar/07-studio-api-contract.md v3):

- The key is ``PLEXAR_HARNESS_KEY`` (never ``PLEXAR_API_KEY``), stored in
  config.json beside the other secrets, NEVER settings.json, never returned or
  logged. It is ALWAYS set in the child env; with no key configured we refuse
  with reason ``key_missing`` and do not spawn -- an unset env would let a key
  from the harness's own credential files leak in.
- ``start()`` and every client call block, so they run in ``asyncio.to_thread``.
- One pump thread per runtime iterates ``runtime.updates()`` in arrival order and
  hands each Update to the loop with ``call_soon_threadsafe``. ``drain()`` is
  never used: it reorders.
- ``on_permission`` runs on the client's own thread. It blocks on a
  ``threading.Event`` for up to 120 s; a timeout or an absent subscriber answers
  ``reject-once`` (fail closed).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

import app_paths
import settings_store
from plexar_harness_client import HarnessError, HarnessRuntime

logger = logging.getLogger("cockpit.harness")

KEY_FIELD = "plexar_harness_key"
PERMISSION_TIMEOUT_S = 120.0
IDLE_STOP_AFTER_S = 600.0
MAX_LIST_PAGES = 10
ALLOWED_OPTIONS = ("allow-once", "reject-once")
MIN_NODE = (22, 19)

FRIENDLY = {
    "key_missing": "No Plexar Harness key is set. Add one in Settings.",
    "key_rejected": "The model server rejected your Plexar Harness key.",
    "rig_unreachable": "The model server did not answer. Check that it is running.",
    "node_too_old": "Node.js 22.19 or newer is required to run the Plexar Harness.",
    "profile_install_failed": "The Plexar Harness could not create its plexar-acp profile.",
}
DEFAULT_FRIENDLY = "The Plexar Harness could not start."


def friendly(reason: str | None) -> str:
    return FRIENDLY.get(reason or "", DEFAULT_FRIENDLY)


# ---------------------------------------------------------------------------
# Key (config.json, the secrets file) -- same shape as remote_tunnel's token
# ---------------------------------------------------------------------------

def key_source() -> str | None:
    """Where this user's harness key comes from: "settings" (saved in Studio's
    config.json), "environment" (PLEXAR_HARNESS_KEY in Studio's own process env,
    which is the harness's documented variable), or None.

    Both are per OS user. The harness's OWN fallbacks (its stored-credentials file,
    project and harness-home .env) are still never used: Studio always passes the key
    it resolved here, and refuses to start when there is none (DEC-229)."""
    value = settings_store._read_config().get(KEY_FIELD)
    if isinstance(value, str) and value:
        return "settings"
    if os.environ.get("PLEXAR_HARNESS_KEY"):
        return "environment"
    return None


def get_key() -> str | None:
    value = settings_store._read_config().get(KEY_FIELD)
    if isinstance(value, str) and value:
        return value
    return os.environ.get("PLEXAR_HARNESS_KEY") or None


def set_key(key: str) -> None:
    data = settings_store._read_config()
    data[KEY_FIELD] = key
    settings_store._write_config(data)


def clear_key() -> None:
    data = settings_store._read_config()
    if KEY_FIELD in data:
        del data[KEY_FIELD]
        settings_store._write_config(data)


def _harness_settings() -> dict:
    try:
        block = settings_store.read_settings().get("harness") or {}
    except Exception:  # noqa: BLE001 - a damaged settings file must not break the harness
        logger.warning("Could not read harness settings", exc_info=True)
        return {}
    return block if isinstance(block, dict) else {}


def permission_mode() -> str:
    return str(_harness_settings().get("permission_mode") or "workspace-write")


# ---------------------------------------------------------------------------
# Labels (~/.plexar-studio/harness_labels.json, {session_id: label})
# ---------------------------------------------------------------------------

_labels_lock = threading.Lock()


def _labels_path() -> Path:
    return app_paths.data_path("harness_labels.json")


def read_labels() -> dict[str, str]:
    path = _labels_path()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("Could not read harness labels at %s", path, exc_info=True)
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}


def write_label(session_id: str, label: str | None) -> None:
    with _labels_lock:
        labels = read_labels()
        if label:
            labels[session_id] = label
        else:
            labels.pop(session_id, None)
        path = _labels_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(labels, fh, indent=2)
        os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Status probes
# ---------------------------------------------------------------------------

def _node_version() -> str | None:
    try:
        out = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=3,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        logger.info("node --version failed", exc_info=True)
        return None
    version = (out.stdout or "").strip()
    return version or None


def node_ok(version: str | None) -> bool:
    m = re.match(r"v?(\d+)\.(\d+)", version or "")
    return bool(m) and (int(m.group(1)), int(m.group(2))) >= MIN_NODE


def normalize_workspace(workspace: str | None) -> str:
    """The registry key. Raises ValueError for a missing/relative/non-directory path."""
    if not workspace or not isinstance(workspace, str) or not os.path.isabs(workspace):
        raise ValueError("workspace must be an absolute path")
    if not os.path.isdir(workspace):
        raise ValueError("workspace is not a directory")
    return os.path.normcase(os.path.abspath(workspace))


class SessionBusy(Exception):
    pass


class UnknownSession(Exception):
    pass


class _Entry:
    def __init__(self, key: str, workspace: str, runtime: Any) -> None:
        self.key = key
        self.workspace = workspace
        self.runtime = runtime
        self.open: set[str] = set()
        self.stopping = False


class HarnessManager:
    def __init__(self, runtime_factory: Callable[..., Any] = HarnessRuntime,
                 permission_timeout: float = PERMISSION_TIMEOUT_S,
                 idle_stop_after: float = IDLE_STOP_AFTER_S) -> None:
        self.runtime_factory = runtime_factory
        self.permission_timeout = permission_timeout
        self.idle_stop_after = idle_stop_after
        self._loop: asyncio.AbstractEventLoop | None = None
        self._runtimes: dict[str, _Entry] = {}
        self._start_locks: dict[str, asyncio.Lock] = {}
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._idle_timers: dict[str, asyncio.TimerHandle] = {}
        self._session_ws: dict[str, str] = {}
        self._busy: set[str] = set()
        self._tasks: set[asyncio.Task] = set()
        self._permissions: dict[str, dict] = {}
        self._perm_lock = threading.Lock()

    # -- plumbing --------------------------------------------------------------
    def _bind_loop(self) -> asyncio.AbstractEventLoop:
        self._loop = asyncio.get_running_loop()
        return self._loop

    def _broadcast(self, key: str, frame: dict) -> None:
        for q in list(self._subs.get(key, ())):
            q.put_nowait(frame)

    def _threadsafe_broadcast(self, key: str, frame: dict) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._broadcast, key, frame)
        except RuntimeError:
            logger.info("Loop closed; dropped a harness frame", exc_info=True)

    # -- runtimes --------------------------------------------------------------
    async def ensure_runtime(self, workspace: str) -> _Entry:
        key = normalize_workspace(workspace)
        self._bind_loop()
        entry = self._runtimes.get(key)
        if entry is not None:
            return entry
        lock = self._start_locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._runtimes.get(key)
            if entry is not None:
                return entry
            api_key = await asyncio.to_thread(get_key)
            if not api_key:
                raise HarnessError("no PLEXAR_HARNESS_KEY configured", None, "key_missing")
            settings = await asyncio.to_thread(_harness_settings)
            kwargs: dict[str, Any] = {
                "workspace": Path(workspace),
                "env": {"PLEXAR_HARNESS_KEY": api_key,
                        "DSH_PERMISSION_MODE": str(settings.get("permission_mode") or "workspace-write")},
                "on_permission": self._permission_handler(key),
            }
            root = str(settings.get("root") or "").strip()
            if root:
                kwargs["harness_root"] = Path(root)
            runtime = self.runtime_factory(**kwargs)
            try:
                await asyncio.to_thread(runtime.start)
            except Exception as exc:
                logger.warning("Harness runtime failed to start for %s (reason=%s)", workspace,
                               getattr(exc, "reason", None), exc_info=True)
                try:
                    await asyncio.to_thread(runtime.stop)
                except Exception:
                    logger.warning("Stopping a failed harness runtime failed", exc_info=True)
                raise
            entry = _Entry(key, workspace, runtime)
            self._runtimes[key] = entry
            threading.Thread(target=self._pump, args=(entry,), name=f"harness-pump-{len(self._runtimes)}",
                             daemon=True).start()
            logger.info("Harness runtime started for %s", workspace)
            self._schedule_idle_check(key)
            return entry

    def _pump(self, entry: _Entry) -> None:
        try:
            for upd in entry.runtime.updates():
                self._threadsafe_broadcast(entry.key, {
                    "type": "update", "session_id": upd.session_id, "kind": upd.kind, "payload": upd.payload,
                })
        except Exception:
            logger.error("Harness update pump crashed", exc_info=True)
        loop = self._loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._runtime_exited, entry)
            except RuntimeError:
                logger.info("Loop closed before runtime exit was reported", exc_info=True)

    def _runtime_exited(self, entry: _Entry) -> None:
        if self._runtimes.get(entry.key) is entry:
            del self._runtimes[entry.key]
        for sid in [s for s, k in self._session_ws.items() if k == entry.key]:
            self._session_ws.pop(sid, None)
            self._busy.discard(sid)
        if entry.stopping:
            return
        proc = getattr(entry.runtime, "_proc", None)
        exit_code = None
        try:
            exit_code = proc.poll() if proc is not None else None
        except Exception:
            logger.warning("Could not read harness exit code", exc_info=True)
        reason = None
        for line in reversed(list(getattr(entry.runtime, "stderr_tail", []) or [])):
            m = re.match(r"plexar-harness: error (\w+):", line)
            if m:
                reason = m.group(1)
                break
        logger.warning("Harness runtime for %s exited (code=%s reason=%s)", entry.workspace, exit_code, reason)
        self._broadcast(entry.key, {
            "type": "runtime_error", "reason": reason, "exit_code": exit_code,
            "message": friendly(reason) if reason else "The Plexar Harness stopped unexpectedly.",
        })

    async def _stop_entry(self, entry: _Entry) -> None:
        entry.stopping = True
        if self._runtimes.get(entry.key) is entry:
            del self._runtimes[entry.key]
        try:
            await asyncio.to_thread(entry.runtime.stop)
        except Exception:
            logger.warning("Stopping harness runtime for %s failed", entry.workspace, exc_info=True)

    async def stop_all(self) -> None:
        for timer in self._idle_timers.values():
            timer.cancel()
        self._idle_timers.clear()
        for entry in list(self._runtimes.values()):
            await self._stop_entry(entry)
        with self._perm_lock:
            pending = list(self._permissions.values())
            self._permissions.clear()
        for rec in pending:
            rec["event"].set()

    # -- subscribers & idle stop ---------------------------------------------
    def subscribe(self, workspace: str) -> tuple[str, asyncio.Queue]:
        key = normalize_workspace(workspace)
        self._bind_loop()
        q: asyncio.Queue = asyncio.Queue()
        self._subs.setdefault(key, set()).add(q)
        timer = self._idle_timers.pop(key, None)
        if timer:
            timer.cancel()
        return key, q

    def unsubscribe(self, key: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(key)
        if subs:
            subs.discard(q)
            if not subs:
                del self._subs[key]
        self._schedule_idle_check(key)

    def _schedule_idle_check(self, key: str) -> None:
        if self._subs.get(key) or key not in self._runtimes or self._loop is None:
            return
        old = self._idle_timers.pop(key, None)
        if old:
            old.cancel()
        self._idle_timers[key] = self._loop.call_later(self.idle_stop_after, self._idle_fire, key)

    def _idle_fire(self, key: str) -> None:
        self._idle_timers.pop(key, None)
        entry = self._runtimes.get(key)
        if entry is None or self._subs.get(key):
            return
        if any(self._session_ws.get(s) == key for s in self._busy):
            self._schedule_idle_check(key)
            return
        logger.info("Stopping idle harness runtime for %s", entry.workspace)
        task = asyncio.ensure_future(self._stop_entry(entry))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # -- permissions -----------------------------------------------------------
    def _permission_handler(self, key: str) -> Callable[[dict], str]:
        def handler(params: dict) -> str:
            if not self._subs.get(key):
                logger.info("Harness permission request with no subscriber; rejecting")
                return "reject-once"
            request_id = uuid.uuid4().hex
            rec = {"event": threading.Event(), "choice": None, "key": key}
            with self._perm_lock:
                self._permissions[request_id] = rec
            self._threadsafe_broadcast(key, {
                "type": "permission", "request_id": request_id,
                "session_id": (params or {}).get("sessionId"), "params": params,
            })
            answered = rec["event"].wait(self.permission_timeout)
            with self._perm_lock:
                self._permissions.pop(request_id, None)
            choice = rec["choice"] if answered else None
            return choice if choice in ALLOWED_OPTIONS else "reject-once"
        return handler

    def answer_permission(self, request_id: str, option_id: str) -> bool:
        with self._perm_lock:
            rec = self._permissions.get(request_id)
            if rec is None:
                return False
            rec["choice"] = option_id
        rec["event"].set()
        return True

    # -- sessions --------------------------------------------------------------
    def _entry_for(self, session_id: str) -> _Entry:
        key = self._session_ws.get(session_id)
        entry = self._runtimes.get(key) if key else None
        if entry is None:
            raise UnknownSession(session_id)
        return entry

    async def list_sessions(self, workspace: str) -> list[dict]:
        entry = await self.ensure_runtime(workspace)
        rows: dict[str, dict] = {}
        cursor = None
        for _ in range(MAX_LIST_PAGES):
            page = await asyncio.to_thread(entry.runtime.list_sessions, cursor) or {}
            for s in page.get("sessions") or []:
                sid = s.get("sessionId")
                if sid and sid not in rows:
                    rows[sid] = s
            cursor = page.get("nextCursor")
            if not cursor:
                break
        order = list(entry.open - rows.keys()) + list(rows.keys())
        labels = await asyncio.to_thread(read_labels)
        return [{
            "session_id": sid, "label": labels.get(sid), "workspace": entry.workspace,
            "open": sid in entry.open, "busy": sid in self._busy,
        } for sid in order]

    async def new_session(self, workspace: str, label: str | None = None) -> dict:
        entry = await self.ensure_runtime(workspace)
        res = await asyncio.to_thread(entry.runtime.new_session) or {}
        sid = res.get("sessionId")
        if sid:
            entry.open.add(sid)
            self._session_ws[sid] = entry.key
            if label:
                await asyncio.to_thread(write_label, sid, label)
        return {"session_id": sid, "config_options": res.get("configOptions") or []}

    async def resume_session(self, session_id: str, workspace: str) -> dict:
        entry = await self.ensure_runtime(workspace)
        res = await asyncio.to_thread(entry.runtime.resume_session, session_id) or {}
        entry.open.add(session_id)
        self._session_ws[session_id] = entry.key
        return {"config_options": res.get("configOptions") or []}

    async def prompt(self, session_id: str, text: str) -> None:
        entry = self._entry_for(session_id)
        if session_id in self._busy:
            raise SessionBusy(session_id)
        self._busy.add(session_id)
        task = asyncio.ensure_future(self._run_turn(entry, session_id, text))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run_turn(self, entry: _Entry, session_id: str, text: str) -> None:
        stop_reason = error = None
        try:
            result = await asyncio.to_thread(entry.runtime.prompt, session_id, text) or {}
            stop_reason = result.get("stopReason")
        except HarnessError as exc:
            error = str(exc)
            logger.warning("Harness turn failed", exc_info=True)
        except Exception as exc:  # noqa: BLE001 - a turn must always end with turn_end
            error = str(exc) or type(exc).__name__
            logger.error("Harness turn crashed", exc_info=True)
        finally:
            self._busy.discard(session_id)
        self._broadcast(entry.key, {"type": "turn_end", "session_id": session_id,
                                    "stop_reason": stop_reason, "error": error})

    async def cancel(self, session_id: str) -> None:
        entry = self._entry_for(session_id)
        await asyncio.to_thread(entry.runtime.cancel, session_id)

    async def close(self, session_id: str) -> None:
        entry = self._entry_for(session_id)
        await asyncio.to_thread(entry.runtime.close_session, session_id)
        entry.open.discard(session_id)
        if session_id not in self._busy:
            self._session_ws.pop(session_id, None)

    async def set_config(self, session_id: str, config_id: str, value: str) -> Any:
        entry = self._entry_for(session_id)
        return await asyncio.to_thread(entry.runtime.set_option, session_id, config_id, value)

    # -- status ----------------------------------------------------------------
    async def status(self) -> dict:
        source = await asyncio.to_thread(key_source)
        version = await asyncio.to_thread(_node_version)
        return {
            "key_set": source is not None,
            "key_source": source,
            "launcher": shutil.which("plexar-harness"),
            "node_version": version,
            "node_ok": node_ok(version),
            "permission_mode": await asyncio.to_thread(permission_mode),
        }


harness_manager = HarnessManager()
