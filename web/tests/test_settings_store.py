"""Tests for the settings.json store (web/settings_store.py) and the
FastAPI settings endpoints added to server.py:

  GET  /api/settings         — effective settings + real resolved path
  PUT  /api/settings         — apply a partial nested patch (all-or-nothing)
  POST /api/settings/reveal  — best-effort open of the containing folder

settings.json is a SIBLING of config.json: config.json keeps secrets (the
OpenRouter key), settings.json keeps only non-secret preferences. These tests
assert the two never bleed into each other.
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
def isolated_settings(tmp_path, monkeypatch):
    """Point settings_store at a throwaway config dir for this test only."""
    config_dir = tmp_path / ".claude-cockpit"
    monkeypatch.setattr(settings_store, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", config_dir / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", config_dir / "settings.json")
    return config_dir, config_dir / "settings.json"


# ---------------------------------------------------------------------------
# read_settings — defaults, overrides, corruption
# ---------------------------------------------------------------------------


def test_defaults_returned_when_no_file(isolated_settings):
    config_dir, settings_file = isolated_settings
    assert not settings_file.exists()

    settings = settings_store.read_settings()

    assert settings["general"]["autostart_broker"] is True
    assert settings["sessions"]["max_sessions"] == 8
    assert settings["appearance"]["glow_size"] == 30
    assert settings["providers"]["lmstudio"]["default"] is True
    # A pure read must not create the file.
    assert not settings_file.exists()


def test_disk_values_override_defaults_per_leaf(isolated_settings):
    config_dir, settings_file = isolated_settings
    config_dir.mkdir(parents=True)
    settings_file.write_text(
        json.dumps({"appearance": {"glow_size": 12}, "data": {"retention_days": 7}}),
        encoding="utf-8",
    )

    settings = settings_store.read_settings()

    assert settings["appearance"]["glow_size"] == 12
    assert settings["data"]["retention_days"] == 7
    # Sibling leaves inside the same section keep their defaults.
    assert settings["appearance"]["glow_enabled"] is True
    assert settings["appearance"]["theme"] is None
    assert settings["general"]["check_updates"] is True


def test_corrupt_json_reads_as_defaults(isolated_settings):
    config_dir, settings_file = isolated_settings
    config_dir.mkdir(parents=True)
    settings_file.write_text("{not json at all", encoding="utf-8")

    settings = settings_store.read_settings()

    assert settings == settings_store.read_settings()
    assert settings["sessions"]["max_sessions"] == 8
    assert settings["general"]["minimize_to_tray"] is False


def test_non_object_json_reads_as_defaults(isolated_settings):
    config_dir, settings_file = isolated_settings
    config_dir.mkdir(parents=True)
    settings_file.write_text("[1, 2, 3]", encoding="utf-8")

    assert settings_store.read_settings()["data"]["retention_days"] == 90


def test_unknown_disk_keys_are_preserved(isolated_settings):
    """A newer build's settings must survive a rollback to an older build."""
    config_dir, settings_file = isolated_settings
    config_dir.mkdir(parents=True)
    settings_file.write_text(
        json.dumps({"future_section": {"nifty": 1}, "general": {"brand_new": "x"}}),
        encoding="utf-8",
    )

    settings = settings_store.read_settings()

    assert settings["future_section"] == {"nifty": 1}
    assert settings["general"]["brand_new"] == "x"
    assert settings["general"]["autostart_broker"] is True


def test_settings_path_is_absolute_and_names_settings_json(isolated_settings):
    path = settings_store.settings_path()
    assert os.path.isabs(path)
    assert path.endswith("settings.json")


# ---------------------------------------------------------------------------
# update_settings — happy path
# ---------------------------------------------------------------------------


def test_valid_partial_patch_merges_without_clobbering_siblings(isolated_settings):
    config_dir, settings_file = isolated_settings

    settings_store.update_settings({"appearance": {"glow_size": 4}})
    effective = settings_store.update_settings(
        {"providers": {"vllm": {"gpu_util": 0.5}}, "sessions": {"fast": True}}
    )

    # Both patches survive, and untouched siblings keep their values.
    assert effective["appearance"]["glow_size"] == 4
    assert effective["providers"]["vllm"]["gpu_util"] == 0.5
    assert effective["providers"]["vllm"]["base_url"] == "http://127.0.0.1:8001"
    assert effective["providers"]["lmstudio"]["default"] is True
    assert effective["sessions"]["fast"] is True
    assert effective["sessions"]["max_sessions"] == 8

    # Only the patched keys are actually persisted; defaults are not baked in.
    on_disk = json.loads(settings_file.read_text(encoding="utf-8"))
    assert on_disk == {
        "appearance": {"glow_size": 4},
        "providers": {"vllm": {"gpu_util": 0.5}},
        "sessions": {"fast": True},
    }


def test_null_clears_a_leaf(isolated_settings):
    effective = settings_store.update_settings({"appearance": {"glow_size": None}})
    assert effective["appearance"]["glow_size"] is None


