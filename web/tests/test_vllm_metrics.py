"""Tests for the vLLM Prometheus -> broker-metrics-contract adapter
(server._parse_prometheus / _hist_quantile / _vllm_metrics) and the
GET /api/local/vllm-local/metrics route it feeds.

Covers:
  1. Prometheus text parsing (labels, quoted commas, malformed-line skip).
  2. Histogram quantile interpolation across cumulative _bucket{le=} counts.
  3. _vllm_metrics reshaping: counters -> runs/tokens, histograms -> ttft/run_time,
     honesty markers (window_exact, empty breakdowns).
  4. Route: kind=="vllm" takes the adapter path, returns broker-shaped 200;
     bad window -> 400; unreachable -> 503; timeseries -> honest unsupported.
"""
from __future__ import annotations

import os
import sys

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


# A trimmed-but-real-shaped vLLM /metrics scrape.
SAMPLE = """\
# HELP vllm:prompt_tokens_total Number of prefill tokens processed.
# TYPE vllm:prompt_tokens_total counter
vllm:prompt_tokens_total{model_name="qwen3-coder-30b-awq"} 12000.0
# TYPE vllm:generation_tokens_total counter
vllm:generation_tokens_total{model_name="qwen3-coder-30b-awq"} 4000.0
# TYPE vllm:request_success_total counter
vllm:request_success_total{finished_reason="stop",model_name="qwen3-coder-30b-awq"} 8.0
vllm:request_success_total{finished_reason="length",model_name="qwen3-coder-30b-awq"} 2.0
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le="0.1",model_name="m"} 0.0
vllm:time_to_first_token_seconds_bucket{le="0.5",model_name="m"} 5.0
vllm:time_to_first_token_seconds_bucket{le="1.0",model_name="m"} 9.0
vllm:time_to_first_token_seconds_bucket{le="+Inf",model_name="m"} 10.0
vllm:time_to_first_token_seconds_sum{model_name="m"} 5.0
vllm:time_to_first_token_seconds_count{model_name="m"} 10.0
# TYPE vllm:e2e_request_latency_seconds histogram
vllm:e2e_request_latency_seconds_bucket{le="1.0",model_name="m"} 0.0
vllm:e2e_request_latency_seconds_bucket{le="10.0",model_name="m"} 10.0
vllm:e2e_request_latency_seconds_bucket{le="+Inf",model_name="m"} 10.0
vllm:e2e_request_latency_seconds_sum{model_name="m"} 40.0
vllm:e2e_request_latency_seconds_count{model_name="m"} 10.0
# TYPE vllm:time_per_output_token_seconds histogram
vllm:time_per_output_token_seconds_sum{model_name="m"} 20.0
vllm:time_per_output_token_seconds_count{model_name="m"} 4000.0
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="m"} 1.0
vllm:num_requests_waiting{model_name="m"} 9.0
vllm:kv_cache_usage_perc{model_name="m"} 0.82
vllm:cache_config_info{kv_cache_size_tokens="63664",kv_cache_max_concurrency="1.3",model_name="m"} 1.0
# TYPE vllm:request_prompt_tokens histogram
vllm:request_prompt_tokens_sum{model_name="m"} 32000.0
vllm:request_prompt_tokens_count{model_name="m"} 2.0
vllm:request_prompt_tokens_bucket{le="10000.0",model_name="m"} 0.0
vllm:request_prompt_tokens_bucket{le="20000.0",model_name="m"} 1.0
vllm:request_prompt_tokens_bucket{le="+Inf",model_name="m"} 2.0
# TYPE vllm:request_generation_tokens histogram
vllm:request_generation_tokens_sum{model_name="m"} 200.0
vllm:request_generation_tokens_count{model_name="m"} 2.0
vllm:request_generation_tokens_bucket{le="100.0",model_name="m"} 1.0
vllm:request_generation_tokens_bucket{le="500.0",model_name="m"} 2.0
vllm:request_generation_tokens_bucket{le="+Inf",model_name="m"} 2.0
this_is_malformed
"""


def test_parse_prometheus_labels_and_values():
    parsed = server_module._parse_prometheus(SAMPLE)
    assert parsed["vllm:prompt_tokens_total"][0][1] == 12000.0
    assert parsed["vllm:prompt_tokens_total"][0][0]["model_name"] == "qwen3-coder-30b-awq"
    # two label sets for request_success_total
    assert len(parsed["vllm:request_success_total"]) == 2
    # malformed line skipped, not raised
    assert "this_is_malformed" not in parsed


def test_split_labels_respects_quoted_commas():
    pairs = server_module._split_labels('a="x,y",b="z"')
    assert pairs == ['a="x,y"', 'b="z"']


def test_hist_quantile_interpolates():
    parsed = server_module._parse_prometheus(SAMPLE)
    # ttft: 10 total, p50 target=5 lands exactly at le=0.5 cumulative boundary.
    p50 = server_module._hist_quantile(parsed, "vllm:time_to_first_token_seconds", 0.50)
    assert p50 == pytest.approx(0.5, abs=1e-6)
    # p95 target=9.5 sits between le=1.0 (cum 9) and +Inf -> clamps to last finite le.
    p95 = server_module._hist_quantile(parsed, "vllm:time_to_first_token_seconds", 0.95)
    assert p95 == pytest.approx(1.0, abs=1e-6)


