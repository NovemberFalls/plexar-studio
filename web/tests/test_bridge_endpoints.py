"""Tests for Bridge / Peer Coordination FastAPI endpoints (web/server.py).

Covers:
  GET  /api/terminals/{id}/latest-assistant  — 404, no JSONL, happy path, no assistant entries
  POST /api/bridge/manual                    — validation, self-bridge, success, failure
                                               plus the mailbox conflict guard (409)

All tests use httpx AsyncClient + ASGITransport matching the existing test_server.py pattern.
bridge_manager and pty_manager methods are replaced with lightweight stubs via monkeypatch
to avoid PTY or filesystem access.
"""

from __future__ import annotations

import sys
import os
from unittest.mock import MagicMock, patch

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from server import app
import server as server_module


# ---------------------------------------------------------------------------
# Shared fixture — AsyncClient
# ---------------------------------------------------------------------------


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


# ---------------------------------------------------------------------------
# Helper — mock session
# ---------------------------------------------------------------------------


def _mock_session(terminal_id="term-abc"):
    s = MagicMock()
    s.id = terminal_id
    s.alive = True
    s.working_dir = "/tmp/test"
    s.claude_session_id = "session-123"
    return s


# ---------------------------------------------------------------------------
# GET /api/terminals/{id}/latest-assistant
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_latest_assistant_terminal_not_found(client, monkeypatch):
    """Returns 404 when the terminal ID does not exist."""
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: None)

    res = await client.get("/api/terminals/nonexistent/latest-assistant")
    assert res.status_code == 404
    assert "error" in res.json()


@pytest.mark.asyncio
async def test_latest_assistant_no_jsonl(client, monkeypatch):
    """Returns 200 with {text: null, reason: 'no JSONL yet'} when JSONL path is None."""
    session = _mock_session()
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(server_module.pty_manager, "_get_jsonl_path", lambda s: None)

    res = await client.get("/api/terminals/term-abc/latest-assistant")
    assert res.status_code == 200
    data = res.json()
    assert data["text"] is None
    assert data["reason"] == "no JSONL yet"


@pytest.mark.asyncio
async def test_latest_assistant_returns_text(client, monkeypatch):
    """Returns the latest assistant text block when one exists."""
    session = _mock_session()
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(server_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    assistant_entry = {
        "type": "assistant",
        "id": "msg-1",
        "timestamp": "2026-01-01T00:00:00Z",
        "content": [{"type": "text", "text": "The answer is 42."}],
    }

    # read_all_messages is imported inside the route via `from jsonl_watcher import read_all_messages`
    # so patch at the jsonl_watcher module level.
    with patch("jsonl_watcher.read_all_messages", return_value=[assistant_entry]):
        res = await client.get("/api/terminals/term-abc/latest-assistant")

    assert res.status_code == 200
    data = res.json()
    assert data["text"] == "The answer is 42."
    assert data["message_id"] == "msg-1"


@pytest.mark.asyncio
async def test_latest_assistant_no_assistant_entries(client, monkeypatch):
    """Returns {text: null, reason: 'no assistant message found'} when JSONL has no assistant entries."""
    session = _mock_session()
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(server_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    user_entry = {
        "type": "user",
        "id": "msg-0",
        "timestamp": "2026-01-01T00:00:00Z",
        "content": [{"type": "text", "text": "Hello"}],
    }
    tool_result_entry = {
        "type": "tool_result",
        "id": "msg-t",
        "timestamp": "2026-01-01T00:00:01Z",
        "content": [{"type": "tool_result", "tool_use_id": "tu-1", "content": "ok"}],
    }

    with patch("jsonl_watcher.read_all_messages", return_value=[user_entry, tool_result_entry]):
        res = await client.get("/api/terminals/term-abc/latest-assistant")

    assert res.status_code == 200
    data = res.json()
    assert data["text"] is None
    assert data["reason"] == "no assistant message found"


# ---------------------------------------------------------------------------
# POST /api/bridge/manual
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bridge_manual_missing_fields(client):
    """Returns 400 when any of the required fields is absent."""
    # Missing message
    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
    })
    assert res.status_code == 400

    # Missing to_terminal_id
    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "message": "hello",
    })
    assert res.status_code == 400

    # Missing from_terminal_id
    res = await client.post("/api/bridge/manual", json={
        "to_terminal_id": "b",
        "message": "hello",
    })
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_bridge_manual_self_bridge_rejected(client):
    """Returns 400 when from_terminal_id == to_terminal_id."""
    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "same",
        "to_terminal_id": "same",
        "message": "hi",
    })
    assert res.status_code == 400
    assert "itself" in res.json().get("error", "").lower()


@pytest.mark.asyncio
async def test_bridge_manual_success(client, monkeypatch):
    """Returns 200 with {ok: True} when start_manual succeeds."""
    async def fake_start_manual(*a, **kw):
        return {"ok": True}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)

    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "message": "relay this",
    })
    assert res.status_code == 200
    assert res.json()["ok"] is True


@pytest.mark.asyncio
async def test_bridge_manual_failure_returns_400(client, monkeypatch):
    """Returns 400 with {ok: False, error: ...} when start_manual fails."""
    async def fake_start_manual(*a, **kw):
        return {"ok": False, "error": "Target session dead"}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)

    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "message": "relay",
    })
    assert res.status_code == 400
    data = res.json()
    assert data["ok"] is False
    assert "error" in data


# ---------------------------------------------------------------------------
# POST /api/bridge/manual conflict guard (live mailbox bridge)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("busy", [{"a"}, {"b"}])
async def test_bridge_manual_conflict_when_session_in_mailbox_bridge(client, monkeypatch, busy):
    """409 when either session is enrolled in a live mailbox bridge."""
    monkeypatch.setattr(server_module.mailbox_manager, "member_ids", MagicMock(return_value=busy))
    calls: list = []

    async def fake_start_manual(*a, **kw):
        calls.append((a, kw))
        return {"ok": True}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)
    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a", "to_terminal_id": "b", "message": "relay this",
    })
    assert res.status_code == 409
    assert res.json()["ok"] is False
    assert calls == []


@pytest.mark.asyncio
async def test_bridge_manual_no_conflict_without_mailbox_membership(client, monkeypatch):
    monkeypatch.setattr(server_module.mailbox_manager, "member_ids", MagicMock(return_value=set()))

    async def fake_start_manual(*a, **kw):
        return {"ok": True}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)
    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a", "to_terminal_id": "b", "message": "fresh relay",
    })
    assert res.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("method,path", [
    ("post", "/api/bridge/auto"),
    ("get", "/api/bridge"),
    ("post", "/api/bridge/channel"),
    ("get", "/api/bridge/channel"),
])
async def test_auto_and_channel_routes_are_gone(client, method, path):
    res = await getattr(client, method)(path)
    assert res.status_code in (404, 405)
