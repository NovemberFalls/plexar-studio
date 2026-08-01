"""Plexar reads: engine state, reporting, GPUs.

The load-bearing idea: **the gateway being up is not the engine being able to
serve.** Plexar answers 200 on /v1/models while the engine behind it is
restarting or dead, because a stable address is the entire product. Judging it
by "did the HTTP call succeed" reports a dead engine as healthy.

These tests pin that separation, and pin that Plexar's own source labels
survive the trip through Cockpit — Cockpit keeps its own reporting, and two
sources merged without saying which is which produce numbers nobody can
defend.
"""

from __future__ import annotations

import os
import sys


sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import plexar_client as pc  # noqa: E402


def _model(state, reason=None, action=None, eta=None):
    return {"id": f"m-{state}", "object": "model", "plexar": {
        "state": state, "available": state in ("serving", "degraded"),
        "reason": reason, "action": action, "eta_seconds": eta,
    }}


# ---------------------------------------------------------------------------
# engine_summary — the gateway/engine distinction
# ---------------------------------------------------------------------------

def test_serving_engine_is_available():
    s = pc.engine_summary({"data": [_model("serving")]})
    assert s["available"] is True
    assert s["serving"] == 1 and s["total"] == 1
    assert s["state"] == "serving"


def test_degraded_still_counts_as_servable():
    """Degraded is still answering — just not happily."""
    s = pc.engine_summary({"data": [_model("degraded")]})
    assert s["available"] is True
    assert s["serving"] == 1


def test_unreachable_engine_behind_a_live_gateway_is_not_available():
    """THE case: /v1/models answered 200, the engine is dead.

    This is a real observed state — Plexar reported exactly this while its
    container was down and the gateway kept serving the catalog.
    """
    s = pc.engine_summary({"data": [
        _model("unreachable", action="the container is running but not answering")
    ]})
    assert s["available"] is False, "a reachable gateway must not imply a usable engine"
    assert s["state"] == "unreachable"
    assert s["serving"] == 0
    assert "not answering" in s["action"]


def test_loading_engine_carries_its_eta():
    """A restart must read as 'back shortly', not as a flat failure."""
    s = pc.engine_summary({"data": [
        _model("loading", reason="container starting", eta=30)
    ]})
    assert s["available"] is False
    assert s["state"] == "loading"
    assert s["eta_seconds"] == 30
    assert s["reason"] == "container starting"


def test_worst_state_wins_across_instances():
    """A user asking 'can I use this' is asking about what will stop them."""
    s = pc.engine_summary({"data": [_model("serving"), _model("failed")]})
    assert s["state"] == "failed"
    assert s["serving"] == 1, "the healthy one is still counted"
    assert s["total"] == 2
    assert s["available"] is True, "one servable instance means work can run"


def test_no_instances_is_reported_as_such_not_as_broken():
    s = pc.engine_summary({"data": []})
    assert s["state"] == "no_instances"
    assert s["available"] is False
    assert s["action"], "must say what to do about it"


def test_malformed_models_payload_is_rejected():
    for bad in (None, "nope", {}, {"data": "no"}):
        s = pc.engine_summary(bad)
        assert s["available"] is False


# ---------------------------------------------------------------------------
# fetch_status
# ---------------------------------------------------------------------------

def test_status_preserves_the_envelope_and_live_gauges(monkeypatch):
    payload = {
        "bind": {"host": "127.0.0.1", "port": 8760},
        "runtime": "wsl",
        "auth_required": False,
        "instances": [{
            "id": "gpu-main", "served_model_name": "qwen", "external": True,
            "state": "unreachable", "available": False,
            "reason": "adopted an engine already answering",
            "action": "check logs, then restart", "eta_seconds": None,
            "container": "vllm-bench", "container_reason": None,
            "live": {"available": False, "reason": "last sample is 1600s old",
                     "running": None, "tokens_per_sec": None},
        }],
    }
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: payload)
    out = pc.fetch_status("http://x")

    assert out["available"] is True, "we DID read Plexar successfully"
    inst = out["instances"][0]
    assert inst["state"] == "unreachable"
    assert inst["available"] is False, "the instance is not usable — a separate fact"
    assert inst["action"] == "check logs, then restart"
    assert inst["external"] is True
    assert inst["live"]["running"] is None, "a null gauge stays null, never 0"
    assert inst["container"] == "vllm-bench", (
        "the container is what a user needs for `docker logs` — Plexar now "
        "identifies it from the daemon rather than assuming its own naming "
        "convention applied to an engine it did not launch"
    )


