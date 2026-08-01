"""``/api/local/{id}/timeseries`` — bucketed engine history from Plexar.

``/api/reports/summary`` returns window TOTALS. A client wanting history could
therefore only diff repeated polls, which is not history and vanishes on
reload. This route is the stored version.

The rules under test are the ones that make a chart honest rather than
decorative:

  · the two sources stay SEPARATE named series and are never summed;
  · an empty bucket is emitted, because a gap and a zero mean different
    things — and inside it a measured ``requests: 0`` coexists with a null
    latency, because nothing was measured;
  · a percentile below its sample floor arrives null and stays null;
  · a Plexar 400 (a series it refuses to truncate) is a REFUSAL, not
    "Plexar is down" — ``HTTPError`` subclasses ``URLError``, which is exactly
    how that lie used to happen.
"""

from __future__ import annotations

import io
import json
import os
import sys
import urllib.error

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import plexar_client as pc  # noqa: E402
import server  # noqa: E402


PAYLOAD = {
    "range": "24h",
    "bucket": "1h",
    "bucket_seconds": 3600,
    "generated": "2026-07-31T02:46:59Z",
    "truncated": False,
    "series": {
        "gateway-requests": {
            "window_exact": True,
            "note": "gateway request records: what consumers experienced.",
            "buckets": [
                {"t": "2026-07-31T01:00:00Z", "requests": 214, "errors": 2,
                 "completion_tokens": 81220,
                 "ttft_ms": {"p50": 412, "p95": 1420, "p99": 6180}},
                # An hour with no traffic: a MEASURED zero, and nothing measured.
                {"t": "2026-07-31T02:00:00Z", "requests": 0, "errors": 0,
                 "completion_tokens": None,
                 "ttft_ms": {"p50": None, "p95": None, "p99": None}},
            ],
        },
        "vllm-prometheus": {
            "window_exact": False,
            "note": "counters are cumulative since engine start.",
            "buckets": [
                {"t": "2026-07-31T01:00:00Z", "tps_avg": 742,
                 "kv_cache_pct": {"mean": 61.4, "max": 97.4},
                 "runs_delta": 412, "restart_in_bucket": False},
            ],
        },
    },
}


def _http_error(code, body):
    return urllib.error.HTTPError(
        "http://x", code, "Bad Request", {},
        io.BytesIO(json.dumps(body).encode("utf-8")),
    )


# ---------------------------------------------------------------------------
# fetch_timeseries
# ---------------------------------------------------------------------------

def test_the_two_series_survive_as_separate_keys(monkeypatch):
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: PAYLOAD)
    out = pc.fetch_timeseries("http://x", "24h")

    assert out["available"] is True
    assert set(out["series"]) == {"gateway-requests", "vllm-prometheus"}
    assert out["series"]["gateway-requests"]["window_exact"] is True
    assert out["series"]["vllm-prometheus"]["window_exact"] is False, (
        "a Prometheus counter is cumulative since engine start; losing that "
        "flag is how two defensible series become one indefensible line"
    )


def test_an_empty_bucket_keeps_its_measured_zero_and_its_nulls(monkeypatch):
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: PAYLOAD)
    out = pc.fetch_timeseries("http://x", "24h")
    quiet = out["series"]["gateway-requests"]["buckets"][1]

    assert quiet["requests"] == 0, "no traffic IS a measurement"
    assert quiet["ttft_ms"]["p50"] is None, (
        "no request means no latency was measured — a chart must draw a gap "
        "there, not a dip to the axis"
    )
    assert quiet["completion_tokens"] is None


def test_truncation_flag_is_carried(monkeypatch):
    """`lifetime` is bounded by Plexar's retention and says so."""
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: {**PAYLOAD, "truncated": True})
    assert pc.fetch_timeseries("http://x", "lifetime")["truncated"] is True


def test_short_ranges_the_summary_route_lacks_are_accepted(monkeypatch):
    seen = []
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: seen.append(path) or PAYLOAD)
    for r in ("1h", "6h"):
        assert pc.fetch_timeseries("http://x", r)["available"] is True
    assert any("range=1h" in p for p in seen)


def test_bad_range_and_bucket_are_refused_before_the_network(monkeypatch):
    called = []
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: called.append(path))

    assert pc.fetch_timeseries("http://x", "yesterday")["reason"] == "bad_range"
    assert pc.fetch_timeseries("http://x", "24h", bucket="3s")["reason"] == "bad_bucket"
    assert called == [], "an invalid request must not reach Plexar"


def test_bucket_and_instance_filter_reach_plexar(monkeypatch):
    seen = []
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: seen.append(path) or PAYLOAD)
    pc.fetch_timeseries("http://x", "24h", bucket="1h", instance_id="gpu-main")
    assert "bucket=1h" in seen[0] and "instance_id=gpu-main" in seen[0]


