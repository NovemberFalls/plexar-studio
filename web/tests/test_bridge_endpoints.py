"""Tests for Bridge / Peer Coordination FastAPI endpoints (web/server.py lines ~577-696).

Covers:
  GET  /api/terminals/{id}/latest-assistant  — 404, no JSONL, happy path, no assistant entries
  POST /api/bridge/manual                    — validation, self-bridge, success, failure
  POST /api/bridge/auto                      — max_turns validation, self-bridge, conflict guard,
                                               no-conflict-when-ended, success
  DELETE /api/bridge/{bridge_id}             — 404 unknown, 200 known
  GET  /api/bridge                           — list shape

All tests use httpx AsyncClient + ASGITransport matching the existing test_server.py pattern.
bridge_manager and pty_manager methods are replaced with lightweight stubs via monkeypatch
to avoid PTY or filesystem access.
"""

from __future__ import annotations

import sys
import os
from unittest.mock import AsyncMock, MagicMock, patch

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
# POST /api/bridge/manual — conflict guard (409)
#
# Regression tests for the fix that gave manual relay the same busy-session
# guard as /api/bridge/auto and /api/bridge/channel. Previously start_manual
# had NO conflict check at all — a manual relay into (or out of) a session
# already enrolled in an active V2 bridge or V3 channel would interleave
# writes into that session's PTY input buffer with the active relay task's
# writes, corrupting output.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bridge_manual_conflict_when_from_id_in_active_bridge(client, monkeypatch):
    """Returns 409 when from_terminal_id is already in an active bridge."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [{"bridge_id": "br-1", "from_id": "a", "to_id": "c", "state": "active",
                  "from_name": "A", "to_name": "C", "turns_used": 0, "max_turns": 4}],
    )
    monkeypatch.setattr(server_module.channel_manager, "member_ids", MagicMock(return_value=set()))

    start_manual_calls: list = []

    async def fake_start_manual(*a, **kw):
        start_manual_calls.append((a, kw))
        return {"ok": True}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)

    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "message": "relay this",
    })
    assert res.status_code == 409
    data = res.json()
    assert data["ok"] is False
    assert "active bridge" in data.get("error", "").lower()
    # start_manual must NOT have been called — the guard short-circuits before it
    assert len(start_manual_calls) == 0


@pytest.mark.asyncio
async def test_bridge_manual_conflict_when_to_id_in_active_bridge(client, monkeypatch):
    """Returns 409 when to_terminal_id is already in an active bridge."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [{"bridge_id": "br-1", "from_id": "x", "to_id": "b", "state": "active",
                  "from_name": "X", "to_name": "B", "turns_used": 0, "max_turns": 4}],
    )
    monkeypatch.setattr(server_module.channel_manager, "member_ids", MagicMock(return_value=set()))

    start_manual_calls: list = []

    async def fake_start_manual(*a, **kw):
        start_manual_calls.append((a, kw))
        return {"ok": True}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)

    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "message": "relay this",
    })
    assert res.status_code == 409
    assert res.json()["ok"] is False
    assert len(start_manual_calls) == 0


@pytest.mark.asyncio
async def test_bridge_manual_conflict_when_session_in_active_channel(client, monkeypatch):
    """Returns 409 when either session is already enrolled in an active channel."""
    monkeypatch.setattr(server_module.bridge_manager, "list_active", lambda: [])
    monkeypatch.setattr(
        server_module.channel_manager,
        "member_ids",
        MagicMock(return_value={"b"}),
    )

    start_manual_calls: list = []

    async def fake_start_manual(*a, **kw):
        start_manual_calls.append((a, kw))
        return {"ok": True}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)

    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "message": "relay this",
    })
    assert res.status_code == 409
    data = res.json()
    assert data["ok"] is False
    assert "channel" in data.get("error", "").lower()
    assert len(start_manual_calls) == 0


