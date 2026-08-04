"""Tests for the local provider proxy routes.

Covers the metrics window validation, the provider registry's wire shape,
model normalisation, health aggregation and the capability 404s.

**THE QUEUE / STATUS / TRACES TESTS ARE DELETED, NOT SKIPPED (T11).** The
lane broker was the only thing that ever served /queue, /traces, /trace and
the service-identity fingerprint behind GET /api/local/status; all four
routes are gone, so a test for them would be pinning a promise nothing makes.

The provider itself is never contacted — server._broker_get is monkeypatched.
Uses httpx AsyncClient + ASGITransport, matching the existing test pattern.
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
async def test_lmstudio_has_no_metrics_capability_after_broker_removal(client):
    """T11: /metrics for LM Studio was the BROKER's aggregate over its own
    jobs.jsonl. LM Studio serves no such route, so the capability is gone and
    the honest answer is 404 `capability not available` -- NOT a 200 with
    zeros, and not a 503 pretending something is merely unreachable."""
    res = await client.get("/api/local/lmstudio-local/metrics")
    assert res.status_code == 404
    assert res.json()["error"] == "capability not available"


@pytest.mark.asyncio
async def test_metrics_proxies_and_forwards_window(client, monkeypatch):
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["path"] = path
        seen["query"] = query
        return {"runs_total": 10, "prompts_total": 8, "window": "24h"}

    monkeypatch.setattr(server_module, "_vllm_metrics_persisted",
                        lambda base, window: fake_get("/metrics", f"window={window}", base))
    res = await client.get("/api/local/vllm-local/metrics?window=24h")
    assert res.status_code == 200
    assert res.json()["runs_total"] == 10
    assert seen["path"] == "/metrics"
    assert seen["query"] == "window=24h"


@pytest.mark.asyncio
async def test_metrics_invalid_window_400_not_forwarded(client, monkeypatch):
    called = {"n": 0}

    def fake_get(path, query="", base_url=None):
        called["n"] += 1
        return {}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/vllm-local/metrics?window=../etc/passwd")
    assert res.status_code == 400
    assert called["n"] == 0  # never forwarded to the provider


@pytest.mark.asyncio
async def test_metrics_defaults_to_lifetime(client, monkeypatch):
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["query"] = query
        return {"runs_total": 0}

    monkeypatch.setattr(server_module, "_vllm_metrics_persisted",
                        lambda base, window: fake_get("/metrics", f"window={window}", base))
    res = await client.get("/api/local/vllm-local/metrics")
    assert res.status_code == 200
    assert seen["query"] == "window=lifetime"


# ---------------------------------------------------------------------------
# Service identity / shape validation — the "200 anyway" defense
# ---------------------------------------------------------------------------

# LM Studio's dev server answers unknown endpoints with 200 + an error body.
_LMSTUDIO_GARBAGE = {"error": "Unexpected endpoint or method."}


@pytest.mark.asyncio
async def test_metrics_garbage_200_returns_502_not_data(client, monkeypatch):
    monkeypatch.setattr(server_module, "_vllm_metrics_persisted",
                        lambda base, window: _LMSTUDIO_GARBAGE)
    monkeypatch.setattr(server_module, "_vllm_offline_snapshot", lambda: None)
    res = await client.get("/api/local/vllm-local/metrics")
    assert res.status_code == 502
    assert res.json()["compatible"] is False


@pytest.mark.asyncio
async def test_providers_list_shape_no_urls(client, vllm_ownership):
    # Pin the vLLM ownership state so the expected capability list does not
    # depend on the developer's own COCKPIT_MANAGED_VLLM (read at import).
    vllm_ownership("0")
    res = await client.get("/api/local/providers")
    assert res.status_code == 200
    body = res.json()
    # Both "model-control" advertisements are CONDITIONAL: LM Studio's on the
    # `lms` CLI being on PATH, vLLM's on Cockpit owning the container. With
    # COCKPIT_MANAGED_VLLM=0 the restart route always refuses, so the capability
    # must be absent rather than lying to the UI.
    # T11: `queue`, `metrics` and `traces` were all BROKER-served and are gone.
    lms_caps = ["models", "health"]
    if server_module._LMS_CLI:
        lms_caps.append("model-control")
    # Keyed by id, not positional: `vllm-local` is deregistered at import
    # unless a direct vLLM is declared (conftest puts it back for the suite),
    # so registration ORDER is no longer a fact worth pinning — its presence
    # and its shape are.
    by_id = {p["id"]: p for p in body["providers"]}
    assert by_id["lmstudio-local"] == {
        "id": "lmstudio-local",
        "label": "LM Studio (local)",
        "kind": "lmstudio",
        "scope": "local",
        "capabilities": lms_caps,
        "endpoint_hint": "127.0.0.1:1234",
        # LM Studio is somebody else's process and always was; the broker was
        # the only thing Studio ever managed at this address.
        "managed": False,
    }
    assert by_id["vllm-local"] == {
        "id": "vllm-local",
        "label": "vLLM (local)",
        "kind": "vllm",
        "scope": "local",
        "capabilities": ["models", "health", "metrics", "model-discovery"],
        "endpoint_hint": "127.0.0.1:8001",
        "managed": False,
    }
    # Plexar is the vLLM face: a fixed-bind gateway that owns container
    # lifecycle. No "model-control" (Cockpit does not own its containers). "timeseries" is
    # bucketed history, which the "reports" totals cannot provide.
    assert by_id["plexar-vllm"] == {
        "id": "plexar-vllm",
        "label": "Plexar-vLLM",
        "kind": "plexar",
        "scope": "local",
        "capabilities": ["models", "health", "instances", "reports", "gpus",
                         "timeseries", "model-control", "identity"],
        "endpoint_hint": "127.0.0.1:8760",
        "managed": False,
    }
    dumped = str(body)
    # SSRF stance: local providers may expose a display-only host:port
    # (endpoint_hint) so the user knows where to boot the service, but the FULL
    # url, scheme, auth, and the raw url keys must never reach the browser.
    assert "http://" not in dumped and "https://" not in dumped
    assert "auth" not in dumped
    assert "broker_url" not in dumped and "management_url" not in dumped


@pytest.mark.asyncio
async def test_provider_metrics_happy_path(client, monkeypatch):
    monkeypatch.setattr(server_module, "_vllm_metrics_persisted",
                        lambda base, window: {"runs_total": 3, "prompts_total": 3})
    res = await client.get("/api/local/vllm-local/metrics?window=24h")
    assert res.status_code == 200
    assert res.json()["runs_total"] == 3


@pytest.mark.asyncio
async def test_provider_capability_absent_404(client, monkeypatch):
    limited = dict(server_module._PROVIDERS["lmstudio-local"])
    limited["capabilities"] = ["health"]
    monkeypatch.setitem(server_module._PROVIDERS, "lmstudio-local", limited)
    res = await client.get("/api/local/lmstudio-local/models")
    assert res.status_code == 404
    assert res.json() == {"error": "capability not available"}


@pytest.mark.asyncio
async def test_unknown_provider_404(client):
    res = await client.get("/api/local/nope/models")
    assert res.status_code == 404
    assert res.json() == {"error": "unknown provider"}


@pytest.mark.asyncio
async def test_provider_models_normalization(client, monkeypatch):
    def fake_mgmt_get(provider, path):
        assert path == "/api/v0/models"
        return {"data": [
            {"id": "qwen3", "type": "llm", "arch": "qwen3", "quantization": "q4",
             "state": "loaded", "max_context_length": 8192, "loaded_context_length": 4096},
            {"id": "sparse-model"},  # missing fields -> null
        ]}

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)
    res = await client.get("/api/local/lmstudio-local/models")
    assert res.status_code == 200
    body = res.json()
    assert body["reachable"] is True
    assert body["models"][0]["id"] == "qwen3"
    assert body["models"][1] == {
        "id": "sparse-model", "type": None, "arch": None, "quantization": None,
        "state": None, "max_context_length": None, "loaded_context_length": None,
        "container_path": None, "name": None, "host_path": None,
        # Plexar addresses load/unload by instance; null for every other
        # backend, and present rather than absent so the shape stays uniform.
        "instance_id": None,
    }


@pytest.mark.asyncio
async def test_provider_models_unreachable_503(client, monkeypatch):
    def fake_mgmt_get(provider, path):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)
    res = await client.get("/api/local/lmstudio-local/models")
    assert res.status_code == 503
    assert res.json() == {"reachable": False, "reason": "unreachable"}


@pytest.mark.asyncio
async def test_provider_health_aggregates_both_probes(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        assert path == "/queue"
        return {"queued": []}

    def fake_mgmt_get(provider, path):
        assert path == "/api/v0/models"
        return {"data": [
            {"id": "a", "state": "loaded"},
            {"id": "b", "state": "not-loaded"},
        ]}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)
    res = await client.get("/api/local/lmstudio-local/health")
    assert res.status_code == 200
    body = res.json()
    # T11: nothing is broker-probed any more, so `broker` is permanently
    # not-applicable for EVERY provider and `ok` is purely the provider's own
    # reachability. The key is kept rather than dropped because
    # `applicable: false` already said "there is no broker here" -- which is
    # now simply true everywhere.
    assert body == {
        "broker": {"applicable": False, "reachable": None},
        "provider": {"reachable": True, "models_loaded": 1},
        "ok": True,
    }


@pytest.mark.asyncio
async def test_provider_health_both_down(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        raise OSError("down")

    def fake_mgmt_get(provider, path):
        raise OSError("down")

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)
    res = await client.get("/api/local/lmstudio-local/health")
    assert res.status_code == 200
    body = res.json()
    assert body["broker"] == {"applicable": False, "reachable": None}
    assert body["provider"] == {"reachable": False, "models_loaded": 0}
    assert body["ok"] is False


@pytest.mark.asyncio
async def test_legacy_metrics_404s_because_the_default_provider_lost_it(client):
    """The legacy un-keyed route delegates to the DEFAULT provider, which is
    LM Studio -- and LM Studio's /metrics was the broker's aggregate (T11).
    The route still exists and still delegates; what changed is that the
    provider behind it no longer promises metrics, so it answers the same
    honest 404 the keyed route does rather than 200 with nothing in it."""
    res = await client.get("/api/local/metrics")
    assert res.status_code == 404
    assert res.json()["error"] == "capability not available"


def test_providers_file_rejects_unsafe_scheme(tmp_path):
    bad_file = tmp_path / "providers.json"
    bad_file.write_text(
        '{"providers": [{"id": "evil", "label": "Evil", "kind": "lmstudio", '
        '"scope": "local", "broker_url": "file:///etc/passwd", "capabilities": ["queue"]}]}',
        encoding="utf-8",
    )
    result = server_module._load_providers_from_file(str(bad_file))
    assert result is None
    # the default registry stays untouched
    assert "lmstudio-local" in server_module._PROVIDERS
    assert server_module._PROVIDERS["lmstudio-local"]["broker_url"].startswith("http")

