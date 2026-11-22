"""Regression tests for the idle gate and the PtyManager state ticker.

Contracts locked in:

1. ``_wait_for_idle_simple`` defaults to ``_MANUAL_WAIT_MAX`` (60 s), read at call time.

2. ``PtyManager`` has ``start_state_ticker`` / ``stop_state_ticker`` /
   ``_state_ticker_loop`` / ``_STATE_TICKER_INTERVAL`` / ``_state_ticker_task``.
   The loop ticks ALIVE sessions, skips dead ones, and survives tick() exceptions.

Mocking style matches test_bridge_manager.py / test_bridge_typing_gate.py.
"""

from __future__ import annotations

import asyncio
import sys
import os
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import bridge_manager as bm_module
from bridge_manager import _wait_for_idle_simple
from pty_manager import PtyManager


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_submit_delay(monkeypatch):
    """Zero the paste->submit gap module-wide.

    Injection is two writes separated by ``_SUBMIT_DELAY`` (1s in production)
    so the CR lands as a keypress rather than as pasted content.  Paying that
    second per injection would dominate this file's timing assertions.
    """
    monkeypatch.setattr(bm_module, "_SUBMIT_DELAY", 0)


def _make_mock_session(terminal_id="t1", name="Session", alive=True, tracker_state="idle"):
    """Build a mock TerminalSession with the fields bridge_manager reads."""
    s = MagicMock()
    s.id = terminal_id
    s.name = name
    s.alive = alive
    s.tracker = MagicMock()
    s.tracker.state = tracker_state
    s.claude_session_id = "claude-abc"
    s.working_dir = "/tmp"
    # last_user_input_time far in the past so typing gate never fires
    s.last_user_input_time = 0.0
    return s


# ===========================================================================
# Section E — PtyManager state ticker
# ===========================================================================


@pytest.mark.asyncio
async def test_state_ticker_ticks_alive_sessions_and_skips_dead(monkeypatch):
    """_state_ticker_loop calls tick() on alive sessions and skips dead ones."""
    mgr = PtyManager()

    # Two fake sessions: one alive, one dead
    alive_session = MagicMock()
    alive_session.alive = True
    alive_session.id = "alive-x"
    alive_session.tracker = MagicMock()

    dead_session = MagicMock()
    dead_session.alive = False
    dead_session.id = "dead-x"
    dead_session.tracker = MagicMock()

    mgr.sessions = {"alive-x": alive_session, "dead-x": dead_session}

    # Run exactly one tick by patching sleep to cancel after the first iteration
    iteration = {"count": 0}
    original_sleep = asyncio.sleep

    async def fast_sleep(delay):
        iteration["count"] += 1
        if iteration["count"] >= 2:
            raise asyncio.CancelledError()
        await original_sleep(0)  # yield without actual delay

    monkeypatch.setattr(asyncio, "sleep", fast_sleep)

    try:
        await mgr._state_ticker_loop()
    except asyncio.CancelledError:
        pass

    # Alive session must have been ticked
    alive_session.tracker.tick.assert_called()
    # Dead session must NOT have been ticked
    dead_session.tracker.tick.assert_not_called()


@pytest.mark.asyncio
async def test_state_ticker_continues_after_tick_exception(monkeypatch):
    """_state_ticker_loop survives a tick() exception and continues to other sessions."""
    mgr = PtyManager()

    bad_session = MagicMock()
    bad_session.alive = True
    bad_session.id = "bad-x"
    bad_session.tracker = MagicMock()
    bad_session.tracker.tick.side_effect = RuntimeError("boom")

    good_session = MagicMock()
    good_session.alive = True
    good_session.id = "good-x"
    good_session.tracker = MagicMock()

    # Ordered dict ensures bad_session is iterated before good_session
    mgr.sessions = {"bad-x": bad_session, "good-x": good_session}

    iteration = {"count": 0}
    original_sleep = asyncio.sleep

    async def fast_sleep(delay):
        iteration["count"] += 1
        if iteration["count"] >= 2:
            raise asyncio.CancelledError()
        await original_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", fast_sleep)

    try:
        await mgr._state_ticker_loop()
    except asyncio.CancelledError:
        pass

    # good_session must still have been ticked even though bad_session raised
    good_session.tracker.tick.assert_called()


