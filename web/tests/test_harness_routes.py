"""The /api/harness/* routes and /ws/harness, over a FAKE runtime (no node)."""
from __future__ import annotations

import asyncio
import json
import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

import logging_config  # noqa: E402
logging_config.setup("WARNING")

import harness_manager as hm  # noqa: E402
import server  # noqa: E402
import settings_store  # noqa: E402
from test_harness_manager import FakeRuntime  # noqa: E402

KEY = "plx_route_SECRET_key"


@pytest.fixture
def setup(monkeypatch, tmp_path):
    # The developer's own PLEXAR_HARNESS_KEY must not leak into these tests.
    monkeypatch.delenv("PLEXAR_HARNESS_KEY", raising=False)
    monkeypatch.delenv("COCKPIT_PLEXAR_URL", raising=False)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(hm, "_labels_path", lambda: tmp_path / "harness_labels.json")
    monkeypatch.setattr(hm, "_models_cache_path", lambda: tmp_path / "harness_models_cache.json")
    monkeypatch.setattr(hm, "_harness_settings", lambda: {"permission_mode": "workspace-write", "root": ""})
    monkeypatch.setattr(hm, "_node_version", lambda: "v22.19.0")
    mgr = hm.HarnessManager(runtime_factory=FakeRuntime)
    monkeypatch.setattr(server, "harness_manager", mgr)
    monkeypatch.setattr(hm, "_last_config_options", None)
    FakeRuntime.instances.clear()
    FakeRuntime.instances_pending_config = None
    ws = tmp_path / "ws"
    ws.mkdir()
    client = AsyncClient(transport=ASGITransport(app=server.app), base_url="http://127.0.0.1:8420")
    return client, mgr, str(ws)


@pytest.mark.asyncio
async def test_key_never_returned(setup):
    client, mgr, ws = setup
    r = await client.get("/api/harness/status")
    assert r.status_code == 200 and r.json()["key_set"] is False
    assert set(r.json()) == {"key_set", "key_source", "launcher", "node_version", "node_ok", "permission_mode",
                              "rig_url", "rig_url_source"}
    r = await client.put("/api/harness/key", json={"key": KEY})
    assert r.json() == {"key_set": True}
    bodies = [r.text]
    r = await client.get("/api/harness/status")
    assert r.json()["key_set"] is True and r.json()["node_ok"] is True
    bodies.append(r.text)
    r = await client.post("/api/harness/sessions", json={"workspace": ws, "label": "L"})
    bodies.append(r.text)
    r = await client.get("/api/harness/sessions", params={"workspace": ws})
    bodies.append(r.text)
    assert all(KEY not in b for b in bodies)
    r = await client.delete("/api/harness/key")
    assert r.json() == {"key_set": False, "key_source": None}
    await mgr.stop_all()


@pytest.mark.asyncio
async def test_start_without_key_is_502_key_missing(setup):
    client, _, ws = setup
    r = await client.post("/api/harness/sessions", json={"workspace": ws})
    assert r.status_code == 502
    assert r.json()["error"] == "key_missing" and r.json()["message"]
    assert FakeRuntime.instances == []


@pytest.mark.asyncio
async def test_relative_workspace_is_400(setup):
    client, _, _ = setup
    r = await client.get("/api/harness/sessions", params={"workspace": "rel/path"})
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_prompt_busy_409_and_flow(setup):
    client, mgr, ws = setup
    await client.put("/api/harness/key", json={"key": KEY})
    r = await client.post("/api/harness/sessions", json={"workspace": ws})
    sid = r.json()["session_id"]
    assert r.json()["config_options"] == [{"id": "model"}]
    FakeRuntime.instances[0].turn_gate.clear()
    r = await client.post(f"/api/harness/sessions/{sid}/prompt", json={"text": "hi"})
    assert r.status_code == 202 and r.json() == {"accepted": True}
    r = await client.post(f"/api/harness/sessions/{sid}/prompt", json={"text": "hi"})
    assert r.status_code == 409 and r.json() == {"error": "busy"}
    FakeRuntime.instances[0].turn_gate.set()
    for _ in range(300):
        if sid not in mgr._busy:
            break
        await asyncio.sleep(0.01)
    assert (await client.post(f"/api/harness/sessions/{sid}/cancel")).json() == {"ok": True}
    r = await client.post(f"/api/harness/sessions/{sid}/config", json={"config_id": "model", "value": "m"})
    assert r.status_code == 200
    assert (await client.put(f"/api/harness/sessions/{sid}/label", json={"label": "Named"})).json() == {"ok": True}
    rows = (await client.get("/api/harness/sessions", params={"workspace": ws})).json()["sessions"]
    assert any(x["session_id"] == sid and x["label"] == "Named" for x in rows)
    assert (await client.post(f"/api/harness/sessions/{sid}/close")).json() == {"ok": True}
    r = await client.post(f"/api/harness/sessions/{sid}/resume", json={"workspace": ws})
    assert r.json() == {"config_options": [{"id": "reasoning_effort"}]}
    await mgr.stop_all()


