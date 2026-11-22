"""Orchestration identity on a worker pane (orch_run / orch_node / brief_sha256).

`plexar orch dispatch` hands a card to a Studio worker pane; the parent passes three
values on /api/agent/spawn and Studio exports them into that pane only. A value that
fails validation is left absent, never truncated, and every other pane has them removed.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

from pty_manager import PtyManager
from tests.test_agent_spawn import _client, _h, world  # noqa: F401 -- fixture

SHA = "a" * 64
KEYS = ("PLEXAR_ORCH_RUN", "PLEXAR_ORCH_NODE", "PLEXAR_BRIEF_SHA256")


async def test_valid_fields_reach_the_one_spawn_path(world, monkeypatch):  # noqa: F811
    import agent_api
    seen = {}

    async def create(body, parent_id=None, orch=None):
        seen.update(orch=orch, parent=parent_id, body=body)
        return {"id": "x"}

    monkeypatch.setitem(agent_api._deps, "create", create)
    async with _client() as c:
        r = await c.post("/api/agent/spawn", headers=_h("tok-p1"), json={
            "orch_run": "orch-20261122-x", "orch_node": "N7.a", "brief_sha256": SHA})
    assert r.status_code == 201
    assert seen["orch"] == {"PLEXAR_ORCH_RUN": "orch-20261122-x", "PLEXAR_ORCH_NODE": "N7.a",
                            "PLEXAR_BRIEF_SHA256": SHA}
    assert seen["parent"] == "p1"
    assert not any(k.startswith(("orch", "brief")) for k in seen["body"])
    assert r.json()["orch"] == {"orch_run": "orch-20261122-x", "orch_node": "N7.a",
                                "brief_sha256": SHA}


async def test_a_bad_value_is_absent_not_truncated_and_the_spawn_still_happens(world):  # noqa: F811
    async with _client() as c:
        r = await c.post("/api/agent/spawn", headers=_h("tok-p1"), json={
            "orch_run": "r" * 129, "orch_node": "has space", "brief_sha256": SHA.upper()})
        r2 = await c.post("/api/agent/spawn", headers=_h("tok-p1"), json={
            "orch_run": 7, "orch_node": "N1\r\nX: y", "brief_sha256": SHA[:63]})
    assert r.status_code == 201 and r.json()["orch"] == {}
    assert r2.status_code == 201 and r2.json()["orch"] == {}
    assert len(world.spawned) == 2  # the recorder takes no `orch`: it was never passed


def _spawn_env(monkeypatch, **kw):
    pty = MagicMock()
    pty.isalive.return_value = True
    pty.pid = 99999
    backend = MagicMock()
    backend.spawn.return_value = pty
    backend.__name__ = "MockBackend"
    with patch("pty_backend.get_backend", return_value=backend), \
         patch("pty_manager.resolve_claude_cli", side_effect=lambda path: ("claude", path)):
        PtyManager().create_terminal(name="t", workdir="C:\\Code", model="sonnet", **kw)
    return backend.spawn.call_args[1]["env"]


def test_a_stamped_pane_gets_exactly_its_own_values(monkeypatch):
    monkeypatch.setenv("PLEXAR_ORCH_RUN", "inherited-run")
    env = _spawn_env(monkeypatch, orch={"PLEXAR_ORCH_RUN": "mine", "PLEXAR_BRIEF_SHA256": SHA})
    assert env["PLEXAR_ORCH_RUN"] == "mine" and env["PLEXAR_BRIEF_SHA256"] == SHA
    assert "PLEXAR_ORCH_NODE" not in env


def test_an_ordinary_pane_never_inherits_a_workers_identity(monkeypatch):
    for k in KEYS:
        monkeypatch.setenv(k, "inherited")
    env = _spawn_env(monkeypatch)
    assert not any(k in env for k in KEYS)


def test_the_public_create_route_cannot_set_it():
    src = (Path(__file__).resolve().parent.parent / "server.py").read_text(encoding="utf-8")
    assert 'body.get("orch' not in src and 'body.get("brief_sha256' not in src