def test_omitted_bucket_is_left_to_plexar(monkeypatch):
    """Plexar derives the bucket from the range AND owns the 720-point rule."""
    seen = []
    monkeypatch.setattr(pc, "_get", lambda base, path, auth=None: seen.append(path) or PAYLOAD)
    pc.fetch_timeseries("http://x", "7d")
    assert "bucket=" not in seen[0]


def test_a_refusal_is_reported_as_a_refusal_not_as_unreachable(monkeypatch):
    """THE trap: HTTPError is a subclass of URLError.

    A bare `except URLError` swallows Plexar's 400 — the one it raises rather
    than silently truncate a series — and reports a live service as down.
    """
    def refuse(base, path, auth=None):
        raise _http_error(400, {"detail": "bucket would produce 8760 points"})

    monkeypatch.setattr(pc, "_get", refuse)
    out = pc.fetch_timeseries("http://x", "30d", bucket="1m")

    assert out["available"] is False
    assert out["reason"] == "refused", "Plexar answered; it just said no"
    assert "8760 points" in out["detail"], "its stated reason must survive"


def test_genuinely_unreachable_still_reads_as_unreachable(monkeypatch):
    def boom(base, path, auth=None):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(pc, "_get", boom)
    assert pc.fetch_timeseries("http://x", "24h")["reason"] == "unreachable"


def test_wrong_shaped_payload_is_rejected(monkeypatch):
    for bad in (None, "nope", {}, {"series": []}):
        monkeypatch.setattr(pc, "_get", lambda base, path, auth=None, b=bad: b)
        out = pc.fetch_timeseries("http://x", "24h")
        assert out["available"] is False
        assert out["reason"] == "bad_response"


def test_summary_route_also_distinguishes_a_refusal(monkeypatch):
    """Same fix, applied to the sibling route that had the same bug."""
    def refuse(base, path, auth=None):
        raise _http_error(400, {"detail": "range must be one of [...]"})

    monkeypatch.setattr(pc, "_get", refuse)
    assert pc.fetch_reports("http://x", "24h")["reason"] == "refused"


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------

def test_plexar_advertises_timeseries_but_lmstudio_does_not():
    assert "timeseries" in server._PROVIDERS["plexar-vllm"]["capabilities"]
    assert "timeseries" not in server._PROVIDERS["lmstudio-local"]["capabilities"], (
        "a capability is a promise the route will answer; the lane broker "
        "serves no bucketed history"
    )


@pytest.mark.asyncio
async def test_route_passes_the_series_through(monkeypatch):
    monkeypatch.setattr(
        server.plexar_client, "fetch_timeseries",
        lambda url, rng, bucket, inst, auth=None: {"available": True, "series": PAYLOAD["series"]},
    )
    resp = await server.get_provider_timeseries("plexar-vllm", range="24h")
    body = json.loads(resp.body)
    assert set(body["series"]) == {"gateway-requests", "vllm-prometheus"}


@pytest.mark.asyncio
async def test_route_rejects_a_bad_range_and_bucket_loudly():
    """An envelope is for a service that failed. A bad param is the caller's."""
    assert (await server.get_provider_timeseries("plexar-vllm", range="nope")).status_code == 400
    assert (
        await server.get_provider_timeseries("plexar-vllm", range="24h", bucket="3s")
    ).status_code == 400


@pytest.mark.asyncio
async def test_route_404s_for_unknown_provider_and_missing_capability():
    assert (await server.get_provider_timeseries("nope")).status_code == 404
    resp = await server.get_provider_timeseries("lmstudio-local")
    assert resp.status_code == 404
    assert json.loads(resp.body)["error"] == "capability not available"


# ---------------------------------------------------------------------------
# Model control (load / unload) — Plexar shipped the routes 2026-07-31
# ---------------------------------------------------------------------------
#
# Cockpit's control routes are keyed by MODEL (a picker row is a model);
# Plexar's are keyed by INSTANCE, and its catalog can list the same served name
# more than once. So there is a resolution step, and the interesting behaviour
# is what it refuses.

def _catalog(*entries):
    return {"data": [
        {"id": mid, "object": "model", "plexar": {"state": st, "instance_id": iid}}
        for mid, st, iid in entries
    ]}


@pytest.mark.asyncio
async def test_unload_resolves_the_model_to_its_instance(monkeypatch):
    sent = {}
    monkeypatch.setattr(server, "_mgmt_get",
                        lambda p, path: _catalog(("qwen", "serving", "gpu-main")))
    monkeypatch.setattr(
        server.plexar_client, "control_instance",
        lambda url, inst, action, auth=None: sent.update(inst=inst, action=action) or {"ok": True},
    )
    resp = await server.unload_provider_model("plexar-vllm", "qwen")
    assert resp.status_code == 200
    assert sent == {"inst": "gpu-main", "action": "unload"}


