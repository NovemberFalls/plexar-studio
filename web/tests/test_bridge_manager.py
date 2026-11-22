"""Tests for BridgeManager (web/bridge_manager.py).

Covers:
  - start_manual: bracketed-paste injection, dead-session guard, prefix handling
  - file handoff for large payloads and relay-file GC

All tests are isolated — no real PTY processes or filesystem access.
pty_manager is replaced by monkeypatched stubs for each test.
"""

from __future__ import annotations

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
