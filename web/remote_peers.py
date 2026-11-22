"""Studio-to-Studio peers: this Studio pairs with another machine's Studio.

The other machine sees an ordinary Studio Remote v1 device (docs/studio-remote-v1.md):
this sidecar redeems a pairing code at `<peer>/remote/v1/pair` exactly as a phone does,
keeps the device token, and from then on proxies the page's requests to that peer.
Contract for the page: docs/studio-peers-v1.md.

**The page never sees the token.** It lives in `config.json` (the secrets file, beside
the provider keys and the tunnel token; never `settings.json`, which is exportable),
keyed by peer id under `remote_peer_tokens`. Non-secret metadata (id, label, url,
added_at, the peer's device id) lives in `app_paths.data_path("remote_peers.json")`.
No route returns the token, and no log line carries it: lines name the peer id only,
and the upstream WebSocket library's own logger is held at WARNING because its debug
output echoes request headers.

**Where requests go.** Only to a STORED peer url, only under the fixed `/remote/v1`
prefix, with every caller-supplied path segment percent-quoted so it cannot climb out
of it. A url is validated once, at add time: `https` to any host, `http` only to a
loopback host (a dev rig on this machine). Redirects are never followed, on HTTP or
WebSocket: a 3xx from a peer is reported, and a Cloudflare Access challenge (a 302 to
`*.cloudflareaccess.com`, or an HTML page where JSON was expected) is classified as
`access_required`, distinct from `unauthorized` (a 401 from Studio itself) and from
`unreachable`. A 401 is never reported as unreachable: their remedies are opposite.

**`/ws/peer/{peer_id}/{session_id}` speaks the page the frames `/ws/terminal/{id}`
does**, so `TerminalPane` needs only a different URL. The origin guard runs BEFORE
accept and before the peer lookup, and an unknown peer is refused with the SAME
pre-accept close, so a foreign page learns nothing about which peers exist.

Every route is `async def`; every blocking network call runs in `asyncio.to_thread`.
The HTTP client and the upstream WebSocket connector are injectable (`configure`) so
tests run against fakes without a network.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

import origin_guard

logger = logging.getLogger("cockpit.peers")

# websockets logs request headers (Authorization included) at DEBUG. Pinning its
# logger here keeps the bearer out of any sink regardless of the root level.
_upstream_ws_logger = logging.getLogger("cockpit.peers.upstream_ws")
_upstream_ws_logger.setLevel(logging.WARNING)

REMOTE_PREFIX = "/remote/v1"
_TOKEN_FIELD = "remote_peer_tokens"
_USER_AGENT = "PlexarStudio-peer/1"
_HTTP_TIMEOUT = 10.0
_DEFAULT_DEVICE_NAME = "Plexar Studio"

# The page's own /ws/terminal heartbeat cadence, mirrored.
_HEARTBEAT_S = 30.0
# Input retry: the SAME request_id each time, so the peer's LRU answers a retry of
# a write that did land with duplicate:true instead of typing it twice.
_INPUT_ATTEMPTS = 3
_INPUT_RETRY_DELAY_S = 0.5

_SESSION_ENDED_BANNER = "\r\n\x1b[33m[Session ended]\x1b[0m\r\n"
# Identical for a refused origin and an unknown peer: the caller must not be able
# to tell them apart. Starlette turns a pre-accept close into an HTTP 403 anyway.
_WS_REFUSAL_CODE = 4403
_WS_REFUSAL_REASON = "refused"

# Fields the page may pass through to the peer's POST /remote/v1/sessions.
_CREATE_FIELDS = ("workdir", "harness", "model", "permission_mode", "effort", "bypass", "name")

_LOOPBACK_HOSTS = {"localhost"}


# ---------------------------------------------------------------------------
# URL validation
# ---------------------------------------------------------------------------


def _is_loopback(host: str) -> bool:
    if host.lower() in _LOOPBACK_HOSTS:
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def normalize_peer_url(raw: Any) -> str | None:
    """The peer's base url (`scheme://host[:port]`), or None when refused.

    https to any host; http only to a loopback host. No credentials, query,
    fragment or path beyond a bare `/`: the stored value is an ORIGIN, and every
    request appends the fixed `/remote/v1` prefix to it.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    if not text or any(ch.isspace() for ch in text):
        return None
    try:
        parts = urllib.parse.urlsplit(text)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    host = parts.hostname or ""
    if scheme not in ("https", "http") or not host:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    if parts.query or parts.fragment or parts.path not in ("", "/"):
        return None
    if scheme == "http" and not _is_loopback(host):
        return None
    shown = f"[{host}]" if ":" in host else host
    return f"{scheme}://{shown}" + (f":{port}" if port is not None else "")


