"""Tests for per-session spawn-time levers: permission_mode, effort, fast.

Covers:
  - cmd-building logic in PtyManager.create_terminal()
  - allowlist validation (ValueError before spawn)
  - fast-mode temp-file cleanup on spawn failure
  - POST /api/terminals forwarding camelCase body fields
"""

import json
import os
import tempfile
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("MAX_SESSIONS", "8")

from pty_manager import PtyManager


# ---------------------------------------------------------------------------
# Helpers
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
    avoid any real PTY spawn.  Returns the (session, captured_cmd) tuple.

    get_backend is imported locally inside create_terminal via
    ``from pty_backend import get_backend``, so we must patch at the source:
    ``pty_backend.get_backend``.
    """
    captured = {}

    original_spawn = backend_cls.spawn.side_effect

    def recording_spawn(cmd, **kw):
        captured["cmd"] = cmd
        if original_spawn:
            raise original_spawn if isinstance(original_spawn, Exception) else original_spawn()
        return backend_cls.spawn.return_value

    backend_cls.spawn.side_effect = recording_spawn

    with patch("pty_backend.get_backend", return_value=backend_cls):
        session = mgr.create_terminal(**kwargs)

    return session, captured.get("cmd", "")


# ---------------------------------------------------------------------------
# permission_mode cmd-building
# ---------------------------------------------------------------------------


class TestPermissionModeCmd:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_plan_mode_adds_permission_mode_flag(self):
        """permission_mode='plan' → --permission-mode plan, NOT --dangerously-skip-permissions."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            permission_mode="plan",
        )
        assert "--permission-mode plan" in cmd
        assert "--dangerously-skip-permissions" not in cmd

    def test_bypass_via_permission_mode_string(self):
        """permission_mode='bypassPermissions' → --dangerously-skip-permissions, NOT --permission-mode."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            permission_mode="bypassPermissions",
            bypass_permissions=False,
        )
        assert "--dangerously-skip-permissions" in cmd
        assert "--permission-mode" not in cmd

    def test_bypass_flag_wins_over_permission_mode_plan(self):
        """bypass_permissions=True + permission_mode='plan' → only --dangerously-skip-permissions."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            bypass_permissions=True,
            permission_mode="plan",
        )
        assert "--dangerously-skip-permissions" in cmd
        assert "--permission-mode" not in cmd

    def test_default_permission_mode_adds_no_flags(self):
        """permission_mode='default' → neither --permission-mode nor --dangerously-skip-permissions."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            permission_mode="default",
        )
        assert "--permission-mode" not in cmd
        assert "--dangerously-skip-permissions" not in cmd

    def test_omitted_permission_mode_adds_no_flags(self):
        """Omitted permission_mode defaults to 'default' — no extra flags."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
        )
        assert "--permission-mode" not in cmd
        assert "--dangerously-skip-permissions" not in cmd

    def test_accept_edits_mode(self):
        """permission_mode='acceptEdits' → --permission-mode acceptEdits."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            permission_mode="acceptEdits",
        )
        assert "--permission-mode acceptEdits" in cmd
        assert "--dangerously-skip-permissions" not in cmd


# ---------------------------------------------------------------------------
# effort cmd-building
# ---------------------------------------------------------------------------


class TestEffortCmd:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_effort_high_adds_flag(self):
        """effort='high' → cmd contains --effort high."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            effort="high",
        )
        assert "--effort high" in cmd

    def test_effort_empty_omits_flag(self):
        """effort='' (default) → no --effort flag."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            effort="",
        )
        assert "--effort" not in cmd

    def test_effort_omitted_omits_flag(self):
        """effort not specified → no --effort flag."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
        )
        assert "--effort" not in cmd

    def test_effort_max(self):
        """effort='max' → --effort max in cmd."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            effort="max",
        )
        assert "--effort max" in cmd


# ---------------------------------------------------------------------------
# Allowlist validation — ValueError before spawn
# ---------------------------------------------------------------------------


class TestAllowlistValidation:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_invalid_permission_mode_raises_before_spawn(self):
        """Injected permission_mode string raises ValueError; spawn is never called."""
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="Invalid permission_mode"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    permission_mode="evil; rm -rf /",
                )
        # ValueError fires before get_backend is even called, so spawn is not reached.
        backend.spawn.assert_not_called()

    def test_invalid_effort_raises_before_spawn(self):
        """effort='ultra' (not in allowlist) raises ValueError; spawn is never called."""
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError, match="Invalid effort"):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    effort="ultra",
                )
        backend.spawn.assert_not_called()

    def test_invalid_permission_mode_with_spaces(self):
        """Permission mode containing a space is rejected."""
        backend, _ = _make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            with pytest.raises(ValueError):
                self.mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="sonnet",
                    permission_mode="plan --dangerously-skip-permissions",
                )


# ---------------------------------------------------------------------------
# fast mode cmd-building
# ---------------------------------------------------------------------------


class TestFastModeCmd:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_fast_opus_adds_settings_flag(self):
        """fast=True + opus model → --settings "<path>" in cmd; file contains fastMode:true."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="claude-opus-4-8",
            fast=True,
        )
        assert '--settings "' in cmd

        # Confirm the path is present in the cmd string (between the double quotes after --settings)
        import re
        m = re.search(r'--settings "([^"]+)"', cmd)
        assert m, f"Could not extract --settings path from: {cmd!r}"

        # The file should no longer exist (cleanup runs post-spawn in server.py),
        # but the session stores the path so we can check what was written.
        # Since create_terminal succeeded, session._fast_settings_path is set.
        session = list(self.mgr.sessions.values())[-1]
        path = session._fast_settings_path
        assert path is not None
        assert os.path.isfile(path), "Settings temp file should still exist (server.py cleans it up)"
        with open(path) as f:
            data = json.load(f)
        assert data == {"fastMode": True}

    def test_fast_opus_settings_path_is_single_shlex_token(self):
        """The --settings value is double-quoted so spaces in %TEMP% don't split the token."""
        import shlex
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="claude-opus-4-8",
            fast=True,
        )
        assert '--settings "' in cmd
        # On POSIX shlex, double-quoted path is a single token.
        # We strip the outer quotes to check no extra splitting happens.
        tokens = shlex.split(cmd, posix=True)
        settings_idx = tokens.index("--settings")
        path_token = tokens[settings_idx + 1]
        # It must be a non-empty string with no whitespace of its own
        assert path_token and " " not in path_token

    def test_fast_true_with_generic_opus_model(self):
        """fast=True + bare 'opus' model id (contains 'opus') → --settings in cmd."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="opus",
            fast=True,
        )
        assert '--settings "' in cmd

    def test_fast_non_opus_no_settings(self):
        """fast=True + non-Opus model → no --settings flag."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="sonnet",
            fast=True,
        )
        assert "--settings" not in cmd

    def test_fast_false_no_settings(self):
        """fast=False (default) → no --settings flag even for Opus."""
        backend, _ = _make_mock_backend()
        _, cmd = _call_create(
            self.mgr, backend,
            name="t", workdir="C:\\Code",
            model="claude-opus-4-8",
            fast=False,
        )
        assert "--settings" not in cmd

    def test_fast_spawn_failure_cleans_up_temp_file(self):
        """Spawn failure with fast=True+Opus → temp file is deleted; exception propagates."""
        mgr = PtyManager()
        backend_cls = MagicMock()
        backend_cls.__name__ = "MockBackend"
        backend_cls.spawn.side_effect = RuntimeError("spawn failed")

        created_paths = []

        # Patch tempfile.mkstemp to record the path before the original creates it
        original_mkstemp = tempfile.mkstemp

        def recording_mkstemp(**kwargs):
            fd, path = original_mkstemp(**kwargs)
            created_paths.append(path)
            return fd, path

        with patch("pty_backend.get_backend", return_value=backend_cls), \
             patch("tempfile.mkstemp", side_effect=recording_mkstemp):
            with pytest.raises(RuntimeError, match="spawn failed"):
                mgr.create_terminal(
                    name="t", workdir="C:\\Code",
                    model="claude-opus-4-8",
                    fast=True,
                )

        # The temp file must have been created and then cleaned up
        assert len(created_paths) >= 1, "mkstemp was never called — fast-mode path not exercised"
        for path in created_paths:
            assert not os.path.isfile(path), (
                f"Temp fast-mode settings file was NOT cleaned up after spawn failure: {path}"
            )


