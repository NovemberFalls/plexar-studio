"""Tests for the Phase-A routing/reporting proxy + API-side endpoints.

Covers:
  1. GET /api/local/{provider}/metrics/timeseries proxies broker JSON verbatim
     (new fields pass through unchanged -- no shape validation to strip them).
  2. GET /api/local/{provider}/spills proxies broker JSON, forwards limit.
  3. GET /api/local/{provider}/metrics passthrough of new (ttft_ms etc.) fields.
  4. GET /api/usage/summary sources usage_tracker.summary(window) and validates
     the window param.
  5. GET /api/pricing/models reads pricing_models.json, falls back to the
     inline default (still 200) when missing/unreadable.

The broker itself is never contacted -- server._broker_get is monkeypatched,
matching web/tests/test_local_broker.py's style. usage_tracker.summary is
monkeypatched directly on the singleton instance.
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


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_timeseries_proxies_broker_json(client, monkeypatch):
    payload = {
        "buckets": [
            {"ts": "2026-07-24T00:00:00Z", "by_provider": {
                "lmstudio-local": {"runs": 3, "tokens": 900, "decode_tps_p50": 42.0,
                                    "ttft_ms_p50": 210, "queue_wait_ms_p50": 15, "spilled": 0, "errors": 0}
            }}
        ]
    }
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["path"] = path
        seen["query"] = query
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/metrics/timeseries?window=24h&bucket=1h")
    assert res.status_code == 200
    assert res.json() == payload
    assert seen["path"] == "/metrics/timeseries"
    assert seen["query"] == "window=24h&bucket=1h"


@pytest.mark.asyncio
async def test_timeseries_invalid_window_400_not_forwarded(client, monkeypatch):
    called = {"n": 0}

    def fake_get(path, query="", base_url=None):
        called["n"] += 1
        return {}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/metrics/timeseries?window=bogus")
    assert res.status_code == 400
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_timeseries_unknown_provider_404(client, monkeypatch):
    res = await client.get("/api/local/nope/metrics/timeseries")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_timeseries_offline_returns_503(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/metrics/timeseries")
    assert res.status_code == 503
    assert res.json() == {"reachable": False}


@pytest.mark.asyncio
async def test_spills_proxies_and_forwards_limit(client, monkeypatch):
    payload = {"spills": [{"ts": "2026-07-24T00:00:00Z", "lane_class": "interactive",
                            "predicted_wait_s": 55.0, "threshold_s": 30.0,
                            "client_id": "c1", "agent": "ash", "trace_id": "t1"}]}
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["path"] = path
        seen["query"] = query
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/spills?limit=5")
    assert res.status_code == 200
    assert res.json() == payload
    assert seen["path"] == "/spills"
    assert seen["query"] == "limit=5"


@pytest.mark.asyncio
async def test_spills_limit_clamped(client, monkeypatch):
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["query"] = query
        return {"spills": []}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/spills?limit=9999")
    assert res.status_code == 200
    assert seen["query"] == "limit=100"


@pytest.mark.asyncio
async def test_spills_capability_missing_404(client, monkeypatch):
    # lmstudio-local doesn't declare "spill" absent -- swap capabilities to
    # simulate a provider without it, then restore.
    provider = server_module._PROVIDERS["lmstudio-local"]
    original = provider["capabilities"]
    provider["capabilities"] = [c for c in original if c != "spill"]
    try:
        res = await client.get("/api/local/lmstudio-local/spills")
        assert res.status_code == 404
    finally:
        provider["capabilities"] = original


@pytest.mark.asyncio
async def test_metrics_passthrough_of_new_fields(client, monkeypatch):
    """/metrics already proxies verbatim -- new broker fields (ttft_ms,
    queue_wait_ms, errors_total, by_model, by_provider) must pass through
    unchanged, with no shape-stripping code path added for them."""
    payload = {
        "runs_total": 12, "prompts_total": 10, "tokens_total": {"prompt": 100, "completion": 50},
        "tokens_per_sec": {"current": 30.0, "avg": 28.0},
        "ttft_ms": {"p50": 200, "p95": 500},
        "decode_tokens_per_sec": {"current": 40.0, "avg": 38.0, "p50": 39.0},
        "queue_wait_ms": {"p50": 10, "p95": 40},
        "errors_total": 1, "errors_by_kind": {"timeout": 1},
        "by_model": [{"id": "qwen3-coder-30b", "runs_total": 12}],
        "by_provider": [{"id": "gpu-main", "runs_total": 12, "spilled_out": 0}],
    }

    def fake_get(path, query="", base_url=None):
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/metrics?window=lifetime")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_usage_summary_sources_usage_tracker(client, monkeypatch):
    payload = {
        "runs": 5, "tokens": {"prompt": 1000, "completion": 500},
        "ttft_ms": {"p50": None, "p95": None}, "wall_ms": {"p50": 900, "p95": 2000},
        "errors_total": 0, "cost_usd": 1.23, "by_model": [],
    }

    def fake_summary(window):
        assert window == "24h"
        return payload

    monkeypatch.setattr(server_module.usage_tracker, "summary", fake_summary)
    res = await client.get("/api/usage/summary?window=24h")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_usage_summary_invalid_window_400(client):
    res = await client.get("/api/usage/summary?window=bogus")
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_usage_summary_tracker_failure_503(client, monkeypatch):
    def fake_summary(window):
        raise RuntimeError("db locked")

    monkeypatch.setattr(server_module.usage_tracker, "summary", fake_summary)
    res = await client.get("/api/usage/summary")
    assert res.status_code == 503
    assert res.json() == {"reachable": False}


@pytest.mark.asyncio
async def test_pricing_models_reads_file(client, monkeypatch, tmp_path):
    models = [{"id": "claude-sonnet", "label": "Claude Sonnet", "input_per_mtok": 3.0,
               "output_per_mtok": 15.0, "fetched_at": "2026-07-24"}]
    path = tmp_path / "pricing_models.json"
    path.write_text('{"models": ' + str(models).replace("'", '"') + '}', encoding="utf-8")
    monkeypatch.setattr(server_module, "_PRICING_MODELS_PATH", str(path))
    res = await client.get("/api/pricing/models")
    assert res.status_code == 200
    assert res.json() == models


@pytest.mark.asyncio
async def test_pricing_models_falls_back_when_missing(client, monkeypatch):
    monkeypatch.setattr(server_module, "_PRICING_MODELS_PATH", "/nonexistent/pricing_models.json")
    res = await client.get("/api/pricing/models")
    assert res.status_code == 200
    body = res.json()
    assert body == server_module._DEFAULT_PRICING_MODELS
    ids = {m["id"] for m in body}
    assert {"claude-sonnet", "claude-opus", "claude-haiku", "fable"} <= ids
