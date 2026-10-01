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


def _session(sid, *, parent_id=None, token="", name=None, bypass=False, state="idle",
             harness="claude-code", cwd="C:/repo"):
    return types.SimpleNamespace(
        id=sid, name=name or sid, harness=harness, model="sonnet", provider="anthropic",
        working_dir=cwd, parent_id=parent_id, spawn_token=token, alive=True,
        tracker=_Tracker(state), effort="", permission_mode="default",
        bypass_permissions=bypass, history=types.SimpleNamespace(chunks=[], sequence=0),
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
                                             name=body["name"], harness=body["harness"],
                                             cwd=body["workdir"])
        return {"id": sid}

    pasted = []

    async def fake_paste(tid, text):
        pasted.append((tid, text))
        return True

    async def fake_idle(tid, timeout=None):
        return True

    written = []

    async def fake_write(tid, data):
        written.append((tid, data))
        return True

    killed = []
    monkeypatch.setitem(agent_api._deps, "write", fake_write)
    monkeypatch.setattr(agent_api, "_latest_assistant", lambda child: None)
    monkeypatch.setitem(agent_api._deps, "create", fake_create)
    monkeypatch.setitem(agent_api._deps, "paste", fake_paste)
    monkeypatch.setitem(agent_api._deps, "idle", fake_idle)
    monkeypatch.setattr(pty_manager, "kill_terminal", lambda tid: killed.append(tid) or True)
    pty_manager.sessions["p1"] = _session("p1", token="tok-p1", name="Session 3")
    pty_manager.sessions["p2"] = _session("p2", token="tok-p2", name="Other")
    yield types.SimpleNamespace(spawned=spawned, pasted=pasted, killed=killed, written=written)
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
    assert r.json() == {"state": "waiting", "timed_out": False, "saw_activity": True, "stalled": False}


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


# ── herdr-parity surface ─────────────────────────────────────────────────────

async def test_plexar_alias_spawns_the_plexar_harness_with_its_default_model(world):
    async with _client() as c:
        r = await c.post("/api/agent/spawn", json={"harness": "plexar"}, headers=_h("tok-p1"))
    assert r.status_code == 201
    body, _ = world.spawned[0]
    assert body["harness"] == "plexar-harness" and body["model"] == "" and body["effort"] == ""


async def test_a_foreign_harness_needs_an_explicit_model(world):
    async with _client() as c:
        r = await c.post("/api/agent/spawn", json={"harness": "codex"}, headers=_h("tok-p1"))
    assert r.status_code == 400 and world.spawned == []


async def test_shell_worker_runs_commands_and_refuses_prompts(world):
    async with _client() as c:
        bad = await c.post("/api/agent/spawn", json={"harness": "shell", "prompt": "x"}, headers=_h("tok-p1"))
        ok = await c.post("/api/agent/spawn", json={"harness": "shell", "name": "sh"}, headers=_h("tok-p1"))
        run = await c.post("/api/agent/sh/run", json={"command": "npm test"}, headers=_h("tok-p1"))
        multi = await c.post("/api/agent/sh/run", json={"command": "a\nb"}, headers=_h("tok-p1"))
        prompt = await c.post("/api/agent/sh/prompt", json={"text": "hi"}, headers=_h("tok-p1"))
        wait = await c.get("/api/agent/sh/wait", headers=_h("tok-p1"))
    assert bad.status_code == 400
    assert ok.status_code == 201 and ok.json()["worker"]["state"] == "n/a"
    assert run.status_code == 200 and run.json()["after"] == 0
    assert world.written == [("child1", "npm test\r")]
    assert multi.status_code == 400 and prompt.status_code == 409 and wait.status_code == 409


