"""Client for Plexar — the vLLM face (``C:/Code/Personal/plexar-vllm``).

Plexar owns vLLM container lifecycle and publishes a **fixed-bind**
OpenAI-compatible gateway. Cockpit points at one address forever; model swaps,
restarts and upgrades happen behind it.

Why this module exists rather than another `_broker_get` call
-------------------------------------------------------------
Plexar draws a distinction the lane-broker contract has no room for:

    THE GATEWAY IS UP  ≠  THE ENGINE CAN SERVE

A restarting engine answers ``200`` on ``/v1/models`` and ``503`` +
``Retry-After`` on inference, carrying a state envelope that says *which* of
``serving | degraded | loading | unreachable | stopped | failed`` it is, why,
and how long it expects to take. Collapsing that to Cockpit's boolean
``reachable`` throws away the only information that tells a user whether to
wait ten seconds or go fix something — and reports a dead engine behind a live
gateway as healthy, which is worse than reporting nothing.

So every read here preserves ``state`` / ``available`` / ``reason`` /
``action`` / ``eta_seconds`` verbatim. Cockpit does not re-derive them and
must not invent them.

Two data sources, never conflated (Plexar's rule, honoured here)
---------------------------------------------------------------
1. ``gateway-requests`` — Plexar's own records. Authoritative on what
   *consumers experienced*; exact, supports real time windows.
2. ``vllm-prometheus`` — authoritative on what the *GPU* was doing. Cumulative
   since server start, so a window is only exact for ``lifetime``.

Plexar labels every figure with its source and whether the window is exact.
Those labels are passed through untouched: a report that mixes the two without
saying which is which produces numbers nobody can defend.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from typing import Any, Optional

logger = logging.getLogger("cockpit.plexar")

# Plexar is a local, first-party service; these are quick reads behind a UI.
_TIMEOUT = 6.0

# States in which an instance can actually accept a request. `degraded` is
# included deliberately — it is still answering, just not happily.
_SERVABLE_STATES = ("serving", "degraded")

# Ranges Plexar's reporting routes accept. Validated here so a bad value is a
# 400 from Cockpit rather than an opaque proxy error.
REPORT_RANGES = ("lifetime", "24h", "7d", "30d")

_ENVELOPE_KEYS = ("state", "available", "reason", "action", "eta_seconds", "since")


def _get(base_url: str, path: str) -> Any:
    """GET {base_url}{path} and parse JSON. Raises on any failure."""
    url = f"{base_url}{path}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _envelope(src: dict) -> dict:
    """Lift the state envelope out of *src*, defaulting nothing."""
    return {k: src.get(k) for k in _ENVELOPE_KEYS}


def unavailable(reason: str, detail: str) -> dict:
    """The shape every fallible read returns when it could not read.

    Mirrors Plexar's own honesty envelope: never an empty success, never a
    zero standing in for "unknown".
    """
    return {"available": False, "reason": reason, "detail": detail}


def fetch_status(base_url: str) -> dict:
    """Plexar's ``/api/status`` — bind, instances (with state + live), runtime.

    Returns ``{available: True, ...}`` on success, or ``unavailable(...)``.
    Never raises: a down Plexar is an expected state, not an error.
    """
    try:
        data = _get(base_url, "/api/status")
    except urllib.error.URLError as exc:
        logger.debug("Plexar status unreachable: %s", exc)
        return unavailable("unreachable", "Plexar is not answering on its address.")
    except Exception:
        logger.warning("Plexar status read failed", exc_info=True)
        return unavailable("bad_response", "Plexar returned something unreadable.")

    if not isinstance(data, dict) or "instances" not in data:
        return unavailable("bad_response", "Plexar status was not status-shaped.")

    instances = []
    for inst in data.get("instances") or []:
        if not isinstance(inst, dict):
            continue
        entry = {
            "id": inst.get("id"),
            "served_model_name": inst.get("served_model_name"),
            "model_path": inst.get("model_path"),
            "gpu_uuid": inst.get("gpu_uuid"),
            "image": inst.get("image"),
            "started_at": inst.get("started_at"),
            # `external` means Plexar adopted an engine it did not start, and
            # therefore will not stop. Surfacing it stops a user wondering why
            # a restart control is absent.
            "external": inst.get("external"),
            "in_flight": inst.get("in_flight"),
            "drift": inst.get("drift"),
            "live": inst.get("live"),
        }
        entry.update(_envelope(inst))
        instances.append(entry)

    return {
        "available": True,
        "reason": None,
        "detail": None,
        "bind": data.get("bind"),
        "runtime": data.get("runtime"),
        "auth_required": data.get("auth_required"),
        "version": data.get("version"),
        "instances": instances,
    }


def engine_summary(models_payload: Any) -> dict:
    """Aggregate engine health from a Plexar ``/v1/models`` body.

    THE POINT OF THIS FUNCTION: Plexar answers ``200`` on ``/v1/models`` even
    when the engine behind it is down — the gateway is up, which is the whole
    design. Judging Plexar by "did the HTTP call succeed" therefore reports a
    dead engine as healthy. This reads the per-model envelope instead.

    Returns ``{serving, total, state, available, reason, action, eta_seconds}``
    where ``state`` is the single worst state across instances, because a user
    asking "can I use this" is asking about the thing that will stop them.
    """
    data = models_payload.get("data") if isinstance(models_payload, dict) else None
    if not isinstance(data, list):
        return {"serving": 0, "total": 0, "state": None, "available": False,
                "reason": "bad_response", "action": None, "eta_seconds": None}

    serving = 0
    worst: Optional[dict] = None
    # Ordered best → worst; the first non-servable state encountered wins.
    rank = {"serving": 0, "degraded": 1, "loading": 2, "unreachable": 3,
            "stopped": 4, "failed": 5}

    for entry in data:
        if not isinstance(entry, dict):
            continue
        env = entry.get("plexar")
        if not isinstance(env, dict):
            continue
        state = env.get("state")
        if state in _SERVABLE_STATES:
            serving += 1
        if worst is None or rank.get(state, 9) > rank.get(worst.get("state"), 9):
            worst = env

    total = sum(1 for e in data if isinstance(e, dict))
    if worst is None:
        # A gateway with no instances at all is a real, reportable state — it
        # is not "broken", it just has nothing to serve.
        return {"serving": 0, "total": total, "state": "no_instances",
                "available": False,
                "reason": "Plexar has no engine instances configured.",
                "action": "Create an instance in Plexar.", "eta_seconds": None}

    return {
        "serving": serving,
        "total": total,
        "state": worst.get("state"),
        # `available` is about whether a request can be served RIGHT NOW, which
        # is not the same as the gateway being reachable.
        "available": serving > 0,
        "reason": worst.get("reason"),
        "action": worst.get("action"),
        "eta_seconds": worst.get("eta_seconds"),
    }


def fetch_reports(base_url: str, report_range: str = "lifetime") -> dict:
    """Plexar's ``/api/reports/summary`` — both sources, each figure labelled.

    Figures are passed through with their ``source`` and ``window_exact`` flags
    intact. Cockpit must not strip those: a Prometheus counter is cumulative
    since engine start, so the same number means different things depending on
    which source produced it.
    """
    if report_range not in REPORT_RANGES:
        return unavailable("bad_range", f"range must be one of {list(REPORT_RANGES)}")

    try:
        data = _get(base_url, f"/api/reports/summary?range={report_range}")
    except urllib.error.URLError:
        return unavailable("unreachable", "Plexar is not answering on its address.")
    except Exception:
        logger.warning("Plexar reports read failed", exc_info=True)
        return unavailable("bad_response", "Plexar returned something unreadable.")

    if not isinstance(data, dict) or "figures" not in data:
        return unavailable("bad_response", "Plexar reports were not report-shaped.")

    return {
        "available": True,
        "reason": None,
        "detail": None,
        "range": data.get("range"),
        "generated": data.get("generated"),
        "figures": data.get("figures") or [],
        "sources": data.get("sources") or {},
        # Present when Prometheus could not be read; Plexar reports the gap
        # rather than substituting zeros, and so do we.
        "engine_unknown": data.get("engine_unknown"),
    }


def fetch_gpus(base_url: str) -> dict:
    """Plexar's ``/api/planner/gpus`` — physical cards, VRAM, display usage."""
    try:
        data = _get(base_url, "/api/planner/gpus")
    except urllib.error.URLError:
        return unavailable("unreachable", "Plexar is not answering on its address.")
    except Exception:
        logger.warning("Plexar GPU read failed", exc_info=True)
        return unavailable("bad_response", "Plexar returned something unreadable.")

    if not isinstance(data, dict):
        return unavailable("bad_response", "Plexar GPU payload was not an object.")

    # Plexar already answers with its own availability envelope here.
    if data.get("available") is False:
        return unavailable("unavailable", data.get("reason") or "GPU data unavailable.")

    return {
        "available": True,
        "reason": None,
        "detail": None,
        "gpus": data.get("gpus") or [],
    }
