"""Tests for SessionStateTracker — pure logic, no mocks needed."""

import time
from pty_manager import SessionStateTracker


def test_initial_state_is_starting():
    tracker = SessionStateTracker()
    assert tracker.state == "starting"


def test_feed_transitions_to_busy():
    tracker = SessionStateTracker()
    tracker.feed("Some output from Claude")
    assert tracker.state == "busy"


def test_token_parsing():
    tracker = SessionStateTracker()
    tracker.feed("Total: 1,234 tokens used")
    assert tracker.total_tokens == 1234


def test_token_parsing_no_comma():
    tracker = SessionStateTracker()
    tracker.feed("Used 500 tokens so far")
    assert tracker.total_tokens == 500


def test_cost_parsing():
    tracker = SessionStateTracker()
    tracker.feed("Cost: $0.05 for this session")
    assert tracker.total_cost == 0.05


def test_cost_accumulates_upward():
    tracker = SessionStateTracker()
    tracker.feed("$0.01")
    assert tracker.total_cost == 0.01
    tracker.feed("$0.05")
    assert tracker.total_cost == 0.05
    # Lower value should NOT replace
    tracker.feed("$0.02")
    assert tracker.total_cost == 0.05


def test_idle_detection_with_prompt_pattern():
    tracker = SessionStateTracker()
    tracker.feed("Some output\n❯")
    # Force enough time to pass
    tracker.last_output_time = time.time() - 2.0
    state = tracker.tick()
    assert state == "idle"


def test_waiting_detection():
    tracker = SessionStateTracker()
    tracker.feed("Do you want to proceed? (y/n)")
    tracker.last_output_time = time.time() - 2.0
    state = tracker.tick()
    assert state == "waiting"


def test_buffer_rolling():
    tracker = SessionStateTracker()
    # Feed more than 2000 chars
    tracker.feed("x" * 3000)
    assert len(tracker.buffer) == 2000


def test_busy_stays_during_active_output():
    tracker = SessionStateTracker()
    tracker.feed("Working on something...")
    # Recent output — should stay busy
    state = tracker.tick()
    assert state == "busy"


def test_folder_trust_dialog_is_waiting_not_idle():
    """Measured 2026-09-30: Claude Code's trust dialog in a fresh folder (every new
    worktree worker) read as idle, so the agent API prompted it -- and Esc on it exits
    the CLI. The screen text below is the captured dialog, ANSI already stripped."""
    tracker = SessionStateTracker()
    tracker.feed(
        " Quick safety check: Is this a project you created or one you trust?\n"
        " Claude Code'll be able to read, edit, and execute files here.\n"
        " ❯ 1. Yes, I trust this folder\n   2. No, exit\n"
        " Enter to confirm · Esc to cancel\n"
    )
    tracker.last_output_time = time.time() - 5
    assert tracker.tick() == "waiting"


def test_working_footer_beats_the_idle_glyph():
    """Claude Code keeps its prompt glyph on screen while it works; its footer says
    "esc to interrupt" until the turn ends. Measured 2026-10-01: without this check a
    worker read as idle mid-turn and its parent collected an empty answer."""
    tracker = SessionStateTracker()
    tracker.feed("❯ \n  bypass permissions on (shift+tab to cycle) · esc to interrupt\n")
    tracker.last_output_time = time.time() - 12
    assert tracker.tick() == "busy"
    tracker.feed("❯ \n  bypass permissions on (shift+tab to cycle) · ? for shortcuts\n")
    tracker.last_output_time = time.time() - 2
    assert tracker.tick() == "idle"


def test_idle_footer_without_glyph_is_idle_immediately():
    """Measured 2026-10-01 (Claude Code 2.1.283): the idle tail is a divider plus the
    footer, no prompt glyph. A redraw must not read as WORKING for 10 s."""
    tracker = SessionStateTracker()
    tracker.feed("─" * 120 + "\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents\n\n\n")
    tracker.last_output_time = time.time() - 1.5
    assert tracker.tick() == "idle"
    busy = SessionStateTracker()
    busy.feed("─" * 120 + "\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt\n")
    busy.last_output_time = time.time() - 1.5
    assert busy.tick() == "busy"
