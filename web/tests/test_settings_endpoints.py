"""Tests for OpenRouter settings storage (web/settings_store.py) and the
FastAPI settings endpoints added to server.py:

  GET    /api/settings/openrouter   — report configured/source/masked
  POST   /api/settings/openrouter   — validate + persist a UI-supplied key
  DELETE /api/settings/openrouter   — remove the UI-supplied key

All endpoint tests use httpx AsyncClient + ASGITransport matching the
existing test_server.py / test_bridge_endpoints.py pattern. The real
OpenRouter network call (server._validate_openrouter_key) is always
monkeypatched — no test in this file hits the network.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from server import app
import server as server_module
import settings_store


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.fixture()
def isolated_config(tmp_path, monkeypatch):
    """Point settings_store at a throwaway config dir for this test only."""
    config_dir = tmp_path / ".claude-cockpit"
    config_file = config_dir / "config.json"
    monkeypatch.setattr(settings_store, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", config_file)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    return config_dir, config_file


# ---------------------------------------------------------------------------
# settings_store — roundtrip
# ---------------------------------------------------------------------------


def test_store_roundtrip_set_get_delete(isolated_config):
    config_dir, config_file = isolated_config

    assert settings_store.get_ui_key() is None

    settings_store.set_ui_key("sk-or-v1-abcdefghijklmno")
    assert settings_store.get_ui_key() == "sk-or-v1-abcdefghijklmno"
    assert config_file.is_file()

    # Persisted as valid JSON with the expected field name.
    on_disk = json.loads(config_file.read_text(encoding="utf-8"))
    assert on_disk == {"openrouter_api_key": "sk-or-v1-abcdefghijklmno"}

    removed = settings_store.delete_ui_key()
    assert removed is True
    assert settings_store.get_ui_key() is None


def test_store_delete_when_nothing_configured_returns_false(isolated_config):
    assert settings_store.delete_ui_key() is False


def test_store_set_overwrites_previous_key(isolated_config):
    settings_store.set_ui_key("first-key-value-123")
    settings_store.set_ui_key("second-key-value-456")
    assert settings_store.get_ui_key() == "second-key-value-456"


def test_store_creates_config_dir_on_demand(isolated_config):
    config_dir, _ = isolated_config
    assert not config_dir.exists()
    settings_store.set_ui_key("some-key-value")
    assert config_dir.is_dir()


def test_store_handles_corrupt_json_gracefully(isolated_config, caplog):
    config_dir, config_file = isolated_config
    config_dir.mkdir(parents=True)
    config_file.write_text("{not valid json!!", encoding="utf-8")

    # Corrupt file must not raise — treated as empty.
    assert settings_store.get_ui_key() is None

    # A subsequent set() must still succeed and overwrite the corrupt file.
    settings_store.set_ui_key("recovered-key-value")
    assert settings_store.get_ui_key() == "recovered-key-value"


def test_store_handles_non_object_json_gracefully(isolated_config):
    config_dir, config_file = isolated_config
    config_dir.mkdir(parents=True)
    config_file.write_text("[1, 2, 3]", encoding="utf-8")
    assert settings_store.get_ui_key() is None


def test_store_handles_missing_file_gracefully(isolated_config):
    # No file was ever created.
    assert settings_store.get_ui_key() is None
    assert settings_store.delete_ui_key() is False


# ---------------------------------------------------------------------------
# settings_store — resolution precedence
# ---------------------------------------------------------------------------


def test_resolve_ui_beats_env(isolated_config, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-key-value-xyz")
    settings_store.set_ui_key("ui-key-value-abc")
    key, source = settings_store.resolve_openrouter_key()
    assert key == "ui-key-value-abc"
    assert source == "ui"


def test_resolve_env_used_when_no_ui_key(isolated_config, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "env-key-value-xyz")
    key, source = settings_store.resolve_openrouter_key()
    assert key == "env-key-value-xyz"
    assert source == "env"


def test_resolve_none_when_neither_configured(isolated_config):
    key, source = settings_store.resolve_openrouter_key()
    assert (key, source) == (None, None)


def test_resolve_env_empty_string_treated_as_unset(isolated_config, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "")
    key, source = settings_store.resolve_openrouter_key()
    assert (key, source) == (None, None)


# ---------------------------------------------------------------------------
# settings_store — mask_key
# ---------------------------------------------------------------------------


def test_mask_key_normal_length_shows_only_prefix_and_suffix():
    key = "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890"
    masked = settings_store.mask_key(key)
    assert masked.startswith(key[:8])
    assert masked.endswith(key[-4:])
    # None of the middle content may leak into the masked output.
    middle = key[8:-4]
    assert middle not in masked
    assert "…" in masked
    assert masked != key


def test_mask_key_short_key_fully_masked():
    short_key = "short-key12"  # < 14 chars
    masked = settings_store.mask_key(short_key)
    assert masked == "…"
    # No substring of the real key of length >= 2 should appear.
    for i in range(len(short_key) - 1):
        assert short_key[i:i + 2] not in masked


def test_mask_key_empty_string():
    assert settings_store.mask_key("") == ""


def test_mask_key_boundary_length_14():
    key = "12345678901234"  # exactly 14 chars
    masked = settings_store.mask_key(key)
    assert masked == f"{key[:8]}…{key[-4:]}"


# ---------------------------------------------------------------------------
# GET /api/settings/openrouter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_settings_not_configured(client, monkeypatch):
    monkeypatch.setattr(settings_store, "resolve_openrouter_key", lambda: (None, None))
    res = await client.get("/api/settings/openrouter")
    assert res.status_code == 200
    assert res.json() == {"configured": False, "source": None, "masked": None}


@pytest.mark.asyncio
async def test_get_settings_configured_via_ui(client, monkeypatch):
    fake_key = "sk-or-v1-abcdefghijklmnopqrstuvwxyz"
    monkeypatch.setattr(settings_store, "resolve_openrouter_key", lambda: (fake_key, "ui"))
    res = await client.get("/api/settings/openrouter")
    assert res.status_code == 200
    data = res.json()
    assert data["configured"] is True
    assert data["source"] == "ui"
    assert data["masked"] == settings_store.mask_key(fake_key)
    assert fake_key not in json.dumps(data)


@pytest.mark.asyncio
async def test_get_settings_configured_via_env(client, monkeypatch):
    fake_key = "env-key-abcdefghijklmno"
    monkeypatch.setattr(settings_store, "resolve_openrouter_key", lambda: (fake_key, "env"))
    res = await client.get("/api/settings/openrouter")
    assert res.status_code == 200
    data = res.json()
    assert data["configured"] is True
    assert data["source"] == "env"
    assert data["masked"] == settings_store.mask_key(fake_key)


# ---------------------------------------------------------------------------
# POST /api/settings/openrouter — validation (no network call)
# ---------------------------------------------------------------------------


def _forbid_validation_call(monkeypatch):
    """Install a validator stub that fails the test if it's ever invoked."""
    def _boom(key):
        raise AssertionError("Validator must not be called for invalid-format keys")
    monkeypatch.setattr(server_module, "_validate_openrouter_key", _boom)


