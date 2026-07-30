"""vLLM ownership precedence and the ownership surface.

The bug this covers: Settings ▸ Providers ▸ vLLM rendered a "Managed by Cockpit"
toggle that wrote providers.vllm.managed to settings.json, and NOTHING read that
key -- ownership came from COCKPIT_MANAGED_VLLM alone. The owner flipped it,
saved, and nothing changed, with no explanation anywhere.

Precedence now (see server._vllm_managed_intent):
  1. COCKPIT_MANAGED_VLLM when explicitly set -- wins outright, either way.
  2. else settings.json providers.vllm.managed.
  3. the startup double-bind verdict overrides BOTH: if something external is
     already answering, Cockpit is not the owner no matter what config says.
"""
from __future__ import annotations

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


@pytest.fixture
def ownership(monkeypatch):
    """Set (env, settings.json, external) and re-sync the capability list.

    Restores the capability list, the external verdict and the memoized setting,
    because all three are module state that would otherwise leak between tests.
    """
    caps = server_module._PROVIDERS["vllm-local"]["capabilities"]
    caps_snapshot = list(caps)
    external_snapshot = server_module._MANAGED_VLLM.get("external", False)

    def apply(env, setting: bool, external: bool = False):
        monkeypatch.setattr(server_module, "COCKPIT_MANAGED_VLLM", env)
        monkeypatch.setattr(
            server_module.settings_store,
            "read_settings",
            lambda: {"providers": {"vllm": {"managed": setting}}},
        )
        server_module._reset_vllm_managed_cache()
        server_module._MANAGED_VLLM["external"] = external
        server_module._refresh_vllm_model_control()

    yield apply

    caps[:] = caps_snapshot
    server_module._MANAGED_VLLM["external"] = external_snapshot
    server_module._reset_vllm_managed_cache()


def _has_model_control() -> bool:
    return "model-control" in server_module._PROVIDERS["vllm-local"]["capabilities"]


# ── precedence ────────────────────────────────────────────

def test_settings_toggle_alone_makes_cockpit_the_owner(ownership):
    """The reported bug, inverted: env unset + toggle on -> managed."""
    ownership(None, True)
    assert server_module._vllm_is_managed() is True
    assert _has_model_control() is True


def test_settings_toggle_off_is_not_managed(ownership):
    ownership(None, False)
    assert server_module._vllm_is_managed() is False
    assert _has_model_control() is False


def test_env_zero_beats_settings_true(ownership):
    """An operator who exported COCKPIT_MANAGED_VLLM=0 means it."""
    ownership("0", True)
    assert server_module._vllm_is_managed() is False
    assert _has_model_control() is False


def test_env_one_beats_settings_false(ownership):
    """Unchanged meaning for anyone already relying on COCKPIT_MANAGED_VLLM=1."""
    ownership("1", False)
    assert server_module._vllm_is_managed() is True
    assert _has_model_control() is True


def test_empty_env_string_is_treated_as_unset(ownership):
    ownership("", True)
    assert server_module._vllm_is_managed() is True


@pytest.mark.parametrize("env,setting", [(None, True), ("1", True), ("1", False)])
def test_external_overrides_every_config_source(ownership, env, setting):
    ownership(env, setting, external=True)
    assert server_module._vllm_is_managed() is False
    assert _has_model_control() is False


def test_unreadable_settings_falls_back_to_off(monkeypatch, ownership):
    ownership(None, False)

    def boom():
        raise OSError("no settings file")

    monkeypatch.setattr(server_module.settings_store, "read_settings", boom)
    server_module._reset_vllm_managed_cache()
    assert server_module._vllm_is_managed() is False


def test_setting_is_memoized_so_capabilities_cannot_go_stale(monkeypatch, ownership):
    """A settings save mid-process must NOT silently flip effective ownership --
    nothing re-runs _refresh_vllm_model_control() on a write, so a live read
    would leave the capability list disagreeing with _vllm_is_managed()."""
    ownership(None, False)
    assert server_module._vllm_is_managed() is False
    monkeypatch.setattr(
        server_module.settings_store,
        "read_settings",
        lambda: {"providers": {"vllm": {"managed": True}}},
    )
    assert server_module._vllm_is_managed() is False
    assert _has_model_control() is False
    # ...but the ownership surface reads live, so it can report the pending save.
    assert server_module._vllm_ownership()["pending_restart"] is True


# ── the ownership surface: three distinct states ──────────

