"""lane-broker tests: fake slow upstream + real broker subprocess.

Run: python -m pytest tools/lane-broker/tests -q
"""
import http.client
import json
import os
import socket
import socketserver
import subprocess
import sys
import threading
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
BROKER = os.path.join(HERE, "..", "broker.py")

SSE_TOOL_USE_BODY = (
    b"data: {\"type\":\"content_block_start\",\"content_block\":{\"type\":\"tool_use\","
    b"\"id\":\"toolu_01\",\"name\":\"get_weather\",\"input\":{}}}\n\n"
    b"data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\","
    b"\"partial_json\":\"{\\\"city\\\": \\\"Pori\\\", \\\"unit\\\": \\\"c\\\"}\"}}\n\n"
    b"data: [DONE]\n\n"
)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeUpstream(threading.Thread):
    """Slow echo server. Records arrival order and max concurrency.
    Responds with a chunked SSE body (tool_use JSON) after `delay` seconds."""

    def __init__(self, delay: float = 0.0, mode: str = "sse"):
        super().__init__(daemon=True)
        self.port = free_port()
        self.delay = delay
        self.mode = mode
        self.order: list[str] = []
        self.active = 0
        self.max_active = 0
        self.lock = threading.Lock()
        outer = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self):
                head = b""
                while b"\r\n\r\n" not in head:
                    b_ = self.rfile.read(1)
                    if not b_:
                        return
                    head += b_
                headers = {}
                for line in head.split(b"\r\n")[1:]:
                    if b":" in line:
                        k, _, v = line.partition(b":")
                        headers[k.decode().strip().lower()] = v.decode().strip()
                body = self.rfile.read(int(headers.get("content-length", "0") or "0"))
                with outer.lock:
                    outer.active += 1
                    outer.max_active = max(outer.max_active, outer.active)
                    outer.order.append(headers.get("x-lane-class", "?") + ":" +
                                       headers.get("x-req-id", "?"))
                try:
                    time.sleep(outer.delay)
                    if outer.mode == "json":
                        payload = json.dumps({
                            "choices": [{"message": {"content": "ok"}}],
                            "usage": {"prompt_tokens": 10, "completion_tokens": 20},
                        }).encode()
                        self.wfile.write(
                            b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n"
                            + f"content-length: {len(payload)}\r\n".encode()
                            + b"connection: close\r\n\r\n" + payload)
                        return
                    chunks = b""
                    for piece in (SSE_TOOL_USE_BODY[:60], SSE_TOOL_USE_BODY[60:]):
                        chunks += f"{len(piece):x}\r\n".encode() + piece + b"\r\n"
                    chunks += b"0\r\n\r\n"
                    self.wfile.write(
                        b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n"
                        b"transfer-encoding: chunked\r\nconnection: close\r\n\r\n" + chunks)
                finally:
                    with outer.lock:
                        outer.active -= 1

        class Srv(socketserver.ThreadingTCPServer):
            allow_reuse_address = True

        self.server = Srv(("127.0.0.1", self.port), Handler)

    def run(self):
        self.server.serve_forever()

    def stop(self):
        self.server.shutdown()


def wait_port(port: int, timeout: float = 10.0) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with socket.create_connection(("127.0.0.1", port), 0.2):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError(f"port {port} never opened")


def start_broker(upstream_port: int, log_file: str, extra: list[str] | None = None):
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, BROKER, "--port", str(port),
         "--upstream", f"http://127.0.0.1:{upstream_port}",
         "--log-file", log_file] + (extra or []),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    wait_port(port)
    return proc, port


def post_chat(port: int, lane_class: str | None = None, req_id: str = "r",
              content: str = "hi", timeout: float = 30.0):
    """Returns (status, body_bytes)."""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    body = json.dumps({"model": "m", "messages": [{"role": "user", "content": content}]})
    headers = {"content-type": "application/json", "x-req-id": req_id}
    if lane_class:
        headers["X-Lane-Class"] = lane_class
    conn.request("POST", "/v1/chat/completions", body=body, headers=headers)
    r = conn.getresponse()
    data = r.read()
    conn.close()
    return r.status, data


def get_queue(port: int) -> dict:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", "/queue")
    r = conn.getresponse()
    data = json.loads(r.read())
    conn.close()
    return data


