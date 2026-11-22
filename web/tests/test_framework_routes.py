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
import urllib.error
import urllib.parse

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
        if url.endswith("/api/orch/runs"):
            # A framework from before the orch surface existed.
            raise urllib.error.HTTPError(url, 404, "Not Found", None, None)
        raise AssertionError(f"unexpected url {url}")

    monkeypatch.setattr(framework_client, "_get_json", fake_get_json)
    result = framework_client.fetch_summary("http://127.0.0.1:8430")
    assert result["up"] is True
    assert result["orch"] is False
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


# ---------------------------------------------------------------------------
# The orch-era framework (2026-11-22): /api/orch/runs is the probe, the old
# summary/daemon routes are shims, and /api/orch/events feeds the toasts.
# ---------------------------------------------------------------------------

BASE = "http://127.0.0.1:8430"


def _http(url, code):
    return urllib.error.HTTPError(url, code, "x", None, None)


def test_orch_framework_is_up_even_when_the_old_routes_are_gone(monkeypatch):
    def fake(url):
        if url.endswith("/api/orch/runs"):
            return {"runs": [{"run_id": "a"}, {"run_id": "b"}]}
        raise _http(url, 404)

    monkeypatch.setattr(framework_client, "_get_json", fake)
    result = framework_client.fetch_summary(BASE)
    assert result == {"up": True, "base": BASE, "orch": True, "pending_approvals": 0,
                      "running": 2, "buckets": {}}


def test_orch_framework_keeps_buckets_while_the_shims_answer(monkeypatch):
    def fake(url):
        if url.endswith("/api/orch/runs"):
            return {"runs": []}
        if url.endswith("/api/summary"):
            return {"pending_approvals": 0, "running": 0, "buckets": {}}
        return {"buckets": {"p": {"cwd": "C:/p"}}}

    monkeypatch.setattr(framework_client, "_get_json", fake)
    result = framework_client.fetch_summary(BASE)
    assert result["orch"] is True and result["running"] == 0
    assert result["buckets"] == {"p": {"cwd": "C:/p", "pending_approvals": 0}}


def test_a_wrong_shaped_orch_reply_falls_back_to_the_old_probe(monkeypatch):
    def fake(url):
        if url.endswith("/api/orch/runs"):
            return {"runs": "nope"}
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(framework_client, "_get_json", fake)
    monkeypatch.setattr(framework_client, "_unreachable_logged", set())
    assert framework_client.fetch_summary(BASE) == {"up": False, "base": BASE, "reason": "unreachable"}


def _feed(n):
    return [{"id": i, "ts": "t", "run_id": "r", "session_id": "" if i % 3 else "term-1",
             "step": "s", "ok": False, "worker": None, "rule": None, "detail": f"d{i}",
             "kind": "refusal" if i % 2 else None, "extra": "dropped"} for i in range(1, n + 1)]


def _serve(feed, calls):
    def fake(url):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        since, limit = int(q["since"][0]), int(q["limit"][0])
        calls.append((since, limit))
        page = [e for e in feed if e["id"] > since][:limit]
        return {"events": page, "cursor": page[-1]["id"] if page else since}
    return fake


def test_seeding_pages_to_the_end_and_returns_nothing_to_toast(monkeypatch):
    calls = []
    monkeypatch.setattr(framework_client, "_get_json", _serve(_feed(1200), calls))
    result = framework_client.fetch_orch_events(BASE, None)
    assert result["up"] is True and result["seeded"] is True
    assert result["events"] == [] and result["cursor"] == 1200
    assert calls == [(0, 500), (500, 500), (1000, 500), (1200, 500)]


def test_seeding_an_empty_feed_starts_at_zero(monkeypatch):
    monkeypatch.setattr(framework_client, "_get_json", _serve([], []))
    result = framework_client.fetch_orch_events(BASE, None)
    assert result["events"] == [] and result["cursor"] == 0


def test_polling_returns_only_events_with_a_kind_and_only_the_agreed_fields(monkeypatch):
    monkeypatch.setattr(framework_client, "_get_json", _serve(_feed(12), []))
    result = framework_client.fetch_orch_events(BASE, 6)
    assert [e["id"] for e in result["events"]] == [7, 9, 11]
    assert result["cursor"] == 12 and result["seeded"] is False
    assert set(result["events"][0]) == set(framework_client._ORCH_EVENT_FIELDS)
    assert result["events"][0]["session_id"] is None      # "" normalised
    assert result["events"][1]["session_id"] == "term-1"


def test_polling_an_idle_feed_keeps_the_cursor(monkeypatch):
    monkeypatch.setattr(framework_client, "_get_json", _serve(_feed(4), []))
    result = framework_client.fetch_orch_events(BASE, 4)
    assert result["events"] == [] and result["cursor"] == 4


def test_a_framework_without_the_feed_is_silence_not_an_error(monkeypatch):
    def fake(url):
        raise _http(url, 404)

    monkeypatch.setattr(framework_client, "_get_json", fake)
    assert framework_client.fetch_orch_events(BASE, 3) == {"up": False, "base": BASE, "reason": "http 404"}
    assert framework_client.fetch_orch_events("ftp://x", 3)["reason"] == "bad url"


@pytest.mark.asyncio
async def test_orch_events_route_is_always_200_and_passes_the_cursor(client, monkeypatch):
    seen = []

    def fake(base, since):
        seen.append(since)
        return {"up": False, "base": base, "reason": "unreachable"}

    monkeypatch.setattr(framework_client, "fetch_orch_events", fake)
    r1 = await client.get("/api/framework/orch-events")
    r2 = await client.get("/api/framework/orch-events?since=41")
    r3 = await client.get("/api/framework/orch-events?since=-5")
    assert (r1.status_code, r2.status_code, r3.status_code) == (200, 200, 200)
    assert r1.json()["up"] is False
    assert seen == [None, 41, 0]


