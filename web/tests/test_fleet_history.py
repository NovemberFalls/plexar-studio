"""Tests for Cockpit's self-contained fleet history (no Prometheus): the JSONL
time-series store + GET /api/history/{status,query}.
"""
from __future__ import annotations

import json
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


@pytest.fixture
def _tmp_fleet(tmp_path, monkeypatch):
    monkeypatch.setattr(server_module, "_FLEET_LOG", str(tmp_path / "fleet-metrics.jsonl"))
    return tmp_path


def _snap(runs, tps, up=True, waiting=None, ttft_p95_ms=None):
    m = {"reachable": True, "runs_total": runs,
         "tokens_per_sec": {"avg": tps},
         "engine": {"waiting": waiting} if waiting is not None else {},
         "ttft_ms": {"p95": ttft_p95_ms} if ttft_p95_ms is not None else {}}
    return {"up": up, "metrics": m, "queue": None}


def test_fleet_record_flattens_snapshot():
    rec = server_module._fleet_record(
        {"id": "vllm-local", "kind": "vllm"}, _snap(12, 90.0, waiting=7, ttft_p95_ms=900), ts=1000)
    assert rec["ts"] == 1000 and rec["provider"] == "vllm-local"
    assert rec["runs"] == 12 and rec["tps"] == 90.0
    # T11: `queue_depth` is GONE from the record. Its only surviving source
    # was the engine's own `waiting` counter, which is already its own key --
    # keeping both charted the same series under two names, one of which
    # promised a lane queue that no longer exists.
    assert rec["waiting"] == 7
    assert "queue_depth" not in rec
    assert rec["ttft_p95"] == 0.9                            # 900ms -> 0.9s


def test_append_and_query_roundtrip(_tmp_fleet):
    now = int(server_module._time.time())
    recs = [
        {"ts": now - 100, "provider": "vllm-local", "kind": "vllm", "tps": 80},
        {"ts": now - 50, "provider": "vllm-local", "kind": "vllm", "tps": 100},
        {"ts": now - 50, "provider": "lmstudio-local", "kind": "lmstudio", "tps": 30},
        {"ts": now - 999999, "provider": "vllm-local", "kind": "vllm", "tps": 5},  # outside window
    ]
    server_module._append_fleet_samples(recs)
    grouped = server_module._query_fleet_history("tps", "all", span_s=3600)
    assert set(grouped) == {"vllm-local", "lmstudio-local"}
    assert [v for _, v in grouped["vllm-local"]["points"]] == [80, 100]   # stale one excluded
    # provider filter
    only = server_module._query_fleet_history("tps", "vllm-local", span_s=3600)
    assert set(only) == {"vllm-local"}


def test_trim_drops_stale(_tmp_fleet):
    now = int(server_module._time.time())
    old = {"ts": now - int(server_module._FLEET_RETENTION_S) - 10, "provider": "p", "kind": "k", "tps": 1}
    fresh = {"ts": now, "provider": "p", "kind": "k", "tps": 2}
    server_module._append_fleet_samples([old, fresh])   # append+trim
    with open(server_module._FLEET_LOG, encoding="utf-8") as f:
        rows = [json.loads(l) for l in f]
    assert all(r["ts"] >= now - server_module._FLEET_RETENTION_S for r in rows)
    assert any(r["tps"] == 2 for r in rows)


@pytest.mark.asyncio
async def test_history_status_counts_samples(client, _tmp_fleet):
    now = int(server_module._time.time())
    server_module._append_fleet_samples([{"ts": now, "provider": "p", "kind": "k", "tps": 1}])
    async with client as c:
        resp = await c.get("/api/history/status")
    assert resp.json() == {"reachable": True, "samples": 1}


@pytest.mark.asyncio
async def test_history_query_route(client, _tmp_fleet):
    now = int(server_module._time.time())
    server_module._append_fleet_samples([
        {"ts": now - 10, "provider": "vllm-local", "kind": "vllm", "tps": 88},
    ])
    async with client as c:
        resp = await c.get("/api/history/query?metric=throughput_tps&provider=all&window=24h")
    assert resp.status_code == 200
    body = resp.json()
    assert body["reachable"] is True
    assert body["series"][0]["provider"] == "vllm-local"
    assert body["series"][0]["points"][0][1] == 88


@pytest.mark.asyncio
async def test_history_query_rejects_unknown_metric(client, _tmp_fleet):
    async with client as c:
        resp = await c.get("/api/history/query?metric=nope&window=24h")
    assert resp.status_code == 404