def test_an_unidentified_container_keeps_the_reason_that_explains_the_null():
    """A null container is 'we could not identify it', NOT 'there is none'.

    Something is demonstrably answering — that is why it was adopted. Dropping
    `container_reason` would make those two meanings indistinguishable, which
    is the exact ambiguity Plexar added the field to remove.
    """
    payload = {"instances": [{
        "id": "gpu-main", "state": "serving", "external": True,
        "container": None,
        "container_reason": "two containers publish this port; cannot disambiguate",
    }]}
    import plexar_client as _pc
    orig = _pc._get
    try:
        _pc._get = lambda base, path, auth=None: payload
        inst = _pc.fetch_status("http://x")["instances"][0]
    finally:
        _pc._get = orig

    assert inst["container"] is None
    assert "disambiguate" in inst["container_reason"]


def test_status_unreachable_reports_a_reason(monkeypatch):
    import urllib.error

    def boom(base, path, auth=None):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(pc, "_get", boom)
    out = pc.fetch_status("http://x")
    assert out["available"] is False
    assert out["reason"] == "unreachable"


def test_wrong_shaped_status_is_rejected(monkeypatch):
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: {"hello": "world"})
    out = pc.fetch_status("http://x")
    assert out["available"] is False
    assert out["reason"] == "bad_response"


# ---------------------------------------------------------------------------
# fetch_reports — source labels must survive
# ---------------------------------------------------------------------------

def test_report_figures_keep_their_source_and_window_labels(monkeypatch):
    """Cockpit keeps its OWN reporting; Plexar's is a second source beside it.

    A Prometheus counter is cumulative since engine start, so the same number
    means different things depending on which source produced it. Stripping the
    labels is how two defensible reports become one indefensible one.
    """
    payload = {"range": "lifetime", "generated": "2026-07-31T08:24:18+00:00",
               "figures": [
                   {"key": "requests", "value": 8, "source": "gateway-requests",
                    "window_exact": True},
                   {"key": "runs_total", "value": 10, "source": "vllm-prometheus",
                    "window_exact": False},
               ],
               "sources": {"gateway-requests": {"label": "gateway request records"}},
               "engine_unknown": {"instances": 1}}
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: payload)
    out = pc.fetch_reports("http://x", "lifetime")

    assert out["available"] is True
    assert [f["source"] for f in out["figures"]] == ["gateway-requests", "vllm-prometheus"]
    assert [f["window_exact"] for f in out["figures"]] == [True, False]
    assert out["sources"], "the source glossary must survive"
    assert out["engine_unknown"] == {"instances": 1}, (
        "a reported gap must not be dropped — it is why a figure is missing"
    )


def test_bad_range_is_refused_before_the_network(monkeypatch):
    called = []
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: called.append(path))
    out = pc.fetch_reports("http://x", "yesterday")
    assert out["available"] is False
    assert out["reason"] == "bad_range"
    assert called == [], "an invalid range must not reach Plexar"


# ---------------------------------------------------------------------------
# fetch_gpus
# ---------------------------------------------------------------------------

def test_gpus_pass_through(monkeypatch):
    payload = {"available": True, "gpus": [
        {"uuid": "GPU-1", "name": "RTX 3090", "total_mb": 24576.0,
         "free_mb": 20314.0, "used_by_display": True},
    ]}
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: payload)
    out = pc.fetch_gpus("http://x")
    assert out["available"] is True
    assert out["gpus"][0]["name"] == "RTX 3090"


def test_gpus_honour_plexars_own_unavailable_envelope(monkeypatch):
    """Plexar answers with its own availability flag; don't override it."""
    monkeypatch.setattr(
        pc, "_get",
        lambda base, path, auth=None: {"available": False, "reason": "nvidia-smi not found", "gpus": []},
    )
    out = pc.fetch_gpus("http://x")
    assert out["available"] is False
    assert "nvidia-smi" in out["detail"]
