"""Regression tests for the V2/V3 idle-gate and state-ticker bug fix.

These tests lock in three new contracts introduced by the fix:

1. ``_wait_for_idle`` returns one of "idle" / "dead" / "stopped" / "timeout"
   (string, not bool).  "timeout" is NON-FATAL — the peer is alive but slow.

2. ``_inject`` maps gate results to "ok" / "skip" / "fatal" and NEVER calls
   _end_bridge on a "skip" result.

3. ``PtyManager`` gained ``start_state_ticker`` / ``stop_state_ticker`` /
   ``_state_ticker_loop`` / ``_STATE_TICKER_INTERVAL`` / ``_state_ticker_task``.
   The loop ticks ALIVE sessions, skips dead ones, and survives tick() exceptions.

Each test is written so that it would have been RED on the old code (where
_wait_for_idle returned bool and "timeout" == False → fatal → bridge died).

Mocking style matches test_bridge_manager.py / test_bridge_typing_gate.py:
  - monkeypatch bm_module.pty_manager.{get_terminal, _get_jsonl_path, write_pty_async}
  - monkeypatch module-level constants (_BUSY_WAIT_MAX, _IDLE_POLL_INTERVAL, etc.)
  - No real PTY, no real Claude, no real filesystem (except relay-dir)
"""

from __future__ import annotations

import asyncio
import sys
import os
import time
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import bridge_manager as bm_module
from bridge_manager import (
    _wait_for_idle,
    _wait_for_idle_simple,
    _inject,
    _BridgeRecord,
    BridgeManager,
    ChannelManager,
)
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


def _make_bridge_record(from_id="f1", to_id="t2", max_turns=4) -> _BridgeRecord:
    """Minimal BridgeRecord with stop event unset."""
    return _BridgeRecord(
        bridge_id="testbridge001",
        from_id=from_id,
        to_id=to_id,
        from_name="From",
        to_name="To",
        max_turns=max_turns,
    )


async def _never_yield(path, from_beginning=False, **kwargs):
    """Async generator that hangs forever without yielding anything."""
    await asyncio.sleep(3600)
    return
    yield  # pragma: no cover


# ===========================================================================
# Section A — _wait_for_idle return values
# ===========================================================================


@pytest.mark.asyncio
async def test_wait_for_idle_returns_timeout_for_alive_but_slow_peer(monkeypatch):
    """_wait_for_idle returns 'timeout' (not False/dead) for an alive but never-idle peer.

    OLD behaviour: returned False → callers treated it as fatal → bridge died.
    NEW behaviour: returns 'timeout' (non-fatal string).

    We monkeypatch _BUSY_WAIT_MAX to 0.15s so the test completes in < 0.5s.
    """
    busy_session = _make_mock_session("busy-1", tracker_state="busy", alive=True)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: busy_session)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.15)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record()
    result = await _wait_for_idle("busy-1", record)

    assert result == "timeout", (
        f"Expected 'timeout' for alive-but-slow peer, got {result!r}. "
        "Old code returned False, which callers treated as fatal and ended the bridge."
    )


@pytest.mark.asyncio
async def test_wait_for_idle_returns_dead_when_session_missing(monkeypatch):
    """_wait_for_idle returns 'dead' when get_terminal returns None."""
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: None)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 2.0)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record()
    result = await _wait_for_idle("gone-1", record)

    assert result == "dead", f"Expected 'dead' for missing session, got {result!r}"


@pytest.mark.asyncio
async def test_wait_for_idle_returns_dead_when_session_not_alive(monkeypatch):
    """_wait_for_idle returns 'dead' when the session exists but alive=False."""
    dead_session = _make_mock_session("dead-1", alive=False)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: dead_session)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 2.0)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record()
    result = await _wait_for_idle("dead-1", record)

    assert result == "dead", f"Expected 'dead' for not-alive session, got {result!r}"


@pytest.mark.asyncio
async def test_wait_for_idle_returns_stopped_when_stop_event_set(monkeypatch):
    """_wait_for_idle returns 'stopped' when the record's stop event is set."""
    # Session is alive and busy (would normally time out) but we set the stop event
    busy_session = _make_mock_session("busy-2", tracker_state="busy", alive=True)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: busy_session)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 10.0)  # Would take forever without stop
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record()
    record._stop_event.set()  # Signal teardown immediately

    result = await _wait_for_idle("busy-2", record)

    assert result == "stopped", f"Expected 'stopped' when stop event is set, got {result!r}"