@pytest.mark.asyncio
async def test_bridge_manual_no_conflict_when_only_ended_bridges_exist(client, monkeypatch):
    """Does NOT return 409 when all existing bridges are in a terminal state."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [{"bridge_id": "old1", "from_id": "a", "to_id": "b", "state": "ended_user",
                  "from_name": "A", "to_name": "B", "turns_used": 2, "max_turns": 4}],
    )
    monkeypatch.setattr(server_module.channel_manager, "member_ids", MagicMock(return_value=set()))

    async def fake_start_manual(*a, **kw):
        return {"ok": True}

    monkeypatch.setattr(server_module.bridge_manager, "start_manual", fake_start_manual)

    res = await client.post("/api/bridge/manual", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "message": "fresh relay",
    })
    assert res.status_code != 409
    assert res.status_code == 200
    assert res.json()["ok"] is True


# ---------------------------------------------------------------------------
# POST /api/bridge/auto
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bridge_auto_max_turns_invalid_string(client):
    """Returns 400 when max_turns is a non-integer string."""
    res = await client.post("/api/bridge/auto", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "kickoff_prompt": "go",
        "max_turns": "banana",
    })
    assert res.status_code == 400
    assert "integer" in res.json().get("error", "").lower()


@pytest.mark.asyncio
async def test_bridge_auto_max_turns_out_of_range(client):
    """Returns 400 when max_turns is 0 or 11 (out of 1–10 range)."""
    for bad_val in [0, 11, -1]:
        res = await client.post("/api/bridge/auto", json={
            "from_terminal_id": "a",
            "to_terminal_id": "b",
            "kickoff_prompt": "go",
            "max_turns": bad_val,
        })
        assert res.status_code == 400, f"Expected 400 for max_turns={bad_val}, got {res.status_code}"
        assert "max_turns" in res.json().get("error", "")


@pytest.mark.asyncio
async def test_bridge_auto_self_bridge_rejected(client):
    """Returns 400 when from_terminal_id == to_terminal_id."""
    res = await client.post("/api/bridge/auto", json={
        "from_terminal_id": "same",
        "to_terminal_id": "same",
        "kickoff_prompt": "go",
    })
    assert res.status_code == 400
    assert "itself" in res.json().get("error", "").lower()


@pytest.mark.asyncio
async def test_bridge_auto_conflict_when_already_active(client, monkeypatch):
    """Returns 409 when one of the sessions is already in an active bridge."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [{"bridge_id": "abc", "from_id": "a", "to_id": "c", "state": "active",
                   "from_name": "A", "to_name": "C", "turns_used": 0, "max_turns": 4}],
    )

    res = await client.post("/api/bridge/auto", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "kickoff_prompt": "clash",
    })
    assert res.status_code == 409
    assert "active bridge" in res.json().get("error", "").lower()


