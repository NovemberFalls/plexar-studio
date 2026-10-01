"""Agent sub-sessions (agent_api.py): token identity, ownership scoping, limits.

No CLI is launched: sessions are lightweight doubles placed in pty_manager.sessions,
and the one spawn path is replaced with a recorder that inserts a child double.
"""
from __future__ import annotations

import types

import pytest
from httpx import ASGITransport, AsyncClient

import agent_api
from server import app, pty_manager

BASE = "http://127.0.0.1:8420"


class _Tracker:
    def __init__(self, state="idle"):
        self.state = state

    def tick(self):
        pass


def _session(sid, *, parent_id=None, token="", name=None, bypass=False, state="idle"):
    return types.SimpleNamespace(
        id=sid, name=name or sid, harness="claude-code", model="sonnet", provider="anthropic",
        working_dir="C:/repo", parent_id=parent_id, spawn_token=token, alive=True,
        tracker=_Tracker(state), effort="", permission_mode="default",
        bypass_permissions=bypass, history=types.SimpleNamespace(chunks=[]),
    )


@pytest.fixture
def world(monkeypatch):
    saved = dict(pty_manager.sessions)
    pty_manager.sessions.clear()
    spawned = []

    async def fake_create(body, parent_id=None):
        sid = f"child{len(spawned) + 1}"
        spawned.append((body, parent_id))
        pty_manager.sessions[sid] = _session(sid, parent_id=parent_id, token=f"tok-{sid}",
                                             name=body["name"])
        return {"id": sid}

    pasted = []

    async def fake_paste(tid, text):
        pasted.append((tid, text))
        return True

    async def fake_idle(tid, timeout=None):
        return True

    killed = []
    monkeypatch.setitem(agent_api._deps, "create", fake_create)
    monkeypatch.setitem(agent_api._deps, "paste", fake_paste)
    monkeypatch.setitem(agent_api._deps, "idle", fake_idle)
    monkeypatch.setattr(pty_manager, "kill_terminal", lambda tid: killed.append(tid) or True)
    pty_manager.sessions["p1"] = _session("p1", token="tok-p1", name="Session 3")
    pty_manager.sessions["p2"] = _session("p2", token="tok-p2", name="Other")
    yield types.SimpleNamespace(spawned=spawned, pasted=pasted, killed=killed)
    pty_manager.sessions.clear()
    pty_manager.sessions.update(saved)


def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url=BASE)


def _h(tok):
    return {"X-Plexar-Session-Token": tok}


async def test_missing_or_wrong_token_is_401_and_spawns_nothing(world):
    async with _client() as c:
        assert (await c.post("/api/agent/spawn", json={})).status_code == 401
        assert (await c.post("/api/agent/spawn", json={}, headers=_h("nope"))).status_code == 401
    assert world.spawned == []


async def test_spawn_sets_parent_from_token_and_names_children_n_dot_k(world):
    async with _client() as c:
        r1 = await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        r2 = await c.post("/api/agent/spawn", json={"parent_id": "p2"}, headers=_h("tok-p1"))
    assert r1.status_code == 201 and r2.status_code == 201
    # parent comes from the TOKEN; a parent_id in the body is ignored
    assert [p for _, p in world.spawned] == ["p1", "p1"]
    assert [b["name"] for b, _ in world.spawned] == ["Session 3.1", "Session 3.2"]


async def test_worker_never_gets_more_permission_than_parent(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={"bypassPermissions": True}, headers=_h("tok-p1"))
    body, _ = world.spawned[0]
    assert body["bypassPermissions"] is False


async def test_depth_is_one(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        r = await c.post("/api/agent/spawn", json={}, headers=_h("tok-child1"))
    assert r.status_code == 403
    assert len(world.spawned) == 1


async def test_child_cap(world):
    async with _client() as c:
        for _ in range(agent_api.MAX_CHILDREN):
            assert (await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))).status_code == 201
        r = await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
    assert r.status_code == 409


async def test_only_the_parent_can_prompt_read_or_close_its_worker(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        for tok in ("tok-p2", "tok-child1"):
            assert (await c.post("/api/agent/child1/prompt", json={"text": "x"}, headers=_h(tok))).status_code == 404
            assert (await c.get("/api/agent/child1/read", headers=_h(tok))).status_code == 404
            assert (await c.delete("/api/agent/child1", headers=_h(tok))).status_code == 404
        ok = await c.post("/api/agent/Session 3.1/prompt", json={"text": "go"}, headers=_h("tok-p1"))
        gone = await c.delete("/api/agent/child1", headers=_h("tok-p1"))
    assert ok.status_code == 200 and world.pasted == [("child1", "go")]
    assert gone.status_code == 200 and world.killed == ["child1"]


async def test_prompt_refuses_a_blocked_worker(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        pty_manager.sessions["child1"].tracker.state = "waiting"
        r = await c.post("/api/agent/child1/prompt", json={"text": "go"}, headers=_h("tok-p1"))
    assert r.status_code == 409 and world.pasted == []


async def test_children_lists_only_own_live_workers(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p2"))
        r = await c.get("/api/agent/children", headers=_h("tok-p1"))
    assert [w["id"] for w in r.json()["children"]] == ["child1"]


async def test_wait_returns_waiting_state(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        pty_manager.sessions["child1"].tracker.state = "waiting"
        r = await c.get("/api/agent/child1/wait?until=waiting&timeout_ms=2000", headers=_h("tok-p1"))
    assert r.json() == {"state": "waiting", "timed_out": False, "saw_activity": True}


async def test_browser_origin_is_still_refused(world):
    async with _client() as c:
        r = await c.post("/api/agent/spawn", json={}, headers={**_h("tok-p1"), "Origin": "http://evil.example"})
    assert r.status_code == 403 and world.spawned == []


def test_token_and_parent_reach_session_and_dict():
    """parent_id is serialized; the token never is."""
    import pty_manager as pm
    assert "spawn_token" in pm.TerminalSession.__dataclass_fields__
    src = open(pm.__file__, encoding="utf-8").read()
    assert '"parent_id": session.parent_id' in src
    assert '"spawn_token"' not in src.split("def _session_to_dict", 1)[1].split("def list_terminals", 1)[0]
    assert 'env["PLEXAR_STUDIO_TOKEN"] = spawn_token' in src