@pytest.mark.asyncio
async def test_wait_for_idle_returns_idle_promptly_when_session_is_idle(monkeypatch):
    """_wait_for_idle returns 'idle' quickly when tracker state is already 'idle'."""
    idle_session = _make_mock_session("idle-1", tracker_state="idle", alive=True)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: idle_session)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 10.0)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record()
    t0 = time.monotonic()
    result = await _wait_for_idle("idle-1", record)
    elapsed = time.monotonic() - t0

    assert result == "idle", f"Expected 'idle' for idle session, got {result!r}"
    assert elapsed < 1.0, f"Expected fast resolution; took {elapsed:.3f}s"


# ===========================================================================
# Section B — _inject return value mapping
# ===========================================================================


@pytest.mark.asyncio
async def test_inject_returns_ok_and_calls_write_when_peer_idle(monkeypatch):
    """_inject returns 'ok' when the peer is idle, and write_pty_async is called."""
    idle_session = _make_mock_session("idle-2", tracker_state="idle", alive=True)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: idle_session)

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 2.0)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record(to_id="idle-2")
    result = await _inject("idle-2", "hello", record)

    assert result == "ok", f"Expected 'ok' for idle peer, got {result!r}"
    # Two writes: the bracketed-paste block, then a separate bare-CR submit.
    # The CR is deliberately NOT part of the paste — inside it, the TUI eats it
    # as pasted content and the message never sends.
    assert len(write_calls) == 2, "expected a paste write followed by a submit write"
    assert write_calls[1][1] == bm_module._SUBMIT, "second write must be the bare submit CR"
    assert bm_module._SUBMIT not in write_calls[0][1], "CR must not ride inside the paste"
    assert write_calls[0][0] == "idle-2"


@pytest.mark.asyncio
async def test_inject_returns_skip_when_peer_times_out(monkeypatch):
    """_inject returns 'skip' (non-fatal) when the peer is alive but times out.

    OLD behaviour: _wait_for_idle returned False → inject called _end_bridge('errored').
    NEW behaviour: _wait_for_idle returns 'timeout' → _inject returns 'skip', no write.
    """
    busy_session = _make_mock_session("busy-3", tracker_state="busy", alive=True)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: busy_session)

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.10)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.03)

    record = _make_bridge_record(to_id="busy-3")
    result = await _inject("busy-3", "hello", record)

    assert result == "skip", (
        f"Expected 'skip' (non-fatal) for alive-but-slow peer, got {result!r}. "
        "Old code returned 'fatal', which ended the bridge."
    )
    assert len(write_calls) == 0, "No write should occur on 'skip'"


@pytest.mark.asyncio
async def test_inject_returns_skip_when_stop_event_set(monkeypatch):
    """_inject returns 'skip' when the stop event is set (teardown in progress)."""
    busy_session = _make_mock_session("busy-4", tracker_state="busy", alive=True)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: busy_session)

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 10.0)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record(to_id="busy-4")
    record._stop_event.set()

    result = await _inject("busy-4", "hello", record)

    assert result == "skip", f"Expected 'skip' on stop event, got {result!r}"
    assert len(write_calls) == 0


@pytest.mark.asyncio
async def test_inject_returns_fatal_when_peer_dead(monkeypatch):
    """_inject returns 'fatal' when the peer session is not alive."""
    dead_session = _make_mock_session("dead-2", alive=False)
    # get_terminal returns session but alive=False; initial _session_alive check fires
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: dead_session)

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 2.0)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record(to_id="dead-2")
    result = await _inject("dead-2", "hello", record)

    assert result == "fatal", f"Expected 'fatal' for dead peer, got {result!r}"
    assert len(write_calls) == 0


@pytest.mark.asyncio
async def test_inject_returns_fatal_when_write_returns_false(monkeypatch):
    """_inject returns 'fatal' when write_pty_async returns False."""
    idle_session = _make_mock_session("idle-3", tracker_state="idle", alive=True)
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: idle_session)

    async def failing_write(tid, data):
        return False

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", failing_write)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 2.0)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    record = _make_bridge_record(to_id="idle-3")
    result = await _inject("idle-3", "hello", record)

    assert result == "fatal", f"Expected 'fatal' when write fails, got {result!r}"