def seed_history(path: str, walls_ms: list[int], prompt_chars: int = 100):
    with open(path, "w", encoding="utf-8") as f:
        for w in walls_ms:
            f.write(json.dumps({"ts": "2026-07-23T00:00:00Z", "class": "worker",
                                "prompt_chars": prompt_chars, "wall_ms": w,
                                "model": "m", "client_id": "seed"}) + "\n")


@pytest.fixture
def env(tmp_path, request):
    delay = getattr(request, "param", {}).get("delay", 0.8)
    seed = getattr(request, "param", {}).get("seed")
    log = str(tmp_path / "jobs.jsonl")
    if seed:
        seed_history(log, seed)
    up = FakeUpstream(delay=delay)
    up.start()
    proc, port = start_broker(up.port, log)
    yield up, port, log
    proc.terminate()
    proc.wait(timeout=5)
    up.stop()


# ---------------------------------------------------------------- tests

@pytest.mark.parametrize("env", [{"delay": 0.6}], indirect=True)
def test_single_flight_and_fifo(env):
    up, port, _ = env
    threads = []
    for i in range(3):
        t = threading.Thread(target=post_chat, args=(port, "worker", f"j{i}"))
        t.start()
        threads.append(t)
        time.sleep(0.15)  # deterministic arrival order
    for t in threads:
        t.join()
    assert up.max_active == 1, "upstream must never see concurrent requests"
    assert [o.split(":")[1] for o in up.order] == ["j0", "j1", "j2"]


@pytest.mark.parametrize("env", [{"delay": 0.8, "seed": [1000] * 5}], indirect=True)
def test_priority_preemption_in_queue(env):
    up, port, _ = env
    threads = []
    for cls, rid in [("batch", "b1"), ("batch", "b2"), ("worker", "w1"), ("interactive", "i1")]:
        t = threading.Thread(target=post_chat, args=(port, cls, rid))
        t.start()
        threads.append(t)
        time.sleep(0.15)
    for t in threads:
        t.join()
    # b1 was in-flight (never cancelled); queue reorders: interactive > worker > batch
    assert up.order[0].endswith("b1")
    assert [o.split(":")[1] for o in up.order[1:]] == ["i1", "w1", "b2"]


@pytest.mark.parametrize("env", [{"delay": 1.0, "seed": [2000, 4000, 6000]}], indirect=True)
def test_eta_from_seeded_history_and_queue_endpoint(env):
    up, port, _ = env
    threads = []
    for rid in ["a", "b", "c", "d"]:
        t = threading.Thread(target=post_chat, args=(port, "worker", rid))
        t.start()
        threads.append(t)
        time.sleep(0.1)
    time.sleep(0.2)
    q = get_queue(port)
    assert q["in_flight"] is not None and q["in_flight"]["class"] == "worker"
    assert len(q["queued"]) == 3
    assert [j["position"] for j in q["queued"]] == [0, 1, 2]
    # median of seeded walls = 4s per queued job
    for j in q["queued"]:
        assert j["predicted_wall_s"] == pytest.approx(4.0, abs=0.01)
    expected_clear = q["in_flight"]["predicted_remaining_s"] + 3 * 4.0
    assert q["estimated_clear_seconds"] == pytest.approx(expected_clear, abs=0.2)
    for t in threads:
        t.join()


@pytest.mark.parametrize("env", [{"delay": 2.0, "seed": [40_000] * 5}], indirect=True)
def test_spill_trigger(env):
    up, port, _ = env
    # occupy the single slot (predicted 40s wall from seed)
    t = threading.Thread(target=post_chat, args=(port, "worker", "long"))
    t.start()
    time.sleep(0.4)
    status, body = post_chat(port, "interactive", "spillme", timeout=5)
    assert status == 503
    payload = json.loads(body)
    assert payload["spill"] is True
    assert payload["hint"] == "escalate-to-api"
    assert payload["predicted_wait_s"] > 30
    # batch has no threshold: must NOT spill (it queues; don't wait for it)
    q_status_holder = {}

    def batch_call():
        q_status_holder["s"] = post_chat(port, "batch", "b")[0]

    tb = threading.Thread(target=batch_call)
    tb.start()
    t.join()
    tb.join()
    assert q_status_holder["s"] == 200


