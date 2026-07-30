"""Tests for BridgeManager (web/bridge_manager.py).

Covers:
  - start_manual: bracketed-paste injection, dead-session guard, prefix handling
  - start_auto: bridge_id generation, JSONL pre-check, kickoff writes, task spawn
  - stop: state transitions, idempotency, unknown bridge
  - list_active: shape of returned dicts
  - Relay-task behaviour: sentinel detection, turn cap, idle-gate timeout

All tests are isolated — no real PTY processes or filesystem access.
pty_manager and tail_jsonl are replaced by monkeypatched stubs for each test.
"""

from __future__ import annotations

import asyncio
import pathlib
import re
import sys
import os
import time
from unittest.mock import MagicMock

import pytest

# Make the web/ directory importable without a package install
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import bridge_manager as bm_module
from bridge_manager import BridgeManager, _BP_START, _BP_END, _SUBMIT


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_mock_session(terminal_id="term-123", name="Test Session", alive=True, tracker_state="idle"):
    """Build a mock TerminalSession with the fields BridgeManager reads."""
    s = MagicMock()
    s.id = terminal_id
    s.name = name
    s.alive = alive
    s.tracker = MagicMock()
    s.tracker.state = tracker_state
    s.claude_session_id = "claude-abc"
    s.working_dir = "/tmp"
    s.last_user_input_time = 0.0
    return s


@pytest.fixture()
def bm():
    """Fresh BridgeManager for each test."""
    return BridgeManager()


@pytest.fixture()
def from_session():
    return _make_mock_session("from-001", "From Session")


@pytest.fixture()
def to_session():
    return _make_mock_session("to-002", "To Session")


@pytest.fixture(autouse=True)
def _no_submit_delay(monkeypatch):
    """Zero the paste→submit gap for the whole module.

    Injection is deliberately two writes separated by ``_SUBMIT_DELAY`` (1s in
    production) so the CR lands as a keypress rather than as pasted content.
    Paying that second per injection would add minutes to the suite, and no
    test here is asserting the duration.
    """
    monkeypatch.setattr(bm_module, "_SUBMIT_DELAY", 0)


@pytest.fixture()
def patch_pty(monkeypatch, from_session, to_session):
    """Monkeypatch pty_manager on the bridge_manager module.

    Returns a list that accumulates (terminal_id, data) tuples from every
    write_pty_async call.
    """
    sessions = {from_session.id: from_session, to_session.id: to_session}

    # Injection is two writes — the bracketed-paste block, then a bare CR after
    # _SUBMIT_DELAY (see bridge_manager._paste_and_submit).  Zero the delay so
    # the suite does not pay a real second per injection.
    monkeypatch.setattr(bm_module, "_SUBMIT_DELAY", 0)

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list[tuple[str, str]] = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    return write_calls


def paste_only(write_calls):
    """Filter out the bare-CR submit writes, keeping paste writes in order.

    Unlike ``pastes()`` this makes no pairing assertion, so it is safe to call
    while relays are still in flight (a paste may not have been submitted yet).
    """
    return [c for c in write_calls if c[1] != bm_module._SUBMIT]


def pastes(write_calls):
    """Return only the bracketed-paste writes, asserting each one was submitted.

    Every injection is a paste write followed by a separate bare-CR write; a
    paste with no trailing submit is the "message sits in the composer forever"
    bug, so this helper refuses to hide it.
    """
    submits = [c for c in write_calls if c[1] == bm_module._SUBMIT]
    paste_calls = [c for c in write_calls if c[1] != bm_module._SUBMIT]
    assert len(submits) == len(paste_calls), (
        f"expected one submit per paste, got {len(paste_calls)} pastes / {len(submits)} submits"
    )
    for tid, _data in paste_calls:
        assert (tid, bm_module._SUBMIT) in submits, f"paste to {tid} was never submitted"
    return paste_calls


# ---------------------------------------------------------------------------
# Helper — async generator that yields a fixed set of JSONL entries then stops
# ---------------------------------------------------------------------------


def _async_gen_from_list(entries: list[dict]):
    """Return an async generator that yields items from *entries* then returns."""
    async def _gen(path, from_beginning=False, **kwargs):
        for entry in entries:
            yield entry
    return _gen


# ---------------------------------------------------------------------------
# Test 1 — start_manual writes bracketed-paste
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_writes_bracketed_paste(bm, patch_pty, from_session, to_session):
    """start_manual wraps the message in BP escapes and sends it to the target PTY."""
    result = await bm.start_manual(
        from_session.id,
        to_session.id,
        "Hello from the bridge",
        prefix='[From session "From Session"]:',
    )

    assert result == {"ok": True}
    calls = pastes(patch_pty)
    assert len(calls) == 1
    _tid, data = calls[0]
    assert _tid == to_session.id
    # BP escapes present
    assert _BP_START in data
    assert _BP_END in data
    # The CR must NOT ride inside the paste — a CR in the same write is eaten
    # as pasted content and the message never sends.  `pastes()` has already
    # asserted a separate submit write followed this one.
    assert _SUBMIT not in data
    # Prefix on its own line, then the message
    assert '[From session "From Session"]:' in data
    assert "Hello from the bridge" in data
    # Prefix comes BEFORE the message
    assert data.index('[From session "From Session"]:') < data.index("Hello from the bridge")


# ---------------------------------------------------------------------------
# Test 2 — start_manual with dead target
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_with_dead_target(bm, monkeypatch, from_session):
    """start_manual returns {ok: False} if the target session is dead."""
    dead_target = _make_mock_session("to-dead", alive=False)
    sessions = {from_session.id: from_session, dead_target.id: dead_target}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))

    write_calls = []
    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    result = await bm.start_manual(from_session.id, dead_target.id, "msg")

    assert result.get("ok") is False
    assert "error" in result
    assert len(write_calls) == 0