@pytest.mark.asyncio
async def test_post_settings_empty_key_returns_400_without_network_call(client, monkeypatch):
    _forbid_validation_call(monkeypatch)
    res = await client.post("/api/settings/openrouter", json={"key": ""})
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_post_settings_whitespace_only_key_returns_400(client, monkeypatch):
    _forbid_validation_call(monkeypatch)
    res = await client.post("/api/settings/openrouter", json={"key": "   "})
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_post_settings_key_with_internal_whitespace_returns_400(client, monkeypatch):
    _forbid_validation_call(monkeypatch)
    res = await client.post("/api/settings/openrouter", json={"key": "sk-or bad key"})
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_post_settings_non_string_key_returns_400(client, monkeypatch):
    _forbid_validation_call(monkeypatch)
    res = await client.post("/api/settings/openrouter", json={"key": 12345})
    assert res.status_code == 400
    assert res.json()["ok"] is False


@pytest.mark.asyncio
async def test_post_settings_missing_key_returns_400(client, monkeypatch):
    _forbid_validation_call(monkeypatch)
    res = await client.post("/api/settings/openrouter", json={})
    assert res.status_code == 400
    assert res.json()["ok"] is False


# ---------------------------------------------------------------------------
# POST /api/settings/openrouter — happy path / rejected / network failure
# (validator monkeypatched; no real network access)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_settings_happy_path_saves_key(client, monkeypatch, isolated_config):
    async def _noop():
        pass

    def fake_validate(key):
        assert key == "sk-or-v1-validkey1234567890"
        return {"status": "ok", "credits_remaining": 12.5}

    monkeypatch.setattr(server_module, "_validate_openrouter_key", fake_validate)

    res = await client.post("/api/settings/openrouter", json={"key": "sk-or-v1-validkey1234567890"})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["credits_remaining"] == 12.5
    assert data["masked"] == settings_store.mask_key("sk-or-v1-validkey1234567890")
    assert "sk-or-v1-validkey1234567890" not in json.dumps(data)

    # Key must actually be persisted.
    assert settings_store.get_ui_key() == "sk-or-v1-validkey1234567890"