# ---------------------------------------------------------------------------
# Server route: POST /api/terminals forwards camelCase fields
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_terminals_forwards_permission_mode():
    """POST /api/terminals with permissionMode='plan' passes it to create_terminal."""
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    captured = {}

    def fake_create_terminal(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop early")  # abort before spawn

    with patch("server.pty_manager.create_terminal", side_effect=fake_create_terminal):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as client:
            res = await client.post("/api/terminals", json={
                "name": "t",
                "workdir": "C:\\Code",
                "model": "sonnet",
                "permissionMode": "plan",
                "effort": "high",
                "fast": False,
            })
    # Route returns 500 (fake_create_terminal raised), but we can check captured kwargs
    assert res.status_code == 500
    assert captured.get("permission_mode") == "plan"
    assert captured.get("effort") == "high"
    assert captured.get("fast") is False


@pytest.mark.asyncio
async def test_post_terminals_forwards_fast_true():
    """POST /api/terminals with fast=True passes it to create_terminal."""
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
                "model": "claude-opus-4-8",
                "permissionMode": "default",
                "effort": "",
                "fast": True,
            })
    assert res.status_code == 500
    assert captured.get("fast") is True
    assert captured.get("permission_mode") == "default"


@pytest.mark.asyncio
async def test_post_terminals_invalid_permission_mode_returns_500():
    """POST /api/terminals with invalid permissionMode → ValueError → 500 response."""
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as client:
        res = await client.post("/api/terminals", json={
            "name": "t",
            "workdir": "C:\\Code",
            "model": "sonnet",
            "permissionMode": "evil; rm -rf /",
        })
    # ValueError is caught by the broad except in the route → 500
    assert res.status_code == 500
    data = res.json()
    assert "error" in data


@pytest.mark.asyncio
async def test_post_terminals_invalid_effort_returns_500():
    """POST /api/terminals with invalid effort → ValueError → 500 response."""
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as client:
        res = await client.post("/api/terminals", json={
            "name": "t",
            "workdir": "C:\\Code",
            "model": "sonnet",
            "effort": "ultra",
        })
    assert res.status_code == 500
    data = res.json()
    assert "error" in data
