import json
import threading
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

import codex_usage
import server
from pty_manager import PtyManager, TerminalSession
from usage_tracker import UsageTracker


@pytest.mark.asyncio
async def test_transcript_identity_matches_its_file_when_native_conversation_switches(monkeypatch):
    session = SimpleNamespace(
        harness="codex", codex_usage_lock=threading.Lock(),
        codex_rollout_path="first.jsonl", codex_session_id="first-native",
        codex_usage={"binding_status": "verified"},
    )
    manager = SimpleNamespace(get_terminal=lambda _: session, refresh_codex_usage=lambda *_: {})
    monkeypatch.setattr(server, "pty_manager", manager)

    def read_and_switch(path, before, limit):
        assert path == "first.jsonl"
        with session.codex_usage_lock:
            session.codex_rollout_path = "second.jsonl"
            session.codex_session_id = "second-native"
        return {"available": True, "messages": [{"text": "first conversation"}]}

    monkeypatch.setattr("codex_transcript.transcript_page", read_and_switch)
    # get_codex_transcript is async def (N04 -- its blocking body now runs
    # via asyncio.to_thread), so it must be awaited rather than called
    # directly; every assertion below is unchanged.
    result = await server.get_codex_transcript("pane")
    assert result["session_id"] == "first-native"
    assert result["messages"][0]["text"] == "first conversation"


@pytest.mark.asyncio
async def test_owned_rollout_reaches_usage_and_history_routes_and_persistent_store(tmp_path, monkeypatch):
    path = tmp_path / "rollout.jsonl"
    counts = {"input_tokens": 1000, "cached_input_tokens": 800, "output_tokens": 100,
              "total_tokens": 1100, "reasoning_output_tokens": 40}
    rows = [
        {"type": "session_meta", "payload": {"id": "native-id", "cli_version": "0.153.0"}},
        {"type": "turn_context", "payload": {"model": "gpt-6-astra"}},
        {"type": "response_item", "payload": {"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "Earlier question"}]}},
        {"type": "token_usage_record", "timestamp": "2026-09-07T00:00:00Z",
         "payload": {"response_id": "response-1", "thread_id": "native-id", "usage": counts}},
        {"type": "event_msg", "payload": {"type": "token_count", "info": {
            "model_context_window": 10000, "total_token_usage": counts, "last_token_usage": counts}}},
    ]
    path.write_text("\n".join(map(json.dumps, rows)) + "\n", encoding="utf-8")
    manager = PtyManager()
    tracker = UsageTracker(db_path=tmp_path / "usage.db")
    session = TerminalSession(
        id="pane-one", name="fixture", pty=MagicMock(pid=42), created_at="", harness="codex", working_dir=str(tmp_path),
    )
    manager.sessions[session.id] = session
    monkeypatch.setattr(server, "pty_manager", manager)
    monkeypatch.setattr(server, "usage_tracker", tracker)
    monkeypatch.setattr(codex_usage, "discover_rollout", lambda *args, **kwargs: path)
    try:
        async with AsyncClient(transport=ASGITransport(app=server.app), base_url="http://localhost:8420") as client:
            response = await client.get("/api/terminals/pane-one/usage")
            assert response.status_code == 200
            data = response.json()
            assert data["context_tokens"] == 1100 and data["context_window"] == 10000
            assert data["context_percent"] == 11
            assert data["total_tokens"] == 1100  # cache/reasoning are subsets
            assert data["est_cost_usd"] == pytest.approx((200 * 10 + 800 + 100 * 50) / 1e6)
            assert session.codex_session_id == "native-id"
            history = await client.get("/api/terminals/pane-one/transcript")
            assert history.json()["messages"][0]["text"] == "Earlier question"
            forbidden = await client.get("/api/terminals/pane-one/transcript", headers={"Origin": "https://foreign.example"})
            assert forbidden.status_code == 403
        assert tracker.session_summary("pane-one")["total_tokens"] == 1100
    finally:
        tracker.close()
        manager._pty_executor.shutdown(wait=True)
