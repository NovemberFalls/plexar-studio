"""The Codex rollout SEARCH is spaced out; the usage READ is not (R-193).

`codex_usage.discover_rollout` calls `psutil.Process.open_files()` across the Codex
CLI's process tree, and on Windows that enumerates every handle on the machine.
MEASURED 2026-09-10 on the owner's six-session sidecar: ~64% of all py-spy samples
in the process, re-run every 2 s even after the rollout was already bound. Worker
threads grinding through it starved the event loop until the watchdog killed a
live workspace.

These pin the cadence:
  * the search runs on the FIRST refresh, and whenever a caller forces a refresh by
    zeroing `codex_usage_checked` (the existing identity tests rely on that);
  * a BOUND rollout is not re-searched until `_CODEX_REDISCOVER_BOUND_S` has passed,
    yet its usage is still read on every refresh;
  * an UNBOUND session is re-searched on the shorter `_CODEX_REDISCOVER_UNBOUND_S`.

Time is driven through the session's own timestamps, never by patching the clock.
"""

import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import codex_usage
import pty_manager
from pty_manager import PtyManager


class _Reader:
    """Stands in for CodexUsageReader: records reads, returns a stable identity."""

    def __init__(self):
        self.reads = 0

    def read(self, path, pricing):
        self.reads += 1
        return {"session_id": "s1", "total_tokens": self.reads}

    def take_events(self, path):
        return []

    def restore_events(self, path, events):
        pass


@pytest.fixture()
def rig(tmp_path, monkeypatch):
    rollout = tmp_path / "rollout-2026-09-10T00-00-00-s1.jsonl"
    rollout.write_text("", encoding="utf-8")
    reader = _Reader()
    monkeypatch.setattr(codex_usage, "CodexUsageReader", lambda: reader)
    monkeypatch.setattr(codex_usage, "reference_pricing", lambda: {})
    session = SimpleNamespace(
        id="owned", harness="codex", alive=True,
        pty=SimpleNamespace(pid=123, isalive=lambda: True), working_dir=str(tmp_path),
        codex_usage_lock=threading.Lock(), codex_usage_checked=0,
        codex_rollout_path=None, codex_usage_reader=None,
        codex_session_id=None, codex_usage={}, effort="high",
    )
    manager = object.__new__(PtyManager)
    manager.sessions = {session.id: session}
    return manager, session, rollout, reader


def _past(seconds):
    return time.monotonic() - seconds


def test_the_first_refresh_searches_and_binds(rig, monkeypatch):
    manager, session, rollout, _reader = rig
    discover = Mock(return_value=rollout)
    monkeypatch.setattr(codex_usage, "discover_rollout", discover)
    result = manager.refresh_codex_usage(session)
    assert discover.call_count == 1
    assert session.codex_rollout_path == str(rollout)
    assert result["binding_status"] == "verified"


def test_a_bound_rollout_is_not_re_searched_before_the_interval(rig, monkeypatch):
    """THE FIX. Before R-193 this searched on every refresh past the 2 s gate."""
    manager, session, rollout, reader = rig
    discover = Mock(return_value=rollout)
    monkeypatch.setattr(codex_usage, "discover_rollout", discover)
    manager.refresh_codex_usage(session)
    reads_after_bind = reader.reads

    session.codex_usage_checked = _past(3)      # past the 2 s usage gate
    session.codex_discover_checked = _past(5)   # well inside the bound interval
    result = manager.refresh_codex_usage(session)

    assert discover.call_count == 1, "the expensive search ran again for a bound rollout"
    assert reader.reads > reads_after_bind, "usage must still be read on every refresh"
    assert result["binding_status"] == "verified", "the last search's status is kept"


def test_a_bound_rollout_is_re_searched_after_the_interval(rig, monkeypatch):
    """The positive twin: a native /new or /resume must still be found."""
    manager, session, rollout, _reader = rig
    discover = Mock(return_value=rollout)
    monkeypatch.setattr(codex_usage, "discover_rollout", discover)
    manager.refresh_codex_usage(session)

    session.codex_usage_checked = _past(3)
    session.codex_discover_checked = _past(pty_manager._CODEX_REDISCOVER_BOUND_S + 1)
    manager.refresh_codex_usage(session)
    assert discover.call_count == 2


def test_zeroing_the_check_time_forces_a_search(rig, monkeypatch):
    """The contract the existing identity tests use to force a full refresh."""
    manager, session, rollout, _reader = rig
    discover = Mock(return_value=rollout)
    monkeypatch.setattr(codex_usage, "discover_rollout", discover)
    manager.refresh_codex_usage(session)

    session.codex_usage_checked = 0
    session.codex_discover_checked = _past(1)   # a search just happened
    manager.refresh_codex_usage(session)
    assert discover.call_count == 2


def test_an_unbound_session_uses_the_shorter_interval(rig, monkeypatch):
    manager, session, _rollout, _reader = rig
    discover = Mock(return_value=None)
    monkeypatch.setattr(codex_usage, "discover_rollout", discover)
    manager.refresh_codex_usage(session)
    assert discover.call_count == 1

    session.codex_usage_checked = _past(3)
    session.codex_discover_checked = _past(5)   # < UNBOUND interval
    manager.refresh_codex_usage(session)
    assert discover.call_count == 1

    session.codex_usage_checked = _past(3)
    session.codex_discover_checked = _past(pty_manager._CODEX_REDISCOVER_UNBOUND_S + 1)
    manager.refresh_codex_usage(session)
    assert discover.call_count == 2