async def test_run_is_refused_on_an_agent_worker(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        r = await c.post("/api/agent/child1/run", json={"command": "ls"}, headers=_h("tok-p1"))
    assert r.status_code == 409 and world.written == []


async def test_keys_are_validated_as_a_whole_before_writing(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        pty_manager.sessions["child1"].tracker.state = "waiting"   # keys still allowed
        bad = await c.post("/api/agent/child1/keys", json={"keys": ["esc", "bogus"]}, headers=_h("tok-p1"))
        ok = await c.post("/api/agent/child1/keys", json={"keys": "esc ctrl+c enter"}, headers=_h("tok-p1"))
        foreign = await c.post("/api/agent/child1/keys", json={"keys": ["esc"]}, headers=_h("tok-p2"))
    assert bad.status_code == 400
    assert ok.status_code == 200 and world.written == [("child1", "\x1b\x03\r")]
    assert foreign.status_code == 404


async def test_wait_output_matches_existing_and_respects_after(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={"harness": "shell", "name": "sh"}, headers=_h("tok-p1"))
        h = pty_manager.sessions["child1"].history
        h.chunks = [(1, "\x1b[32m12 passed\x1b[0m\r\n", 0), (2, "$ ", 0)]
        hit = await c.get("/api/agent/sh/wait-output", params={"regex": r"(\d+) passed", "timeout_ms": 0},
                          headers=_h("tok-p1"))
        miss = await c.get("/api/agent/sh/wait-output", params={"match": "passed", "after": 1, "timeout_ms": 0},
                           headers=_h("tok-p1"))
        both = await c.get("/api/agent/sh/wait-output", params={"match": "a", "regex": "b"}, headers=_h("tok-p1"))
        badre = await c.get("/api/agent/sh/wait-output", params={"regex": "("}, headers=_h("tok-p1"))
    assert hit.json() == {"matched": True, "line": "12 passed", "timed_out": False, "ended": False}
    assert miss.json()["matched"] is False and miss.json()["timed_out"] is True
    assert both.status_code == 400 and badre.status_code == 400


async def test_read_ansi_keeps_escapes_and_text_strips_them(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        pty_manager.sessions["child1"].history.chunks = [(1, "\x1b[31mred\x1b[0m\r\n", 0)]
        text = await c.get("/api/agent/child1/read", headers=_h("tok-p1"))
        ansi = await c.get("/api/agent/child1/read?format=ansi", headers=_h("tok-p1"))
    assert text.json()["screen"] == "red"
    assert "\x1b[31m" in ansi.json()["screen"]


async def test_settled_wait_without_activity_reports_stalled(world, monkeypatch):
    monkeypatch.setattr(agent_api, "_ACTIVITY_GRACE", 0.0)
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        r = await c.get("/api/agent/child1/wait?timeout_ms=2000", headers=_h("tok-p1"))
    assert r.json()["stalled"] is True and r.json()["saw_activity"] is False


async def test_peers_are_read_only_and_exclude_self_and_workers(world):
    async with _client() as c:
        await c.post("/api/agent/spawn", json={}, headers=_h("tok-p1"))
        r = await c.get("/api/agent/peers", headers=_h("tok-p1"))
        ctl = await c.post("/api/agent/p2/prompt", json={"text": "x"}, headers=_h("tok-p1"))
    assert [p["id"] for p in r.json()["peers"]] == ["p2"]
    assert ctl.status_code == 404


async def test_worktree_worker_gets_its_own_checkout(world, tmp_path):
    import subprocess
    repo = tmp_path / "repo"
    repo.mkdir()
    for cmd in (["init", "-q"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q",
                                  "--allow-empty", "-m", "init"]):
        subprocess.run(["git", "-C", str(repo), *cmd], check=True)
    pty_manager.sessions["p1"].working_dir = str(repo)
    async with _client() as c:
        r = await c.post("/api/agent/spawn", json={"worktree": "feat/x"}, headers=_h("tok-p1"))
        dup = await c.post("/api/agent/spawn", json={"worktree": "feat/x"}, headers=_h("tok-p1"))
        bad = await c.post("/api/agent/spawn", json={"worktree": "../escape"}, headers=_h("tok-p1"))
    assert r.status_code == 201
    wt = tmp_path / "repo-worktrees" / "feat-x"
    assert world.spawned[0][0]["workdir"] == str(wt)
    branch = subprocess.run(["git", "-C", str(wt), "branch", "--show-current"],
                            capture_output=True, text=True).stdout.strip()
    assert branch == "feat/x"
    assert dup.status_code == 400 and bad.status_code == 400


def test_shell_harness_is_allowed_and_refuses_a_provider():
    import pty_manager as pm
    assert "shell" in pm._ALLOWED_HARNESSES
    assert pm._shell_command().split()[0]
    with pytest.raises(ValueError, match="no model provider"):
        pm.pty_manager.create_terminal(harness="shell", provider="openrouter")


def test_cli_points_at_a_shipped_file_and_exits_2_outside_a_pane(monkeypatch):
    import os
    import studio_cli
    monkeypatch.delenv("PLEXAR_STUDIO_TOKEN", raising=False)
    with pytest.raises(SystemExit) as exc:
        studio_cli.main(["whoami"])
    assert exc.value.code == 2
    spec = open(os.path.join(os.path.dirname(studio_cli.__file__), "cockpit-server.spec"), encoding="utf-8").read()
    assert "studio_cli.py" in spec


def test_cli_exit_codes(monkeypatch, capsys):
    import studio_cli
    monkeypatch.setattr(studio_cli, "_call", lambda *a, **k: (0, {"matched": False, "timed_out": True}))
    assert studio_cli.main(["wait-output", "w", "--match", "x"]) == 3
    monkeypatch.setattr(studio_cli, "_call", lambda *a, **k: (1, {"error": "no"}))
    assert studio_cli.main(["close", "w"]) == 1
    monkeypatch.setattr(studio_cli, "_call", lambda *a, **k: (0, {"ok": True}))
    assert studio_cli.main(["keys", "w", "esc", "enter"]) == 0
