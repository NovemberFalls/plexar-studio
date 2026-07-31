"""Tests for PtyManager — session management logic with mocked PTY processes."""

import os
from unittest.mock import MagicMock, patch

import pytest

# Set MAX_SESSIONS before import
os.environ.setdefault("MAX_SESSIONS", "3")

from pty_manager import PtyManager, TerminalSession


def make_mock_session(terminal_id="test1", alive=True):
    """Create a mock TerminalSession."""
    pty = MagicMock()
    pty.isalive.return_value = alive
    return TerminalSession(
        id=terminal_id,
        name=f"Test {terminal_id}",
        pty=pty,
        created_at="2026-01-01T00:00:00Z",
        model="sonnet",
        working_dir="C:\\Code",
    )


class TestPtyManager:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_kill_terminal_removes_session(self):
        session = make_mock_session("abc")
        self.mgr.sessions["abc"] = session
        assert self.mgr.kill_terminal("abc") is True
        assert "abc" not in self.mgr.sessions

    def test_kill_nonexistent_returns_false(self):
        assert self.mgr.kill_terminal("nonexistent") is False

    def test_list_terminals_marks_dead_but_keeps_them(self):
        alive = make_mock_session("alive1", alive=True)
        dead = make_mock_session("dead1", alive=False)
        self.mgr.sessions["alive1"] = alive
        self.mgr.sessions["dead1"] = dead
        result = self.mgr.list_terminals()
        # list_terminals no longer purges dead sessions (avoids race conditions).
        # It returns all sessions with their alive flag set correctly.
        assert len(result) == 2
        by_id = {r["id"]: r for r in result}
        assert by_id["alive1"]["alive"] is True
        assert by_id["dead1"]["alive"] is False
        # Dead session is still in the dict (cleaned up by kill_terminal)
        assert "dead1" in self.mgr.sessions

    def test_get_terminal_marks_dead(self):
        session = make_mock_session("test1", alive=False)
        self.mgr.sessions["test1"] = session
        result = self.mgr.get_terminal("test1")
        assert result is not None
        assert result.alive is False

    def test_get_nonexistent_returns_none(self):
        assert self.mgr.get_terminal("nope") is None

    def test_max_sessions_limit(self):
        import pty_manager as _pm
        original = _pm.MAX_SESSIONS
        try:
            _pm.MAX_SESSIONS = 3
            for i in range(3):
                self.mgr.sessions[f"s{i}"] = make_mock_session(f"s{i}")
            with pytest.raises(RuntimeError, match="Maximum session limit"):
                self.mgr.create_terminal(name="overflow", workdir="C:\\Code")
        finally:
            _pm.MAX_SESSIONS = original

    def test_write_pty_dead_session(self):
        session = make_mock_session("dead", alive=False)
        self.mgr.sessions["dead"] = session
        assert self.mgr.write_pty("dead", "hello") is False

    def test_write_pty_nonexistent(self):
        assert self.mgr.write_pty("nope", "hello") is False

    def test_shutdown_kills_all(self):
        for i in range(3):
            self.mgr.sessions[f"s{i}"] = make_mock_session(f"s{i}")
        self.mgr.shutdown()
        assert len(self.mgr.sessions) == 0


