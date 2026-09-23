"""Studio's read-only server-side reads of Plexar-Framework.

The framework sends no CORS headers, so Studio's frontend cannot read its
JSON directly (HANDOFF-studio-framework-pilot.md §3.3); `/api/framework/summary`
and `/api/framework/events` do those reads server-side instead. Both routes
are ALWAYS 200 -- a framework that is down, misconfigured, or answering
garbage must never turn into a 5xx from Studio, because this feeds a rail
badge and a toast poll that must not blank the UI.

These tests stub `framework_client._get_json` (the one blocking urllib call)
rather than hitting a real socket, and drive the FastAPI routes through
`httpx.AsyncClient` + `ASGITransport` the same way `test_event_loop_hygiene.py`
does, so the async-route contract (no blocking call on the loop) is exercised
end to end.
"""

from __future__ import annotations

import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config  # noqa: E402
logging_config.setup("WARNING")

import framework_client  # noqa: E402
import server  # noqa: E402
import settings_store  # noqa: E402


@pytest.fixture
def client():
    transport = ASGITransport(app=server.app)
    # Loopback base_url: the origin guard's anti-rebinding clause 403s a
    # non-loopback Host on every route.
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


# ---------------------------------------------------------------------------
# framework_client unit tests (no server involved)
# ---------------------------------------------------------------------------

def test_bad_url_never_reaches_the_network(monkeypatch):
    def boom(_url):
        raise AssertionError("must not attempt a network call for a bad url")

    monkeypatch.setattr(framework_client, "_get_json", boom)
    result = framework_client.fetch_summary("not-a-url")
    assert result == {"up": False, "base": "not-a-url", "reason": "bad url"}


def test_bad_url_rejects_non_http_scheme(monkeypatch):
    def boom(_url):
        raise AssertionError("must not attempt a network call for a bad scheme")

    monkeypatch.setattr(framework_client, "_get_json", boom)
    result = framework_client.fetch_summary("ftp://127.0.0.1:8430")
    assert result["up"] is False
    assert result["reason"] == "bad url"


def test_summary_up_merges_daemon_cwd_into_buckets(monkeypatch):
    def fake_get_json(url):
        if url.endswith("/api/summary"):
            return {
                "pending_approvals": 1,
                "running": 1,
                "buckets": {"pilot": {"counts": {"held": 1}, "pending_approvals": 1}},
            }
        if url.endswith("/api/daemon"):
            return {
                "config": {},
                "buckets": {"pilot": {"cwd": "C:\\Code\\Personal\\plexar-pilot", "runnable": True, "why_not": None}},
            }
        raise AssertionError(f"unexpected url {url}")

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_summary("http://127.0.0.1:8430")
    assert result["up"] is True
    assert result["base"] == "http://127.0.0.1:8430"
    assert result["pending_approvals"] == 1
    assert result["running"] == 1
    assert result["buckets"] == {
        "pilot": {"cwd": "C:\\Code\\Personal\\plexar-pilot", "pending_approvals": 1}
    }


def test_summary_down_on_connection_failure(monkeypatch):
    import urllib.error

    def fake_get_json(_url):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_summary("http://127.0.0.1:8430")
    assert result == {"up": False, "base": "http://127.0.0.1:8430", "reason": "unreachable"}


def test_summary_down_on_http_error_is_never_raised(monkeypatch):
    """HTTPError is a URLError subclass -- must be caught by its own arm, not
    fall through unhandled."""
    import io
    import urllib.error

    def fake_get_json(_url):
        raise urllib.error.HTTPError("http://x", 500, "boom", {}, io.BytesIO(b""))

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_summary("http://127.0.0.1:8430")
    assert result["up"] is False
    assert result["reason"] == "http 500"


def test_summary_down_on_bad_json_shape(monkeypatch):
    def fake_get_json(_url):
        return {"pending_approvals": "not-a-number-and-not-coercible"}

    def raiser(_url):
        raise ValueError("boom")

    monkeypatch.setattr(framework_client, "_get_json", raiser)
    result = framework_client.fetch_summary("http://127.0.0.1:8430")
    assert result["up"] is False
    assert result["reason"] == "bad response"


def test_events_empty_session_id_normalises_to_null(monkeypatch):
    def fake_get_json(_url):
        return {
            "events": [
                {"task_id": "T-1", "bucket": "pilot", "to": "done", "gate_exit": 0,
                 "branch": "plexar/T-1", "session_id": ""},
            ],
            "cursor": "c1",
        }

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_events("http://127.0.0.1:8430", None)
    assert result["up"] is True
    assert result["events"][0]["session_id"] is None
    assert result["cursor"] == "c1"


def test_events_paginates_until_short_page(monkeypatch):
    """A full page (== limit) means "there may be more"; loop again with the
    new cursor until a short page or the page cap."""
    calls = []

    def fake_get_json(url):
        calls.append(url)
        page_no = len(calls)
        if page_no == 1:
            events = [{"task_id": f"T-{i}", "bucket": "pilot", "to": "done",
                       "gate_exit": 0, "branch": "b", "session_id": None}
                      for i in range(framework_client._EVENTS_LIMIT)]
            return {"events": events, "cursor": "page2"}
        # second page short -> stop
        return {"events": [{"task_id": "T-last", "bucket": "pilot", "to": "done",
                             "gate_exit": 0, "branch": "b", "session_id": None}],
                "cursor": "page2-final"}

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_events("http://127.0.0.1:8430", None)
    assert result["up"] is True
    assert len(result["events"]) == framework_client._EVENTS_LIMIT + 1
    assert len(calls) == 2
    assert result["cursor"] == "page2-final"


