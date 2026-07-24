"""lane-broker /traces and /trace/{id} tests.

Run: python -m pytest tools/lane-broker/tests -q
"""
import json
import os

from test_broker import FakeUpstream, get_json, http_req, start_broker

HERE = os.path.dirname(os.path.abspath(__file__))


def seed_trace_history(path: str) -> None:
    """Root -> child -> grandchild chain, plus one untraced run."""
    recs = [
        {"ts": "2026-07-23T00:00:00Z", "class": "worker", "prompt_chars": 50,
         "wall_ms": 1000, "model": "m", "client_id": "c0", "agent": "nadia",
         "trace_id": "root-1", "trace_parent": "",
         "prompt_tokens": 10, "completion_tokens": 5},
        {"ts": "2026-07-23T00:00:05Z", "class": "worker", "prompt_chars": 60,
         "wall_ms": 1200, "model": "m", "client_id": "c0", "agent": "nadia",
         "trace_id": "child-1", "trace_parent": "root-1",
         "prompt_tokens": 12, "completion_tokens": 6},
        {"ts": "2026-07-23T00:00:10Z", "class": "batch", "prompt_chars": 70,
         "wall_ms": 1300, "model": "m", "client_id": "c0", "agent": "nadia",
         "trace_id": "grandchild-1", "trace_parent": "child-1",
         "prompt_tokens": 14, "completion_tokens": 7},
        {"ts": "2026-07-23T00:00:01Z", "class": "worker", "prompt_chars": 40,
         "wall_ms": 500, "model": "m", "client_id": "c1", "agent": "",
         "trace_id": "", "trace_parent": ""},
    ]
    with open(path, "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")


def test_traces_and_trace_closure(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    seed_trace_history(log)
    up = FakeUpstream(delay=0.05)
    up.start()
    proc, port = start_broker(up.port, log)
    try:
        # /traces: only the root shows up; untraced run excluded
        traces = get_json(port, "/traces")
        assert traces["count"] == 1
        t = traces["traces"][0]
        assert t["trace_id"] == "root-1"
        assert t["agent"] == "nadia"
        assert t["runs_total"] == 1
        assert t["descendant_runs"] == 2
        assert t["first_ts"] == "2026-07-23T00:00:00Z"
        assert t["last_ts"] == "2026-07-23T00:00:00Z"
        assert t["wall_ms_total"] == 1000
        assert t["lane_classes"] == {"worker": 1}

        # /trace/{id} from a leaf must still resolve full closure
        tr = get_json(port, "/trace/grandchild-1")
        assert tr["trace_id"] == "grandchild-1"
        node_ids = [n["trace_id"] for n in tr["nodes"]]
        assert node_ids == ["root-1", "child-1", "grandchild-1"]
        assert tr["nodes"][2]["tokens"] == {"prompt": 14, "completion": 7}
        assert tr["nodes"][2]["lane_class"] == "batch"
        assert sorted(tr["edges"]) == [["child-1", "grandchild-1"], ["root-1", "child-1"]]

        # unknown trace -> 404
        status, body = http_req(port, "GET", "/trace/nope")
        assert status == 404
        assert json.loads(body) == {"error": "unknown trace"}

        # limit clamp
        status, body = http_req(port, "GET", "/traces?limit=0")
        assert json.loads(body)["count"] == 1  # clamped to >=1, only 1 root exists
        status, body = http_req(port, "GET", "/traces?limit=500")
        assert status == 200  # clamped to <=100, no error
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        up.stop()
