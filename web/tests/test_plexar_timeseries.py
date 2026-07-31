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
    monkeypatch.setattr(pc, "_get", lambda base, path: PAYLOAD)
    out = pc.fetch_timeseries("http://x", "24h")

    assert out["available"] is True
    assert set(out["series"]) == {"gateway-requests", "vllm-prometheus"}
    assert out["series"]["gateway-requests"]["window_exact"] is True
    assert out["series"]["vllm-prometheus"]["window_exact"] is False, (
        "a Prometheus counter is cumulative since engine start; losing that "
        "flag is how two defensible series become one indefensible line"
    )


def test_an_empty_bucket_keeps_its_measured_zero_and_its_nulls(monkeypatch):
    monkeypatch.setattr(pc, "_get", lambda base, path: PAYLOAD)
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
    monkeypatch.setattr(pc, "_get", lambda base, path: {**PAYLOAD, "truncated": True})
    assert pc.fetch_timeseries("http://x", "lifetime")["truncated"] is True


def test_short_ranges_the_summary_route_lacks_are_accepted(monkeypatch):
    seen = []
    monkeypatch.setattr(pc, "_get", lambda base, path: seen.append(path) or PAYLOAD)
    for r in ("1h", "6h"):
        assert pc.fetch_timeseries("http://x", r)["available"] is True
    assert any("range=1h" in p for p in seen)


def test_bad_range_and_bucket_are_refused_before_the_network(monkeypatch):
    called = []
    monkeypatch.setattr(pc, "_get", lambda base, path: called.append(path))

    assert pc.fetch_timeseries("http://x", "yesterday")["reason"] == "bad_range"
    assert pc.fetch_timeseries("http://x", "24h", bucket="3s")["reason"] == "bad_bucket"
    assert called == [], "an invalid request must not reach Plexar"


def test_bucket_and_instance_filter_reach_plexar(monkeypatch):
    seen = []
    monkeypatch.setattr(pc, "_get", lambda base, path: seen.append(path) or PAYLOAD)
    pc.fetch_timeseries("http://x", "24h", bucket="1h", instance_id="gpu-main")
    assert "bucket=1h" in seen[0] and "instance_id=gpu-main" in seen[0]


def test_omitted_bucket_is_left_to_plexar(monkeypatch):
    """Plexar derives the bucket from the range AND owns the 720-point rule."""
    seen = []
    monkeypatch.setattr(pc, "_get", lambda base, path: seen.append(path) or PAYLOAD)
    pc.fetch_timeseries("http://x", "7d")
    assert "bucket=" not in seen[0]


def test_a_refusal_is_reported_as_a_refusal_not_as_unreachable(monkeypatch):
    """THE trap: HTTPError is a subclass of URLError.

    A bare `except URLError` swallows Plexar's 400 — the one it raises rather
    than silently truncate a series — and reports a live service as down.
    """
    def refuse(base, path):
        raise _http_error(400, {"detail": "bucket would produce 8760 points"})

    monkeypatch.setattr(pc, "_get", refuse)
    out = pc.fetch_timeseries("http://x", "30d", bucket="1m")

    assert out["available"] is False
    assert out["reason"] == "refused", "Plexar answered; it just said no"
    assert "8760 points" in out["detail"], "its stated reason must survive"


def test_genuinely_unreachable_still_reads_as_unreachable(monkeypatch):
    def boom(base, path):
        raise urllib.error.URLError("refused")

    monkeypatch.setattr(pc, "_get", boom)
    assert pc.fetch_timeseries("http://x", "24h")["reason"] == "unreachable"


def test_wrong_shaped_payload_is_rejected(monkeypatch):
    for bad in (None, "nope", {}, {"series": []}):
        monkeypatch.setattr(pc, "_get", lambda base, path, b=bad: b)
        out = pc.fetch_timeseries("http://x", "24h")
        assert out["available"] is False
        assert out["reason"] == "bad_response"


def test_summary_route_also_distinguishes_a_refusal(monkeypatch):
    """Same fix, applied to the sibling route that had the same bug."""
    def refuse(base, path):
        raise _http_error(400, {"detail": "range must be one of [...]"})

    monkeypatch.setattr(pc, "_get", refuse)
    assert pc.fetch_reports("http://x", "24h")["reason"] == "refused"


# ---------------------------------------------------------------------------
# The route
# ---------------------------------------------------------------------------

def test_plexar_advertises_timeseries_but_lmstudio_does_not():
    assert "timeseries" in server._PROVIDERS["plexar"]["capabilities"]
    assert "timeseries" not in server._PROVIDERS["lmstudio-local"]["capabilities"], (
        "a capability is a promise the route will answer; the lane broker "
        "serves no bucketed history"
    )


@pytest.mark.asyncio
async def test_route_passes_the_series_through(monkeypatch):
    monkeypatch.setattr(
        server.plexar_client, "fetch_timeseries",
        lambda url, rng, bucket, inst: {"available": True, "series": PAYLOAD["series"]},
    )
    resp = await server.get_provider_timeseries("plexar", range="24h")
    body = json.loads(resp.body)
    assert set(body["series"]) == {"gateway-requests", "vllm-prometheus"}


@pytest.mark.asyncio
async def test_route_rejects_a_bad_range_and_bucket_loudly():
    """An envelope is for a service that failed. A bad param is the caller's."""
    assert (await server.get_provider_timeseries("plexar", range="nope")).status_code == 400
    assert (
        await server.get_provider_timeseries("plexar", range="24h", bucket="3s")
    ).status_code == 400


@pytest.mark.asyncio
async def test_route_404s_for_unknown_provider_and_missing_capability():
    assert (await server.get_provider_timeseries("nope")).status_code == 404
    resp = await server.get_provider_timeseries("lmstudio-local")
    assert resp.status_code == 404
    assert json.loads(resp.body)["error"] == "capability not available"
