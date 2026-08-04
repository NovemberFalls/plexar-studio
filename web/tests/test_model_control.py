"""Tests for the local model-control routes (load / unload / vLLM restart).

No real `lms` CLI, docker, or LM Studio is contacted — the subprocess spawn and
the managed-vLLM lifecycle helpers are monkeypatched. Uses httpx AsyncClient +
ASGITransport, matching the existing local-route test pattern.
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
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.fixture()
def lms_available(monkeypatch):
    """Pretend the `lms` CLI is present and lmstudio advertises model-control."""
    monkeypatch.setattr(server_module, "_LMS_CLI", "/usr/bin/lms")
    caps = server_module._PROVIDERS["lmstudio-local"]["capabilities"]
    added = "model-control" not in caps
    if added:
        caps.append("model-control")
    yield
    if added:
        caps.remove("model-control")


class _FakeProc:
    def __init__(self, returncode=0):
        self.returncode = returncode

    async def communicate(self):
        return (b"", b"")


# ── LM Studio load ────────────────────────────────────────

@pytest.mark.asyncio
async def test_load_kicks_off_and_returns_loading(client, lms_available, monkeypatch):
    calls = []

    async def fake_bg(model_id):
        calls.append(model_id)

    monkeypatch.setattr(server_module, "_lms_load_bg", fake_bg)
    async with client as c:
        r = await c.post("/api/local/lmstudio-local/models/qwen%2Fq3/load")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["status"] == "loading"
    assert body["model"] == "qwen/q3"


@pytest.mark.asyncio
async def test_load_unknown_provider_404(client, lms_available):
    async with client as c:
        r = await c.post("/api/local/nope/models/x/load")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_load_capability_missing_404(client, monkeypatch):
    # lms CLI absent → lmstudio does not advertise model-control.
    monkeypatch.setattr(server_module, "_LMS_CLI", None)
    caps = server_module._PROVIDERS["lmstudio-local"]["capabilities"]
    had = "model-control" in caps
    if had:
        caps.remove("model-control")
    try:
        async with client as c:
            r = await c.post("/api/local/lmstudio-local/models/x/load")
        assert r.status_code == 404
    finally:
        if had:
            caps.append("model-control")


@pytest.mark.asyncio
async def test_load_on_external_vllm_returns_404_no_capability(client, vllm_ownership):
    """An external vLLM does not advertise model-control at all, so the request
    is refused by the capability gate before any vLLM-specific branch."""
    vllm_ownership("0")
    async with client as c:
        r = await c.post("/api/local/vllm-local/models/x/load")
    assert r.status_code == 404
    assert r.json() == {"error": "capability not available"}


@pytest.mark.asyncio
async def test_load_on_managed_vllm_returns_409_pointing_at_restart(client, vllm_ownership):
    """Even when Cockpit owns the container there is no hot-load; the 409 has to
    name the mechanism that DOES work."""
    vllm_ownership("1")
    async with client as c:
        r = await c.post("/api/local/vllm-local/models/x/load")
    assert r.status_code == 409
    assert "restart" in r.json()["error"]


@pytest.mark.asyncio
async def test_unload_on_managed_vllm_returns_409(client, vllm_ownership):
    vllm_ownership("1")
    async with client as c:
        r = await c.post("/api/local/vllm-local/models/x/unload")
    assert r.status_code == 409
    assert "one model per process" in r.json()["error"]


@pytest.mark.asyncio
async def test_load_invalid_model_id_400(client, lms_available):
    async with client as c:
        r = await c.post("/api/local/lmstudio-local/models/-bad%20id/load")
    assert r.status_code == 400


# ── LM Studio unload ──────────────────────────────────────

@pytest.mark.asyncio
async def test_unload_ok(client, lms_available, monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _FakeProc(0)

    monkeypatch.setattr(server_module.asyncio, "create_subprocess_exec", fake_exec)
    async with client as c:
        r = await c.post("/api/local/lmstudio-local/models/qwen%2Fq3/unload")
    assert r.status_code == 200 and r.json()["ok"] is True


@pytest.mark.asyncio
async def test_unload_cli_failure_502(client, lms_available, monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _FakeProc(1)

    monkeypatch.setattr(server_module.asyncio, "create_subprocess_exec", fake_exec)
    async with client as c:
        r = await c.post("/api/local/lmstudio-local/models/q/unload")
    assert r.status_code == 502


# ── vLLM restart ──────────────────────────────────────────

@pytest.fixture()
def managed_vllm(monkeypatch, vllm_ownership):
    # Ownership drives BOTH the capability and the route's refusal, so flip it
    # through the same helper the startup path uses.
    vllm_ownership("1")
    stops, starts = [], []

    async def fake_stop():
        stops.append(server_module._vllm_runtime_model)

    async def fake_start():
        starts.append(server_module._vllm_runtime_model)
        return True

    monkeypatch.setattr(server_module, "stop_managed_vllm", fake_stop)
    monkeypatch.setattr(server_module, "start_managed_vllm", fake_start)
    return stops, starts


@pytest.mark.asyncio
async def test_restart_managed_stops_then_starts_with_new_model(client, managed_vllm, monkeypatch):
    stops, starts = managed_vllm
    original = server_module._vllm_runtime_model
    try:
        async with client as c:
            r = await c.post("/api/local/vllm-local/restart", json={"model": "/models/Qwen3-New"})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "status": "restarting", "model": "/models/Qwen3-New"}
        # runtime model was rewritten, and stop happened before start, both with new model
        assert server_module._vllm_runtime_model == "/models/Qwen3-New"
        assert stops == ["/models/Qwen3-New"] and starts == ["/models/Qwen3-New"]
        # the docker argv now carries the new model
        argv = server_module._vllm_docker_argv("run")
        assert any("/models/Qwen3-New" in part for part in argv)
    finally:
        server_module._vllm_runtime_model = original


@pytest.mark.asyncio
async def test_restart_unmanaged_409(client, vllm_ownership):
    vllm_ownership("0")
    async with client as c:
        r = await c.post("/api/local/vllm-local/restart", json={"model": "/models/x"})
    assert r.status_code == 409
    body = r.json()
    # The refusal must be ACTIONABLE: name the env var that enables it, say why
    # a restart is the only mechanism, and say where to do it instead.
    assert body["managed"] is False
    assert "COCKPIT_MANAGED_VLLM" in body["error"]
    assert "hot-swap" in body["error"]
    assert "where you started it" in body["error"]


@pytest.mark.asyncio
async def test_restart_external_double_bind_409(client, vllm_ownership):
    """Opted in via env but something else is already serving -> still refuse.

    The refusal must name the ACTUAL cause. Telling this user to set
    COCKPIT_MANAGED_VLLM=1 would be useless advice -- they already did, and the
    external process is what is in the way -- so the env var survives as the
    machine-readable `env` field while the prose points at the real blocker.
    """
    vllm_ownership("1", external=True)
    async with client as c:
        r = await c.post("/api/local/vllm-local/restart", json={"model": "/models/x"})
    assert r.status_code == 409
    body = r.json()
    assert body["env"] == "COCKPIT_MANAGED_VLLM"
    assert "external vLLM is already answering" in body["error"]
    assert "where you started it" in body["error"]
    assert body["ownership"]["external"] is True
    assert body["ownership"]["pending_restart"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["foo; rm -rf /", "a b", "$(x)", "a|b", "`id`", ""])
async def test_restart_rejects_malicious_model_and_does_not_cycle(client, managed_vllm, bad):
    stops, starts = managed_vllm
    original = server_module._vllm_runtime_model
    async with client as c:
        r = await c.post("/api/local/vllm-local/restart", json={"model": bad})
    assert r.status_code == 400
    # nothing was stopped/started and the runtime model is untouched
    assert stops == [] and starts == []
    assert server_module._vllm_runtime_model == original
