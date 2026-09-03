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

# Identifies Studio to Plexar and, more importantly, is NOT the urllib default
# that Cloudflare blocks outright (see auth_headers). Naming the product also
# makes Plexar's own request records attributable to Studio rather than to an
# anonymous script.
_USER_AGENT = "PlexarStudio/1.0 (+https://github.com/anthropics/claude-cockpit)"


def auth_headers(auth: Optional[dict]) -> dict:
    """Build the request headers for *auth*, which may be None.

    TWO INDEPENDENT LAYERS, and conflating them is the documented trap:

      * **Cloudflare Access** (`CF-Access-Client-Id` / `-Secret`) gets a request
        past the tunnel and NO FURTHER. It is not authentication for Plexar.
      * **Plexar** (`Authorization: Bearer plx_…`) is the actual identity.

    A service token alone returns 401 from Plexar — Access passed, Plexar
    refused — so both are sent, and neither substitutes for the other.

    None of these values ever reach the browser (same SSRF/secrets stance as
    every other provider URL and key in the registry).

    THE USER-AGENT IS LOAD-BEARING, not cosmetic. Plexar is published through
    Cloudflare, and Cloudflare rejects urllib's default `Python-urllib/3.x`
    with **Error 1010 ("Access denied", HTTP 403") before the request reaches
    the tunnel at all. Measured 2026-09-02 against the live rig: identical
    requests differing ONLY in User-Agent returned 403 (`Python-urllib/3.11`)
    vs. Plexar's own 401 (curl's UA, or no UA header). So every Plexar read
    failed with a Cloudflare error that has nothing to do with the credential —
    and because the body is a 403, `_refused()` mapped it to `forbidden` and
    the UI told the user to ask the rig owner to widen their key's scope. The
    key was fine; the request never arrived.

    Set here rather than at each call site because this is the one builder
    every Plexar path shares (`_get`, the control POST, and server's
    `_mgmt_get`), and a UA missing from any one of them resurrects the bug on
    that route alone.
    """
    headers = {"Accept": "application/json", "User-Agent": _USER_AGENT}
    if not isinstance(auth, dict):
        return headers
    token = auth.get("bearer")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    cf_id, cf_secret = auth.get("cf_client_id"), auth.get("cf_client_secret")
    # Both or neither: a lone half is not a partial credential, it is a
    # malformed one, and sending it produces a confusing 302-to-login instead
    # of a clean refusal.
    if cf_id and cf_secret:
        headers["CF-Access-Client-Id"] = cf_id
        headers["CF-Access-Client-Secret"] = cf_secret
    return headers


def _get(base_url: str, path: str, auth: Optional[dict] = None) -> Any:
    """GET {base_url}{path} and parse JSON. Raises on any failure."""
    url = f"{base_url}{path}"
    req = urllib.request.Request(url, headers=auth_headers(auth))
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


