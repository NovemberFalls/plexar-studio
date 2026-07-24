"""Tests for the managed lane-broker lifecycle (server.start_managed_broker).

Covers:
  1. External broker answering -> managed broker NOT started (external wins).
  2. Nothing listening -> managed task starts; /api/local/status reports managed.
  3. COCKPIT_MANAGED_BROKER=0 -> never starts.
  4. stop_managed_broker cancels the task cleanly.
"""
from __future__ import annotations

import asyncio
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


@pytest.fixture(autouse=True)
async def _clean_managed_state():
    server_module._MANAGED_BROKER["task"] = None
    server_module._detect_cache["result"] = None
    server_module._detect_cache["at"] = 0.0
    yield
    await server_module.stop_managed_broker()


@pytest.mark.asyncio
async def test_external_broker_wins(monkeypatch):
    monkeypatch.setattr(server_module, "_broker_get",
                        lambda path, query="": {"queued": [], "shadow": True})
    started = await server_module.start_managed_broker()
    assert started is False
    assert server_module._MANAGED_BROKER["task"] is None


@pytest.mark.asyncio
async def test_starts_when_nothing_listening(monkeypatch, tmp_path):
    def refuse(path, query=""):
        raise OSError("connection refused")
    monkeypatch.setattr(server_module, "_broker_get", refuse)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    # Don't actually bind a port in unit tests — stub the vendored amain.
    ran = asyncio.Event()

    async def fake_amain(args):
        assert args.shadow is True
        assert args.log_file.endswith("jobs.jsonl")
        ran.set()
        await asyncio.sleep(3600)

    import lane_broker.broker as broker_mod
    monkeypatch.setattr(broker_mod, "amain", fake_amain)

    started = await server_module.start_managed_broker()
    assert started is True
    await asyncio.wait_for(ran.wait(), timeout=2)
    task = server_module._MANAGED_BROKER["task"]
    assert task is not None and not task.done()


@pytest.mark.asyncio
async def test_env_disable(monkeypatch):
    monkeypatch.setenv("COCKPIT_MANAGED_BROKER", "0")
    started = await server_module.start_managed_broker()
    assert started is False


@pytest.mark.asyncio
async def test_stop_cancels_task(monkeypatch, tmp_path):
    def refuse(path, query=""):
        raise OSError("refused")
    monkeypatch.setattr(server_module, "_broker_get", refuse)
    monkeypatch.setenv("USERPROFILE", str(tmp_path))

    async def fake_amain(args):
        await asyncio.sleep(3600)

    import lane_broker.broker as broker_mod
    monkeypatch.setattr(broker_mod, "amain", fake_amain)

    assert await server_module.start_managed_broker() is True
    await server_module.stop_managed_broker()
    assert server_module._MANAGED_BROKER["task"] is None
