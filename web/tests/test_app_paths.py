"""The Claude Cockpit -> Plexar data directory move.

This carries settings, usage history, pricing snapshots and every chat. The
failure that matters is not a crash — it is a rename that quietly fails, after
which the app starts EMPTY and the user concludes their data is gone.

So the rule under test throughout: a failed migration must be a non-event that
keeps using the old directory, never a fresh start.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app_paths  # noqa: E402


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    """Point HOME at tmp_path and clear the memoized resolution.

    Without this a test would migrate the DEVELOPER's real ~/.claude-cockpit.
    """
    monkeypatch.setattr(app_paths.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("PLEXAR_DATA_DIR", raising=False)
    monkeypatch.delenv("COCKPIT_DATA_DIR", raising=False)
    app_paths.reset_for_tests()
    yield tmp_path
    app_paths.reset_for_tests()


def _seed(dirpath, name="usage.sqlite3", content="rows"):
    dirpath.mkdir(parents=True, exist_ok=True)
    (dirpath / name).write_text(content, encoding="utf-8")
    return dirpath / name


# ---------------------------------------------------------------------------
# Migration
# ---------------------------------------------------------------------------

def test_an_existing_install_is_moved_and_its_data_arrives(isolated):
    _seed(isolated / ".claude-cockpit")

    resolved = app_paths.data_dir()

    assert resolved == isolated / ".plexar"
    assert (resolved / "usage.sqlite3").read_text(encoding="utf-8") == "rows"


def test_a_rollback_is_told_where_the_data_went(isolated):
    """An older build looks in the old folder and finds it empty.

    Without the note that reads as "my history is gone", which is the exact
    conclusion this migration must never cause.
    """
    _seed(isolated / ".claude-cockpit")
    app_paths.data_dir()

    note = isolated / ".claude-cockpit" / app_paths.BREADCRUMB
    assert note.exists()
    assert ".plexar" in note.read_text(encoding="utf-8")
    assert "Nothing was deleted" in note.read_text(encoding="utf-8")


def test_a_failed_move_keeps_using_the_old_directory(isolated, monkeypatch):
    """THE rule. A locked file or a permissions refusal must be invisible.

    Falling through to a fresh directory would leave a user with settings,
    history and chats they can no longer see.
    """
    src = _seed(isolated / ".claude-cockpit")

    def boom(*a, **k):
        raise PermissionError("file in use by another process")

    monkeypatch.setattr(app_paths.shutil, "move", boom)

    resolved = app_paths.data_dir()

    assert resolved == isolated / ".claude-cockpit", (
        "a failed migration must be a non-event, not a fresh install"
    )
    assert src.read_text(encoding="utf-8") == "rows", "and nothing was lost"


def test_a_fresh_install_just_uses_the_new_name(isolated):
    resolved = app_paths.data_dir()
    assert resolved == isolated / ".plexar"
    assert resolved.is_dir()
    assert not (isolated / ".claude-cockpit").exists(), (
        "a fresh install must not manufacture the legacy directory"
    )


def test_an_already_migrated_install_is_not_migrated_again(isolated):
    _seed(isolated / ".plexar", content="new")
    _seed(isolated / ".claude-cockpit", content="old")

    resolved = app_paths.data_dir()

    assert resolved == isolated / ".plexar"
    assert (resolved / "usage.sqlite3").read_text(encoding="utf-8") == "new", (
        "the new location wins; a second move would clobber live data"
    )
    assert (isolated / ".claude-cockpit" / "usage.sqlite3").exists(), (
        "and the old one is left alone for the user to reconcile, not deleted"
    )


def test_migration_runs_at_most_once_per_process(isolated):
    _seed(isolated / ".claude-cockpit")
    first = app_paths.data_dir()
    # A second call must not re-run the move (there is nothing to move now, but
    # a non-memoized resolver would also let two modules disagree about where
    # the database lives).
    assert app_paths.data_dir() is first


# ---------------------------------------------------------------------------
# Env override
# ---------------------------------------------------------------------------

def test_an_explicit_directory_is_used_verbatim(isolated, monkeypatch):
    """An operator who names a directory owns it -- no migration into it."""
    custom = isolated / "somewhere-else"
    monkeypatch.setenv("PLEXAR_DATA_DIR", str(custom))
    _seed(isolated / ".claude-cockpit")
    app_paths.reset_for_tests()

    resolved = app_paths.data_dir()

    assert resolved == custom
    assert (isolated / ".claude-cockpit" / "usage.sqlite3").exists(), (
        "an explicitly named directory must not trigger a move"
    )


def test_the_legacy_env_var_still_works(isolated, monkeypatch):
    """Breaking a running install to make our rename tidy is the wrong trade."""
    custom = isolated / "legacy-var"
    monkeypatch.setenv("COCKPIT_DATA_DIR", str(custom))
    app_paths.reset_for_tests()
    assert app_paths.data_dir() == custom


def test_the_new_env_var_wins_when_both_are_set(isolated, monkeypatch):
    monkeypatch.setenv("COCKPIT_DATA_DIR", str(isolated / "old-var"))
    monkeypatch.setenv("PLEXAR_DATA_DIR", str(isolated / "new-var"))
    app_paths.reset_for_tests()
    assert app_paths.data_dir() == isolated / "new-var"


def test_data_path_joins_inside_the_resolved_directory(isolated):
    assert app_paths.data_path("chat.sqlite3").parent == app_paths.data_dir()
