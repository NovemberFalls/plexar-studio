"""Studio Remote gateway (protocol v1) -- routers, auth and the stream registry.

Two routers live here and they are deliberately different animals:

* ``admin_router`` (``/api/remote``) is the DESKTOP's control surface. It is an
  ordinary ``/api`` route family and keeps the browser origin guard.
* ``router`` (``/remote/v1``) is the PHONE's surface. It is exempt from the
  origin guard (see ``origin_guard.is_remote_path``) because a phone through a
  tunnel presents a non-loopback Host and no Origin; the device bearer token is
  the boundary there instead.

This module NEVER imports ``server``. Everything it needs from the running
application arrives through ``configure(RemoteBackend, DeviceStore)`` as plain
callables, so the gateway can be exercised on its own against fakes.
"""

from __future__ import annotations

import datetime
import asyncio
import inspect
import json
import logging
import os
import re
import shutil
import socket
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Body, Depends, File, HTTPException, Request, UploadFile, WebSocket
from fastapi.responses import FileResponse, JSONResponse

import app_paths
import jsonl_watcher
from remote_devices import Device, DeviceStore, PairingError

logger = logging.getLogger("cockpit.remote")

PROTOCOL_VERSION = 1

# The only session fields a phone is given. Nothing else -- no jsonl_path, no
# cost, no tokens, no claude_session_id. A remote surface should not carry the
# desktop's whole record just because the desktop's own list route does.
# `updated_at` and `preview` are DERIVED (see `_session_view`) rather than
# copied straight off the desktop's record -- there is no such field there.
# `branch` is likewise derived, via `RemoteBackend.git_branch`. `effort` IS a
# field on the desktop's own record (`TerminalSession.effort`, already merged
# live-vs-launch by `pty_manager.list_terminals()`), so it is copied straight
# through like every other passthrough field.
SESSION_FIELDS = (
    "id",
    "name",
    "harness",
    "model",
    "working_dir",
    "alive",
    "activity_state",
    "created_at",
    "updated_at",
    "preview",
    "branch",
    "effort",
)

# The ONLY per-row fields a phone gets from a folder listing. `entry_count`,
# `dirty` and `skipped` exist in the desktop's own /api/browse rows and are
# deliberately dropped: they are the desktop picker's affordances, and a remote
# surface should not carry the desktop's whole record just because it is there.
BROWSE_ENTRY_FIELDS = ("path", "name", "git", "branch", "session_count")

# (device_id, request_id) pairs already applied. Bounded, because it is a
# convenience against a retried tap on a flaky cellular link, not a durable log.
_IDEMPOTENCY_MAX = 256

# The four permission modes `_create_terminal_from_body` understands, with the
# words a phone shows for them. Ids are the WIRE values and must match
# `permissionMode` exactly; the labels are ours.
PERMISSION_MODES = (
    ("default", "Ask before edits"),
    ("acceptEdits", "Accept edits"),
    ("plan", "Plan only"),
    ("bypassPermissions", "Bypass permissions"),
)
_PERMISSION_MODE_IDS = frozenset(mode_id for mode_id, _label in PERMISSION_MODES)

EFFORTS = ("low", "medium", "high", "xhigh")

# Codex publishes no live `/v1/models` equivalent, so its catalog is a static
# list on BOTH sides of the app -- here, and in
# `web/frontend/src/modelCatalog.js`'s CODEX_MODEL_GROUPS. Two static lists is
# exactly the drift hazard `modelCatalog.js` exists to prevent for Anthropic,
# so `tests/test_remote_codex_catalog_sync.py` reads that file and asserts set
# equality with these ids. Change one, change the other, or the suite reddens.
CODEX_MODELS = (
    ("gpt-6-astra", "GPT-6 Astra"),
    ("gpt-5.6-sol", "GPT-5.6 Sol"),
    ("gpt-5.6-terra", "GPT-5.6 Terra"),
    ("gpt-5.6-luna", "GPT-5.6 Luna"),
    ("gpt-5.5", "GPT-5.5"),
    ("gpt-5.3-codex-spark", "Codex Spark"),
)
CODEX_DEFAULT_MODEL = "gpt-6-astra"

# Saved folders the desktop publishes for the phone's "Saved" tab.
LOCATIONS_FILENAME = "remote_locations.json"
MAX_SAVED_LOCATIONS = 200


@dataclass
class RemoteBackend:
    """The slice of the running server the gateway is allowed to touch.

    The four fields added for Stage 1c default to ``None`` so an older caller
    (or a narrower test fake) still constructs a valid backend; the routes that
    need them answer 503 rather than 500 when they are absent.

    Two of them are annotated as returning either a value or an awaitable, and
    that is deliberate rather than sloppy. ``browse`` is wired to
    ``server.browse_directories`` -- the SAME callable ``GET /api/browse`` uses,
    which is a FastAPI route and therefore hands back a ``JSONResponse``; and
    ``delete_session`` is wired to ``pty_manager.kill_terminal``, the SAME
    synchronous call ``DELETE /api/terminals/{id}`` makes. Wrapping either one
    in server.py to make the annotation prettier would mean the phone no longer
    travels the identical code path, which is the property that matters.
    """

    settings: Callable[[], dict]
    app_version: Callable[[], str]
    list_sessions: Callable[[], list[dict]]
    get_session: Callable[[str], Any]
    create_session: Callable[[dict], Awaitable[dict]]
    submit: Callable[[str, str], Awaitable[bool]]
    write_raw: Callable[[str, str], Awaitable[bool]]
    interrupt: Callable[[str], Awaitable[bool]]
    browse: Callable[[str], Awaitable[dict] | Any] | None = None
    delete_session: Callable[[str], Awaitable[bool] | bool] | None = None
    recent_workdirs: Callable[[int], list[dict]] | None = None
    anthropic_models: Callable[[], Awaitable[dict]] | None = None
    # Stage 2 (chat view). Same defaulting rule as the four above: absent means
    # the route answers 503/404, never 500.
    messages_claude: Callable[[Any], list[dict]] | None = None
    transcript_codex: Callable[[Any, int | None, int], Awaitable[dict] | Any] | None = None
    upload_dir: Callable[[], str] | None = None
    save_upload: Callable[[str, bytes], Awaitable[str] | str] | None = None
    # Stage 4 (colour tokens / branch display). Wired to
    # `server._git_branch_from_head(dir)[1]`. Absent (older caller / narrower
    # test fake) means `branch` is always null, never a 500 -- same defaulting
    # rule as every other Stage 1c+ field above.
    git_branch: Callable[[str], str | None] | None = None


class StreamRegistry:
    """Open remote sockets, keyed by device, so a revoke can hang them up."""

    def __init__(self) -> None:
        self._sockets: dict[str, set] = {}

    def register(self, device_id: str, websocket) -> None:
        self._sockets.setdefault(device_id, set()).add(websocket)

    def unregister(self, device_id: str, websocket) -> None:
        sockets = self._sockets.get(device_id)
        if not sockets:
            return
        sockets.discard(websocket)
        if not sockets:
            self._sockets.pop(device_id, None)

    def count(self, device_id: str) -> int:
        return len(self._sockets.get(device_id, ()))

    async def close_device(self, device_id: str) -> None:
        """Close every socket held by *device_id*.

        Best effort per socket: one already-dead socket must not strand the
        others, which is exactly the state revocation is meant to end.
        """
        for websocket in list(self._sockets.get(device_id, ())):
            try:
                await websocket.close(code=4401)
            except Exception:  # noqa: BLE001 - a dead socket is the normal case
                logger.debug("Failed closing remote socket for %s", device_id, exc_info=True)
        self._sockets.pop(device_id, None)


