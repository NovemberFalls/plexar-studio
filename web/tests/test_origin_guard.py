"""Gate for the browser-origin guard (backlog row 16, widened to /api/*).

The arms are paired on purpose. A refusal check that refuses EVERYTHING passes
every negative arm perfectly, and that is the failure shape this program keeps
hitting — so every negative arm here has a positive twin proving the legitimate
UI still connects, and `test_allowlist_is_actually_read` proves the allowlist is
consulted rather than the guard being hardcoded-refuse-all.
"""

from __future__ import annotations

import importlib

import pytest
from httpx import ASGITransport, AsyncClient

import origin_guard
from server import app


# ── Unit: the two clauses, independently ─────────────────────────────────

@pytest.mark.parametrize(
    "host",
    ["127.0.0.1", "localhost", "127.0.0.1:8420", "localhost:8420", "[::1]:8420", "::1"],
)
def test_loopback_hosts_accepted(host):
    assert origin_guard.is_loopback_host(host)


@pytest.mark.parametrize(
    "host",
    ["evil.example", "evil.example:8420", "192.168.1.5:8420", "", "localhost.evil.com"],
)
def test_non_loopback_hosts_refused(host):
    assert not origin_guard.is_loopback_host(host)


def test_rebinding_sends_no_origin_at_all_which_is_why_the_host_clause_exists():
    """The subtle one, and the arm that caught a hole in this gate's first draft.

    Under DNS rebinding the browser believes it is same-origin — so it sends
    **no Origin header**, exactly like the legitimate UI does. The allowlist
    therefore cannot see this attack at all; `check_http` allows absent Origin by
    design. The loopback `Host` clause is the ONLY thing that refuses it.

    The first version of this test sent `Origin: http://evil.example`, which the
    allowlist rejects on its own — so deleting the Host clause reddened nothing
    and the arm was asserting a state it did not test.
    """
    assert origin_guard.check_http("evil.example", None) is not None
    assert origin_guard.check_websocket("evil.example", None) is not None
    # And the equality check row 16 warned about would have passed both of these:
    assert origin_guard.check_http("evil.example", "http://evil.example") is not None


def test_127_and_localhost_are_one_origin():
    """The pop-out depends on this: same host, two spellings."""
    allowed = origin_guard.allowed_origins()
    assert "http://localhost:8420" in allowed
    assert "http://127.0.0.1:8420" not in allowed  # folded, not duplicated
    assert origin_guard.check_http("127.0.0.1:8420", "http://127.0.0.1:8420") is None


def test_dev_popout_origin_is_allowed_by_default(monkeypatch):
    """`PopoutTerminal.jsx` connects direct to :8420 from a :5174 page.

    This is the only legitimately cross-origin caller in the codebase, and row 16
    predicted it as the arm most likely to break. It must work with no env set.
    """
    monkeypatch.delenv("COCKPIT_DEV_ORIGINS", raising=False)
    assert origin_guard.check_websocket("localhost:8420", "http://localhost:5174") is None


def test_websocket_refuses_absent_origin_but_http_allows_it():
    """The deliberate difference between the two entry points.

    A browser always sends Origin on a WS handshake, so absent means "not the UI".
    A same-origin HTTP fetch omits it, so refusing there would refuse the app.
    """
    assert origin_guard.check_websocket("127.0.0.1:8420", None) is not None
    assert origin_guard.check_http("127.0.0.1:8420", None) is None


def test_origin_null_is_refused_not_treated_as_absent():
    """A sandboxed iframe / data: document is a real origin that is not ours."""
    assert origin_guard.check_websocket("127.0.0.1:8420", "null") is not None
    assert origin_guard.check_http("127.0.0.1:8420", "null") is not None


def test_allowlist_is_actually_read(monkeypatch):
    """WATCH-TO-FAIL: prove the guard consults the list rather than refusing all.

    Without this arm, a build that refuses every request passes every negative
    arm above.
    """
    monkeypatch.setenv("COCKPIT_DEV_ORIGINS", "https://evil.example")
    assert origin_guard.check_http("127.0.0.1:8420", "https://evil.example") is None


def test_host_clause_stands_down_when_operator_binds_lan(monkeypatch):
    """HOST=0.0.0.0 is a deliberate choice; the clause must not refuse it."""
    monkeypatch.setenv("HOST", "0.0.0.0")
    assert origin_guard.check_http("192.168.1.5:8420", None) is None
    # The Origin allowlist still applies off-loopback.
    assert origin_guard.check_http("192.168.1.5:8420", "https://evil.example") is not None


def test_port_is_read_not_hardcoded_twice(monkeypatch):
    monkeypatch.setenv("PORT", "8421")
    assert "http://localhost:8421" in origin_guard.allowed_origins()


# ── Integration: the middleware over real routes ──────────────────────────

def _client(origin: str | None):
    headers = {"Origin": origin} if origin is not None else {}
    return AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://127.0.0.1:8420",
        headers=headers,
    )


@pytest.mark.asyncio
async def test_drive_by_post_is_refused_before_the_handler_runs():
    """The spawn route, reached as a CORS simple request.

    A 403 here — rather than the 200-and-a-real-spawn row 16 measured — is the
    whole point: the side effect is what CORS never prevented.
    """
    async with _client("https://evil.example") as c:
        r = await c.post(
            "/api/terminals",
            content='{"workdir":"C:\\\\","bypassPermissions":true}',
            headers={"Content-Type": "text/plain"},
        )
    assert r.status_code == 403
    assert r.json()["error"] == "forbidden"


@pytest.mark.asyncio
async def test_foreign_origin_cannot_read_a_get():
    async with _client("https://evil.example") as c:
        r = await c.get("/api/terminals")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_rebinding_host_is_refused_even_when_origin_agrees():
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://evil.example"
    ) as c:
        # No Origin header — the rebinding shape. See the unit test above.
        r = await c.get("/api/terminals")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_the_real_ui_still_works():
    """Positive twin. Without this the suite would pass on refuse-everything."""
    async with _client("http://localhost:8420") as c:
        r = await c.get("/api/version")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_same_origin_fetch_without_origin_header_still_works():
    async with _client(None) as c:
        r = await c.get("/api/version")
    assert r.status_code == 200


@pytest.mark.asyncio
async def test_the_claude_cli_path_is_not_collateral():
    """`/shim/*` is driven by the Node CLI via ANTHROPIC_BASE_URL: loopback Host,
    no Origin. It must pass the guard with no exemption carved for it — an
    exemption would be a hole a page could aim at."""
    assert origin_guard.check_http("127.0.0.1:8420", None) is None
