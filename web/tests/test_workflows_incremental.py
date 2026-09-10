"""Workflow calls are read INCREMENTALLY, and the answer is identical to a full re-parse (R-193).

`/api/terminals/{id}/workflows` is polled every 3 s for every open pane. It used to
read and JSON-parse the WHOLE transcript on every poll — ~19% of all py-spy samples
in the owner's six-session sidecar (2026-09-10), in worker threads that starved the
event loop. `jsonl_watcher.workflow_calls` scans a transcript once, then parses only
the bytes appended since.

The old algorithm is kept below VERBATIM as `_reference`, and every arm compares
against it — equivalence is the claim, so equivalence is what is tested.
"""

import json
import uuid

import jsonl_watcher
from jsonl_watcher import read_all_messages, workflow_calls


def _use(tool_id, name, ts, tool_name="Workflow"):
    return {
        "uuid": str(uuid.uuid4()), "type": "assistant", "timestamp": ts, "parentUuid": None,
        "message": {"role": "assistant", "content": [{
            "type": "tool_use", "id": tool_id, "name": tool_name,
            "input": {"name": name, "description": f"about {name}", "args": {"n": 1},
                      "script": "x" * 300, "scriptPath": f"/tmp/{name}.js"},
        }]},
    }


def _result(tool_use_id, ts, is_error=False):
    return {
        "uuid": str(uuid.uuid4()), "type": "user", "timestamp": ts, "parentUuid": None,
        "message": {"role": "user", "content": [{
            "type": "tool_result", "tool_use_id": tool_use_id, "content": "ok", "is_error": is_error,
        }]},
    }


def _text(i, ts):
    return {"uuid": str(uuid.uuid4()), "type": "user", "timestamp": ts, "parentUuid": None,
            "message": {"role": "user", "content": f"hello {i}"}}


def _reference(path):
    """The pre-R-193 route body, verbatim apart from the sort/cap the route still does."""
    messages = read_all_messages(path)
    tool_results = {}
    for m in messages:
        if m.get("type") == "tool_result":
            for block in m.get("content", []):
                tuid = block.get("tool_use_id")
                if tuid:
                    tool_results[tuid] = {
                        "completed_at": m.get("timestamp"),
                        "is_error": block.get("is_error", False),
                    }
    workflows = []
    for m in messages:
        if m.get("type") != "assistant":
            continue
        for block in m.get("content", []):
            if block.get("type") != "tool_use":
                continue
            if block.get("tool_name") != "Workflow":
                continue
            tool_id = block.get("tool_id", "")
            inp = block.get("input", {}) or {}
            result = tool_results.get(tool_id)
            workflows.append({
                "tool_id": tool_id,
                "name": inp.get("name") or inp.get("title") or "workflow",
                "description": inp.get("description") or "",
                "args": inp.get("args"),
                "script_preview": (inp.get("script") if isinstance(inp.get("script"), str) else None),
                "script_path": inp.get("scriptPath"),
                "started_at": m.get("timestamp"),
                "completed_at": result["completed_at"] if result else None,
                "is_error": result["is_error"] if result else False,
                "status": "completed" if result else "in_progress",
            })
    return workflows


def _append(path, entries, *, final_newline=True):
    with open(path, "a", encoding="utf-8", newline="") as f:
        body = "\n".join(json.dumps(e) for e in entries)
        f.write(body + ("\n" if final_newline else ""))


def test_matches_the_full_parse_across_appends(tmp_path):
    path = str(tmp_path / "t.jsonl")
    _append(path, [_text(0, "t0"), _use("w1", "alpha", "t1"), _text(1, "t2"),
                   _use("other", "grep", "t3", tool_name="Bash"), _use("w2", "beta", "t4"),
                   _result("w1", "t5")])
    assert workflow_calls(path) == _reference(path)

    _append(path, [_result("w2", "t6", is_error=True), _use("w3", "gamma", "t7"), _text(2, "t8")])
    assert workflow_calls(path) == _reference(path)


def test_a_final_line_without_a_newline_is_counted_but_not_committed(tmp_path):
    """The full read counted an unterminated last line, so the incremental one must."""
    path = str(tmp_path / "t.jsonl")
    _append(path, [_use("w1", "alpha", "t1")])
    _append(path, [_use("w2", "beta", "t2")], final_newline=False)
    assert workflow_calls(path) == _reference(path)
    assert [w["tool_id"] for w in workflow_calls(path)] == ["w1", "w2"]

    # Complete that line and add a result for it: counted once, not twice.
    with open(path, "a", encoding="utf-8", newline="") as f:
        f.write("\n")
    _append(path, [_result("w2", "t3")])
    got = workflow_calls(path)
    assert got == _reference(path)
    assert [w["tool_id"] for w in got] == ["w1", "w2"]


def test_an_unchanged_file_costs_no_parsing_and_an_append_costs_only_its_lines(tmp_path, monkeypatch):
    """The guard against regressing to a full re-read: count the parses."""
    path = str(tmp_path / "t.jsonl")
    _append(path, [_text(i, f"t{i}") for i in range(50)] + [_use("w1", "alpha", "t50")])
    workflow_calls(path)                         # the one full scan

    parsed = []
    real = jsonl_watcher.parse_jsonl_entry
    monkeypatch.setattr(jsonl_watcher, "parse_jsonl_entry",
                        lambda line: parsed.append(1) or real(line))
    workflow_calls(path)
    assert parsed == [], "an unchanged transcript was parsed again"

    _append(path, [_result("w1", "t51"), _text(99, "t52")])
    got = workflow_calls(path)
    assert len(parsed) == 2, f"expected only the 2 appended lines to be parsed, got {len(parsed)}"
    assert got[0]["status"] == "completed"


def test_a_truncated_or_replaced_file_is_rescanned(tmp_path):
    path = str(tmp_path / "t.jsonl")
    _append(path, [_use("w1", "alpha", "t1"), _use("w2", "beta", "t2"), _result("w1", "t3")])
    workflow_calls(path)

    with open(path, "w", encoding="utf-8", newline="") as f:   # shorter rewrite
        f.write(json.dumps(_use("w9", "omega", "t9")) + "\n")
    got = workflow_calls(path)
    assert got == _reference(path)
    assert [w["tool_id"] for w in got] == ["w9"]


def test_a_missing_file_is_an_empty_list(tmp_path):
    assert workflow_calls(str(tmp_path / "nope.jsonl")) == []
