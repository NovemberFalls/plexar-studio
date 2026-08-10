"""The concurrent-session cap now comes from settings, with env taking precedence.

`sessions.max_sessions` sat in DEFAULT_SETTINGS unread since the facelift. Scroll
mode (backlog row 19) is the feature that needs more than 8, so the key is wired
up here. The cap is NOT removed: it remains the backstop against a runaway spawn
loop -- it is just no longer pinned to the old 8-pane grid's ceiling.

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


def test_settings_used_when_no_env(monkeypatch):
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 20}})
    assert _resolve_max_sessions() == 20


def test_falls_back_to_eight_when_settings_has_nothing_usable(monkeypatch):
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {}})
    assert _resolve_max_sessions() == 8


@pytest.mark.parametrize("bad", ["", "eight", "3.5", "-"])
def test_unparseable_env_falls_back_rather_than_crashing(monkeypatch, bad):
    """A typo'd env var must not take the server down at import time."""
    monkeypatch.setenv("MAX_SESSIONS", bad)
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": 12}})
    assert _resolve_max_sessions() == 12


def test_a_settings_read_that_raises_is_survivable(monkeypatch):
    """Fail open to the default -- an unreadable settings file must not stop
    the user from creating any session at all."""
    def boom():
        raise OSError("settings.json is a directory")

    monkeypatch.setattr("settings_store.read_settings", boom)
    assert _resolve_max_sessions() == 8


def test_bool_is_not_accepted_as_a_count(monkeypatch):
    """isinstance(True, int) is True in Python; `max_sessions: true` is a typo,
    not a cap of 1."""
    monkeypatch.setattr("settings_store.read_settings", lambda: {"sessions": {"max_sessions": True}})
    assert _resolve_max_sessions() == 8


def test_zero_and_negative_are_rejected(monkeypatch):
    """A cap of 0 blocks every session and is indistinguishable from a mistyped
    'off' -- the same stance spend_guard takes on a 0 cap."""
    for value in (0, -5):
        monkeypatch.setattr("settings_store.read_settings", lambda v=value: {"sessions": {"max_sessions": v}})
        assert _resolve_max_sessions() == 8


def test_the_settings_bound_actually_permits_more_than_the_grid_shows():
    """The whole point of the row: the bound must exceed the 8-pane grid, or the
    setting cannot express what scroll mode exists for."""
    low, high = _NUMERIC_BOUNDS["sessions.max_sessions"]
    assert low == 1
    assert high >= 16, "raising the cap is pointless if the bound still caps it at the grid size"
