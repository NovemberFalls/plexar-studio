"""Studio owns the Cloudflare connector.

The operator used to run ``cloudflared`` themselves — a bare console window, or
an S4U scheduled task that needs elevation. Closing that window silently killed
remote access (R-178), and the task route asks a desktop user to reason about
logon types (NOTE-196). Studio therefore supervises the connector itself: one
hidden child process, restarted with backoff when it dies, with a Start/Stop
button in Settings ▸ Remote.

THE TOKEN IS A SECRET AND NEVER ENTERS settings.json. settings.json is
deliberately exportable/shareable, so the token lives beside the provider API
keys in ``config.json`` (``cloudflare_tunnel_token``), reusing
``settings_store``'s atomic config read/write. It is never returned by any
route: status reports ``token_set: bool`` and nothing more. It is passed to the
child as an argv element, never logged, and every line captured from the child
is scrubbed of the token string before it reaches the ring buffer or the log
file — cloudflared itself has been known to echo its arguments on a usage
error, and a log file is exactly where a secret must not be.

A ``cloudflared`` that Studio did NOT start is not ours: ``foreign_running``
says so, so the UI can explain "another connector is already running outside
Studio" rather than fighting it or pretending the state is ours.

ORPHANS, AND WHY IDENTITY IS PROVEN BEFORE ANYTHING IS TERMINATED (2026-09-09).
``TunnelManager.stop()`` runs on the graceful shutdown path only, and on this
app that path is the exception, not the rule (see ``temp_sweep``'s docstring and
NOTE-197): the owner's machine held five orphaned Studio connectors, one per
unclean server exit. Startup is the only moment reached however the last process
died, so ``sweep_orphan()`` runs there.

**R-185 is the rule that decides the design: ``cloudflared.exe`` is NOT a Studio
process.** Several Plexar products run that same binary -- Plexar-LLM's tunnel
is ``cloudflared tunnel run plexar-vllm`` under its own supervisor -- and
terminating by process NAME took that product's service down. So Studio
terminates only a connector it can PROVE it started, exactly the way
``instance_guard`` gates its kill on ``SIDECAR_NAMES`` and ``temp_sweep`` gates
its removal on a marker:

  * spawning writes an OWNERSHIP RECORD (``connector-owner.json``, beside the
    connector log) naming the connector pid, the Studio pid that spawned it, and
    a SHA-256 of the exact argv;
  * the sweep terminates that pid only when the record's Studio owner is gone,
    the live process is a ``cloudflared``, AND the hash of its live command line
    equals the recorded one. **A pid that now runs a different command line is
    left alone** -- that is a recycled pid or another product's connector.
  * the token never enters the record: a hash cannot be read back, and the argv
    carries the secret.

Adoption of a healthy orphan was considered and rejected: supervision here means
owning the child's stdout pipe and its exit code, and neither can be reattached
to a process we did not spawn. Terminate-and-respawn is the honest option.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

import app_paths
import instance_guard
import settings_store

logger = logging.getLogger("cockpit.tunnel")

#: Executable basenames a Cloudflare connector can legitimately have. This is a
#: NECESSARY condition for terminating a recorded pid, never a sufficient one --
#: R-185 is precisely the mistake of treating it as sufficient.
CONNECTOR_NAMES = {"cloudflared", "cloudflared.exe"}

# Ring buffer of recent child output, in memory. 200 lines is enough to see a
# start-up failure and the connection registrations that follow it.
_RING_LINES = 200
# What the status route hands the UI. Smaller than the ring on purpose: the
# card renders a collapsible tail, not a log viewer.
_STATUS_TAIL = 40

_LOG_MAX_BYTES = 5 * 1024 * 1024
_CONNECTION_MARKER = "Registered tunnel connection"

# Backoff for a connector that exits while we still want it running: 1, 2, 4,
# ... capped at 60s. A tunnel that cannot connect (bad token, no network) must
# not become a spawn loop.
_BACKOFF_START = 1.0
_BACKOFF_CAP = 60.0

# How long a terminate() gets before kill().
_TERMINATE_GRACE = 5.0

_TOKEN_FIELD = "cloudflare_tunnel_token"

_WINDOWS_PATHS = (
    r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
    r"C:\Program Files\cloudflared\cloudflared.exe",
)


# ---------------------------------------------------------------------------
# Token storage (config.json — the secrets file, NEVER settings.json)
# ---------------------------------------------------------------------------


def get_token() -> str | None:
    """Return the stored connector token, or None if it has never been set."""
    value = settings_store._read_config().get(_TOKEN_FIELD)
    return value if isinstance(value, str) and value else None


def set_token(token: str) -> None:
    """Persist *token* (overwrites any existing value)."""
    settings_store.update_config(lambda data: data.__setitem__(_TOKEN_FIELD, token))


def clear_token() -> bool:
    """Remove the stored token. True if one was actually present."""
    removed = []

    def drop(data: dict) -> None:
        if data.get(_TOKEN_FIELD):
            del data[_TOKEN_FIELD]
            removed.append(True)

    settings_store.update_config(drop)
    return bool(removed)


# ---------------------------------------------------------------------------
# Binary resolution, argv, logging — module-level so tests can substitute a
# fake connector without reaching inside the manager.
# ---------------------------------------------------------------------------


def _tunnel_settings() -> dict:
    """The `remote.tunnel` block, with defaults already merged in."""
    try:
        remote = settings_store.read_settings().get("remote") or {}
    except Exception:  # noqa: BLE001 - a damaged settings file must not 500 status
        logger.warning("Could not read settings for tunnel config", exc_info=True)
        return {}
    tunnel = remote.get("tunnel")
    return tunnel if isinstance(tunnel, dict) else {}


def _resolve_binary() -> str | None:
    """Configured path → PATH → the two Windows install locations."""
    configured = str(_tunnel_settings().get("cloudflared_path") or "").strip()
    if configured:
        # An explicit path that does not exist is "not installed", never a
        # silent fall-through to whatever else is on the machine -- the same
        # never-substitute-a-neighbour rule the model picker follows.
        return configured if os.path.isfile(configured) else None
    found = shutil.which("cloudflared")
    if found:
        return found
    for candidate in _WINDOWS_PATHS:
        if os.path.isfile(candidate):
            return candidate
    return None


def _build_argv(binary: str, token: str) -> list[str]:
    """The connector command line. The token is an argv element, never a file."""
    return [binary, "tunnel", "run", "--token", token]


def _log_path() -> Path:
    return app_paths.data_path("logs", "cloudflared.log")


def _owner_record_path() -> Path:
    """Where the ownership record lives — beside the connector log."""
    return app_paths.data_path("logs", "connector-owner.json")


def _argv_fingerprint(argv) -> str:
    """SHA-256 over the argv, joined by NUL.

    A hash, not the argv itself: the token is an argv element and a record file
    is exactly where a secret must not be. It is still a total identity test --
    the sweep hashes the live command line and requires equality.
    """
    joined = "\x00".join(str(a) for a in argv)
    return hashlib.sha256(joined.encode("utf-8", "surrogatepass")).hexdigest()


def write_owner_record(pid: int, argv) -> None:
    """Record that THIS Studio process spawned connector ``pid``. Best-effort."""
    record = {
        "connector_pid": pid,
        "argv_sha256": _argv_fingerprint(argv),
        "owner_pid": os.getpid(),
        "owner_exe": Path(sys.executable).name,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        path = _owner_record_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record), encoding="utf-8")
    except OSError:
        logger.debug("Could not write the connector ownership record", exc_info=True)


def read_owner_record() -> dict | None:
    """The stored record, or None when absent/unreadable/wrong-shaped."""
    try:
        data = json.loads(_owner_record_path().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001 - a missing or damaged record is simply "none"
        return None
    if not isinstance(data, dict):
        return None
    if not isinstance(data.get("connector_pid"), int):
        return None
    if not isinstance(data.get("argv_sha256"), str):
        return None
    return data


def clear_owner_record() -> None:
    """Forget the record — the connector it named is gone. Best-effort."""
    try:
        _owner_record_path().unlink(missing_ok=True)
    except OSError:
        logger.debug("Could not clear the connector ownership record", exc_info=True)


def _owning_studio_is_live(record: dict) -> bool:
    """Is the Studio process that spawned this connector still running?

    Both halves, the same reasoning ``temp_sweep`` applies: a bare pid-exists
    test keeps a record alive forever the moment the OS recycles that pid.
    """
    pid = record.get("owner_pid")
    if not isinstance(pid, int):
        return False
    if pid == os.getpid():
        return True
    try:
        import psutil

        proc = psutil.Process(pid)
        if not proc.is_running():
            return False
        return proc.name() in instance_guard.SIDECAR_NAMES
    except Exception:  # noqa: BLE001 - unidentifiable owner counts as gone
        return False


def sweep_orphan() -> dict:
    """Terminate a connector this Studio install PROVABLY started and abandoned.

    Called at startup, best-effort, NEVER raises. Returns a small verdict dict
    for logging and tests. Verdicts:

      ``no_record``      nothing was ever recorded, or the file is unreadable.
      ``owner_alive``    the Studio that spawned it is still running — not ours
                         to clean up, and killing it would break a live install.
      ``gone``           the recorded pid is no longer running.
      ``not_ours``       that pid is alive but is NOT a matching connector. **It
                         is never touched** — this is the R-185 case.
      ``terminated``     proven ours and orphaned; terminated.
      ``error``          something failed; nothing was touched.
    """
    record = read_owner_record()
    if record is None:
        return {"verdict": "no_record"}
    try:
        if _owning_studio_is_live(record):
            return {"verdict": "owner_alive", "pid": record["connector_pid"]}

        import psutil

        pid = record["connector_pid"]
        try:
            proc = psutil.Process(pid)
            name = (proc.name() or "").lower()
            cmdline = proc.cmdline()
        except Exception:  # noqa: BLE001 - vanished/inaccessible: nothing to do
            clear_owner_record()
            return {"verdict": "gone", "pid": pid}

        if name not in CONNECTOR_NAMES:
            logger.info(
                "Connector sweep: PID %d now runs %s — not ours, left alone", pid, name
            )
            clear_owner_record()
            return {"verdict": "not_ours", "pid": pid, "reason": "name"}
        if _argv_fingerprint(cmdline) != record["argv_sha256"]:
            # A cloudflared that is not the one we started. R-185: another
            # Plexar product runs this same binary. Never touched.
            logger.info(
                "Connector sweep: PID %d is a cloudflared with a different command "
                "line — not ours, left alone", pid,
            )
            clear_owner_record()
            return {"verdict": "not_ours", "pid": pid, "reason": "cmdline"}

        logger.warning(
            "Connector sweep: terminating orphaned connector PID %d left by a "
            "previous Studio process", pid,
        )
        proc.terminate()
        try:
            proc.wait(timeout=_TERMINATE_GRACE)
        except Exception:  # noqa: BLE001 - psutil.TimeoutExpired and friends
            try:
                proc.kill()
            except Exception:  # noqa: BLE001 - a survivor is reported, not fatal
                logger.debug("kill() on the orphaned connector failed", exc_info=True)
        clear_owner_record()
        return {"verdict": "terminated", "pid": pid}
    except Exception:  # noqa: BLE001 - startup must never fail because of this
        logger.warning("Connector orphan sweep failed", exc_info=True)
        return {"verdict": "error"}


def _creation_flags() -> int:
    """CREATE_NO_WINDOW on Windows only — the whole point is an invisible child.

    The constant does not exist on other platforms, so it is read behind a
    platform check rather than a getattr that would silently mean "0" if the
    name were ever renamed.
    """
    if sys.platform == "win32":
        return subprocess.CREATE_NO_WINDOW
    return 0


def _sleep(seconds: float) -> None:
    """Indirection so the backoff is patchable in tests."""
    time.sleep(seconds)


def _scrub(line: str, token: str | None) -> str:
    """Replace the token with *** anywhere it appears."""
    if token and token in line:
        return line.replace(token, "***")
    return line


def _foreign_running(our_pid: int | None) -> bool:
    """Is a cloudflared running that is NOT the child we started?"""
    try:
        import psutil
    except Exception:  # noqa: BLE001 - psutil absence must not 500 the route
        logger.debug("psutil unavailable for foreign cloudflared check", exc_info=True)
        return False
    try:
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                name = (proc.info.get("name") or "").lower()
                pid = proc.info.get("pid")
            except Exception:  # noqa: BLE001 - a vanished process is not our error
                continue
            if name in ("cloudflared", "cloudflared.exe") and pid != our_pid:
                return True
    except Exception:  # noqa: BLE001 - enumeration must never 500 the route
        logger.debug("Failed to enumerate processes for cloudflared", exc_info=True)
    return False


# ---------------------------------------------------------------------------
# TunnelManager
# ---------------------------------------------------------------------------


class TunnelManager:
    """Supervises one cloudflared child process.

    `desired` is the user's intent (running/stopped) and `state` is what is
    actually true. They are separate because a crash must leave the intent
    intact — that is what makes the restart legitimate rather than a surprise.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._proc: subprocess.Popen | None = None
        self._desired = "stopped"
        self._state = "stopped"
        self._lines: deque[str] = deque(maxlen=_RING_LINES)
        self._restarts = 0
        self._connections = 0
        self._started_at: str | None = None
        self._last_error: str | None = None
        self._worker: threading.Thread | None = None
        self._stop_event = threading.Event()

    # -- public API ---------------------------------------------------------

    def start(self) -> dict:
        """Begin supervising. Idempotent — a second call while running is a no-op."""
        with self._lock:
            if self._desired == "running" and self._worker and self._worker.is_alive():
                return self.status()
            self._desired = "running"
            self._state = "starting"
            self._stop_event.clear()
            self._restarts = 0
            self._connections = 0
            self._last_error = None
            worker = threading.Thread(
                target=self._supervise, name="cloudflared-supervisor", daemon=True
            )
            self._worker = worker
        worker.start()
        return self.status()

    def stop(self) -> dict:
        """Stop, and stay stopped: desired=stopped so the supervisor will not restart."""
        with self._lock:
            self._desired = "stopped"
            if self._state != "stopped":
                self._state = "stopping"
            worker = self._worker
        self._stop_event.set()
        self._terminate_child()
        if worker and worker.is_alive() and worker is not threading.current_thread():
            worker.join(timeout=_TERMINATE_GRACE + 2)
        with self._lock:
            self._state = "stopped"
            self._proc = None
            self._started_at = None
            self._worker = None
        # The child is gone by intent; the record would otherwise name a pid the
        # OS is free to hand to something else.
        clear_owner_record()
        return self.status()

    def status(self) -> dict:
        binary = _resolve_binary()
        settings = _tunnel_settings()
        with self._lock:
            proc = self._proc
            pid = proc.pid if proc and proc.poll() is None else None
            return {
                "installed": bool(binary),
                "binary": binary,
                "token_set": get_token() is not None,
                "enabled": bool(settings.get("enabled", False)),
                "autostart": bool(settings.get("autostart", True)),
                "state": self._state,
                "pid": pid,
                "started_at": self._started_at,
                "restarts": self._restarts,
                "connections": self._connections,
                "last_error": self._last_error,
                "foreign_running": _foreign_running(pid),
                "log_tail": list(self._lines)[-_STATUS_TAIL:],
            }

    def log_lines(self) -> list[str]:
        with self._lock:
            return list(self._lines)

    def reconcile(self) -> dict:
        """Bring the running connector in line with current settings + token.

        Called right after a settings write touches `remote.tunnel`, or after
        a token save/delete — so "run when Studio starts" (autostart) also
        means "run right now" instead of waiting for the next launch. Never
        raises: this rides inside the settings response path, and a broken
        connector must not turn into a broken settings save.
        """
        try:
            settings = _tunnel_settings()
            enabled = bool(settings.get("enabled", False))
            autostart = bool(settings.get("autostart", True))
            with self._lock:
                state = self._state
            if not enabled:
                if state != "stopped":
                    self.stop()
                return self.status()
            if (
                enabled
                and autostart
                and get_token() is not None
                and _resolve_binary() is not None
                and state in ("stopped", "crashed")
            ):
                self.start()
            return self.status()
        except Exception:  # noqa: BLE001 - reconcile must never raise into a caller
            logger.error("Tunnel reconcile failed", exc_info=True)
            return self.status()

    def set_token(self, token: str) -> None:
        set_token(token)

    def clear_token(self) -> bool:
        """Forget the token, and stop the connector — it cannot run without one."""
        removed = clear_token()
        with self._lock:
            running = self._desired == "running"
        if running:
            self.stop()
        return removed

    # -- internals ----------------------------------------------------------

    def _record(self, line: str, token: str | None) -> None:
        line = _scrub(line.rstrip("\r\n"), token)
        if not line:
            return
        with self._lock:
            self._lines.append(line)
            if _CONNECTION_MARKER in line:
                self._connections += 1
        self._append_log(line)

    def _append_log(self, line: str) -> None:
        try:
            path = _log_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.stat().st_size >= _LOG_MAX_BYTES:
                backup = path.with_suffix(path.suffix + ".1")
                backup.unlink(missing_ok=True)
                path.replace(backup)
            with path.open("a", encoding="utf-8", errors="replace") as fh:
                fh.write(line + "\n")
        except OSError:
            logger.debug("Could not append to the cloudflared log", exc_info=True)

    def _terminate_child(self) -> None:
        with self._lock:
            proc = self._proc
        if proc is None or proc.poll() is not None:
            return
        try:
            proc.terminate()
        except OSError:
            logger.debug("terminate() on the connector failed", exc_info=True)
        try:
            proc.wait(timeout=_TERMINATE_GRACE)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except OSError:
                logger.debug("kill() on the connector failed", exc_info=True)
            try:
                proc.wait(timeout=_TERMINATE_GRACE)
            except subprocess.TimeoutExpired:
                logger.warning("Connector did not exit after kill()")

    def _supervise(self) -> None:
        backoff = _BACKOFF_START
        attempt = 0
        while True:
            with self._lock:
                if self._desired != "running":
                    return
            token = get_token()
            binary = _resolve_binary()
            if not token or not binary:
                with self._lock:
                    self._last_error = (
                        "no token" if not token else "cloudflared not installed"
                    )
                    self._state = "crashed"
                    self._desired = "stopped"
                return
            if attempt:
                with self._lock:
                    self._restarts += 1
                _sleep(backoff)
                backoff = min(backoff * 2, _BACKOFF_CAP)
                with self._lock:
                    if self._desired != "running":
                        return
            attempt += 1
            code = self._run_once(binary, token)
            with self._lock:
                if self._desired != "running":
                    self._state = "stopped"
                    return
                self._state = "crashed"
                self._last_error = f"connector exited with code {code}"
            logger.warning("cloudflared exited (code %s) — restarting", code)

    def _run_once(self, binary: str, token: str) -> int | None:
        argv = _build_argv(binary, token)
        try:
            proc = subprocess.Popen(  # noqa: S603 - argv is built here, never shell
                argv,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
                creationflags=_creation_flags(),
            )
        except OSError as exc:
            with self._lock:
                self._last_error = f"could not start cloudflared: {exc}"
                self._state = "crashed"
            logger.error("Could not start cloudflared", exc_info=True)
            return None

        with self._lock:
            self._proc = proc
            self._state = "running"
            self._started_at = datetime.now(timezone.utc).isoformat()
        # Durable ownership, written BEFORE we block on the child's output: an
        # unclean death of this process must still leave proof of what we
        # started. Overwrites any previous record — there is one child at a time.
        write_owner_record(proc.pid, argv)
        logger.info("cloudflared started (PID %d)", proc.pid)

        try:
            if proc.stdout is not None:
                for line in proc.stdout:
                    self._record(line, token)
        except (OSError, ValueError):
            logger.debug("Reading connector output failed", exc_info=True)
        finally:
            try:
                if proc.stdout is not None:
                    proc.stdout.close()
            except OSError:
                logger.debug("Closing connector stdout failed", exc_info=True)
        try:
            return proc.wait(timeout=_TERMINATE_GRACE)
        except subprocess.TimeoutExpired:
            return None


