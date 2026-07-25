"""Tests for the managed vLLM lifecycle (server.start_managed_vllm/stop_managed_vllm)
and the vllm-local / lmstudio-local provider-registry entries.

Covers:
  1. vllm-local provider shape (kind/scope/capabilities/required keys).
  2. lmstudio-local still present; _DEFAULT_PROVIDER unchanged.
  3. COCKPIT_MANAGED_VLLM unset/"0" -> never launches a container.
  4. External vLLM already answering -> managed container NOT launched.
  5. Nothing listening -> subprocess launcher IS called; _MANAGED_VLLM tracks it.
  6. stop_managed_vllm: no-op when untracked; docker-rm + state clear when tracked.
  7. Launcher exceptions are swallowed -- start_managed_vllm returns False, never raises.
"""
from __future__ import annotations

import asyncio
import os
import sys
from unittest.mock import AsyncMock

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


@pytest.fixture(autouse=True)
def _clean_managed_vllm_state():
    server_module._MANAGED_VLLM["proc"] = None
    server_module.COCKPIT_MANAGED_VLLM = "0"
    yield
    server_module._MANAGED_VLLM["proc"] = None
    server_module.COCKPIT_MANAGED_VLLM = "0"


def _fake_proc():
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(b"", b""))
    return proc


# ── Provider registry ─────────────────────────────────────

def test_vllm_local_provider_shape():
    provider = server_module._PROVIDERS["vllm-local"]
    assert provider["kind"] == "vllm"
    assert provider["scope"] == "local"
    assert set(provider["capabilities"]) == {"models", "health"}
    for key in server_module._PROVIDER_REQUIRED_KEYS:
        assert key in provider


def test_lmstudio_local_still_default():
    assert "lmstudio-local" in server_module._PROVIDERS
    assert server_module._DEFAULT_PROVIDER == "lmstudio-local"


# ── Kind-aware model catalog path (vLLM uses /v1/models, not LM Studio's /api/v0/models) ──

def test_models_path_kind_aware():
    assert server_module._models_path({"kind": "lmstudio"}) == "/api/v0/models"
    assert server_module._models_path({"kind": "vllm"}) == "/v1/models"


@pytest.mark.asyncio
async def test_get_provider_models_uses_v1_for_vllm(client, monkeypatch):
    recorded = {}

    def fake_mgmt_get(provider, path):
        recorded["path"] = path
        return {"data": [{"id": "qwen3-coder-30b-awq"}]}

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)

    async with client as c:
        resp = await c.get("/api/local/vllm-local/models")

    assert resp.status_code == 200
    body = resp.json()
    assert body["reachable"] is True
    assert [m["id"] for m in body["models"]] == ["qwen3-coder-30b-awq"]
    assert recorded["path"] == "/v1/models"


@pytest.mark.asyncio
async def test_get_provider_models_uses_v0_for_lmstudio(client, monkeypatch):
    recorded = {}

    def fake_mgmt_get(provider, path):
        recorded["path"] = path
        return {"data": [{"id": "some-lmstudio-model"}]}

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)

    async with client as c:
        resp = await c.get("/api/local/lmstudio-local/models")

    assert resp.status_code == 200
    assert resp.json()["reachable"] is True
    assert recorded["path"] == "/api/v0/models"


# ── Lifecycle ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_env_disabled_never_launches(monkeypatch):
    server_module.COCKPIT_MANAGED_VLLM = "0"
    mock_exec = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", mock_exec)

    started = await server_module.start_managed_vllm()

    assert started is False
    mock_exec.assert_not_called()


@pytest.mark.asyncio
async def test_external_vllm_wins(monkeypatch):
    server_module.COCKPIT_MANAGED_VLLM = "1"
    monkeypatch.setattr(
        server_module, "_broker_get",
        lambda path, query="", base_url=None: {"data": []},
    )
    mock_exec = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", mock_exec)

    started = await server_module.start_managed_vllm()

    assert started is False
    mock_exec.assert_not_called()
    assert server_module._MANAGED_VLLM["proc"] is None


@pytest.mark.asyncio
async def test_nothing_listening_launches_container(monkeypatch):
    server_module.COCKPIT_MANAGED_VLLM = "1"

    def refuse(path, query="", base_url=None):
        raise OSError("connection refused")
    monkeypatch.setattr(server_module, "_broker_get", refuse)

    fake_proc = _fake_proc()
    mock_exec = AsyncMock(return_value=fake_proc)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", mock_exec)

    started = await server_module.start_managed_vllm()

    assert started is True
    mock_exec.assert_awaited_once()
    assert server_module._MANAGED_VLLM["proc"] is fake_proc

    call_args = mock_exec.await_args.args
    joined = " ".join(call_args)
    assert "--enable-auto-tool-choice" in joined
    assert "--tool-call-parser" in joined
    assert "qwen3_coder" in joined
    assert f"--max-model-len {server_module.COCKPIT_VLLM_MAX_MODEL_LEN}" in joined


@pytest.mark.asyncio
async def test_stop_noop_when_untracked(monkeypatch):
    server_module._MANAGED_VLLM["proc"] = None
    mock_exec = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", mock_exec)

    await server_module.stop_managed_vllm()

    mock_exec.assert_not_called()
    assert server_module._MANAGED_VLLM["proc"] is None


@pytest.mark.asyncio
async def test_stop_removes_tracked_container(monkeypatch):
    server_module._MANAGED_VLLM["proc"] = _fake_proc()

    fake_rm_proc = _fake_proc()
    mock_exec = AsyncMock(return_value=fake_rm_proc)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", mock_exec)

    await server_module.stop_managed_vllm()

    mock_exec.assert_awaited_once()
    assert server_module._MANAGED_VLLM["proc"] is None


@pytest.mark.asyncio
async def test_launcher_exception_is_swallowed(monkeypatch):
    server_module.COCKPIT_MANAGED_VLLM = "1"

    def refuse(path, query="", base_url=None):
        raise OSError("connection refused")
    monkeypatch.setattr(server_module, "_broker_get", refuse)

    async def boom(*args, **kwargs):
        raise RuntimeError("docker not found")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", boom)

    started = await server_module.start_managed_vllm()

    assert started is False
    assert server_module._MANAGED_VLLM["proc"] is None