registry = StreamRegistry()

_backend: RemoteBackend | None = None
_store: DeviceStore | None = None
_seen_requests: "OrderedDict[tuple[str, str], bool]" = OrderedDict()


def configure(backend: RemoteBackend, store: DeviceStore) -> None:
    """Wire the gateway to the running server. Called once from server.py."""
    global _backend, _store
    _backend = backend
    _store = store
    _seen_requests.clear()


def _require_configured() -> tuple[RemoteBackend, DeviceStore]:
    if _backend is None or _store is None:
        raise HTTPException(status_code=503, detail="remote not configured")
    return _backend, _store


def remote_enabled() -> bool:
    """True when settings say remote access is on. False on any read failure."""
    if _backend is None:
        return False
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001 - a settings read must never 500 the gateway
        logger.warning("Failed to read settings for remote gate", exc_info=True)
        return False
    remote = settings.get("remote")
    return bool(isinstance(remote, dict) and remote.get("enabled"))


def _remote_hostname() -> str:
    if _backend is None:
        return ""
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001
        logger.warning("Failed to read settings for remote hostname", exc_info=True)
        return ""
    remote = settings.get("remote")
    if not isinstance(remote, dict):
        return ""
    hostname = remote.get("hostname")
    return hostname.rstrip("/") if isinstance(hostname, str) else ""


def _bearer_token(headers) -> str | None:
    raw = headers.get("authorization") or headers.get("Authorization")
    if not raw or not isinstance(raw, str):
        return None
    scheme, _, token = raw.partition(" ")
    if scheme.lower() != "bearer":
        return None
    token = token.strip()
    return token or None


async def require_device(request: Request) -> Device:
    """FastAPI dependency: the authenticated device, or an HTTPException.

    Order matters and is load-bearing: when remote is disabled EVERY route
    answers 404 before any credential is examined, so a probe cannot learn
    whether a token is valid on a desktop that has remote turned off.

    Async, and DeviceStore.authenticate runs in the threadpool (N04): every
    phone route depends on this (the phone polls the session list every 3s),
    and DeviceStore._read() does a real disk read (is_file + read_text) on
    every call -- it is not an in-memory check.
    """
    _require_configured()
    if not remote_enabled():
        raise HTTPException(status_code=404, detail="remote disabled")
    token = _bearer_token(request.headers)
    device = await asyncio.to_thread(_store.authenticate, token) if token else None
    if device is None:
        raise HTTPException(status_code=401, detail="unauthorized")
    return device


def authenticate_websocket(websocket: WebSocket) -> Device | None:
    """The same rules as ``require_device``, but as a value rather than a raise.

    A WebSocket handshake has no useful place to put an HTTPException, and the
    caller has to distinguish "disabled" from "unauthorized" only in so far as
    both refuse pre-accept. Returns None for either.
    """
    if _backend is None or _store is None:
        return None
    if not remote_enabled():
        return None
    token = _bearer_token(websocket.headers)
    if not token:
        return None
    return _store.authenticate(token)


def _lan_ipv4() -> str:
    """This machine's primary IPv4, or 127.0.0.1.

    The UDP connect trick: connecting a datagram socket sends NOTHING on the
    wire, it only makes the kernel pick the source address it would route
    8.8.8.8 through -- which is the interface a phone on the same LAN can
    actually reach.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        addr = sock.getsockname()[0]
        return addr or "127.0.0.1"
    except OSError:
        logger.debug("Could not determine LAN IPv4 -- falling back to loopback", exc_info=True)
        return "127.0.0.1"
    finally:
        sock.close()


def _pairing_url() -> str:
    hostname = _remote_hostname()
    if hostname:
        return hostname
    port = os.getenv("PORT", "8420")
    return f"http://{_lan_ipv4()}:{port}"


def _session_updated_at(entry: dict) -> str | None:
    """The transcript file's mtime for a claude-code session, else created_at.

    `entry["jsonl_path"]` is the SAME discovery `pty_manager._get_jsonl_path`
    already did for `list_terminals()` -- it is only stripped from the phone's
    view by `SESSION_FIELDS`, not absent from the record. Codex sessions (and
    any claude-code session with no transcript yet) carry no jsonl_path, so
    `created_at` is the honest answer there.
    """
    path = entry.get("jsonl_path")
    if path:
        try:
            mtime = os.path.getmtime(path)
        except OSError:
            logger.debug("Could not stat jsonl for updated_at: %s", path, exc_info=True)
        else:
            return datetime.datetime.fromtimestamp(mtime, tz=datetime.timezone.utc).isoformat()
    return entry.get("created_at")


def _session_preview(entry: dict) -> dict | None:
    """The session's preview bubble, or None (no transcript / nothing to show).

    Codex sessions have no `jsonl_path` in the record (Claude JSONL discovery
    is refused for them, see `pty_manager._get_jsonl_path`) and there is no
    tail reader for the Codex rollout format yet -- null, per spec, rather
    than guessing at a different file's shape.
    """
    path = entry.get("jsonl_path")
    if not path:
        return None
    try:
        return jsonl_watcher.latest_preview(path)
    except Exception:  # noqa: BLE001 - a bad transcript must not break the list
        logger.debug("latest_preview failed for %s", path, exc_info=True)
        return None


def _session_branch(backend: "RemoteBackend", entry: dict) -> str | None:
    """The git branch for *entry*'s working_dir, or None.

    None when there is no working_dir, when `git_branch` was never wired (an
    older caller / a narrower test fake), or when the directory is not a git
    repo -- all three are the same "nothing to show" answer to a phone.
    """
    working_dir = entry.get("working_dir")
    if not working_dir or backend.git_branch is None:
        return None
    try:
        return backend.git_branch(working_dir)
    except Exception:  # noqa: BLE001 - a bad repo must not break the sessions list
        logger.debug("git_branch failed for %s", working_dir, exc_info=True)
        return None


def _session_effort(backend: "RemoteBackend | None", entry: dict) -> str | None:
    """The effort a phone should show: the LIVE value, falling back to launch.

    `pty_manager._session_to_dict` emits no `effort` key at all -- the live
    value set by "Set effort level to X" lives on `session.tracker.effort`,
    the launch-time value on `TerminalSession.effort` (a str, "" = unset).
    Mirrors how `activity_state` falls back to `session.tracker.state` for a
    real `TerminalSession` above: resolve off the REAL session object via
    `backend.get_session`, not off the already-stripped list entry, and treat
    an empty string as unset at every step -- including one already present
    on a dict-shaped test double's `entry["effort"]`.
    """
    terminal_id = entry.get("id")
    session = backend.get_session(terminal_id) if backend is not None and terminal_id else None
    if session is not None:
        tracker_effort = getattr(getattr(session, "tracker", None), "effort", None)
        if isinstance(tracker_effort, str) and tracker_effort:
            return tracker_effort
        launch_effort = _session_field(session, "effort")
        if isinstance(launch_effort, str) and launch_effort:
            return launch_effort
        return None
    entry_effort = entry.get("effort")
    return entry_effort if isinstance(entry_effort, str) and entry_effort else None


def _session_view(entry: dict, backend: "RemoteBackend | None" = None) -> dict:
    enriched = dict(entry)
    enriched["updated_at"] = _session_updated_at(entry)
    enriched["preview"] = _session_preview(entry)
    enriched["branch"] = _session_branch(backend, entry) if backend is not None else None
    enriched["effort"] = _session_effort(backend, entry)
    return {key: enriched.get(key) for key in SESSION_FIELDS}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


async def _read_json(request: Request) -> dict:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - a malformed body is a client error
        return {}
    return body if isinstance(body, dict) else {}


async def _maybe_await(value: Any) -> Any:
    """Await *value* when it is awaitable, otherwise hand it straight back.

    Lets one route body drive both an ``async def`` server route and a plain
    synchronous manager call without the wiring in server.py having to lie
    about which it is.
    """
    if inspect.isawaitable(value):
        return await value
    return value


def _as_dict(result: Any) -> dict:
    """Normalize a backend reply to a plain dict.

    ``browse_directories`` returns a ``JSONResponse`` (it is a route); test
    fakes return a dict. Reading both here is what allows the gateway to call
    the real route function rather than a parallel copy of it.
    """
    if isinstance(result, dict):
        return result
    body = getattr(result, "body", None)
    if isinstance(body, (bytes, bytearray)):
        try:
            data = json.loads(bytes(body).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            logger.warning("Backend reply was not decodable JSON", exc_info=True)
            return {}
        return data if isinstance(data, dict) else {}
    return {}


# A Windows absolute path, checked EXPLICITLY rather than left to
# ``os.path.isabs``: that function answers for the platform the server runs on,
# so "C:\\Code" is relative to a Linux CI runner. The phone's paths come from
# the desktop, not from this process's filesystem.
_WINDOWS_ABS_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+)")


def _is_absolute_path(value: Any) -> bool:
    """True for a POSIX root path, a Windows drive path, or a UNC path."""
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not text:
        return False
    if text.startswith("/") or _WINDOWS_ABS_RE.match(text):
        return True
    return os.path.isabs(text)


def _is_browsable_path(value: str) -> bool:
    """``_is_absolute_path`` plus a refusal of anything with a ``..`` segment.

    The walk itself is the desktop's own listing code and is not sandboxed --
    it never was, because on the desktop the whole filesystem is already the
    user's. Refusing traversal-looking input here is not a sandbox either; it
    keeps a phone from asking for a path the desktop UI could not have produced,
    so a malformed request fails loudly instead of listing something surprising.
    """
    if not isinstance(value, str):
        return False
    if ".." in [part for part in re.split(r"[\\/]+", value.strip()) if part]:
        return False
    return _is_absolute_path(value)


def _dedupe_key(path: str) -> str:
    """The key two spellings of one folder must share.

    Trailing separators are stripped everywhere; case is folded on Windows
    ONLY. Folding on Linux would merge ``/srv/App`` and ``/srv/app``, which are
    two different directories there.
    """
    text = str(path or "").strip().rstrip("\\/")
    return text.casefold() if os.name == "nt" else text


def _locations_file() -> Path:
    """Where the desktop's published folder list lives. Patched in tests."""
    return app_paths.data_path(LOCATIONS_FILENAME)