def test_hist_quantile_absent_returns_none():
    assert server_module._hist_quantile({}, "vllm:nope", 0.5) is None


def test_vllm_metrics_reshape(monkeypatch):
    monkeypatch.setattr(server_module, "_http_get_text", lambda url, timeout=None: SAMPLE)
    m = server_module._vllm_metrics("http://127.0.0.1:8001", "lifetime")

    assert m["runs_total"] == 10          # 8 + 2 success
    assert m["prompts_total"] == 10       # vLLM has no distinct prompt id
    assert m["tokens_total"] == {"prompt": 12000, "completion": 4000}
    # tps avg = completion / e2e_sum = 4000 / 40 = 100
    assert m["tokens_per_sec"]["avg"] == 100.0
    # decode avg = count / sum = 4000 / 20 = 200 tok/s
    assert m["decode_tokens_per_sec"]["avg"] == 200.0
    assert m["ttft_ms"]["p50"] == pytest.approx(500.0, abs=1.0)
    assert m["run_time_ms"]["p50"] is not None
    # honesty markers
    assert m["window_exact"] is True
    assert m["source"] == "vllm-prometheus"
    assert m["served_model"] == "qwen3-coder-30b-awq"  # from counter labels
    # live in-engine depth + KV headroom
    assert m["engine"]["running"] == 1
    assert m["engine"]["waiting"] == 9
    assert m["engine"]["kv_cache_pct"] == 82.0
    assert m["engine"]["kv_cache_tokens"] == 63664
    assert m["engine"]["max_concurrency"] == 1.3
    # per-request context sizes (for card tuning): avg exact, p95 from histogram
    assert m["context"]["in"]["avg"] == 16000   # 32000 / 2
    assert m["context"]["in"]["p95"] == 20000   # saturates at top finite bucket
    assert m["context"]["out"]["avg"] == 100    # 200 / 2
    assert m["context"]["out"]["p95"] == 460    # interpolated 100..500
    assert m["by_session"] == [] and m["by_agent"] == [] and m["by_lane_class"] == []
    # satisfies the shape-validation contract keys
    assert server_module._looks_like(m, server_module._METRICS_SHAPE_KEYS)


def test_vllm_metrics_accepts_renamed_tpot_histogram(monkeypatch):
    # Newer vLLM builds name the per-output-token histogram
    # request_time_per_output_token_seconds (SAMPLE uses the old name).
    renamed = SAMPLE.replace(
        "vllm:time_per_output_token_seconds",
        "vllm:request_time_per_output_token_seconds",
    )
    monkeypatch.setattr(server_module, "_http_get_text", lambda url, timeout=None: renamed)
    m = server_module._vllm_metrics("http://127.0.0.1:8001", "lifetime")
    assert m["decode_tokens_per_sec"]["avg"] == 200.0  # count/sum = 4000/20


def test_vllm_metrics_window_not_exact(monkeypatch):
    monkeypatch.setattr(server_module, "_http_get_text", lambda url, timeout=None: SAMPLE)
    m = server_module._vllm_metrics("http://127.0.0.1:8001", "24h")
    assert m["window"] == "24h"
    assert m["window_exact"] is False


