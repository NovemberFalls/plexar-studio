"""Browser-origin guard for Studio's loopback HTTP surface.

Studio binds a TCP listener on 127.0.0.1 and authenticates none of its routes.
Loopback is NOT a trust boundary against a browser: any page the user visits can
open a connection to localhost. Two distinct attacks follow, and they need two
distinct clauses — collapsing them into one check is the defect this module
exists to avoid.

1. **Drive-by / CSRF.** A foreign page issues a CORS *simple request* (a POST with
   `text/plain` or no body — which is exactly what every `request.json()` handler
   in `server.py` accepts). The response is unreadable, but the side effect
   already happened: a process spawn, a credential overwrite, a shutdown.
   Answer: the **Origin allowlist**. A cross-origin fetch always carries `Origin`;
   a same-origin one does not, so an ABSENT Origin is allowed on HTTP.

2. **DNS rebinding.** The attacker's domain resolves to their IP, then re-resolves
   to 127.0.0.1. The browser now considers the request *same-origin*, so CORS never
   applies and the page can READ every response — session ids, workdirs, history,
   terminal output. Note that `Origin: http://evil.example` and `Host: evil.example`
   are EQUAL here, so an `Origin == Host` equality check passes this attack.
   Answer: the **loopback `Host` clause**. Whatever name the browser resolved, the
   `Host` header carries it, and it is not a loopback name.

Both clauses are required. Neither substitutes for the other.

**WebSockets are guarded by a different rule and get their own entry point.**
A WebSocket handshake is not subject to CORS at all, and a browser ALWAYS sends
`Origin` on one — same-origin included. So on `/ws/*` an absent Origin does not
mean "a legitimate script", it means "not the UI", and it is refused. The only
clients of `/ws/terminal/{id}` in existence are xterm.js in `TerminalPane.jsx`
and `PopoutTerminal.jsx`; nothing in `tests/` connects to it.

**`/shim/*` and `/v1/*` need no exemption.** They are driven by the `claude` CLI
via `ANTHROPIC_BASE_URL`, a non-browser client that sends no Origin and addresses
127.0.0.1 directly — so it satisfies both clauses without a carve-out. An
exemption would be a hole a page could aim at; there is no reason to open one.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger("cockpit.server")

# Host names that mean "this machine, reached as this machine". Anything else in
# a Host header means a name resolved to us, which is the rebinding signature.
_LOOPBACK_HOSTNAMES = {"127.0.0.1", "localhost", "::1"}

# Tauri's own webview origins. A web page cannot forge these — they are not
# HTTP(S) origins a document can be served from — so allowing them costs nothing
# and keeps a bundled-asset frontend working if `frontendDist` ever moves off the
# server's origin (see backlog/17).
_TAURI_ORIGINS = ("tauri://localhost", "https://tauri.localhost")

# The Vite dev server. Defaulted rather than hardcoded once: the dev port drifts,
# and hardcoding it means the next port change is a code change. Same escape
# hatch, and the same reason, as PLEXAR_DEV_ORIGINS.
_DEFAULT_DEV_ORIGINS = "http://localhost:5174,http://127.0.0.1:5174"


def _split_host(raw: str) -> str:
    """Return the hostname from a Host header, port and brackets removed."""
    host = (raw or "").strip()
    if not host:
        return ""
    if host.startswith("["):  # [::1]:8420
        end = host.find("]")
        return host[1:end] if end != -1 else host[1:]
    # Only strip a trailing :port — a bare IPv6 literal has many colons.
    if host.count(":") == 1:
        host = host.rsplit(":", 1)[0]
    return host.lower()


def is_loopback_host(raw: str) -> bool:
    """True if a Host header names this machine as this machine.

    An EMPTY Host is refused. HTTP/1.1 requires the header and every browser
    sends it; absent means a hand-rolled client, and the safe answer on the
    anti-rebinding clause is no.
    """
    return _split_host(raw) in _LOOPBACK_HOSTNAMES


def _normalise_origin(origin: str) -> str:
    """Fold 127.0.0.1 to localhost so the allowlist holds one string per host.

    They are different strings for the same host, and the dev pop-out depends on
    it: `PopoutTerminal.jsx` connects direct to `ws://localhost:8420` from a page
    that may have been served from either name.
    """
    return (origin or "").strip().lower().replace("//127.0.0.1", "//localhost")


def allowed_origins() -> set[str]:
    """The origins the legitimate UI is served from, normalised.

    Read at call time, not at import, so PORT and COCKPIT_DEV_ORIGINS are honoured
    by a test that sets them and by a server started on a non-default port. The
    bind port is read from the same env var `main()` reads — never hardcoded a
    second time, which is how the two drift apart.
    """
    port = os.getenv("PORT", "8420")
    origins = {f"http://localhost:{port}", f"http://127.0.0.1:{port}"}
    origins.update(_TAURI_ORIGINS)
    dev = os.getenv("COCKPIT_DEV_ORIGINS", _DEFAULT_DEV_ORIGINS)
    origins.update(part.strip() for part in dev.split(",") if part.strip())
    return {_normalise_origin(o) for o in origins}


def _host_clause_active() -> bool:
    """False when the operator deliberately bound off-loopback.

    `HOST=0.0.0.0` is an explicit choice to serve the LAN (`main()` logs a loud
    warning for it). Enforcing a loopback Host there would refuse every request
    the operator just asked for. The Origin allowlist still applies.
    """
    return os.getenv("HOST", "127.0.0.1") in _LOOPBACK_HOSTNAMES


def check_http(host: str, origin: str | None) -> str | None:
    """Guard an ordinary HTTP request. Returns a refusal reason, or None to allow.

    Absent Origin is ALLOWED here — see the module docstring, clause 1. A
    same-origin fetch omits the header, so requiring it would refuse the UI.
    """
    if _host_clause_active() and not is_loopback_host(host):
        return f"non-loopback Host: {host!r}"
    if origin is not None and _normalise_origin(origin) not in allowed_origins():
        return f"origin not allowed: {origin!r}"
    return None


def check_websocket(host: str, origin: str | None) -> str | None:
    """Guard a WebSocket handshake. Returns a refusal reason, or None to allow.

    Absent Origin is REFUSED here, unlike `check_http`. A browser always sends it
    on a handshake, so absent means the caller is not the UI. `Origin: null` (a
    sandboxed iframe, a `data:` document) is a real browser origin that is
    definitively not ours, and it fails the allowlist like any other stranger —
    it must never be treated as absent.
    """
    if _host_clause_active() and not is_loopback_host(host):
        return f"non-loopback Host: {host!r}"
    if not origin:
        return "missing Origin header"
    if _normalise_origin(origin) not in allowed_origins():
        return f"origin not allowed: {origin!r}"
    return None