manager = TunnelManager()


def autostart_if_configured() -> bool:
    """Start the connector at boot when the user asked for it.

    Best-effort and never raises, the same posture as `start_managed_vllm`: a
    connector that cannot start must not stop Studio from starting.
    """
    try:
        settings = _tunnel_settings()
        if not settings.get("enabled") or not settings.get("autostart", True):
            return False
        if get_token() is None:
            logger.info("Tunnel autostart skipped — no token configured")
            return False
        manager.start()
        return True
    except Exception:  # noqa: BLE001 - startup must never be blocked by this
        logger.error("Tunnel autostart failed", exc_info=True)
        return False


def shutdown() -> None:
    """Stop the connector on graceful shutdown. Never raises."""
    try:
        manager.stop()
    except Exception:  # noqa: BLE001 - shutdown must complete regardless
        logger.error("Stopping the connector failed", exc_info=True)


# ---------------------------------------------------------------------------
# Routes — ordinary /api routes, so the browser origin guard covers them via
# server.py's middleware. No exemption is added or wanted.
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/api/remote/tunnel")


@router.get("")
async def tunnel_status():
    return JSONResponse(manager.status())


@router.post("/start")
async def tunnel_start():
    if get_token() is None:
        return JSONResponse({"error": "no token"}, status_code=409)
    if _resolve_binary() is None:
        return JSONResponse({"error": "cloudflared not installed"}, status_code=409)
    return JSONResponse(manager.start())


@router.post("/stop")
async def tunnel_stop():
    return JSONResponse(manager.stop())


@router.put("/token")
async def tunnel_put_token(request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - any unparseable body is the same 400
        return JSONResponse({"error": "body must be valid JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)
    token = body.get("token")
    if not isinstance(token, str) or not token.strip():
        return JSONResponse({"error": "token must not be empty"}, status_code=400)
    manager.set_token(token.strip())
    logger.info("Cloudflare connector token saved")
    manager.reconcile()
    return Response(status_code=204)


@router.delete("/token")
async def tunnel_delete_token():
    manager.clear_token()
    return Response(status_code=204)


@router.get("/log")
async def tunnel_log():
    return JSONResponse({"lines": manager.log_lines()})
