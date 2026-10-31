"""Standing-agent support in agent_api.py: peers sees everything, adopt and
self-refresh need the user's approval, clear is confirmed, events push transitions.

Same doubles as test_agent_spawn: no CLI is launched.
"""
# ruff: noqa: F811  -- `world` is the shared fixture imported below, used as a parameter
from __future__ import annotations

import asyncio

import pytest

import agent_api
from server import pty_manager
from tests.test_agent_spawn import _client, _h, _session, world  # noqa: F401


@pytest.fixture(autouse=True)
def _fresh_tables(monkeypatch):
    monkeypatch.setattr(agent_api, "_approvals", {})
    monkeypatch.setattr(agent_api, "_event_state", {})
    monkeypatch.setattr(agent_api, "_CLEAR_CONFIRM_S", 0.2)
    monkeypatch.setattr(agent_api, "_POLL_S", 0.01)


def _worker_of(parent, sid, name, **kw):
    pty_manager.sessions[sid] = _session(sid, parent_id=parent, token=f"tok-{sid}", name=name, **kw)
    return pty_manager.sessions[sid]


async def _answer(c, aid, approve):
    return await c.post(f"/api/agent-approvals/{aid}", json={"approve": approve})


@pytest.mark.asyncio
async def test_peers_list_another_sessions_workers_with_their_parent(world):
    _worker_of("p2", "w9", "FW-World")
    async with _client() as c:
        peers = (await c.get("/api/agent/peers", headers=_h("tok-p1"))).json()["peers"]
    fw = next(p for p in peers if p["id"] == "w9")
    assert fw["parent_id"] == "p2" and fw["parent_name"] == "Other" and not fw["orphaned"]


@pytest.mark.asyncio
async def test_adopt_waits_for_the_user_then_reparents(world):
    _worker_of("p2", "w9", "FW-World")
    async with _client() as c:
        r = await c.post("/api/agent/adopt", json={"peer": "FW-World"}, headers=_h("tok-p1"))
        assert r.status_code == 202
        aid = r.json()["approval"]["id"]
        # Not yet mine: pending means no control.
        assert (await c.post("/api/agent/w9/prompt", json={"text": "hi"},
                             headers=_h("tok-p1"))).status_code == 404
        listed = (await c.get("/api/agent-approvals")).json()["approvals"]
        assert [a["id"] for a in listed] == [aid]
        assert (await _answer(c, aid, True)).json()["approval"]["status"] == "done"
        assert pty_manager.sessions["w9"].parent_id == "p1"
        assert (await c.post("/api/agent/w9/prompt", json={"text": "hi"},
                             headers=_h("tok-p1"))).status_code == 200
        st = (await c.get(f"/api/agent/approvals/{aid}", headers=_h("tok-p1"))).json()
        assert st["approval"]["status"] == "done"
        # Another session cannot read my request.
        assert (await c.get(f"/api/agent/approvals/{aid}",
                            headers=_h("tok-p2"))).status_code == 404


@pytest.mark.asyncio
async def test_denied_adopt_changes_nothing(world):
    async with _client() as c:
        aid = (await c.post("/api/agent/adopt", json={"peer": "p2"},
                            headers=_h("tok-p1"))).json()["approval"]["id"]
        assert (await _answer(c, aid, False)).json()["approval"]["status"] == "denied"
    assert pty_manager.sessions["p2"].parent_id is None


@pytest.mark.asyncio
async def test_adopt_refuses_escalation_depth_and_rechecks_at_approval(world):
    pty_manager.sessions["p3"] = _session("p3", token="tok-p3", name="Root", bypass=True)
    async with _client() as c:
        assert (await c.post("/api/agent/adopt", json={"peer": "p3"},
                             headers=_h("tok-p1"))).status_code == 403
        aid = (await c.post("/api/agent/adopt", json={"peer": "p2"},
                            headers=_h("tok-p1"))).json()["approval"]["id"]
        _worker_of("p2", "w5", "late")  # p2 gains a worker before the user answers
        r = await _answer(c, aid, True)
    assert r.status_code == 409 and r.json()["approval"]["status"] == "failed"
    assert pty_manager.sessions["p2"].parent_id is None


@pytest.mark.asyncio
async def test_spawn_refuses_a_twin_of_a_live_name_elsewhere(world):
    _worker_of("p2", "w9", "FW-World")
    async with _client() as c:
        r = await c.post("/api/agent/spawn", json={"name": "FW-World"}, headers=_h("tok-p1"))
    assert r.status_code == 409 and r.json()["live_elsewhere"]["id"] == "w9"
    assert world.spawned == []


CLEARED = ('{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}\n')


@pytest.fixture
def transcripts(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_api, "_transcript_dir", lambda s: str(tmp_path))
    (tmp_path / "old-conv.jsonl").write_text('{"type":"user"}\n', encoding="utf-8")
    return tmp_path


def _feed(s, data):
    s.history.sequence += 1
    s.history.chunks.append((s.history.sequence, data, 0.0))


@pytest.mark.asyncio
async def test_clear_is_confirmed_by_the_new_transcript_and_follows_it(world, monkeypatch,
                                                                        transcripts):
    w = _worker_of("p1", "w1", "FW-QA")
    w.claude_session_id = "old-conv"

    async def paste(tid, text):
        world.pasted.append((tid, text))
        if text == "/clear":
            (transcripts / "new-conv.jsonl").write_text(CLEARED, encoding="utf-8")
        return True

    monkeypatch.setitem(agent_api._deps, "paste", paste)
    async with _client() as c:
        r = await c.post("/api/agent/FW-QA/clear", json={"then_prompt": "Read BOOT.md"},
                         headers=_h("tok-p1"))
    assert r.json()["confirmed"] is True
    assert w.claude_session_id == "new-conv"  # usage and `read` follow the new conversation
    assert world.pasted == [("w1", "/clear"), ("w1", "Read BOOT.md")]