def _seg(value: str) -> str:
    """One path segment, quoted so `/`, `..` and `?` cannot leave the prefix."""
    return urllib.parse.quote(str(value), safe="")


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _default_meta_path() -> Path:
    import app_paths

    return app_paths.data_path("remote_peers.json")


def _default_read_secrets() -> dict:
    import settings_store

    return settings_store._read_config()


def _default_write_secrets(data: dict) -> None:
    import settings_store

    settings_store._write_config(data)
    try:
        os.chmod(settings_store.CONFIG_FILE, 0o600)
    except OSError:
        logger.debug("Could not chmod config.json to 0600", exc_info=True)


@dataclass
class Peer:
    id: str
    label: str
    url: str
    added_at: str
    device_id: str | None = None

    def public(self) -> dict:
        """The ONLY shape a route returns. No token, no device id."""
        return {"id": self.id, "label": self.label, "url": self.url, "added_at": self.added_at}


class PeerStore:
    """Peer metadata on disk plus tokens in the secrets file. Thread-safe.

    Blocking: every method does file I/O, so routes call it via asyncio.to_thread.
    """

    def __init__(
        self,
        meta_path: Path | None = None,
        read_secrets: Callable[[], dict] | None = None,
        write_secrets: Callable[[dict], None] | None = None,
    ) -> None:
        self._meta_path = meta_path
        self._read_secrets = read_secrets or _default_read_secrets
        self._write_secrets = write_secrets or _default_write_secrets
        self._lock = threading.Lock()

    @property
    def meta_path(self) -> Path:
        return self._meta_path or _default_meta_path()

    def _read_meta(self) -> list[dict]:
        path = self.meta_path
        try:
            if not path.is_file():
                return []
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("Could not read %s; treating as no peers", path, exc_info=True)
            return []
        peers = data.get("peers") if isinstance(data, dict) else None
        return [p for p in peers if isinstance(p, dict)] if isinstance(peers, list) else []

    def _write_meta(self, rows: list[dict]) -> None:
        import settings_store

        path = self.meta_path
        settings_store._write_json_object(path, {"peers": rows}, prefix="remote_peers_")
        try:
            os.chmod(path, 0o600)
        except OSError:
            logger.debug("Could not chmod %s to 0600", path, exc_info=True)

    @staticmethod
    def _row_to_peer(row: dict) -> Peer | None:
        pid, url = row.get("id"), row.get("url")
        if not isinstance(pid, str) or not isinstance(url, str):
            return None
        return Peer(
            id=pid,
            label=str(row.get("label") or ""),
            url=url,
            added_at=str(row.get("added_at") or ""),
            device_id=row.get("device_id") if isinstance(row.get("device_id"), str) else None,
        )

    def list(self) -> list[Peer]:
        with self._lock:
            return [p for p in (self._row_to_peer(r) for r in self._read_meta()) if p]

    def get(self, peer_id: str) -> Peer | None:
        for peer in self.list():
            if peer.id == peer_id:
                return peer
        return None

    def token(self, peer_id: str) -> str | None:
        with self._lock:
            tokens = self._read_secrets().get(_TOKEN_FIELD)
        value = tokens.get(peer_id) if isinstance(tokens, dict) else None
        return value if isinstance(value, str) and value else None

    def add(self, label: str, url: str, token: str, device_id: str | None) -> Peer:
        peer = Peer(id=uuid.uuid4().hex[:12], label=label, url=url, added_at=_now_iso(),
                    device_id=device_id)
        with self._lock:
            # Token first: a crash between the two writes leaves an orphan secret
            # (harmless, nothing lists it) rather than a listed peer with no token.
            data = self._read_secrets()
            tokens = data.get(_TOKEN_FIELD)
            tokens = dict(tokens) if isinstance(tokens, dict) else {}
            tokens[peer.id] = token
            data[_TOKEN_FIELD] = tokens
            self._write_secrets(data)
            rows = self._read_meta()
            rows.append({"id": peer.id, "label": peer.label, "url": peer.url,
                         "added_at": peer.added_at, "device_id": peer.device_id})
            self._write_meta(rows)
        return peer

    def remove(self, peer_id: str) -> bool:
        with self._lock:
            rows = self._read_meta()
            kept = [r for r in rows if r.get("id") != peer_id]
            found = len(kept) != len(rows)
            if found:
                self._write_meta(kept)
            data = self._read_secrets()
            tokens = data.get(_TOKEN_FIELD)
            if isinstance(tokens, dict) and peer_id in tokens:
                tokens = dict(tokens)
                tokens.pop(peer_id, None)
                data[_TOKEN_FIELD] = tokens
                self._write_secrets(data)
                found = True
        return found


