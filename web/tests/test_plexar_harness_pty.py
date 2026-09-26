"""The `plexar-harness` harness: a PTY pane running the Plexar Harness CLI.

Copies the codex pattern (tests/test_codex_harness.py): nothing here spawns a
real process -- the PTY backend and every CLI resolver are patched -- and the
Plexar key / rig URL come from monkeypatched harness_manager seams, never from
the developer's own environment.
"""

import json
import os
from unittest.mock import MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

os.environ.setdefault("MAX_SESSIONS", "8")

import harness_manager as hm  # noqa: E402
import pty_manager  # noqa: E402
from pty_manager import PtyManager  # noqa: E402

KEY = "plx_pty_SECRET_key"
RIG = "https://rig.example.test"
MODEL_VALUE = json.dumps(["plexar", "qwen3.8-27b"])

# Every flag the claude CLI (or codex) takes that must never reach this CLI.
CLAUDE_ONLY = (
    "--dangerously-skip-permissions", "--permission-mode", "--effort", "--model",
    "--settings", "--name", "--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox",
    "--sandbox", "--ask-for-approval", "model_reasoning_effort",
)


def _call_create(mgr, **kwargs):
    pty = MagicMock()
    pty.isalive.return_value = True
    pty.pid = None
    backend_cls = MagicMock()
    backend_cls.__name__ = "MockBackend"
    captured = {}

    def recording_spawn(cmd, **kw):
        captured["cmd"] = cmd
        captured["env"] = kw.get("env", {})
        return pty

    backend_cls.spawn.side_effect = recording_spawn
    with patch("pty_backend.get_backend", return_value=backend_cls), \
         patch.object(pty_manager, "resolve_plexar_harness_cli",
                      side_effect=lambda p: ("C:\\fake\\plexar-harness.cmd", p)), \
         patch.object(pty_manager, "resolve_codex_cli", side_effect=AssertionError("codex resolved")), \
         patch.object(pty_manager, "resolve_claude_cli", side_effect=AssertionError("claude resolved")):
        session = mgr.create_terminal(**kwargs)
    return session, captured.get("cmd", ""), captured.get("env", {})


@pytest.fixture()
def harness_env(monkeypatch):
    monkeypatch.setenv("PLEXAR_RIG_URL", "https://inherited.example")
    monkeypatch.setenv("PLEXAR_MODEL", "inherited-model")
    monkeypatch.setattr(hm, "get_key", lambda: KEY)
    monkeypatch.setattr(hm, "_harness_settings", lambda: {})
    monkeypatch.setattr(hm, "resolve_rig_url", lambda settings: (RIG, "plexar_provider"))


@pytest.fixture()
def mgr():
    return PtyManager()


def _create(mgr, **kw):
    base = dict(name="t", workdir="C:\\Code", harness="plexar-harness", model=MODEL_VALUE)
    base.update(kw)
    return _call_create(mgr, **base)


@pytest.mark.parametrize("mode,flag", [
    ("default", "ask"), ("plan", "ask"), ("acceptEdits", "auto-edit"), ("bypassPermissions", "full-access"),
])
def test_permission_mode_maps_to_harness_preset(mgr, harness_env, mode, flag):
    _, cmd, _ = _create(mgr, permission_mode=mode)
    assert cmd.split()[0] == "plexar-harness"
    assert f" -m {flag}" in cmd
    assert cmd.split().count("-m") == 1


def test_legacy_bypass_boolean_is_full_access(mgr, harness_env):
    _, cmd, _ = _create(mgr, bypass_permissions=True)
    assert " -m full-access" in cmd


@pytest.mark.parametrize("effort,expected", [
    ("", None), ("off", " -e off"), ("high", " -e high"),
    ("low", None), ("medium", None), ("xhigh", None), ("max", None),
])
def test_effort_values(mgr, harness_env, effort, expected):
    _, cmd, _ = _create(mgr, effort=effort)
    if expected is None:
        assert " -e " not in cmd  # dropped, never passed through
        assert effort not in cmd.split()
    else:
        assert expected in cmd
        assert cmd.split().count("-e") == 1


def test_off_effort_still_refused_for_claude(mgr):
    with pytest.raises(ValueError, match="Invalid effort"):
        _call_create(mgr, name="t", workdir="C:\\Code", model="sonnet", effort="off")


@pytest.mark.parametrize("mode", ["default", "plan", "acceptEdits", "bypassPermissions", "auto", "dontAsk"])
@pytest.mark.parametrize("effort", ["", "off", "high", "low", "xhigh", "max"])
def test_no_claude_only_flag_ever_appears(mgr, harness_env, mode, effort):
    _, cmd, _ = _create(mgr, permission_mode=mode, effort=effort, fast=True, bypass_permissions=(mode == "auto"),
                        name="My pane")
    tokens = cmd.split()
    for flag in CLAUDE_ONLY:
        assert flag not in tokens and flag not in cmd, (flag, cmd)
    assert "claude" not in tokens and "codex" not in tokens


def test_resume_and_continue(mgr, harness_env):
    _, cmd, _ = _create(mgr, resume_session_id="0199aabb-ccdd-7eef-8899-001122334455")
    assert " --resume 0199aabb-ccdd-7eef-8899-001122334455" in cmd
    _, cmd, _ = _create(mgr, continue_last=True)
    assert cmd.split().count("--continue") == 1


