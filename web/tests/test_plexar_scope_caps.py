"""A capability is a property of the CREDENTIAL, not of the backend kind.

THE DEFECT. Studio derived a Plexar provider's `capabilities` from its registry
entry alone, so every key was offered every route. A user connecting a
guest-scoped key got Plexar's own refusal prose handed to them:

    "This credential is scoped 'guest' -- inference only -- call the models that
     are currently serving, use the Playground, and read their own usage. Cannot
     change anything ... This route is outside that scope."

MEASURED on the live rig 2026-09-22 with a `model-control` key, which is what
proves this is not only a guest problem:

    /v1/models 200 · /api/me 200 · /api/status 200
    /api/reports/summary 403 · /api/reports/timeseries 403 · /api/planner/gpus 403

The scope name is not inferred: Plexar publishes it at `GET /api/me` as
`identity.scope`. So Studio asks, and narrows.

WHAT THESE TESTS DEFEND, in order of how easily each is broken by a plausible
"simplification":

 1. UNKNOWN NARROWS NOTHING. A probe that could not run tells us nothing about
    what the key may do; hiding a working surface on a failed probe is the same
    false claim about machine state that `authorized` exists to prevent.
 2. Narrowing is a VIEW, not a write. The declared list is what the rig can
    serve and must survive a key change.
 3. A narrowed capability answers the existing 404 "capability not available",
    never a 403 carrying Plexar's prose. That is the whole user-visible point.
 4. The reactive demotion drops exactly the refused capability and nothing else.

Every negative arm has a positive twin, because a build that narrowed EVERYTHING
would satisfy the negatives and break the product -- the failure shape this repo
keeps hitting.
"""

from __future__ import annotations

import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import plexar_client  # noqa: E402
import server as server_module  # noqa: E402
from server import app  # noqa: E402

PID = "plexar-vllm"


@pytest.fixture()
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420")


@pytest.fixture(autouse=True)
def clear_scope_cache():
    """The scope cache is process-global; a stale entry would leak between cases."""
    server_module._plexar_scope_cache.clear()
    declared = list(server_module._PROVIDERS[PID]["capabilities"])
    yield
    server_module._plexar_scope_cache.clear()
    server_module._PROVIDERS[PID]["capabilities"] = declared


def _scope(monkeypatch, scope):
    """Pin the scope probe. It must never dial the network from a test."""
    monkeypatch.setattr(server_module, "_plexar_scope", lambda provider: scope)


# ── the pure mapping ──────────────────────────────────────

DECLARED = ["models", "health", "instances", "reports", "gpus",
            "timeseries", "model-control", "identity"]


def test_owner_keeps_everything():
    assert server_module._capabilities_for_scope(DECLARED, "owner") == DECLARED


def test_model_control_drops_exactly_the_three_measured_403s():
    got = server_module._capabilities_for_scope(DECLARED, "model-control")
    assert set(DECLARED) - set(got) == {"reports", "timeseries", "gpus"}
    # ...and KEEPS the four that were measured 200. Without this half the test
    # passes on a build that returns [].
    for kept in ("models", "health", "identity", "instances"):
        assert kept in got


def test_guest_keeps_the_inference_set():
    got = server_module._capabilities_for_scope(DECLARED, "guest")
    assert "models" in got and "health" in got and "identity" in got
    assert "model-control" not in got  # "Cannot change anything"
    assert "reports" not in got        # "cannot see anyone else's usage"


@pytest.mark.parametrize("scope", [None, "", "some-scope-shipped-after-this-build"])
def test_unknown_scope_narrows_NOTHING(scope):
    """UNKNOWN IS NOT FALSE.

    None is an unreachable/refused probe. An unrecognised name is a scope Plexar
    added after this build -- and a table that predates a scope must not silently
    disable a user's working surfaces. Both fall through to no narrowing; the
    reactive demotion catches a real refusal with one measured 403 instead.
    """
    assert server_module._capabilities_for_scope(DECLARED, scope) == DECLARED