@pytest.mark.asyncio
async def test_start_state_ticker_is_idempotent():
    """start_state_ticker() called twice does not spawn a second task."""
    mgr = PtyManager()

    # Must be called from a running event loop
    mgr.start_state_ticker()
    task_one = mgr._state_ticker_task
    assert task_one is not None

    mgr.start_state_ticker()
    task_two = mgr._state_ticker_task

    # Must be the same task object — not a new one
    assert task_one is task_two, (
        "Second call to start_state_ticker() spawned a new task; expected idempotent no-op"
    )

    # Cleanup
    await mgr.stop_state_ticker()


@pytest.mark.asyncio
async def test_stop_state_ticker_safe_when_never_started():
    """stop_state_ticker() is safe to call even if start_state_ticker() was never called."""
    mgr = PtyManager()
    # Should not raise
    await mgr.stop_state_ticker()


@pytest.mark.asyncio
async def test_state_ticker_task_attribute_exists():
    """PtyManager has the _state_ticker_task attribute at __init__ time."""
    mgr = PtyManager()
    assert hasattr(mgr, "_state_ticker_task"), "_state_ticker_task attribute must exist"
    assert mgr._state_ticker_task is None, "Must be None before start_state_ticker() is called"


def test_state_ticker_interval_constant():
    """_STATE_TICKER_INTERVAL constant exists on PtyManager."""
    assert hasattr(PtyManager, "_STATE_TICKER_INTERVAL"), (
        "_STATE_TICKER_INTERVAL class attribute must exist on PtyManager"
    )
    assert PtyManager._STATE_TICKER_INTERVAL > 0, (
        "_STATE_TICKER_INTERVAL must be positive (seconds)"
    )


# ===========================================================================
# Section F — V1 manual: _MANUAL_WAIT_MAX is 60s (not the old 10s)
# ===========================================================================


@pytest.mark.asyncio
async def test_manual_wait_max_is_60_seconds():
    """_MANUAL_WAIT_MAX must be 60.0 (not the old 10.0).

    The regression: the old 10s cap meant that any Claude turn longer than 10s
    returned "busy" to the user for V1 relays.  The fix raised this to 60s.
    """
    assert bm_module._MANUAL_WAIT_MAX == 60.0, (
        f"Expected _MANUAL_WAIT_MAX == 60.0, got {bm_module._MANUAL_WAIT_MAX}. "
        "Old code was 10.0, which caused spurious busy errors on normal Claude turns."
    )


@pytest.mark.asyncio
async def test_wait_for_idle_simple_uses_manual_wait_max_default(monkeypatch):
    """_wait_for_idle_simple with timeout=None reads _MANUAL_WAIT_MAX at call time.

    With a patched _MANUAL_WAIT_MAX of 0.08s and a session that becomes idle
    after 0.04s, the call should return True (not time out).
    This confirms the default is not baked in at function definition time.
    """
    # Tracker starts busy, switches to idle after a short delay
    calls_to_idle = {"n": 0}

    session = MagicMock()
    session.alive = True
    session.last_user_input_time = 0.0  # typing gate won't fire

    class _DynamicTracker:
        @property
        def state(self):
            calls_to_idle["n"] += 1
            # Return "idle" starting from the 3rd poll
            if calls_to_idle["n"] >= 3:
                return "idle"
            return "busy"

    session.tracker = _DynamicTracker()

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(bm_module, "_MANUAL_WAIT_MAX", 0.5)  # Enough time
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.02)

    result = await _wait_for_idle_simple("t1")

    assert result is True, (
        f"Expected True when session becomes idle within timeout, got {result!r}. "
        "This confirms _MANUAL_WAIT_MAX is read at call time."
    )


@pytest.mark.asyncio
async def test_wait_for_idle_simple_60s_is_enough_for_slow_peer(monkeypatch):
    """_wait_for_idle_simple returns True for a peer that takes ~30s to idle.

    Simulated by patching _MANUAL_WAIT_MAX to 0.3s and poll to 0.02s, with
    the session becoming idle after ~15 polls (0.15s into the window).
    """
    poll_count = {"n": 0}

    session = MagicMock()
    session.alive = True
    session.last_user_input_time = 0.0

    class _SlowTracker:
        @property
        def state(self):
            poll_count["n"] += 1
            # Becomes idle after 8 polls (well within 0.3s window)
            if poll_count["n"] >= 8:
                return "idle"
            return "busy"

    session.tracker = _SlowTracker()

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(bm_module, "_MANUAL_WAIT_MAX", 0.3)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.02)

    result = await _wait_for_idle_simple("t1")

    assert result is True, (
        f"Expected True for peer that idles within the window; got {result!r}. "
        "Old 10s cap would have failed here on real slow peers."
    )
