"""`chat.url` — where Studio opens Plexar Chat.

A SETTING, not a frontend constant, because DEC-175 makes Chat's address "known
and shown, editable only behind 'Use a different address' for self-hosters". A
self-hoster running their own Chat must be able to point Studio at it without a
rebuild.

Opened in a Studio-owned WINDOW, never an iframe. Measured 2026-09-22: Chat
serves `frame-ancestors 'none'` and Studio's Tauri CSP is `default-src 'self'`
with no frame-src -- two independent refusals, and relaxing Chat's would spend a
public product's clickjacking defence for one desktop client.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import settings_store  # noqa: E402


def test_the_default_exists_and_is_https():
    url = settings_store.DEFAULT_SETTINGS["chat"]["url"]
    assert url.startswith("https://"), url


def test_a_stored_url_wins_over_the_default(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    settings_store.update_settings({"chat": {"url": "https://chat.internal.example"}})
    assert settings_store.read_settings()["chat"]["url"] == "https://chat.internal.example"


def test_an_untouched_install_still_reads_the_default(tmp_path, monkeypatch):
    """The positive twin: a deep-merge bug that dropped unknown top-level keys
    would pass the test above (it wrote one) and fail every fresh install."""
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    assert settings_store.read_settings()["chat"]["url"] == \
        settings_store.DEFAULT_SETTINGS["chat"]["url"]


def test_an_unrelated_save_does_not_drop_chat(tmp_path, monkeypatch):
    """settings.json is deep-merged; a partial patch elsewhere must not orphan
    this key, or the address silently reverts on the next unrelated save."""
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    settings_store.update_settings({"chat": {"url": "https://chat.internal.example"}})
    settings_store.update_settings({"general": {"check_updates": False}})
    s = settings_store.read_settings()
    assert s["chat"]["url"] == "https://chat.internal.example"
    assert s["general"]["check_updates"] is False


@pytest.mark.parametrize("bad", ["javascript:alert(1)", "file:///C:/Windows/system.ini", ""])
def test_the_store_does_not_validate_the_scheme_so_the_CALLER_must(bad, tmp_path, monkeypatch):
    """DOCUMENTING A REAL SEAM, not asserting a bug.

    settings.json is an operator-editable file and this store deliberately
    accepts any string here -- it validates bounded numerics, not URLs. So the
    scheme check CANNOT live here, and App.jsx's openChat refuses anything that
    is not http(s) before handing it to a browsing context. If that check is
    ever removed, a javascript: value in this file would be opened with the
    app's own trust. `chatWindow.test.jsx` pins the refusal.
    """
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    settings_store.update_settings({"chat": {"url": bad}})
    assert settings_store.read_settings()["chat"]["url"] == bad
