"""Local-network listener for Studio Remote: a SECOND port that serves only the
device-authenticated surface.

Studio's main listener binds 127.0.0.1 and authenticates none of its ``/api``
routes, so it can never be opened to a network: anyone on the Wi-Fi could start
a process. Until this module the only way in from another device was a tunnel
or proxy running on this machine, which needs a domain and an account. This is
the no-account path: with ``remote.enabled`` AND ``remote.lan.enabled`` a second
uvicorn server binds every interface on ``remote.lan.port`` and forwards to the
same app ONLY what :func:`origin_guard.is_origin_exempt` already names as safe
without a browser origin: ``/remote/v1/*`` (bearer-token routes, plus ``pair``)
and ``/.well-known/plexar``. Everything else is answered 404 HERE, before the
app is reached, so no ``/api`` route, no ``/ws/terminal`` and no page is ever
served on this port.

Three rules, each load-bearing:

* **The allowlist is the origin guard's own predicate**, not a second list. A
  path the guard would check for a browser origin must not exist on a port a
  browser on the network can reach.
* **Only private-range clients are served** (RFC 1918, link-local, loopback,
  CGNAT 100.64/10 for Tailscale-style overlays, IPv6 ULA). A router port-forward
  or a public interface does not turn this into an internet listener.
* **Pairing is throttled per client here.** Five wrong codes burn every
  outstanding pairing (remote_devices), and on this port any device on the
  network can send them, so one address gets four attempts per five minutes
  and must send JSON (a browser page cannot do that without a preflight this
  port never answers).
* **A bind failure is a reported state, never an exit.** uvicorn's own startup
  calls ``sys.exit(1)`` on a bind error, which here would take every session
  down, so the socket is bound by this module first and handed over.

Traffic on this port is plain HTTP: the device token crosses the local network
unencrypted. That is the trade for needing no certificate, and the Settings page
says so. The main listener, its loopback bind and its guard are unchanged.
"""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import logging
import socket
import time
from typing import Any, Callable

import origin_guard

logger = logging.getLogger("cockpit.server")

DEFAULT_PORT = 8421
_START_TIMEOUT_S = 5.0
_STOP_TIMEOUT_S = 5.0

# Spelled out rather than taken from ``ipaddress.is_private``, which also
# covers documentation, benchmarking and reserved ranges that are not a LAN.
PRIVATE_NETS = tuple(ipaddress.ip_network(n) for n in (
    "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "100.64.0.0/10",   # CGNAT, where overlay networks such as Tailscale live
    "fc00::/7",        # IPv6 unique local
))
_LOCAL_NETS = tuple(ipaddress.ip_network(n) for n in (
    "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fe80::/10",
))

_PAIR_PATH = "/remote/v1/pair"
_PAIR_WINDOW_S = 300.0
_PAIR_MAX_PER_WINDOW = 4   # one fewer than the five misses that burn a code
_PAIR_TRACKED_CLIENTS = 256


def _parse_ip(host: Any):
    if not isinstance(host, str) or not host:
        return None
    try:
        addr = ipaddress.ip_address(host.split("%", 1)[0])
    except ValueError:
        return None
    return getattr(addr, "ipv4_mapped", None) or addr


def is_private_address(host: Any) -> bool:
    """A literal address on a private network (not loopback, not link-local)."""
    addr = _parse_ip(host)
    return addr is not None and any(addr.version == n.version and addr in n for n in PRIVATE_NETS)


def client_allowed(host: Any) -> bool:
    """True when ``host`` is an address on a private or local network."""
    addr = _parse_ip(host)
    if addr is None:
        return False
    return any(addr.version == n.version and addr in n for n in PRIVATE_NETS + _LOCAL_NETS)


class _PairThrottle:
    """Pairing attempts per client address on this port. In memory, bounded."""

    def __init__(self) -> None:
        self._seen: dict[str, list[float]] = {}

    def allow(self, client: str, now: float | None = None) -> bool:
        now = time.monotonic() if now is None else now
        recent = [t for t in self._seen.get(client, ()) if now - t < _PAIR_WINDOW_S]
        if len(recent) >= _PAIR_MAX_PER_WINDOW:
            self._seen[client] = recent
            return False
        recent.append(now)
        self._seen.pop(client, None)
        self._seen[client] = recent
        while len(self._seen) > _PAIR_TRACKED_CLIENTS:
            self._seen.pop(next(iter(self._seen)))
        return True


def _is_json(scope) -> bool:
    for name, value in scope.get("headers") or ():
        if name == b"content-type":
            return value.split(b";", 1)[0].strip().lower() == b"application/json"
    return False


async def _respond(send, status: int, message: str) -> None:
    body = ('{"error":"%s"}' % message).encode()
    await send({
        "type": "http.response.start",
        "status": status,
        "headers": [(b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode())],
    })
    await send({"type": "http.response.body", "body": body})


def path_allowed(path: Any) -> bool:
    """True only for the remote surface, spelled exactly."""
    if not isinstance(path, str) or ".." in path or "//" in path or "\\" in path:
        return False
    return origin_guard.is_origin_exempt(path)


