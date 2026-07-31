"""A failed PTY write must not be mistaken for a dead session.

REGRESSION (owner-reported, 1.12.0): pressing Escape after `/status` showed
"[Session ended]" in the pane. Claude Code was fine — its own transcript said
"Settings dialog dismissed" — and claude.exe was still running. What had
happened was that a transient write error set ``session.alive = False``
unconditionally, which:

  * made the WS forwarder print the "[Session ended]" banner,
  * left the pane refusing input,
  * and could never be purged, because the dead-session sweep requires BOTH
    ``not session.alive`` AND ``not pty.isalive()`` — and the process was up.

So the session became a zombie: reported dead, actually alive, unrecoverable.
Worse, the failure logged at DEBUG, so at the default INFO level it left no
trace at all — which is why the log looked clean while the owner was losing
sessions.

The rule these tests pin: **the process is the source of truth.** An I/O
failure fails that operation; only an exited process ends a session.
"""

from __future__ import annotations

import logging
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pty_manager import PtyManager  # noqa: E402


def _session(alive_flag=True, process_alive=True, write_raises=None):
    s = MagicMock()
    s.alive = alive_flag
    s.pty = MagicMock()
    s.pty.isalive.return_value = process_alive
    if write_raises is not None:
        s.pty.write.side_effect = write_raises
    else:
        s.pty.write.return_value = None  # ConPTY-style complete write
    return s


@pytest.fixture()
def mgr():
    m = PtyManager.__new__(PtyManager)
    m.sessions = {}
    return m


# ---------------------------------------------------------------------------
# The core rule
# ---------------------------------------------------------------------------

def test_write_error_with_live_process_does_not_kill_the_session(mgr):
    """The exact reported bug: a raising write must not end a live session."""
    s = _session(write_raises=OSError("pipe busy"))
    mgr.sessions["t1"] = s

    assert mgr._write_pty_sync("t1", "\x1b") is False, "the write itself fails"
    assert s.alive is True, (
        "session must stay alive — the process is still running, so this was a "
        "failed write, not a death"
    )


def test_write_error_with_exited_process_does_mark_dead(mgr):
    """The genuine case still works — this is not just 'never mark dead'."""
    s = _session(process_alive=False, write_raises=OSError("closed"))
    mgr.sessions["t1"] = s

    assert mgr._write_pty_sync("t1", "x") is False
    assert s.alive is False


def test_write_error_is_logged_visibly(mgr):
    """Must be visible at the default level.

    The original logged at DEBUG, so the one path that killed sessions was
    invisible in the shipped log — the owner was losing sessions while the log
    file looked clean.

    A direct handler is used rather than caplog because logging_config sets
    ``propagate = False`` on the root cockpit logger, so caplog's root-level
    capture never sees these records.
    """
    records = []

    class _Capture(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = _Capture()
    log = logging.getLogger("cockpit.pty")
    log.addHandler(handler)
    try:
        s = _session(write_raises=OSError("pipe busy"))
        mgr.sessions["t1"] = s
        mgr._write_pty_sync("t1", "x")
    finally:
        log.removeHandler(handler)

    assert records, "a failed write must leave a trace in the log"
    assert any(r.levelno >= logging.WARNING for r in records), (
        "must be WARNING or above — DEBUG is invisible in the shipped log"
    )


def test_unqueryable_pty_is_treated_as_dead(mgr):
    """If liveness cannot be determined, do not keep forwarding to it."""
    s = _session(write_raises=OSError("boom"))
    s.pty.isalive.side_effect = OSError("handle gone")
    mgr.sessions["t1"] = s

    mgr._write_pty_sync("t1", "x")
    assert s.alive is False


# ---------------------------------------------------------------------------
# Self-heal on reconnect
# ---------------------------------------------------------------------------

def test_resync_revives_a_session_wrongly_flagged_dead(mgr):
    """Someone already stuck in the zombie state recovers on reconnect."""
    s = _session(alive_flag=False, process_alive=True)
    mgr.sessions["t1"] = s

    assert mgr.resync_alive("t1") is True
    assert s.alive is True


def test_resync_marks_dead_when_the_process_really_exited(mgr):
    s = _session(alive_flag=True, process_alive=False)
    mgr.sessions["t1"] = s

    assert mgr.resync_alive("t1") is False
    assert s.alive is False


def test_resync_on_unknown_terminal_is_false_not_an_error(mgr):
    assert mgr.resync_alive("nope") is False


def test_resync_leaves_a_healthy_session_untouched(mgr):
    s = _session(alive_flag=True, process_alive=True)
    mgr.sessions["t1"] = s

    assert mgr.resync_alive("t1") is True
    assert s.alive is True


# ---------------------------------------------------------------------------
# The zombie state itself
# ---------------------------------------------------------------------------

def test_the_zombie_state_is_unreachable_via_a_failed_write(mgr):
    """alive=False while the process runs is what the purge cannot collect.

    `_purge_dead` requires both flags, so this combination is a session that
    can never be cleaned up and never be used. No write path may produce it.
    """
    s = _session(write_raises=RuntimeError("transient"))
    mgr.sessions["t1"] = s

    mgr._write_pty_sync("t1", "data")

    zombie = (s.alive is False) and (s.pty.isalive() is True)
    assert not zombie, "produced an unpurgeable, unusable session"