@pytest.mark.asyncio
async def test_post_settings_rejected_key_returns_400_and_does_not_save(client, monkeypatch, isolated_config):
    def fake_validate(key):
        return {"status": "rejected", "credits_remaining": None}

    monkeypatch.setattr(server_module, "_validate_openrouter_key", fake_validate)

    res = await client.post("/api/settings/openrouter", json={"key": "sk-or-v1-badkey1234567890"})
    assert res.status_code == 400
    data = res.json()
    assert data["ok"] is False
    assert "error" in data

    # A rejected key must never be persisted.
    assert settings_store.get_ui_key() is None


@pytest.mark.asyncio
async def test_post_settings_network_failure_returns_502_and_does_not_save(client, monkeypatch, isolated_config):
    def fake_validate(key):
        return {"status": "network_error", "credits_remaining": None}

    monkeypatch.setattr(server_module, "_validate_openrouter_key", fake_validate)

    res = await client.post("/api/settings/openrouter", json={"key": "sk-or-v1-somekey1234567890"})
    assert res.status_code == 502
    data = res.json()
    assert data["ok"] is False
    assert "error" in data
    assert settings_store.get_ui_key() is None


# ---------------------------------------------------------------------------
# DELETE /api/settings/openrouter
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_settings_clears_ui_key_no_env_fallback(client, monkeypatch, isolated_config):
    settings_store.set_ui_key("ui-key-to-remove-123")
    res = await client.delete("/api/settings/openrouter")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["configured"] is False
    assert data["source"] is None
    assert settings_store.get_ui_key() is None


@pytest.mark.asyncio
async def test_delete_settings_clears_ui_key_reports_env_fallback(client, monkeypatch, isolated_config):
    settings_store.set_ui_key("ui-key-to-remove-456")
    monkeypatch.setenv("OPENROUTER_API_KEY", "fallback-env-key-789")

    res = await client.delete("/api/settings/openrouter")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["configured"] is True
    assert data["source"] == "env"
    assert settings_store.get_ui_key() is None


@pytest.mark.asyncio
async def test_delete_settings_when_nothing_configured_is_still_ok(client, isolated_config):
    res = await client.delete("/api/settings/openrouter")
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] is True
    assert data["configured"] is False


# ---------------------------------------------------------------------------
# Anthropic key -- GET/POST/DELETE /api/settings/anthropic
#
# Same contract as the OpenRouter routes above. The key lives in config.json
# (secrets), never settings.json (exportable), and no route may ever emit an
# unmasked key.
# ---------------------------------------------------------------------------

_ANTHROPIC_KEY = "sk-ant-api03-AAAAbbbbCCCCddddEEEEffff"