# Open orch runs for the Orchestrators list and run dock.

def _live_run(**over):
    run = {
        "run_id": "orch-1", "state": "FROZEN", "task": "do it", "cwd": "C:/x", "stage": "workers",
        "loop": None, "close_status": None, "events": [{"step": "start"}],
        "orchestrator_session_id": "653b77ee", "started_at": "t0", "updated_at": "t1",
        "workers": [{"worker": "W1", "batch": 1, "lane": "sonnet", "status": "DISPATCHED",
                     "card_path": "C:/secret/card.txt"}],
        "gate": {"exit": 0, "x": 1},
    }
    run.update(over)
    return run


def test_orch_runs_keep_only_the_agreed_fields(monkeypatch):
    payload = {"runs": [_live_run(), _live_run(run_id="orch-2", orchestrator_session_id="", gate=None)],
               "studio": {"a": 1}, "prompts": []}
    monkeypatch.setattr(framework_client, "_get_json", lambda url: payload)
    result = framework_client.fetch_orch_runs(BASE)
    assert result["up"] is True and result["base"] == BASE
    first, second = result["runs"]
    assert set(first) == {"run_id", "state", "stage", "loop", "task", "cwd", "orchestrator_session_id",
                          "started_at", "updated_at", "gate_exit", "workers"}
    assert first["gate_exit"] == 0 and first["workers"] == [{"worker": "W1", "lane": "sonnet", "status": "DISPATCHED"}]
    assert second["orchestrator_session_id"] is None and second["gate_exit"] is None
    assert "studio" not in result


def test_orch_runs_failures_are_reported_not_raised(monkeypatch):
    def old(url):
        raise _http(url, 404)

    monkeypatch.setattr(framework_client, "_get_json", old)
    assert framework_client.fetch_orch_runs(BASE) == {"up": False, "base": BASE, "reason": "http 404"}
    monkeypatch.setattr(framework_client, "_get_json", lambda url: {"runs": "nope"})
    assert framework_client.fetch_orch_runs(BASE)["reason"] == "bad response"
    monkeypatch.setattr(framework_client, "_get_json", lambda url: {"runs": [_live_run(workers=[None, 3])]})
    assert framework_client.fetch_orch_runs(BASE)["runs"][0]["workers"] == []
    assert framework_client.fetch_orch_runs("ftp://x")["reason"] == "bad url"


@pytest.mark.asyncio
async def test_orch_runs_route_is_always_200(client, monkeypatch):
    monkeypatch.setattr(framework_client, "fetch_orch_runs",
                        lambda base: {"up": False, "base": base, "reason": "unreachable"})
    r = await client.get("/api/framework/orch-runs")
    assert r.status_code == 200 and r.json()["up"] is False


# ---------------------------------------------------------------------------
# Session directory: Studio tells the framework what each pane is called.
# ---------------------------------------------------------------------------

def test_session_directory_drops_bad_ids_and_caps_text():
    rows = framework_client.session_directory([
        {"id": "02a5e5ba", "name": "studio", "cwd": "C:/x", "parent_id": None},
        {"id": "bad id!", "name": "nope"},
        {"id": 7, "name": "nope"},
        {"id": "w1", "name": "n" * 300, "cwd": "c" * 900, "parent_id": "02a5e5ba"},
        {"id": "w2", "name": None, "parent_id": "not valid!"},
    ])
    assert [r["id"] for r in rows] == ["02a5e5ba", "w1", "w2"]
    assert len(rows[1]["name"]) == 100 and len(rows[1]["cwd"]) == 300
    assert rows[1]["parent_id"] == "02a5e5ba"
    assert rows[2] == {"id": "w2", "name": "", "cwd": "", "parent_id": None}


def test_session_directory_is_capped():
    rows = framework_client.session_directory([{"id": f"s{i}", "name": "x"} for i in range(700)])
    assert len(rows) == 500


def test_put_session_names_sends_the_directory(monkeypatch):
    seen = {}

    def fake_put(url, body):
        seen["url"], seen["body"] = url, body
        return {"ok": True, "known": 1}

    monkeypatch.setattr(framework_client, "_put_json", fake_put)
    result = framework_client.put_session_names(BASE, [{"id": "a1", "name": "studio", "cwd": "C:/x"}])
    assert result == {"up": True, "base": BASE, "sent": 1}
    assert seen["url"] == f"{BASE}/api/orch/studio/sessions"
    assert seen["body"] == {"sessions": [{"id": "a1", "name": "studio", "cwd": "C:/x", "parent_id": None}]}


def test_put_session_names_is_silent_on_an_older_framework(monkeypatch):
    def fake_put(url, body):
        raise _http(url, 404)

    monkeypatch.setattr(framework_client, "_put_json", fake_put)
    assert framework_client.put_session_names(BASE, [{"id": "a1"}]) == {
        "up": False, "base": BASE, "reason": "http 404"}
    assert framework_client.put_session_names("ftp://x", [])["reason"] == "bad url"


def test_framework_session_rows_carry_only_id_name_cwd_parent(monkeypatch):
    import types
    fake = types.SimpleNamespace(id="t1", name="studio", working_dir="C:/x", parent_id=None,
                                 spawn_token="secret", claude_session_id="c1")
    monkeypatch.setattr(server.pty_manager, "sessions", {"t1": fake})
    assert server._framework_session_rows() == [
        {"id": "t1", "name": "studio", "cwd": "C:/x", "parent_id": None}]
