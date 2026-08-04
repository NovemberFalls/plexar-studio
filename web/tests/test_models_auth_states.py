"""S9 UI arm — GET /api/local/{provider}/models must distinguish THREE states.

The defect this pins: `_mgmt_get` raises `urllib.error.HTTPError` on a 401, and
`HTTPError` is a subclass of `Exception`, so the handler's bare `except
Exception` reported a rig that was UP AND REFUSING THE CREDENTIAL as
`{"reachable": false, "reason": "unreachable"}` — a false claim about machine
state, and identical to the answer given for a rig that is genuinely down.

`plexar_client._refused` already had this exact reasoning written down for the
reporting routes ("a bare except URLError swallows a 400 and reports it as
unreachable -- which is a false claim about a service that is up"). The model
picker's own path never got it. These tests are what stops it coming back.

THE THREE STATES, which must never collapse into each other:
  1. up + credential accepted  -> reachable, authorized, models listed
  2. up + credential refused   -> REACHABLE, authorized:false, reason+action
  3. down                      -> not reachable, reason "unreachable", 503
"""
import io
import sys
import urllib.error
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server as server_module  # noqa: E402
from server import app  # noqa: E402

PROVIDER = "plexar-vllm"


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.fixture(autouse=True)
def _no_disk_scan(monkeypatch):
    """The disk-scan branch is a THIRD shape and would mask the states here.

    `_scan_vllm_models_dir` only runs for kind == "vllm" (Plexar is kind
    "plexar"), but pinning it empty means these tests keep testing what they
    say they test if that ever changes.
    """
    monkeypatch.setattr(server_module, "_scan_vllm_models_dir", lambda: [])
    yield


def _http_error(code):
    """A realistic HTTPError: it carries a readable body, like the real one."""
    return urllib.error.HTTPError(
        url="http://127.0.0.1:8760/v1/models",
        code=code,
        msg="Unauthorized" if code == 401 else "Forbidden",
        hdrs=None,
        fp=io.BytesIO(b'{"error":{"code":"unauthorized"}}'),
    )


# ── STATE 1: up, credential accepted ────────────────────────────────────────

@pytest.mark.asyncio
async def test_state1_authorized_lists_models(client, monkeypatch):
    monkeypatch.setattr(
        server_module, "_mgmt_get",
        lambda provider, path: {"data": [{"id": "qwen3-30b-instruct"}]},
    )
    res = await client.get(f"/api/local/{PROVIDER}/models")
    assert res.status_code == 200
    body = res.json()
    assert body["reachable"] is True
    # Absence of the negative flag is what the picker keys on.
    assert body.get("authorized") is not False
    assert [m["id"] for m in body["models"]] == ["qwen3-30b-instruct"]


# ── STATE 2: up, credential refused ─────────────────────────────────────────

@pytest.mark.asyncio
async def test_state2_401_is_reachable_but_unauthorized(client, monkeypatch):
    def boom(provider, path):
        raise _http_error(401)

    monkeypatch.setattr(server_module, "_mgmt_get", boom)
    res = await client.get(f"/api/local/{PROVIDER}/models")
    assert res.status_code == 200
    body = res.json()
    # THE HEART OF IT. The rig answered, so claiming otherwise is a lie about
    # machine state and sends the user to debug a network they can reach.
    assert body["reachable"] is True
    assert body["authorized"] is False
    assert body["reason"] == "unauthorized"
    # An action, not just a diagnosis. "Says what to DO" is the house rule.
    assert "Settings" in body["action"] or "COCKPIT_PLEXAR_KEY" in body["action"]


@pytest.mark.asyncio
async def test_state2b_403_is_not_the_same_remedy_as_401(client, monkeypatch):
    """403 must not be folded into 401.

    Telling a user whose key is VALID to go re-enter their key sends them to
    fix the one thing that is not broken. Same reasoning as
    `plexar_client._refused`, which already separates these two.
    """
    def boom(provider, path):
        raise _http_error(403)

    monkeypatch.setattr(server_module, "_mgmt_get", boom)
    body = (await client.get(f"/api/local/{PROVIDER}/models")).json()
    assert body["reachable"] is True
    assert body["authorized"] is False
    assert body["reason"] == "forbidden"
    assert body["reason"] != "unauthorized"


# ── STATE 3: down ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_state3_down_is_unreachable_and_differs_from_both(client, monkeypatch):
    def boom(provider, path):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_mgmt_get", boom)
    res = await client.get(f"/api/local/{PROVIDER}/models")
    assert res.status_code == 503
    body = res.json()
    assert body["reachable"] is False
    assert body["reason"] == "unreachable"
    assert "authorized" not in body


# ── THE POINT: all three are mutually distinguishable ───────────────────────

@pytest.mark.asyncio
async def test_the_three_states_are_pairwise_distinct(client, monkeypatch):
    """A regression here is the whole defect returning, so assert it directly.

    Each arm is compared against the OTHER TWO, not merely against its own
    expected value — that is what "watched to fail" means for a
    collapse-of-states bug: the failure mode is two arms becoming EQUAL, which
    per-arm assertions can still pass through.
    """
    seen = {}

    def run(name, raiser):
        monkeypatch.setattr(server_module, "_mgmt_get", raiser)
        return name

    cases = {
        "ok": lambda provider, path: {"data": [{"id": "qwen3-30b-instruct"}]},
        "refused": lambda provider, path: (_ for _ in ()).throw(_http_error(401)),
        "down": lambda provider, path: (_ for _ in ()).throw(OSError("refused")),
    }
    for name, fn in cases.items():
        monkeypatch.setattr(server_module, "_mgmt_get", fn)
        res = await client.get(f"/api/local/{PROVIDER}/models")
        body = res.json()
        seen[name] = (res.status_code, body.get("reachable"), body.get("authorized"),
                      body.get("reason"))

    assert seen["ok"] != seen["refused"]
    assert seen["ok"] != seen["down"]
    # The one that was actually broken: refused and down were byte-identical.
    assert seen["refused"] != seen["down"]