@pytest.mark.asyncio
async def test_load_uses_the_load_verb(monkeypatch):
    sent = {}
    monkeypatch.setattr(server, "_mgmt_get",
                        lambda p, path: _catalog(("qwen", "down", "gpu-main")))
    monkeypatch.setattr(
        server.plexar_client, "control_instance",
        lambda url, inst, action, auth=None: sent.update(action=action) or {"ok": True},
    )
    await server.load_provider_model("plexar-vllm", "qwen")
    assert sent["action"] == "load", "an unloaded instance is loaded, not created"


@pytest.mark.asyncio
async def test_an_ambiguous_model_name_is_refused_not_guessed(monkeypatch):
    """Two instances serving one name are different engines on different GPUs.

    Taking the first match would toggle whichever happened to sort first --
    the same class of guess that made the old container name a lie.
    """
    called = []
    monkeypatch.setattr(
        server, "_mgmt_get",
        lambda p, path: _catalog(("qwen", "serving", "gpu-a"), ("qwen", "serving", "gpu-b")),
    )
    monkeypatch.setattr(server.plexar_client, "control_instance",
                        lambda *a: called.append(a))
    resp = await server.unload_provider_model("plexar-vllm", "qwen")

    assert resp.status_code == 409
    assert called == [], "nothing may be controlled while the target is ambiguous"
    assert "will not guess" in json.loads(resp.body)["error"]


@pytest.mark.asyncio
async def test_an_unknown_model_is_a_404(monkeypatch):
    monkeypatch.setattr(server, "_mgmt_get",
                        lambda p, path: _catalog(("qwen", "serving", "gpu-main")))
    resp = await server.unload_provider_model("plexar-vllm", "llama")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_an_unreadable_catalog_does_not_become_a_blind_write(monkeypatch):
    called = []

    def boom(p, path):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(server, "_mgmt_get", boom)
    monkeypatch.setattr(server.plexar_client, "control_instance",
                        lambda *a: called.append(a))
    resp = await server.unload_provider_model("plexar-vllm", "qwen")
    assert resp.status_code == 502
    assert called == []


@pytest.mark.asyncio
async def test_a_failed_control_is_not_reported_as_success(monkeypatch):
    """A toggle that moves while the GPU does nothing is worse than an error."""
    monkeypatch.setattr(server, "_mgmt_get",
                        lambda p, path: _catalog(("qwen", "serving", "gpu-main")))
    monkeypatch.setattr(
        server.plexar_client, "control_instance",
        lambda url, inst, action, auth=None: {"ok": False, "reason": "refused",
                                   "detail": "instance is draining"},
    )
    resp = await server.unload_provider_model("plexar-vllm", "qwen")
    assert resp.status_code == 502
    assert "draining" in json.loads(resp.body)["error"]


def test_delete_is_not_a_verb_cockpit_can_send():
    """`unload` keeps the declaration; DELETE forgets the instance entirely.

    A picker needs a list it can toggle, not one it can destroy, so the
    destructive verb is not reachable from the control path at all.
    """
    import plexar_client as _pc
    assert _pc.CONTROL_ACTIONS == ("load", "unload")
    assert _pc.control_instance("http://x", "i", "delete")["reason"] == "bad_action"


def test_instance_id_survives_normalization():
    out = server._normalize_plexar_raw_model(
        {"id": "qwen", "plexar": {"state": "serving", "instance_id": "gpu-main"}}
    )
    assert out["instance_id"] == "gpu-main"
    assert "instance_id" in server._MODEL_FIELDS, (
        "the field is whitelisted out of the /models response otherwise"
    )


def test_an_unloaded_instance_stays_in_the_catalog_as_not_loaded():
    """Plexar keeps it listed as `state: down` on purpose -- that IS the picker.

    It must not be dressed up as loaded, and must not vanish: a model that is
    unloaded is not a model that does not exist.
    """
    out = server._normalize_plexar_raw_model(
        {"id": "qwen", "plexar": {"state": "down", "instance_id": "gpu-main"}}
    )
    assert out["state"] == "down"


# ---------------------------------------------------------------------------
# Auth — Plexar gates /api/* when remote, as of 2026-07-31
# ---------------------------------------------------------------------------
#
# Two INDEPENDENT layers: a Cloudflare Access service token gets a request past
# the tunnel and no further; the Plexar bearer is the actual identity. Treating
# Access as authentication for Plexar is the documented trap.

AUTH = {"type": "bearer", "bearer": "plx_secret",
        "cf_client_id": "cf-id", "cf_client_secret": "cf-secret"}