def test_order_is_preserved():
    got = server_module._capabilities_for_scope(DECLARED, "model-control")
    assert got == [c for c in DECLARED if c in got]


# ── the seam ──────────────────────────────────────────────

def test_require_provider_narrows_without_mutating_the_registry(monkeypatch):
    """Narrowing is a VIEW. The declared list says what the RIG can serve and has
    to survive a key change; only a measured 403 edits the registry."""
    _scope(monkeypatch, "guest")
    view = server_module._require_provider(PID)
    assert "reports" not in view["capabilities"]
    assert "reports" in server_module._PROVIDERS[PID]["capabilities"]


def test_require_provider_is_unchanged_for_an_owner(monkeypatch):
    _scope(monkeypatch, "owner")
    view = server_module._require_provider(PID)
    assert view["capabilities"] == server_module._PROVIDERS[PID]["capabilities"]


def test_a_non_plexar_provider_is_never_scope_narrowed(monkeypatch):
    """LM Studio has no credential concept; scope logic must not touch it."""
    _scope(monkeypatch, "guest")
    view = server_module._require_provider("lmstudio-local")
    assert view["capabilities"] == server_module._PROVIDERS["lmstudio-local"]["capabilities"]


# ── what the user actually sees ───────────────────────────

@pytest.mark.asyncio
async def test_a_guest_gets_404_capability_not_available_not_plexar_prose(client, monkeypatch):
    """THE POINT OF THE WHOLE CHANGE.

    Before: Studio called the route and handed back Plexar's "This route is
    outside that scope." After: the surface is not offered at all.
    """
    _scope(monkeypatch, "guest")

    def _boom(*a, **k):  # the route must not even reach Plexar
        raise AssertionError("a narrowed capability must not call the provider")

    monkeypatch.setattr(plexar_client, "fetch_reports", _boom)
    async with client as c:
        res = await c.get(f"/api/local/{PID}/reports")
    assert res.status_code == 404
    assert res.json() == {"error": "capability not available"}


@pytest.mark.asyncio
async def test_the_positive_twin_an_owner_still_reaches_reports(client, monkeypatch):
    """Without this, a build that 404s every capability passes the test above."""
    _scope(monkeypatch, "owner")
    monkeypatch.setattr(plexar_client, "fetch_reports",
                        lambda *a, **k: {"available": True, "totals": {}})
    async with client as c:
        res = await c.get(f"/api/local/{PID}/reports")
    assert res.status_code == 200
    assert res.json()["available"] is True


@pytest.mark.asyncio
async def test_models_stays_reachable_for_a_guest(client, monkeypatch):
    """Inference is the one thing a guest key is FOR. If narrowing broke this it
    would have replaced an annoying error with an unusable product."""
    _scope(monkeypatch, "guest")
    monkeypatch.setattr(server_module, "_mgmt_get",
                        lambda provider, path: {"data": [{"id": "qwen3.8-27b"}]})
    async with client as c:
        res = await c.get(f"/api/local/{PID}/models")
    assert res.status_code == 200
    assert res.json()["reachable"] is True


@pytest.mark.asyncio
async def test_providers_list_reports_the_narrowed_set(client, monkeypatch):
    """The frontend builds its surfaces off this list, so the narrowing has to be
    visible here or the UI renders pages the key cannot use."""
    _scope(monkeypatch, "guest")
    monkeypatch.setattr(server_module, "_probe_responses_api", lambda provider: None)
    async with client as c:
        body = (await c.get("/api/local/providers")).json()
    caps = {p["id"]: p["capabilities"] for p in body["providers"]}
    assert "reports" not in caps[PID] and "gpus" not in caps[PID]
    assert "models" in caps[PID]


# ── the reactive backstop ─────────────────────────────────

