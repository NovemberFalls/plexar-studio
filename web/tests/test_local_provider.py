"""Tests for the Tier 2 provider="local" launch path (LM Studio / vLLM).

Covers:
  - PtyManager.create_terminal() provider="local": env carries the local
    vars (base URL resolved via server.resolve_local_base_url, dummy auth
    token, cleared API key, ANTHROPIC_MODEL = parsed model id,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000), cmd omits --model
  - lmstudio-local resolves to the broker URL; vllm-local resolves to
    cockpit's own /shim/vllm path
  - Regression: provider="anthropic" still strips ANTHROPIC_BASE_URL /
    ANTHROPIC_AUTH_TOKEN from a machine-global env even after the
    blocked_keys guard was widened to exempt "local" alongside "openrouter"
  - Validation ValueErrors fire before any spawn attempt: unknown local
    provider id, missing providerModel, malformed providerModel (no "::")
"""

import os
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("MAX_SESSIONS", "8")

from pty_manager import PtyManager


def _make_mock_backend(spawn_raises=None):
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
    captured = {}
    original_spawn = backend_cls.spawn.side_effect

    def recording_spawn(cmd, **kw):
        captured["cmd"] = cmd
        captured["env"] = kw.get("env", {})
        if original_spawn:
            raise original_spawn if isinstance(original_spawn, Exception) else original_spawn()
        return backend_cls.spawn.return_value

    backend_cls.spawn.side_effect = recording_spawn

    # Command-building tests own CLI discovery as well as the mocked process.
    with patch("pty_backend.get_backend", return_value=backend_cls), \
         patch("pty_manager.resolve_claude_cli", side_effect=lambda path: ("claude", path)):
        session = mgr.create_terminal(**kwargs)

    return session, captured.get("cmd", ""), captured.get("env", {})


# ---------------------------------------------------------------------------
# local provider — cmd + env (LM Studio)
# ---------------------------------------------------------------------------


class TestLocalProviderCmdAndEnv:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_local_lmstudio_cmd_has_no_model_flag(self):
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:1235"):
            _, cmd, _ = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="local",
                provider_model="lmstudio-local::qwen3-coder-30b",
            )
        assert "--model" not in cmd
        assert cmd.startswith("claude")

    def test_local_lmstudio_env_has_all_vars(self):
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:1235"):
            _, _, env = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="local",
                provider_model="lmstudio-local::qwen3-coder-30b",
            )
        assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:1235"
        assert env["ANTHROPIC_AUTH_TOKEN"] == "local"
        assert env["ANTHROPIC_API_KEY"] == ""
        assert env["ANTHROPIC_MODEL"] == "qwen3-coder-30b"
        assert env["ANTHROPIC_SMALL_FAST_MODEL"] == "qwen3-coder-30b"
        assert env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "8000"

    def test_local_session_model_and_provider_fields(self):
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:1235"):
            session, _, _ = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="local",
                provider_model="lmstudio-local::qwen3-coder-30b",
            )
        assert session.model == "qwen3-coder-30b"
        assert session.provider == "local"

    def test_local_PASSES_effort_through(self):
        """This test used to assert the OPPOSITE ("local skips effort"), pinning a
        premise that was false. Measured 2026-09-22 against a Plexar rig: --effort
        low/medium -> OK, high -> the engine's own 400 naming its supported set.
        Skipping the flag did not mean no effort was sent -- the CLI fell back to
        the USER's Claude Code config, so a user configured for `high` got a 400
        on every turn while Studio's pill read "low"."""
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:1235"):
            _, cmd, _ = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="opus",
                provider="local",
                provider_model="lmstudio-local::qwen3-coder-30b",
                effort="low",
            )
        assert "--effort low" in cmd

    def test_local_effort_is_passed_VERBATIM_not_remapped(self):
        """A choice the engine refuses must surface the engine's own error, not be
        silently swapped for a neighbour it accepts (the R-169 shape)."""
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:1235"):
            _, cmd, _ = _call_create(
                self.mgr, backend, name="t", workdir="C:\\Code", model="opus",
                provider="local", provider_model="lmstudio-local::qwen3-coder-30b",
                effort="high",
            )
        assert "--effort high" in cmd

    def test_local_still_skips_fast_mode(self):
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:1235"):
            _, cmd, _ = _call_create(
                self.mgr, backend, name="t", workdir="C:\\Code", model="opus",
                provider="local", provider_model="lmstudio-local::qwen3-coder-30b",
                fast=True,
            )
        assert "--settings" not in cmd

    def test_model_id_containing_double_colon_splits_on_first_separator_only(self):
        # providerModel = "lmstudio-local::foo::v2" — split on the FIRST "::"
        # so a model id that itself contains "::" resolves to "foo::v2", not
        # truncated at the first occurrence.
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:1235"):
            session, cmd, env = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="local",
                provider_model="lmstudio-local::foo::v2",
            )
        assert env["ANTHROPIC_MODEL"] == "foo::v2"
        assert env["ANTHROPIC_SMALL_FAST_MODEL"] == "foo::v2"
        assert session.model == "foo::v2"
        assert "--model" not in cmd


