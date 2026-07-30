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
    # "external" and the capability list are mutated by start_managed_vllm now
    # (ownership decides whether "model-control" is advertised), so both must be
    # restored or the lifecycle tests leak state into the registry tests.
    caps = server_module._PROVIDERS["vllm-local"]["capabilities"]
    caps_snapshot = list(caps)
    server_module._MANAGED_VLLM["proc"] = None
    server_module._MANAGED_VLLM["external"] = False
    server_module.COCKPIT_MANAGED_VLLM = "0"
    yield
    server_module._MANAGED_VLLM["proc"] = None
    server_module._MANAGED_VLLM["external"] = False
    server_module.COCKPIT_MANAGED_VLLM = "0"
    caps[:] = caps_snapshot


def _fake_proc():
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(b"", b""))
    return proc


# ── Provider registry ─────────────────────────────────────

def test_vllm_local_provider_shape(vllm_ownership):
    vllm_ownership("0")
    provider = server_module._PROVIDERS["vllm-local"]
    assert provider["kind"] == "vllm"
    assert provider["scope"] == "local"
    # "model-control" is NOT in the base set -- it is appended only when Cockpit
    # owns the container (see the managed/external tests below).
    assert set(provider["capabilities"]) == {"models", "health", "metrics", "model-discovery"}
    for key in server_module._PROVIDER_REQUIRED_KEYS:
        assert key in provider


# ── model-control is conditional on ownership ─────────────


def test_model_control_absent_when_vllm_external(vllm_ownership):
    """The reported bug: COCKPIT_MANAGED_VLLM defaults to "0", so an
    unconditional "model-control" made the UI offer a restart the route always
    refused with 409."""
    vllm_ownership("0")
    assert server_module._vllm_is_managed() is False
    assert "model-control" not in server_module._PROVIDERS["vllm-local"]["capabilities"]


def test_model_control_present_when_vllm_managed(vllm_ownership):
    vllm_ownership("1")
    assert server_module._vllm_is_managed() is True
    assert "model-control" in server_module._PROVIDERS["vllm-local"]["capabilities"]


def test_model_control_dropped_when_external_wins_double_bind(vllm_ownership):
    """Opted in, but something else already answers on the port -> Cockpit is a
    pure observer and must not advertise control."""
    vllm_ownership("1", external=True)
    assert server_module._vllm_is_managed() is False
    assert "model-control" not in server_module._PROVIDERS["vllm-local"]["capabilities"]


def test_refresh_is_idempotent(vllm_ownership):
    vllm_ownership("1")
    server_module._refresh_vllm_model_control()
    server_module._refresh_vllm_model_control()
    caps = server_module._PROVIDERS["vllm-local"]["capabilities"]
    assert caps.count("model-control") == 1


@pytest.mark.asyncio
async def test_providers_managed_flag_follows_ownership(client, vllm_ownership):
    vllm_ownership("0")
    async with client as c:
        r = await c.get("/api/local/providers")
    vllm = [p for p in r.json()["providers"] if p["id"] == "vllm-local"][0]
    assert vllm["managed"] is False
    assert "model-control" not in vllm["capabilities"]


@pytest.mark.asyncio
async def test_providers_managed_flag_true_when_managed(client, vllm_ownership):
    vllm_ownership("1")
    async with client as c:
        r = await c.get("/api/local/providers")
    vllm = [p for p in r.json()["providers"] if p["id"] == "vllm-local"][0]
    assert vllm["managed"] is True
    assert "model-control" in vllm["capabilities"]


@pytest.mark.asyncio
async def test_providers_managed_flag_matches_status_for_broker(client):
    """The broker provider's `managed` must be the SAME determination
    /api/local/status reports -- never a second guess that can disagree."""
    async with client as c:
        providers = (await c.get("/api/local/providers")).json()["providers"]
    lms = [p for p in providers if p["id"] == "lmstudio-local"][0]
    assert lms["managed"] is server_module._broker_is_managed()


@pytest.mark.asyncio
async def test_providers_never_leak_urls_or_auth(client, vllm_ownership):
    """The `managed` boolean must not become a channel for URLs/auth."""
    vllm_ownership("1")
    async with client as c:
        body = (await c.get("/api/local/providers")).json()
    for p in body["providers"]:
        assert set(p) == {
            "id", "label", "kind", "scope", "capabilities", "endpoint_hint", "managed",
        }
        assert isinstance(p["managed"], bool)
    dumped = str(body)
    assert "http://" not in dumped and "https://" not in dumped
    assert "auth" not in dumped
    assert "broker_url" not in dumped and "management_url" not in dumped


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
    # The double-bind probe recorded that ownership went elsewhere, so the
    # capability is withdrawn even though the operator opted in.
    assert server_module._MANAGED_VLLM["external"] is True
    assert "model-control" not in server_module._PROVIDERS["vllm-local"]["capabilities"]


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
    # Cockpit owns it -> control is now honestly advertised.
    assert server_module._MANAGED_VLLM["external"] is False
    assert "model-control" in server_module._PROVIDERS["vllm-local"]["capabilities"]

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