@pytest.mark.asyncio
async def test_ownership_settled_managed(client, ownership):
    ownership(None, True)
    async with client as c:
        r = await c.get("/api/local/vllm/ownership")
    body = r.json()
    assert r.status_code == 200
    assert body["effective"] is True
    assert body["configured"] is True
    assert body["external"] is False
    assert body["source"] == "settings"
    assert body["pending_restart"] is False


@pytest.mark.asyncio
async def test_ownership_pending_restart(client, monkeypatch, ownership):
    """Toggle just flipped on: saved, real, dormant until Cockpit restarts."""
    ownership(None, False)
    monkeypatch.setattr(
        server_module.settings_store,
        "read_settings",
        lambda: {"providers": {"vllm": {"managed": True}}},
    )
    async with client as c:
        r = await c.get("/api/local/vllm/ownership")
    body = r.json()
    assert body["effective"] is False
    assert body["configured"] is True
    assert body["external"] is False
    assert body["pending_restart"] is True
    assert body["requires_restart"] is True
    assert "restarts" in body["reason"]


@pytest.mark.asyncio
async def test_ownership_external_is_not_pending_restart(client, ownership):
    """Distinct from pending: a restart will NOT make this real."""
    ownership(None, True, external=True)
    async with client as c:
        r = await c.get("/api/local/vllm/ownership")
    body = r.json()
    assert body["effective"] is False
    assert body["configured"] is True
    assert body["external"] is True
    assert body["source"] == "external"
    assert body["pending_restart"] is False
    assert "external vLLM" in body["reason"]


@pytest.mark.asyncio
async def test_ownership_source_env_when_env_set(client, ownership):
    ownership("1", False)
    async with client as c:
        r = await c.get("/api/local/vllm/ownership")
    body = r.json()
    assert body["source"] == "env"
    assert body["env_set"] is True


@pytest.mark.asyncio
async def test_providers_managed_flag_follows_settings_toggle(client, ownership):
    ownership(None, True)
    async with client as c:
        r = await c.get("/api/local/providers")
    vllm = [p for p in r.json()["providers"] if p["id"] == "vllm-local"][0]
    assert vllm["managed"] is True
    assert "model-control" in vllm["capabilities"]


# ── the refusal names the right cause ─────────────────────

@pytest.mark.asyncio
async def test_restart_refusal_points_at_the_toggle_when_off(client, ownership):
    ownership(None, False)
    async with client as c:
        r = await c.post("/api/local/vllm-local/restart", json={"model": "/models/x"})
    assert r.status_code == 409
    body = r.json()
    assert "Managed by Cockpit" in body["error"]
    assert "COCKPIT_MANAGED_VLLM=1" in body["error"]
    assert body["ownership"]["pending_restart"] is False


@pytest.mark.asyncio
async def test_restart_refusal_says_restart_cockpit_when_pending(client, monkeypatch, ownership):
    ownership(None, False)
    monkeypatch.setattr(
        server_module.settings_store,
        "read_settings",
        lambda: {"providers": {"vllm": {"managed": True}}},
    )
    async with client as c:
        r = await c.post("/api/local/vllm-local/restart", json={"model": "/models/x"})
    assert r.status_code == 409
    body = r.json()
    assert "restart Cockpit first" in body["error"]
    assert body["ownership"]["pending_restart"] is True


# ── the container actually launches from the toggle ───────

@pytest.mark.asyncio
async def test_start_managed_vllm_honours_the_settings_toggle(monkeypatch, ownership):
    """The whole point: the stored toggle must reach the launcher."""
    ownership(None, True)
    server_module._MANAGED_VLLM["proc"] = None

    def _no_server(*_a, **_kw):
        raise RuntimeError("nothing listening")

    monkeypatch.setattr(server_module, "_broker_get", _no_server)
    proc = AsyncMock()
    proc.communicate = AsyncMock(return_value=(b"", b""))
    exec_mock = AsyncMock(return_value=proc)
    monkeypatch.setattr(server_module.asyncio, "create_subprocess_exec", exec_mock)
    try:
        assert await server_module.start_managed_vllm() is True
        assert exec_mock.await_count == 1
    finally:
        server_module._MANAGED_VLLM["proc"] = None


@pytest.mark.asyncio
async def test_start_managed_vllm_still_refuses_when_env_says_zero(monkeypatch, ownership):
    ownership("0", True)
    server_module._MANAGED_VLLM["proc"] = None
    exec_mock = AsyncMock()
    monkeypatch.setattr(server_module.asyncio, "create_subprocess_exec", exec_mock)
    assert await server_module.start_managed_vllm() is False
    assert exec_mock.await_count == 0
