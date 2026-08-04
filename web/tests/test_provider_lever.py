"""Tests for the per-session OpenRouter provider lever.

Covers:
  - PtyManager.create_terminal() provider="openrouter": cmd omits --model,
    env carries the five OpenRouter vars with correct values
  - provider="anthropic" (default): env never carries ANTHROPIC_BASE_URL /
    ANTHROPIC_AUTH_TOKEN even when a machine-global os.environ has them
  - Validation ValueErrors fire before any spawn attempt: missing key,
    invalid slug, missing provider_model, invalid provider
  - effort/fast are silently skipped (no flag in cmd) for provider="openrouter"
  - POST /api/terminals forwards provider/providerModel and echoes provider
    back in both the create response and the session-list dict
"""

import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

os.environ.setdefault("MAX_SESSIONS", "8")

from pty_manager import PtyManager


# ---------------------------------------------------------------------------
# Helpers (same approach as test_spawn_levers.py, extended to also capture env)
# ---------------------------------------------------------------------------


def _make_mock_backend(spawn_raises=None):
    """Return a mock backend class whose .spawn() can be inspected or made to raise."""
    pty = MagicMock()
    pty.isalive.return_value = True
    pty.pid = 99999

    backend_cls = MagicMock()
    if spawn_raises:
        backend_cls.spawn.side_effect = spawn_raises
    else:
        backend_cls.spawn.return_value = pty
    backend_cls.__name__ = "MockBackend"
    return backend_cls, pty


def _call_create(mgr, backend_cls, **kwargs):
    """
    Call mgr.create_terminal() with the given kwargs, patching get_backend to
    avoid any real PTY spawn.  Returns (session, captured_cmd, captured_env).

    get_backend is imported locally inside create_terminal via
    ``from pty_backend import get_backend``, so we must patch at the source:
    ``pty_backend.get_backend``.
    """
    captured = {}

    original_spawn = backend_cls.spawn.side_effect

    def recording_spawn(cmd, **kw):
        captured["cmd"] = cmd
        captured["env"] = kw.get("env", {})
        if original_spawn:
            raise original_spawn if isinstance(original_spawn, Exception) else original_spawn()
        return backend_cls.spawn.return_value

    backend_cls.spawn.side_effect = recording_spawn

    with patch("pty_backend.get_backend", return_value=backend_cls):
        session = mgr.create_terminal(**kwargs)

    return session, captured.get("cmd", ""), captured.get("env", {})


_FAKE_KEY = "sk-or-test-key-1234"


# ---------------------------------------------------------------------------
# openrouter provider — cmd + env
# ---------------------------------------------------------------------------


class TestOpenRouterProviderCmdAndEnv:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_openrouter_cmd_has_no_model_flag(self):
        backend, _ = _make_mock_backend()
        with patch("pty_manager.settings_store.resolve_openrouter_key", return_value=(_FAKE_KEY, "ui")):
            _, cmd, _ = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="openrouter",
                provider_model="qwen/qwen3-coder-next",
            )
        assert "--model" not in cmd
        assert cmd.startswith("claude")

    def test_openrouter_env_has_all_five_vars(self):
        backend, _ = _make_mock_backend()
        with patch("pty_manager.settings_store.resolve_openrouter_key", return_value=(_FAKE_KEY, "ui")):
            _, _, env = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="openrouter",
                provider_model="qwen/qwen3-coder-next",
            )
        assert env["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api"
        assert env["ANTHROPIC_AUTH_TOKEN"] == _FAKE_KEY
        assert env["ANTHROPIC_API_KEY"] == ""
        assert env["ANTHROPIC_MODEL"] == "qwen/qwen3-coder-next"
        assert env["ANTHROPIC_SMALL_FAST_MODEL"] == "qwen/qwen3-coder-next"

    def test_openrouter_session_model_and_provider_fields(self):
        backend, _ = _make_mock_backend()
        with patch("pty_manager.settings_store.resolve_openrouter_key", return_value=(_FAKE_KEY, "ui")):
            session, _, _ = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="openrouter",
                provider_model="qwen/qwen3-coder-next",
            )
        # model field ignores the incoming `model` param and stores provider_model
        # for display, since the session actually runs that OpenRouter slug.
        assert session.model == "qwen/qwen3-coder-next"
        assert session.provider == "openrouter"