def _read_locations() -> list[dict]:
    """The saved folders, or [] for any missing/unreadable/corrupt file.

    A phone that cannot see its Saved tab is an inconvenience; a 500 on the
    workdirs route would take the Recent and Browse tabs down with it.
    """
    path = _locations_file()
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    except OSError:
        logger.warning("Failed to read saved locations %s -- treating as empty", path, exc_info=True)
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Saved locations %s contain invalid JSON -- treating as empty", path, exc_info=True)
        return []
    items = data.get("locations") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _write_locations(locations: list[dict]) -> None:
    """Atomically replace the saved-folder file. Same shape as DeviceStore._write."""
    path = _locations_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix="remote_locations_", suffix=".json.tmp", dir=str(path.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"locations": locations}, handle, indent=2)
        os.replace(tmp_path, path)
    except OSError:
        logger.warning("Failed to write saved locations %s", path, exc_info=True)
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            logger.debug("Failed to clean up temp locations file %s", tmp_path, exc_info=True)
        raise


def _remember_request(device_id: str, request_id: str) -> bool:
    """Record (device, request) as applied. False if it was already there.

    With no request_id the caller does not opt in and every call writes -- an
    absent id means "I have no way to tell you these are the same tap", and
    inventing one would silently swallow a deliberate repeat.
    """
    key = (device_id, request_id)
    if key in _seen_requests:
        _seen_requests.move_to_end(key)
        return False
    _seen_requests[key] = True
    while len(_seen_requests) > _IDEMPOTENCY_MAX:
        _seen_requests.popitem(last=False)
    return True


def _access_required() -> bool:
    if _backend is None:
        return False
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001 - a settings read must never 500 the gateway
        logger.warning("Failed to read settings for remote access_required", exc_info=True)
        return False
    remote = settings.get("remote")
    return bool(isinstance(remote, dict) and remote.get("access_required"))


def qr_payload(url: str, code: str) -> str:
    """Build the pairing QR payload string, verbatim what the phone scans.

    Carries ``"access": true`` only when the operator has told Studio a
    Cloudflare Access gate sits in front of the tunnel (``remote.access_required``).
    """
    payload: dict[str, Any] = {"v": 1, "url": url, "code": code}
    if _access_required():
        payload["access"] = True
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# admin_router -- desktop only, origin-guarded like every other /api route
# ---------------------------------------------------------------------------

admin_router = APIRouter(prefix="/api/remote")


@admin_router.post("/pairings")
async def create_pairing():
    """Mint a pairing code plus everything a phone needs to reach this host."""
    _backend_, store = _require_configured()
    if not remote_enabled():
        return _error(409, "remote disabled")
    pairing = store.create_pairing()
    url = _pairing_url()
    return {
        "code": pairing["code"],
        "expires_at": pairing["expires_at"],
        "url": url,
        "qr_payload": qr_payload(url, pairing["code"]),
    }


@admin_router.get("/status")
async def remote_status():
    _backend_, store = _require_configured()
    return {
        "enabled": remote_enabled(),
        "hostname": _remote_hostname(),
        "protocol": PROTOCOL_VERSION,
        "devices": [d.to_dict() for d in store.list_devices()],
    }


@admin_router.delete("/devices/{device_id}")
async def revoke_device(device_id: str):
    _backend_, store = _require_configured()
    if not store.revoke(device_id):
        return _error(404, "unknown device")
    await registry.close_device(device_id)
    return {"revoked": True}


@admin_router.put("/locations")
async def put_locations(request: Request):
    """Publish the desktop's saved folders for the phone's "Saved" tab.

    Validated all-or-nothing, like PUT /api/settings: one bad entry means the
    stored list is left exactly as it was rather than half-replaced. This is a
    REPLACE, not a merge -- the desktop's saved list is the whole truth, and a
    merge would make deleting a location impossible.
    """
    body = await _read_json(request)
    raw = body.get("locations")
    if not isinstance(raw, list):
        return _error(400, "locations must be a list")
    if len(raw) > MAX_SAVED_LOCATIONS:
        return _error(400, f"at most {MAX_SAVED_LOCATIONS} locations")
    cleaned: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            return _error(400, "each location must be an object")
        path = item.get("path")
        if not _is_absolute_path(path):
            return _error(400, "each location needs an absolute path")
        name = item.get("name")
        cleaned.append(
            {
                "path": path.strip(),
                "name": name.strip() if isinstance(name, str) and name.strip() else None,
            }
        )
    try:
        _write_locations(cleaned)
    except OSError:
        return _error(500, "could not save locations")
    return {"count": len(cleaned)}


