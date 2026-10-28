"""The phone's slash-command catalogue: built-ins, on-disk commands, auth, cache."""

from __future__ import annotations

import os
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import slash_catalog  # noqa: E402
from tests.test_remote_gateway import BASE, auth, pair, rig as _rig  # noqa: E402,F401


@pytest.fixture
def rig(_rig, tmp_path, monkeypatch):
    backend, store, _client = _rig
    home = tmp_path / "home"
    (home / ".claude" / "commands" / "sub").mkdir(parents=True)
    (home / ".claude" / "skills" / "myskill").mkdir(parents=True)
    (home / ".claude" / "commands" / "deploy.md").write_text(
        "---\ndescription: Ship it\nargument-hint: <env>\n---\nbody\n", encoding="utf-8")
    (home / ".claude" / "commands" / "sub" / "nested.md").write_text(
        "# Nested thing\nmore\n", encoding="utf-8")
    (home / ".claude" / "skills" / "myskill" / "SKILL.md").write_text(
        "---\nname: myskill\ndescription: A skill\n---\n", encoding="utf-8")
    proj = tmp_path / "proj"
    (proj / ".claude" / "commands").mkdir(parents=True)
    (proj / ".claude" / "commands" / "local.md").write_text("Project cmd\n", encoding="utf-8")
    plug = tmp_path / "plug"
    (plug / "commands").mkdir(parents=True)
    (plug / "commands" / "go.md").write_text("---\ndescription: Plugin go\n---\n", encoding="utf-8")
    (home / ".claude" / "plugins").mkdir()
    (home / ".claude" / "plugins" / "installed_plugins.json").write_text(
        '{"plugins": {"acme@mk": [{"installPath": %s}]}}' % __import__("json").dumps(str(plug)),
        encoding="utf-8")
    monkeypatch.setattr(slash_catalog.Path, "home", classmethod(lambda cls: home))
    backend.sessions[0]["working_dir"] = str(proj)
    slash_catalog._cache.clear()
    app = FastAPI()
    app.include_router(slash_catalog.router)
    import remote_gateway
    app.include_router(remote_gateway.router)
    with TestClient(app, base_url=BASE) as client:
        yield backend, store, client


def _get(rig, sid="t1"):
    backend, store, client = rig
    token = pair(client, store)["token"]
    return client.get(f"/remote/v1/sessions/{sid}/commands", headers=auth(token))


def test_requires_device(rig):
    _b, _s, client = rig
    assert client.get("/remote/v1/sessions/t1/commands").status_code == 401


def test_unknown_session(rig):
    assert _get(rig, "nope").status_code == 404


def test_claude_catalog(rig):
    resp = _get(rig)
    assert resp.status_code == 200
    by = {c["command"]: c for c in resp.json()["commands"]}
    assert by["/compact"]["source"] == "builtin"
    assert by["/deploy"] == {"command": "/deploy", "description": "Ship it",
                             "source": "user", "argument_hint": "<env>"}
    assert by["/sub:nested"]["description"] == "Nested thing"
    assert by["/myskill"]["source"] == "skill"
    assert by["/local"]["source"] == "project"
    assert by["/acme:go"]["source"] == "plugin"


def test_other_harness_small_set(rig):
    backend, _s, _c = rig
    backend.sessions[0]["harness"] = "shell"
    assert _get(rig).json() == {"commands": []}
    backend.sessions[0]["harness"] = "codex"
    assert any(c["command"] == "/new" for c in _get(rig).json()["commands"])


def test_cache_invalidates_on_change(rig, tmp_path):
    first = {c["command"] for c in _get(rig).json()["commands"]}
    (tmp_path / "proj" / ".claude" / "commands" / "fresh.md").write_text("New\n", encoding="utf-8")
    second = {c["command"] for c in _get(rig).json()["commands"]}
    assert "/fresh" in second - first