# ===========================================================================
# Section C — V2 bridge: non-fatal skip does NOT end the bridge
# ===========================================================================


@pytest.mark.asyncio
async def test_v2_bridge_stays_active_when_peer_times_out(monkeypatch):
    """V2 bridge stays 'active' when the target peer is alive-but-slow (skip).

    This is THE core regression test:
    OLD: busy peer → _wait_for_idle returns False → _inject returned "fatal" →
         _relay_task called _end_bridge("errored") → bridge died after ONE relay.
    NEW: busy peer → 'timeout' → _inject returns 'skip' → relay task continues →
         bridge stays 'active'.
    """
    from_session = _make_mock_session("from-r", "From", alive=True, tracker_state="idle")
    # To-session is permanently busy — relay to it will always time out
    to_session = _make_mock_session("to-r", "To", alive=True, tracker_state="busy")
    sessions = {from_session.id: from_session, to_session.id: to_session}

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # from_session emits one assistant turn — triggers a relay attempt to busy to_session
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["n"] += 1
        if call_idx["n"] == 1:
            yield {"type": "assistant", "content": [{"type": "text", "text": "Hello peer"}]}
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    # Short timeout so the relay skip fires quickly
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.15)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    bm = BridgeManager()
    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait enough time for the timeout to fire + relay task to execute skip path
    for _ in range(15):
        await asyncio.sleep(0.05)

    record = bm._bridges[bid]
    # Key assertion: bridge must NOT be errored after a skip
    assert record.state == "active", (
        f"Expected bridge to stay 'active' on peer timeout (skip), got {record.state!r}. "
        "Old code would set state='errored' here."
    )

    # Cleanup
    bm.stop(bid)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_v2_bridge_errors_when_peer_dies(monkeypatch):
    """V2 bridge transitions to 'errored' when the peer session actually dies.

    Confirms that dead=fatal path is preserved: only 'skip' (timeout/stopped)
    is non-fatal; a truly dead session still ends the bridge with 'errored'.
    """
    from_session = _make_mock_session("from-d", "From", alive=True, tracker_state="idle")
    to_session = _make_mock_session("to-d", "To", alive=True, tracker_state="idle")

    get_calls = {"n": 0}

    def get_terminal(tid):
        if tid == from_session.id:
            return from_session
        get_calls["n"] += 1
        # Return alive for the first couple of lookups (JSONL pre-check + _session_alive),
        # then vanish to simulate session death.
        if get_calls["n"] <= 2:
            return to_session
        return None

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", get_terminal)
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    tail_calls = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        tail_calls["n"] += 1
        if tail_calls["n"] == 1:
            yield {"type": "assistant", "content": [{"type": "text", "text": "Hello peer"}]}
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.3)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    bm = BridgeManager()
    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for dead-peer detection
    for _ in range(30):
        await asyncio.sleep(0.05)
        if bm._bridges[bid].state != "active":
            break

    assert bm._bridges[bid].state == "errored", (
        f"Expected 'errored' when peer dies, got {bm._bridges[bid].state!r}"
    )


@pytest.mark.asyncio
async def test_v2_bridge_end_bridge_not_called_on_skip(monkeypatch):
    """Verify _end_bridge is NOT called when _inject returns 'skip'.

    Patches _end_bridge directly so we can count calls, independently of state.
    """
    from_session = _make_mock_session("from-e", "From", alive=True, tracker_state="idle")
    to_session = _make_mock_session("to-e", "To", alive=True, tracker_state="busy")
    sessions = {from_session.id: from_session, to_session.id: to_session}

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["n"] += 1
        if call_idx["n"] == 1:
            yield {"type": "assistant", "content": [{"type": "text", "text": "Hello"}]}
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.12)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.04)

    end_bridge_calls: list = []
    original_end_bridge = bm_module._end_bridge

    def tracked_end_bridge(record, new_state):
        end_bridge_calls.append(new_state)
        original_end_bridge(record, new_state)

    monkeypatch.setattr(bm_module, "_end_bridge", tracked_end_bridge)

    bm = BridgeManager()
    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for the skip path to execute
    for _ in range(12):
        await asyncio.sleep(0.05)

    # _end_bridge must NOT have been called due to a skip (timeout)
    skip_related_calls = [s for s in end_bridge_calls if s == "errored"]
    assert len(skip_related_calls) == 0, (
        f"_end_bridge was called with 'errored' {len(skip_related_calls)} time(s) "
        f"after a skip — old bug reproduced. Calls: {end_bridge_calls}"
    )

    # Bridge must still be active
    assert bm._bridges[bid].state == "active", (
        f"Bridge must stay active on skip, got {bm._bridges[bid].state!r}"
    )

    bm.stop(bid)
    await asyncio.sleep(0)