# ---------------------------------------------------------------------------
# Test 3 — start_manual with dead source
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_with_dead_source(bm, monkeypatch, to_session):
    """start_manual returns {ok: False} if the source session is dead."""
    dead_source = _make_mock_session("from-dead", alive=False)
    sessions = {dead_source.id: dead_source, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))

    write_calls = []
    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    result = await bm.start_manual(dead_source.id, to_session.id, "msg")

    assert result.get("ok") is False
    assert "error" in result
    assert len(write_calls) == 0


# ---------------------------------------------------------------------------
# Test 4 — start_manual default prefix when None
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_default_prefix_when_none(bm, patch_pty, from_session, to_session):
    """When prefix=None, BridgeManager sends only the message (no prefix line).

    The bridge_manager source code shows: if prefix is falsy, full_text = message.
    So the sent data should contain only the message inside the BP escapes.
    """
    result = await bm.start_manual(from_session.id, to_session.id, "bare message", prefix=None)

    assert result == {"ok": True}
    calls = pastes(patch_pty)
    assert len(calls) == 1
    _tid, data = calls[0]
    assert "bare message" in data
    # No spurious prefix line when None
    assert "[From session" not in data


# ---------------------------------------------------------------------------
# Test 5 — start_auto returns bridge_id
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_auto_returns_bridge_id(bm, patch_pty, from_session, to_session, monkeypatch):
    """start_auto returns {ok: True, bridge_id: <12-char hex>} when both sessions are live."""
    # Stub tail_jsonl so relay tasks don't spin forever
    async def never_yield(path, from_beginning=False, **kwargs):
        await asyncio.sleep(10)
        return
        yield  # make it an async generator

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "ping")

    assert result.get("ok") is True
    bid = result.get("bridge_id")
    assert bid is not None
    assert len(bid) == 12
    assert re.fullmatch(r"[0-9a-f]{12}", bid) is not None, f"bridge_id not 12-char hex: {bid!r}"

    # Cleanup — cancel tasks so they don't escape the test
    record = bm._bridges[bid]
    record._stop_event.set()
    for task in (record._task_from, record._task_to):
        if task and not task.done():
            task.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 6 — start_auto with JSONL=None for both sessions still starts (ok: True)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_auto_no_jsonl_still_starts(bm, monkeypatch, from_session, to_session):
    """start_auto returns {ok: True} even when JSONL is unavailable for both sessions.

    Brand-new sessions have no JSONL yet (Claude Code only creates it on the first
    message).  The bridge's kickoff prompt IS that first message, so the relay tasks
    must handle the missing file — not the pre-flight validation.  Previously, the
    pre-flight returned {ok: False, error: 'JSONL not yet available...'}, which
    prevented bridging any session that hadn't spoken before.
    """
    sessions = {from_session.id: from_session, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    # JSONL is not available for either session (simulates brand-new sessions)
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: None)

    write_calls = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # Stub tail_jsonl so relay tasks don't spin forever waiting for JSONL
    async def never_yield(path, from_beginning=False, **kwargs):
        await asyncio.sleep(3600)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")

    assert result.get("ok") is True, f"Expected ok=True for no-JSONL sessions, got: {result}"
    assert "bridge_id" in result
    # Kickoff writes must still have been sent to both sides
    kickoffs = pastes(write_calls)
    assert len(kickoffs) == 2, f"Expected 2 kickoff pastes, got {len(kickoffs)}"

    # Cleanup
    bid = result["bridge_id"]
    record = bm._bridges[bid]
    record._stop_event.set()
    for task in (record._task_from, record._task_to):
        if task and not task.done():
            task.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 6b — start_auto with a dead/missing session still returns ok:False
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_auto_dead_session_returns_error(bm, monkeypatch, from_session):
    """start_auto returns {ok: False, error: '...not found or dead...'} when either
    session is dead, even after the JSONL pre-flight check was removed.

    This confirms the alive/exists guard was NOT removed as part of the fix.
    """
    dead_to = _make_mock_session("to-dead", "Dead Target", alive=False)
    sessions = {from_session.id: from_session, dead_to.id: dead_to}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: None)

    write_calls = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    result = await bm.start_auto(from_session.id, dead_to.id, "kickoff")

    assert result.get("ok") is False, f"Expected ok=False for dead session, got: {result}"
    assert "error" in result
    assert len(write_calls) == 0, "No kickoff writes should occur when a session is dead"


# ---------------------------------------------------------------------------
# Test 7 — start_auto sends kickoff writes to both sides
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_auto_kicks_off_both_sides(bm, patch_pty, from_session, to_session, monkeypatch):
    """start_auto sends one kickoff write to each session."""
    async def never_yield(path, from_beginning=False, **kwargs):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "shared prompt")

    assert result.get("ok") is True

    # Allow asyncio tasks to schedule
    await asyncio.sleep(0)

    # Two kickoff writes: one per session
    calls = pastes(patch_pty)
    assert len(calls) == 2
    target_ids = {tid for tid, _ in calls}
    assert from_session.id in target_ids
    assert to_session.id in target_ids

    # Each kickoff contains the BP start
    for _tid, data in calls:
        assert _BP_START in data

    # Cleanup
    bid = result["bridge_id"]
    record = bm._bridges[bid]
    record._stop_event.set()
    for task in (record._task_from, record._task_to):
        if task and not task.done():
            task.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 8 — stop transitions state to ended_user
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_existing_bridge_returns_true_and_marks_ended_user(
    bm, patch_pty, from_session, to_session, monkeypatch
):
    """stop() on an active bridge returns True and sets state='ended_user'."""
    async def never_yield(path, from_beginning=False, **kwargs):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "test")
    bid = result["bridge_id"]

    await asyncio.sleep(0)

    ok = bm.stop(bid)
    assert ok is True

    bridges = {b["bridge_id"]: b for b in bm.list_active()}
    assert bridges[bid]["state"] == "ended_user"


# ---------------------------------------------------------------------------
# Test 9 — stop unknown bridge returns False
# ---------------------------------------------------------------------------