# ---------------------------------------------------------------------------
# anthropic provider — machine-global OpenRouter env vars must never leak in
# ---------------------------------------------------------------------------


class TestAnthropicProviderEnvIsolation:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_anthropic_env_excludes_openrouter_vars_even_if_globally_set(self, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://evil.example.com")
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "leaked-token")
        backend, _ = _make_mock_backend()
        _, cmd, env = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
        )
        assert "ANTHROPIC_BASE_URL" not in env
        assert "ANTHROPIC_AUTH_TOKEN" not in env
        assert "--model sonnet" in cmd

    def test_anthropic_session_provider_field_defaults(self):
        backend, _ = _make_mock_backend()
        session, _, _ = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
        )
        assert session.provider == "anthropic"
        assert session.model == "sonnet"


# ---------------------------------------------------------------------------
# Validation — ValueError before any spawn attempt
# ---------------------------------------------------------------------------


class TestOpenRouterValidation:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_missing_key_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("pty_manager.settings_store.resolve_openrouter_key", return_value=(None, None)):
            with patch("pty_backend.get_backend", return_value=backend):
                with pytest.raises(ValueError, match="OpenRouter key not configured"):
                    self.mgr.create_terminal(
                        name="t", workdir="C:\\Code",
                        model="sonnet",
                        provider="openrouter",
                        provider_model="qwen/qwen3-coder-next",
                    )
        backend.spawn.assert_not_called()

    def test_invalid_slug_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="Invalid provider_model slug"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    provider="openrouter",
                    provider_model="NoSlashHere",
                )
        backend.spawn.assert_not_called()

    def test_missing_provider_model_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="provider_model is required"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    provider="openrouter",
                    provider_model="",
                )
        backend.spawn.assert_not_called()

    def test_invalid_provider_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="Invalid provider"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    provider="openai",
                )
        backend.spawn.assert_not_called()


# ---------------------------------------------------------------------------
# effort / fast silently skipped for openrouter
# ---------------------------------------------------------------------------


class TestOpenRouterSkipsEffortAndFast:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_effort_and_fast_omitted_from_cmd(self):
        backend, _ = _make_mock_backend()
        with patch("pty_manager.settings_store.resolve_openrouter_key", return_value=(_FAKE_KEY, "ui")):
            _, cmd, _ = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                # 'opus' is ignored for openrouter but included here to prove the
                # Opus fast-mode gate can't fire it back on regardless.
                model="opus",
                provider="openrouter",
                provider_model="qwen/qwen3-coder-next",
                effort="high",
                fast=True,
            )
        assert "--effort" not in cmd
        assert "--settings" not in cmd