def restricted_app(app: Callable) -> Callable:
    """Wrap ``app`` so this port serves the remote surface and nothing else."""

    throttle = _PairThrottle()

    async def lan_app(scope, receive, send):
        kind = scope.get("type")
        if kind == "lifespan":
            # The main server owns the app's lifespan; running it twice would
            # start every background task twice.
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        client = scope.get("client") or (None, None)
        if (
            kind in ("http", "websocket")
            and path_allowed(scope.get("path"))
            and client_allowed(client[0])
        ):
            if kind == "http" and scope.get("path") == _PAIR_PATH and scope.get("method") == "POST":
                if not _is_json(scope):
                    await _respond(send, 415, "pairing needs a JSON body")
                    return
                if not throttle.allow(client[0]):
                    await _respond(send, 429, "too many pairing attempts; wait a few minutes")
                    return
            await app(scope, receive, send)
            return
        if kind == "http":
            await _respond(send, 404, "not found")
        elif kind == "websocket":
            # Closing before accept is a refused handshake: no socket is held.
            await send({"type": "websocket.close", "code": 1008})

    return lan_app


def lan_settings(settings: Any) -> tuple[bool, int]:
    """(wanted, port) from a settings dict. Wanted needs BOTH switches on."""
    remote = settings.get("remote") if isinstance(settings, dict) else None
    if not isinstance(remote, dict):
        return False, DEFAULT_PORT
    lan = remote.get("lan")
    if not isinstance(lan, dict):
        return False, DEFAULT_PORT
    port = lan.get("port")
    if isinstance(port, bool) or not isinstance(port, (int, float)) or not (1024 <= int(port) <= 65535):
        port = DEFAULT_PORT
    return bool(remote.get("enabled")) and bool(lan.get("enabled")), int(port)


class LanListener:
    """Owns the second server. All methods run on the app's event loop."""

    def __init__(self) -> None:
        self._app: Callable | None = None
        self._read_settings: Callable[[], dict] | None = None
        self._uvicorn_kwargs: dict = {}
        self._server = None
        self._task: asyncio.Task | None = None
        self._port: int | None = None
        self._error: str | None = None
        self._lock = asyncio.Lock()

    def configure(self, app: Callable, read_settings: Callable[[], dict], **uvicorn_kwargs) -> None:
        self._app = app
        self._read_settings = read_settings
        self._uvicorn_kwargs = uvicorn_kwargs

    def status(self) -> dict:
        """In-memory only: safe to call from a route on the loop."""
        running = bool(self._task and not self._task.done() and self._server and self._server.started)
        error = self._error
        if self._task is not None and self._task.done() and error is None:
            # serve() ended without being asked to: say so rather than look idle.
            error = "The local-network listener stopped unexpectedly. Save the Remote settings again to restart it."
        return {"running": running, "port": self._port if running else None, "error": error}

    async def reconcile(self) -> dict:
        """Make the listener match the saved settings. Never raises."""
        if self._app is None or self._read_settings is None:
            return self.status()
        async with self._lock:
            try:
                settings = await asyncio.to_thread(self._read_settings)
                wanted, port = lan_settings(settings)
                current = self.status()
                if wanted and current["running"] and current["port"] == port:
                    return current
                await self._stop()
                self._error = None
                if wanted:
                    await self._start(port)
            except Exception:  # noqa: BLE001 - a listener fault must not fail a settings save or startup
                logger.error("Local-network listener reconcile failed", exc_info=True)
                self._error = "The local-network listener could not be started. See the log."
            return self.status()

    async def stop(self) -> None:
        async with self._lock:
            await self._stop()

    async def _start(self, port: int) -> None:
        import uvicorn

        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # No SO_REUSEADDR: on Windows it lets a second process take a port
            # that is already in use, which is the opposite of what is wanted.
            sock.bind(("0.0.0.0", port))
        except OSError as exc:
            sock.close()
            self._error = f"Port {port} is not available on this computer ({exc.strerror or exc})."
            logger.warning("Local-network listener could not bind port %d: %s", port, exc)
            return
        sock.setblocking(False)

        class _Server(uvicorn.Server):
            # The main server owns SIGINT/SIGTERM; a second set of handlers
            # would swallow the first Ctrl+C.
            @contextlib.contextmanager
            def capture_signals(self):
                yield

        config = uvicorn.Config(
            restricted_app(self._app), log_config=None, lifespan="off", access_log=False,
            **self._uvicorn_kwargs,
        )
        server = _Server(config)
        task = asyncio.create_task(server.serve(sockets=[sock]))
        deadline = asyncio.get_running_loop().time() + _START_TIMEOUT_S
        while not server.started and not task.done() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.02)
        if not server.started:
            server.should_exit = True
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
            with contextlib.suppress(Exception):
                sock.close()
            self._error = f"The local-network listener did not start on port {port}."
            logger.error("Local-network listener did not start on port %d", port)
            return
        self._server, self._task, self._port = server, task, port
        logger.warning(
            "Local-network listener is serving the remote surface on 0.0.0.0:%d "
            "(device-token routes only; plain HTTP)", port,
        )

    async def _stop(self) -> None:
        server, task = self._server, self._task
        self._server = self._task = self._port = None
        if server is None or task is None:
            return
        server.should_exit = True
        try:
            await asyncio.wait_for(asyncio.shield(task), _STOP_TIMEOUT_S)
        except asyncio.TimeoutError:
            # An open remote stream holds graceful shutdown; do not wait on it.
            server.force_exit = True
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task
        except Exception:  # noqa: BLE001
            logger.error("Local-network listener ended with an error", exc_info=True)
        logger.info("Local-network listener stopped")


listener = LanListener()
