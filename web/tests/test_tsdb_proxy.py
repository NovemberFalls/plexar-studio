"""Tests for the Prometheus history proxy (GET /api/tsdb/*) that backs Cockpit's
in-app History view. PromQL stays server-side; the browser sends metric+provider+window.
"""
from __future__ import annotations

import os
import sys

import urllib.parse

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app


@pytest.fixture
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420")


@pytest.mark.asyncio
async def test_query_range_builds_server_side_promql(client, monkeypatch):
    seen = {}

    def fake_broker_get(path, query="", base_url=None):
        seen["path"] = path
        seen["query"] = query
        seen["base_url"] = base_url
        return {"status": "success", "data": {"resultType": "matrix", "result": []}}

    monkeypatch.setattr(server_module, "_broker_get", fake_broker_get)

    async with client as c:
        resp = await c.get("/api/tsdb/query_range?metric=throughput_tps&provider=vllm-local&window=24h")
    assert resp.status_code == 200
    assert resp.json()["status"] == "success"
    # server built the PromQL + hit Prometheus, not the broker
    assert seen["path"] == "/api/v1/query_range"
    assert seen["base_url"] == server_module._PROMETHEUS_URL
    decoded = urllib.parse.unquote_plus(seen["query"])
    assert 'cockpit_provider_tps{provider=~"vllm-local"}' in decoded
    assert "start=" in seen["query"] and "step=300" in seen["query"]


@pytest.mark.asyncio
async def test_query_range_all_providers_wildcard(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(server_module, "_broker_get",
                        lambda path, query="", base_url=None: seen.update(q=query) or {"ok": 1})
    async with client as c:
        await c.get("/api/tsdb/query_range?metric=waiting&provider=all&window=session")
    assert 'provider=~".*"' in urllib.parse.unquote_plus(seen["q"])
    assert "step=15" in seen["q"]


@pytest.mark.asyncio
async def test_query_range_rejects_unknown_metric(client):
    async with client as c:
        resp = await c.get("/api/tsdb/query_range?metric=DROP_TABLE&provider=all&window=24h")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_query_range_rejects_bad_window_and_provider(client):
    async with client as c:
        r1 = await c.get("/api/tsdb/query_range?metric=throughput_tps&window=forever")
        r2 = await c.get("/api/tsdb/query_range?metric=throughput_tps&provider=bad%20name&window=24h")
    assert r1.status_code == 400
    assert r2.status_code == 400


@pytest.mark.asyncio
async def test_query_range_prometheus_down(client, monkeypatch):
    def _down(path, query="", base_url=None):
        raise OSError("refused")
    monkeypatch.setattr(server_module, "_broker_get", _down)
    async with client as c:
        resp = await c.get("/api/tsdb/query_range?metric=throughput_tps&window=24h")
    assert resp.status_code == 503
    assert resp.json() == {"reachable": False}


@pytest.mark.asyncio
async def test_status_reachable(monkeypatch):
    monkeypatch.setattr(server_module, "_http_get_text", lambda url, timeout=None: "Prometheus Server is Ready.")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as c:
        resp = await c.get("/api/tsdb/status")
    assert resp.json() == {"reachable": True}


@pytest.mark.asyncio
async def test_status_down(monkeypatch):
    def _down(url, timeout=None):
        raise OSError("refused")
    monkeypatch.setattr(server_module, "_http_get_text", _down)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420") as c:
        resp = await c.get("/api/tsdb/status")
    assert resp.json() == {"reachable": False}