class TestWritePtySync:
    """Unit tests for _write_pty_sync partial-write handling."""

    def setup_method(self):
        self.mgr = PtyManager()

    def _add_session(self, terminal_id="t1", alive=True):
        session = make_mock_session(terminal_id, alive=alive)
        self.mgr.sessions[terminal_id] = session
        return session

    def test_full_write_succeeds(self):
        """write() returns full byte count — no retry, returns True."""
        session = self._add_session("t1")
        data = "hello"
        session.pty.write.return_value = len(data.encode("utf-8"))
        assert self.mgr._write_pty_sync("t1", data) is True
        session.pty.write.assert_called_once_with(data)

    def test_partial_write_retries_and_succeeds(self):
        """write() returns partial on first call, remainder on second — retries and returns True."""
        session = self._add_session("t1")
        data = "hello"
        data_bytes = data.encode("utf-8")
        # First call: write 3 bytes, second call: write remaining 2
        session.pty.write.side_effect = [3, len(data_bytes) - 3]
        assert self.mgr._write_pty_sync("t1", data) is True
        assert session.pty.write.call_count == 2
        # Second call must receive only the remaining substring "lo"
        assert session.pty.write.call_args_list[1][0][0] == "lo"

    def test_zero_byte_write_returns_false(self):
        """write() returns 0 — bail immediately, return False."""
        session = self._add_session("t1")
        session.pty.write.return_value = 0
        assert self.mgr._write_pty_sync("t1", "hello") is False

    def test_none_return_conpty_compat_succeeds(self):
        """write() returns None (ConPTY style) — treat as complete, return True."""
        session = self._add_session("t1")
        session.pty.write.return_value = None
        assert self.mgr._write_pty_sync("t1", "hello") is True
        session.pty.write.assert_called_once()

    def test_safety_valve_trips_on_persistent_partial(self):
        """write() consistently returns 1 byte — safety valve fires at 50 retries, returns False."""
        session = self._add_session("t1")
        # Each call writes only 1 byte — triggers safety valve before completing
        session.pty.write.return_value = 1
        # Use a string long enough that 50 single-byte writes won't finish it
        data = "a" * 100
        assert self.mgr._write_pty_sync("t1", data) is False
        assert session.pty.write.call_count == 50

    def test_session_not_found_returns_false(self):
        """No session registered — returns False without error."""
        assert self.mgr._write_pty_sync("nonexistent", "hi") is False

    def test_dead_session_returns_false(self):
        """isalive() returns False — marks alive=False, returns False."""
        session = self._add_session("t1", alive=False)
        assert self.mgr._write_pty_sync("t1", "hi") is False
        assert session.alive is False

    def test_exception_with_live_process_fails_the_write_but_keeps_the_session(self):
        """write() raises but the process is alive — fail the write, not the session.

        CONTRACT CHANGE (was: any exception marked the session dead). That older
        behaviour is the owner-reported "[Session ended]" bug: a transient write
        error killed a session whose claude.exe was still running, and because
        the dead-session purge requires the process to be gone too, the result
        was an unpurgeable, unusable pane. See tests/test_pty_liveness.py.
        """
        session = self._add_session("t1")
        session.pty.write.side_effect = OSError("pipe broken")
        result = self.mgr._write_pty_sync("t1", "hello")
        assert result is False
        assert session.alive is True

    def test_exception_with_exited_process_marks_session_dead(self):
        """write() raises AND the process has exited — genuinely dead."""
        session = self._add_session("t1")
        session.pty.write.side_effect = OSError("pipe broken")
        session.pty.isalive.return_value = False
        assert self.mgr._write_pty_sync("t1", "hello") is False
        assert session.alive is False

    def test_multibyte_partial_write_at_clean_boundary(self):
        """Partial write that stops at a clean UTF-8 boundary retries and succeeds.

        "café" encodes to 5 bytes: b'c'=1, b'a'=1, b'f'=1, b'\\xc3\\xa9'=2.
        First write returns 3 (all of "caf"), second returns 2 (all of "é").
        """
        session = self._add_session("t1")
        data = "café"
        # First call: 3 bytes (b"caf"), second call: 2 bytes (b"\xc3\xa9")
        session.pty.write.side_effect = [3, 2]
        assert self.mgr._write_pty_sync("t1", data) is True
        assert session.pty.write.call_count == 2
        # Second call must receive the remaining string "é"
        assert session.pty.write.call_args_list[1][0][0] == "é"

    def test_multibyte_partial_write_splits_character(self):
        """Partial write that splits a multi-byte UTF-8 character returns False.

        "café" encodes to 5 bytes. If write() returns 4, the remaining byte
        b'\\xa9' is the second byte of the two-byte sequence for 'é' — it cannot
        be decoded as valid UTF-8 on its own, so the method must log a warning
        and return False rather than silently dropping the byte.
        """
        session = self._add_session("t1")
        data = "café"
        # First call: 4 bytes — splits 'é' (b"\xc3\xa9") mid-character
        session.pty.write.side_effect = [4]
        assert self.mgr._write_pty_sync("t1", data) is False


