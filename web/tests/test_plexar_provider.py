"""Cockpit's side of the Plexar (vLLM face) integration.

Plexar owns vLLM container lifecycle and publishes a FIXED-BIND
OpenAI-compatible gateway; Cockpit's whole integration is one endpoint entry
pointing at that address. These tests pin the two places Cockpit's existing
assumptions did not fit it — both of which made a healthy engine look broken:

  1. Health was judged by probing the lane broker's ``/queue`` on EVERY
     provider. Plexar has no broker, so that 404s and reported
     ``broker.reachable: false`` — a false claim about a component that is not
     there, which dragged ``ok`` to false while the engine served fine.

  2. The loaded-model count only understood LM Studio's ``state: "loaded"``.
     Plexar nests its state envelope under a ``plexar`` key, so every model
     counted as not-loaded and the catalog read as empty mid-serve.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server  # noqa: E402


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def test_plexar_is_registered_without_queue_or_model_control():
    p = server._PROVIDERS["plexar"]
    caps = p["capabilities"]
    assert "models" in caps and "health" in caps
    assert "queue" not in caps, (
        "Plexar has no lane broker in front of it — advertising `queue` is what "
        "makes the health route probe a /queue that does not exist"
    )
    assert "model-control" not in caps, (
        "Plexar owns container lifecycle; a Cockpit restart button for an engine "
        "it does not own is false advertising"
    )


def test_plexar_address_is_overridable():
    """The address is the product — but it must not be hard-coded here."""
    assert "COCKPIT_PLEXAR_URL" in open(
        os.path.join(os.path.dirname(__file__), "..", "server.py"), encoding="utf-8"
    ).read()


# ---------------------------------------------------------------------------
# Loaded-model counting across the three catalog dialects
# ---------------------------------------------------------------------------

def test_counts_plexar_serving_models():
    data = {"data": [
        {"id": "a", "plexar": {"state": "serving", "available": True}},
        {"id": "b", "plexar": {"state": "degraded", "available": True}},
    ]}
    assert server._provider_models_loaded_count(data) == 2, (
        "serving and degraded can both take a request"
    )


def test_does_not_count_plexar_models_that_cannot_serve():
    data = {"data": [
        {"id": "a", "plexar": {"state": "loading"}},
        {"id": "b", "plexar": {"state": "failed"}},
        {"id": "c", "plexar": {"state": "stopped"}},
    ]}
    assert server._provider_models_loaded_count(data) == 0


def test_lmstudio_dialect_still_filters_on_loaded():
    data = {"data": [
        {"id": "a", "state": "loaded"},
        {"id": "b", "state": "not-loaded"},
    ]}
    assert server._provider_models_loaded_count(data) == 1


def test_stateless_openai_catalog_counts_as_loaded():
    """vLLM direct reports no state — one process serves what it launched with.

    This previously counted 0, so a serving vLLM reported "no models".
    """
    assert server._provider_models_loaded_count({"data": [{"id": "a"}]}) == 1


def test_empty_and_malformed_catalogs_are_zero():
    assert server._provider_models_loaded_count({}) == 0
    assert server._provider_models_loaded_count({"data": []}) == 0
    assert server._provider_models_loaded_count({"data": [None, 3]}) == 0
    assert server._provider_models_loaded_count("nonsense") == 0


# ---------------------------------------------------------------------------
# Model normalization
# ---------------------------------------------------------------------------

def test_plexar_serving_model_normalizes_to_loaded():
    out = server._normalize_plexar_raw_model(
        {"id": "qwen3-coder-30b-awq", "plexar": {"state": "serving", "reason": None}}
    )
    assert out["state"] == "loaded"
    assert out["quantization"] == "awq", "quantization is sniffed from the id"


def test_plexar_not_ready_keeps_its_own_state_and_reason():
    """A not-ready model must NOT be dressed up as loaded OR flattened to null.

    Plexar's whole envelope exists so "not ready" carries a reason; discarding
    that would reintroduce the ambiguity it was built to remove.
    """
    out = server._normalize_plexar_raw_model({
        "id": "m",
        "plexar": {"state": "loading", "reason": "container starting", "eta_seconds": 30},
    })
    assert out["state"] == "loading"
    assert out["reason"] == "container starting"
    assert out["eta_seconds"] == 30


def test_plexar_normalizer_tolerates_a_missing_envelope():
    out = server._normalize_plexar_raw_model({"id": "m"})
    assert out["id"] == "m"


# ---------------------------------------------------------------------------
# Health probing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_brokerless_provider_is_not_queue_probed(monkeypatch):
    """The regression: probing /queue on a broker-less backend.

    It 404s, and reporting that as broker-unreachable made `ok` false for a
    healthy engine.
    """
    calls = []

    def fake_broker_get(path, qs="", base=None):
        calls.append(path)
        raise RuntimeError("404 — no broker here")

    monkeypatch.setattr(server, "_broker_get", fake_broker_get)
    monkeypatch.setattr(
        server, "_mgmt_get",
        lambda provider, path: {"data": [{"id": "m", "plexar": {"state": "serving"}}]},
    )

    resp = await server.get_provider_health("plexar")
    import json as _json
    body = _json.loads(resp.body)

    assert calls == [], "a provider without the queue capability must never be queue-probed"
    assert body["broker"] == {"applicable": False, "reachable": None}, (
        "'no broker here' and 'the broker is down' are different statements"
    )
    assert body["provider"]["reachable"] is True
    assert body["provider"]["models_loaded"] == 1
    assert body["ok"] is True, "a healthy broker-less engine must report ok"


@pytest.mark.asyncio
async def test_broker_fronted_provider_still_requires_its_broker(monkeypatch):
    """The fix must not make the broker optional where it IS in the path."""
    monkeypatch.setattr(
        server, "_broker_get",
        lambda path, qs="", base=None: (_ for _ in ()).throw(RuntimeError("down")),
    )
    monkeypatch.setattr(
        server, "_mgmt_get", lambda provider, path: {"data": [{"id": "m", "state": "loaded"}]}
    )

    resp = await server.get_provider_health("lmstudio-local")
    import json as _json
    body = _json.loads(resp.body)

    assert body["broker"] == {"applicable": True, "reachable": False}
    assert body["ok"] is False, "LM Studio is served THROUGH the broker; down broker means not ok"


@pytest.mark.asyncio
async def test_unreachable_plexar_reports_not_ok(monkeypatch):
    def boom(provider, path):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(server, "_mgmt_get", boom)
    resp = await server.get_provider_health("plexar")
    import json as _json
    body = _json.loads(resp.body)

    assert body["provider"]["reachable"] is False
    assert body["ok"] is False