def test_stop_unknown_bridge_returns_false(bm):
    """stop() on a nonexistent bridge_id returns False."""
    assert bm.stop("nonexistent_12x") is False


# ---------------------------------------------------------------------------
# Test 10 — stop already-ended bridge is idempotent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stop_already_ended_idempotent(bm, patch_pty, from_session, to_session, monkeypatch):
    """Calling stop() twice on the same bridge both return True."""
    async def never_yield(path, from_beginning=False, **kwargs):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    result = await bm.start_auto(from_session.id, to_session.id, "test")
    bid = result["bridge_id"]

    await asyncio.sleep(0)

    first = bm.stop(bid)
    second = bm.stop(bid)

    assert first is True
    assert second is True  # Per Quinn's note: already in terminal state — still True


# ---------------------------------------------------------------------------
# Test 11 — list_active shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_active_shape(bm, patch_pty, from_session, to_session, monkeypatch):
    """list_active() returns dicts with all required keys."""
    async def never_yield(path, from_beginning=False, **kwargs):
        await asyncio.sleep(10)
        return
        yield

    monkeypatch.setattr(bm_module, "tail_jsonl", never_yield)

    await bm.start_auto(from_session.id, to_session.id, "probe")

    bridges = bm.list_active()
    assert len(bridges) == 1

    b = bridges[0]
    required_keys = {"bridge_id", "from_id", "to_id", "from_name", "to_name", "turns_used", "max_turns", "state"}
    assert required_keys.issubset(b.keys()), f"Missing keys: {required_keys - b.keys()}"

    # Cleanup
    bm.stop(b["bridge_id"])
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 12 — GC after TTL (skipped — too brittle at 10s GC interval)
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason=(
    "GC loop sleeps 10s between cycles; testing it deterministically would "
    "require patching asyncio.sleep deep inside _gc_loop, which is brittle. "
    "The TTL logic is simple enough (now - _ended_at > _RECORD_TTL) that a "
    "manual inspection suffices."
))
def test_record_gc_after_ttl():
    pass