def test_int_accepted_for_float_default(isolated_settings):
    effective = settings_store.update_settings({"providers": {"vllm": {"gpu_util": 1}}})
    assert effective["providers"]["vllm"]["gpu_util"] == 1


def test_freeform_dicts_accept_arbitrary_contents(isolated_settings):
    effective = settings_store.update_settings({
        "appearance": {
            "token_overrides": {"--accent": "#ff0000", "nested": {"a": [1, 2]}},
            "user_palettes": {"mine": {"bg": "#000"}},
        },
        "system": {"keybindings": {"ctrl+k": "open-palette"}},
    })
    assert effective["appearance"]["token_overrides"]["--accent"] == "#ff0000"
    assert effective["system"]["keybindings"] == {"ctrl+k": "open-palette"}


def test_freeform_dict_is_replaced_wholesale_not_merged(isolated_settings):
    settings_store.update_settings({"system": {"keybindings": {"a": "1", "b": "2"}}})
    effective = settings_store.update_settings({"system": {"keybindings": {"a": "9"}}})
    assert effective["system"]["keybindings"] == {"a": "9"}


# ---------------------------------------------------------------------------
# update_settings — rejection (and NOTHING written)
# ---------------------------------------------------------------------------


def test_non_dict_patch_rejected(isolated_settings):
    with pytest.raises(ValueError):
        settings_store.update_settings(["not", "a", "dict"])


def test_unknown_top_level_key_rejected_and_nothing_written(isolated_settings):
    config_dir, settings_file = isolated_settings

    with pytest.raises(ValueError, match="bogus"):
        settings_store.update_settings({"general": {"check_updates": False}, "bogus": {"x": 1}})

    # All-or-nothing: the valid half of the patch must NOT have landed.
    assert not settings_file.exists()
    assert settings_store.read_settings()["general"]["check_updates"] is True


def test_wrong_type_leaf_rejected_and_nothing_written(isolated_settings):
    config_dir, settings_file = isolated_settings

    with pytest.raises(ValueError, match=r"providers\.lmstudio\.base_url"):
        settings_store.update_settings({"providers": {"lmstudio": {"base_url": 1234}}})

    assert not settings_file.exists()


def test_bool_not_accepted_for_int_leaf(isolated_settings):
    """isinstance(True, int) is True in Python -- bool must be checked first."""
    with pytest.raises(ValueError, match=r"sessions\.max_sessions"):
        settings_store.update_settings({"sessions": {"max_sessions": True}})


def test_int_not_accepted_for_bool_leaf(isolated_settings):
    with pytest.raises(ValueError, match=r"general\.autostart_broker"):
        settings_store.update_settings({"general": {"autostart_broker": 1}})


def test_string_not_accepted_for_bool_leaf(isolated_settings):
    with pytest.raises(ValueError, match=r"general\.minimize_to_tray"):
        settings_store.update_settings({"general": {"minimize_to_tray": "true"}})


def test_freeform_leaf_must_be_a_dict(isolated_settings):
    with pytest.raises(ValueError, match=r"system\.keybindings"):
        settings_store.update_settings({"system": {"keybindings": ["ctrl+k"]}})


@pytest.mark.parametrize("patch,needle", [
    ({"providers": {"lane_broker": {"concurrency": 0}}}, "concurrency"),
    ({"providers": {"lane_broker": {"concurrency": 9}}}, "concurrency"),
    ({"providers": {"vllm": {"gpu_util": 0.01}}}, "gpu_util"),
    ({"providers": {"vllm": {"gpu_util": 1.5}}}, "gpu_util"),
    ({"appearance": {"glow_size": -1}}, "glow_size"),
    ({"appearance": {"glow_size": 49}}, "glow_size"),
    ({"sessions": {"max_sessions": 0}}, "max_sessions"),
    ({"sessions": {"max_sessions": 17}}, "max_sessions"),
    ({"data": {"retention_days": 0}}, "retention_days"),
    ({"data": {"retention_days": 3651}}, "retention_days"),
])
def test_out_of_range_numeric_rejected(isolated_settings, patch, needle):
    config_dir, settings_file = isolated_settings
    with pytest.raises(ValueError, match=needle):
        settings_store.update_settings(patch)
    assert not settings_file.exists()


def test_range_boundaries_accepted(isolated_settings):
    # Boundary values on each bounded key must be accepted, not off-by-one rejected.
    settings_store.update_settings({"providers": {"lane_broker": {"concurrency": 1}}})
    settings_store.update_settings({"providers": {"lane_broker": {"concurrency": 8}}})
    settings_store.update_settings({"providers": {"vllm": {"gpu_util": 0.05}}})
    settings_store.update_settings({"providers": {"vllm": {"gpu_util": 1.0}}})
    settings_store.update_settings({"appearance": {"glow_size": 0}})
    settings_store.update_settings({"appearance": {"glow_size": 48}})
    settings_store.update_settings({"sessions": {"max_sessions": 16}})
    effective = settings_store.update_settings({"data": {"retention_days": 3650}})
    assert effective["data"]["retention_days"] == 3650