# -- self-hosted Cloudflare deployment tools (Settings > Remote) -----------

# Lowercase DNS label characters and dots only. No scheme, no path, no port --
# this string is later interpolated into an https:// URL and nowhere else.
_HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$")

_CLOUDFLARED_WIN_PATH = r"C:\Program Files (x86)\cloudflared\cloudflared.exe"

_TUNNEL_NAME = "plexar-studio"


def _valid_hostname(hostname: str) -> bool:
    if not isinstance(hostname, str):
        return False
    if not (3 <= len(hostname) <= 253):
        return False
    if "://" in hostname:
        return False
    return bool(_HOSTNAME_RE.match(hostname))


def _hostname_from(raw: str) -> str:
    """Reduce what the Public URL field holds to a bare hostname.

    The field is a URL ("https://studio.example.com") because that is what the
    phone needs, and the desktop tools take the same value. Measured
    2026-09-08: passing the URL straight to the validator produced "invalid
    hostname" on a correctly configured desktop. Scheme, port and path are
    dropped; what remains is validated exactly as before.
    """
    raw = (raw or "").strip()
    if "://" in raw:
        raw = urllib.parse.urlsplit(raw).hostname or ""
    else:
        raw = raw.split("/", 1)[0].rsplit("@", 1)[-1]
        if raw.count(":") == 1:
            raw = raw.split(":", 1)[0]
    return raw.lower().rstrip(".")


@admin_router.get("/cloudflared-config")
async def cloudflared_config(hostname: str = ""):
    hostname = _hostname_from(hostname)
    if not _valid_hostname(hostname):
        return _error(400, "invalid hostname")
    port = os.getenv("PORT", "8420")
    config_yml = (
        "tunnel: <tunnel-id>\n"
        "credentials-file: %USERPROFILE%\\.cloudflared\\<tunnel-id>.json\n"
        "\n"
        "ingress:\n"
        f"  - hostname: {hostname}\n"
        "    path: ^/remote/v1/\n"
        f"    service: http://127.0.0.1:{port}\n"
        "\n"
        "  - service: http_status:404\n"
    )
    commands = [
        "cloudflared tunnel login",
        f"cloudflared tunnel create {_TUNNEL_NAME}",
        f"cloudflared tunnel route dns {_TUNNEL_NAME} {hostname}",
        "Write the config above to %USERPROFILE%\\.cloudflared\\config.yml",
        "cloudflared service install",
    ]
    return {"hostname": hostname, "config_yml": config_yml, "commands": commands}


def _cloudflared_path() -> str | None:
    found = shutil.which("cloudflared")
    if found:
        return found
    if os.path.isfile(_CLOUDFLARED_WIN_PATH):
        return _CLOUDFLARED_WIN_PATH
    return None


def _cloudflared_running() -> bool:
    try:
        import psutil
    except Exception:  # noqa: BLE001 - psutil absence must not 500 this route
        logger.debug("psutil unavailable for cloudflared running check", exc_info=True)
        return False
    try:
        for proc in psutil.process_iter(["name"]):
            try:
                name = (proc.info.get("name") or "").lower()
            except Exception:  # noqa: BLE001 - a vanished process is not our error
                continue
            if name in ("cloudflared", "cloudflared.exe"):
                return True
    except Exception:  # noqa: BLE001 - enumeration must never 500 this route
        logger.debug("Failed to enumerate processes for cloudflared", exc_info=True)
        return False
    return False


@admin_router.get("/cloudflared")
async def cloudflared_status():
    path = _cloudflared_path()
    return {
        "installed": bool(path),
        "path": path,
        "version": None,
        "running": _cloudflared_running(),
    }


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


# Cloudflare's default bot rules answer urllib's own "Python-urllib/3.x" agent
# with a bare 403 (measured 2026-09-08 on studio.boord-its.com: curl, Dart and a
# browser all got the Access 302; Python-urllib alone got 403). A probe that
# announces itself honestly gets the same answer a phone would.
_PROBE_USER_AGENT = "PlexarStudio-remote-probe/1"


def _fetch_probe(hostname: str) -> tuple[int | None, dict, str]:
    """GET https://<hostname>/remote/v1/hello, redirects NOT followed, no creds.

    Returns (status, headers, body); status is None only on a genuine
    connect/DNS/timeout failure. Overridden in tests via ``_fetch_probe``.
    """
    url = f"https://{hostname}/remote/v1/hello"
    opener = urllib.request.build_opener(_NoRedirectHandler)
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": _PROBE_USER_AGENT})
    try:
        with opener.open(request, timeout=5) as resp:
            body = resp.read(65536).decode("utf-8", errors="replace")
            return resp.status, dict(resp.headers.items()), body
    except urllib.error.HTTPError as exc:
        headers = dict(exc.headers.items()) if exc.headers else {}
        try:
            body = exc.read(65536).decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - a body-less error response is fine
            body = ""
        return exc.code, headers, body
    except (urllib.error.URLError, OSError):
        logger.debug("Probe of %s was unreachable", hostname, exc_info=True)
        return None, {}, ""


def _header(headers: dict, name: str) -> str:
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return value
    return ""


def _classify_probe(status: int | None, headers: dict, body: str) -> str:
    if status is None:
        return "unreachable"
    if 300 <= status < 400 and "cloudflareaccess.com" in _header(headers, "Location"):
        return "access"
    content_type = _header(headers, "Content-Type").lower()
    stripped = (body or "").strip().lower()
    if "html" in content_type or stripped.startswith("<!doctype html") or stripped.startswith("<html"):
        return "access"
    if status == 401:
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict):
            return "guarded"
    if status == 404:
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            data = None
        if isinstance(data, dict) and data.get("error") == "remote disabled":
            return "disabled"
    return "unexpected"


@admin_router.post("/probe")
def probe_public_url(payload: dict = Body(default={})):
    """Server-side probe of the operator's own public hostname.

    A plain ``def`` route: FastAPI runs it in its threadpool, so the blocking
    urllib call never stalls the event loop the way an unguarded call in an
    ``async def`` route would.
    """
    hostname = _hostname_from(str((payload or {}).get("hostname") or ""))
    if not _valid_hostname(hostname):
        return _error(400, "invalid hostname")
    status, headers, body = _fetch_probe(hostname)
    classification = _classify_probe(status, headers, body)
    return {"hostname": hostname, "classification": classification, "status": status}


# ---------------------------------------------------------------------------
# router -- the phone's surface, device-authenticated
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/remote/v1")