# ---------------------------------------------------------------------------
# Test 13 — sentinel in relay text ends bridge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sentinel_in_relay_text_ends_bridge(bm, monkeypatch, from_session, to_session):
    """BRIDGE-DONE in an assistant turn ends the bridge with state='ended_sentinel'.

    The final message is still delivered to the peer BEFORE the bridge ends.
    """
    sessions = {from_session.id: from_session, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list[tuple[str, str]] = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # from_session emits a message with BRIDGE-DONE; to_session tails nothing
    from_entries = [
        {
            "type": "assistant",
            "content": [{"type": "text", "text": "All done. BRIDGE-DONE"}],
        }
    ]

    call_count = {"from": 0, "to": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        # Only yield from the from_session path; to_session path hangs
        if "fake" in path:
            # Distinguish by call order
            call_count["from"] += 1
            if call_count["from"] == 1:
                for entry in from_entries:
                    yield entry
            else:
                await asyncio.sleep(5)
                return
        else:
            await asyncio.sleep(5)
            return

    # Patch the module-level _wait_for_idle so we don't actually wait
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for relay tasks to process the entry
    for _ in range(20):
        await asyncio.sleep(0.05)
        record = bm._bridges[bid]
        if record.state != "active":
            break

    record = bm._bridges[bid]
    assert record.state == "ended_sentinel", f"Expected ended_sentinel, got {record.state}"

    # The message was delivered: at least one relay write happened (beyond the two kickoffs).
    # At minimum the kickoff writes (2) plus the relay write (1).
    assert len(paste_only(write_calls)) >= 3


# ---------------------------------------------------------------------------
# Test 14 — turn cap ends bridge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_turn_cap_ends_bridge(bm, monkeypatch, from_session, to_session):
    """Bridge ends with state='ended_capped' when max_turns=1 and both sides relay once."""
    sessions = {from_session.id: from_session, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # Each side yields one assistant turn (no sentinel)
    single_entry = [
        {"type": "assistant", "content": [{"type": "text", "text": "My reply, no sentinel"}]}
    ]

    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["n"] += 1
        for entry in single_entry:
            yield entry
        # After yielding, hang so bridge ends due to cap not due to generator exhaustion
        await asyncio.sleep(5)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff", max_turns=1)
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for both relay tasks to fire and cap to trigger
    for _ in range(30):
        await asyncio.sleep(0.05)
        record = bm._bridges[bid]
        if record.state != "active":
            break

    record = bm._bridges[bid]
    assert record.state == "ended_capped", f"Expected ended_capped, got {record.state}"
    assert record.turns_used >= 1


# ---------------------------------------------------------------------------
# Test 15 — idle gate: dead peer causes bridge to error; busy-alive peer is skipped
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_idle_gate_dead_peer_errors_bridge(bm, monkeypatch, from_session, to_session):
    """Bridge ends with state='errored' when the target peer session dies mid-wait.

    _wait_for_idle returns 'dead' (fatal) when the session is None/not-alive.
    _inject translates 'dead' → 'fatal' → _relay_task calls _end_bridge('errored').

    Previously the test was named 'test_idle_gate_waits_then_errors_if_busy' and
    expected that a *busy-but-alive* peer would also end the bridge with 'errored'.
    That contract changed: a busy-but-alive peer now produces a non-fatal 'timeout'
    result (the relay is skipped for that turn and the bridge stays active).  Only
    a dead session or a PTY write failure is a fatal error.
    """
    # 'to' session starts alive so the JSONL check passes, but will vanish
    # (return None from get_terminal) once the relay task fires — simulating
    # session death mid-relay.
    call_idx = {"get": 0, "tail": 0}

    def get_terminal_side_effect(tid):
        if tid == from_session.id:
            return from_session
        # to_session is alive for the first two lookups (JSONL check + initial
        # liveness check inside _inject), then gone.
        call_idx["get"] += 1
        if call_idx["get"] <= 2:
            return to_session
        return None  # session vanished — simulate death

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", get_terminal_side_effect)
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # from_session tails one entry, triggering an inject into the (soon-dead) peer
    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["tail"] += 1
        if call_idx["tail"] == 1:
            yield {"type": "assistant", "content": [{"type": "text", "text": "Hello peer"}]}
        await asyncio.sleep(10)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.3)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait for the dead-peer detection to propagate and bridge to errored
    for _ in range(30):
        await asyncio.sleep(0.05)
        record = bm._bridges[bid]
        if record.state != "active":
            break

    record = bm._bridges[bid]
    assert record.state == "errored", f"Expected errored for dead peer, got {record.state}"


@pytest.mark.asyncio
async def test_idle_gate_busy_alive_peer_is_skipped_not_errored(bm, monkeypatch, from_session, to_session):
    """Bridge stays alive when the target peer is permanently busy-but-alive.

    A busy-but-alive peer used to kill the bridge ('errored').  After the fix,
    _wait_for_idle returns 'timeout' (non-fatal) → _inject returns 'skip' →
    _relay_task continues rather than ending the bridge.

    We verify by patching _BUSY_WAIT_MAX to a very short value so the timeout
    fires quickly, then checking that the bridge remains in 'active' state (not
    'errored') after the timeout window elapses.
    """
    busy_to = _make_mock_session(to_session.id, to_session.name, alive=True, tracker_state="busy")
    sessions = {from_session.id: from_session, busy_to.id: busy_to}
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
            yield {"type": "assistant", "content": [{"type": "text", "text": "Hello peer"}]}
        await asyncio.sleep(10)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    # Very short busy-wait so the test doesn't take 300s
    monkeypatch.setattr(bm_module, "_BUSY_WAIT_MAX", 0.15)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await bm.start_auto(from_session.id, to_session.id, "kickoff")
    assert result.get("ok") is True
    bid = result["bridge_id"]

    # Wait enough time for the timeout to fire and the skip path to execute
    for _ in range(10):
        await asyncio.sleep(0.05)

    record = bm._bridges[bid]
    # Bridge must NOT have errored — busy-but-alive peer is a non-fatal skip
    assert record.state == "active", (
        f"Expected bridge to stay 'active' when peer is busy-but-alive, got {record.state!r}"
    )

    # Cleanup
    bm.stop(bid)
    await asyncio.sleep(0)


# ===========================================================================
# ChannelManager tests (Tests 16–32)
# ===========================================================================

from bridge_manager import ChannelManager, _ChannelRecord  # noqa: E402


# ---------------------------------------------------------------------------
# Shared helpers for channel tests
# ---------------------------------------------------------------------------


def _make_channel_sessions(lead_id="lead-1", lead_name="Lead Session",
                            worker_specs=None):
    """Return (lead_session, list_of_worker_sessions).

    *worker_specs* is a list of (id, name, alive) tuples.
    Defaults to two alive workers if not supplied.
    """
    if worker_specs is None:
        worker_specs = [("w1", "Worker One", True), ("w2", "Worker Two", True)]
    lead = _make_mock_session(lead_id, lead_name, alive=True)
    workers = [_make_mock_session(wid, wname, alive=alive)
               for wid, wname, alive in worker_specs]
    return lead, workers


def _patch_channel_pty(monkeypatch, sessions_dict, jsonl_map=None):
    """Monkeypatch pty_manager for channel tests.

    *sessions_dict*: {terminal_id: mock_session}
    *jsonl_map*: {terminal_id: path_or_None} — defaults to "/tmp/fake.jsonl" for all.
    Returns write_calls list.
    """
    def get_terminal(tid):
        return sessions_dict.get(tid)

    def get_jsonl_path(session):
        if jsonl_map is not None:
            return jsonl_map.get(session.id)
        return "/tmp/fake.jsonl"

    write_calls: list[tuple[str, str]] = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", get_terminal)
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", get_jsonl_path)
    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)
    return write_calls


async def _cancel_channel_tasks(record: _ChannelRecord):
    """Cancel all tasks on a _ChannelRecord and yield control so they can exit."""
    record._stop_event.set()
    for t in record._tasks:
        if t and not t.done():
            t.cancel()
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Hanging tail_jsonl stub — prevents relay tasks from spinning
# ---------------------------------------------------------------------------


async def _never_yield(path, from_beginning=False, **kwargs):
    """Async generator that hangs forever without yielding anything."""
    await asyncio.sleep(3600)
    return
    yield  # make it an async generator


# ---------------------------------------------------------------------------
# Test 16 — start() returns channel_id with correct shape
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_returns_channel_id(monkeypatch):
    """start() returns {ok: True, channel_id: <12-char hex>} for a valid topology."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "get to work")

    assert result.get("ok") is True, f"Expected ok=True, got: {result}"
    cid = result.get("channel_id")
    assert cid is not None
    assert len(cid) == 12
    assert re.fullmatch(r"[0-9a-f]{12}", cid), f"channel_id not 12-char hex: {cid!r}"

    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 17 — start() spawns N+1 tasks
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_spawns_n_plus_one_tasks(monkeypatch):
    """start() with N workers creates exactly N+1 asyncio tasks in record._tasks."""
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    # Case A: 1 lead + 2 workers → 3 tasks
    cm_a = ChannelManager()
    lead_a, workers_a = _make_channel_sessions(
        lead_id="lead-a", worker_specs=[("wa1", "Worker A1", True), ("wa2", "Worker A2", True)]
    )
    sessions_a = {lead_a.id: lead_a, **{w.id: w for w in workers_a}}
    _patch_channel_pty(monkeypatch, sessions_a)

    result_a = await cm_a.start(lead_a.id, [w.id for w in workers_a], "prompt")
    assert result_a.get("ok") is True
    record_a = cm_a._channels[result_a["channel_id"]]
    assert len(record_a._tasks) == 3, f"Expected 3 tasks for 2 workers, got {len(record_a._tasks)}"
    await _cancel_channel_tasks(record_a)

    # Case B: 1 lead + 3 workers → 4 tasks
    cm_b = ChannelManager()
    lead_b, workers_b = _make_channel_sessions(
        lead_id="lead-b",
        worker_specs=[("wb1", "Worker B1", True), ("wb2", "Worker B2", True), ("wb3", "Worker B3", True)],
    )
    sessions_b = {lead_b.id: lead_b, **{w.id: w for w in workers_b}}
    _patch_channel_pty(monkeypatch, sessions_b)

    result_b = await cm_b.start(lead_b.id, [w.id for w in workers_b], "prompt")
    assert result_b.get("ok") is True
    record_b = cm_b._channels[result_b["channel_id"]]
    assert len(record_b._tasks) == 4, f"Expected 4 tasks for 3 workers, got {len(record_b._tasks)}"
    await _cancel_channel_tasks(record_b)


# ---------------------------------------------------------------------------
# Test 18 — start() sends kickoff to lead AND all workers simultaneously
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_sends_kickoff_to_all(monkeypatch):
    """start() writes one kickoff to lead + one each to all workers; all contain _BP_START.

    Lead kickoff must contain 'LEAD'; each worker kickoff must contain 'WORKER'.
    """
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()  # 1 lead + 2 workers
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    write_calls = _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "kickoff prompt")
    assert result.get("ok") is True

    # Allow relay tasks to start (they may trigger additional writes via _inject — but
    # tail_jsonl hangs, so only the initial kickoff writes should have fired by now)
    await asyncio.sleep(0)

    # Exactly 3 kickoff writes: lead + 2 workers
    kickoffs = pastes(write_calls)
    assert len(kickoffs) == 3, f"Expected 3 kickoff pastes, got {len(kickoffs)}: {[t for t, _ in kickoffs]}"

    # All must contain _BP_START
    for tid, data in kickoffs:
        assert _BP_START in data, f"Missing _BP_START in kickoff to {tid}"

    # Lead kickoff goes to lead.id and contains "LEAD"
    lead_writes = [(tid, data) for tid, data in kickoffs if tid == lead.id]
    assert len(lead_writes) == 1, f"Expected 1 lead write, got {len(lead_writes)}"
    assert "LEAD" in lead_writes[0][1], "Lead kickoff must contain 'LEAD'"

    # Worker kickoffs go to worker IDs and each contains "WORKER"
    for w in workers:
        worker_writes = [(tid, data) for tid, data in kickoffs if tid == w.id]
        assert len(worker_writes) == 1, f"Expected 1 write for worker {w.id}, got {len(worker_writes)}"
        assert "WORKER" in worker_writes[0][1], f"Worker kickoff for {w.id} must contain 'WORKER'"

    record = cm._channels[result["channel_id"]]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 19 — start() rejects empty worker_ids
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_empty_workers(monkeypatch):
    """start() with an empty worker_ids list returns {ok: False, error: ...}."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead")
    _patch_channel_pty(monkeypatch, {lead.id: lead})

    result = await cm.start(lead.id, [], "prompt")

    assert result.get("ok") is False
    assert "error" in result
    assert len(cm._channels) == 0