def test_non_json_serializable_rejected(isolated_settings):
    config_dir, settings_file = isolated_settings
    with pytest.raises(ValueError, match="JSON"):
        settings_store.update_settings({"appearance": {"theme": object()}})
    assert not settings_file.exists()


def test_settings_never_touch_the_openrouter_key(isolated_settings):
    config_dir, settings_file = isolated_settings

    settings_store.set_ui_key("sk-or-v1-abcdefghijklmno")
    settings_store.update_settings({"providers": {"openrouter": {"enabled": True}}})

    # The secret stays in config.json and never appears in the settings blob.
    assert settings_store.get_ui_key() == "sk-or-v1-abcdefghijklmno"
    blob = json.dumps(settings_store.read_settings())
    assert "sk-or-v1" not in blob


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_settings_endpoint(client, isolated_settings):
    async with client as ac:
        resp = await ac.get("/api/settings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["path"].endswith("settings.json")
    assert os.path.isabs(body["path"])
    assert body["settings"]["sessions"]["max_sessions"] == 8


@pytest.mark.asyncio
async def test_put_settings_endpoint_applies_patch(client, isolated_settings):
    async with client as ac:
        resp = await ac.put("/api/settings", json={"appearance": {"glow_size": 10}})
    assert resp.status_code == 200
    body = resp.json()
    assert body["settings"]["appearance"]["glow_size"] == 10
    assert body["settings"]["appearance"]["glow_enabled"] is True
    assert settings_store.read_settings()["appearance"]["glow_size"] == 10


@pytest.mark.asyncio
async def test_put_settings_endpoint_rejects_bad_patch_with_400(client, isolated_settings):
    config_dir, settings_file = isolated_settings
    async with client as ac:
        resp = await ac.put("/api/settings", json={"nope": {"x": 1}})
    assert resp.status_code == 400
    assert "nope" in resp.json()["error"]
    assert not settings_file.exists()


@pytest.mark.asyncio
async def test_put_settings_endpoint_rejects_non_object_body(client, isolated_settings):
    async with client as ac:
        resp = await ac.put("/api/settings", json=[1, 2, 3])
    assert resp.status_code == 400
    assert "error" in resp.json()


@pytest.mark.asyncio
async def test_reveal_endpoint_creates_folder_and_reports_ok(client, isolated_settings, monkeypatch):
    config_dir, settings_file = isolated_settings
    calls = []
    monkeypatch.setattr(server_module.subprocess, "Popen", lambda argv, **kw: calls.append(argv))

    async with client as ac:
        resp = await ac.post("/api/settings/reveal")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert body["path"].endswith("settings.json")
    # The folder is created so reveal works on a fresh install.
    assert config_dir.is_dir()
    assert len(calls) == 1
    assert isinstance(calls[0], list)
    assert str(config_dir) in calls[0][-1]


@pytest.mark.asyncio
async def test_reveal_endpoint_returns_200_on_failure(client, isolated_settings, monkeypatch):
    def boom(argv, **kw):
        raise OSError("no file manager here")

    monkeypatch.setattr(server_module.subprocess, "Popen", boom)

    async with client as ac:
        resp = await ac.post("/api/settings/reveal")

    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is False
    assert "no file manager here" in body["error"]


# ---------------------------------------------------------------------------
# Voice — an OPTIONAL capability whose engine is not bundled
# ---------------------------------------------------------------------------

def test_voice_is_off_by_default():
    """The ML deps are not shipped (the sidecar is 48 MB; torch is ~2 GB).

    Defaulting to on would advertise a feature whose engine has to be
    downloaded before it can do anything.
    """
    assert settings_store.DEFAULT_SETTINGS["voice"]["enabled"] is False


def test_no_voice_is_guessed_by_default():
    """Naming a voicepack that may not be on disk would show the user a
    selection the engine cannot honour. Empty means 'ask the engine'."""
    assert settings_store.DEFAULT_SETTINGS["voice"]["voice_id"] == ""


def test_barge_in_defaults_on():
    """Speaking over the assistant IS conversational voice; an install where
    you cannot interrupt is the feature without its point."""
    assert settings_store.DEFAULT_SETTINGS["voice"]["barge_in"] is True


def test_the_continue_pause_is_five_seconds_and_bounded(isolated_settings):
    assert settings_store.DEFAULT_SETTINGS["voice"]["silence_continue_seconds"] == 5.0

    # Below ~0.5s a normal breath ends the turn; past 30s "listening" is
    # indistinguishable from a hang.
    with pytest.raises(ValueError):
        settings_store.update_settings({"voice": {"silence_continue_seconds": 0.1}})
    with pytest.raises(ValueError):
        settings_store.update_settings({"voice": {"silence_continue_seconds": 120}})

    effective = settings_store.update_settings(
        {"voice": {"silence_continue_seconds": 2.5}}
    )
    assert effective["voice"]["silence_continue_seconds"] == 2.5
    assert effective["voice"]["barge_in"] is True, "a bounded edit must not clobber siblings"