# ---------------------------------------------------------------------------
# Server route: POST /api/terminals forwards + echoes provider
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_terminals_forwards_provider_and_provider_model():
    """POST /api/terminals with provider='openrouter' + providerModel forwards both to create_terminal."""
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    captured = {}

    def fake_create_terminal(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop early")  # abort before spawn/sleep

    with patch("server.pty_manager.create_terminal", side_effect=fake_create_terminal):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as client:
            res = await client.post("/api/terminals", json={
                "name": "t",
                "workdir": "C:\\Code",
                "model": "sonnet",
                "provider": "openrouter",
                "providerModel": "qwen/qwen3-coder-next",
            })
    assert res.status_code == 500
    assert captured.get("provider") == "openrouter"
    assert captured.get("provider_model") == "qwen/qwen3-coder-next"


@pytest.mark.asyncio
async def test_post_terminals_defaults_provider_to_anthropic():
    """Omitted provider/providerModel body fields default to anthropic/""."""
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    captured = {}

    def fake_create_terminal(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop early")

    with patch("server.pty_manager.create_terminal", side_effect=fake_create_terminal):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as client:
            res = await client.post("/api/terminals", json={
                "name": "t",
                "workdir": "C:\\Code",
                "model": "sonnet",
            })
    assert res.status_code == 500
    assert captured.get("provider") == "anthropic"
    assert captured.get("provider_model") == ""


@pytest.mark.asyncio
async def test_post_terminals_missing_key_returns_500_with_error_string():
    """No dedicated ValueError -> 400 path exists for POST /api/terminals today.

    tests/test_spawn_levers.py's test_post_terminals_invalid_permission_mode_returns_500
    and test_post_terminals_invalid_effort_returns_500 both assert that an invalid-input
    ValueError from create_terminal() is caught by the route's broad `except Exception`
    and returned as a 500 (not 400). The missing-key ValueError is caught by that same
    generic handler, so it is 500 too -- this test documents that, matching the
    established pattern rather than introducing an inconsistent one-off 400.
    """
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    with patch(
        "server.pty_manager.create_terminal",
        side_effect=ValueError(
            "OpenRouter key not configured — add one via the key icon in the top bar or set OPENROUTER_API_KEY"
        ),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as client:
            res = await client.post("/api/terminals", json={
                "name": "t",
                "workdir": "C:\\Code",
                "model": "sonnet",
                "provider": "openrouter",
                "providerModel": "qwen/qwen3-coder-next",
            })
    assert res.status_code == 500
    data = res.json()
    assert "OpenRouter key not configured" in data["error"]


@pytest.mark.asyncio
async def test_post_terminals_success_echoes_provider_and_model():
    """Successful create response includes provider + the display model (session.model)."""
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    fake_pty = MagicMock()
    fake_pty.isalive.return_value = True
    fake_session = SimpleNamespace(
        id="abc123",
        name="t",
        model="qwen/qwen3-coder-next",
        provider="openrouter",
        created_at="2026-01-01T00:00:00Z",
        pty=fake_pty,
    )

    def _swallow_create_task(coro, *a, **kw):
        # Avoid scheduling a real _session_reader background task against a
        # session that doesn't actually exist in the real pty_manager
        # singleton -- close the coroutine instead of awaiting/discarding it
        # to avoid a "coroutine was never awaited" warning.
        coro.close()
        return MagicMock()

    with patch("server.pty_manager.create_terminal", return_value=fake_session), \
         patch("asyncio.sleep", new=AsyncMock()), \
         patch("server.asyncio.create_task", side_effect=_swallow_create_task):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as client:
            res = await client.post("/api/terminals", json={
                "name": "t",
                "workdir": "C:\\Code",
                "model": "sonnet",
                "provider": "openrouter",
                "providerModel": "qwen/qwen3-coder-next",
            })
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "openrouter"
    assert data["model"] == "qwen/qwen3-coder-next"


# ---------------------------------------------------------------------------
# Session-list dict includes provider
# ---------------------------------------------------------------------------


class TestSessionInfoIncludesProvider:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_list_terminals_includes_provider_for_openrouter_session(self):
        backend, _ = _make_mock_backend()
        with patch("pty_manager.settings_store.resolve_openrouter_key", return_value=(_FAKE_KEY, "ui")):
            _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="openrouter",
                provider_model="qwen/qwen3-coder-next",
            )
        listed = self.mgr.list_terminals()
        assert len(listed) == 1
        assert listed[0]["provider"] == "openrouter"
        assert listed[0]["model"] == "qwen/qwen3-coder-next"

    def test_list_terminals_includes_provider_for_anthropic_session(self):
        backend, _ = _make_mock_backend()
        _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
        )
        listed = self.mgr.list_terminals()
        assert len(listed) == 1
        assert listed[0]["provider"] == "anthropic"
        assert listed[0]["model"] == "sonnet"