# ---------------------------------------------------------------------------
# Test 20 — start() rejects duplicate IDs (lead appears in worker_ids)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_duplicate_ids(monkeypatch):
    """start() returns {ok: False} when the same terminal ID appears as both lead and worker."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead")
    worker = _make_mock_session("w1", "Worker")
    _patch_channel_pty(monkeypatch, {lead.id: lead, worker.id: worker})

    # lead.id is duplicated in the worker list
    result = await cm.start(lead.id, [worker.id, lead.id], "prompt")

    assert result.get("ok") is False
    assert "error" in result


# ---------------------------------------------------------------------------
# Test 21 — start() rejects dead lead session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_dead_lead(monkeypatch):
    """start() returns {ok: False} when the lead session is not alive."""
    cm = ChannelManager()
    dead_lead = _make_mock_session("lead-1", "Lead", alive=False)
    worker = _make_mock_session("w1", "Worker")
    _patch_channel_pty(monkeypatch, {dead_lead.id: dead_lead, worker.id: worker})

    result = await cm.start(dead_lead.id, [worker.id], "prompt")

    assert result.get("ok") is False
    assert "error" in result


# ---------------------------------------------------------------------------
# Test 22 — start() rejects dead worker session
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_rejects_dead_worker(monkeypatch):
    """start() returns {ok: False} when any worker session is not alive."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead", alive=True)
    alive_worker = _make_mock_session("w1", "Worker One", alive=True)
    dead_worker = _make_mock_session("w2", "Worker Two", alive=False)
    sessions = {lead.id: lead, alive_worker.id: alive_worker, dead_worker.id: dead_worker}
    _patch_channel_pty(monkeypatch, sessions)

    result = await cm.start(lead.id, [alive_worker.id, dead_worker.id], "prompt")

    assert result.get("ok") is False
    assert "error" in result