# ---------------------------------------------------------------------------
# Upstream clients (injectable)
# ---------------------------------------------------------------------------


@dataclass
class UpstreamResponse:
    status: int | None  # None only for a genuine connect/DNS/timeout failure
    headers: dict
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8", errors="replace"))
        except (ValueError, TypeError):
            return None


HttpClient = Callable[[str, str, dict, "bytes | None"], UpstreamResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D102
        return None


def urllib_client(method: str, url: str, headers: dict, body: bytes | None) -> UpstreamResponse:
    """Blocking HTTP call, redirects NOT followed. Runs in a worker thread."""
    opener = urllib.request.build_opener(_NoRedirect)
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with opener.open(request, timeout=_HTTP_TIMEOUT) as resp:
            return UpstreamResponse(resp.status, dict(resp.headers.items()), resp.read(4 * 1024 * 1024))
    except urllib.error.HTTPError as exc:
        # HTTPError subclasses URLError: caught first, so a refusal is never
        # mistaken for an unreachable peer.
        try:
            data = exc.read(1024 * 1024)
        except Exception:  # noqa: BLE001 - a body-less error response is fine
            data = b""
        return UpstreamResponse(exc.code, dict(exc.headers.items()) if exc.headers else {}, data)
    except (urllib.error.URLError, OSError, ValueError):
        logger.debug("Peer request %s to %s failed to connect", method,
                     urllib.parse.urlsplit(url).netloc, exc_info=True)
        return UpstreamResponse(None, {}, b"")


class UpstreamSocket:
    """What the WS bridge needs from an upstream connection."""

    async def recv(self) -> str: ...  # noqa: D102
    async def send(self, text: str) -> None: ...  # noqa: D102
    async def close(self) -> None: ...  # noqa: D102


WsConnector = Callable[[str, dict], Awaitable[UpstreamSocket]]


async def websockets_connector(url: str, headers: dict) -> UpstreamSocket:
    """Open the peer's stream socket with the `websockets` library, no redirects."""
    from websockets.asyncio.client import connect

    class _NoRedirectConnect(connect):
        def process_redirect(self, exc):  # noqa: D102
            return exc

    return await _NoRedirectConnect(
        url,
        additional_headers=headers,
        user_agent_header=_USER_AGENT,
        open_timeout=_HTTP_TIMEOUT,
        max_size=16 * 1024 * 1024,
        logger=_upstream_ws_logger,
        proxy=None,
    )


_store: PeerStore | None = None
_http: HttpClient = urllib_client
_ws_connect: WsConnector = websockets_connector


def configure(store: PeerStore | None = None, http: HttpClient | None = None,
              ws_connect: WsConnector | None = None) -> None:
    """Swap the store or the clients. Tests only; production uses the defaults."""
    global _store, _http, _ws_connect
    _store = store
    _http = http or urllib_client
    _ws_connect = ws_connect or websockets_connector


def _get_store() -> PeerStore:
    global _store
    if _store is None:
        _store = PeerStore()
    return _store


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def _header(headers: dict, name: str) -> str:
    for key, value in (headers or {}).items():
        if key.lower() == name.lower():
            return str(value)
    return ""


def classify(resp: UpstreamResponse) -> str | None:
    """None for a usable answer, else the reason the peer could not serve it.

    `unreachable`, `access_required` and `unauthorized` are the three that must
    never collapse. `remote_disabled` and `unexpected` are named too, rather than
    folded into one of those three and sending the user to the wrong fix.
    """
    if resp.status is None:
        return "unreachable"
    if 300 <= resp.status < 400:
        if "cloudflareaccess.com" in _header(resp.headers, "Location"):
            return "access_required"
        return "unexpected"
    content_type = _header(resp.headers, "Content-Type").lower()
    head = resp.body[:256].decode("utf-8", errors="replace").strip().lower()
    if "html" in content_type or head.startswith("<!doctype html") or head.startswith("<html"):
        return "access_required"
    if resp.status == 401:
        return "unauthorized"
    if resp.status == 404:
        data = resp.json()
        if isinstance(data, dict) and "remote disabled" in (data.get("detail"), data.get("error")):
            return "remote_disabled"
    if resp.status >= 500:
        return "unexpected"
    return None


# ---------------------------------------------------------------------------
# Upstream calls
# ---------------------------------------------------------------------------


async def _call(peer: Peer, method: str, path: str, body: Any = None,
                query: dict | None = None, token: str | None = None) -> UpstreamResponse:
    """One request to `<peer.url>/remote/v1<path>`, off the loop."""
    url = peer.url + REMOTE_PREFIX + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    return await asyncio.to_thread(_http, method, url, headers, data)


def _error(status: int, message: str, reason: str | None = None) -> JSONResponse:
    body: dict = {"error": message}
    if reason:
        body["reason"] = reason
    return JSONResponse(body, status_code=status)


def _relay(resp: UpstreamResponse) -> JSONResponse:
    """Hand an upstream answer to the page, with failures kept distinct.

    401 stays 401 (the token is no longer valid there: re-pair). A peer that
    could not answer is 502 with its reason. Any other answer, including the
    peer's own 400/404/409, is passed through with its status and JSON body.
    """
    reason = classify(resp)
    if reason == "unauthorized":
        return _error(401, "peer refused this Studio's token; pair again", reason)
    if reason is not None:
        return _error(502, f"peer could not answer: {reason}", reason)
    data = resp.json()
    if not isinstance(data, (dict, list)):
        return _error(502, "peer answered with something other than JSON", "unexpected")
    return JSONResponse(data, status_code=resp.status or 502)


async def _peer_and_token(peer_id: str) -> tuple[Peer | None, str | None]:
    store = _get_store()
    peer = await asyncio.to_thread(store.get, peer_id)
    if peer is None:
        return None, None
    return peer, await asyncio.to_thread(store.token, peer_id)


async def _proxy(peer_id: str, method: str, path: str, body: Any = None,
                 query: dict | None = None) -> JSONResponse:
    peer, token = await _peer_and_token(peer_id)
    if peer is None:
        return _error(404, "unknown peer")
    if token is None:
        return _error(401, "no token stored for this peer; pair again", "unauthorized")
    return _relay(await _call(peer, method, path, body=body, query=query, token=token))


async def _read_json(request: Request) -> dict | None:
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - any unparseable body is the same 400
        return None
    return body if isinstance(body, dict) else None


# ---------------------------------------------------------------------------
# HTTP routes (ordinary origin-guarded /api routes; no exemption wanted)
# ---------------------------------------------------------------------------

router = APIRouter()


@router.get("/api/peers")
async def list_peers():
    peers = await asyncio.to_thread(_get_store().list)
    return {"peers": [p.public() for p in peers]}


@router.post("/api/peers")
async def add_peer(request: Request):
    body = await _read_json(request)
    if body is None:
        return _error(400, "body must be a JSON object")
    url = normalize_peer_url(body.get("url"))
    if url is None:
        return _error(400, "url must be https, or http to a loopback host, with no path")
    code = body.get("code")
    if not isinstance(code, str) or not code.strip():
        return _error(400, "code must not be empty")
    label = body.get("label")
    label = label.strip() if isinstance(label, str) and label.strip() else urllib.parse.urlsplit(url).hostname or url

    candidate = Peer(id="", label=label, url=url, added_at="")
    resp = await _call(candidate, "POST", "/pair",
                       body={"code": code.strip(), "device_name": f"{_DEFAULT_DEVICE_NAME} ({label})"[:80]})
    reason = classify(resp)
    if reason is not None:
        logger.info("Peer pairing at %s did not reach Studio: %s", urllib.parse.urlsplit(url).netloc, reason)
        return _error(502, f"peer could not be paired: {reason}", reason)
    data = resp.json()
    if resp.status == 400:
        return _error(400, "invalid or expired code")
    token = data.get("token") if isinstance(data, dict) else None
    if resp.status != 200 or not isinstance(token, str) or not token:
        return _error(502, "peer answered the pairing with an unexpected shape", "unexpected")
    device_id = data.get("device_id") if isinstance(data.get("device_id"), str) else None
    peer = await asyncio.to_thread(_get_store().add, label, url, token, device_id)
    logger.info("Paired with peer %s at %s", peer.id, urllib.parse.urlsplit(url).netloc)
    return {"peer": peer.public()}


@router.delete("/api/peers/{peer_id}")
async def delete_peer(peer_id: str):
    removed = await asyncio.to_thread(_get_store().remove, peer_id)
    if not removed:
        return _error(404, "unknown peer")
    logger.info("Forgot peer %s", peer_id)
    return {"removed": True}


@router.get("/api/peers/{peer_id}/status")
async def peer_status(peer_id: str):
    """Always 200. `reason` names why, never collapsing the three failure shapes."""
    peer, token = await _peer_and_token(peer_id)
    if peer is None:
        return {"reachable": False, "authorized": None, "reason": "unknown_peer"}
    if token is None:
        return {"reachable": None, "authorized": False, "reason": "unauthorized"}
    resp = await _call(peer, "GET", "/hello", token=token)
    reason = classify(resp)
    if reason == "unreachable":
        return {"reachable": False, "authorized": None, "reason": reason}
    if reason is not None:
        return {"reachable": True, "authorized": False if reason in ("unauthorized", "access_required") else None,
                "reason": reason}
    data = resp.json()
    if resp.status != 200 or not isinstance(data, dict):
        return {"reachable": True, "authorized": None, "reason": "unexpected"}
    return {"reachable": True, "authorized": True, "reason": None}


@router.get("/api/peers/{peer_id}/sessions")
async def peer_sessions(peer_id: str):
    return await _proxy(peer_id, "GET", "/sessions")


@router.post("/api/peers/{peer_id}/sessions")
async def peer_create_session(peer_id: str, request: Request):
    body = await _read_json(request)
    if body is None:
        return _error(400, "body must be a JSON object")
    payload = {k: body[k] for k in _CREATE_FIELDS if k in body}
    return await _proxy(peer_id, "POST", "/sessions", body=payload)


@router.delete("/api/peers/{peer_id}/sessions/{session_id}")
async def peer_close_session(peer_id: str, session_id: str):
    return await _proxy(peer_id, "DELETE", f"/sessions/{_seg(session_id)}")


@router.get("/api/peers/{peer_id}/workdirs")
async def peer_workdirs(peer_id: str):
    return await _proxy(peer_id, "GET", "/workdirs")


@router.get("/api/peers/{peer_id}/browse")
async def peer_browse(peer_id: str, path: str = ""):
    return await _proxy(peer_id, "GET", "/browse", query={"path": path})


@router.get("/api/peers/{peer_id}/catalog")
async def peer_catalog(peer_id: str):
    return await _proxy(peer_id, "GET", "/catalog")


# ---------------------------------------------------------------------------
# WebSocket bridge: the page's /ws/terminal frames <-> the peer's remote stream
# ---------------------------------------------------------------------------


def _ws_url(peer: Peer, session_id: str, after: int | None) -> str:
    scheme = "wss" if peer.url.startswith("https://") else "ws"
    url = scheme + peer.url[peer.url.index("://"):] + f"{REMOTE_PREFIX}/sessions/{_seg(session_id)}/stream"
    if after is not None:
        url += f"?after={after}"
    return url


async def send_input(peer: Peer, token: str, session_id: str, text: str,
                     request_id: str | None = None) -> bool:
    """Raw input to the peer's PTY, retried with ONE request_id.

    Only a peer that could not answer is retried. A 401 or a 4xx is an answer:
    retrying it would not change it.
    """
    request_id = request_id or secrets.token_hex(12)
    body = {"text": text, "submit": False, "request_id": request_id}
    for attempt in range(_INPUT_ATTEMPTS):
        resp = await _call(peer, "POST", f"/sessions/{_seg(session_id)}/input", body=body, token=token)
        reason = classify(resp)
        if reason is None:
            data = resp.json()
            return bool(isinstance(data, dict) and data.get("accepted"))
        if reason not in ("unreachable", "unexpected"):
            logger.warning("Peer %s refused input for %s: %s", peer.id, session_id, reason)
            return False
        if attempt + 1 < _INPUT_ATTEMPTS:
            await asyncio.sleep(_INPUT_RETRY_DELAY_S)
    logger.warning("Peer %s input for %s not delivered after %d attempts",
                   peer.id, session_id, _INPUT_ATTEMPTS)
    return False


@router.websocket("/ws/peer/{peer_id}/{session_id}")
async def websocket_peer(websocket: WebSocket, peer_id: str, session_id: str):
    """Bridge a desktop pane to a session on a peer Studio."""
    # BEFORE accept() and before the peer lookup, exactly as /ws/terminal does it.
    reason = origin_guard.check_websocket(websocket.headers.get("host", ""),
                                          websocket.headers.get("origin"))
    if reason:
        logger.warning("Refused WS /ws/peer: %s", reason)
        await websocket.close(code=_WS_REFUSAL_CODE, reason=_WS_REFUSAL_REASON)
        return
    peer, token = await _peer_and_token(peer_id)
    if peer is None or token is None:
        # Same close as a refused origin: no peer-id oracle.
        await websocket.close(code=_WS_REFUSAL_CODE, reason=_WS_REFUSAL_REASON)
        return

    raw_after = websocket.query_params.get("after")
    try:
        after = int(raw_after) if raw_after is not None else None
        if after is not None and after < 0:
            after = None
    except ValueError:
        after = None

    await websocket.accept()
    try:
        upstream = await _ws_connect(_ws_url(peer, session_id, after),
                                     {"Authorization": f"Bearer {token}"})
    except Exception as exc:  # noqa: BLE001 - any connect failure is the same outcome
        # The exception text can name the url but never the header.
        logger.warning("Peer %s stream for %s could not open: %s", peer.id, session_id,
                       type(exc).__name__)
        try:
            await websocket.close(code=1011, reason="peer unreachable")
        except Exception:  # noqa: BLE001 - the page may already be gone
            logger.debug("Page socket already closed for peer %s", peer.id, exc_info=True)
        return

    inputs: asyncio.Queue = asyncio.Queue()

    async def upstream_to_page():
        while True:
            raw = await upstream.recv()
            try:
                frame = json.loads(raw)
            except (ValueError, TypeError):
                continue
            if not isinstance(frame, dict):
                continue
            kind = frame.get("type")
            if kind == "replay_start":
                await websocket.send_json({"type": "replay_start", "reset": bool(frame.get("reset")),
                                           "truncated": bool(frame.get("truncated"))})
            elif kind in ("output", "replay_end"):
                await websocket.send_json(frame)
            elif kind == "ended":
                await websocket.send_text(_SESSION_ENDED_BANNER)
                return
            # resize (the peer's desktop owns the PTY size) and pong: not page frames.

    async def page_to_upstream():
        while True:
            msg = await websocket.receive()
            if msg.get("type") == "websocket.disconnect":
                return
            text = msg.get("text")
            if text is None and msg.get("bytes"):
                text = msg["bytes"].decode("utf-8", errors="replace")
            if not text:
                continue
            if text.startswith("{"):
                try:
                    ctrl = json.loads(text)
                except json.JSONDecodeError:
                    ctrl = None
                if isinstance(ctrl, dict) and ctrl.get("type") == "resize":
                    # Remote v1 has no resize route: the peer's own desktop owns
                    # the PTY size. Say so with the existing failure frame.
                    await websocket.send_text('{"type":"resize_failed"}')
                    continue
                if isinstance(ctrl, dict) and ctrl.get("type") == "pong":
                    continue
            inputs.put_nowait(text)

    async def drain_inputs():
        # One writer, in order: keystrokes must reach the peer in the order typed.
        while True:
            text = await inputs.get()
            await send_input(peer, token, session_id, text)

    async def heartbeat():
        while True:
            await asyncio.sleep(_HEARTBEAT_S)
            await websocket.send_text('{"type":"ping"}')
            await upstream.send('{"type":"ping"}')

    tasks = [asyncio.create_task(t()) for t in (upstream_to_page, page_to_upstream, drain_inputs, heartbeat)]
    try:
        done, _pending = await asyncio.wait(tasks[:2], return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            exc = task.exception()
            if exc is not None and not isinstance(exc, WebSocketDisconnect):
                logger.debug("Peer %s bridge for %s ended: %s", peer.id, session_id,
                             type(exc).__name__)
    finally:
        # Let typed input that already left the page reach the peer before closing.
        deadline = time.monotonic() + 2.0
        while not inputs.empty() and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            await upstream.close()
        except Exception:  # noqa: BLE001 - an already-closed upstream is fine
            logger.debug("Upstream close failed for peer %s", peer.id, exc_info=True)
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001 - the page may already be gone
            logger.debug("Page close failed for peer %s", peer.id, exc_info=True)
