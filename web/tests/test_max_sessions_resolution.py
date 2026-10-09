"""The concurrent-session cap comes from settings, with env taking precedence.

Owner ruling 2026-10-06: sessions have NO cap by default. 0 means "no limit";
an explicit positive value (env or settings) stays an opt-in ceiling. The grid
shows 8 panes per page, which is a display matter and not a session limit.

Precedence matters and is asserted in both directions: an operator who exports
MAX_SESSIONS for a headless run must not be overridden by a settings file, and a
user who sets the value in Settings must be honoured when no env var is present.
"""
import pytest

from pty_manager import _resolve_max_sessions
from settings_store import _NUMERIC_BOUNDS


@pytest.fixture(autouse=True)
def _no_env(monkeypatch):
    monkeypatch.delenv("MAX_SESSIONS", raising=False)


def test_env_var_wins_over_settings(monkeypatch):
    monkeypatch.setenv("MAX_SESSIONS", "24")
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 3}})
    assert _resolve_max_sessions() == 24


def test_env_zero_means_no_limit_and_wins(monkeypatch):
    monkeypatch.setenv("MAX_SESSIONS", "0")
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 3}})
    assert _resolve_max_sessions() == 0


def test_negative_env_falls_through_to_settings(monkeypatch):
    monkeypatch.setenv("MAX_SESSIONS", "-1")
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 5}})
    assert _resolve_max_sessions() == 5


def test_settings_used_when_no_env(monkeypatch):
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 20}})
    assert _resolve_max_sessions() == 20


def test_settings_zero_is_accepted(monkeypatch):
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 0}})
    assert _resolve_max_sessions() == 0


def test_defaults_to_no_limit_when_settings_has_nothing_usable(monkeypatch):
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {}})
    assert _resolve_max_sessions() == 0


@pytest.mark.parametrize("bad", ["", "eight", "3.5", "-"])
def test_unparseable_env_falls_back_rather_than_crashing(monkeypatch, bad):
    """A typo'd env var must not take the server down at import time."""
    monkeypatch.setenv("MAX_SESSIONS", bad)
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 12}})
    assert _resolve_max_sessions() == 12


def test_a_settings_read_that_raises_is_survivable(monkeypatch):
    """Fail open to no limit -- an unreadable settings file must not stop
    the user from creating any session at all."""
    def boom():
        raise OSError("settings.json is a directory")

    monkeypatch.setattr("settings_store.read_settings", boom)
    assert _resolve_max_sessions() == 0


def test_bool_is_not_accepted_as_a_count(monkeypatch):
    """isinstance(True, int) is True in Python; `max_sessions: true` is a typo,
    not a cap of 1."""
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": True}})
    assert _resolve_max_sessions() == 0


def test_negative_settings_value_is_rejected(monkeypatch):
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": -5}})
    assert _resolve_max_sessions() == 0


def test_the_settings_bound_permits_zero_and_more_than_the_grid_shows():
    """0 is the no-limit sentinel, and the upper bound must exceed the 8-pane grid."""
    low, high = _NUMERIC_BOUNDS["sessions.max_sessions"]
    assert low == 0
    assert high >= 16, "an opt-in ceiling is pointless if the bound caps it at the grid size"
