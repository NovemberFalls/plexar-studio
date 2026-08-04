"""lane-broker metrics-v2 tests (TTFT, true decode, queue wait, errors,
by_model, timeseries, predicted_wait_s_by_class).

Pure/offline: seeds a synthetic jobs.jsonl and drives the aggregation methods
directly — no live upstream, no sockets.

Run: python -m pytest lane_broker/tests -q
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import broker as B  # noqa: E402


def make_server(log_path):
    eta = B.EtaModel(log_path)
    brk = B.Broker("127.0.0.1", 1234, eta, shadow=False)
    return B.Server(brk, 1235), brk


def rec(ts, model="m", cls="worker", wall=1000, ptok=10, ctok=100,
        ttft=100, qwait=0, status="ok", error_kind=None, client="c0",
        agent="a0", trace="", parent=""):
    r = {"ts": ts, "class": cls, "prompt_chars": 50, "wall_ms": wall,
         "model": model, "client_id": client, "agent": agent,
         "trace_id": trace, "trace_parent": parent, "status": status,
         "ttft_ms": ttft, "queue_wait_ms": qwait}
    if ptok is not None:
        r["prompt_tokens"] = ptok
    if ctok is not None:
        r["completion_tokens"] = ctok
    if error_kind is not None:
        r["error_kind"] = error_kind
    return r


def seed(path, recs):
    with open(path, "w", encoding="utf-8") as f:
        for r in recs:
            f.write(json.dumps(r) + "\n")


# ---- TTFT: null for non-stream, excluded from percentiles -----------------

def test_ttft_null_excluded_from_percentiles(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    seed(log, [
        rec("2026-07-24T00:00:00Z", ttft=100),
        rec("2026-07-24T00:00:01Z", ttft=200),
        rec("2026-07-24T00:00:02Z", ttft=300),
        rec("2026-07-24T00:00:03Z", ttft=None),  # non-streaming -> excluded
    ])
    srv, _ = make_server(log)
    m = srv._metrics_state("lifetime")
    # runs_total counts all completed runs, including the non-stream one
    assert m["runs_total"] == 4
    # percentiles computed over {100,200,300} only
    assert m["ttft_ms"]["p50"] == 200
    assert m["ttft_ms"]["p95"] == 300


# ---- true decode speed math -----------------------------------------------

def test_decode_tokens_per_sec_math(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    # completion=100, wall=1100, ttft=100 -> 100 / ((1100-100)/1000) = 100 tok/s
    seed(log, [
        rec("2026-07-24T00:00:00Z", wall=1100, ctok=100, ttft=100),
        rec("2026-07-24T00:00:01Z", wall=600, ctok=50, ttft=100),  # 50/0.5 = 100
    ])
    srv, _ = make_server(log)
    d = srv._metrics_state("lifetime")["decode_tokens_per_sec"]
    assert d["p50"] == 100.0
    assert d["avg"] == 100.0
    assert d["current"] == 100.0
    # tokens_per_sec (wall-clock) must remain SEPARATE and lower than decode
    tps = srv._metrics_state("lifetime")["tokens_per_sec"]
    assert tps["avg"] is not None and tps["avg"] < d["avg"]


# ---- queue wait -----------------------------------------------------------

def test_queue_wait_percentiles(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    seed(log, [
        rec("2026-07-24T00:00:00Z", qwait=500),
        rec("2026-07-24T00:00:01Z", qwait=1500),
        rec("2026-07-24T00:00:02Z", qwait=2500),
    ])
    srv, _ = make_server(log)
    q = srv._metrics_state("lifetime")["queue_wait_ms"]
    assert q["p50"] == 1500
    assert q["p95"] == 2500


# ---- error counting + runs/attempts split ---------------------------------

def test_error_counting_and_attempts(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    seed(log, [
        rec("2026-07-24T00:00:00Z", status="ok"),
        rec("2026-07-24T00:00:01Z", status="error", error_kind="upstream_5xx",
            ctok=None, ttft=None),
        rec("2026-07-24T00:00:02Z", status="error", error_kind="timeout",
            ctok=None, ttft=None),
    ])
    srv, _ = make_server(log)
    m = srv._metrics_state("lifetime")
    assert m["runs_total"] == 1          # completed only
    assert m["attempts_total"] == 3      # denominator for failure rate
    assert m["errors_total"] == 2
    assert m["errors_by_kind"] == {"upstream_5xx": 1, "timeout": 1}
    # errored runs must not pollute wall-time percentiles
    assert m["run_time_ms"]["max"] == 1000


# ---- by_model breakdown ---------------------------------------------------

def test_by_model_breakdown(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    seed(log, [
        rec("2026-07-24T00:00:00Z", model="qwen"),
        rec("2026-07-24T00:00:01Z", model="qwen"),
        rec("2026-07-24T00:00:02Z", model="llama"),
    ])
    srv, _ = make_server(log)
    bm = srv._metrics_state("lifetime")["by_model"]
    by = {row["key"]: row for row in bm}
    assert by["qwen"]["runs_total"] == 2
    assert by["llama"]["runs_total"] == 1
    # each breakdown row carries the new v2 fields
    for row in bm:
        assert "ttft_ms" in row and "decode_tokens_per_sec" in row
        assert "queue_wait_ms" in row and "errors_total" in row


# ---- timeseries bucketing -------------------------------------------------

def test_timeseries_bucketing(tmp_path):
    from datetime import datetime, timezone, timedelta
    log = str(tmp_path / "jobs.jsonl")
    now = datetime.now(timezone.utc)
    t1 = (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    t2 = (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    seed(log, [
        rec(t1, wall=1100, ctok=100, ttft=100),
        rec(t1, wall=1100, ctok=100, ttft=100),
        rec(t2, status="error", error_kind="timeout", ctok=None, ttft=None),
    ])
    srv, _ = make_server(log)
    ts = srv._timeseries("24h", "1h")
    assert ts["persisted"] is True
    assert ts["bucket_s"] == 3600
    pid = ts["provider_id"]
    total_runs = sum(b["by_provider"][pid]["runs"] for b in ts["buckets"])
    total_errors = sum(b["by_provider"][pid]["errors"] for b in ts["buckets"])
    assert total_runs == 2        # only completed runs count as runs
    assert total_errors == 1
    # the bucket holding the two decodeable runs reports a decode p50
    decodes = [b["by_provider"][pid]["decode_tps_p50"]
               for b in ts["buckets"]
               if b["by_provider"][pid]["decode_tps_p50"] is not None]
    assert 100.0 in decodes


# ---- predicted_wait_s_by_class on /queue ----------------------------------

def test_predicted_wait_by_class_on_queue(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    seed(log, [])
    srv, _ = make_server(log)
    q = srv._queue_state()
    assert set(q["predicted_wait_s_by_class"]) == {"interactive", "worker", "batch"}
    # empty queue, nothing in flight -> zero wait for every class
    assert all(v == 0.0 for v in q["predicted_wait_s_by_class"].values())


# ---- helper units ---------------------------------------------------------

def test_sse_frame_has_content():
    assert B._sse_frame_has_content(
        b'{"choices":[{"delta":{"content":"hi"}}]}')
    assert B._sse_frame_has_content(
        b'{"type":"content_block_delta","delta":{"text":"hi"}}')
    assert not B._sse_frame_has_content(b"[DONE]")
    assert not B._sse_frame_has_content(
        b'{"choices":[{"delta":{"role":"assistant"}}]}')
    assert not B._sse_frame_has_content(b"not json")


def test_classify_status():
    assert B._classify_status(200, b"") == ("ok", None)
    assert B._classify_status(503, b"") == ("error", "upstream_5xx")
    assert B._classify_status(0, b"") == ("error", "transport")
    assert B._classify_status(504, b"") == ("error", "timeout")
    assert B._classify_status(400, b'{"error":"maximum context length exceeded"}') \
        == ("error", "context_overflow")
    assert B._classify_status(418, b"nope") == ("error", "other")


def test_parse_bucket():
    assert B._parse_bucket("5m") == 300
    assert B._parse_bucket("1h") == 3600
    assert B._parse_bucket("1d") == 86400
    assert B._parse_bucket("90") == 90
    assert B._parse_bucket(None) is None
    assert B._parse_bucket("junk") is None


def test_7d_window_parsed(tmp_path):
    log = str(tmp_path / "jobs.jsonl")
    seed(log, [rec("2026-07-24T00:00:00Z")])
    srv, _ = make_server(log)
    m = srv._metrics_state("7d")
    assert m["window"] == "7d"
    assert m["persisted"] is True


# ---- reasoning_content counts as TTFT (defect 2) --------------------------

def test_sse_frame_reasoning_content_is_ttft():
    # LM Studio reasoning models stream reasoning_content long before content;
    # that first reasoning token IS what the user waits on -> counts as TTFT.
    assert B._sse_frame_has_content(
        b'{"choices":[{"delta":{"reasoning_content":"thinking"}}]}')
    assert B._sse_frame_has_content(
        b'{"choices":[{"delta":{"reasoning":"thinking"}}]}')
    assert B._sse_frame_has_content(
        b'{"type":"content_block_delta","delta":{"thinking":"hm"}}')
    # a frame with neither content nor reasoning is still not a first token
    assert not B._sse_frame_has_content(
        b'{"choices":[{"delta":{"role":"assistant"}}]}')


# ---- response-end detector (defect 1 unit) --------------------------------

def _chunk(b: bytes) -> bytes:
    return f"{len(b):x}\r\n".encode() + b + b"\r\n"


def test_response_end_detector_chunked_and_length():
    hdr = (b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
           b"Transfer-Encoding: chunked\r\n")
    d = B._ResponseEndDetector(hdr)
    assert d.mode == "chunked"
    d.feed(_chunk(b"data: hi\n\n"))
    assert not d.done          # mid-stream, terminal chunk not seen yet
    d.feed(b"0\r\n\r\n")       # terminal zero-length chunk
    assert d.done              # message complete -> relay may stop

    d2 = B._ResponseEndDetector(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n")
    assert d2.mode == "length"
    d2.feed(b"abc")
    assert not d2.done
    d2.feed(b"de")
    assert d2.done

    # split terminal chunk across two feeds is still detected
    d3 = B._ResponseEndDetector(hdr)
    d3.feed(_chunk(b"x") + b"0\r")
    assert not d3.done
    d3.feed(b"\n\r\n")
    assert d3.done


# ---- live chunked streaming relay records promptly (defect 1 integration) --

def test_streaming_chunked_relay_records_promptly(tmp_path):
    """End-to-end: a mock upstream streams a chunked SSE response (reasoning
    frames + content + a TAIL usage frame + [DONE]) then LINGERS on the socket
    like LM Studio's keep-alive. The broker must relay byte-verbatim, stop at the
    terminal chunk, and write exactly ONE jobs.jsonl record (with completion
    tokens from the tail usage frame and a non-null ttft) BEFORE the linger ends
    — proving it no longer blocks until the upstream closes the socket."""
    import asyncio
    import time

    log = str(tmp_path / "jobs.jsonl")
    LINGER = 2.0

    async def upstream(reader, writer):
        try:
            await reader.readuntil(b"\r\n\r\n")
        except Exception:
            pass
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
                     b"Connection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\n")
        for payload in (
            b'{"choices":[{"delta":{"reasoning_content":"think"}}]}',
            b'{"choices":[{"delta":{"reasoning_content":"more"}}]}',
            b'{"choices":[{"delta":{"content":"hi"}}]}',
            b'{"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":7}}',
            b'[DONE]',
        ):
            writer.write(_chunk(b"data: " + payload + b"\n\n"))
        writer.write(b"0\r\n\r\n")           # terminal chunk = true end of message
        await writer.drain()
        await asyncio.sleep(LINGER)           # keep-alive linger (the bug trigger)
        try:
            writer.close()
        except Exception:
            pass

    async def run():
        up_srv = await asyncio.start_server(upstream, "127.0.0.1", 0)
        up_port = up_srv.sockets[0].getsockname()[1]
        eta = B.EtaModel(log)
        brk = B.Broker("127.0.0.1", up_port, eta, shadow=False)
        srv = B.Server(brk, 0)
        disp = asyncio.create_task(brk.dispatcher())
        br_srv = await asyncio.start_server(srv.handle, "127.0.0.1", 0)
        br_port = br_srv.sockets[0].getsockname()[1]

        body = (b'{"model":"qwen","messages":[{"role":"user","content":"hi"}],'
                b'"stream":true}')
        r, w = await asyncio.open_connection("127.0.0.1", br_port)
        req = (b"POST /v1/chat/completions HTTP/1.1\r\nhost: x\r\n"
               b"x-lane-class: interactive\r\nx-trace-id: t1\r\n"
               b"content-type: application/json\r\n"
               b"content-length: %d\r\n\r\n" % len(body)) + body
        w.write(req)
        await w.drain()
        t0 = time.monotonic()
        data = b""
        while True:
            c = await r.read(65536)
            if not c:
                break
            data += c
        elapsed = time.monotonic() - t0
        w.close()
        lines = [ln for ln in open(log, encoding="utf-8").read().splitlines() if ln]
        disp.cancel()
        up_srv.close()
        br_srv.close()
        return data, elapsed, lines

    data, elapsed, lines = asyncio.run(run())

    assert b"[DONE]" in data                    # client got the full stream verbatim
    assert elapsed < LINGER                      # relay ended at stream end, not on close
    assert len(lines) == 1, lines                # exactly one record, and it exists now
    r = json.loads(lines[0])
    assert r["status"] == "ok"
    assert r["completion_tokens"] == 7           # tail usage frame captured
    assert r["ttft_ms"] is not None              # reasoning_content counted as TTFT
    assert r["queue_wait_ms"] is not None
