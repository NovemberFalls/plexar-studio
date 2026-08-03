"""Per-conversation working root: migration, states, and the seam to the child.

Len, asked directly whether the root is per-conversation or global: **"per
convo."** The global `chat.root` is the DEFAULT a new conversation inherits; a
conversation with its own root overrides it.

── WHY THE MIGRATION TESTS BUILD A LEGACY DATABASE BY HAND ──────────────────
NOTE-20's finding, applied rather than quoted: **a fresh database gets its
columns from `CREATE TABLE` and never consults the migration list, so every
fresh-DB test is blind to a broken migration BY CONSTRUCTION.** The rig's store
proved this the expensive way -- a suite at 1068 green could not see a broken
migration path, and only a run against a database with history caught it.

So `_legacy_db()` below creates `conversations` WITHOUT `root`/`root_choice`,
exactly as a pre-2026-08-03 build would have left it, and the migration is
asserted against THAT. A test that opened a fresh store would pass no matter
what `_COLUMN_MIGRATIONS` said.

── AND WHY THE SEAM IS ASSERTED AT THE SUBPROCESS ───────────────────────────
`chat_workspace()` returning the right string proves nothing about where the
child actually started. That is the helper-versus-wiring shape (R26) this
codebase has now found in a record writer, a UI flag, a settings card and an
environment variable. The wiring test below reads the `cwd` that
`create_subprocess_exec` was actually called with.
"""

from __future__ import annotations

import os
import sqlite3
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app_paths  # noqa: E402
import chat_runner  # noqa: E402
import settings_store  # noqa: E402
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
    """A `conversations` table as a pre-2026-08-03 build left it.

    Deliberately hand-built and deliberately WITHOUT root/root_choice: this is
    the only shape that can exercise the migration at all.
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
            harness_session_id TEXT
        );
        INSERT INTO conversations (id, title, created_at, updated_at)
        VALUES ('cnv_old', 'A conversation from before the setting existed',
                '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
        """
    )
    c.commit()
    assert c.execute("PRAGMA user_version").fetchone()[0] == 0, "legacy DBs have no version"
    c.close()


# ── The migration, against a database with history in it ───────────────────

def test_migration_adds_the_columns_to_a_LEGACY_database(tmp_path):
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    ChatStore(db_path=str(db))

    c = sqlite3.connect(str(db))
    cols = {r[1] for r in c.execute("PRAGMA table_info(conversations)")}
    assert {"root", "root_choice"} <= cols
    c.close()


def test_migration_does_NOT_backfill_the_existing_conversation(tmp_path):
    """NULL is "never asked" -- a real state, and never a guess.

    Inventing a root for a conversation that predates the setting would be
    indistinguishable from an answer the user actually gave.
    """
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    store = ChatStore(db_path=str(db))
    conv = store.get_conversation("cnv_old")
    assert conv["root"] is None
    assert conv["root_choice"] is None


def test_migration_preserves_the_legacy_row_exactly(tmp_path):
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    before = sqlite3.connect(str(db)).execute(
        "SELECT id,title,created_at,updated_at FROM conversations").fetchall()
    ChatStore(db_path=str(db))
    after = sqlite3.connect(str(db)).execute(
        "SELECT id,title,created_at,updated_at FROM conversations").fetchall()
    assert before == after, "the migration rewrote existing data"


def test_migration_sets_a_schema_version_where_there_was_none(tmp_path):
    """There was NO version and exactly ONE migration entry before today.

    That is how a second migration becomes unorderable -- the rig's store hit
    it and it cost a startup failure against databases that had history.
    """
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    ChatStore(db_path=str(db))
    v = sqlite3.connect(str(db)).execute("PRAGMA user_version").fetchone()[0]
    assert v == ChatStore.SCHEMA_VERSION
    assert v > 0


def test_migration_is_idempotent(tmp_path):
    """Applying it twice is a no-op -- guarded by presence, not by version."""
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    ChatStore(db_path=str(db))
    ChatStore(db_path=str(db))  # must not raise "duplicate column name"
    conv = ChatStore(db_path=str(db)).get_conversation("cnv_old")
    assert conv["root"] is None


def test_migration_is_ADDITIVE_no_column_lost(tmp_path):
    """An older build pointed at a migrated file must still run."""
    db = tmp_path / "chat.sqlite3"
    _legacy_db(db)
    before = {r[1] for r in sqlite3.connect(str(db)).execute(
        "PRAGMA table_info(conversations)")}
    ChatStore(db_path=str(db))
    after = {r[1] for r in sqlite3.connect(str(db)).execute(
        "PRAGMA table_info(conversations)")}
    assert before <= after, f"columns disappeared: {before - after}"


# ── The four states, pairwise distinct (R10) with a declared set (R19) ──────