def test_env_carries_key_rig_and_model(mgr, harness_env):
    session, cmd, env = _create(mgr)
    assert env["PLEXAR_HARNESS_KEY"] == KEY
    assert env["PLEXAR_RIG_URL"] == RIG
    assert env["PLEXAR_MODEL"] == "qwen3.8-27b"
    assert env["PLEXAR_SESSION_ID"] == session.id
    assert KEY not in cmd and "qwen3.8-27b" not in cmd
    assert session.harness == "plexar-harness"
    assert session.claude_session_id is None and session.codex_session_id is None


def test_env_omits_rig_and_model_when_unresolved(mgr, harness_env, monkeypatch):
    monkeypatch.setattr(hm, "resolve_rig_url", lambda settings: (None, "harness_default"))
    _, _, env = _create(mgr, model="")
    assert env["PLEXAR_HARNESS_KEY"] == KEY
    # Inherited values must not leak in either.
    assert "PLEXAR_RIG_URL" not in env
    assert "PLEXAR_MODEL" not in env


def test_bare_served_name_is_accepted(mgr, harness_env):
    _, _, env = _create(mgr, model="qwen3.8-27b")
    assert env["PLEXAR_MODEL"] == "qwen3.8-27b"


@pytest.mark.parametrize("bad", ["sonnet", "claude-opus-5", json.dumps(["openai", "gpt-5"]), "[not json", "a b"])
def test_bad_or_foreign_model_is_refused(mgr, harness_env, bad):
    with pytest.raises(ValueError):
        _create(mgr, model=bad)


def test_key_missing_refuses_the_spawn(mgr, harness_env, monkeypatch):
    monkeypatch.setattr(hm, "get_key", lambda: None)
    backend = MagicMock()
    with patch("pty_backend.get_backend", return_value=backend), \
         patch.object(pty_manager, "resolve_plexar_harness_cli", side_effect=lambda p: ("x", p)):
        with pytest.raises(ValueError) as exc:
            mgr.create_terminal(name="t", workdir="C:\\Code", harness="plexar-harness", model=MODEL_VALUE)
    assert str(exc.value) == hm.friendly("key_missing")
    backend.spawn.assert_not_called()
    assert mgr.sessions == {}


def test_bad_rig_url_refuses_the_spawn(mgr, harness_env, monkeypatch):
    def bad(_settings):
        raise hm.HarnessError("bad", None, "bad_rig_url")
    monkeypatch.setattr(hm, "resolve_rig_url", bad)
    with pytest.raises(ValueError, match="rig URL"):
        _create(mgr)


def test_non_anthropic_provider_is_refused(mgr, harness_env):
    with pytest.raises(ValueError, match="Plexar rig"):
        _create(mgr, provider="openrouter", provider_model="qwen/qwen3-coder-next")


def test_get_jsonl_path_is_none_for_plexar_harness(mgr, harness_env):
    session, _, _ = _create(mgr)
    session.tracker.last_output_time = 1.0
    assert getattr(session, "_pre_spawn_files", None) is None
    with patch.object(mgr, "_rediscover_jsonl", side_effect=AssertionError("Strategy 3 ran")):
        assert mgr._get_jsonl_path(session) is None


def test_launcher_missing_is_actionable(monkeypatch):
    monkeypatch.setattr(pty_manager.shutil, "which", lambda *a, **k: None)
    with pytest.raises(pty_manager.PlexarHarnessCliNotFound) as exc:
        pty_manager.resolve_plexar_harness_cli("")
    assert "Plexar Harness launcher not found - run packages/bundle/plexar/profiles/install.ps1" in str(exc.value)
    assert isinstance(exc.value, FileNotFoundError)


@pytest.mark.asyncio
async def test_post_terminals_forwards_plexar_harness(monkeypatch):
    import server

    seen = {}

    def fake_create(**kw):
        seen.update(kw)
        s = MagicMock()
        s.id, s.name, s.model, s.provider, s.created_at = "abc12345", "t", kw["model"], "anthropic", "now"
        s.harness = "plexar-harness"
        s._fast_settings_path = None
        s.pty.isalive.return_value = True
        return s

    async def no_sleep(_):
        return None

    async def no_reader(_):
        return None

    monkeypatch.setattr(server.pty_manager, "create_terminal", fake_create)
    monkeypatch.setattr(server.asyncio, "sleep", no_sleep)
    monkeypatch.setattr(server, "_session_reader", no_reader)
    client = AsyncClient(transport=ASGITransport(app=server.app), base_url="http://127.0.0.1:8420")
    r = await client.post("/api/terminals", json={
        "name": "t", "workdir": "C:\\Code", "harness": "plexar-harness",
        "model": MODEL_VALUE, "effort": "off", "permissionMode": "acceptEdits",
    })
    assert r.status_code == 200, r.text
    assert seen["harness"] == "plexar-harness"
    assert seen["model"] == MODEL_VALUE
    assert seen["effort"] == "off"
    assert seen["provider"] == "anthropic"


def test_removed_acp_session_routes_are_gone():
    import server

    paths = {getattr(r, "path", "") for r in server.app.routes}
    assert "/ws/harness" not in paths
    assert not any(p.startswith("/api/harness/sessions") or p.startswith("/api/harness/permissions") for p in paths)
    for kept in ("/api/harness/status", "/api/harness/key", "/api/harness/models"):
        assert kept in paths
