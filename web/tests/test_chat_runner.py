"""The Chat reply path — running the `claude` CLI headlessly.

Two classes of rule here, and both were learned rather than assumed.

SECURITY. `claude` runs its tools on THIS machine; the model being
containerised elsewhere is irrelevant to that. So the allow-list is enforced
server-side and defaults to read-only.

CLI SHAPE. ``--allowedTools`` is variadic and swallows a trailing positional
prompt, which is why the prompt goes on stdin and argv stays flag-only.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import chat_runner as cr  # noqa: E402


@pytest.fixture(autouse=True)
def fake_cli(monkeypatch):
    monkeypatch.setattr(cr, "resolve_cli", lambda: "/usr/bin/claude")


# ---------------------------------------------------------------------------
# The allow-list IS the security boundary
# ---------------------------------------------------------------------------

def test_a_chat_is_read_only_by_default():
    """The default must not be able to change the machine.

    These tools run locally with the user's own privileges, so anything that
    writes or executes has to be asked for.
    """
    argv = cr.build_argv()
    tools = argv[argv.index("--allowedTools") + 1:]
    assert set(tools) == set(cr.READ_ONLY_TOOLS)
    for dangerous in ("Bash", "Write", "Edit", "WebFetch"):
        assert dangerous not in tools


@pytest.mark.parametrize("flag,expected", [
    ("allow_write", "Write"), ("allow_exec", "Bash"), ("allow_net", "WebFetch"),
])
def test_each_capability_is_opt_in_separately(flag, expected):
    argv = cr.build_argv(**{flag: True})
    tools = argv[argv.index("--allowedTools") + 1:]
    assert expected in tools
    # Opting into one must not quietly grant the others.
    others = {"Write": ("Bash", "WebFetch"), "Bash": ("Write", "WebFetch"),
              "WebFetch": ("Write", "Bash")}[expected]
    for o in others:
        assert o not in tools


def test_allowed_tools_is_last_because_it_is_variadic():
    """THE trap: a positional prompt after --allowedTools is consumed as a
    tool name, and the CLI then fails complaining it received no input.

    Keeping the flag last, with the prompt on stdin, makes that impossible.
    """
    argv = cr.build_argv(model="claude-opus-5", session_id="s1")
    idx = argv.index("--allowedTools")
    # Everything after it is a tool name; no flags may follow.
    assert all(not a.startswith("--") for a in argv[idx + 1:])


def test_the_prompt_never_appears_in_argv():
    argv = cr.build_argv()
    assert not any("prompt" in a.lower() for a in argv)


# ---------------------------------------------------------------------------
# Resume, scope, model
# ---------------------------------------------------------------------------

def test_a_known_session_is_resumed_rather_than_re_sent():
    """Re-sending the transcript each turn costs the whole history as input
    tokens — the exact cost the model-switch warning describes."""
    argv = cr.build_argv(session_id="sess-123")
    assert "--resume" in argv
    assert argv[argv.index("--resume") + 1] == "sess-123"


def test_a_first_turn_has_no_resume_flag():
    assert "--resume" not in cr.build_argv()


def test_a_scoped_conversation_limits_filesystem_reach():
    argv = cr.build_argv(cwd_scope="C:/repo")
    assert argv[argv.index("--add-dir") + 1] == "C:/repo"


def test_streaming_flags_are_requested():
    argv = cr.build_argv()
    assert argv[argv.index("--output-format") + 1] == "stream-json"
    assert "--include-partial-messages" in argv


def test_a_missing_cli_is_a_clear_refusal(monkeypatch):
    monkeypatch.setattr(cr, "resolve_cli", lambda: None)
    with pytest.raises(cr.ChatRunnerError, match="not found"):
        cr.build_argv()


# ---------------------------------------------------------------------------
# Event extraction — never invent transcript text
# ---------------------------------------------------------------------------

def test_text_deltas_are_extracted():
    ev = {"type": "stream_event",
          "event": {"delta": {"type": "text_delta", "text": "hel"}}}
    assert cr._extract_text(ev) == "hel"


def test_a_complete_assistant_message_is_extracted():
    ev = {"type": "assistant", "message": {"content": [
        {"type": "text", "text": "answer"},
        {"type": "tool_use", "name": "Read"},
    ]}}
    assert cr._extract_text(ev) == "answer", "only text blocks become transcript"


def test_an_unrecognised_event_contributes_nothing():
    """Garbage in a chat is worse than a gap: the user cannot tell it came
    from us rather than from the model."""
    for ev in (None, "nope", {}, {"type": "system"}, {"type": "stream_event"},
               {"type": "stream_event", "event": {"delta": {"type": "thinking"}}}):
        assert cr._extract_text(ev) == ""


# ---------------------------------------------------------------------------
# The streamed turn
# ---------------------------------------------------------------------------

class _FakeStdin:
    def write(self, _b):
        pass

    async def drain(self):
        pass

    def close(self):
        pass


class _FakeStdout:
    def __init__(self, lines):
        self._lines = lines

    async def readline(self):
        return self._lines.pop(0) if self._lines else b""


class _FakeReader:
    def __init__(self, data):
        self._data = data

    async def read(self):
        return self._data


class _FakeProc:
    def __init__(self, lines, rc=0, stderr=b""):
        self._lines = list(lines)
        self.returncode = rc
        self.stdin = _FakeStdin()
        self.stdout = _FakeStdout(self._lines)
        self.stderr = _FakeReader(stderr)
        self.killed = False

    def kill(self):
        self.killed = True

    async def wait(self):
        return self.returncode


def _lines(*objs):
    return [json.dumps(o).encode() + b"\n" for o in objs]


async def _collect(monkeypatch, proc, **kw):
    async def fake_exec(*a, **k):
        return proc
    monkeypatch.setattr(cr.asyncio, "create_subprocess_exec", fake_exec)
    return [e async for e in cr.stream_reply("hi", **kw)]


@pytest.mark.asyncio
async def test_a_turn_streams_deltas_then_reports_done(monkeypatch):
    proc = _FakeProc(_lines(
        {"type": "stream_event", "session_id": "s9",
         "event": {"delta": {"type": "text_delta", "text": "Hel"}}},
        {"type": "stream_event", "event": {"delta": {"type": "text_delta", "text": "lo"}}},
        {"type": "result", "session_id": "s9", "total_cost_usd": 0.01,
         "is_error": False, "result": "Hello"},
    ))
    events = await _collect(monkeypatch, proc)

    assert [e["text"] for e in events if e["type"] == "delta"] == ["Hel", "lo"]
    done = [e for e in events if e["type"] == "done"][0]
    assert done["text"] == "Hello"
    assert done["session_id"] == "s9", "so the next turn can resume"
    assert done["cost_usd"] == 0.01


@pytest.mark.asyncio
async def test_a_failed_turn_reports_error_and_never_a_done(monkeypatch):
    """A non-zero exit must not be persisted as an empty assistant turn."""
    proc = _FakeProc([], rc=1, stderr=b"boom")
    events = await _collect(monkeypatch, proc)

    assert [e["type"] for e in events] == ["error"]
    assert "boom" in events[0]["detail"]


@pytest.mark.asyncio
async def test_non_json_diagnostic_lines_are_skipped_not_shown(monkeypatch):
    proc = _FakeProc(
        [b"warning: something\n"] + _lines(
            {"type": "result", "result": "ok", "session_id": "s1"}),
    )
    events = await _collect(monkeypatch, proc)
    assert not any("warning" in str(e.get("text", "")) for e in events)
    assert [e for e in events if e["type"] == "done"][0]["text"] == "ok"


@pytest.mark.asyncio
async def test_a_hung_harness_is_killed_and_reported(monkeypatch):
    class _Hang(_FakeStdout):
        async def readline(self):
            import asyncio as a
            await a.sleep(9)

    proc = _FakeProc([])
    proc.stdout = _Hang([])

    events = await _collect(monkeypatch, proc, timeout_s=0.01)
    assert events[-1]["type"] == "error"
    assert proc.killed, "a hung harness must not be left running"


# ---------------------------------------------------------------------------
# Tool calls (CHAT.md §6) — a quiet log, not a transcript of arguments
# ---------------------------------------------------------------------------

def test_a_tool_call_yields_its_verb_and_targets():
    ev = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t1", "name": "Read",
         "input": {"file_path": "queue.py"}},
    ]}}
    assert cr._extract_tools(ev) == [
        {"id": "t1", "verb": "Read", "targets": ["queue.py"]}
    ]


def test_tool_arguments_beyond_the_target_stay_out_of_the_transcript():
    """A tool input can carry file contents or a whole prompt. The strip is
    meant to be scannable, and dumping the blob leaks into a surface that
    should only say what was touched."""
    ev = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t1", "name": "Write", "input": {
            "file_path": "a.py", "content": "SECRET PAYLOAD", "extra": "noise",
        }},
    ]}}
    call = cr._extract_tools(ev)[0]
    assert call["targets"] == ["a.py"]
    assert "SECRET PAYLOAD" not in str(call)


def test_an_unnamed_tool_call_is_recorded_not_dropped():
    """It still happened; "unknown" beats a silent gap."""
    ev = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": "t1", "input": {}},
    ]}}
    assert cr._extract_tools(ev)[0]["verb"] == "unknown"


def test_text_blocks_are_not_mistaken_for_tool_calls():
    ev = {"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}
    assert cr._extract_tools(ev) == []


def test_malformed_events_yield_no_tool_calls():
    for ev in (None, "nope", {}, {"type": "assistant"},
               {"type": "assistant", "message": {"content": "no"}}):
        assert cr._extract_tools(ev) == []
        assert cr._extract_tool_results(ev) == []


def test_a_tool_result_reports_only_its_outcome():
    """A result can be an entire file; only success/failure belongs here."""
    ev = {"type": "user", "message": {"content": [
        {"type": "tool_result", "tool_use_id": "t1", "is_error": True,
         "content": "a whole file's worth of text"},
    ]}}
    assert cr._extract_tool_results(ev) == [{"id": "t1", "is_error": True}]


@pytest.mark.asyncio
async def test_tool_calls_are_streamed_alongside_text(monkeypatch):
    proc = _FakeProc(_lines(
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "id": "t1", "name": "Grep",
             "input": {"pattern": "_inflight"}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "is_error": False}]}},
        {"type": "stream_event",
         "event": {"delta": {"type": "text_delta", "text": "Found it"}}},
        {"type": "result", "result": "Found it", "session_id": "s1"},
    ))
    events = await _collect(monkeypatch, proc)
    kinds = [e["type"] for e in events]

    assert "tool" in kinds and "tool_result" in kinds
    tool = [e for e in events if e["type"] == "tool"][0]
    assert tool["verb"] == "Grep" and tool["targets"] == ["_inflight"]
