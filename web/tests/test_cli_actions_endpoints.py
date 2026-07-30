"""Tests for the per-session CLI-actions endpoints added to server.py:

  PATCH  /api/terminals/{id}            — rename (Cockpit-side + optional Claude sync)
  POST   /api/terminals/{id}/interrupt  — immediate ESC, no gating
  POST   /api/terminals/{id}/command    — allowlisted slash-command injection
  GET    /api/terminals/{id}/export     — Markdown transcript download

All tests use httpx AsyncClient + ASGITransport matching the existing
test_server.py / test_bridge_endpoints.py pattern. pty_manager methods and
the imported bridge_manager gate helper (_wait_for_idle_simple) are replaced
with lightweight stubs via monkeypatch to avoid PTY or filesystem access.
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
import server as server_module
from pty_manager import TerminalSession
import bridge_manager  # _SUBMIT: injection is paste-then-submit, two writes


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


def _make_pty_mock(alive=True):
    pty = MagicMock()
    pty.isalive.return_value = alive
    return pty


def _make_session(terminal_id="term-cli", name="Original Name", alive=True,
                   model="sonnet", working_dir="C:\\Code"):
    """Build a real TerminalSession with a mocked PTY (no real process)."""
    return TerminalSession(
        id=terminal_id,
        name=name,
        pty=_make_pty_mock(alive=alive),
        created_at="2026-01-01T00:00:00Z",
        model=model,
        working_dir=working_dir,
    )


def _install_sessions(monkeypatch, *sessions: TerminalSession) -> dict:
    """Replace pty_manager.sessions with a fresh dict containing *sessions*.

    monkeypatch restores the original dict automatically after the test, so
    this never leaks into other tests or the (separate-process) live server.
    """
    sessions_dict = {s.id: s for s in sessions}
    monkeypatch.setattr(server_module.pty_manager, "sessions", sessions_dict)
    return sessions_dict


def _mock_session_for_write_tests(terminal_id="term-cli", alive=True):
    """Lightweight MagicMock session — sufficient for routes that only call
    pty_manager.get_terminal / write_pty_async (interrupt, command), which
    don't touch pty_manager.sessions or _session_to_dict.
    """
    s = MagicMock()
    s.id = terminal_id
    s.alive = alive
    return s


# ---------------------------------------------------------------------------
# PATCH /api/terminals/{terminal_id} — validation
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _no_submit_delay(monkeypatch):
    """Zero the paste->submit gap; production waits 1s between the two writes."""
    monkeypatch.setattr(bridge_manager, "_SUBMIT_DELAY", 0)


@pytest.mark.asyncio
async def test_rename_missing_name_returns_400(client, monkeypatch):
    _install_sessions(monkeypatch, _make_session())
    res = await client.patch("/api/terminals/term-cli", json={})
    assert res.status_code == 400
    assert "error" in res.json()


@pytest.mark.asyncio
async def test_rename_blank_name_returns_400(client, monkeypatch):
    _install_sessions(monkeypatch, _make_session())
    res = await client.patch("/api/terminals/term-cli", json={"name": "   "})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_rename_name_too_long_returns_400(client, monkeypatch):
    _install_sessions(monkeypatch, _make_session())
    res = await client.patch("/api/terminals/term-cli", json={"name": "x" * 101})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_rename_unknown_terminal_returns_404(client, monkeypatch):
    _install_sessions(monkeypatch)  # empty sessions dict
    res = await client.patch("/api/terminals/nonexistent", json={"name": "New Name"})
    assert res.status_code == 404
    assert "error" in res.json()


# ---------------------------------------------------------------------------
# PATCH /api/terminals/{terminal_id} — rename reflects in GET /api/terminals
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rename_success_reflects_in_get_terminals(client, monkeypatch):
    """A successful rename (sync_claude omitted) updates the Cockpit record,
    and that update is visible on a subsequent GET /api/terminals — proving
    it's the same session object, not a copy.
    """
    _install_sessions(monkeypatch, _make_session(terminal_id="term-cli", name="Old Name"))

    res = await client.patch("/api/terminals/term-cli", json={"name": "  New Name  "})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["terminal"]["name"] == "New Name"  # trimmed
    assert data["claude_synced"] is False
    assert data["sync_requested"] is False

    list_res = await client.get("/api/terminals")
    assert list_res.status_code == 200
    names = {t["id"]: t["name"] for t in list_res.json()["terminals"]}
    assert names["term-cli"] == "New Name"


# ---------------------------------------------------------------------------
# PATCH /api/terminals/{terminal_id} — sync_claude behaviour
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_rename_sync_claude_success_injects_rename_command(client, monkeypatch):
    """sync_claude=True with a clean idle gate injects '/rename <name>' and
    reports claude_synced: True.
    """
    _install_sessions(monkeypatch, _make_session(terminal_id="term-cli", name="Old Name"))

    async def fake_wait_idle(terminal_id, timeout=None):
        assert terminal_id == "term-cli"
        return True

    write_calls: list[tuple[str, str]] = []

    async def fake_write(terminal_id, data):
        write_calls.append((terminal_id, data))
        return True

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle)
    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write)

    res = await client.patch("/api/terminals/term-cli", json={"name": "New Name", "sync_claude": True})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["sync_requested"] is True
    assert data["claude_synced"] is True

    # Two writes: the bracketed-paste block, then a separate bare-CR submit.
    # The CR must not ride inside the paste — the TUI eats it as pasted
    # content and the command would sit in the composer, never running.
    assert len(write_calls) == 2
    tid, payload = write_calls[0]
    assert tid == "term-cli"
    assert "/rename New Name" in payload
    assert write_calls[1] == ("term-cli", bridge_manager._SUBMIT)


@pytest.mark.asyncio
async def test_rename_sync_claude_gate_timeout_still_ok(client, monkeypatch):
    """If the typing-quiet/idle gate times out, the Cockpit rename still
    succeeds — only claude_synced flips to False. This is the fallback
    behaviour the contract calls out explicitly.
    """
    _install_sessions(monkeypatch, _make_session(terminal_id="term-cli", name="Old Name"))

    async def fake_wait_idle_timeout(terminal_id, timeout=None):
        return False  # simulates gate timeout

    write_calls: list[tuple[str, str]] = []

    async def fake_write(terminal_id, data):
        write_calls.append((terminal_id, data))
        return True

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle_timeout)
    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write)

    res = await client.patch("/api/terminals/term-cli", json={"name": "New Name", "sync_claude": True})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["terminal"]["name"] == "New Name"  # Cockpit rename still committed
    assert data["claude_synced"] is False
    # Gate never cleared, so no PTY write should have been attempted.
    assert write_calls == []

    # And the rename is still reflected in GET despite the sync failure.
    list_res = await client.get("/api/terminals")
    names = {t["id"]: t["name"] for t in list_res.json()["terminals"]}
    assert names["term-cli"] == "New Name"


@pytest.mark.asyncio
async def test_rename_sync_claude_write_failure_still_ok(client, monkeypatch):
    """If the idle gate clears but the PTY write itself fails, the Cockpit
    rename still succeeds and claude_synced is False.
    """
    _install_sessions(monkeypatch, _make_session(terminal_id="term-cli", name="Old Name"))

    async def fake_wait_idle(terminal_id, timeout=None):
        return True

    async def fake_write_fails(terminal_id, data):
        return False

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle)
    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write_fails)

    res = await client.patch("/api/terminals/term-cli", json={"name": "New Name", "sync_claude": True})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["claude_synced"] is False


@pytest.mark.asyncio
async def test_rename_sync_not_requested_defaults_false(client, monkeypatch):
    """sync_claude omitted entirely: claude_synced is False and no gate/write is attempted."""
    _install_sessions(monkeypatch, _make_session(terminal_id="term-cli", name="Old Name"))

    gate_called = False

    async def fake_wait_idle(terminal_id, timeout=None):
        nonlocal gate_called
        gate_called = True
        return True

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle)

    res = await client.patch("/api/terminals/term-cli", json={"name": "New Name"})
    assert res.status_code == 200
    data = res.json()
    assert data["claude_synced"] is False
    assert data["sync_requested"] is False
    assert gate_called is False


# ---------------------------------------------------------------------------
# POST /api/terminals/{terminal_id}/interrupt
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_interrupt_unknown_terminal_returns_404(client, monkeypatch):
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: None)
    res = await client.post("/api/terminals/nonexistent/interrupt")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_interrupt_dead_terminal_returns_404(client, monkeypatch):
    session = _mock_session_for_write_tests(alive=False)
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)
    res = await client.post("/api/terminals/term-cli/interrupt")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_interrupt_writes_esc_with_no_gating(client, monkeypatch):
    """Interrupt writes a bare ESC byte — no bracketed-paste wrap, no idle gate."""
    session = _mock_session_for_write_tests(alive=True)
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)

    gate_called = False

    async def fake_wait_idle(terminal_id, timeout=None):
        nonlocal gate_called
        gate_called = True
        return True

    write_calls: list[tuple[str, str]] = []

    async def fake_write(terminal_id, data):
        write_calls.append((terminal_id, data))
        return True

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle)
    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write)

    res = await client.post("/api/terminals/term-cli/interrupt")
    assert res.status_code == 200
    assert res.json() == {"ok": True}

    assert gate_called is False  # no idle/typing gating for interrupt
    assert len(write_calls) == 1
    tid, payload = write_calls[0]
    assert tid == "term-cli"
    assert payload == "\x1b"  # bare ESC, not bracketed-paste wrapped


@pytest.mark.asyncio
async def test_interrupt_write_failure_returns_500(client, monkeypatch):
    session = _mock_session_for_write_tests(alive=True)
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)

    async def fake_write_fails(terminal_id, data):
        return False

    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write_fails)

    res = await client.post("/api/terminals/term-cli/interrupt")
    assert res.status_code == 500


# ---------------------------------------------------------------------------
# POST /api/terminals/{terminal_id}/command — validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_command_must_start_with_slash(client):
    res = await client.post("/api/terminals/term-cli/command", json={"command": "compact"})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_command_must_be_single_line(client):
    res = await client.post("/api/terminals/term-cli/command", json={"command": "/compact\nrm -rf /"})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_command_too_long_returns_400(client):
    long_cmd = "/rename " + ("x" * 500)
    assert len(long_cmd) > 500
    res = await client.post("/api/terminals/term-cli/command", json={"command": long_cmd})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_command_not_in_allowlist_returns_400_naming_allowed_set(client):
    """A command not on the allowlist (e.g. '/help') is rejected, and the
    error names the allowed prefixes so the frontend can surface a useful
    message.
    """
    res = await client.post("/api/terminals/term-cli/command", json={"command": "/help"})
    assert res.status_code == 400
    error = res.json().get("error", "")
    for allowed in ("/compact", "/clear", "/rename", "/model", "/fast"):
        assert allowed in error


# ---------------------------------------------------------------------------
# POST /api/terminals/{terminal_id}/command — busy gate (409)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_command_busy_returns_409(client, monkeypatch):
    session = _mock_session_for_write_tests(alive=True)
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)

    async def fake_wait_idle_busy(terminal_id, timeout=None):
        return False

    write_calls: list[tuple[str, str]] = []

    async def fake_write(terminal_id, data):
        write_calls.append((terminal_id, data))
        return True

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle_busy)
    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write)

    res = await client.post("/api/terminals/term-cli/command", json={"command": "/compact"})
    assert res.status_code == 409
    data = res.json()
    assert data["ok"] is False
    assert "busy" in data["error"].lower()
    assert write_calls == []  # never reached the write path


# ---------------------------------------------------------------------------
# POST /api/terminals/{terminal_id}/command — success
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_command_success_injects_command(client, monkeypatch):
    session = _mock_session_for_write_tests(alive=True)
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)

    async def fake_wait_idle_ok(terminal_id, timeout=None):
        return True

    write_calls: list[tuple[str, str]] = []

    async def fake_write(terminal_id, data):
        write_calls.append((terminal_id, data))
        return True

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle_ok)
    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write)

    res = await client.post("/api/terminals/term-cli/command", json={"command": "/model opus"})
    assert res.status_code == 200
    assert res.json() == {"ok": True}

    # Paste write, then a separate submit CR — see the rename test above.
    assert len(write_calls) == 2
    tid, payload = write_calls[0]
    assert tid == "term-cli"
    assert "/model opus" in payload  # bracketed-paste wrap surrounds the raw command
    assert write_calls[1] == ("term-cli", bridge_manager._SUBMIT)


@pytest.mark.asyncio
async def test_command_write_failure_returns_500(client, monkeypatch):
    session = _mock_session_for_write_tests(alive=True)
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)

    async def fake_wait_idle_ok(terminal_id, timeout=None):
        return True

    async def fake_write_fails(terminal_id, data):
        return False

    monkeypatch.setattr(server_module, "_wait_for_idle_simple", fake_wait_idle_ok)
    monkeypatch.setattr(server_module.pty_manager, "write_pty_async", fake_write_fails)

    res = await client.post("/api/terminals/term-cli/command", json={"command": "/clear"})
    assert res.status_code == 500
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_command_unknown_terminal_returns_404(client, monkeypatch):
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: None)
    res = await client.post("/api/terminals/nonexistent/command", json={"command": "/clear"})
    assert res.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/terminals/{terminal_id}/export
# ---------------------------------------------------------------------------


def _write_jsonl(lines: list[dict]) -> str:
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl", delete=False, encoding="utf-8",
    ) as f:
        for line in lines:
            f.write(json.dumps(line) + "\n")
        return f.name


def _user_entry(text: str, timestamp: str) -> dict:
    return {
        "uuid": str(uuid.uuid4()),
        "type": "user",
        "timestamp": timestamp,
        "parentUuid": None,
        "message": {"role": "user", "content": text},
    }


def _assistant_entry(text: str, timestamp: str) -> dict:
    return {
        "uuid": str(uuid.uuid4()),
        "type": "assistant",
        "timestamp": timestamp,
        "parentUuid": None,
        "message": {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "model": "claude-sonnet-4-6",
            "stop_reason": "end_turn",
        },
    }


def _tool_result_entry(tool_use_id: str, text: str, timestamp: str) -> dict:
    return {
        "uuid": str(uuid.uuid4()),
        "type": "user",
        "timestamp": timestamp,
        "parentUuid": None,
        "message": {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": tool_use_id, "content": text, "is_error": False},
            ],
        },
    }


@pytest.mark.asyncio
async def test_export_unknown_terminal_returns_404(client, monkeypatch):
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: None)
    res = await client.get("/api/terminals/nonexistent/export")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_export_no_jsonl_returns_404(client, monkeypatch):
    session = _mock_session_for_write_tests(alive=True)
    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(server_module.pty_manager, "_get_jsonl_path", lambda s: None)

    res = await client.get("/api/terminals/term-cli/export")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_export_happy_path_renders_markdown(client, monkeypatch):
    """Export produces a Markdown transcript with the right headers, an H1
    session name, a metadata line, and User/Assistant sections in order.
    Tool-result noise is skipped.
    """
    jsonl_lines = [
        _user_entry("What is 2+2?", "2026-01-01T10:00:00Z"),
        _tool_result_entry("toolu_1", "irrelevant tool noise", "2026-01-01T10:00:01Z"),
        _assistant_entry("2+2 is 4.", "2026-01-01T10:00:05Z"),
    ]
    jsonl_path = _write_jsonl(jsonl_lines)

    session = MagicMock()
    session.id = "term-export"
    session.alive = True
    session.name = 'My Session #1 (test)'
    session.model = "sonnet"
    session.working_dir = "C:\\Code\\Project"

    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(server_module.pty_manager, "_get_jsonl_path", lambda s: jsonl_path)

    try:
        res = await client.get("/api/terminals/term-export/export")
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/markdown")

        disposition = res.headers.get("content-disposition", "")
        assert disposition.startswith("attachment; filename=")
        assert disposition.endswith('.md"')
        # Filename must be filesystem-safe: no spaces, #, (, ) characters.
        for unsafe in (" ", "#", "(", ")"):
            assert unsafe not in disposition.split("filename=")[1]

        body = res.text
        assert body.startswith("# My Session #1 (test)\n")
        assert "sonnet" in body
        assert "C:\\Code\\Project" in body
        assert "## User" in body
        assert "What is 2+2?" in body
        assert "## Assistant" in body
        assert "2+2 is 4." in body
        # Tool-result noise must not leak into the transcript.
        assert "irrelevant tool noise" not in body

        # User section must precede Assistant section (chronological order).
        assert body.index("## User") < body.index("## Assistant")
    finally:
        os.unlink(jsonl_path)


@pytest.mark.asyncio
async def test_export_empty_jsonl_still_returns_200_with_header_only(client, monkeypatch):
    """A JSONL file with no user/assistant text still exports — just header + metadata."""
    jsonl_lines = [
        _tool_result_entry("toolu_1", "only tool noise", "2026-01-01T10:00:00Z"),
    ]
    jsonl_path = _write_jsonl(jsonl_lines)

    session = MagicMock()
    session.id = "term-export-empty"
    session.alive = True
    session.name = "Empty Session"
    session.model = "sonnet"
    session.working_dir = "C:\\Code"

    monkeypatch.setattr(server_module.pty_manager, "get_terminal", lambda tid: session)
    monkeypatch.setattr(server_module.pty_manager, "_get_jsonl_path", lambda s: jsonl_path)

    try:
        res = await client.get("/api/terminals/term-export-empty/export")
        assert res.status_code == 200
        body = res.text
        assert body.startswith("# Empty Session\n")
        assert "## User" not in body
        assert "## Assistant" not in body
    finally:
        os.unlink(jsonl_path)
