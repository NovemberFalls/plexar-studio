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
import urllib.parse
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

# The bucketed-history route accepts a WIDER set of ranges than the summary
# route (it adds the two short ones), so it gets its own tuple rather than
# reusing REPORT_RANGES. Collapsing them would silently refuse `1h`/`6h`.
TIMESERIES_RANGES = ("1h", "6h", "24h", "7d", "30d", "lifetime")

# Bucket widths Plexar accepts. Omitting `bucket` lets Plexar derive it from
# the range, which is the better default -- it also owns the >720-point rule.
TIMESERIES_BUCKETS = ("1m", "5m", "1h", "6h", "1d")

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


def _refused(exc: "urllib.error.HTTPError") -> dict:
    """Plexar answered, and its answer was a refusal.

    ``HTTPError`` is a SUBCLASS of ``URLError``, so a bare ``except URLError``
    swallows a ``400`` and reports it as ``unreachable`` -- which is a false
    claim about a service that is up and just told us the request was wrong.
    Plexar refuses loudly on purpose (a bad range, or a bucket that would
    produce a truncated series), so that refusal has to survive the trip.
    """
    detail = None
    try:
        body = json.loads(exc.read().decode("utf-8"))
        if isinstance(body, dict):
            detail = body.get("detail") or body.get("error")
    except Exception:
        detail = None
    return unavailable(
        "refused",
        detail or f"Plexar refused the request (HTTP {exc.code}).",
    )


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
            # SAFE TO SURFACE as of 2026-07-31, and it was not before: an
            # adopted instance used to keep the name Plexar's own convention
            # WOULD have given a container it launched (`plexar-vllm-<id>`),
            # applied to one it demonstrably did not — `docker logs` against it
            # fails. Plexar now asks the daemon which container actually
            # publishes the port.
            #
            # A null is "we could not identify it", NEVER "there is no
            # container" — something is demonstrably answering, which is why it
            # was adopted at all. That is why `container_reason` has to travel
            # with it: a null with no reason cannot be told apart from the
            # other meaning, and dropping it here would recreate the exact
            # ambiguity the fix removed.
            "container": inst.get("container"),
            "container_reason": inst.get("container_reason"),
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
    except urllib.error.HTTPError as exc:
        return _refused(exc)
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


def fetch_timeseries(
    base_url: str,
    report_range: str = "24h",
    bucket: Optional[str] = None,
    instance_id: Optional[str] = None,
) -> dict:
    """Plexar's ``/api/reports/timeseries`` — bucketed history, two series.

    ``/api/reports/summary`` returns window TOTALS, so the only history a
    client could draw from it was "change observed while this page was open" —
    a browser-side diff that vanishes on reload. This route is real stored
    history, and it keeps the same two-source discipline as the summary: the
    ``gateway-requests`` and ``vllm-prometheus`` series are separate, each with
    its own ``window_exact`` flag, and are **never summed**.

    Three of Plexar's rules matter to whatever draws this, and are preserved
    here rather than smoothed away:

    * **Empty buckets are emitted.** A gap and a zero mean different things,
      so the grid is filled from the window start and the client never has to
      guess which it is looking at.
    * **A null is unknown, never zero.** An hour with no requests reports
      ``requests: 0`` (measured) but ``ttft_ms`` nulls (nothing was measured).
      A chart must draw a gap there, not a dip to the axis.
    * **Percentiles below their sample floor are null.** A p99 over four rows
      is one sample wearing a percentile's name; Plexar returns null instead,
      and that null is not a value to interpolate across.
    """
    if report_range not in TIMESERIES_RANGES:
        return unavailable("bad_range", f"range must be one of {list(TIMESERIES_RANGES)}")
    if bucket is not None and bucket not in TIMESERIES_BUCKETS:
        return unavailable("bad_bucket", f"bucket must be one of {list(TIMESERIES_BUCKETS)}")

    query = f"?range={urllib.parse.quote(report_range)}"
    if bucket:
        query += f"&bucket={urllib.parse.quote(bucket)}"
    if instance_id:
        query += f"&instance_id={urllib.parse.quote(instance_id)}"

    try:
        data = _get(base_url, f"/api/reports/timeseries{query}")
    except urllib.error.HTTPError as exc:
        # A 400 here is Plexar refusing a series it would have to truncate.
        # That is a real answer and must not read as "Plexar is down".
        return _refused(exc)
    except urllib.error.URLError:
        return unavailable("unreachable", "Plexar is not answering on its address.")
    except Exception:
        logger.warning("Plexar timeseries read failed", exc_info=True)
        return unavailable("bad_response", "Plexar returned something unreadable.")

    if not isinstance(data, dict) or not isinstance(data.get("series"), dict):
        return unavailable("bad_response", "Plexar timeseries was not series-shaped.")

    return {
        "available": True,
        "reason": None,
        "detail": None,
        "range": data.get("range"),
        "bucket": data.get("bucket"),
        "bucket_seconds": data.get("bucket_seconds"),
        "generated": data.get("generated"),
        # `lifetime` is bounded by Plexar's retention, and it says so here.
        # Dropping this would present a retention-clipped series as complete.
        "truncated": data.get("truncated"),
        "series": data.get("series"),
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