@pytest.mark.parametrize("env", [{"delay": 0.1}], indirect=True)
def test_verbatim_sse_passthrough(env):
    up, port, _ = env
    # raw socket so we see the exact bytes after headers
    body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "x"}],
                       "stream": True}).encode()
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\n"
                  b"content-type: application/json\r\n"
                  + f"content-length: {len(body)}\r\n\r\n".encode() + body)
        raw = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                break
            raw += chunk
    head, _, payload = raw.partition(b"\r\n\r\n")
    assert b"200" in head.split(b"\r\n")[0]
    assert b"transfer-encoding: chunked" in head.lower()
    # de-chunk and compare byte-for-byte
    out, rest = b"", payload
    while rest:
        size_line, _, rest = rest.partition(b"\r\n")
        size = int(size_line.split(b";")[0], 16)
        if size == 0:
            break
        out += rest[:size]
        rest = rest[size + 2:]
    assert out == SSE_TOOL_USE_BODY, "SSE body must survive byte-for-byte (tool_use JSON intact)"


@pytest.mark.parametrize("env", [{"delay": 1.0}], indirect=True)
def test_queue_html_page(env):
    up, port, _ = env
    t = threading.Thread(target=post_chat, args=(port, "worker", "h"))
    t.start()
    time.sleep(0.3)
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", "/queue?html=1")
    r = conn.getresponse()
    page = r.read().decode()
    conn.close()
    assert r.status == 200 and "lane-broker" in page and "IN-FLIGHT" in page
    t.join()