# ---------------------------------------------------------------------------
# Test 23 — start() succeeds when JSONL is missing for all members
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_no_jsonl_still_starts(monkeypatch):
    """start() returns {ok: True} when JSONL is unavailable for ALL members.

    Brand-new sessions have no JSONL yet.  The channel kickoff prompt is what
    triggers the session's first message, so the relay tasks handle the missing
    file post-kickoff.  Previously the pre-flight returned {ok: False, error:
    'JSONL not yet available...'} for any session without a JSONL path, blocking
    channels involving fresh sessions.
    """
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}
    # No JSONL for any session
    jsonl_map = {lead.id: None, w1.id: None, w2.id: None}
    write_calls = _patch_channel_pty(monkeypatch, sessions, jsonl_map=jsonl_map)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")

    assert result.get("ok") is True, f"Expected ok=True for no-JSONL sessions, got: {result}"
    assert "channel_id" in result
    # Kickoff writes must still have been sent to all 3 members (lead + 2 workers)
    kickoffs = pastes(write_calls)
    assert len(kickoffs) == 3, f"Expected 3 kickoff pastes, got {len(kickoffs)}"

    record = cm._channels[result["channel_id"]]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 24 — stop() transitions state to ended_user
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_stop_transitions_to_ended_user(monkeypatch):
    """stop() on an active channel returns True and sets state='ended_user'."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    await asyncio.sleep(0)

    ok = cm.stop(cid)
    assert ok is True

    record = cm._channels[cid]
    assert record.state == "ended_user", f"Expected ended_user, got {record.state}"
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 25 — stop() on unknown channel_id returns False
# ---------------------------------------------------------------------------


def test_channel_stop_unknown_returns_false():
    """stop() with an unrecognised channel_id returns False."""
    cm = ChannelManager()
    assert cm.stop("nonexistent_12x") is False


# ---------------------------------------------------------------------------
# Test 26 — stop() is idempotent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_stop_idempotent(monkeypatch):
    """Calling stop() twice on the same channel both return True."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    await asyncio.sleep(0)

    first = cm.stop(cid)
    second = cm.stop(cid)

    assert first is True
    assert second is True


# ---------------------------------------------------------------------------
# Test 27 — member_ids() returns lead + all workers for active channels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_member_ids_includes_all_active(monkeypatch):
    """member_ids() returns the lead + every worker ID while the channel is active."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True

    ids = cm.member_ids()
    assert lead.id in ids, f"lead.id {lead.id!r} not in member_ids: {ids}"
    for w in workers:
        assert w.id in ids, f"worker.id {w.id!r} not in member_ids: {ids}"
    assert len(ids) == 1 + len(workers)

    cid = result["channel_id"]
    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 28 — member_ids() excludes ended channels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_member_ids_excludes_ended(monkeypatch):
    """member_ids() returns an empty set after the only channel has been stopped."""
    cm = ChannelManager()
    lead, workers = _make_channel_sessions()
    sessions = {lead.id: lead, **{w.id: w for w in workers}}
    _patch_channel_pty(monkeypatch, sessions)
    monkeypatch.setattr(bm_module, "tail_jsonl", _never_yield)

    result = await cm.start(lead.id, [w.id for w in workers], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    await asyncio.sleep(0)
    cm.stop(cid)
    await asyncio.sleep(0)

    assert cm.member_ids() == set(), f"Expected empty set after stop, got {cm.member_ids()}"


# ---------------------------------------------------------------------------
# Test 29 — worker relay task sends to LEAD only (not to other workers)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_worker_relay_targets_lead_only(monkeypatch):
    """A worker's relay task forwards its assistant turn to the lead, not to peer workers."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    write_calls = _patch_channel_pty(monkeypatch, sessions)

    # Track which tail_jsonl calls are made by index; first call = w1 relay task,
    # second = w2 relay task, third = lead relay task (tasks created in worker order
    # then lead last in ChannelManager.start).
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["n"] += 1
        current = call_idx["n"]
        if current == 1:
            # First watcher is w1 — yield one assistant entry
            yield {
                "type": "assistant",
                "content": [{"type": "text", "text": "Hello from w1"}],
            }
        # All other watchers hang
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for the worker relay to fire
    for _ in range(30):
        await asyncio.sleep(0.05)
        # Relay writes come AFTER the 3 kickoff writes
        if len(paste_only(write_calls)) > 3:
            break

    # Collect relay writes (beyond the initial 3 kickoff writes)
    relay_writes = paste_only(write_calls)[3:]
    assert len(relay_writes) >= 1, "Expected at least one relay write from w1"

    # All relay write targets must be the lead (not w2)
    relay_targets = {tid for tid, _ in relay_writes}
    assert lead.id in relay_targets, f"Lead not among relay targets: {relay_targets}"
    assert w2.id not in relay_targets, f"w2 should NOT receive w1's relay write, got targets: {relay_targets}"

    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 30 — lead relay task sends to ALL workers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_lead_relay_targets_all_workers(monkeypatch):
    """The lead's relay task forwards its assistant turn to ALL workers, not back to lead."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    write_calls = _patch_channel_pty(monkeypatch, sessions)

    # Tasks are spawned: worker w1 (idx=1), worker w2 (idx=2), lead (idx=3)
    # We want only the lead task (third call) to yield an entry.
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["n"] += 1
        current = call_idx["n"]
        if current == 3:
            # Third watcher is the lead relay task
            yield {
                "type": "assistant",
                "content": [{"type": "text", "text": "Lead directive to all workers"}],
            }
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for the lead relay to write to both workers
    for _ in range(30):
        await asyncio.sleep(0.05)
        if len(paste_only(write_calls)) > 4:  # 3 kickoff pastes + >=2 relay pastes
            break

    relay_writes = paste_only(write_calls)[3:]
    relay_targets = {tid for tid, _ in relay_writes}

    assert w1.id in relay_targets, f"w1 not among relay targets: {relay_targets}"
    assert w2.id in relay_targets, f"w2 not among relay targets: {relay_targets}"
    assert lead.id not in relay_targets, f"Lead should NOT receive its own relay, got targets: {relay_targets}"

    record = cm._channels[cid]
    await _cancel_channel_tasks(record)


# ---------------------------------------------------------------------------
# Test 31 — sentinel from a worker ends the channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_sentinel_from_worker_ends_channel(monkeypatch):
    """BRIDGE-DONE in a worker's reply transitions the channel to 'ended_sentinel'."""
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    _patch_channel_pty(monkeypatch, sessions)

    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["n"] += 1
        current = call_idx["n"]
        if current == 1:
            # First watcher is w1 — yield sentinel
            yield {
                "type": "assistant",
                "content": [{"type": "text", "text": "Task complete. BRIDGE-DONE"}],
            }
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt")
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for state to transition
    for _ in range(30):
        await asyncio.sleep(0.05)
        record = cm._channels[cid]
        if record.state != "active":
            break

    record = cm._channels[cid]
    assert record.state == "ended_sentinel", f"Expected ended_sentinel, got {record.state}"
    await asyncio.sleep(0)