@pytest.mark.asyncio
async def test_a_repaint_does_not_confirm_a_claude_clear(world, monkeypatch, transcripts):
    """Claude Code does not repaint on /clear; a repaint alone (any redraw) is no proof."""
    w = _worker_of("p1", "w1", "FW-QA")

    async def paste(tid, text):
        _feed(w, "\x1b[2J")
        return True

    monkeypatch.setitem(agent_api._deps, "paste", paste)
    async with _client() as c:
        r = await c.post("/api/agent/w1/clear", json={}, headers=_h("tok-p1"))
    assert r.status_code == 200 and r.json()["confirmed"] is False


@pytest.mark.asyncio
async def test_a_transcript_another_session_holds_is_never_claimed(world, monkeypatch,
                                                                   transcripts):
    w = _worker_of("p1", "w1", "FW-QA")
    pty_manager.sessions["p2"].claude_session_id = "theirs"

    async def paste(tid, text):
        (transcripts / "theirs.jsonl").write_text(CLEARED, encoding="utf-8")
        return True

    monkeypatch.setitem(agent_api._deps, "paste", paste)
    async with _client() as c:
        r = await c.post("/api/agent/w1/clear", json={}, headers=_h("tok-p1"))
    assert r.json()["confirmed"] is False and getattr(w, "claude_session_id", None) is None


@pytest.mark.asyncio
async def test_codex_clear_sends_new_and_is_confirmed_by_a_repaint(world, monkeypatch):
    w = _worker_of("p1", "w1", "cx", harness="codex")

    async def paste(tid, text):
        world.pasted.append((tid, text))
        _feed(w, "\x1b[2J")
        return True

    monkeypatch.setitem(agent_api._deps, "paste", paste)
    async with _client() as c:
        r = await c.post("/api/agent/w1/clear", json={}, headers=_h("tok-p1"))
    assert r.json()["confirmed"] is True and world.pasted == [("w1", "/new")]


@pytest.mark.asyncio
async def test_clear_refuses_blocked_shell_and_foreign_workers(world):
    _worker_of("p1", "w1", "asks", state="waiting")
    _worker_of("p1", "w2", "sh", harness="shell")
    _worker_of("p2", "w3", "theirs")
    async with _client() as c:
        assert (await c.post("/api/agent/w1/clear", headers=_h("tok-p1"))).status_code == 409
        assert (await c.post("/api/agent/w2/clear", headers=_h("tok-p1"))).status_code == 409
        assert (await c.post("/api/agent/w3/clear", headers=_h("tok-p1"))).status_code == 404
    assert world.pasted == []


@pytest.mark.asyncio
async def test_self_refresh_runs_only_after_approval(world, monkeypatch, transcripts):
    me = pty_manager.sessions["p1"]

    async def paste(tid, text):
        world.pasted.append((tid, text))
        if text == "/clear":
            (transcripts / "fresh.jsonl").write_text(CLEARED, encoding="utf-8")
        return True

    monkeypatch.setitem(agent_api._deps, "paste", paste)
    async with _client() as c:
        r = await c.post("/api/agent/self/refresh", json={"prompt": "Read HANDOFF.md"},
                         headers=_h("tok-p1"))
        assert r.status_code == 202 and world.pasted == []
        aid = r.json()["approval"]["id"]
        await _answer(c, aid, True)
        st = (await c.get(f"/api/agent/approvals/{aid}?wait_ms=0",
                          headers=_h("tok-p1"))).json()["approval"]
        for _ in range(100):
            if st["status"] in ("done", "failed"):
                break
            await asyncio.sleep(0.01)
            st = (await c.get(f"/api/agent/approvals/{aid}", headers=_h("tok-p1"))).json()["approval"]
    assert st["status"] == "done" and st["detail"] == "confirmed"
    assert world.pasted == [("p1", "/clear"), ("p1", "Read HANDOFF.md")]
    assert me.claude_session_id == "fresh"


@pytest.mark.asyncio
async def test_events_report_a_blocked_worker_then_transitions(world):
    w1 = _worker_of("p1", "w1", "a", state="busy")
    _worker_of("p1", "w2", "b", state="waiting")
    async with _client() as c:
        first = (await c.get("/api/agent/events?timeout_ms=0", headers=_h("tok-p1"))).json()
        assert [(e["name"], e["event"]) for e in first["events"]] == [("b", "asking")]
        w1.tracker.state = "idle"
        nxt = (await c.get(f"/api/agent/events?after={first['next']}&timeout_ms=500",
                           headers=_h("tok-p1"))).json()
        assert [(e["name"], e["event"], e["previous"]) for e in nxt["events"]] == [
            ("a", "idle", "busy")]
        quiet = (await c.get(f"/api/agent/events?after={nxt['next']}&timeout_ms=0",
                             headers=_h("tok-p1"))).json()
        assert quiet["events"] == []


@pytest.mark.asyncio
async def test_terminals_poll_carries_pending_approvals(world, monkeypatch):
    monkeypatch.setattr(pty_manager, "list_terminals", lambda: [])
    async with _client() as c:
        aid = (await c.post("/api/agent/adopt", json={"peer": "p2"},
                            headers=_h("tok-p1"))).json()["approval"]["id"]
        body = (await c.get("/api/terminals")).json()
    assert [a["id"] for a in body["agent_approvals"]] == [aid]