def test_shadow_mode_no_queueing(tmp_path):
    up = FakeUpstream(delay=0.5)
    up.start()
    log = str(tmp_path / "jobs.jsonl")
    proc, port = start_broker(up.port, log, extra=["--shadow"])
    try:
        threads = [threading.Thread(target=post_chat, args=(port, "worker", f"s{i}"))
                   for i in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert up.max_active >= 2, "shadow mode must not serialize requests"
        # log records land just after the final relayed byte — poll briefly
        deadline = time.time() + 3
        recs = []
        while time.time() < deadline and len(recs) < 3:
            if os.path.exists(log):
                with open(log, encoding="utf-8") as f:
                    recs = [json.loads(x) for x in f]
            time.sleep(0.05)
        assert len(recs) == 3 and all(r.get("shadow") for r in recs)
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        up.stop()


def get_json(port: int, path: str) -> dict:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", path)
    r = conn.getresponse()
    data = json.loads(r.read())
    conn.close()
    return data


def test_metrics_usage_sniff_and_session_window(tmp_path):
    up = FakeUpstream(delay=0.05, mode="json")
    up.start()
    log = str(tmp_path / "jobs.jsonl")
    proc, port = start_broker(up.port, log)
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        for i in range(2):
            body = json.dumps({"model": "m", "messages": [{"role": "user", "content": "x"}]})
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
            conn.request("POST", "/v1/chat/completions", body=body,
                         headers={"content-type": "application/json",
                                  "X-Lane-Class": "worker", "X-Trace-Id": "t-shared",
                                  "X-Agent-Id": "nadia"})
            conn.getresponse().read()
            conn.close()
        m = get_json(port, "/metrics?window=session")
        assert m["window"] == "session" and m["persisted"] is False
        assert m["runs_total"] == 2
        assert m["prompts_total"] == 1, "same X-Trace-Id => one prompt, two runs"
        assert m["tokens_total"] == {"prompt": 20, "completion": 40}
        assert m["tokens_per_sec"]["avg"] > 0
        assert m["by_agent"][0]["key"] == "nadia"
        assert m["by_lane_class"][0]["key"] == "worker"
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        up.stop()


def test_metrics_lifetime_from_seeded_history(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    with open(log, "w", encoding="utf-8") as f:
        for i, wall in enumerate([1000, 2000, 3000, 4000]):
            f.write(json.dumps({
                "ts": "2026-07-23T00:00:00Z", "class": "batch", "prompt_chars": 50,
                "wall_ms": wall, "model": "m", "client_id": f"c{i % 2}",
                "trace_id": f"t{i}", "prompt_tokens": 100, "completion_tokens": 50,
            }) + "\n")
    up = FakeUpstream(delay=0.05)
    up.start()
    proc, port = start_broker(up.port, log)
    try:
        m = get_json(port, "/metrics")  # default = lifetime
        assert m["window"] == "lifetime" and m["persisted"] is True
        assert m["runs_total"] == 4 and m["prompts_total"] == 4
        assert m["tokens_total"] == {"prompt": 400, "completion": 200}
        assert m["run_time_ms"]["min"] == 1000 and m["run_time_ms"]["max"] == 4000
        assert m["run_time_ms"]["avg"] == 2500 and m["run_time_ms"]["p50"] == 3000
        assert len(m["by_session"]) == 2
        # session window: broker just started, nothing new
        s = get_json(port, "/metrics?window=session")
        assert s["runs_total"] == 0 and s["persisted"] is False
        # html variant renders
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request("GET", "/metrics?html=1")
        r = conn.getresponse()
        page = r.read().decode()
        conn.close()
        assert r.status == 200 and "lane-broker metrics" in page
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        up.stop()


def test_extract_usage_shapes():
    sys.path.insert(0, os.path.join(HERE, ".."))
    import broker
    # Anthropic SSE: input_tokens in message_start, output_tokens in message_delta
    sse = (b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n"
           b'data: {"type":"message_start","message":{"usage":{"input_tokens":7}}}\n\n'
           b'data: {"type":"message_delta","usage":{"output_tokens":13}}\n\n'
           b"data: [DONE]\n\n")
    assert broker.extract_usage(sse) == {"prompt_tokens": 7, "completion_tokens": 13}
    # OpenAI plain JSON
    body = json.dumps({"usage": {"prompt_tokens": 3, "completion_tokens": 4}}).encode()
    raw = b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n" + body
    assert broker.extract_usage(raw) == {"prompt_tokens": 3, "completion_tokens": 4}
    # no usage anywhere -> {}
    assert broker.extract_usage(b"HTTP/1.1 200 OK\r\n\r\n{}") == {}


def http_req(port: int, method: str, path: str, body: bytes | None = None):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request(method, path, body=body,
                 headers={"content-type": "application/json"} if body else {})
    r = conn.getresponse()
    data = r.read()
    conn.close()
    return r.status, data


@pytest.mark.parametrize("env", [{"delay": 2.0, "seed": [40_000] * 5}], indirect=True)
def test_spill_config_endpoint(env):
    up, port, _ = env
    # defaults
    status, data = http_req(port, "GET", "/config/spill")
    cfg = json.loads(data)
    assert status == 200
    assert cfg["spill_thresholds_s"] == {"interactive": 30.0, "worker": 300.0, "batch": None}
    assert cfg["spilled_total"] == 0 and cfg["persisted"] is False
    # invalid class / invalid value -> 400, config untouched
    assert http_req(port, "PUT", "/config/spill", b'{"vip": 10}')[0] == 400
    assert http_req(port, "PUT", "/config/spill", b'{"worker": -1}')[0] == 400
    # occupy the slot (predicted 40s from seed), interactive spills and counts
    t = threading.Thread(target=post_chat, args=(port, "worker", "long"))
    t.start()
    time.sleep(0.4)
    assert post_chat(port, "interactive", "s1", timeout=5)[0] == 503
    cfg = json.loads(http_req(port, "GET", "/config/spill")[1])
    assert cfg["spilled_total"] == 1 and cfg["spilled_by_class"] == {"interactive": 1}
    # disable interactive spill -> same request now queues instead
    status, data = http_req(port, "PUT", "/config/spill", b'{"interactive": null}')
    assert status == 200
    assert json.loads(data)["spill_thresholds_s"]["interactive"] is None
    ok = {}
    t2 = threading.Thread(target=lambda: ok.setdefault(
        "s", post_chat(port, "interactive", "s2")[0]))
    t2.start()
    t.join()
    t2.join()
    assert ok["s"] == 200
    t3_status, _ = http_req(port, "PUT", "/config/spill", b'{"interactive": 45}')
    assert t3_status == 200  # restore a numeric threshold round-trips


def lmstudio_up() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", 1234), 0.5):
            return True
    except OSError:
        return False


@pytest.mark.skipif(not lmstudio_up(), reason="LM Studio not running on :1234")
def test_live_smoke_lmstudio(tmp_path):
    proc, port = start_broker(1234, str(tmp_path / "jobs.jsonl"))
    try:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.request("GET", "/v1/models")
        r = conn.getresponse()
        data = json.loads(r.read())
        conn.close()
        assert r.status == 200 and "data" in data
    finally:
        proc.terminate()
        proc.wait(timeout=5)