@pytest.mark.asyncio
async def test_bridge_auto_no_conflict_when_only_ended_bridges_exist(client, monkeypatch):
    """Does NOT return 409 when all existing bridges are in a terminal state."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [{"bridge_id": "old1", "from_id": "a", "to_id": "b", "state": "ended_user",
                   "from_name": "A", "to_name": "B", "turns_used": 2, "max_turns": 4}],
    )

    async def fake_start_auto(*a, **kw):
        return {"ok": True, "bridge_id": "newbridge001"}

    monkeypatch.setattr(server_module.bridge_manager, "start_auto", fake_start_auto)

    res = await client.post("/api/bridge/auto", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "kickoff_prompt": "fresh start",
    })
    # Should not be 409 — ended bridges do not block new ones
    assert res.status_code != 409
    assert res.status_code == 200


@pytest.mark.asyncio
async def test_bridge_auto_success_returns_bridge_id(client, monkeypatch):
    """Returns 200 with {ok: True, bridge_id: ...} on success."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [],
    )

    async def fake_start_auto(*a, **kw):
        return {"ok": True, "bridge_id": "abc123def456"}

    monkeypatch.setattr(server_module.bridge_manager, "start_auto", fake_start_auto)

    res = await client.post("/api/bridge/auto", json={
        "from_terminal_id": "a",
        "to_terminal_id": "b",
        "kickoff_prompt": "coordinate",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["bridge_id"] == "abc123def456"


# ---------------------------------------------------------------------------
# DELETE /api/bridge/{bridge_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bridge_stop_unknown_returns_404(client, monkeypatch):
    """Returns 404 when the bridge_id is not found."""
    monkeypatch.setattr(server_module.bridge_manager, "stop", lambda bid: False)

    res = await client.delete("/api/bridge/nosuchbridge")
    assert res.status_code == 404
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_bridge_stop_known_returns_200(client, monkeypatch):
    """Returns 200 when the bridge is successfully stopped."""
    monkeypatch.setattr(server_module.bridge_manager, "stop", lambda bid: True)

    res = await client.delete("/api/bridge/abc123def456")
    assert res.status_code == 200
    assert res.json()["ok"] is True


# ---------------------------------------------------------------------------
# GET /api/bridge
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bridge_list_returns_array(client, monkeypatch):
    """Returns {bridges: [...]} with the shape from list_active()."""
    fake_bridges = [
        {
            "bridge_id": "aaa",
            "from_id": "s1",
            "to_id": "s2",
            "from_name": "Alpha",
            "to_name": "Beta",
            "turns_used": 1,
            "max_turns": 4,
            "state": "active",
        }
    ]
    monkeypatch.setattr(server_module.bridge_manager, "list_active", lambda: fake_bridges)

    res = await client.get("/api/bridge")
    assert res.status_code == 200
    data = res.json()
    assert "bridges" in data
    assert isinstance(data["bridges"], list)
    assert len(data["bridges"]) == 1
    b = data["bridges"][0]
    for key in ("bridge_id", "from_id", "to_id", "from_name", "to_name", "turns_used", "max_turns", "state"):
        assert key in b, f"Missing key: {key}"


# ---------------------------------------------------------------------------
# POST /api/bridge/channel — validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_missing_lead_id(client):
    """Returns 400 when lead_id is absent."""
    res = await client.post("/api/bridge/channel", json={
        "worker_ids": ["sess-b"],
        "kickoff_prompt": "go",
    })
    assert res.status_code == 400
    data = res.json()
    assert data["ok"] is False


@pytest.mark.asyncio
async def test_channel_start_missing_worker_ids(client):
    """Returns 400 when worker_ids is absent."""
    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-a",
        "kickoff_prompt": "go",
    })
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_channel_start_missing_kickoff_prompt(client):
    """Returns 400 when kickoff_prompt is absent."""
    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-a",
        "worker_ids": ["sess-b"],
    })
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_channel_start_worker_ids_not_a_list(client):
    """Returns 400 when worker_ids is a string instead of a list."""
    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-a",
        "worker_ids": "sess-b",
        "kickoff_prompt": "go",
    })
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_channel_start_too_many_workers(client):
    """Returns 400 when worker_ids contains more than 7 entries."""
    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-lead",
        "worker_ids": [f"sess-{i}" for i in range(8)],
        "kickoff_prompt": "go",
    })
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_channel_start_max_turns_zero(client):
    """Returns 400 when max_turns is 0 (below minimum of 1)."""
    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-a",
        "worker_ids": ["sess-b"],
        "kickoff_prompt": "go",
        "max_turns": 0,
    })
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_channel_start_max_turns_above_max(client):
    """Returns 400 when max_turns is 21 (above maximum of 20)."""
    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-a",
        "worker_ids": ["sess-b"],
        "kickoff_prompt": "go",
        "max_turns": 21,
    })
    assert res.status_code == 400
    assert res.json()["ok"] is False


