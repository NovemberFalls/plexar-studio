"""subagent_watch: Claude Code's in-process Agent-tool subagents, read-only.

Fixture shape copied from a real Claude Code 2.1.283 session (2026-10-01):
<session>.jsonl beside <session>/subagents/agent-<id>.{meta.json,jsonl}.
"""
import json
import os
import time

import pytest

import subagent_watch as sw


def _rec(kind, stop=None, text=None):
    if kind == "assistant":
        content = [{"type": "text", "text": text}] if text else [{"type": "tool_use", "name": "Read"}]
        return {"type": "assistant", "message": {"stop_reason": stop, "content": content}}
    return {"type": kind}


@pytest.fixture
def session(tmp_path):
    jsonl = tmp_path / "abc.jsonl"
    jsonl.write_text("{}\n")
    sub = tmp_path / "abc" / "subagents"
    sub.mkdir(parents=True)

    def add(agent_id, records, meta=None, age=0):
        (sub / f"agent-{agent_id}.meta.json").write_text(json.dumps(meta or {
            "agentType": "general-purpose", "description": f"W1 N0{agent_id[-1]} task", "model": "haiku"}))
        t = sub / f"agent-{agent_id}.jsonl"
        t.write_text("\n".join(json.dumps(r) for r in records) + "\n")
        ts = time.time() - age
        os.utime(t, (ts, ts))
        os.utime(sub / f"agent-{agent_id}.meta.json", (ts - 5, ts - 5))
    return str(jsonl), add


def test_finished_running_and_tool_pending(session):
    path, add = session
    add("a1", [_rec("user"), _rec("assistant", "end_turn", "STATUS: DONE"), _rec("attachment")])
    add("a2", [_rec("user"), _rec("assistant", "tool_use")])
    add("a3", [_rec("user"), _rec("assistant", "tool_use"), _rec("user")])
    rows = {r["id"]: r for r in sw.list_subagents(path)}
    assert rows["a1"]["status"] == "done"
    assert rows["a2"]["status"] == "running"
    assert rows["a3"]["status"] == "running"
    assert rows["a1"]["model"] == "haiku" and rows["a1"]["description"] == "W1 N01 task"


def test_unfinished_and_silent_is_stopped_not_running(session):
    path, add = session
    add("b1", [_rec("assistant", "tool_use")], age=sw.STALE_AFTER_S + 60)
    assert sw.list_subagents(path)[0]["status"] == "stopped"


def test_old_finished_agents_drop_off_but_running_never_do(session):
    path, add = session
    add("c1", [_rec("assistant", "end_turn", "x")], age=sw.SHOW_FINISHED_FOR_S + 60)
    add("c2", [_rec("assistant", "tool_use")], age=5)
    assert [r["id"] for r in sw.list_subagents(path)] == ["c2"]


def test_latest_text_is_the_report(session):
    path, add = session
    add("d1", [_rec("assistant", "tool_use"), _rec("assistant", "end_turn", "STATUS: DONE\nFILES: x")])
    assert sw.latest_text(path, "d1").startswith("STATUS: DONE")
    assert sw.latest_text(path, "../../etc") is None


def test_no_dir_or_no_path_is_empty_never_raises(tmp_path):
    assert sw.list_subagents(None) == []
    assert sw.list_subagents(str(tmp_path / "nope.jsonl")) == []


def test_route_is_async_and_read_only():
    import inspect
    import server
    for fn in (server.list_subagents_route, server.subagent_report):
        assert inspect.iscoroutinefunction(fn)
    src = inspect.getsource(sw)
    for verb in ("os.remove", "unlink", ".write(", "open(path, \"w"):
        assert verb not in src


def test_huge_trailing_attachment_does_not_hide_a_finished_agent(session):
    """Measured 2026-10-01: a ~65 KB trailing attachment made a 64 KB tail start mid-line;
    the finished agent read as running and its report as missing."""
    path, add = session
    big = {"type": "attachment", "attachment": {"content": "x" * (sw.TAIL_BYTES + 5000)}}
    add("e1", [_rec("user"), _rec("assistant", "end_turn", "PROBE-OK"), big])
    assert sw.list_subagents(path)[0]["status"] == "done"
    assert sw.latest_text(path, "e1") == "PROBE-OK"