# ---------------------------------------------------------------------------
# vLLM resolves to cockpit's own /shim/vllm path, not vLLM's direct port
# ---------------------------------------------------------------------------


class TestLocalProviderVllmResolution:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_vllm_base_url_uses_cockpit_shim_path(self):
        import server as _server
        # Exercise the real resolver (not mocked) to prove the seam itself
        # points at cockpit's own port + /shim/vllm, never vLLM's :8001 port
        # directly (vLLM is OpenAI-only and would 404 an Anthropic call).
        with patch.dict(os.environ, {"PORT": "8420"}):
            url = _server.resolve_local_base_url("vllm-local")
        assert url == "http://127.0.0.1:8420/shim/vllm"
        assert ":8001" not in url

    def test_local_vllm_env_uses_shim_base_url(self):
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value="http://127.0.0.1:8420/shim/vllm"):
            _, _, env = _call_create(
                self.mgr, backend,
                name="t", workdir="C:\\Code",
                model="sonnet",
                provider="local",
                provider_model="vllm-local::qwen3-coder-30b-awq",
            )
        assert env["ANTHROPIC_BASE_URL"] == "http://127.0.0.1:8420/shim/vllm"
        assert env["ANTHROPIC_MODEL"] == "qwen3-coder-30b-awq"
        assert env["ANTHROPIC_SMALL_FAST_MODEL"] == "qwen3-coder-30b-awq"


# ---------------------------------------------------------------------------
# Regression: the blocked_keys guard still isolates anthropic panes
# ---------------------------------------------------------------------------


class TestAnthropicProviderEnvIsolationRegression:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_anthropic_env_excludes_local_vars_even_if_globally_set(self, monkeypatch):
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


# ---------------------------------------------------------------------------
# Validation — ValueError before any spawn attempt
# ---------------------------------------------------------------------------


class TestLocalProviderValidation:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_unknown_local_provider_id_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("server.resolve_local_base_url", return_value=None):
            with patch("pty_backend.get_backend", return_value=backend):
                with pytest.raises(ValueError, match="Unknown or non-local provider id"):
                    self.mgr.create_terminal(
                        name="t", workdir="C:\\Code",
                        model="sonnet",
                        provider="local",
                        provider_model="totally-bogus::some-model",
                    )
        backend.spawn.assert_not_called()

    def test_missing_provider_model_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="provider_model is required"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    provider="local",
                    provider_model="",
                )
        backend.spawn.assert_not_called()

    def test_malformed_provider_model_no_separator_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="Invalid provider_model"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    provider="local",
                    provider_model="no-separator-here",
                )
        backend.spawn.assert_not_called()

    def test_invalid_local_model_id_raises_before_spawn(self):
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="Invalid local model id"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    provider="local",
                    provider_model="lmstudio-local:: --dangerously-skip-permissions",
                )
        backend.spawn.assert_not_called()

    def test_remote_scoped_provider_rejected_by_real_resolver(self):
        """resolve_local_base_url() itself (not mocked) must reject a
        remote-scoped provider id — a remote-scoped entry (e.g. someone's
        hosted LM Studio/vLLM) must never become a session's live
        ANTHROPIC_BASE_URL via this path. Adds a temporary remote-scoped
        entry to the real registry rather than mocking the resolver, so this
        proves the scope check inside resolve_local_base_url itself.
        """
        import server as _server

        _server._PROVIDERS["remote-test-provider"] = {
            "id": "remote-test-provider", "label": "Remote test", "kind": "lmstudio",
            "scope": "remote",
            "broker_url": "https://example.com:1235",
            "management_url": "https://example.com:1234",
            "auth": {"type": "none"},
            "capabilities": ["queue", "metrics", "models", "traces", "health"],
        }
        try:
            assert _server.resolve_local_base_url("remote-test-provider") is None

            backend, _ = _make_mock_backend()
            with patch("pty_backend.get_backend", return_value=backend):
                with pytest.raises(ValueError, match="Unknown or non-local provider id"):
                    self.mgr.create_terminal(
                        name="t", workdir="C:\\Code",
                        model="sonnet",
                        provider="local",
                        provider_model="remote-test-provider::some-model",
                    )
            backend.spawn.assert_not_called()
        finally:
            del _server._PROVIDERS["remote-test-provider"]