def test_the_four_states_are_mutually_distinguishable(tmp_path):
    db = tmp_path / "chat.sqlite3"
    store = ChatStore(db_path=str(db))
    mk = lambda t: store.create_conversation(title=t)["id"]  # noqa: E731

    never = mk("never asked")
    dflt = mk("accepted the default")
    custom = mk("named a path")
    declined = mk("said no")

    store.set_conversation_root(dflt, None, "default")
    store.set_conversation_root(custom, str(tmp_path / "proj"), "custom")
    store.set_conversation_root(declined, None, "declined")

    got = {name: (c["root"], c["root_choice"]) for name, c in {
        "never": store.get_conversation(never),
        "default": store.get_conversation(dflt),
        "custom": store.get_conversation(custom),
        "declined": store.get_conversation(declined),
    }.items()}

    # DECLARED (R19), not discovered.
    assert got["never"] == (None, None)
    assert got["default"] == (None, "default")
    assert got["custom"] == (str(tmp_path / "proj"), "custom")
    assert got["declined"] == (None, "declined")

    # PAIRWISE (R10). The failure mode is two states becoming equal, and the
    # pair that matters most is named separately so a break says which died:
    # `declined` and `never` both carry a NULL root, and if `choice` stopped
    # distinguishing them the app would re-ask a user who already said no.
    assert got["declined"] != got["never"], "declined collapsed into never-asked"
    assert got["default"] != got["never"], "answering the default looks unasked"
    assert len(set(got.values())) == 4, f"states collapsed: {got}"


def test_never_asked_is_not_a_writable_value(tmp_path):
    """NULL is the ABSENCE of an answer, not an answer you can record."""
    store = ChatStore(db_path=str(tmp_path / "chat.sqlite3"))
    cid = store.create_conversation(title="x")["id"]
    for bad in ("never", "", None, "DEFAULT"):
        with pytest.raises(ValueError):
            store.set_conversation_root(cid, None, bad)


def test_custom_without_a_path_is_refused(tmp_path):
    """Otherwise a conversation is asked-and-answered with no location."""
    store = ChatStore(db_path=str(tmp_path / "chat.sqlite3"))
    cid = store.create_conversation(title="x")["id"]
    with pytest.raises(ValueError):
        store.set_conversation_root(cid, "   ", "custom")


# ── Resolution: per-conversation beats the global default ──────────────────

def test_a_conversation_root_overrides_the_global_setting(tmp_path, monkeypatch):
    glob = tmp_path / "global-root"; glob.mkdir()
    mine = tmp_path / "conversation-root"; mine.mkdir()
    monkeypatch.setattr(settings_store, "read_settings",
                        lambda: {"chat": {"root": str(glob), "root_choice": "custom"}})
    assert chat_runner.chat_workspace(str(mine)) == str(mine)
    # And with no conversation root, the global is still what applies -- the
    # override must not become the only path.
    assert chat_runner.chat_workspace(None) == str(glob)


def test_a_null_conversation_root_inherits_the_global_default(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "read_settings", lambda: {"chat": {"root": ""}})
    assert chat_runner.chat_workspace(None) == str(app_paths.data_dir() / "chat-workspace")


def test_an_unusable_conversation_root_falls_back_and_does_not_fail(tmp_path, monkeypatch):
    blocker = tmp_path / "a-file"
    blocker.write_text("x", encoding="utf-8")
    monkeypatch.setattr(settings_store, "read_settings", lambda: {"chat": {"root": ""}})
    got = chat_runner.chat_workspace(str(blocker / "child"))
    assert got == str(app_paths.data_dir() / "chat-workspace")


# ── THE SEAM: what reaches the CHILD PROCESS (R26) ─────────────────────────

@pytest.mark.asyncio
async def test_the_conversation_root_reaches_the_SUBPROCESS_cwd(tmp_path, monkeypatch):
    """The resolver being right proves nothing about where the child started.

    This reads the `cwd` `create_subprocess_exec` was actually called with --
    the only assertion that covers the wiring rather than the helper.
    """
    mine = tmp_path / "my-root"; mine.mkdir()
    monkeypatch.setattr(settings_store, "read_settings", lambda: {"chat": {"root": ""}})

    seen = {}

    class _Proc:
        returncode = 0
        stdout = stderr = None
        def kill(self): pass
        async def wait(self): return 0

    async def fake_exec(*a, **kw):
        seen["cwd"] = kw.get("cwd")
        raise RuntimeError("stop here: the cwd is what we came for")

    monkeypatch.setattr(chat_runner.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(chat_runner, "resolve_cli", lambda: "claude")

    events = [e async for e in chat_runner.stream_reply("hi", conversation_root=str(mine))]

    assert seen.get("cwd") == str(mine), (
        f"the child started in {seen.get('cwd')!r}, not the conversation's root"
    )
    assert any(e["type"] == "error" for e in events), "the stub should surface as an error"
