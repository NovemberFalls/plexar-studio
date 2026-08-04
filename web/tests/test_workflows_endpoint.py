"""Tests for GET /api/terminals/{terminal_id}/workflows.

Covers:
  1. 404 when terminal not found.
  2. Empty list when JSONL path is None / doesn't exist.
  3. Pairs tool_use "Workflow" with matching tool_result → status: "completed".
  4. Unmatched tool_use → status: "in_progress", completed_at: null.
  5. Non-Workflow tool_uses (e.g. "Bash") are filtered out.
  6. Most-recent-first ordering.

Uses httpx AsyncClient + ASGITransport matching the existing test_server.py pattern.
pty_manager.get_terminal and _get_jsonl_path are monkeypatched via pytest monkeypatch.
JSONL fixture files are written to tempfile paths for cross-platform compatibility.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import uuid
from unittest.mock import MagicMock

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from server import app
import pty_manager as pm_module


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


def _mock_terminal(terminal_id="term-wf"):
    """Return a minimal MagicMock that satisfies get_terminal checks."""
    s = MagicMock()
    s.id = terminal_id
    s.alive = True
    s.working_dir = "/tmp/wf-test"
    s.claude_session_id = "session-wf-abc"
    return s


def _write_jsonl(lines: list[dict]) -> str:
    """Write a list of dicts as JSONL to a temp file. Returns the file path."""
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix=".jsonl",
        delete=False,
        encoding="utf-8",
    ) as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")
        return f.name


def _tool_use_assistant(tool_id: str, tool_name: str, input_data: dict, timestamp: str) -> dict:
    """Build a raw JSONL entry (assistant message with one tool_use block)."""
    return {
        "uuid": str(uuid.uuid4()),
        "type": "assistant",
        "timestamp": timestamp,
        "parentUuid": None,
        "message": {
            "role": "assistant",
            "content": [
                {
                    "type": "tool_use",
                    "id": tool_id,
                    "name": tool_name,
                    "input": input_data,
                }
            ],
        },
    }


def _tool_result_user(tool_use_id: str, result_text: str, timestamp: str, is_error: bool = False) -> dict:
    """Build a raw JSONL entry (user message with one tool_result block)."""
    return {
        "uuid": str(uuid.uuid4()),
        "type": "user",
        "timestamp": timestamp,
        "parentUuid": None,
        "message": {
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": result_text,
                    "is_error": is_error,
                }
            ],
        },
    }


# ---------------------------------------------------------------------------
# Test 1 — 404 when terminal not found
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflows_404_unknown_terminal(client, monkeypatch):
    """GET /api/terminals/nonexistent/workflows returns 404."""
    monkeypatch.setattr(pm_module.pty_manager, "get_terminal", lambda _tid: None)

    res = await client.get("/api/terminals/nonexistent/workflows")
    assert res.status_code == 404
    assert "error" in res.json()


# ---------------------------------------------------------------------------
# Test 2 — empty list when JSONL path is None
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflows_empty_when_no_jsonl(client, monkeypatch):
    """GET returns {workflows: []} when _get_jsonl_path returns None."""
    session = _mock_terminal("term-wf-1")
    monkeypatch.setattr(pm_module.pty_manager, "get_terminal", lambda _tid: session)
    monkeypatch.setattr(pm_module.pty_manager, "_get_jsonl_path", lambda _s: None)

    res = await client.get("/api/terminals/term-wf-1/workflows")
    assert res.status_code == 200
    assert res.json() == {"workflows": []}


# ---------------------------------------------------------------------------
# Test 3 — matched tool_use + tool_result → completed
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflows_completed_when_result_present(client, monkeypatch):
    """A Workflow tool_use paired with a matching tool_result has status 'completed'."""
    tool_id = "toolu_wf_abc123"
    jsonl_lines = [
        _tool_use_assistant(tool_id, "Workflow", {"name": "Deploy", "description": "deploy step"}, "2026-01-01T10:00:00Z"),
        _tool_result_user(tool_id, "Done", "2026-01-01T10:00:05Z"),
    ]
    jsonl_path = _write_jsonl(jsonl_lines)

    session = _mock_terminal("term-wf-2")
    monkeypatch.setattr(pm_module.pty_manager, "get_terminal", lambda _tid: session)
    monkeypatch.setattr(pm_module.pty_manager, "_get_jsonl_path", lambda _s: jsonl_path)

    try:
        res = await client.get("/api/terminals/term-wf-2/workflows")
        assert res.status_code == 200
        data = res.json()
        assert len(data["workflows"]) == 1
        wf = data["workflows"][0]
        assert wf["status"] == "completed"
        assert wf["name"] == "Deploy"
        assert wf["completed_at"] == "2026-01-01T10:00:05Z"
        assert wf["is_error"] is False
    finally:
        os.unlink(jsonl_path)


# ---------------------------------------------------------------------------
# Test 4 — unmatched tool_use → in_progress
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflows_in_progress_when_no_result(client, monkeypatch):
    """A Workflow tool_use with no matching tool_result has status 'in_progress'."""
    tool_id = "toolu_wf_inprog"
    jsonl_lines = [
        _tool_use_assistant(tool_id, "Workflow", {"name": "Build"}, "2026-01-01T11:00:00Z"),
        # No tool_result entry
    ]
    jsonl_path = _write_jsonl(jsonl_lines)

    session = _mock_terminal("term-wf-3")
    monkeypatch.setattr(pm_module.pty_manager, "get_terminal", lambda _tid: session)
    monkeypatch.setattr(pm_module.pty_manager, "_get_jsonl_path", lambda _s: jsonl_path)

    try:
        res = await client.get("/api/terminals/term-wf-3/workflows")
        assert res.status_code == 200
        data = res.json()
        assert len(data["workflows"]) == 1
        wf = data["workflows"][0]
        assert wf["status"] == "in_progress"
        assert wf["completed_at"] is None
        assert wf["name"] == "Build"
    finally:
        os.unlink(jsonl_path)


# ---------------------------------------------------------------------------
# Test 5 — non-Workflow tool_uses are filtered out
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflows_filters_non_workflow_tool_uses(client, monkeypatch):
    """A Bash tool_use does NOT appear in the workflows response."""
    bash_id = "toolu_bash_001"
    wf_id = "toolu_wf_001"
    jsonl_lines = [
        _tool_use_assistant(bash_id, "Bash", {"command": "ls"}, "2026-01-01T12:00:00Z"),
        _tool_use_assistant(wf_id, "Workflow", {"name": "Test"}, "2026-01-01T12:01:00Z"),
    ]
    jsonl_path = _write_jsonl(jsonl_lines)

    session = _mock_terminal("term-wf-4")
    monkeypatch.setattr(pm_module.pty_manager, "get_terminal", lambda _tid: session)
    monkeypatch.setattr(pm_module.pty_manager, "_get_jsonl_path", lambda _s: jsonl_path)

    try:
        res = await client.get("/api/terminals/term-wf-4/workflows")
        assert res.status_code == 200
        data = res.json()
        # Only the Workflow tool_use should appear
        assert len(data["workflows"]) == 1
        assert data["workflows"][0]["name"] == "Test"
    finally:
        os.unlink(jsonl_path)


# ---------------------------------------------------------------------------
# Test 6 — most-recent-first ordering
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_workflows_most_recent_first(client, monkeypatch):
    """Workflows are returned most-recent-first based on started_at timestamp."""
    id_older = "toolu_wf_older"
    id_newer = "toolu_wf_newer"
    jsonl_lines = [
        _tool_use_assistant(id_older, "Workflow", {"name": "First"}, "2026-01-01T09:00:00Z"),
        _tool_use_assistant(id_newer, "Workflow", {"name": "Second"}, "2026-01-01T10:00:00Z"),
    ]
    jsonl_path = _write_jsonl(jsonl_lines)

    session = _mock_terminal("term-wf-5")
    monkeypatch.setattr(pm_module.pty_manager, "get_terminal", lambda _tid: session)
    monkeypatch.setattr(pm_module.pty_manager, "_get_jsonl_path", lambda _s: jsonl_path)

    try:
        res = await client.get("/api/terminals/term-wf-5/workflows")
        assert res.status_code == 200
        data = res.json()
        assert len(data["workflows"]) == 2
        # Most recent (Second / 10:00) must come first
        assert data["workflows"][0]["name"] == "Second"
        assert data["workflows"][1]["name"] == "First"
    finally:
        os.unlink(jsonl_path)