@router.post("/pair")
async def pair(request: Request):
    """Redeem a pairing code. The ONE route with no bearer token."""
    _backend_, store = _require_configured()
    if not remote_enabled():
        return _error(404, "remote disabled")
    body = await _read_json(request)
    try:
        device_id, token = store.redeem_pairing(
            str(body.get("code") or ""), str(body.get("device_name") or "")
        )
    except PairingError as exc:
        client_host = request.client.host if request.client else "unknown"
        logger.warning(
            "Remote pairing attempt failed: %s (client %s)",
            getattr(exc, "reason", "unknown code"),
            client_host,
        )
        return _error(400, str(exc))
    return {
        "device_id": device_id,
        "token": token,
        "protocol": PROTOCOL_VERSION,
        "app_version": _backend_.app_version(),
    }


@router.get("/hello")
async def hello(device: Device = Depends(require_device)):
    backend, _store_ = _require_configured()
    return {
        "protocol": PROTOCOL_VERSION,
        "app_version": backend.app_version(),
        "device": {"id": device.id, "name": device.name},
        "session_count": len(backend.list_sessions()),
    }


@router.get("/sessions")
async def list_sessions(device: Device = Depends(require_device)):
    backend, _store_ = _require_configured()
    # The SNAPSHOT is taken on the loop: `list_sessions` iterates the live
    # session dict, which the loop mutates, so it must not race a worker thread.
    # The per-session ENRICHMENT goes off the loop (R-191): for every session, on
    # every phone poll (1.5-3 s), `_session_view` stats the transcript, reads its
    # tail for the preview and reads .git/HEAD for the branch. That file I/O ran
    # on the one thread serving everything, which fits the owner's report that a
    # stall "took the phone with it". `_session_view` reads only the snapshot
    # dicts, plus plain attribute reads for the live effort.
    sessions = backend.list_sessions()
    views = await asyncio.to_thread(
        lambda: [_session_view(s, backend) for s in sessions]
    )
    return {"sessions": views}


@router.post("/sessions", status_code=201)
async def create_session(request: Request, device: Device = Depends(require_device)):
    """Spawn a session. The three optional knobs are validated HERE, not there.

    `permission_mode`, `effort` and `bypass` are the phone's wire names; they
    are renamed to the local create body's `permissionMode` / `effort` /
    `bypassPermissions` and are OMITTED entirely when the caller did not send
    them, so an absent field keeps `_create_terminal_from_body`'s own default
    rather than this route inventing one.
    """
    backend, _store_ = _require_configured()
    body = await _read_json(request)
    payload = {
        "name": body.get("name"),
        "workdir": body.get("workdir"),
        "harness": body.get("harness"),
        "model": body.get("model"),
    }
    mode = body.get("permission_mode")
    if mode is not None:
        if not isinstance(mode, str) or mode not in _PERMISSION_MODE_IDS:
            return _error(400, "unknown permission_mode")
        payload["permissionMode"] = mode
    effort = body.get("effort")
    if effort is not None:
        if not isinstance(effort, str) or effort not in EFFORTS:
            return _error(400, "unknown effort")
        payload["effort"] = effort
    bypass = body.get("bypass")
    if bypass is not None:
        if not isinstance(bypass, bool):
            return _error(400, "bypass must be a boolean")
        payload["bypassPermissions"] = bypass
    try:
        session = await backend.create_session(payload)
    except ValueError as exc:
        return _error(400, str(exc))
    return {"session": await asyncio.to_thread(_session_view, session or {}, backend)}


@router.delete("/sessions/{terminal_id}")
async def close_session(terminal_id: str, device: Device = Depends(require_device)):
    """Close a session from the phone, via the same kill DELETE /api/terminals does."""
    backend, _store_ = _require_configured()
    if backend.delete_session is None:
        return _error(503, "closing sessions is not available")
    if backend.get_session(terminal_id) is None:
        return _error(404, "unknown session")
    closed = await _maybe_await(backend.delete_session(terminal_id))
    return {"closed": bool(closed)}


@router.post("/sessions/{terminal_id}/input")
async def send_input(
    terminal_id: str, request: Request, device: Device = Depends(require_device)
):
    backend, _store_ = _require_configured()
    if backend.get_session(terminal_id) is None:
        return _error(404, "unknown session")
    body = await _read_json(request)
    text = body.get("text")
    if not isinstance(text, str):
        return _error(400, "text must be a string")
    request_id = body.get("request_id")
    if isinstance(request_id, str) and request_id:
        if not _remember_request(device.id, request_id):
            return {"accepted": True, "duplicate": True}
    submit = body.get("submit")
    submit = True if submit is None else bool(submit)
    if submit:
        accepted = await backend.submit(terminal_id, text)
    else:
        accepted = await backend.write_raw(terminal_id, text)
    return {"accepted": bool(accepted), "duplicate": False}


@router.post("/sessions/{terminal_id}/interrupt")
async def interrupt(terminal_id: str, device: Device = Depends(require_device)):
    backend, _store_ = _require_configured()
    if backend.get_session(terminal_id) is None:
        return _error(404, "unknown session")
    accepted = await backend.interrupt(terminal_id)
    return {"accepted": bool(accepted)}


# ---------------------------------------------------------------------------
# Where a new session should run: saved folders, live sessions, history, and
# the filesystem the desktop can already see.
# ---------------------------------------------------------------------------


def _sessions_newest_first(backend: RemoteBackend) -> list[dict]:
    """Live sessions, newest first. Never raises -- an empty list is an answer."""
    try:
        sessions = list(backend.list_sessions() or [])
    except Exception:  # noqa: BLE001 - one bad session list must not 500 /workdirs
        logger.warning("Failed listing sessions for /workdirs", exc_info=True)
        return []
    rows = [s for s in sessions if isinstance(s, dict)]
    # sorted() is stable and stays stable under reverse=True, so sessions that
    # carry no created_at keep the order the manager listed them in.
    return sorted(rows, key=lambda s: str(s.get("created_at") or ""), reverse=True)


async def _drive_roots(backend: RemoteBackend) -> list[str]:
    """The same roots ``browse_directories("")`` returns; ["/"] if it cannot say."""
    if backend.browse is None:
        return ["/"]
    try:
        data = _as_dict(await _maybe_await(backend.browse("")))
    except OSError:
        logger.warning("Failed listing drive roots for /workdirs", exc_info=True)
        return ["/"]
    dirs = data.get("dirs")
    roots = [d for d in dirs if isinstance(d, str) and d] if isinstance(dirs, list) else []
    return roots or ["/"]


@router.get("/workdirs")
async def list_workdirs(device: Device = Depends(require_device)):
    """Every folder the phone could sensibly start a session in, best first.

    Three sources in one list, each row saying which one it came from, because
    they mean different things: `saved` is a folder the user deliberately kept,
    `session` is one something is running in RIGHT NOW, and `history` is one
    that has usage on record. De-duplication keeps the FIRST occurrence, so a
    saved folder that also has a live session stays labelled `saved` -- the
    stronger statement of the two.
    """
    backend, _store_ = _require_configured()
    workdirs: list[dict] = []
    seen: set[str] = set()

    def add(path: Any, name: Any, source: str, last_used: Any) -> None:
        if not isinstance(path, str):
            return
        path = path.strip()
        if not path:
            return
        key = _dedupe_key(path)
        if key in seen:
            return
        seen.add(key)
        workdirs.append(
            {
                "path": path,
                "name": name if isinstance(name, str) and name else None,
                "source": source,
                "last_used": last_used if isinstance(last_used, str) and last_used else None,
            }
        )

    for entry in _read_locations():
        add(entry.get("path"), entry.get("name"), "saved", None)

    for session in _sessions_newest_first(backend):
        # `last_used` for a LIVE session is when it started: the only timestamp
        # this record actually carries. Claiming "now" would be an invention.
        add(session.get("working_dir"), None, "session", session.get("created_at"))

    if backend.recent_workdirs is not None:
        try:
            history = backend.recent_workdirs(30) or []
        except Exception:  # noqa: BLE001 - a usage DB error must not lose the other two sources
            logger.warning("Failed reading recent workdirs from usage history", exc_info=True)
            history = []
        for row in history:
            if isinstance(row, dict):
                add(row.get("path"), None, "history", row.get("last_used"))

    return {"workdirs": workdirs, "roots": await _drive_roots(backend)}