def _detail_prose(raw) -> Optional[str]:
    """Reduce whatever Plexar put in ``detail``/``error`` to a SENTENCE.

    ``unavailable()`` declares ``detail: str`` and every consumer renders it
    directly, so this is the one place that promise can be kept. It was not
    being kept: Plexar's refusals are OpenAI-shaped, so ``detail`` arrives as
    ``{"message": ..., "type": ..., "param": ..., "code": ...}``. Handing that
    object to the browser is what blanked Reports > Local engine on 1.29.0 --
    React refuses to render an object and the whole tab threw.

    The human sentence lives at ``message``. Anything else is stringified
    rather than dropped: a detail we cannot parse is still evidence, and an
    empty reason reads as "no problem", which is the opposite claim.
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        return raw or None
    if isinstance(raw, dict):
        for key in ("message", "detail", "error", "reason"):
            value = raw.get(key)
            if isinstance(value, str) and value:
                return value
    return str(raw)


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
            detail = _detail_prose(body.get("detail") or body.get("error"))
    except Exception:
        detail = None

    # 401 and 403 are DIFFERENT problems with different remedies, and merging
    # them into "auth error" tells a guest to re-enter a key that was never
    # wrong. 401 = the credential is missing or bad. 403 = the credential is
    # fine and this route is not theirs.
    if exc.code == 401:
        return unavailable(
            "unauthorized",
            detail or "Plexar did not accept the credential. Check COCKPIT_PLEXAR_KEY.",
        )
    if exc.code == 403:
        return unavailable(
            "forbidden",
            detail or "This key is valid but not permitted to read this.",
        )
    return unavailable(
        "refused",
        detail or f"Plexar refused the request (HTTP {exc.code}).",
    )


def fetch_status(base_url: str, auth: Optional[dict] = None) -> dict:
    """Plexar's ``/api/status`` — bind, instances (with state + live), runtime.

    Returns ``{available: True, ...}`` on success, or ``unavailable(...)``.
    Never raises: a down Plexar is an expected state, not an error.
    """
    try:
        data = _get(base_url, "/api/status", auth)
    except urllib.error.HTTPError as exc:
        return _refused(exc)
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


def fetch_reports(base_url: str, report_range: str = "lifetime",
                  auth: Optional[dict] = None) -> dict:
    """Plexar's ``/api/reports/summary`` — both sources, each figure labelled.

    Figures are passed through with their ``source`` and ``window_exact`` flags
    intact. Cockpit must not strip those: a Prometheus counter is cumulative
    since engine start, so the same number means different things depending on
    which source produced it.
    """
    if report_range not in REPORT_RANGES:
        return unavailable("bad_range", f"range must be one of {list(REPORT_RANGES)}")

    try:
        data = _get(base_url, f"/api/reports/summary?range={report_range}", auth)
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
    auth: Optional[dict] = None,
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
        data = _get(base_url, f"/api/reports/timeseries{query}", auth)
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


def fetch_me(base_url: str, auth: Optional[dict] = None) -> dict:
    """Plexar's ``/api/me`` — who Cockpit is authenticating as.

    **Contracted to answer 200 even when nobody is authenticated**, and that is
    the reason to build against it rather than inferring identity from another
    route's 401: ``authenticated: false`` is an ANSWER, where a 401 would leave
    a consumer unable to tell "wrong credential" from "server down" — opposite
    remedies.

    ``scope_description`` and the ``scopes`` map are served BY PLEXAR and
    rendered verbatim. Cockpit must not hard-code what a guest may do: that
    prose goes stale the first time the allow-list changes, and it has already
    changed once. Same rule as ``capacity_caveat``.
    """
    try:
        data = _get(base_url, "/api/me", auth)
    except urllib.error.HTTPError as exc:
        # /api/me is exempt from the gate, so a refusal here is a real
        # surprise rather than an expected unauthenticated read.
        return _refused(exc)
    except urllib.error.URLError:
        return unavailable("unreachable", "Plexar is not answering on its address.")
    except Exception:
        logger.warning("Plexar identity read failed", exc_info=True)
        return unavailable("bad_response", "Plexar returned something unreadable.")

    if not isinstance(data, dict) or "authenticated" not in data:
        return unavailable("bad_response", "Plexar identity was not identity-shaped.")

    return {
        "available": True,
        "reason": None,
        "detail": None,
        "authenticated": bool(data.get("authenticated")),
        # Null when unauthenticated — NOT a fabricated anonymous identity.
        "identity": data.get("identity"),
        # The server's own scope prose. Never replaced with ours.
        "scopes": data.get("scopes") or {},
    }


#: The only lifecycle verbs Cockpit is allowed to send. `unload` frees the GPU
#: but KEEPS the declaration; `load` starts it again with no config re-supply.
#: `DELETE /api/instances/{id}` is deliberately NOT here — it forgets the
#: instance entirely, so re-running the same model would mean re-entering its
#: whole config. A picker needs a list it can toggle, not one it can destroy,
#: and a destructive verb behind a toggle is how data gets lost by accident.
CONTROL_ACTIONS = ("load", "unload")


def control_instance(base_url: str, instance_id: str, action: str,
                     auth: Optional[dict] = None) -> dict:
    """POST ``/api/instances/{id}/{load|unload}``.

    Unlike the read paths this is a WRITE, so it does not return a soft
    availability envelope: a control that silently did nothing is worse than
    one that reports failure, and the caller needs to know which happened.
    """
    if action not in CONTROL_ACTIONS:
        return {"ok": False, "reason": "bad_action", "detail": f"unknown action {action!r}"}

    url = f"{base_url}/api/instances/{urllib.parse.quote(instance_id)}/{action}"
    req = urllib.request.Request(
        url, data=b"", method="POST",
        headers={**auth_headers(auth), "Content-Type": "application/json"},
    )
    try:
        # Loading pulls a model onto the GPU and unloading drains in-flight
        # requests first, so neither fits the 6s read timeout.
        with urllib.request.urlopen(req, timeout=120.0) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        refusal = _refused(exc)
        return {"ok": False, "reason": refusal["reason"], "detail": refusal["detail"]}
    except urllib.error.URLError:
        return {"ok": False, "reason": "unreachable",
                "detail": "Plexar is not answering on its address."}
    except Exception:
        logger.warning("Plexar %s of %s failed", action, instance_id, exc_info=True)
        return {"ok": False, "reason": "bad_response",
                "detail": "Plexar returned something unreadable."}

    logger.info("Plexar %s instance %s", action, instance_id)
    return {"ok": True, "action": action, "instance_id": instance_id,
            "result": body if isinstance(body, dict) else None}


def fetch_gpus(base_url: str, auth: Optional[dict] = None) -> dict:
    """Plexar's ``/api/planner/gpus`` — physical cards, VRAM, display usage."""
    try:
        data = _get(base_url, "/api/planner/gpus", auth)
    except urllib.error.HTTPError as exc:
        return _refused(exc)
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