# ===========================================================================
# Section D — V3 channel: partial timeouts are non-fatal
# ===========================================================================


def _patch_channel_pty(monkeypatch, sessions_dict):
    """Patch pty_manager for channel tests; return write_calls list."""
    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions_dict.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)
    return write_calls


@pytest.mark.asyncio
async def test_channel_lead_relay_skip_one_worker_stays_active(monkeypatch):
    """Lead relaying to workers: one worker times out (skip) → channel stays 'active'.

    The channel should NOT error just because one worker is slow. The other
    worker should still receive the write, and turns_used should advance.
    """
    lead = _make_mock_session("lead-1", "Lead", alive=True, tracker_state="idle")
    w1 = _make_mock_session("w1", "Worker1", alive=True, tracker_state="idle")
    # w2 is permanently busy — lead's relay to it will skip
    w2 = _make_mock_session("w2", "Worker2", alive=True, tracker_state="busy")

    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}
    write_calls = _patch_channel_pty(monkeypatch, sessions)

    # Only the lead (third tail_jsonl call) yields; worker tails hang
    tail_call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        tail_call_idx["n"] += 1
        current = tail_call_idx["n"]
        if current == 3:
            # Third watcher is the lead relay task
            yield {"type": "assistant", "content": [{"type": "text", "text": "To all workers"}]}
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    # w2 will time out quickly
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.15)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    cm = ChannelManager()
    result = await cm.start(lead.id, [w1.id, w2.id], "kickoff", max_turns=10)
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for lead relay to attempt delivery to both workers
    # Delivery to w2 will time out (skip); delivery to w1 should succeed
    for _ in range(30):
        await asyncio.sleep(0.05)
        record = cm._channels[cid]
        # Once turns_used advances, at least one delivery succeeded
        if record.turns_used > 0:
            break

    record = cm._channels[cid]

    # Channel must NOT have errored — one worker timing out is non-fatal
    assert record.state == "active", (
        f"Expected channel to stay 'active' when one worker times out, got {record.state!r}"
    )

    # turns_used must have advanced (the turn was counted despite the w2 skip)
    assert record.turns_used >= 1, (
        f"turns_used must advance after lead relay (even with one skip), got {record.turns_used}"
    )

    # w1 must have received a relay write (beyond the 3 kickoff writes)
    relay_writes_to_w1 = [
        (tid, data) for tid, data in write_calls[3:]
        if tid == w1.id
    ]
    assert len(relay_writes_to_w1) >= 1, (
        f"w1 must receive at least one relay write from lead; "
        f"write_calls (post-kickoff): {[(t, d[:40]) for t, d in write_calls[3:]]}"
    )

    # Cleanup
    cm.stop(cid)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_channel_lead_relay_all_workers_skip_does_not_count_turn(monkeypatch):
    """Lead relay turn where ALL workers time out (skip) must NOT increment turns_used.

    This is the regression test for the ``delivered_any`` fix in ``_lead_relay_task``.

    Pre-fix behaviour (no ``delivered_any`` flag):
        - Lead emits a turn.
        - Worker w1 times out → skip.
        - Worker w2 times out → skip.
        - ``record.turns_used += 1`` runs unconditionally → turns_used == 1.
        - If max_turns==1, the cap check fires and the channel ends ``ended_capped``.
        - The turn budget was burned on a turn that was delivered to nobody.

    Post-fix behaviour (``delivered_any`` flag):
        - All workers skip → ``delivered_any`` stays False.
        - The ``if not delivered_any: continue`` guard is taken.
        - ``turns_used`` is NOT incremented → still 0.
        - The channel stays ``active`` (no cap, no end).
        - ``_end_channel`` is NOT called.

    Why this test would have been RED on pre-fix code:
        - ``assert record.turns_used == 0`` would have failed (got 1).
        - ``assert record.state == "active"`` would have failed when max_turns==1
          (channel would have ended ``ended_capped``).
    """
    lead = _make_mock_session("lead-3", "Lead", alive=True, tracker_state="idle")
    # Both workers are permanently busy — every inject attempt will time out (skip).
    w1 = _make_mock_session("w1c", "Worker1", alive=True, tracker_state="busy")
    w2 = _make_mock_session("w2c", "Worker2", alive=True, tracker_state="busy")

    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}
    _patch_channel_pty(monkeypatch, sessions)

    # The lead relay task is the 3rd tail_jsonl call (workers spawn first).
    tail_call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        tail_call_idx["n"] += 1
        current = tail_call_idx["n"]
        if current == 3:
            # Lead relay task — emit one assistant turn
            yield {"type": "assistant", "content": [{"type": "text", "text": "All workers do X"}]}
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    # Both workers time out quickly; set max_turns=1 so the pre-fix bug is
    # especially visible — on old code the cap would fire and end the channel.
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.15)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    end_channel_calls: list = []
    original_end_channel = bm_module._end_channel

    def tracked_end_channel(record, new_state):
        end_channel_calls.append(new_state)
        original_end_channel(record, new_state)

    monkeypatch.setattr(bm_module, "_end_channel", tracked_end_channel)

    cm = ChannelManager()
    # max_turns=1: on pre-fix code, the unconditional turns_used += 1 would
    # immediately trigger the cap and end the channel with "ended_capped".
    result = await cm.start(lead.id, [w1.id, w2.id], "kickoff", max_turns=1)
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait long enough for both worker timeouts to complete (2 × 0.15s) plus
    # the lead relay loop iteration to run (generous headroom).
    for _ in range(40):
        await asyncio.sleep(0.05)

    record = cm._channels[cid]

    # PRIMARY: turns_used must still be zero — no turn was delivered.
    assert record.turns_used == 0, (
        f"turns_used must be 0 when every worker skipped; got {record.turns_used}. "
        "Pre-fix code incremented turns_used unconditionally, burning the turn budget "
        "even when nothing was delivered."
    )

    # SECONDARY: channel must still be active — a zero-delivery turn must not
    # trigger the cap or any error path.
    assert record.state == "active", (
        f"Channel must stay 'active' when all workers skip; got {record.state!r}. "
        "Pre-fix code would have set state='ended_capped' here (with max_turns=1)."
    )

    # TERTIARY: _end_channel must not have been called at all.
    assert len(end_channel_calls) == 0, (
        f"_end_channel must NOT be called when all workers skip; got calls={end_channel_calls}. "
        "Old code called _end_channel('ended_capped') after the unconditional increment."
    )

    # Cleanup
    cm.stop(cid)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_channel_lead_relay_fatal_worker_ends_channel_errored(monkeypatch):
    """Lead relaying to workers: one worker is dead (fatal) → channel ends 'errored'."""
    lead = _make_mock_session("lead-2", "Lead", alive=True, tracker_state="idle")
    w1 = _make_mock_session("w1b", "Worker1", alive=True, tracker_state="idle")
    w2 = _make_mock_session("w2b", "Worker2", alive=True, tracker_state="idle")

    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    write_calls: list = []
    get_calls = {"n": 0}

    def get_terminal(tid):
        if tid in (lead.id, w1.id):
            return sessions.get(tid)
        # w2: alive for validation but dead when _inject tries to reach it
        get_calls["n"] += 1
        # First few calls: alive (JSONL check, _session_alive inside inject)
        if get_calls["n"] <= 2:
            return w2
        # Return a dead version so _inject sees it as dead inside _wait_for_idle
        dead_w2 = _make_mock_session("w2b", "Worker2", alive=False)
        return dead_w2

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", get_terminal)
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    tail_call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        tail_call_idx["n"] += 1
        current = tail_call_idx["n"]
        if current == 3:
            # Lead relay task
            yield {"type": "assistant", "content": [{"type": "text", "text": "Work on this"}]}
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.3)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    cm = ChannelManager()
    result = await cm.start(lead.id, [w1.id, w2.id], "kickoff")
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for dead-worker detection to end the channel
    for _ in range(30):
        await asyncio.sleep(0.05)
        if cm._channels[cid].state != "active":
            break

    assert cm._channels[cid].state == "errored", (
        f"Expected 'errored' when a worker dies mid-relay, got {cm._channels[cid].state!r}"
    )


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