@router.get("/browse")
async def browse(path: str = "", device: Device = Depends(require_device)):
    """Subdirectories of *path*, through the desktop's own listing code.

    An unreadable folder answers 200 with an empty `entries` and an `error`
    string, NOT a 5xx: the phone is mid-navigation and needs to be told this
    one folder cannot be walked while the breadcrumb it came from still works.
    """
    backend, _store_ = _require_configured()
    if backend.browse is None:
        return _error(503, "browsing is not available")
    requested = (path or "").strip()
    if requested and not _is_browsable_path(requested):
        return _error(400, "path must be absolute")
    try:
        data = _as_dict(await _maybe_await(backend.browse(requested)))
    except OSError as exc:
        logger.debug("Remote browse failed for %r", requested, exc_info=True)
        return {"path": requested, "parent": None, "entries": [], "error": str(exc)}
    parent = data.get("parent")
    raw_entries = data.get("entries")
    entries = []
    if isinstance(raw_entries, list):
        for entry in raw_entries:
            if not isinstance(entry, dict):
                continue
            row = {key: entry.get(key) for key in BROWSE_ENTRY_FIELDS}
            row["git"] = bool(row["git"])
            row["session_count"] = row["session_count"] if isinstance(row["session_count"], int) else 0
            entries.append(row)
    return {
        "path": requested,
        "parent": parent if isinstance(parent, str) and parent else None,
        "entries": entries,
    }


def _configured_session_model() -> str:
    """`sessions.model` from settings, or "" when unset/unreadable."""
    if _backend is None:
        return ""
    try:
        settings = _backend.settings() or {}
    except Exception:  # noqa: BLE001 - a settings read must never 500 the gateway
        logger.warning("Failed to read settings for the remote catalog", exc_info=True)
        return ""
    sessions = settings.get("sessions")
    model = sessions.get("model") if isinstance(sessions, dict) else None
    return model.strip() if isinstance(model, str) else ""


@router.get("/catalog")
async def catalog(device: Device = Depends(require_device)):
    """What a new session can be: harnesses, their models, modes and efforts.

    The Claude list is the LIVE one the desktop picker reads; there is no
    static fallback written here, because a second hardcoded Anthropic catalog
    is exactly what `modelCatalog.js` exists to prevent. If the catalog cannot
    be read the list is empty and `default_model` is null -- the phone renders
    "no models" rather than a plausible id that may not exist.
    """
    backend, _store_ = _require_configured()
    claude_models: list[dict] = []
    if backend.anthropic_models is not None:
        try:
            data = _as_dict(await _maybe_await(backend.anthropic_models()))
        except OSError:
            logger.warning("Failed reading the Anthropic model catalog for /catalog", exc_info=True)
            data = {}
        raw_models = data.get("models")
        for model in raw_models if isinstance(raw_models, list) else []:
            if not isinstance(model, dict):
                continue
            model_id = model.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            label = model.get("display_name") or model.get("label") or model_id
            claude_models.append({"id": model_id, "label": str(label)})
    configured = _configured_session_model()
    claude_default = configured or (claude_models[0]["id"] if claude_models else None)
    return {
        "harnesses": [
            {
                "id": "claude-code",
                "label": "Claude Code",
                "models": claude_models,
                "default_model": claude_default,
            },
            {
                "id": "codex",
                "label": "Codex",
                "models": [{"id": mid, "label": label} for mid, label in CODEX_MODELS],
                "default_model": CODEX_DEFAULT_MODEL,
            },
        ],
        "permission_modes": [{"id": mode_id, "label": label} for mode_id, label in PERMISSION_MODES],
        "efforts": list(EFFORTS),
    }


# ---------------------------------------------------------------------------
# The chat view: one message shape for both harnesses, uploads, and the ONE
# route that hands a file's bytes back to the phone.
# ---------------------------------------------------------------------------

#: Images only, and the same five the desktop's own thumbnail route serves.
#: SVG is absent deliberately -- it is a script-bearing document, and this route
#: exists solely to draw a picture.
SERVABLE_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}

_IMAGE_MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

#: A phone screenshot is a couple of megabytes; ten is generous and still small
#: enough that a refusal is a bug report rather than a slow tab.
FILES_MAX_BYTES = 10 * 1024 * 1024

MAX_UPLOAD_FILES = 4

MESSAGE_LIMIT_DEFAULT = 50
MESSAGE_LIMIT_MAX = 200

#: A tool_result can be enormous; the phone renders it collapsed behind a chip
#: and never needs the whole thing.
_TOOL_RESULT_MAX = 2000

_IMAGE_EXT_ALTERNATION = "png|jpe?g|gif|webp"

#: Absolute paths ending in an image extension, as they appear inside a user
#: message's text -- which is exactly how the desktop's clipboard paste injects
#: them. Quoted first (a quoted path may contain spaces); the bare forms stop at
#: whitespace. Windows and POSIX are both matched regardless of the platform the
#: server runs on, because these strings come from the DESKTOP, not from this
#: process's filesystem.
_IMAGE_PATH_RE = re.compile(
    r'"((?:[A-Za-z]:[\\/]|/)[^"\r\n]*?\.(?:' + _IMAGE_EXT_ALTERNATION + r'))"'
    r"|"
    r'((?:[A-Za-z]:[\\/]|/)[^\s"\r\n]*?\.(?:' + _IMAGE_EXT_ALTERNATION + r"))",
    re.IGNORECASE,
)


def _session_field(session: Any, name: str, default: Any = None) -> Any:
    """Read *name* off a TerminalSession OR off a plain dict.

    ``get_session`` is wired to ``pty_manager.get_terminal`` in production and
    returns an object; the gateway's own tests hand back the dict the sessions
    list is made of. Both must work, or the tests stop testing production.
    """
    if isinstance(session, dict):
        return session.get(name, default)
    return getattr(session, name, default)


def _real(path: Any) -> str:
    """``os.path.realpath`` that never raises. "" when it cannot be resolved."""
    if not isinstance(path, str) or not path.strip():
        return ""
    try:
        return os.path.realpath(path.strip())
    except (OSError, ValueError):
        logger.debug("Could not resolve path %r", path, exc_info=True)
        return ""


def _within(candidate: str, root: str) -> bool:
    """True when *candidate* is *root* itself or lies beneath it.

    A separator-terminated prefix, never a bare ``startswith``: "C:\\uploads2"
    starts with "C:\\uploads" and is a DIFFERENT directory. Case is folded on
    Windows only -- folding on Linux would merge two real directories.
    """
    if not candidate or not root:
        return False
    left, right = candidate, root
    if os.name == "nt":
        left, right = left.casefold(), right.casefold()
    if left == right:
        return True
    return left.startswith(right.rstrip("\\/") + os.sep)


