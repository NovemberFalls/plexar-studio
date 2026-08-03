"""A group is a project is a folder — step 1: the group gains a directory.

DEC-35, Len: *"we should be able to create a sort of project, by moving it to a
group (projects are groups if you will), technically a project is a folder,
where those chats live."*

This is step 1 of four and deliberately does **nothing to any chat**. A group
created before folders existed gains one WITHOUT its conversations moving —
moving files is user data and is its own step, gated on the user asking.

── WHAT THIS STEP GETS RIGHT ON PURPOSE ────────────────────────────────────
**The store does not choose a path.** Deciding where a project lives is a
filesystem question owned by whoever owns `app_paths`. A default invented in
`chat_store` would be a SECOND owner of where data lives — the defect S14
closed hours earlier, on the same surface, the same day.

**And the name is SLUGGED, because a project name is user input.** A project
called `../../etc` or `C:\\Windows` must not become that directory.
"""

from __future__ import annotations

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app_paths  # noqa: E402
import chat_runner  # noqa: E402
from chat_store import ChatStore  # noqa: E402


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(app_paths.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("PLEXAR_DATA_DIR", raising=False)
    monkeypatch.delenv("COCKPIT_DATA_DIR", raising=False)
    app_paths.reset_for_tests()
    yield
    app_paths.reset_for_tests()


def _legacy_db(path):
    """A schema-version-1 database: conversations already migrated, groups NOT.

    The shape a database is in RIGHT NOW, before this step. A fresh store would
    get `chat_groups.root` from CREATE TABLE and never consult the migration
    list, so only this can exercise it.
    """
    c = sqlite3.connect(str(path))
    c.executescript(
        """
        CREATE TABLE chat_groups (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT,
            created_at TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE conversations (
            id TEXT PRIMARY KEY, group_id TEXT, title TEXT NOT NULL, model TEXT,
            provider TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            message_count INTEGER NOT NULL DEFAULT 0, last_message_at TEXT,
            harness_session_id TEXT, root TEXT, root_choice TEXT
        );
        INSERT INTO chat_groups (id, name, created_at)
            VALUES ('grp_old', 'Made before folders existed', '2026-08-02T00:00:00Z');
        INSERT INTO conversations (id, group_id, title, created_at, updated_at)
            VALUES ('cnv_in_old', 'grp_old', 'A chat inside it',
                    '2026-08-02T00:00:00Z', '2026-08-02T00:00:00Z');
        PRAGMA user_version = 1;
        """
    )
    c.commit()
    c.close()


# ── The migration, against a database with history ─────────────────────────

def test_a_legacy_database_gains_chat_groups_root(tmp_path):
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    ChatStore(db_path=str(db))
    cols = {r[1] for r in sqlite3.connect(str(db)).execute("PRAGMA table_info(chat_groups)")}
    assert "root" in cols


def test_the_version_advances_and_conversations_are_untouched(tmp_path):
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    ChatStore(db_path=str(db))
    c = sqlite3.connect(str(db))
    assert c.execute("PRAGMA user_version").fetchone()[0] == ChatStore.SCHEMA_VERSION == 2
    # The conversations table was already at v1's shape; re-running must not
    # disturb it. Table-aware migrations could regress this by re-adding a
    # column to the wrong table.
    cols = {r[1] for r in c.execute("PRAGMA table_info(conversations)")}
    assert {"root", "root_choice", "harness_session_id"} <= cols


def test_an_existing_group_gets_a_folder_WITHOUT_its_chats_moving(tmp_path):
    """The whole point of step 1 being separate from step 3."""
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    store = ChatStore(db_path=str(db))

    assert store.get_group("grp_old")["root"] is None, "not backfilled with a guess"
    store.set_group_root("grp_old", str(tmp_path / "Ninebark"))

    assert store.get_group("grp_old")["root"] == str(tmp_path / "Ninebark")
    # THE CHAT IS UNTOUCHED. Its own root is still NULL and nothing moved.
    conv = store.get_conversation("cnv_in_old")
    assert conv["root"] is None
    assert conv["group_id"] == "grp_old"


def test_migration_is_idempotent_across_both_tables(tmp_path):
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    ChatStore(db_path=str(db))
    ChatStore(db_path=str(db))          # must not raise "duplicate column name"
    assert ChatStore(db_path=str(db)).get_group("grp_old")["root"] is None


# ── Creation ───────────────────────────────────────────────────────────────

def test_a_new_group_can_be_created_with_or_without_a_root(tmp_path):
    store = ChatStore(db_path=str(tmp_path / "chat.sqlite3"))
    with_root = store.create_group("Ninebark", root=str(tmp_path / "nb"))
    without = store.create_group("Later")
    assert with_root["root"] == str(tmp_path / "nb")
    # DISTINCT STATES: "no folder yet" is real and is NOT an empty string --
    # `""` and NULL would read the same to a `.get()` and mean different things.
    assert without["root"] is None


def test_a_blank_root_is_stored_as_NULL_not_an_empty_string(tmp_path):
    store = ChatStore(db_path=str(tmp_path / "chat.sqlite3"))
    assert store.create_group("Blank", root="   ")["root"] is None


# ── The default path: through app_paths, and slugged ──────────────────────

def test_the_default_root_resolves_through_app_paths(tmp_path):
    got = chat_runner.default_group_root("Ninebark")
    assert got == str(app_paths.data_dir() / "projects" / "Ninebark")
    # PROVENANCE is the assertion: a literal here would be a second owner of
    # where data lives, which is exactly what S14 closed.
    assert got.startswith(str(app_paths.data_dir()))


def test_the_env_override_reaches_project_folders_too(tmp_path, monkeypatch):
    named = tmp_path / "elsewhere"
    monkeypatch.setenv("PLEXAR_DATA_DIR", str(named))
    app_paths.reset_for_tests()
    assert chat_runner.default_group_root("Ninebark") == str(named / "projects" / "Ninebark")


def test_a_project_NAME_cannot_become_a_path(tmp_path):
    """A name is user input. Declared outcomes (R19), not "it looks safe"."""
    base = app_paths.data_dir() / "projects"
    cases = {
        "../../etc": "etc",
        "C:\\Windows": "C-Windows",
        "  ": "project",
        "my project!!": "my-project",
        "..": "project",
    }
    for name, expected in cases.items():
        got = chat_runner.default_group_root(name)
        assert got == str(base / expected), f"{name!r} -> {got}"
        # And the belt-and-braces property the slug exists for: the result can
        # never climb out of the projects directory.
        assert os.path.commonpath([got, str(base)]) == str(base), f"{name!r} escaped"
