"""Tests for the unified Prometheus exporter (GET /metrics) that re-exports
every registered provider so LM Studio (broker) + vLLM land in one scrape.
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
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def test_render_prometheus_shape_and_labels():
    vllm_metrics = {
        "reachable": True, "runs_total": 1459,
        "tokens_total": {"prompt": 15000, "completion": 687},
        "tokens_per_sec": {"avg": 11.4}, "decode_tokens_per_sec": {"avg": 90.0},
        "ttft_ms": {"p50": 100, "p95": 900}, "run_time_ms": {"p50": 1000, "p95": 2000},
        "engine": {"running": 1, "waiting": 9, "kv_cache_pct": 82.0},
        "context": {"in": {"avg": 16000, "p95": 20000}, "out": {"avg": 100, "p95": 460}},
    }
    broker_metrics = {"reachable": True, "runs_total": 5, "tokens_total": {"prompt": 100, "completion": 50}}

    pairs = [
        ({"id": "vllm-local", "kind": "vllm"}, {"up": True, "metrics": vllm_metrics, "model_max": 49152}),
        ({"id": "lmstudio-local", "kind": "lmstudio"}, {"up": True, "metrics": broker_metrics}),
    ]
    text = server_module._render_prometheus(pairs)

    # HELP/TYPE emitted once per metric
    assert text.count("# TYPE cockpit_provider_runs_total gauge") == 1
    # both providers labeled
    assert 'cockpit_provider_runs_total{provider="vllm-local",kind="vllm"} 1459.0' in text
    assert 'cockpit_provider_runs_total{provider="lmstudio-local",kind="lmstudio"} 5.0' in text
    # ms -> seconds conversion
    assert 'cockpit_provider_ttft_p50_seconds{provider="vllm-local",kind="vllm"} 0.1' in text
    # vLLM engine depth
    assert 'cockpit_provider_waiting{provider="vllm-local",kind="vllm"} 9.0' in text
    assert 'cockpit_provider_kv_cache_pct{provider="vllm-local",kind="vllm"} 82.0' in text
    # T11: cockpit_provider_queue_depth is NO LONGER EMITTED. It was computed
    # from the lane broker's /queue snapshot (in_flight + queued) and the
    # broker is gone. Asserted as an ABSENCE so a re-added series that quietly
    # aliases the in-engine `waiting` count cannot pass -- that is a different
    # measurement wearing the retired name.
    assert "cockpit_provider_queue_depth" not in text
    # per-request context sizes + model ceiling (for card tuning)
    assert 'cockpit_provider_req_prompt_tokens_avg{provider="vllm-local",kind="vllm"} 16000.0' in text
    assert 'cockpit_provider_req_completion_tokens_p95{provider="vllm-local",kind="vllm"} 460.0' in text
    assert 'cockpit_provider_model_max_tokens{provider="vllm-local",kind="vllm"} 49152.0' in text


def test_render_skips_null_subvalues():
    m = {"reachable": True, "runs_total": 3, "tokens_total": {"prompt": 1, "completion": 2},
         "tokens_per_sec": {"avg": None, "current": None}, "ttft_ms": {"p50": None}}
    text = server_module._render_prometheus([({"id": "p", "kind": "k"}, {"up": True, "metrics": m})])
    assert "cockpit_provider_tps" not in text          # both null -> skipped
    assert "cockpit_provider_ttft_p50_seconds" not in text
    assert 'cockpit_provider_runs_total{provider="p",kind="k"} 3.0' in text


def test_render_unreachable_provider_marks_down():
    text = server_module._render_prometheus([({"id": "dead", "kind": "vllm"}, {"up": False, "metrics": None})])
    assert 'cockpit_provider_up{provider="dead",kind="vllm"} 0.0' in text


@pytest.mark.asyncio
async def test_metrics_route_covers_all_providers(client, monkeypatch):
    monkeypatch.setattr(server_module, "_vllm_metrics",
                        lambda url, window: {"reachable": True, "runs_total": 42, "tokens_total": {"prompt": 1, "completion": 2}})

    def fake_broker_get(path, query="", base_url=None):
        if path == "/metrics":
            return {"reachable": True, "runs_total": 7, "tokens_total": {"prompt": 3, "completion": 4}}
        raise AssertionError(path)

    monkeypatch.setattr(server_module, "_broker_get", fake_broker_get)

    async with client as c:
        resp = await c.get("/metrics")
    assert resp.status_code == 200
    assert "text/plain" in resp.headers["content-type"]
    body = resp.text
    assert 'cockpit_provider_up{provider="vllm-local"' in body
    assert 'cockpit_provider_up{provider="lmstudio-local"' in body
    assert 'cockpit_provider_runs_total{provider="vllm-local",kind="vllm"} 42.0' in body
    # LM Studio no longer contributes run counters at all: /metrics was the
    # BROKER's aggregate over its own jobs.jsonl, and it went with the broker
    # (T11). LM Studio has no metrics capability, so the exporter skips it.
    assert 'cockpit_provider_runs_total{provider="lmstudio-local"' not in body
