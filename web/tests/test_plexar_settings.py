"""Plexar-vLLM URL + key as CONFIGURATION, not a .env beside the source.

The gap this closes was found the hard way: the key was put in `web/.env`,
which is loaded relative to the working directory and is not bundled by
PyInstaller. It therefore reached `python server.py` and never reached the
installed desktop app. A credential a packaged user cannot set is not
configuration, it is a dead end.

So the key joins the same mechanism as the OpenRouter and Anthropic keys
(config.json in the data dir, UI beats env), and the URL joins settings.json
because it is not a secret.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server as server_module  # noqa: E402
import settings_store  # noqa: E402
from server import app  # noqa: E402


@pytest.fixture()
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Point config + settings at tmp_path. Without this a test would write
    the developer's real key into their real config."""
    # Same isolation the existing settings tests use — the module exposes
    # CONFIG_FILE / SETTINGS_FILE, not *_PATH.
    monkeypatch.setattr(settings_store, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    for var in ("COCKPIT_PLEXAR_KEY", "COCKPIT_PLEXAR_URL",
                "COCKPIT_PLEXAR_CF_CLIENT_ID", "COCKPIT_PLEXAR_CF_CLIENT_SECRET"):
        monkeypatch.delenv(var, raising=False)
    yield tmp_path


# ---------------------------------------------------------------------------
# The secret never round-trips
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_saved_key_is_reported_masked_and_never_returned(client):
    await client.post("/api/settings/plexar",
                      json={"key": "plx_abcdefghijklmnopqrstuvwxyz"})
    body = (await client.get("/api/settings/plexar")).json()

    assert body["configured"] is True
    assert body["source"] == "ui"
    assert "plx_abcdefghijklmnopqrstuvwxyz" not in json.dumps(body), (
        "the key must never travel back to the browser"
    )
    assert body["masked"]


@pytest.mark.asyncio
async def test_configured_is_not_the_same_claim_as_accepted(client):
    """Whether the key WORKS is what /identity answers.

    Conflating them makes a rejected key read as a missing one, and sends the
    user to re-enter something that was typed correctly.
    """
    await client.post("/api/settings/plexar", json={"key": "plx_whatever"})
    body = (await client.get("/api/settings/plexar")).json()
    assert "authenticated" not in body


# ---------------------------------------------------------------------------
# Precedence and the packaged-app case
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_ui_key_beats_the_environment(client, monkeypatch):
    monkeypatch.setenv("COCKPIT_PLEXAR_KEY", "from-env")
    await client.post("/api/settings/plexar", json={"key": "from-ui"})
    key, source = settings_store.resolve_provider_key("plexar")
    assert (key, source) == ("from-ui", "ui")


@pytest.mark.asyncio
async def test_an_env_key_is_used_when_nothing_was_entered(client, monkeypatch):
    monkeypatch.setenv("COCKPIT_PLEXAR_KEY", "from-env")
    body = (await client.get("/api/settings/plexar")).json()
    assert body["configured"] is True and body["source"] == "env"


@pytest.mark.asyncio
async def test_an_env_key_cannot_be_deleted_from_here(client, monkeypatch):
    """The server does not own the caller's environment. Reporting success
    while the key stays in force would be a lie."""
    monkeypatch.setenv("COCKPIT_PLEXAR_KEY", "from-env")
    body = (await client.delete("/api/settings/plexar")).json()
    assert body["ok"] is False
    assert "environment variable" in body["error"]


# ---------------------------------------------------------------------------
# URL
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_the_public_url_can_be_stored(client):
    await client.post("/api/settings/plexar",
                      json={"base_url": "https://engine.example.test/"})
    body = (await client.get("/api/settings/plexar")).json()
    # Trailing slash normalised — otherwise every path join doubles it.
    assert body["base_url"] == "https://engine.example.test"


@pytest.mark.asyncio
async def test_clearing_the_url_falls_back_rather_than_being_refused(client, monkeypatch):
    """An empty string is MEANINGFUL: it undoes the override. Refusing it would
    make a stored URL impossible to remove from the UI."""
    monkeypatch.setenv("COCKPIT_PLEXAR_URL", "http://127.0.0.1:8760")
    await client.post("/api/settings/plexar", json={"base_url": "https://example.com"})
    await client.post("/api/settings/plexar", json={"base_url": ""})
    assert (await client.get("/api/settings/plexar")).json()["base_url"] == "http://127.0.0.1:8760"


@pytest.mark.asyncio
async def test_a_url_without_a_scheme_is_refused(client):
    res = await client.post("/api/settings/plexar",
                            json={"base_url": "engine.example.test"})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_defaults_to_loopback_when_nothing_is_configured(client):
    assert (await client.get("/api/settings/plexar")).json()["base_url"] == "http://127.0.0.1:8760"


# ---------------------------------------------------------------------------
# The provider picks it up WITHOUT a restart
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_the_provider_picks_up_a_new_key_without_a_restart(client):
    """A value read once at import means a freshly-entered key does nothing
    until the app restarts — which reads as "the key does not work"."""
    await client.post("/api/settings/plexar",
                      json={"key": "plx_live", "base_url": "https://example.test"})

    provider = server_module._require_provider("plexar-vllm")
    assert provider["auth"]["bearer"] == "plx_live"
    assert provider["management_url"] == "https://example.test"


@pytest.mark.asyncio
async def test_no_credential_reaches_the_browser_via_the_providers_list(client):
    await client.post("/api/settings/plexar", json={"key": "plx_secret_value"})
    dumped = (await client.get("/api/local/providers")).text
    assert "plx_secret_value" not in dumped
    assert "bearer" not in dumped.lower()


@pytest.mark.asyncio
async def test_half_a_cloudflare_token_is_still_never_sent(client, monkeypatch):
    """Access is being retired, but the rule outlives it: a lone id or secret
    is malformed rather than partial, and yields an HTML login page where JSON
    was expected."""
    monkeypatch.setenv("COCKPIT_PLEXAR_CF_CLIENT_ID", "only-the-id")
    _url, auth = server_module._plexar_config()
    import plexar_client
    headers = plexar_client.auth_headers(auth)
    assert not any(h.startswith("CF-") for h in headers)


# ---------------------------------------------------------------------------
# The credential must ride on EVERY path, not just plexar_client's
# ---------------------------------------------------------------------------

def test_the_management_getter_sends_the_credential(monkeypatch):
    """THE bug this closes: _mgmt_get predates authenticated providers and sent
    only an Accept header.

    So /models and /health reached an authenticated Plexar anonymously, got a
    401, and reported a healthy engine as UNREACHABLE -- while /identity, which
    goes through plexar_client, authenticated fine. Two routes disagreeing about
    the same server was the symptom.
    """
    seen = {}

    class _Resp:
        def read(self):
            return b'{"data": []}'

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class _Opener:
        def open(self, req, timeout=None):
            seen["headers"] = dict(req.header_items())
            return _Resp()

    monkeypatch.setattr(server_module, "_NO_REDIRECT_OPENER", _Opener())
    provider = {
        "management_url": "http://x",
        "auth": {"type": "bearer", "bearer": "plx_live",
                 "cf_client_id": "", "cf_client_secret": ""},
    }
    server_module._mgmt_get(provider, "/v1/models")

    lowered = {k.lower(): v for k, v in seen["headers"].items()}
    assert lowered.get("authorization") == "Bearer plx_live"


def test_a_provider_without_auth_is_unchanged(monkeypatch):
    """LM Studio and the lane broker have no credential; adding one must not
    start sending an empty Authorization header."""
    seen = {}

    class _Resp:
        def read(self):
            return b"{}"

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    class _Opener:
        def open(self, req, timeout=None):
            seen["headers"] = {k.lower() for k in dict(req.header_items())}
            return _Resp()

    monkeypatch.setattr(server_module, "_NO_REDIRECT_OPENER", _Opener())
    server_module._mgmt_get({"management_url": "http://x"}, "/models")
    assert "authorization" not in seen["headers"]