def _serve_roots(backend: RemoteBackend, session: Any = None) -> list[str]:
    """Realpath'd roots a file may be served from: the upload dir, plus the
    working_dir of every live session (or of *session* alone when given)."""
    roots: list[str] = []
    if backend.upload_dir is not None:
        try:
            roots.append(_real(backend.upload_dir()))
        except Exception:  # noqa: BLE001 - a bad upload dir must not 500 the route
            logger.warning("Failed reading the upload dir for the files route", exc_info=True)
    if session is not None:
        roots.append(_real(_session_field(session, "working_dir")))
    else:
        try:
            sessions = backend.list_sessions() or []
        except Exception:  # noqa: BLE001
            logger.warning("Failed listing sessions for the files route", exc_info=True)
            sessions = []
        for entry in sessions:
            roots.append(_real(_session_field(entry, "working_dir")))
    return [r for r in roots if r]


#: `<image name=[Image #1] path="C:\...">  </image>` -- the desktop's own
#: image-attachment tag, written into the text block the harness sees.
#: THE CLOSING `</image>` IS OPTIONAL, and the bare form is what real data uses.
#: MEASURED 2026-09-09 (R-187): 27 Codex rollouts on this machine carry 520 of
#: these tags and EVERY ONE is the bare `>` form -- not one self-closing or
#: open/close instance exists, and the last 40 Claude transcripts carry no tag at
#: all. The previous pattern required `/>` or `>` + whitespace + `</image>`, so it
#: matched ZERO real tags; every test pinning it used an invented shape. This
#: pattern is a strict SUPERSET of that one, so those tests still hold.
_IMAGE_TAG_RE = re.compile(
    r'<image\b[^>]*?\bpath="([^"]*)"[^>]*?>(?:\s*</image\s*>)?',
    re.IGNORECASE | re.DOTALL,
)


def _extract_image_tags(text: str) -> tuple[str, list[str]]:
    """Strip every `<image ... path="...">...</image>` tag out of *text*.

    Returns the text with the tags removed and whitespace collapsed at the
    join (an empty remaining text is legitimate -- the caller drops it), plus
    the ordered list of paths the tags carried. Unlike `_image_paths_in`, this
    is NOT root-gated: the tag is the harness's own attachment record, not a
    path merely mentioned in prose.
    """
    if not isinstance(text, str) or not text:
        return text, []
    paths: list[str] = []

    def _sub(match: "re.Match[str]") -> str:
        paths.append(match.group(1))
        return " "

    remaining = _IMAGE_TAG_RE.sub(_sub, text)
    if paths:
        remaining = " ".join(remaining.split())
    return remaining, paths


def _image_paths_in(text: str, roots: list[str]) -> list[str]:
    """Absolute image paths in *text* that resolve inside one of *roots*.

    The containment check is the whole point: a message that merely MENTIONS
    "/etc/logo.png" must not turn into an image block the phone will then ask
    the files route for.
    """
    if not isinstance(text, str) or not text:
        return []
    found: list[str] = []
    for match in _IMAGE_PATH_RE.finditer(text):
        raw = match.group(1) or match.group(2)
        if not raw:
            continue
        resolved = _real(raw)
        if not resolved or not any(_within(resolved, root) for root in roots):
            continue
        if raw not in found:
            found.append(raw)
    return found


def _claude_message(entry: dict, roots: list[str]) -> dict | None:
    """One jsonl_watcher dict -> the unified shape, or None when it carries
    nothing a chat view can draw."""
    if not isinstance(entry, dict):
        return None
    entry_type = entry.get("type")
    role = entry.get("role")
    # A tool_result entry is written with role "user" (the harness replies to
    # itself); calling that "user" on the phone would put the tool's output in
    # the human's bubble.
    if entry_type == "tool_result":
        role = "tool"
    if role not in ("user", "assistant", "system", "tool"):
        return None
    blocks: list[dict] = []
    raw_blocks = entry.get("content")
    for block in raw_blocks if isinstance(raw_blocks, list) else []:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        if kind == "text":
            text = block.get("text")
            if isinstance(text, str) and text:
                blocks.append({"type": "text", "text": text})
        elif kind == "thinking":
            text = block.get("text")
            if isinstance(text, str) and text:
                blocks.append({"type": "thinking", "text": text})
        elif kind == "tool_use":
            blocks.append({"type": "tool_use", "name": str(block.get("tool_name") or "unknown")})
        elif kind == "tool_result":
            blocks.append(
                {"type": "tool_result", "text": str(block.get("content") or "")[:_TOOL_RESULT_MAX]}
            )
    if role == "user":
        for block in list(blocks):
            if block["type"] != "text":
                continue
            remaining, tag_paths = _extract_image_tags(block["text"])
            if tag_paths:
                block["text"] = remaining
                for path in tag_paths:
                    blocks.append({"type": "image", "path": path})
        # A text block that was ONLY image tags is now empty -- drop it rather
        # than showing an empty bubble beside the image(s) it described.
        blocks = [b for b in blocks if b["type"] != "text" or b["text"]]
        for block in list(blocks):
            if block["type"] != "text":
                continue
            for path in _image_paths_in(block["text"], roots):
                blocks.append({"type": "image", "path": path})
    if not blocks:
        return None
    timestamp = entry.get("timestamp")
    return {
        "id": str(entry.get("id") or ""),
        "role": role,
        "timestamp": timestamp if isinstance(timestamp, str) and timestamp else None,
        "blocks": blocks,
    }


def _codex_message(row: Any) -> dict | None:
    r"""One ``transcript_page`` row -> the unified shape. A Codex rollout page
    carries no tool or thinking blocks, but it DOES carry the same desktop
    attachment tags Claude Code writes, so image blocks are extracted here too.

    Measured 2026-09-09: a live rollout holds
    ``<image name=[Image #1] path="C:\...\cockpit_uploads_...">`` byte-identical
    to the Claude JSONL form. Emitting text only meant an attachment could never
    render on the phone under Codex, and the raw tag showed as literal markup in
    the bubble. `_image_paths_in` is deliberately NOT applied: it is root-gated
    and the Codex call site does not thread `roots`. The tag is the harness's own
    record and needs no gate.
    """
    if not isinstance(row, dict):
        return None
    role = row.get("role")
    if role not in ("user", "assistant"):
        return None
    text = row.get("text")
    if not isinstance(text, str) or not text:
        return None
    timestamp = row.get("timestamp")
    blocks: list[dict] = [{"type": "text", "text": text}]
    if role == "user":
        remaining, tag_paths = _extract_image_tags(text)
        if tag_paths:
            # A text block that was ONLY image tags is now empty -- drop it
            # rather than showing an empty bubble beside the image it named.
            blocks = [{"type": "text", "text": remaining}] if remaining else []
            blocks.extend({"type": "image", "path": path} for path in tag_paths)
    if not blocks:
        return None
    return {
        "id": str(row.get("index")),
        "role": role,
        "timestamp": timestamp if isinstance(timestamp, str) and timestamp else None,
        "blocks": blocks,
    }