class TestSpawnEnvDisablesAutoupdater:
    """DISABLE_AUTOUPDATER=1 must reach the PTY backend's env for every spawn.

    Claude Code's built-in auto-updater can never win against up to
    MAX_SESSIONS concurrent cockpit-spawned claude.exe processes all holding
    a handle on the binary, so every session logs a spurious "Auto-update
    failed" message. Cockpit disables the updater in the child env instead.
    """

    def setup_method(self):
        self.mgr = PtyManager()

    def _make_mock_backend(self):
        pty = MagicMock()
        pty.isalive.return_value = True
        pty.pid = 99999
        backend_cls = MagicMock()
        backend_cls.spawn.return_value = pty
        backend_cls.__name__ = "MockBackend"
        return backend_cls

    def test_spawn_env_sets_disable_autoupdater(self):
        """create_terminal() passes env with DISABLE_AUTOUPDATER=1 to backend.spawn()."""
        backend = self._make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            self.mgr.create_terminal(name="t", workdir="C:\\Code", model="sonnet")
        backend.spawn.assert_called_once()
        _, kwargs = backend.spawn.call_args
        assert kwargs["env"]["DISABLE_AUTOUPDATER"] == "1"

    def test_spawn_env_does_not_mutate_parent_os_environ(self, monkeypatch):
        """The env override is scoped to the child's env dict, not os.environ.

        The var is removed from the ambient environment first: when the test
        suite itself runs inside a cockpit-spawned session, the parent already
        set DISABLE_AUTOUPDATER=1 and the old precondition assert flaked.
        """
        monkeypatch.delenv("DISABLE_AUTOUPDATER", raising=False)
        backend = self._make_mock_backend()
        with patch("pty_backend.get_backend", return_value=backend):
            self.mgr.create_terminal(name="t", workdir="C:\\Code", model="sonnet")
        assert "DISABLE_AUTOUPDATER" not in os.environ


class TestKillProcessTree:
    """Regression tests for PtyManager._kill_process_tree.

    Bug: the original ``except (ImportError, psutil.NoSuchProcess):`` tuple
    referenced ``psutil.NoSuchProcess`` in the same except-clause that guards
    the ``import psutil`` statement itself. When the import raises
    ImportError, ``psutil`` is never bound in that scope — but Python must
    still evaluate the except tuple to check the match, which raises
    NameError and masks the original ImportError. That crashes the whole
    cleanup path instead of degrading gracefully.
    """

    def test_import_error_degrades_gracefully(self, monkeypatch):
        """psutil unavailable (ImportError) — must not raise NameError, just return."""
        import sys

        # sys.modules[name] = None is the standard trick to force the next
        # `import psutil` statement to raise ImportError without needing the
        # package to actually be uninstalled.
        monkeypatch.setitem(sys.modules, "psutil", None)

        # Must return cleanly (None) — no NameError, no other exception.
        assert PtyManager._kill_process_tree(12345) is None

    def test_parent_process_gone_degrades_gracefully(self):
        """psutil available but the parent process already exited — no crash."""
        import psutil

        with patch("psutil.Process", side_effect=psutil.NoSuchProcess(99999)):
            assert PtyManager._kill_process_tree(99999) is None

    def test_kills_children_when_parent_alive(self):
        """Normal path: parent found, all children killed."""
        mock_parent = MagicMock()
        child1 = MagicMock()
        child2 = MagicMock()
        mock_parent.children.return_value = [child1, child2]

        with patch("psutil.Process", return_value=mock_parent):
            assert PtyManager._kill_process_tree(1) is None
        child1.kill.assert_called_once()
        child2.kill.assert_called_once()

    def test_child_already_gone_is_swallowed(self):
        """A child that vanishes mid-kill (NoSuchProcess) does not abort the loop."""
        import psutil

        mock_parent = MagicMock()
        gone_child = MagicMock()
        gone_child.kill.side_effect = psutil.NoSuchProcess(1)
        alive_child = MagicMock()
        mock_parent.children.return_value = [gone_child, alive_child]

        with patch("psutil.Process", return_value=mock_parent):
            assert PtyManager._kill_process_tree(1) is None
        alive_child.kill.assert_called_once()