def test_a_403_envelope_withdraws_exactly_that_capability():
    """The honest backstop for a table that cannot be fully tested: no guest key
    exists on this machine and Plexar has no self-service minting, so the guest
    row is unverified. A measured 403 outranks it."""
    before = list(server_module._PROVIDERS[PID]["capabilities"])
    out = server_module._demote_forbidden_capability(
        PID, "gpus", {"available": False, "reason": "forbidden"})
    after = server_module._PROVIDERS[PID]["capabilities"]
    assert out["reason"] == "forbidden"          # the payload travels unchanged
    assert "gpus" not in after
    assert set(before) - set(after) == {"gpus"}  # and nothing else went with it


@pytest.mark.parametrize("reason", ["unauthorized", "unreachable", "refused", None])
def test_only_403_demotes(reason):
    """401 is a credential problem whose remedy is to FIX THE KEY, not to hide the
    feature; unreachable says nothing about permissions at all."""
    before = list(server_module._PROVIDERS[PID]["capabilities"])
    server_module._demote_forbidden_capability(PID, "gpus",
                                               {"available": False, "reason": reason})
    assert server_module._PROVIDERS[PID]["capabilities"] == before


def test_a_successful_payload_never_demotes():
    before = list(server_module._PROVIDERS[PID]["capabilities"])
    out = server_module._demote_forbidden_capability(PID, "gpus", {"available": True, "gpus": []})
    assert out["available"] is True
    assert server_module._PROVIDERS[PID]["capabilities"] == before


# ── the defect this change itself introduced, pinned ──────

def test_require_provider_NEVER_dials_the_network(monkeypatch):
    """`_require_provider` is SYNC and runs inline on the event loop.

    The first draft of this change put a blocking `/api/me` probe behind it, so
    every `/api/local/*` route would have parked the single event loop for up to
    the provider timeout. That is the precise class of defect behind the
    2026-09-11 terminal-disconnect incident -- a loop-blocking call on a route
    path, every pane dropped -- and it shipped past a green unit suite. It was
    caught only because the probe dialled the REAL rig from inside the timeseries
    tests and narrowed a capability out from under them.

    So: the scope read is cache-only, and this test fails the moment anyone makes
    it dial again.
    """
    def _no_network(*a, **k):
        raise AssertionError("_require_provider must never perform I/O")

    monkeypatch.setattr(plexar_client, "fetch_me", _no_network)
    server_module._plexar_scope_cache.clear()
    view = server_module._require_provider(PID)
    # Cold cache == UNKNOWN == no narrowing, which is the safe direction.
    assert view["capabilities"] == server_module._PROVIDERS[PID]["capabilities"]


def test_refresh_populates_the_cache_that_require_provider_reads(monkeypatch):
    """The positive twin: cache-only is useless if nothing ever fills it."""
    monkeypatch.setattr(plexar_client, "fetch_me",
                        lambda url, auth: {"identity": {"scope": "guest"}})
    server_module._plexar_scope_cache.clear()
    prov = server_module._require_provider(PID)
    server_module._plexar_scope_refresh(prov)
    assert "reports" not in server_module._require_provider(PID)["capabilities"]


def test_refresh_accepts_an_already_fetched_me_without_a_second_call(monkeypatch):
    """The identity route has /api/me in hand; the scope must ride it."""
    def _boom(*a, **k):
        raise AssertionError("passing `me` must not trigger another fetch")

    monkeypatch.setattr(plexar_client, "fetch_me", _boom)
    server_module._plexar_scope_cache.clear()
    prov = server_module._require_provider(PID)
    assert server_module._plexar_scope_refresh(prov, {"identity": {"scope": "owner"}}) == "owner"


def test_a_me_body_with_no_scope_is_unknown_not_empty(monkeypatch):
    """An unauthenticated or shape-changed /api/me states no scope. That is
    UNKNOWN, and unknown narrows nothing -- never 'no capabilities'."""
    server_module._plexar_scope_cache.clear()
    prov = server_module._require_provider(PID)
    assert server_module._plexar_scope_refresh(prov, {"authenticated": False}) is None
    assert server_module._require_provider(PID)["capabilities"] == \
        server_module._PROVIDERS[PID]["capabilities"]