@pytest.mark.asyncio
async def test_route_vllm_metrics_uses_adapter(client, monkeypatch, _tmp_store):
    # _tmp_store isolates the persistence path (empty rollup) so the overlay is a
    # no-op and the raw adapter numbers pass through unchanged.
    monkeypatch.setattr(server_module, "_http_get_text", lambda url, timeout=None: SAMPLE)

    def _boom(*a, **k):  # broker path must NOT be taken for a vllm provider
        raise AssertionError("vLLM metrics must not call _broker_get")

    monkeypatch.setattr(server_module, "_broker_get", _boom)

    async with client as c:
        resp = await c.get("/api/local/vllm-local/metrics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["runs_total"] == 10
    assert body["source"] == "vllm-prometheus"


@pytest.mark.asyncio
async def test_route_vllm_metrics_bad_window(client):
    async with client as c:
        resp = await c.get("/api/local/vllm-local/metrics?window=nope")
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_route_vllm_metrics_unreachable_no_history(client, monkeypatch, _tmp_store):
    # offline AND no persisted rollup -> honest 503 (nothing to show)
    def _down(url, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_http_get_text", _down)
    async with client as c:
        resp = await c.get("/api/local/vllm-local/metrics")
    assert resp.status_code == 503
    assert resp.json() == {"reachable": False}


@pytest.mark.asyncio
async def test_route_vllm_metrics_offline_serves_persisted(client, monkeypatch, _tmp_store):
    # offline BUT persisted lifetime exists -> serve it (stale), don't 503, so the
    # backend stays in the report when the GPU is running the other engine.
    server_module._save_vllm_rollup(
        {"carried": {"runs": 100, "prompt": 90000, "completion": 4000},
         "last_raw": {"runs": 10, "prompt": 9000, "completion": 400}})

    def _down(url, timeout=None):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_http_get_text", _down)
    async with client as c:
        resp = await c.get("/api/local/vllm-local/metrics")
    assert resp.status_code == 200
    body = resp.json()
    assert body["stale"] is True
    assert body["runs_total"] == 110          # carried 100 + last-seen 10
    assert body["tokens_total"] == {"prompt": 99000, "completion": 4400}
    assert body["engine"] is None             # live-only, unknown offline


def test_offline_snapshot_none_without_history(_tmp_store):
    assert server_module._vllm_offline_snapshot() is None


@pytest.mark.asyncio
async def test_route_vllm_timeseries_is_gone_not_unsupported(client):
    """This route used to answer 200 {supported: false} for vLLM, to say
    "cumulative counters only, no recomputable buckets" rather than 503 as if
    unreachable. The ROUTE ITSELF is now removed (T11) -- it existed to proxy
    the lane broker's /metrics/timeseries, and with no broker there is no
    implementation for any provider. A 404 from an absent route is the honest
    answer; a 200 saying "unsupported" would imply the route still exists."""
    async with client as c:
        resp = await c.get("/api/local/vllm-local/metrics/timeseries")
    assert resp.status_code == 404


# ── Persistence (reset-aware accumulator + JSONL dataset) ──

@pytest.fixture
def _tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "_VLLM_METRICS_DIR", str(tmp_path))
    monkeypatch.setattr(server_module, "_VLLM_METRICS_LOG", str(tmp_path / "vllm-metrics.jsonl"))
    monkeypatch.setattr(server_module, "_VLLM_METRICS_ROLLUP", str(tmp_path / "vllm-metrics-rollup.json"))
    return tmp_path


def _metrics(runs, prompt, completion):
    return {"runs_total": runs, "tokens_total": {"prompt": prompt, "completion": completion},
            "tokens_per_sec": {"avg": 10.0}, "decode_tokens_per_sec": {"avg": 90.0}}


def test_record_sample_writes_log_and_rollup(_tmp_store):
    server_module._record_vllm_sample(_metrics(10, 1000, 200))
    rollup = server_module._load_vllm_rollup()
    assert rollup["carried"] == {"runs": 0, "prompt": 0, "completion": 0}
    assert rollup["last_raw"] == {"runs": 10, "prompt": 1000, "completion": 200}
    lines = (_tmp_store / "vllm-metrics.jsonl").read_text().strip().splitlines()
    assert len(lines) == 1
    import json as _j
    assert _j.loads(lines[0])["runs"] == 10


def test_record_sample_banks_on_reset(_tmp_store):
    server_module._record_vllm_sample(_metrics(10, 1000, 200))   # pre-restart peak
    server_module._record_vllm_sample(_metrics(3, 300, 60))      # vLLM restarted -> lower
    rollup = server_module._load_vllm_rollup()
    # the pre-restart totals are banked into carried
    assert rollup["carried"] == {"runs": 10, "prompt": 1000, "completion": 200}
    assert rollup["last_raw"] == {"runs": 3, "prompt": 300, "completion": 60}


def test_apply_persistence_overlays_baseline(_tmp_store):
    server_module._save_vllm_rollup(
        {"carried": {"runs": 10, "prompt": 1000, "completion": 200},
         "last_raw": {"runs": 3, "prompt": 300, "completion": 60}})
    live = _metrics(5, 500, 100)      # current vLLM session climbed past last_raw
    out = server_module._vllm_apply_persistence(live)
    assert out["runs_total"] == 15                 # 10 carried + 5 live
    assert out["tokens_total"] == {"prompt": 1500, "completion": 300}
    assert out["persisted"] is True
    assert out["live_session"]["runs"] == 5


def test_apply_persistence_honors_unbanked_reset(_tmp_store):
    # last_raw is high but live is lower => a restart the sampler hasn't banked
    # yet; the overlay must still count the pre-reset total (no dip).
    server_module._save_vllm_rollup(
        {"carried": {"runs": 0, "prompt": 0, "completion": 0},
         "last_raw": {"runs": 100, "prompt": 9000, "completion": 800}})
    out = server_module._vllm_apply_persistence(_metrics(2, 150, 30))
    assert out["runs_total"] == 102                # 100 pre-reset + 2 live, not 2
    assert out["tokens_total"]["completion"] == 830


@pytest.mark.asyncio
async def test_route_metrics_is_persisted(client, _tmp_store, monkeypatch):
    monkeypatch.setattr(server_module, "_http_get_text", lambda url, timeout=None: SAMPLE)
    server_module._save_vllm_rollup(
        {"carried": {"runs": 100, "prompt": 5000, "completion": 900},
         "last_raw": {"runs": 10, "prompt": 12000, "completion": 4000}})
    async with client as c:
        resp = await c.get("/api/local/vllm-local/metrics")
    body = resp.json()
    assert body["persisted"] is True
    assert body["runs_total"] == 110              # 100 carried + 10 live (SAMPLE)
    assert body["live_session"]["runs"] == 10
