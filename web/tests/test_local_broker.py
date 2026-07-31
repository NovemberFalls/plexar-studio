"""Tests for the local-lane broker proxy routes.

Covers:
  1. GET /api/local/queue proxies the broker JSON verbatim.
  2. GET /api/local/queue returns 503 {reachable: false} when the broker is down.
  3. GET /api/local/metrics proxies the broker JSON and forwards the window.
  4. GET /api/local/metrics rejects an invalid window with 400 (never forwarded).
  5. GET /api/local/metrics defaults to window=lifetime.
  6. POST /api/local/spill returns 501 (broker control endpoint not wired yet).

The broker itself is never contacted — server._broker_get is monkeypatched.
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
async def test_queue_proxies_broker_json(client, monkeypatch):
    # Pinned /queue shape (broker.py::_queue_state).
    payload = {
        "shadow": True,
        "in_flight": {"class": "workhorse", "elapsed_s": 1.0, "predicted_remaining_s": 9.0,
                      "model": "qwen/qwen3.6-27b", "client_id": "c1"},
        "queued": [{"class": "mundane", "position": 0, "predicted_wall_s": 12.0,
                    "waiting_s": 0.5, "model": "qwen/qwen3.6-27b", "client_id": "c2"}],
        "estimated_clear_seconds": 42.0,
    }

    def fake_get(path, query="", base_url=None):
        assert path == "/queue"
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/queue")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_queue_offline_returns_503(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/queue")
    assert res.status_code == 503
    assert res.json() == {"reachable": False}


@pytest.mark.asyncio
async def test_metrics_proxies_and_forwards_window(client, monkeypatch):
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["path"] = path
        seen["query"] = query
        return {"runs_total": 10, "prompts_total": 8, "window": "24h"}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/metrics?window=24h")
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
    res = await client.get("/api/local/metrics?window=../etc/passwd")
    assert res.status_code == 400
    assert called["n"] == 0  # never forwarded to the broker


@pytest.mark.asyncio
async def test_metrics_defaults_to_lifetime(client, monkeypatch):
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["query"] = query
        return {"runs_total": 0}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/metrics")
    assert res.status_code == 200
    assert seen["query"] == "window=lifetime"


@pytest.mark.asyncio
async def test_spill_get_proxies_broker(client, monkeypatch):
    payload = {
        "spill_thresholds_s": {"interactive": 30.0, "worker": 300.0, "batch": None},
        "spilled_total": 5,
        "spilled_by_class": {"interactive": 5},
        "persisted": False,
    }

    def fake_get(path, query="", base_url=None):
        assert path == "/config/spill"
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/spill")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_spill_put_forwards_partial_map(client, monkeypatch):
    seen = {}

    def fake_put(path, body, base_url=None):
        seen["path"] = path
        seen["body"] = body
        return {"spill_thresholds_s": {"interactive": 45, "worker": 300.0, "batch": None}}

    monkeypatch.setattr(server_module, "_broker_put", fake_put)
    res = await client.post("/api/local/spill", json={"interactive": 45})
    assert res.status_code == 200
    assert seen["path"] == "/config/spill"
    assert seen["body"] == {"interactive": 45}
    assert res.json()["spill_thresholds_s"]["interactive"] == 45


@pytest.mark.asyncio
async def test_spill_put_accepts_null_to_disable(client, monkeypatch):
    seen = {}

    def fake_put(path, body, base_url=None):
        seen["body"] = body
        return {"spill_thresholds_s": {"interactive": 30, "worker": 300, "batch": None}}

    monkeypatch.setattr(server_module, "_broker_put", fake_put)
    res = await client.post("/api/local/spill", json={"batch": None})
    assert res.status_code == 200
    assert seen["body"] == {"batch": None}


@pytest.mark.asyncio
async def test_spill_put_rejects_unknown_class_not_forwarded(client, monkeypatch):
    called = {"n": 0}

    def fake_put(path, body, base_url=None):
        called["n"] += 1
        return {}

    monkeypatch.setattr(server_module, "_broker_put", fake_put)
    res = await client.post("/api/local/spill", json={"gpu": 10})
    assert res.status_code == 400
    assert called["n"] == 0  # invalid class never reaches the broker


@pytest.mark.asyncio
async def test_spill_put_rejects_out_of_range(client, monkeypatch):
    called = {"n": 0}
    monkeypatch.setattr(server_module, "_broker_put", lambda path, body, base_url=None: called.__setitem__("n", called["n"] + 1) or {})
    res = await client.post("/api/local/spill", json={"interactive": 999999})
    assert res.status_code == 400
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_spill_put_rejects_empty_body(client):
    res = await client.post("/api/local/spill", json={})
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# Service identity / shape validation — the "200 anyway" defense
# ---------------------------------------------------------------------------

# LM Studio's dev server answers unknown endpoints with 200 + an error body.
_LMSTUDIO_GARBAGE = {"error": "Unexpected endpoint or method."}


@pytest.fixture(autouse=True)
def _reset_detect_cache():
    """Detection results are cached 30s — reset between tests."""
    server_module._detect_cache["result"] = None
    server_module._detect_cache["at"] = 0.0
    yield


@pytest.mark.asyncio
async def test_queue_garbage_200_returns_502_not_data(client, monkeypatch):
    monkeypatch.setattr(server_module, "_broker_get", lambda path, query="", base_url=None: _LMSTUDIO_GARBAGE)
    res = await client.get("/api/local/queue")
    assert res.status_code == 502
    assert res.json() == {"reachable": True, "compatible": False}


@pytest.mark.asyncio
async def test_metrics_garbage_200_returns_502_not_data(client, monkeypatch):
    monkeypatch.setattr(server_module, "_broker_get", lambda path, query="", base_url=None: _LMSTUDIO_GARBAGE)
    res = await client.get("/api/local/metrics")
    assert res.status_code == 502
    assert res.json()["compatible"] is False


@pytest.mark.asyncio
async def test_spill_put_garbage_echo_returns_502(client, monkeypatch):
    monkeypatch.setattr(server_module, "_broker_put", lambda path, body, base_url=None: _LMSTUDIO_GARBAGE)
    res = await client.post("/api/local/spill", json={"interactive": 45})
    assert res.status_code == 502
    assert res.json()["compatible"] is False


@pytest.mark.asyncio
async def test_status_detects_lane_broker(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        if path == "/queue":
            return {"queued": [], "estimated_clear_seconds": 0, "spill": 0}
        raise OSError("no other endpoint")

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/status")
    body = res.json()
    assert body["compatible"] is True
    assert body["service"] == "lane-broker"


@pytest.mark.asyncio
async def test_status_fingerprints_lmstudio(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        if path == "/queue":
            return _LMSTUDIO_GARBAGE  # 200 anyway, wrong shape
        if path == "/api/v0/models":
            return {"data": [{"id": "qwen3.6-27b"}]}
        raise OSError("not served")

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/status")
    body = res.json()
    assert body["reachable"] is True
    assert body["compatible"] is False
    assert body["service"] == "lmstudio"


@pytest.mark.asyncio
async def test_status_offline(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/status")
    body = res.json()
    assert body["reachable"] is False
    assert body["service"] == "offline"


# ---------------------------------------------------------------------------
# Provider registry + provider-keyed routes
# ---------------------------------------------------------------------------


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
    lms_caps = ["queue", "metrics", "spill", "models", "traces", "health"]
    if server_module._LMS_CLI:
        lms_caps.append("model-control")
    assert body["providers"] == [
        {
            "id": "lmstudio-local",
            "label": "LM Studio (local)",
            "kind": "lmstudio",
            "scope": "local",
            "capabilities": lms_caps,
            "endpoint_hint": "127.0.0.1:1234",
            "managed": server_module._broker_is_managed(),
        },
        {
            "id": "vllm-local",
            "label": "vLLM (local)",
            "kind": "vllm",
            "scope": "local",
            "capabilities": ["models", "health", "metrics", "model-discovery"],
            "endpoint_hint": "127.0.0.1:8001",
            "managed": False,
        },
        # Plexar is the vLLM face: a fixed-bind gateway that owns container
        # lifecycle. No "queue" (it has no broker in front of it) and no
        # "model-control" (Cockpit does not own its containers).
        {
            "id": "plexar",
            "label": "Plexar (vLLM)",
            "kind": "plexar",
            "scope": "local",
            "capabilities": ["models", "health", "instances", "reports", "gpus"],
            "endpoint_hint": "127.0.0.1:8760",
            "managed": False,
        },
    ]
    dumped = str(body)
    # SSRF stance: local providers may expose a display-only host:port
    # (endpoint_hint) so the user knows where to boot the service, but the FULL
    # url, scheme, auth, and the raw url keys must never reach the browser.
    assert "http://" not in dumped and "https://" not in dumped
    assert "auth" not in dumped
    assert "broker_url" not in dumped and "management_url" not in dumped


@pytest.mark.asyncio
async def test_provider_queue_happy_path(client, monkeypatch):
    payload = {"in_flight": None, "queued": [], "estimated_clear_seconds": 0, "spill": 0}

    def fake_get(path, query="", base_url=None):
        assert path == "/queue"
        assert base_url == server_module._PROVIDERS["lmstudio-local"]["broker_url"]
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/queue")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_provider_metrics_happy_path(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        assert path == "/metrics"
        assert query == "window=24h"
        return {"runs_total": 3, "prompts_total": 3}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/metrics?window=24h")
    assert res.status_code == 200
    assert res.json()["runs_total"] == 3


@pytest.mark.asyncio
async def test_provider_capability_absent_404(client, monkeypatch):
    limited = dict(server_module._PROVIDERS["lmstudio-local"])
    limited["capabilities"] = ["queue"]
    monkeypatch.setitem(server_module._PROVIDERS, "lmstudio-local", limited)
    res = await client.get("/api/local/lmstudio-local/traces")
    assert res.status_code == 404
    assert res.json() == {"error": "capability not available"}


@pytest.mark.asyncio
async def test_unknown_provider_404(client):
    res = await client.get("/api/local/nope/queue")
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
    # `applicable` distinguishes "no broker in front of this backend" from
    # "the broker is down" -- collapsing them reported a healthy broker-less
    # engine (vLLM direct, Plexar) as not ok.
    assert body == {
        "broker": {"applicable": True, "reachable": True},
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
    assert body["broker"]["reachable"] is False
    assert body["provider"] == {"reachable": False, "models_loaded": 0}
    assert body["ok"] is False


@pytest.mark.asyncio
async def test_provider_traces_limit_clamp(client, monkeypatch):
    seen = {}

    def fake_get(path, query="", base_url=None):
        seen["query"] = query
        return {"traces": [], "count": 0}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/traces?limit=9999")
    assert res.status_code == 200
    assert seen["query"] == "limit=100"

    res = await client.get("/api/local/lmstudio-local/traces?limit=0")
    assert res.status_code == 200
    assert seen["query"] == "limit=1"

    res = await client.get("/api/local/lmstudio-local/traces")
    assert res.status_code == 200
    assert seen["query"] == "limit=20"


@pytest.mark.asyncio
async def test_provider_trace_id_regex_400(client):
    res = await client.get("/api/local/lmstudio-local/trace/bad%20id%21")
    assert res.status_code == 400
    assert res.json() == {"error": "invalid trace_id"}


@pytest.mark.asyncio
async def test_provider_trace_happy_path(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        assert path == "/trace/abc-123"
        return {"trace_id": "abc-123", "nodes": [], "edges": []}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/lmstudio-local/trace/abc-123")
    assert res.status_code == 200
    assert res.json()["trace_id"] == "abc-123"


@pytest.mark.asyncio
async def test_provider_spill_put_remote_scope_403(client, monkeypatch):
    remote = dict(server_module._PROVIDERS["lmstudio-local"])
    remote["scope"] = "remote"
    monkeypatch.setitem(server_module._PROVIDERS, "lmstudio-local", remote)
    res = await client.put("/api/local/lmstudio-local/spill", json={"interactive": 30})
    assert res.status_code == 403
    assert res.json() == {"error": "read-only for remote providers"}


@pytest.mark.asyncio
async def test_provider_spill_put_local_scope_ok(client, monkeypatch):
    seen = {}

    def fake_put(path, body, base_url=None):
        seen["path"] = path
        seen["body"] = body
        return {"spill_thresholds_s": {"interactive": 30, "worker": 300.0, "batch": None}}

    monkeypatch.setattr(server_module, "_broker_put", fake_put)
    res = await client.put("/api/local/lmstudio-local/spill", json={"interactive": 30})
    assert res.status_code == 200
    assert seen["path"] == "/config/spill"
    assert seen["body"] == {"interactive": 30}


@pytest.mark.asyncio
async def test_legacy_queue_still_works(client, monkeypatch):
    payload = {"queued": [], "estimated_clear_seconds": 0, "spill": 0}

    def fake_get(path, query="", base_url=None):
        assert path == "/queue"
        return payload

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/queue")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_legacy_metrics_still_works(client, monkeypatch):
    def fake_get(path, query="", base_url=None):
        return {"runs_total": 1, "prompts_total": 1}

    monkeypatch.setattr(server_module, "_broker_get", fake_get)
    res = await client.get("/api/local/metrics")
    assert res.status_code == 200


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


@pytest.mark.asyncio
async def test_legacy_spill_put_still_works(client, monkeypatch):
    def fake_put(path, body, base_url=None):
        return {"spill_thresholds_s": {"interactive": 30, "worker": 300.0, "batch": None}}

    monkeypatch.setattr(server_module, "_broker_put", fake_put)
    res = await client.post("/api/local/spill", json={"interactive": 30})
    assert res.status_code == 200