def test_both_credential_layers_are_sent():
    h = pc.auth_headers(AUTH)
    assert h["Authorization"] == "Bearer plx_secret"
    assert h["CF-Access-Client-Id"] == "cf-id"
    assert h["CF-Access-Client-Secret"] == "cf-secret"


def test_loopback_with_no_credentials_sends_none():
    """Local loopback is unchanged and needs no bearer -- do not invent one."""
    for empty in (None, {}, {"type": "bearer", "bearer": "", "cf_client_id": ""}):
        h = pc.auth_headers(empty)
        assert "Authorization" not in h
        assert not any(k.startswith("CF-") for k in h)


def test_half_a_service_token_is_not_sent():
    """A lone half is malformed, not partial: it yields a 302-to-login page
    where JSON was expected, which reads as Plexar returning garbage."""
    h = pc.auth_headers({"bearer": "k", "cf_client_id": "only-id"})
    assert not any(k.startswith("CF-") for k in h)
    assert h["Authorization"] == "Bearer k"


def test_401_and_403_are_not_collapsed_into_one_auth_error():
    """Different problems, opposite remedies.

    401 = the credential is wrong or missing. 403 = the credential is FINE and
    the route is not yours. Telling a guest to re-enter a working key is the
    failure this distinction prevents.
    """
    def _raise(code, detail):
        def boom(base, path, auth=None):
            raise _http_error(code, {"detail": detail})
        return boom

    monkey = pc._get
    try:
        pc._get = _raise(401, "bad key")
        assert pc.fetch_reports("http://x", "24h")["reason"] == "unauthorized"
        pc._get = _raise(403, "guests cannot read source-2 figures")
        out = pc.fetch_reports("http://x", "24h")
        assert out["reason"] == "forbidden"
        assert "source-2" in out["detail"], "Plexar's own words explain the refusal"
    finally:
        pc._get = monkey


def test_every_read_forwards_the_credential(monkeypatch):
    """A route that forgets the bearer 401s against a remote Plexar."""
    seen = []

    def spy(base, path, auth=None):
        seen.append(auth)
        raise urllib.error.URLError("stop here")

    monkeypatch.setattr(pc, "_get", spy)
    pc.fetch_status("http://x", AUTH)
    pc.fetch_reports("http://x", "24h", AUTH)
    pc.fetch_timeseries("http://x", "24h", None, None, AUTH)
    pc.fetch_gpus("http://x", AUTH)
    pc.fetch_me("http://x", AUTH)
    assert seen == [AUTH] * 5


# ---------------------------------------------------------------------------
# /api/me
# ---------------------------------------------------------------------------

def test_unauthenticated_is_an_answer_not_an_error(monkeypatch):
    """THE reason to build against /api/me rather than infer from a 401.

    `authenticated: false` distinguishes "wrong credential" from "server down".
    A 401 here would merge two states whose remedies are opposite.
    """
    monkeypatch.setattr(pc, "_get", lambda b, p, a=None: {
        "available": True, "authenticated": False, "identity": None,
        "scopes": {"owner": "full control", "guest": "inference only"}})
    out = pc.fetch_me("http://x")

    assert out["available"] is True, "we DID read Plexar"
    assert out["authenticated"] is False, "which is a fact, not a failure"
    assert out["identity"] is None, "no fabricated anonymous identity"


def test_scope_prose_comes_from_the_server(monkeypatch):
    """Hard-coding what a guest may do goes stale -- it already changed once."""
    monkeypatch.setattr(pc, "_get", lambda b, p, a=None: {
        "available": True, "authenticated": True,
        "identity": {"label": "len", "scope": "owner", "is_owner": True,
                     "scope_description": "full control - everything"},
        "scopes": {"owner": "full control", "guest": "inference only"}})
    out = pc.fetch_me("http://x")

    assert out["identity"]["scope_description"] == "full control - everything"
    assert out["scopes"]["guest"] == "inference only"


def test_identity_route_is_capability_gated():
    assert "identity" in server._PROVIDERS["plexar-vllm"]["capabilities"]


@pytest.mark.asyncio
async def test_identity_route_answers_200_even_unauthenticated(monkeypatch):
    monkeypatch.setattr(server.plexar_client, "fetch_me",
                        lambda url, auth: {"available": True, "authenticated": False})
    resp = await server.get_provider_identity("plexar-vllm")
    assert resp.status_code == 200
    assert json.loads(resp.body)["authenticated"] is False


@pytest.mark.asyncio
async def test_no_credential_ever_reaches_the_browser():
    """Same SSRF/secrets stance as every other provider url and key."""
    resp = await server.get_local_providers()
    dumped = str(json.loads(resp.body) if hasattr(resp, "body") else resp)
    for leak in ("bearer", "cf_client", "Authorization", "auth"):
        assert leak not in dumped, f"{leak!r} must never be serialised to the client"
