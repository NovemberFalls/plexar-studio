"""Identity boundaries for native transcript discovery; no real processes used."""
import json
import threading
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

from pty_manager import PtyManager


def fixture_session(tmp_path, *, alive=True, process_alive=True):
    session = SimpleNamespace(
        id="owned", harness="codex", alive=alive,
        pty=SimpleNamespace(pid=123, isalive=lambda: process_alive), working_dir=str(tmp_path),
        codex_usage_lock=threading.Lock(), codex_usage_checked=0,
        codex_rollout_path=None, codex_usage_reader=None,
        codex_session_id="requested-resume-id", codex_usage={}, effort="high",
    )
    manager = object.__new__(PtyManager)
    manager.sessions = {session.id: session}
    return manager, session


def test_dead_session_does_not_discover_reused_pid(tmp_path, monkeypatch):
    discover = Mock(side_effect=AssertionError("Dead session PID must not be inspected"))
    monkeypatch.setattr("codex_usage.discover_rollout", discover)
    for alive, process_alive in [(False, False), (True, False)]:
        manager, session = fixture_session(tmp_path, alive=alive, process_alive=process_alive)
        manager.refresh_codex_usage(session)
        assert session.codex_session_id == "requested-resume-id"
        assert session.codex_rollout_path is None
    discover.assert_not_called()


def test_foreign_discovery_cannot_overwrite_known_resume_identity(tmp_path, monkeypatch):
    path = tmp_path / "rollout-foreign.jsonl"
    path.write_text(json.dumps({"type": "session_meta", "payload": {"id": "foreign-id"}}) + "\n")
    discover = Mock(return_value=path)
    monkeypatch.setattr("codex_usage.discover_rollout", discover)
    manager, session = fixture_session(tmp_path)
    store = SimpleNamespace(ingest_codex_events=Mock())
    manager.refresh_codex_usage(session, store)
    assert session.codex_session_id == "requested-resume-id"
    assert session.codex_rollout_path is None
    assert not session.codex_usage.get("usage_available")
    store.ingest_codex_events.assert_not_called()
    assert discover.call_args.kwargs["expected_session_id"] == "requested-resume-id"


def test_discovery_filters_foreign_metadata_even_when_the_file_is_the_only_candidate(tmp_path):
    from codex_usage import discover_rollout
    path = tmp_path / "rollout-foreign.jsonl"
    path.write_text(json.dumps({"type": "session_meta", "payload": {
        "id": "foreign-id", "source": "cli", "cwd": str(tmp_path),
    }}) + "\n")
    assert discover_rollout(123, str(tmp_path), sessions_root=tmp_path,
                            expected_session_id="requested-resume-id") is None
    assert discover_rollout(123, str(tmp_path), sessions_root=tmp_path,
                            expected_session_id="foreign-id") == path


def rollout(path, sid, tokens):
    rows = [
        {"type": "session_meta", "payload": {"id": sid, "cli_version": "0.153.0"}},
        {"type": "turn_context", "payload": {"model": "gpt-6-astra"}},
        {"type": "token_usage_record", "timestamp": "2026-09-07T12:00:00Z", "payload": {
            "thread_id": sid, "response_id": "response-1", "usage": {
                "input_tokens": tokens, "cached_input_tokens": 0, "output_tokens": 1, "total_tokens": tokens + 1,
            }}},
    ]
    path.write_text("\n".join(map(json.dumps, rows)) + "\n")
    return path


def test_native_new_switches_owned_rollout_and_retains_pending_old_events(tmp_path, monkeypatch):
    first = rollout(tmp_path / "rollout-first.jsonl", "requested-resume-id", 10)
    second = rollout(tmp_path / "rollout-second.jsonl", "new-native-id", 20)
    discovery = Mock(side_effect=[first, second, second])
    monkeypatch.setattr("codex_usage.discover_rollout", discovery)
    manager, session = fixture_session(tmp_path)
    assert manager.refresh_codex_usage(session)["total_tokens"] == 11
    session.codex_usage_checked = 0
    assert manager.refresh_codex_usage(session)["total_tokens"] == 21
    assert session.codex_session_id == "new-native-id"
    assert session.codex_rollout_path == str(second)
    assert discovery.call_args.kwargs["expected_session_id"] is None
    store = SimpleNamespace(ingest_codex_events=Mock())
    session.codex_usage_checked = 0
    manager.refresh_codex_usage(session, store)
    batches = store.ingest_codex_events.call_args_list
    assert {call.args[1] for call in batches} == {str(first), str(second)}
    assert sorted(event["input_tokens"] for call in batches for event in call.args[2]) == [10, 20]


def test_ambiguous_live_discovery_marks_retained_identity_last_known(tmp_path, monkeypatch):
    path = rollout(tmp_path / "rollout-first.jsonl", "requested-resume-id", 10)
    monkeypatch.setattr("codex_usage.discover_rollout", Mock(side_effect=[path, None]))
    manager, session = fixture_session(tmp_path)
    manager.refresh_codex_usage(session)
    session.codex_usage_checked = 0
    result = manager.refresh_codex_usage(session)
    assert result["binding_status"] == "last_known"
    assert session.codex_session_id == "requested-resume-id"
    assert session.codex_rollout_path == str(path)


def test_same_path_identity_replacement_is_rejected(tmp_path, monkeypatch):
    path = rollout(tmp_path / "rollout-first.jsonl", "requested-resume-id", 10)
    monkeypatch.setattr("codex_usage.discover_rollout", Mock(return_value=path))
    manager, session = fixture_session(tmp_path)
    manager.refresh_codex_usage(session)
    with path.open("a") as stream:
        stream.write(json.dumps({"type": "session_meta", "payload": {"id": "foreign-id"}}) + "\n")
    session.codex_usage_checked = 0
    store = SimpleNamespace(ingest_codex_events=Mock())
    assert manager.refresh_codex_usage(session, store)["usage_available"] is False
    assert session.codex_session_id == "requested-resume-id"
    assert session.codex_rollout_path is None
    store.ingest_codex_events.assert_not_called()


def test_switch_flush_failure_keeps_old_identity_and_retries_pending_batch(tmp_path, monkeypatch):
    first = rollout(tmp_path / "rollout-first.jsonl", "requested-resume-id", 10)
    second = rollout(tmp_path / "rollout-second.jsonl", "new-native-id", 20)
    monkeypatch.setattr("codex_usage.discover_rollout", Mock(side_effect=[first, second, second]))
    manager, session = fixture_session(tmp_path)
    manager.refresh_codex_usage(session)
    store = SimpleNamespace(ingest_codex_events=Mock(side_effect=RuntimeError("database unavailable")))
    session.codex_usage_checked = 0
    with pytest.raises(RuntimeError, match="database unavailable"):
        manager.refresh_codex_usage(session, store)
    assert session.codex_session_id == "requested-resume-id"
    assert session.codex_rollout_path == str(first)
    store.ingest_codex_events = Mock()
    session.codex_usage_checked = 0
    manager.refresh_codex_usage(session, store)
    assert session.codex_session_id == "new-native-id"
    assert [call.args[1] for call in store.ingest_codex_events.call_args_list] == [str(first), str(second)]