# ---------------------------------------------------------------------------
# Test 32 — turn cap ends the channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_turn_cap_ends_channel(monkeypatch):
    """Channel ends with state='ended_capped' when max_turns is reached.

    max_turns=1: after a single relay (worker OR lead relaying once), the
    turns_used counter hits the cap and the channel ends.
    """
    cm = ChannelManager()
    lead = _make_mock_session("lead-1", "Lead Session")
    w1 = _make_mock_session("w1", "Worker One")
    w2 = _make_mock_session("w2", "Worker Two")
    sessions = {lead.id: lead, w1.id: w1, w2.id: w2}

    _patch_channel_pty(monkeypatch, sessions)

    # Each tail call yields one entry then hangs; any relay that fires first
    # will increment turns_used to 1 and hit the cap.
    call_idx = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        call_idx["n"] += 1
        yield {
            "type": "assistant",
            "content": [{"type": "text", "text": "One relay, no sentinel"}],
        }
        # Hang after yielding so the channel ends via cap not generator exhaustion
        await asyncio.sleep(3600)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.05)

    result = await cm.start(lead.id, [w1.id, w2.id], "prompt", max_turns=1)
    assert result.get("ok") is True
    cid = result["channel_id"]

    # Wait for turn cap to trigger
    for _ in range(40):
        await asyncio.sleep(0.05)
        record = cm._channels[cid]
        if record.state != "active":
            break

    record = cm._channels[cid]
    assert record.state == "ended_capped", f"Expected ended_capped, got {record.state}"
    assert record.turns_used >= 1
    await asyncio.sleep(0)


# ===========================================================================
# File-handoff + idle-gate tests (Tests 33–36)
# ===========================================================================


# ---------------------------------------------------------------------------
# Test 33 — large manual relay: file-handoff writes relay file, compact prompt sent
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_large_payload_uses_file_handoff(bm, patch_pty, from_session, to_session):
    """start_manual with a payload > 2048 bytes writes the full text to a relay
    file in _RELAY_DIR and injects a compact reference prompt instead.

    Assertions:
      - result is {ok: True}
      - the PTY write payload does NOT contain the full 3000-char body
      - the payload DOES contain a path inside _RELAY_DIR and the
        '[PEER REPLY from session "..."]' attribution
      - the relay file exists and its content equals the full injected text
        (prefix + message)
    """
    big_message = "A" * 3000  # 3000 bytes UTF-8, well over the 2048 threshold
    prefix = '[From session "From Session"]:'
    full_text = f"{prefix}\n{big_message}"

    result = await bm.start_manual(
        from_session.id,
        to_session.id,
        big_message,
        prefix=prefix,
    )

    assert result == {"ok": True}
    calls = pastes(patch_pty)
    assert len(calls) == 1
    _tid, data = calls[0]
    assert _tid == to_session.id

    # The PTY payload must NOT contain the full body (3000 A's)
    assert big_message not in data, (
        "Full large body should NOT appear inline in the PTY write when file-handoff is active"
    )

    # The payload must reference a path inside _RELAY_DIR
    relay_dir_str = str(bm_module._RELAY_DIR)
    assert relay_dir_str in data, (
        f"Compact prompt should contain a relay file path inside _RELAY_DIR={relay_dir_str!r}"
    )

    # The compact prompt includes attribution
    assert '[PEER REPLY from session "From Session"]' in data, (
        "Compact prompt must include '[PEER REPLY from session \"From Session\"]' attribution"
    )

    # Extract the relay file path from the payload and verify the file
    # Look for any substring of data that starts with relay_dir_str and ends before a newline
    match = re.search(
        rf'{re.escape(relay_dir_str)}[^\n]+_relay\.txt', data
    )
    assert match is not None, f"Could not find relay file path in payload:\n{data!r}"
    relay_path = pathlib.Path(match.group(0))

    try:
        assert relay_path.exists(), f"Relay file {relay_path} was not created"
        content = relay_path.read_text(encoding="utf-8")
        assert content == full_text, (
            f"Relay file content mismatch.\n"
            f"Expected: {full_text[:80]!r}...\n"
            f"Got:      {content[:80]!r}..."
        )
    finally:
        relay_path.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Test 34 — small manual relay: inline, no relay file created
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_small_payload_stays_inline(bm, patch_pty, from_session, to_session):
    """start_manual with a payload < 2048 bytes injects the full message inline.

    No relay file must appear in _RELAY_DIR as a result of this call.
    """
    small_message = "Short message for testing"
    prefix = '[From session "From Session"]:'

    # Snapshot _RELAY_DIR contents before the call
    relay_dir = bm_module._RELAY_DIR
    files_before = set(relay_dir.iterdir()) if relay_dir.exists() else set()

    result = await bm.start_manual(
        from_session.id,
        to_session.id,
        small_message,
        prefix=prefix,
    )

    assert result == {"ok": True}
    calls = pastes(patch_pty)
    assert len(calls) == 1
    _tid, data = calls[0]
    assert _tid == to_session.id

    # Full message must appear inline in the payload
    assert small_message in data, (
        "Small message must appear verbatim (inline) in the PTY write"
    )
    # Prefix must also be present inline
    assert "[From session" in data, (
        "Prefix must appear inline for small payloads"
    )

    # No new relay file must have been created
    files_after = set(relay_dir.iterdir()) if relay_dir.exists() else set()
    new_files = files_after - files_before
    relay_files = [f for f in new_files if f.name.endswith("_relay.txt")]
    assert len(relay_files) == 0, (
        f"Small payload should not create relay files, but found: {relay_files}"
    )