def test_events_pagination_caps_at_max_pages(monkeypatch):
    """A framework that always returns a full page must not loop forever."""
    calls = []

    def fake_get_json(url):
        calls.append(url)
        events = [{"task_id": f"T-{len(calls)}-{i}", "bucket": "pilot", "to": "done",
                   "gate_exit": 0, "branch": "b", "session_id": None}
                  for i in range(framework_client._EVENTS_LIMIT)]
        return {"events": events, "cursor": f"cursor-{len(calls)}"}

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_events("http://127.0.0.1:8430", None)
    assert result["up"] is True
    assert len(calls) == framework_client._MAX_PAGES


def test_events_down_on_connection_failure(monkeypatch):
    import urllib.error

    def fake_get_json(_url):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_events("http://127.0.0.1:8430", None)
    assert result == {"up": False, "base": "http://127.0.0.1:8430", "reason": "unreachable"}


# ---------------------------------------------------------------------------
# Server routes: always 200, read settings.json, never a 5xx
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_summary_route_always_200_when_framework_down(client, monkeypatch):
    """Nothing listening on this port -- the route must still answer 200 with
    up:false, never a 5xx. Uses a deliberately-unreachable port rather than
    the default 8430, which may have a real framework daemon running
    alongside this suite on a dev machine."""
    monkeypatch.setattr(server.settings_store, "read_settings",
                         lambda: {"framework": {"url": "http://127.0.0.1:8431"}})
    res = await client.get("/api/framework/summary")
    assert res.status_code == 200
    body = res.json()
    assert body["up"] is False
    assert body["base"] == "http://127.0.0.1:8431"
    assert "reason" in body


@pytest.mark.asyncio
async def test_summary_route_reads_configured_url(client, monkeypatch):
    seen = {}

    def fake_fetch_summary(base):
        seen["base"] = base
        return {"up": True, "base": base, "pending_approvals": 0, "running": 0, "buckets": {}}

    monkeypatch.setattr(server.settings_store, "read_settings",
                         lambda: {"framework": {"url": "http://127.0.0.1:9999"}})
    monkeypatch.setattr(server.framework_client, "fetch_summary", fake_fetch_summary)
    res = await client.get("/api/framework/summary")
    assert res.status_code == 200
    assert res.json() == {"up": True, "base": "http://127.0.0.1:9999", "pending_approvals": 0,
                           "running": 0, "buckets": {}}
    assert seen["base"] == "http://127.0.0.1:9999"


@pytest.mark.asyncio
async def test_summary_route_bad_url_is_200_not_500(client, monkeypatch):
    monkeypatch.setattr(server.settings_store, "read_settings",
                         lambda: {"framework": {"url": "not-a-url"}})
    res = await client.get("/api/framework/summary")
    assert res.status_code == 200
    body = res.json()
    assert body["up"] is False
    assert body["reason"] == "bad url"


@pytest.mark.asyncio
async def test_events_route_always_200_when_framework_down(client, monkeypatch):
    monkeypatch.setattr(server.settings_store, "read_settings",
                         lambda: {"framework": {"url": "http://127.0.0.1:8431"}})
    res = await client.get("/api/framework/events")
    assert res.status_code == 200
    body = res.json()
    assert body["up"] is False


@pytest.mark.asyncio
async def test_events_route_passes_since_cursor_through(client, monkeypatch):
    seen = {}

    def fake_fetch_events(base, since):
        seen["base"] = base
        seen["since"] = since
        return {"up": True, "base": base, "events": [], "cursor": since or ""}

    monkeypatch.setattr(server.settings_store, "read_settings",
                         lambda: {"framework": {"url": "http://127.0.0.1:8430"}})
    monkeypatch.setattr(server.framework_client, "fetch_events", fake_fetch_events)
    res = await client.get("/api/framework/events", params={"since": "cursor-abc"})
    assert res.status_code == 200
    assert seen["since"] == "cursor-abc"


@pytest.mark.asyncio
async def test_events_route_default_settings_key_present():
    """DEFAULT_SETTINGS carries `framework.url` beside `chat`, so a fresh
    install without any settings.json still has a value to read."""
    assert settings_store.DEFAULT_SETTINGS["framework"] == {"url": "http://127.0.0.1:8430"}


def test_unreachable_is_logged_once_until_it_answers(monkeypatch):
    import framework_client as fc
    fc._unreachable_logged.clear()
    import urllib.error
    monkeypatch.setattr(fc, "_get_json", lambda url: (_ for _ in ()).throw(urllib.error.URLError("timed out")))
    # cockpit.* loggers do not propagate to root (logging_config), so count calls directly.
    seen = []
    monkeypatch.setattr(fc.logger, "info", lambda msg, *a, **k: seen.append(msg % a))
    for _ in range(5):
        assert fc.fetch_summary("http://127.0.0.1:8430")["up"] is False
    assert sum("unreachable" in m for m in seen) == 1
