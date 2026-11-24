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
loopback host (a dev rig on this machine) or a private-network IP address (another
Studio's local-network listener, which is plain HTTP by design). Redirects are never followed, on HTTP or
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
import socket
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
import remote_lan

logger = logging.getLogger("cockpit.peers")

# websockets logs request headers (Authorization included) at DEBUG. Pinning its
# logger here keeps the bearer out of any sink regardless of the root level.
_upstream_ws_logger = logging.getLogger("cockpit.peers.upstream_ws")
_upstream_ws_logger.setLevel(logging.WARNING)

REMOTE_PREFIX = "/remote/v1"
_TOKEN_FIELD = "remote_peer_tokens"
# Cloudflare Access service tokens, per peer, beside the device tokens. Access
# gets a request past the tunnel and no further; the bearer is still the identity
# (same two-layer shape as plexar_client.auth_headers).
_ACCESS_FIELD = "remote_peer_access"
_USER_AGENT = "PlexarStudio-peer/1"
_HTTP_TIMEOUT = 10.0
_DEFAULT_DEVICE_NAME = "Plexar Studio"

# The page's own /ws/terminal heartbeat cadence, mirrored.
_HEARTBEAT_S = 30.0
# Input retry: the SAME request_id each time, so the peer's LRU answers a retry of
# a write that did land with duplicate:true instead of typing it twice.
_INPUT_ATTEMPTS = 3
_INPUT_RETRY_DELAY_S = 0.5

# Bounds on the page -> peer input backlog. A hung or slow peer must not let it
# grow without limit, and keystrokes are never dropped silently: past either
# bound the page is told and the socket is closed.
_INPUT_MAX_ITEMS = 512
_INPUT_MAX_BYTES = 256 * 1024
_INPUT_OVERFLOW_BANNER = ("\r\n\x1b[31m[Peer is not accepting input; disconnected rather than "
                          "drop keystrokes]\x1b[0m\r\n")
# /ws/terminal never sends more than one 64 KB coalesced replay frame (JSON
# escaping can double it); 1 MB is generous headroom and still a hard ceiling.
_MAX_UPSTREAM_FRAME = 1024 * 1024
_SESSION_ENDED_BANNER = "\r\n\x1b[33m[Session ended]\x1b[0m\r\n"
# Identical for a refused origin and an unknown peer: the caller must not be able
# to tell them apart. Starlette turns a pre-accept close into an HTTP 403 anyway.
_WS_REFUSAL_CODE = 4403
_WS_REFUSAL_REASON = "refused"

# Fields the page may pass through to the peer's POST /remote/v1/sessions.
_CREATE_FIELDS = ("workdir", "harness", "model", "permission_mode", "effort", "bypass", "name")

_LOOPBACK_HOSTS = {"localhost"}
_LABEL_MAX = 60


def local_machine_name() -> str:
    """This machine's hostname, stripped, at most 64 chars; "" if unavailable. Never raises."""
    try:
        name = socket.gethostname()
    except Exception:  # noqa: BLE001 - a hostname is a nicety, never a failure
        logger.debug("Could not read this machine's hostname", exc_info=True)
        return ""
    return name.strip()[:64] if isinstance(name, str) else ""


def _device_name() -> str:
    """The name the HOST stores for this Studio: this machine, never the peer's label."""
    host = local_machine_name()
    return f"{_DEFAULT_DEVICE_NAME} ({host})"[:80] if host else _DEFAULT_DEVICE_NAME


_RESIZE_MAX_COLS = 1000
_RESIZE_MAX_ROWS = 500


def _clean_label(raw: Any) -> str | None:
    """A peer label: 1..60 chars after trimming, or None when refused."""
    if not isinstance(raw, str):
        return None
    # Printable only: a peer supplies this through machine_name too.
    text = "".join(ch for ch in raw if ch.isprintable()).strip()
    return text if 0 < len(text) <= _LABEL_MAX else None


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


def _is_private_ip(host: str) -> bool:
    """A literal address on a private network. Never a name: a
    name cannot be judged without resolving it, and what it resolves to can change."""
    # The same ranges the other Studio's listener serves, minus link-local:
    # 169.254.169.254 is a cloud metadata address, not a machine to pair with.
    return remote_lan.is_private_address(host)


def normalize_peer_url(raw: Any) -> str | None:
    """The peer's base url (`scheme://host[:port]`), or None when refused.

    https to any host; http only to a loopback host or a private-network IP
    address (another Studio's local-network listener). No credentials, query,
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
    if scheme == "http" and not (_is_loopback(host) or _is_private_ip(host)):
        return None
    shown = f"[{host}]" if ":" in host else host
    return f"{scheme}://{shown}" + (f":{port}" if port is not None else "")


def bad_segment(value: Any) -> bool:
    """True for an id that must never become a path segment: empty, `.`, `..`."""
    return not isinstance(value, str) or value.strip() in ("", ".", "..")


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


def _default_update_secrets(mutate: Callable[[dict], Any]) -> dict:
    """Read-modify-write config.json under settings_store's ONE config lock."""
    import settings_store

    return settings_store.update_config(mutate)


@dataclass
class Peer:
    id: str
    label: str
    url: str
    added_at: str
    device_id: str | None = None

    def public(self, access_token_set: bool = False) -> dict:
        """The ONLY shape a route returns. No token, no device id, no Access secret."""
        return {"id": self.id, "label": self.label, "url": self.url, "added_at": self.added_at,
                "access_token_set": bool(access_token_set)}


class PeerStore:
    """Peer metadata on disk plus tokens in the secrets file. Thread-safe.

    Blocking: every method does file I/O, so routes call it via asyncio.to_thread.
    """

    def __init__(
        self,
        meta_path: Path | None = None,
        read_secrets: Callable[[], dict] | None = None,
        update_secrets: Callable[[Callable[[dict], Any]], dict] | None = None,
    ) -> None:
        self._meta_path = meta_path
        self._read_secrets = read_secrets or _default_read_secrets
        # Never a plain write: config.json is shared with the tunnel, provider and
        # harness keys, and only update_config serialises their read-modify-writes.
        self._update_secrets = update_secrets or _default_update_secrets
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

    def access(self, peer_id: str) -> tuple[str, str] | None:
        """The peer's (CF client id, secret), or None. Both or neither, always."""
        with self._lock:
            entries = self._read_secrets().get(_ACCESS_FIELD)
        entry = entries.get(peer_id) if isinstance(entries, dict) else None
        if not isinstance(entry, dict):
            return None
        cid, secret = entry.get("client_id"), entry.get("client_secret")
        if isinstance(cid, str) and cid and isinstance(secret, str) and secret:
            return cid, secret
        return None

    @staticmethod
    def _put_access(data: dict, peer_id: str, access: tuple[str, str] | None) -> None:
        entries = data.get(_ACCESS_FIELD)
        entries = dict(entries) if isinstance(entries, dict) else {}
        if access is None:
            entries.pop(peer_id, None)
        else:
            entries[peer_id] = {"client_id": access[0], "client_secret": access[1]}
        data[_ACCESS_FIELD] = entries

    def set_access(self, peer_id: str, access: tuple[str, str] | None) -> bool:
        """Set or clear (None) a peer's Access service token. False for an unknown peer."""
        if self.get(peer_id) is None:
            return False
        with self._lock:
            self._update_secrets(lambda data: self._put_access(data, peer_id, access))
        return True

    def add(self, label: str, url: str, token: str, device_id: str | None,
            access: tuple[str, str] | None = None) -> Peer:
        peer = Peer(id=uuid.uuid4().hex[:12], label=label, url=url, added_at=_now_iso(),
                    device_id=device_id)
        with self._lock:
            # Token first: a crash between the two writes leaves an orphan secret
            # (harmless, nothing lists it) rather than a listed peer with no token.
            def put(data: dict) -> None:
                tokens = data.get(_TOKEN_FIELD)
                tokens = dict(tokens) if isinstance(tokens, dict) else {}
                tokens[peer.id] = token
                data[_TOKEN_FIELD] = tokens
                if access is not None:
                    self._put_access(data, peer.id, access)

            self._update_secrets(put)
            rows = self._read_meta()
            rows.append({"id": peer.id, "label": peer.label, "url": peer.url,
                         "added_at": peer.added_at, "device_id": peer.device_id})
            self._write_meta(rows)
        return peer

    def rename(self, peer_id: str, label: str) -> bool:
        """Replace a peer's label. False for an unknown peer."""
        with self._lock:
            rows = self._read_meta()
            found = False
            for row in rows:
                if row.get("id") == peer_id:
                    row["label"] = label
                    found = True
            if found:
                self._write_meta(rows)
        return found

    def remove(self, peer_id: str) -> bool:
        with self._lock:
            rows = self._read_meta()
            kept = [r for r in rows if r.get("id") != peer_id]
            found = len(kept) != len(rows)
            if found:
                self._write_meta(kept)
            dropped = []

            def drop(data: dict) -> None:
                for field in (_TOKEN_FIELD, _ACCESS_FIELD):
                    entries = data.get(field)
                    if isinstance(entries, dict) and peer_id in entries:
                        entries = dict(entries)
                        entries.pop(peer_id, None)
                        data[field] = entries
                        dropped.append(field)

            self._update_secrets(drop)
        return found or bool(dropped)


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
    """Blocking HTTP call, redirects NOT followed. Runs in a worker thread.

    `ProxyHandler({})`: no system or environment proxy, matching the WS path's
    `proxy=None`. A proxy would see the bearer and the Access secret.
    """
    opener = urllib.request.build_opener(_NoRedirect, urllib.request.ProxyHandler({}))
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
        max_size=_MAX_UPSTREAM_FRAME,
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


def classify(resp: UpstreamResponse, access_set: bool = False) -> str | None:
    """None for a usable answer, else the reason the peer could not serve it.

    `unreachable`, `access_required` and `unauthorized` are the three that must
    never collapse; `access_refused` (a service token Access rejected) is a
    fourth. `remote_disabled` and `unexpected` are named too, rather than
    folded into one of those three and sending the user to the wrong fix.
    """
    if resp.status is None:
        return "unreachable"
    # Studio never answers 403 on /remote/v1 (the path is origin-exempt), so with a
    # service token presented a 403 is Access refusing THAT token. Without one, a
    # challenge still reads as access_required below.
    if access_set and resp.status == 403:
        return "access_refused"
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


def access_headers(access: tuple[str, str] | None) -> dict:
    """Cloudflare Access service-token headers, or none. Never half a token."""
    if not access:
        return {}
    return {"CF-Access-Client-Id": access[0], "CF-Access-Client-Secret": access[1]}


def parse_access(body: dict) -> tuple[bool, tuple[str, str] | None]:
    """(ok, value) from `cf_client_id` / `cf_client_secret`. Half a token is not ok.

    Absent, null or empty on BOTH means none. A CR or LF would split a header.
    """
    cid, secret = body.get("cf_client_id"), body.get("cf_client_secret")
    present = [v not in (None, "") for v in (cid, secret)]
    if not any(present):
        return True, None
    if not all(present) or not isinstance(cid, str) or not isinstance(secret, str):
        return False, None
    cid, secret = cid.strip(), secret.strip()
    if not cid or not secret or any(ch in v for v in (cid, secret) for ch in "\r\n"):
        return False, None
    return True, (cid, secret)


async def _call(peer: Peer, method: str, path: str, body: Any = None,
                query: dict | None = None, token: str | None = None,
                access: tuple[str, str] | None = None) -> UpstreamResponse:
    """One request to `<peer.url>/remote/v1<path>`, off the loop."""
    url = peer.url + REMOTE_PREFIX + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = {"User-Agent": _USER_AGENT, "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    headers.update(access_headers(access))
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


def _relay(resp: UpstreamResponse, access_set: bool = False) -> JSONResponse:
    """Hand an upstream answer to the page, with failures kept distinct.

    401 stays 401 (the token is no longer valid there: re-pair). A peer that
    could not answer is 502 with its reason. Any other answer, including the
    peer's own 400/404/409, is passed through with its status and JSON body.
    """
    reason = classify(resp, access_set)
    if reason == "unauthorized":
        return _error(401, "peer refused this Studio's token; pair again", reason)
    if reason is not None:
        return _error(502, f"peer could not answer: {reason}", reason)
    data = resp.json()
    if not isinstance(data, (dict, list)):
        return _error(502, "peer answered with something other than JSON", "unexpected")
    return JSONResponse(data, status_code=resp.status or 502)


async def _peer_and_token(peer_id: str) -> tuple[Peer | None, str | None, tuple[str, str] | None]:
    if bad_segment(peer_id):
        return None, None, None
    store = _get_store()
    peer = await asyncio.to_thread(store.get, peer_id)
    if peer is None:
        return None, None, None
    token = await asyncio.to_thread(store.token, peer_id)
    return peer, token, await asyncio.to_thread(store.access, peer_id)


async def _proxy(peer_id: str, method: str, path: str, body: Any = None,
                 query: dict | None = None) -> JSONResponse:
    peer, token, access = await _peer_and_token(peer_id)
    if peer is None:
        return _error(404, "unknown peer")
    if token is None:
        return _error(401, "no token stored for this peer; pair again", "unauthorized")
    resp = await _call(peer, method, path, body=body, query=query, token=token, access=access)
    return _relay(resp, access is not None)


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
    store = _get_store()

    def rows() -> list[dict]:
        return [p.public(store.access(p.id) is not None) for p in store.list()]

    return {"peers": await asyncio.to_thread(rows)}


@router.post("/api/peers")
async def add_peer(request: Request):
    body = await _read_json(request)
    if body is None:
        return _error(400, "body must be a JSON object")
    url = normalize_peer_url(body.get("url"))
    if url is None:
        return _error(400, "url must be https, or http to a loopback or private-network address, with no path")
    code = body.get("code")
    if not isinstance(code, str) or not code.strip():
        return _error(400, "code must not be empty")
    ok, access = parse_access(body)
    if not ok:
        return _error(400, "cf_client_id and cf_client_secret must be given together")
    label = body.get("label")
    label = label.strip() if isinstance(label, str) else ""

    candidate = Peer(id="", label=label, url=url, added_at="")
    # The device name is THIS machine's, never built from the label (which names the peer).
    resp = await _call(candidate, "POST", "/pair",
                       body={"code": code.strip(), "device_name": _device_name()},
                       access=access)
    reason = classify(resp, access is not None)
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
    if not label:
        machine = data.get("machine_name")
        machine = machine.strip()[:_LABEL_MAX] if isinstance(machine, str) else ""
        label = machine or urllib.parse.urlsplit(url).hostname or url
    peer = await asyncio.to_thread(_get_store().add, label, url, token, device_id, access)
    logger.info("Paired with peer %s at %s", peer.id, urllib.parse.urlsplit(url).netloc)
    return {"peer": peer.public(access is not None)}


@router.put("/api/peers/{peer_id}/access")
async def put_peer_access(peer_id: str, request: Request):
    """Set (both fields) or clear (neither) the peer's Access service token."""
    body = await _read_json(request)
    if body is None:
        return _error(400, "body must be a JSON object")
    ok, access = parse_access(body)
    if not ok:
        return _error(400, "cf_client_id and cf_client_secret must be given together")
    store = _get_store()
    if not await asyncio.to_thread(store.set_access, peer_id, access):
        return _error(404, "unknown peer")
    peer = await asyncio.to_thread(store.get, peer_id)
    logger.info("Access service token %s for peer %s", "set" if access else "cleared", peer_id)
    return {"peer": peer.public(access is not None)}


@router.put("/api/peers/{peer_id}")
async def rename_peer(peer_id: str, request: Request):
    """Rename a peer: body {"label": "<1..60 chars after trim>"}."""
    body = await _read_json(request)
    if body is None:
        return _error(400, "body must be a JSON object")
    label = _clean_label(body.get("label"))
    if label is None:
        return _error(400, f"label must be 1 to {_LABEL_MAX} characters")
    store = _get_store()
    if bad_segment(peer_id) or not await asyncio.to_thread(store.rename, peer_id, label):
        return _error(404, "unknown peer")
    peer = await asyncio.to_thread(store.get, peer_id)
    access_set = await asyncio.to_thread(store.access, peer_id) is not None
    logger.info("Renamed peer %s", peer_id)
    return {"peer": peer.public(access_set)}


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
    peer, token, access = await _peer_and_token(peer_id)
    if peer is None:
        return {"reachable": False, "authorized": None, "reason": "unknown_peer"}
    if token is None:
        return {"reachable": None, "authorized": False, "reason": "unauthorized"}
    resp = await _call(peer, "GET", "/hello", token=token, access=access)
    reason = classify(resp, access is not None)
    if reason == "unreachable":
        return {"reachable": False, "authorized": None, "reason": reason}
    if reason is not None:
        return {"reachable": True, "authorized": False if reason in ("unauthorized", "access_required", "access_refused")
                else None,
                "reason": reason}
    data = resp.json()
    if resp.status != 200 or not isinstance(data, dict):
        return {"reachable": True, "authorized": None, "reason": "unexpected"}
    machine = data.get("machine_name")
    machine = machine.strip()[:_LABEL_MAX] if isinstance(machine, str) else ""
    relabelled = False
    if machine and _named_after_this_machine(peer.label, machine):
        # Paired before the host named itself, the label was built from the wrong
        # computer. Fix it once; through the store, under its lock, off the loop.
        relabelled = await asyncio.to_thread(_get_store().rename, peer.id, machine)
        if relabelled:
            logger.info("Relabelled peer %s with the name it reports", peer.id)
    return {"reachable": True, "authorized": True, "reason": None,
            "machine_name": machine or None, "relabelled": relabelled}


def _named_after_this_machine(label: str, machine: str) -> bool:
    """True when the stored label is THIS machine's hostname and the peer's differs.

    Compared on letters and digits only: a label typed by hand as "Studio Laptop"
    is still the hostname "Studio-Laptop".
    """
    def key(text: str) -> str:
        return "".join(ch for ch in text.casefold() if ch.isalnum())

    here = key(local_machine_name())
    return bool(here) and key(label) == here and key(machine) != here


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
    if bad_segment(session_id):
        return _error(404, "unknown session")
    return await _proxy(peer_id, "DELETE", f"/sessions/{_seg(session_id)}")


@router.get("/api/peers/{peer_id}/subagents")
async def peer_subagents(peer_id: str):
    return await _proxy(peer_id, "GET", "/subagents")


@router.get("/api/peers/{peer_id}/sessions/{session_id}/subagents/{agent_id}")
async def peer_subagent_report(peer_id: str, session_id: str, agent_id: str):
    if bad_segment(session_id) or bad_segment(agent_id):
        return _error(404, "unknown agent")
    return await _proxy(peer_id, "GET", f"/sessions/{_seg(session_id)}/subagents/{_seg(agent_id)}")


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
                     request_id: str | None = None,
                     access: tuple[str, str] | None = None) -> bool:
    """Raw input to the peer's PTY, retried with ONE request_id.

    Only a peer that could not answer is retried. A 401 or a 4xx is an answer:
    retrying it would not change it.
    """
    request_id = request_id or secrets.token_hex(12)
    body = {"text": text, "submit": False, "request_id": request_id}
    for attempt in range(_INPUT_ATTEMPTS):
        resp = await _call(peer, "POST", f"/sessions/{_seg(session_id)}/input", body=body,
                           token=token, access=access)
        reason = classify(resp, access is not None)
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


async def send_resize(peer: Peer, token: str, session_id: str, cols: Any, rows: Any,
                      access: tuple[str, str] | None = None) -> bool:
    """POST the peer's `/sessions/{id}/resize`. False on anything but resized:true.

    A Studio older than that route answers 404, which lands here as False and the
    pane keeps its old behaviour (resize_failed, the peer's desktop owns the size).
    """
    resp = await _call(peer, "POST", f"/sessions/{_seg(session_id)}/resize",
                       body={"cols": cols, "rows": rows}, token=token, access=access)
    if classify(resp, access is not None) is not None or resp.status != 200:
        logger.debug("Peer %s resize for %s not applied (status %s)", peer.id, session_id, resp.status)
        return False
    data = resp.json()
    return bool(isinstance(data, dict) and data.get("resized"))


def _seq(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def page_frame(raw: Any) -> tuple[str, Any]:
    """Validate one upstream frame. Returns (verdict, payload).

    `send` with the frame to relay (resize included: every xterm showing a PTY
    takes the PTY's size), `ended`, `skip` for a known frame the page does not
    take (pong), or `bad` with a reason that names the shape,
    never the content.
    """
    if not isinstance(raw, str):
        return "bad", "not text"
    if len(raw) > _MAX_UPSTREAM_FRAME:
        return "bad", "oversize"
    try:
        frame = json.loads(raw)
    except (ValueError, TypeError):
        return "bad", "not JSON"
    if not isinstance(frame, dict):
        return "bad", "not an object"
    kind = frame.get("type")
    if kind == "replay_start":
        reset, truncated = frame.get("reset", False), frame.get("truncated", False)
        if not isinstance(reset, bool) or not isinstance(truncated, bool):
            return "bad", "replay_start fields"
        return "send", {"type": "replay_start", "reset": reset, "truncated": truncated}
    if kind == "output":
        if not _seq(frame.get("seq")) or not isinstance(frame.get("data"), str):
            return "bad", "output fields"
        return "send", {"type": "output", "seq": frame["seq"], "data": frame["data"]}
    if kind == "replay_end":
        if not _seq(frame.get("seq")):
            return "bad", "replay_end fields"
        return "send", {"type": "replay_end", "seq": frame["seq"]}
    if kind == "ended":
        return "ended", None
    if kind == "resize":
        if not _seq(frame.get("cols")) or not _seq(frame.get("rows")):
            return "bad", "resize fields"
        # The page hands these to xterm: a size no terminal has is dropped here,
        # not relayed (a hostile peer could otherwise freeze the viewer's page).
        if not (1 <= frame["cols"] <= _RESIZE_MAX_COLS and 1 <= frame["rows"] <= _RESIZE_MAX_ROWS):
            return "skip", None
        return "send", {"type": "resize", "cols": frame["cols"], "rows": frame["rows"]}
    if kind == "pong":
        return "skip", None
    return "bad", "unknown type"


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
    peer, token, access = await _peer_and_token(peer_id)
    if peer is None or token is None or bad_segment(session_id):
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
                                     {"Authorization": f"Bearer {token}", **access_headers(access)})
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
    pending_bytes = 0
    close_with = [1000, ""]

    async def upstream_to_page():
        while True:
            verdict, payload = page_frame(await upstream.recv())
            if verdict == "send":
                await websocket.send_json(payload)
            elif verdict == "ended":
                await websocket.send_text(_SESSION_ENDED_BANNER)
                return
            elif verdict == "bad":
                logger.warning("Peer %s sent an invalid frame for %s (%s); closing",
                               peer.id, session_id, payload)
                close_with[:] = [1011, "peer sent an invalid frame"]
                return
            # skip: pong.

    async def enqueue(item: tuple, size: int) -> bool:
        nonlocal pending_bytes
        if inputs.qsize() >= _INPUT_MAX_ITEMS or pending_bytes + size > _INPUT_MAX_BYTES:
            logger.warning("Peer %s input backlog full for %s (%d items, %d bytes); closing",
                           peer.id, session_id, inputs.qsize(), pending_bytes)
            await websocket.send_text(_INPUT_OVERFLOW_BANNER)
            close_with[:] = [1013, "input backlog full"]
            return False
        pending_bytes += size
        inputs.put_nowait((item, size))
        return True

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
                    # Queued with the input so it lands in order with keystrokes.
                    if not await enqueue(("resize", ctrl.get("cols"), ctrl.get("rows")), 64):
                        return
                    continue
                if isinstance(ctrl, dict) and ctrl.get("type") == "pong":
                    continue
            if not await enqueue(("input", text), len(text.encode("utf-8"))):
                return

    async def drain_inputs():
        # One writer, in order: keystrokes must reach the peer in the order typed.
        # One writer also means at most ONE worker thread per socket, each call
        # bounded by _HTTP_TIMEOUT and each item by _INPUT_ATTEMPTS of them.
        nonlocal pending_bytes
        while True:
            item, size = await inputs.get()
            pending_bytes -= size
            if item[0] == "input":
                await send_input(peer, token, session_id, item[1], access=access)
            elif not await send_resize(peer, token, session_id, item[1], item[2], access=access):
                # An older peer without the route (404), a refused size or a
                # failed call: the desktop's own failure frame, as before.
                await websocket.send_text('{"type":"resize_failed"}')

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
            await websocket.close(code=close_with[0], reason=close_with[1])
        except Exception:  # noqa: BLE001 - the page may already be gone
            logger.debug("Page close failed for peer %s", peer.id, exc_info=True)