@pytest.fixture()
def isolated_anthropic(isolated_config, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    return isolated_config


def test_anthropic_store_roundtrip(isolated_anthropic):
    config_dir, config_file = isolated_anthropic

    assert settings_store.get_provider_ui_key("anthropic") is None
    settings_store.set_provider_ui_key("anthropic", _ANTHROPIC_KEY)
    assert settings_store.get_provider_ui_key("anthropic") == _ANTHROPIC_KEY

    # Stored in config.json under its own field, beside the OpenRouter key.
    on_disk = json.loads(config_file.read_text(encoding="utf-8"))
    assert on_disk == {"anthropic_api_key": _ANTHROPIC_KEY}

    assert settings_store.delete_provider_ui_key("anthropic") is True
    assert settings_store.get_provider_ui_key("anthropic") is None
    assert settings_store.delete_provider_ui_key("anthropic") is False


def test_anthropic_key_never_lands_in_settings_json(isolated_anthropic, tmp_path, monkeypatch):
    settings_file = tmp_path / ".claude-cockpit" / "settings.json"
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", settings_file)
    settings_store.set_provider_ui_key("anthropic", _ANTHROPIC_KEY)
    blob = json.dumps(settings_store.read_settings())
    assert _ANTHROPIC_KEY not in blob


def test_anthropic_ui_key_beats_env(isolated_anthropic, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-env-key-000111222333")
    settings_store.set_provider_ui_key("anthropic", _ANTHROPIC_KEY)
    key, source = settings_store.resolve_anthropic_key()
    assert (key, source) == (_ANTHROPIC_KEY, "ui")


@pytest.mark.asyncio
async def test_anthropic_get_reports_unconfigured(client, isolated_anthropic):
    res = await client.get("/api/settings/anthropic")
    assert res.status_code == 200
    assert res.json() == {"configured": False, "source": None, "masked": None}


@pytest.mark.asyncio
async def test_anthropic_post_get_delete_roundtrip(client, isolated_anthropic):
    res = await client.post("/api/settings/anthropic", json={"key": _ANTHROPIC_KEY})
    assert res.status_code == 200
    assert res.json()["ok"] is True

    res = await client.get("/api/settings/anthropic")
    body = res.json()
    assert body["configured"] is True
    assert body["source"] == "ui"
    assert body["masked"] == settings_store.mask_key(_ANTHROPIC_KEY)

    res = await client.delete("/api/settings/anthropic")
    assert res.json()["ok"] is True
    assert res.json()["configured"] is False
    assert settings_store.get_provider_ui_key("anthropic") is None


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [
    {"key": ""},
    {"key": "   "},
    {"key": "has space in it"},
    {"key": 12345},
    {},
])
async def test_anthropic_post_rejects_bad_bodies(client, isolated_anthropic, body):
    res = await client.post("/api/settings/anthropic", json=body)
    assert res.status_code == 400
    assert settings_store.get_provider_ui_key("anthropic") is None


@pytest.mark.asyncio
async def test_anthropic_delete_refuses_honestly_for_env_key(client, isolated_anthropic, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-env-key-000111222333")

    res = await client.delete("/api/settings/anthropic")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert body["source"] == "env"
    assert body["configured"] is True
    assert "ANTHROPIC_API_KEY" in body["error"]


@pytest.mark.asyncio
async def test_no_anthropic_route_emits_an_unmasked_key(client, isolated_anthropic, monkeypatch):
    """Hard guarantee: the full key must not appear in ANY response body."""
    env_key = "sk-ant-env-key-000111222333"
    bodies = []

    res = await client.post("/api/settings/anthropic", json={"key": _ANTHROPIC_KEY})
    bodies.append(res.text)
    bodies.append((await client.get("/api/settings/anthropic")).text)
    bodies.append((await client.delete("/api/settings/anthropic")).text)

    monkeypatch.setenv("ANTHROPIC_API_KEY", env_key)
    bodies.append((await client.get("/api/settings/anthropic")).text)
    bodies.append((await client.delete("/api/settings/anthropic")).text)

    for text in bodies:
        assert _ANTHROPIC_KEY not in text
        assert env_key not in text