def _page_by_id(
    items: list[dict], after: str | None, before: str | None, limit: int
) -> tuple[list[dict], bool, bool]:
    """Slice *items* around an opaque cursor. -> (page, complete, cursor_reset).

    An UNKNOWN cursor is treated as absent -- the tail, plus ``cursor_reset``.
    Refusing it would strand a phone whose stored id belongs to a transcript
    that has since been rewritten, with no way back; guessing a position would
    be worse still.
    """
    ids = [m["id"] for m in items]
    if after is not None:
        if after in ids:
            start = ids.index(after) + 1
            # Everything before `after` is already on the phone, so nothing is
            # missing ahead of this page by construction.
            return items[start : start + limit], True, False
        return items[-limit:], len(items) <= limit, True
    if before is not None:
        if before in ids:
            end = ids.index(before)
            start = max(0, end - limit)
            return items[start:end], start == 0, False
        return items[-limit:], len(items) <= limit, True
    return items[-limit:], len(items) <= limit, False


def _clamp_limit(limit: int) -> int:
    try:
        value = int(limit)
    except (TypeError, ValueError):
        return MESSAGE_LIMIT_DEFAULT
    return max(1, min(MESSAGE_LIMIT_MAX, value))


@router.get("/sessions/{terminal_id}/messages")
async def list_messages(
    terminal_id: str,
    after: str | None = None,
    before: str | None = None,
    limit: int = MESSAGE_LIMIT_DEFAULT,
    device: Device = Depends(require_device),
):
    """The session's conversation, in ONE shape whichever harness produced it.

    A harness with no transcript yet is an empty list and a 200, not a 404: the
    phone has just opened a brand-new session and there is nothing wrong.
    """
    backend, _store_ = _require_configured()
    session = backend.get_session(terminal_id)
    if session is None:
        return _error(404, "unknown session")
    limit = _clamp_limit(limit)
    harness = str(_session_field(session, "harness", "claude-code") or "claude-code")
    activity_state = _session_field(session, "activity_state")
    if activity_state is None:
        # A real TerminalSession has no activity_state attribute: the state
        # lives on its tracker (that is what _session_to_dict serializes). Only
        # the dict-shaped test doubles carry it as a key. Without this branch the
        # phone's typing indicator never lit in production.
        activity_state = getattr(getattr(session, "tracker", None), "state", None)
    messages: list[dict] = []
    complete = True
    cursor_reset = False

    if harness == "claude-code":
        if backend.messages_claude is None:
            return _error(503, "messages are not available")
        try:
            raw = await _maybe_await(backend.messages_claude(session)) or []
        except OSError:
            logger.warning("Failed reading Claude messages for %s", terminal_id, exc_info=True)
            raw = []
        roots = _serve_roots(backend, session)
        mapped = [m for m in (_claude_message(e, roots) for e in raw) if m]
        messages, complete, cursor_reset = _page_by_id(mapped, after, before, limit)
    else:
        if backend.transcript_codex is None:
            return _error(503, "messages are not available")
        # Codex ids are the rollout's byte offsets, so its own `before` paging
        # is used directly rather than re-sliced here. `after` has no native
        # equivalent: take the newest page and drop what the phone already has.
        cursor = before if before is not None else None
        before_index: int | None = None
        if cursor is not None:
            try:
                before_index = int(cursor)
            except (TypeError, ValueError):
                cursor_reset = True
        try:
            page = _as_dict(await _maybe_await(backend.transcript_codex(session, before_index, limit)))
        except OSError:
            logger.warning("Failed reading the Codex transcript for %s", terminal_id, exc_info=True)
            page = {}
        rows = page.get("messages")
        mapped = [m for m in (_codex_message(r) for r in (rows if isinstance(rows, list) else [])) if m]
        complete = not bool(page.get("has_more"))
        if after is not None:
            try:
                after_index = int(after)
            except (TypeError, ValueError):
                cursor_reset = True
            else:
                kept = [m for m in mapped if int(m["id"]) > after_index]
                if len(kept) != len(mapped):
                    # We dropped only messages the phone already holds, so
                    # nothing is missing ahead of this page.
                    complete = True
                mapped = kept
        messages = mapped

    body = {
        "messages": messages,
        "harness": harness,
        "activity_state": activity_state,
        "complete": bool(complete),
    }
    if cursor_reset:
        body["cursor_reset"] = True
    return body


@router.post("/sessions/{terminal_id}/upload", status_code=201)
async def upload_to_session(
    terminal_id: str,
    files: list[UploadFile] = File(...),
    device: Device = Depends(require_device),
):
    """Store 1..4 attachments and hand back the absolute paths the CLI can read.

    Per-file failures are REPORTED, not fatal: three good screenshots and one
    rejected .exe should send three screenshots, and the phone shows the one
    error beside them.
    """
    backend, _store_ = _require_configured()
    if backend.save_upload is None:
        return _error(503, "uploads are not available")
    if backend.get_session(terminal_id) is None:
        return _error(404, "unknown session")
    if not files:
        return _error(400, "at least one file is required")
    if len(files) > MAX_UPLOAD_FILES:
        return _error(400, f"at most {MAX_UPLOAD_FILES} files")
    paths: list[str] = []
    errors: list[str] = []
    for upload in files:
        content = await upload.read()
        try:
            saved = await _maybe_await(backend.save_upload(upload.filename or "", content))
        except ValueError as exc:
            errors.append(str(exc))
            continue
        if isinstance(saved, str) and saved:
            paths.append(saved)
        else:
            errors.append(f"Rejected '{upload.filename}'")
    return {"paths": paths, "errors": errors}


def _refuse_file(path: str, why: str) -> JSONResponse:
    logger.debug("Remote files route refused %r: %s", path, why)
    return _error(404, "not served")


@router.get("/files")
async def get_file(path: str = "", device: Device = Depends(require_device)):
    """Hand back ONE image the phone is entitled to see.

    Every refusal is the SAME 404 body. A probe must not learn from the reply
    whether a path exists, is the wrong type, or sits outside the roots -- those
    are three different facts about the desktop's filesystem and none of them is
    the phone's business.
    """
    backend, _store_ = _require_configured()
    raw = (path or "").strip()
    if not raw:
        return _refuse_file(raw, "empty path")
    # UNC is refused BEFORE resolution: "\\\\host\\share" is a network location,
    # and no root this route serves from is ever one.
    if raw.startswith("\\\\") or (os.name == "nt" and raw.startswith("//")):
        return _refuse_file(raw, "UNC path")
    ext = os.path.splitext(raw)[1].lower()
    if ext not in SERVABLE_IMAGE_EXTENSIONS:
        return _refuse_file(raw, f"extension {ext!r} is not servable")
    resolved = _real(raw)
    if not resolved:
        return _refuse_file(raw, "unresolvable")
    if resolved.startswith("\\\\"):
        return _refuse_file(raw, "resolved to a UNC path")
    roots = _serve_roots(backend)
    if not any(_within(resolved, root) for root in roots):
        return _refuse_file(raw, "outside every served root")
    if not os.path.isfile(resolved):
        return _refuse_file(raw, "not a file")
    try:
        size = os.path.getsize(resolved)
    except OSError:
        return _refuse_file(raw, "could not stat")
    if size > FILES_MAX_BYTES:
        return _refuse_file(raw, f"{size} bytes exceeds the cap")
    return FileResponse(
        resolved,
        media_type=_IMAGE_MEDIA_TYPES.get(ext, "application/octet-stream"),
        headers={"Cache-Control": "no-store"},
    )