@pytest.mark.asyncio
async def test_permission_unknown_404(setup):
    client, _, _ = setup
    r = await client.post("/api/harness/permissions/nope", json={"option_id": "allow-once"})
    assert r.status_code == 404
    r = await client.post("/api/harness/permissions/nope", json={"option_id": "allow-always"})
    assert r.status_code == 400


FIXTURE_CONFIG_OPTIONS = json.load(
    open(os.path.join(os.path.dirname(__file__), "fixtures", "harness_config_options_live.json"), encoding="utf-8")
)["configOptions"]


@pytest.mark.asyncio
async def test_models_session_source_no_key_leak(setup):
    client, mgr, ws = setup
    await client.put("/api/harness/key", json={"key": KEY})
    FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
    r = await client.post("/api/harness/sessions", json={"workspace": ws})
    assert r.status_code == 200
    r = await client.get("/api/harness/models")
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "session"
    assert body["models"] == [{"id": "[\"plexar\",\"qwen3.8-27b\"]", "label": "Plexar Qwen",
                                "efforts": ["", "off", "high"]}]
    assert KEY not in r.text
    await mgr.stop_all()


@pytest.mark.asyncio
async def test_models_none_source_when_nothing_ever_observed(setup):
    client, _, _ = setup
    r = await client.get("/api/harness/models")
    assert r.status_code == 200
    body = r.json()
    assert body == {"source": "none", "models": []}


@pytest.mark.asyncio
async def test_sessions_applies_model_and_effort_drops_unoffered(setup):
    import logging

    client, mgr, ws = setup
    records: list[logging.LogRecord] = []

    class _Collector(logging.Handler):
        def emit(self, record):
            records.append(record)

    handler = _Collector()
    server.logger.addHandler(handler)
    try:
        await client.put("/api/harness/key", json={"key": KEY})
        FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
        r = await client.post("/api/harness/sessions",
                               json={"workspace": ws, "model": "[\"plexar\",\"qwen3.8-27b\"]", "effort": "bogus"})
    finally:
        server.logger.removeHandler(handler)
    assert r.status_code == 200
    sid = r.json()["session_id"]
    rt = FakeRuntime.instances[0]
    assert rt.set_option_calls == [(sid, "model", "[\"plexar\",\"qwen3.8-27b\"]")]  # effort dropped, never sent
    assert any("not offered" in rec.getMessage() for rec in records)
    await mgr.stop_all()


@pytest.mark.asyncio
async def test_sessions_applies_model_then_effort_in_order(setup):
    client, mgr, ws = setup
    await client.put("/api/harness/key", json={"key": KEY})
    FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
    r = await client.post("/api/harness/sessions",
                           json={"workspace": ws, "model": "[\"plexar\",\"qwen3.8-27b\"]", "effort": "high"})
    assert r.status_code == 200
    rt = FakeRuntime.instances[0]
    assert rt.set_option_calls == [
        (r.json()["session_id"], "model", "[\"plexar\",\"qwen3.8-27b\"]"),
        (r.json()["session_id"], "reasoning_effort", "high"),
    ]
    await mgr.stop_all()


@pytest.mark.asyncio
async def test_sessions_provider_default_effort_survives_as_real_value(setup):
    """effort == "" ("Provider default") must survive end to end: request body
    validation, _apply_initial_model_and_effort, and the set_config route --
    never dropped as falsy."""
    client, mgr, ws = setup
    await client.put("/api/harness/key", json={"key": KEY})
    FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
    r = await client.post("/api/harness/sessions",
                           json={"workspace": ws, "model": "[\"plexar\",\"qwen3.8-27b\"]", "effort": ""})
    assert r.status_code == 200
    rt = FakeRuntime.instances[0]
    assert rt.set_option_calls == [
        (r.json()["session_id"], "model", "[\"plexar\",\"qwen3.8-27b\"]"),
        (r.json()["session_id"], "reasoning_effort", ""),
    ]
    await mgr.stop_all()


@pytest.mark.asyncio
async def test_config_route_accepts_empty_string_value(setup):
    client, mgr, ws = setup
    await client.put("/api/harness/key", json={"key": KEY})
    r = await client.post("/api/harness/sessions", json={"workspace": ws})
    sid = r.json()["session_id"]
    r = await client.post(f"/api/harness/sessions/{sid}/config",
                           json={"config_id": "reasoning_effort", "value": ""})
    assert r.status_code == 200
    rt = FakeRuntime.instances[0]
    assert rt.set_option_calls == [(sid, "reasoning_effort", "")]
    await mgr.stop_all()


@pytest.mark.asyncio
async def test_status_rig_url_source_tiers(setup, monkeypatch):
    client, _, _ = setup
    r = await client.get("/api/harness/status")
    assert r.json()["rig_url_source"] == "plexar_provider"  # loopback default, tier 2

    monkeypatch.setattr(hm, "_harness_settings",
                        lambda: {"permission_mode": "workspace-write", "root": "",
                                 "rig_url": "https://explicit.example.com"})
    r = await client.get("/api/harness/status")
    assert r.json()["rig_url_source"] == "harness"  # tier 1


def test_ws_refuses_foreign_origin(setup):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    _, _, ws = setup
    client = TestClient(server.app, base_url="http://127.0.0.1:8420")
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/harness?workspace={ws}",
                                      headers={"origin": "https://evil.example"}):
            pass