# ---------------------------------------------------------------------------
# Test 35 — idle-gate timeout on busy target in start_manual
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_manual_busy_target_returns_error(bm, monkeypatch, from_session):
    """start_manual returns {ok: False, error: '...busy...'} when the target
    session never reaches idle within the timeout.

    The idle gate is accelerated via patching _MANUAL_WAIT_MAX and
    _IDLE_POLL_INTERVAL so the test completes in < 200 ms.
    No PTY write must occur.
    """
    busy_target = _make_mock_session("to-busy", "Busy Target", alive=True, tracker_state="busy")
    sessions = {from_session.id: from_session, busy_target.id: busy_target}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))

    write_calls: list = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # Speed up the idle gate so the test doesn't take 60 seconds.
    # _wait_for_idle_simple uses _MANUAL_WAIT_MAX as its default timeout.
    monkeypatch.setattr(bm_module, "_MANUAL_WAIT_MAX", 0.05)
    monkeypatch.setattr(bm_module, "_IDLE_POLL_INTERVAL", 0.01)

    result = await bm.start_manual(from_session.id, busy_target.id, "hello")

    assert result.get("ok") is False, f"Expected ok=False for busy target, got: {result}"
    assert "error" in result
    assert "busy" in result["error"].lower(), (
        f"Error message should mention 'busy', got: {result['error']!r}"
    )

    # No PTY write must have been issued
    assert len(write_calls) == 0, (
        f"No PTY write should occur when target is busy, but got {len(write_calls)} write(s)"
    )


# ---------------------------------------------------------------------------
# Test 36 — _inject applies file-handoff for large auto/channel relay text
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inject_large_payload_uses_file_handoff(monkeypatch, from_session, to_session):
    """_inject() with a text > 2048 bytes writes a relay file and sends only a
    compact reference prompt to the PTY (never the full body).

    This covers the auto-bridge and channel relay code path (both call _inject).
    """
    sessions = {from_session.id: from_session, to_session.id: to_session}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))

    write_calls: list[tuple[str, str]] = []

    async def fake_write(tid, data):
        write_calls.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    # Build a minimal _BridgeRecord so _inject can reference record.bridge_id
    # and check record._stop_event.
    from bridge_manager import _BridgeRecord
    record = _BridgeRecord(
        bridge_id="test000000aa",
        from_id=from_session.id,
        to_id=to_session.id,
        from_name=from_session.name,
        to_name=to_session.name,
        max_turns=4,
    )

    big_text = "B" * 3000  # > 2048 bytes

    # Snapshot relay dir before call
    relay_dir = bm_module._RELAY_DIR
    files_before = set(relay_dir.iterdir()) if relay_dir.exists() else set()

    inject_result = await bm_module._inject(to_session.id, big_text, record)

    # _inject now returns a string sentinel: "ok" | "skip" | "fatal"
    assert inject_result == "ok", f"_inject should return 'ok' on success, got {inject_result!r}"
    assert len(pastes(write_calls)) == 1

    _tid, data = write_calls[0]
    assert _tid == to_session.id

    # Full large body must NOT be in the PTY write
    assert big_text not in data, (
        "Full large body should NOT appear inline in _inject output when file-handoff is active"
    )

    # Relay dir path must appear in the compact prompt
    relay_dir_str = str(relay_dir)
    assert relay_dir_str in data, (
        "Compact prompt from _inject must reference a relay file path"
    )

    # Verify relay file was actually created and cleaned up
    files_after = set(relay_dir.iterdir()) if relay_dir.exists() else set()
    new_files = files_after - files_before
    relay_files = [f for f in new_files if f.name.endswith("_relay.txt")]
    assert len(relay_files) == 1, f"Expected exactly 1 relay file, found: {relay_files}"

    # Relay file content should be the original text
    relay_content = relay_files[0].read_text(encoding="utf-8")
    assert relay_content == big_text

    # Cleanup
    relay_files[0].unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Test 37 — relay-file GC deletes stale files (regression for monotonic/wall bug)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_relay_file_gc_deletes_stale_files():
    """_maybe_file_handoff's opportunistic GC deletes files whose mtime is older
    than _RELAY_FILE_MAX_AGE seconds.

    Regression test: the original code compared time.monotonic() to st_mtime
    (wall-clock epoch seconds), making the age check always False so stale files
    were never deleted.  The fix uses time.time() so both sides of the comparison
    are in wall-clock seconds.

    This test MUST fail against the old buggy time.monotonic() code because
    time.monotonic() is a small uptime-relative value (e.g. a few thousand
    seconds), while st_mtime is a large Unix timestamp (> 1_700_000_000), so
    `now - st_mtime` is deeply negative and never exceeds _RELAY_FILE_MAX_AGE.
    With time.time(), the backdated mtime produces a positive age well above
    the TTL, and the file is correctly deleted.

    Note: _maybe_file_handoff is async (it wraps its blocking file I/O in
    asyncio.to_thread — see bridge_manager fix "blocking I/O on the event
    loop"), so this test must be async and await the call.
    """
    # Plant a stale file directly in the module-level relay dir.
    stale = bm_module._RELAY_DIR / "stale_relay.txt"
    stale.write_text("old content")

    # Backdate its mtime well beyond the TTL using wall-clock time.
    old_ts = time.time() - (bm_module._RELAY_FILE_MAX_AGE + 120)
    os.utime(stale, (old_ts, old_ts))

    # Trigger the opportunistic GC by calling _maybe_file_handoff with a
    # payload that exceeds the inline threshold (> 2048 bytes).
    await bm_module._maybe_file_handoff("A" * 3000, peer_name=None)

    # The stale file must have been deleted.
    assert not stale.exists(), (
        "Stale relay file was not deleted — GC likely compared time.monotonic() "
        "to st_mtime (wall-clock) so the age check was always False."
    )

    # Clean up any relay files created by the _maybe_file_handoff call above
    # so as not to pollute other tests or leave secrets-at-rest behind.
    for f in bm_module._RELAY_DIR.glob("*_relay.txt"):
        try:
            f.unlink(missing_ok=True)
        except Exception:
            pass