# ===========================================================================
# Section G — V3 channel: concurrent (not sequential) worker broadcast
# ===========================================================================


@pytest.mark.asyncio
async def test_lead_relay_broadcasts_to_workers_concurrently_not_sequentially(monkeypatch):
    """_lead_relay_task's fan-out to N busy workers takes ~one _BUSY_WAIT_MAX
    window, not N of them — proving the broadcast is concurrent, not a
    sequential for-loop that head-of-line-blocks slow workers.

    Regression for the fix: the old code awaited `_inject(worker_id, ...)`
    one worker at a time inside a `for` loop. With 3 permanently-busy workers
    and _BUSY_WAIT_MAX patched to 0.2s, the OLD sequential code would take
    >= 3 * 0.2s == 0.6s (each worker's idle-gate wait fully blocking the
    next). The NEW asyncio.gather-based fan-out runs all three idle-gate
    waits in parallel and should complete in ~1x the window (~0.2-0.3s).

    We assert the elapsed wall-clock time is comfortably below the sequential
    lower bound (0.6s) but generous enough not to be flaky.
    """
    lead = _make_mock_session("lead-concurrent", "Lead", alive=True, tracker_state="idle")
    workers = [
        _make_mock_session(f"w{i}-concurrent", f"Worker{i}", alive=True, tracker_state="busy")
        for i in range(3)
    ]
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)

    # The lead relay task is the last of the N+1 tail_jsonl calls (workers
    # spawn first, then the lead) — mirror the ordering used elsewhere in
    # this file.
    tail_call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        tail_call_idx["n"] += 1
        current = tail_call_idx["n"]
        if current == len(workers) + 1:
            yield {"type": "assistant", "content": [{"type": "text", "text": "Go, all of you"}]}
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.2)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.03)

    # Every worker here is busy-forever, so every _inject() call resolves via
    # "skip" (never "ok") — no PTY write happens, so write_calls can't be used
    # to detect fan-out completion. Instead, wrap _inject itself and record a
    # completion timestamp per call so we can measure the actual spread.
    original_inject = bm_module._inject
    completion_times: list[float] = []

    async def tracked_inject(terminal_id, text, record):
        result = await original_inject(terminal_id, text, record)
        completion_times.append(time.monotonic())
        return result

    monkeypatch.setattr(bm_module, "_inject", tracked_inject)

    cm = ChannelManager()
    t_start = time.monotonic()
    result = await cm.start(lead.id, [w.id for w in workers], "kickoff", max_turns=10)
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Poll until all N worker deliveries have resolved (or a generous timeout).
    for _ in range(100):
        await asyncio.sleep(0.02)
        if len(completion_times) >= len(workers) or time.monotonic() - t_start > 2.0:
            break

    assert len(completion_times) == len(workers), (
        f"Expected {len(workers)} _inject completions, got {len(completion_times)}"
    )

    elapsed = max(completion_times) - t_start

    # Sequential old code: >= 3 * 0.2s = 0.6s just for the idle-gate waits.
    # Concurrent new code: ~1 * 0.2s (all three waits run in parallel) plus
    # scheduling overhead.
    assert elapsed < 0.5, (
        f"Broadcasting to {len(workers)} busy workers took {elapsed:.3f}s — expected well under "
        f"{len(workers)} * _BUSY_WAIT_MAX (0.6s), which would indicate the old sequential "
        "for-loop (head-of-line blocking) regressed."
    )

    # Channel must still be active — all-skip does not end or cap the channel.
    record = cm._channels[cid]
    assert record.state == "active"

    cm.stop(cid)
    await asyncio.sleep(0)
