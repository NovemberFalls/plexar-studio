"""The surviving /api/harness/* routes (status, key, models), over a FAKE runtime (no node)."""
from __future__ import annotations

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
    monkeypatch.setattr(hm, "_known_path", lambda: tmp_path / "harness_sessions.json")
    monkeypatch.setattr(hm, "_models_cache_path", lambda: tmp_path / "harness_models_cache.json")
    monkeypatch.setattr(hm, "_harness_settings", lambda: {"permission_mode": "workspace-write", "root": ""})
    monkeypatch.setattr(hm, "_node_version", lambda: "v22.19.0")
    mgr = hm.HarnessManager(runtime_factory=FakeRuntime)
    monkeypatch.setattr(server, "harness_manager", mgr)
    monkeypatch.setattr(hm, "_last_config_options", None)
    monkeypatch.setattr(hm, "_last_config_at", None)
    monkeypatch.setattr(hm, "_probe_runtime_factory", FakeRuntime)
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
    assert all(KEY not in b for b in bodies)
    r = await client.delete("/api/harness/key")
    assert r.json() == {"key_set": False, "key_source": None}
    await mgr.stop_all()


FIXTURE_CONFIG_OPTIONS = json.load(
    open(os.path.join(os.path.dirname(__file__), "fixtures", "harness_config_options_live.json"), encoding="utf-8")
)["configOptions"]


@pytest.mark.asyncio
async def test_models_session_source_no_key_leak(setup):
    client, mgr, ws = setup
    await client.put("/api/harness/key", json={"key": KEY})
    FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
    # Empty cache + a key: the route runs ONE lazy probe, which is what fills it.
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
async def test_status_rig_url_source_tiers(setup, monkeypatch):
    client, _, _ = setup
    r = await client.get("/api/harness/status")
    assert r.json()["rig_url_source"] == "plexar_provider"  # loopback default, tier 2

    monkeypatch.setattr(hm, "_harness_settings",
                        lambda: {"permission_mode": "workspace-write", "root": "",
                                 "rig_url": "https://explicit.example.com"})
    r = await client.get("/api/harness/status")
    assert r.json()["rig_url_source"] == "harness"  # tier 1


@pytest.mark.asyncio
async def test_models_probe_is_lazy_once_and_cached(setup):
    client, _, _ = setup
    await client.put("/api/harness/key", json={"key": KEY})
    FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
    assert FakeRuntime.instances == []  # nothing probes until the route is asked
    await client.get("/api/harness/models")
    assert len(FakeRuntime.instances) == 1
    probe = FakeRuntime.instances[0]
    assert probe.started and probe.stopped
    assert probe.env["PLEXAR_HARNESS_KEY"] == KEY
    assert not os.path.exists(str(probe.workspace))  # temp dir removed
    # A fresh cache answers without a second probe.
    r = await client.get("/api/harness/models")
    assert r.json()["source"] == "session"
    assert len(FakeRuntime.instances) == 1


@pytest.mark.asyncio
async def test_models_probe_reruns_only_when_older_than_24h(setup, monkeypatch):
    client, _, _ = setup
    await client.put("/api/harness/key", json={"key": KEY})
    FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
    await client.get("/api/harness/models")
    assert len(FakeRuntime.instances) == 1
    monkeypatch.setattr(hm, "_last_config_at", hm._last_config_at - hm.PROBE_MAX_AGE_S + 60)
    await client.get("/api/harness/models")
    assert len(FakeRuntime.instances) == 1
    monkeypatch.setattr(hm, "_last_config_at", hm._last_config_at - 120)
    await client.get("/api/harness/models")
    assert len(FakeRuntime.instances) == 2


@pytest.mark.asyncio
async def test_models_probe_skipped_without_key(setup):
    client, _, _ = setup
    r = await client.get("/api/harness/models")
    assert r.json() == {"source": "none", "models": []}
    assert FakeRuntime.instances == []


def test_models_probe_never_runs_concurrently(setup):
    import threading

    hm.set_key(KEY)
    FakeRuntime.instances_pending_config = FIXTURE_CONFIG_OPTIONS
    gate, entered = threading.Event(), threading.Event()

    class SlowRuntime(FakeRuntime):
        def start(self):
            entered.set()
            gate.wait(5)
            return super().start()

    results = []
    t = threading.Thread(target=lambda: results.append(hm.probe_models_if_stale(SlowRuntime)))
    t.start()
    assert entered.wait(5)
    # A second caller while the first probe is in flight does not start another runtime.
    assert hm.probe_models_if_stale(SlowRuntime) is False
    assert len(FakeRuntime.instances) == 1
    gate.set()
    t.join(5)
    assert results == [True]


def test_models_probe_is_only_reached_from_the_models_route():
    """Never at startup: the probe's one call site is the /api/harness/models handler."""
    import ast

    src = open(os.path.join(os.path.dirname(__file__), "..", "server.py"), encoding="utf-8").read()
    owners = []
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for sub in ast.walk(node):
                if isinstance(sub, ast.Attribute) and sub.attr == "probe_models_if_stale":
                    owners.append(node.name)
    assert owners == ["harness_models"]