# ---------------------------------------------------------------------------
# POST /api/bridge/channel — conflict guards (409)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_lead_in_active_bridge_is_409(client, monkeypatch):
    """Returns 409 when the lead session is already enrolled in an active bridge."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [{"bridge_id": "br-1", "from_id": "sess-a", "to_id": "sess-c",
                  "state": "active", "from_name": "A", "to_name": "C",
                  "turns_used": 1, "max_turns": 4}],
    )
    monkeypatch.setattr(server_module.channel_manager, "member_ids", MagicMock(return_value=set()))

    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-a",
        "worker_ids": ["sess-b"],
        "kickoff_prompt": "go",
    })
    assert res.status_code == 409
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_channel_start_worker_in_active_channel_is_409(client, monkeypatch):
    """Returns 409 when a worker session is already enrolled in an active channel."""
    monkeypatch.setattr(
        server_module.bridge_manager,
        "list_active",
        lambda: [],
    )
    monkeypatch.setattr(
        server_module.channel_manager,
        "member_ids",
        MagicMock(return_value={"sess-b"}),
    )

    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-a",
        "worker_ids": ["sess-b"],
        "kickoff_prompt": "go",
    })
    assert res.status_code == 409
    assert res.json()["ok"] is False


# ---------------------------------------------------------------------------
# POST /api/bridge/channel — success and manager failure
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_start_success_returns_channel_id(client, monkeypatch):
    """Returns 200 with channel_id when channel_manager.start succeeds."""
    monkeypatch.setattr(server_module.bridge_manager, "list_active", lambda: [])
    monkeypatch.setattr(server_module.channel_manager, "member_ids", MagicMock(return_value=set()))
    monkeypatch.setattr(
        server_module.channel_manager,
        "start",
        AsyncMock(return_value={"ok": True, "channel_id": "abc123def456"}),
    )

    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-lead",
        "worker_ids": ["sess-w1", "sess-w2"],
        "kickoff_prompt": "coordinate on this task",
    })
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["channel_id"] == "abc123def456"


@pytest.mark.asyncio
async def test_channel_start_manager_failure_returns_400(client, monkeypatch):
    """Returns 400 when channel_manager.start returns ok: False."""
    monkeypatch.setattr(server_module.bridge_manager, "list_active", lambda: [])
    monkeypatch.setattr(server_module.channel_manager, "member_ids", MagicMock(return_value=set()))
    monkeypatch.setattr(
        server_module.channel_manager,
        "start",
        AsyncMock(return_value={"ok": False, "error": "Session dead"}),
    )

    res = await client.post("/api/bridge/channel", json={
        "lead_id": "sess-lead",
        "worker_ids": ["sess-w1"],
        "kickoff_prompt": "go",
    })
    assert res.status_code == 400
    data = res.json()
    assert data["ok"] is False
    assert "error" in data


# ---------------------------------------------------------------------------
# DELETE /api/bridge/channel/{channel_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_stop_unknown_returns_404(client, monkeypatch):
    """Returns 404 when the channel_id is not found."""
    monkeypatch.setattr(server_module.channel_manager, "stop", MagicMock(return_value=False))

    res = await client.delete("/api/bridge/channel/nosuchchannel")
    assert res.status_code == 404
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_channel_stop_known_returns_200(client, monkeypatch):
    """Returns 200 with ok: True when the channel is successfully stopped."""
    monkeypatch.setattr(server_module.channel_manager, "stop", MagicMock(return_value=True))

    res = await client.delete("/api/bridge/channel/abc123def456")
    assert res.status_code == 200
    assert res.json()["ok"] is True


# ---------------------------------------------------------------------------
# GET /api/bridge/channel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_channel_list_returns_channels_array(client, monkeypatch):
    """Returns {channels: [...]} with all entries from channel_manager.list_active()."""
    fake_channels = [
        {"channel_id": "ch-1", "lead_id": "sess-lead", "worker_ids": ["sess-w1"],
         "state": "active", "turns_used": 0, "max_turns": 6},
        {"channel_id": "ch-2", "lead_id": "sess-x", "worker_ids": ["sess-y", "sess-z"],
         "state": "ended", "turns_used": 5, "max_turns": 6},
    ]
    monkeypatch.setattr(server_module.channel_manager, "list_active", MagicMock(return_value=fake_channels))

    res = await client.get("/api/bridge/channel")
    assert res.status_code == 200
    data = res.json()
    assert "channels" in data
    assert isinstance(data["channels"], list)
    assert len(data["channels"]) == 2
    ids = {c["channel_id"] for c in data["channels"]}
    assert ids == {"ch-1", "ch-2"}


# ---------------------------------------------------------------------------
# POST /api/bridge/auto — channel membership blocks new bridges (409)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_bridge_auto_session_in_active_channel_is_409(client, monkeypatch):
    """Returns 409 when a requested session is already enrolled in an active channel.

    This tests the busy_ids |= channel_manager.member_ids() guard added to
    bridge_auto alongside the channel routes.
    """
    monkeypatch.setattr(server_module.bridge_manager, "list_active", lambda: [])
    monkeypatch.setattr(
        server_module.channel_manager,
        "member_ids",
        MagicMock(return_value={"from-id"}),
    )

    res = await client.post("/api/bridge/auto", json={
        "from_terminal_id": "from-id",
        "to_terminal_id": "to-id",
        "kickoff_prompt": "conflict test",
    })
    assert res.status_code == 409
    data = res.json()
    assert data["ok"] is False
    assert "channel" in data.get("error", "").lower()
