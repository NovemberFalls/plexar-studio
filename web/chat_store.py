"""Persistence for the Chat surface — groups, conversations, messages, files.

Cockpit's other stores record what ALREADY happened somewhere else (a JSONL a
CLI wrote, a price a vendor published). This one is different: it is the system
of record. If a row is wrong here, the user's own words are wrong, and there is
no upstream to re-ingest from. That asymmetry drives most of the decisions
below.

Ordering is by ``seq``, never by timestamp
------------------------------------------
Two messages can land in the same millisecond — a paste that triggers an
immediate reply, an assistant turn split into parts. Sorting a conversation by
``created_at`` would then be non-deterministic, and a chat that renders in a
different order on reload is broken in a way users do not forgive. ``seq`` is a
per-conversation counter allocated under the write lock.

Content is stored VERBATIM
--------------------------
The brief calls for pasting thousands of lines. Nothing here truncates,
normalises whitespace, or re-encodes: a store that quietly shortens what the
user typed is worse than one that refuses the write. Size is bounded by
``MAX_MESSAGE_BYTES`` and a violation is a loud error, never a silent trim.

Deleting a group does NOT delete its conversations
--------------------------------------------------
A group is a shelf, not a container. Removing a shelf must not destroy what sat
on it — a single mis-click would otherwise take a month of chats with it. The
conversations are re-parented to the root, and re-filing them is a two-second
job where recovering them would be impossible.

Attachments store a PATH, not bytes
------------------------------------
A 40 MB spreadsheet inside a row makes every conversation read pay for it. The
file lives on disk (the existing upload dir); this table records what it was,
where it went, and which message referenced it.
"""

from __future__ import annotations

import app_paths

import json
import logging
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger("cockpit.chat")

#: Refuse a single message larger than this. Generous by design — the brief
#: asks for thousands of lines, and 4 MB is roughly 50k lines of code — but
#: NOT unbounded: an accidental binary paste should fail loudly at the door
#: rather than wedge the UI rendering it.
MAX_MESSAGE_BYTES = 4 * 1024 * 1024

#: Roles a message may carry. `system` is stored so a conversation can be
#: replayed exactly as it was sent, not reconstructed from assumptions.
ROLES = ("user", "assistant", "system")

#: The root group. Conversations with `group_id = None` live here; it is not a
#: row, so it cannot be renamed, moved or deleted.
ROOT_GROUP = None

#: Distinguishes "caller did not mention group_id" from "caller said None".
#: `None` is a MEANINGFUL value on update — it means "move to the root" — so a
#: plain-None default would make moving a conversation OUT of a group
#: impossible to express.
_UNSET = object()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _default_db_path() -> Path:
    return app_paths.data_path("chat.sqlite3")


class ChatStore:
    """SQLite-backed store for the Chat surface.

    One connection, guarded by a lock: chat writes are user-paced (a keystroke
    burst at worst), so contention is not the problem to optimise for —
    correctness of `seq` allocation is, and that needs the lock anyway.
    """

    def __init__(self, db_path: Optional[Path | str] = None) -> None:
        self.db_path = Path(db_path) if db_path else _default_db_path()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # REENTRANT on purpose: add_message() takes the lock and calls
        # get_conversation(), which takes it too. A plain Lock deadlocks
        # there. And EVERY connection touch is guarded, reads included --
        # one sqlite3 connection shared across threads is not safe for
        # concurrent use even with check_same_thread=False, and an
        # unguarded read racing a write raises 'bad parameter or other
        # API misuse', which surfaces as a message the user sent going
        # missing.
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(str(self.db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            # A chat is the system of record for the user's own words; a
            # half-written message surviving a crash is not acceptable here.
            self._conn.execute("PRAGMA foreign_keys=ON")
        except sqlite3.Error:
            logger.warning("Failed to set PRAGMAs on %s", self.db_path, exc_info=True)
        self._init_schema()
        self._migrate()

    # -- schema ---------------------------------------------------------------

    def _init_schema(self) -> None:
        with self._lock, self._conn:
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS chat_groups (
                    id          TEXT PRIMARY KEY,
                    name        TEXT NOT NULL,
                    parent_id   TEXT,
                    created_at  TEXT NOT NULL,
                    sort_order  INTEGER NOT NULL DEFAULT 0,
                    -- The project's folder. Chats in this group derive their
                    -- working root from it. NULL = no folder yet, a real state
                    -- and not an error. Mirrored in _COLUMN_MIGRATIONS for
                    -- databases that predate it.
                    root        TEXT,
                    FOREIGN KEY (parent_id) REFERENCES chat_groups(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS conversations (
                    id          TEXT PRIMARY KEY,
                    group_id    TEXT,
                    title       TEXT NOT NULL,
                    model       TEXT,
                    provider    TEXT,
                    created_at  TEXT NOT NULL,
                    updated_at  TEXT NOT NULL,
                    archived    INTEGER NOT NULL DEFAULT 0,
                    -- Denormalised so a conversation LIST does not have to
                    -- open every conversation to show a preview.
                    message_count INTEGER NOT NULL DEFAULT 0,
                    last_message_at TEXT,
                    -- The harness session this conversation maps onto, so a
                    -- reply can --resume rather than re-sending the whole
                    -- transcript every turn. NULL until the first reply.
                    harness_session_id TEXT,
                    -- Per-conversation working root, and the record of whether
                    -- the user was ever ASKED for it. Both NULL means "never
                    -- asked", which is a real state and is never backfilled.
                    -- Mirrored in _COLUMN_MIGRATIONS so an existing database
                    -- reaches the same shape; a fresh one gets them here and
                    -- never consults the migration list, which is exactly why
                    -- the tests exercise the LEGACY path and not this one.
                    root TEXT,
                    root_choice TEXT,
                    FOREIGN KEY (group_id) REFERENCES chat_groups(id) ON DELETE SET NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    id              TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    seq             INTEGER NOT NULL,
                    role            TEXT NOT NULL,
                    content         TEXT NOT NULL,
                    model           TEXT,
                    created_at      TEXT NOT NULL,
                    input_tokens    INTEGER,
                    output_tokens   INTEGER,
                    UNIQUE (conversation_id, seq),
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                        ON DELETE CASCADE
                );

                CREATE TABLE IF NOT EXISTS attachments (
                    id              TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    message_id      TEXT,
                    filename        TEXT NOT NULL,
                    kind            TEXT NOT NULL,
                    mime            TEXT,
                    size_bytes      INTEGER,
                    path            TEXT NOT NULL,
                    created_at      TEXT NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                        ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS ix_messages_conv
                    ON messages(conversation_id, seq);
                CREATE INDEX IF NOT EXISTS ix_conv_group
                    ON conversations(group_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS ix_attach_conv
                    ON attachments(conversation_id);
                """
            )

    #: Ordered, additive column migrations for `conversations`.
    #:
    #: APPEND ONLY. Reordering or removing an entry changes what an existing
    #: database receives, which is how a migration list stops being a record of
    #: what happened and becomes a wish about it.
    #:
    #: ADDITIVE ONLY -- no column is ever dropped or retyped here. An older
    #: build pointed at a migrated file still runs, because it simply never
    #: SELECTs the new column. That is what makes rollback "check out the
    #: previous commit" rather than a restore.
    #:
    #: Every entry is guarded by a column-presence check, so applying this list
    #: twice is a no-op regardless of `user_version`. The version below is for
    #: ORDERING, not for idempotence -- a future migration that is NOT an
    #: additive column (a data rewrite, a new table backfilled from an old one)
    #: cannot be made idempotent by inspection and will need the version.
    #: (table, column, declaration). TABLE-AWARE since 2026-08-03: this held
    #: bare (column, decl) pairs and `_migrate` read `table_info(conversations)`
    #: hardcoded, so the list could only ever describe ONE table. Adding a
    #: column to `chat_groups` meant generalising it rather than bolting on a
    #: second loop -- two migration mechanisms is how one of them stops running.
    #:
    #: (A duplicated comment block sat at the end of this tuple until now:
    #: residue from a watch-to-fail restore that put the comment back without
    #: its entries. Comment-only, so nothing behaved differently, but it was
    #: dead text and is removed here rather than left to confuse a reader.)
    _COLUMN_MIGRATIONS: tuple[tuple[str, str, str], ...] = (
        ("conversations", "harness_session_id", "TEXT"),
        # Per-conversation working root. NULL is meaningful and is NEVER
        # backfilled -- see _migrate.
        ("conversations", "root", "TEXT"),
        ("conversations", "root_choice", "TEXT"),
        ("chat_groups", "root", "TEXT"),
        # A GROUP IS A PROJECT IS A FOLDER (DEC-35). The GROUP owns the
        # directory; a chat in it derives its root from the group rather than
        # being asked. NULL means "no folder yet" -- a real state for any group
        # created before this, and never backfilled with a guess.
    )

    #: Bumped when `_COLUMN_MIGRATIONS` grows. There was NO schema version at
    #: all before 2026-08-03 and exactly ONE migration entry, which is precisely
    #: how a second becomes unorderable -- the rig's store hit this and it cost
    #: a startup failure against exactly the databases that had history in them.
    SCHEMA_VERSION = 2

    def _migrate(self) -> None:
        """Additively add columns to a store created by an older build.

        Never DROP and recreate: this database holds the user's conversations,
        and there is no upstream to re-ingest them from.

        NO BACKFILL, and this is deliberate rather than lazy. Existing
        conversations get NULL in `root`/`root_choice` and KEEP it. NULL is
        "never asked", which is a state the app already models and can act on.
        Inventing a root for a conversation that predates the setting would be a
        guess written into the record and indistinguishable from an answer the
        user actually gave.

        ORDERING IS LOAD-BEARING AND IS WHY NOTHING HERE LIVES IN `_init_schema`.
        That method runs `CREATE TABLE IF NOT EXISTS`, which is a NO-OP on a
        database that already exists -- so a constraint or index naming a new
        column, placed there, would reference a column that does not exist yet
        and fail at startup against exactly the databases that have history,
        while a fresh database came up fine. Invisible in development, fatal in
        the field. Columns are added HERE, and anything depending on them goes
        after this loop, never before it.
        """
        with self._lock, self._conn:
            cols_by_table: dict[str, set[str]] = {}
            for table, name, decl in self._COLUMN_MIGRATIONS:
                if table not in cols_by_table:
                    cols_by_table[table] = {
                        r["name"] for r in
                        self._conn.execute(f"PRAGMA table_info({table})").fetchall()}
                if name in cols_by_table[table]:
                    continue
                # Table and column names come from the frozen tuple above,
                # never from input, so interpolation here cannot be reached by
                # a caller.
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
                cols_by_table[table].add(name)
                logger.info("chat store: added %s.%s", table, name)

            current = self._conn.execute("PRAGMA user_version").fetchone()[0]
            if current != self.SCHEMA_VERSION:
                # PRAGMA does not accept a bound parameter for the value.
                self._conn.execute(f"PRAGMA user_version = {int(self.SCHEMA_VERSION)}")
                logger.info("chat store: schema version %s -> %s",
                            current, self.SCHEMA_VERSION)

    def set_harness_session(self, conversation_id: str, session_id: str) -> None:
        """Record the harness session so the next turn can --resume it."""
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE conversations SET harness_session_id = ? WHERE id = ?",
                (session_id, conversation_id),
            )

    #: The answers `root_choice` may hold. NULL (absent) is the fourth state --
    #: "never asked" -- and is deliberately NOT in this set: it is the absence
    #: of an answer, not an answer. Collapsing it into `declined` would re-ask a
    #: user who already said no, and a question asked repeatedly gets answered
    #: carelessly.
    ROOT_CHOICES = frozenset({"default", "custom", "declined"})

    def set_conversation_root(self, conversation_id: str, root: Optional[str],
                              choice: str) -> None:
        """Record this conversation's working root AND that it was asked.

        Both are written together, always. Writing `root` without `choice`
        would leave a conversation with a location and no record that anyone
        chose it; writing `choice` without `root` on a "custom" answer would
        leave it asked-and-unanswered. They are one fact.

        `root` is None for "default" and "declined" -- both mean "use the global
        default" -- and the two are still DISTINGUISHABLE because `choice`
        differs. That distinction is the whole point of storing a choice at all.
        """
        if choice not in self.ROOT_CHOICES:
            raise ValueError(
                f"unknown root_choice {choice!r}; expected one of "
                f"{sorted(self.ROOT_CHOICES)} (never-asked is NULL, not a value)")
        if choice == "custom" and not (root or "").strip():
            raise ValueError("root_choice 'custom' requires a root path")
        if choice != "custom":
            root = None
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE conversations SET root = ?, root_choice = ? WHERE id = ?",
                (root, choice, conversation_id),
            )

    # -- groups ---------------------------------------------------------------

    def create_group(self, name: str, parent_id: Optional[str] = None,
                     root: Optional[str] = None) -> dict:
        """Create a project. `root` is its folder; None means "no folder yet".

        THE STORE DOES NOT CHOOSE A PATH. Deciding where a project lives is a
        filesystem question that belongs to whoever owns `app_paths` -- if this
        method invented a default it would become a SECOND owner of where data
        lives, which is the defect S14 closed hours ago. The caller passes a
        resolved path or nothing.
        """
        name = (name or "").strip()
        if not name:
            raise ValueError("group name must not be empty")
        if parent_id is not None and self.get_group(parent_id) is None:
            raise ValueError(f"unknown parent group {parent_id!r}")
        gid = _new_id("grp")
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO chat_groups (id, name, parent_id, created_at, root) "
                "VALUES (?,?,?,?,?)",
                (gid, name, parent_id, _now(), (root or "").strip() or None),
            )
        return self.get_group(gid)

    def set_group_root(self, group_id: str, root: Optional[str]) -> None:
        """Give an EXISTING project a folder, or clear it.

        Deliberately separate from `create_group` and deliberately does NOT
        touch any chat: a group created before folders existed gains one
        WITHOUT its chats moving. Moving files is its own step, gated on the
        user asking, because it is user data.
        """
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE chat_groups SET root = ? WHERE id = ?",
                ((root or "").strip() or None, group_id),
            )

    def get_group(self, group_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM chat_groups WHERE id = ?", (group_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_groups(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM chat_groups ORDER BY sort_order, name"
            ).fetchall()
        return [dict(r) for r in rows]

    def rename_group(self, group_id: str, name: str) -> Optional[dict]:
        name = (name or "").strip()
        if not name:
            raise ValueError("group name must not be empty")
        with self._lock, self._conn:
            self._conn.execute(
                "UPDATE chat_groups SET name = ? WHERE id = ?", (name, group_id)
            )
        return self.get_group(group_id)

    def delete_group(self, group_id: str) -> dict:
        """Remove a group. Its conversations are RE-PARENTED, never deleted.

        A group is a shelf, not a container. One mis-click must not be able to
        take a month of conversations with it, and re-filing them is trivial
        where recovering them would be impossible. Child groups are lifted to
        the root for the same reason.

        Returns a count of what moved, so the UI can say so rather than leaving
        the user to discover it.
        """
        with self._lock, self._conn:
            moved = self._conn.execute(
                "SELECT COUNT(*) AS n FROM conversations WHERE group_id = ?", (group_id,)
            ).fetchone()["n"]
            orphaned = self._conn.execute(
                "SELECT COUNT(*) AS n FROM chat_groups WHERE parent_id = ?", (group_id,)
            ).fetchone()["n"]
            self._conn.execute(
                "UPDATE conversations SET group_id = NULL WHERE group_id = ?", (group_id,)
            )
            self._conn.execute(
                "UPDATE chat_groups SET parent_id = NULL WHERE parent_id = ?", (group_id,)
            )
            self._conn.execute("DELETE FROM chat_groups WHERE id = ?", (group_id,))
        return {"deleted": group_id, "conversations_moved": moved,
                "groups_moved": orphaned}

    # -- conversations --------------------------------------------------------

    def create_conversation(
        self,
        title: str = "New chat",
        group_id: Optional[str] = None,
        model: Optional[str] = None,
        provider: Optional[str] = None,
    ) -> dict:
        if group_id is not None and self.get_group(group_id) is None:
            raise ValueError(f"unknown group {group_id!r}")
        cid = _new_id("cnv")
        ts = _now()
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO conversations "
                "(id, group_id, title, model, provider, created_at, updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (cid, group_id, (title or "New chat").strip() or "New chat",
                 model, provider, ts, ts),
            )
        return self.get_conversation(cid)

    def get_conversation(self, conversation_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_conversations(
        self, group_id: Optional[str] = None, include_archived: bool = False,
        limit: int = 200,
    ) -> list[dict]:
        """Conversations, newest activity first.

        ``group_id`` is a FILTER, and `None` means "all groups" rather than
        "the root group" — the root is reached with ``group_id="root"``. Those
        are different questions and conflating them makes the root unreachable.
        """
        clauses, params = [], []
        if group_id == "root":
            clauses.append("group_id IS NULL")
        elif group_id is not None:
            clauses.append("group_id = ?")
            params.append(group_id)
        if not include_archived:
            clauses.append("archived = 0")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        with self._lock:
            rows = self._conn.execute(
                f"SELECT * FROM conversations {where} ORDER BY updated_at DESC LIMIT ?",
                (*params, max(1, min(int(limit), 1000))),
            ).fetchall()
        return [dict(r) for r in rows]

    def update_conversation(
        self, conversation_id: str, *, title: Optional[str] = None,
        group_id: Any = _UNSET, archived: Optional[bool] = None,
        model: Optional[str] = None,
    ) -> Optional[dict]:
        """Patch a conversation. Moving between groups is an UPDATE, never a copy.

        ``group_id`` uses a sentinel rather than ``None`` as its default,
        because `None` is a MEANINGFUL value here — "move to the root". A
        plain-None default would make moving a conversation out of a group
        impossible to express.
        """
        if self.get_conversation(conversation_id) is None:
            return None
        sets, params = [], []
        if title is not None:
            t = title.strip()
            if not t:
                raise ValueError("title must not be empty")
            sets.append("title = ?")
            params.append(t)
        if group_id is not _UNSET:
            if group_id is not None and self.get_group(group_id) is None:
                raise ValueError(f"unknown group {group_id!r}")
            sets.append("group_id = ?")
            params.append(group_id)
        if archived is not None:
            sets.append("archived = ?")
            params.append(1 if archived else 0)
        if model is not None:
            sets.append("model = ?")
            params.append(model)
        if not sets:
            return self.get_conversation(conversation_id)
        sets.append("updated_at = ?")
        params.append(_now())
        with self._lock, self._conn:
            self._conn.execute(
                f"UPDATE conversations SET {', '.join(sets)} WHERE id = ?",
                (*params, conversation_id),
            )
        return self.get_conversation(conversation_id)

    def delete_conversation(self, conversation_id: str) -> bool:
        """Delete a conversation and its messages. This one IS destructive.

        Unlike a group, a conversation genuinely contains its messages, so
        cascade is the honest behaviour. The UI is responsible for confirming.
        """
        with self._lock, self._conn:
            cur = self._conn.execute(
                "DELETE FROM conversations WHERE id = ?", (conversation_id,)
            )
        return cur.rowcount > 0

    # -- messages -------------------------------------------------------------

    def add_message(
        self, conversation_id: str, role: str, content: str,
        model: Optional[str] = None, input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
    ) -> dict:
        """Append a message and return it, with its allocated ``seq``.

        The whole body runs under the lock: ``seq`` is MAX+1, so two concurrent
        appends outside it would race to the same number and the UNIQUE
        constraint would reject one of them — losing a message the user
        actually sent.
        """
        if role not in ROLES:
            raise ValueError(f"role must be one of {ROLES}")
        if content is None:
            raise ValueError("content must not be None")
        size = len(content.encode("utf-8"))
        if size > MAX_MESSAGE_BYTES:
            # Loud, never a silent trim: a store that shortens what the user
            # typed is worse than one that refuses the write.
            raise ValueError(
                f"message is {size} bytes, over the {MAX_MESSAGE_BYTES} limit"
            )
        if self.get_conversation(conversation_id) is None:
            raise ValueError(f"unknown conversation {conversation_id!r}")

        mid = _new_id("msg")
        ts = _now()
        with self._lock, self._conn:
            row = self._conn.execute(
                "SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            seq = row["s"] + 1
            self._conn.execute(
                "INSERT INTO messages (id, conversation_id, seq, role, content, model, "
                "created_at, input_tokens, output_tokens) VALUES (?,?,?,?,?,?,?,?,?)",
                (mid, conversation_id, seq, role, content, model, ts,
                 input_tokens, output_tokens),
            )
            self._conn.execute(
                "UPDATE conversations SET updated_at = ?, last_message_at = ?, "
                "message_count = message_count + 1 WHERE id = ?",
                (ts, ts, conversation_id),
            )
        return self.get_message(mid)

    def get_message(self, message_id: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM messages WHERE id = ?", (message_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_messages(self, conversation_id: str, limit: int = 2000) -> list[dict]:
        """Full history in ``seq`` order — the reason ``seq`` exists."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq LIMIT ?",
                (conversation_id, max(1, min(int(limit), 10000))),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_message(self, message_id: str) -> bool:
        with self._lock, self._conn:
            cur = self._conn.execute("DELETE FROM messages WHERE id = ?", (message_id,))
        return cur.rowcount > 0

    # -- attachments ----------------------------------------------------------

    def add_attachment(
        self, conversation_id: str, filename: str, path: str,
        kind: str = "file", mime: Optional[str] = None,
        size_bytes: Optional[int] = None, message_id: Optional[str] = None,
    ) -> dict:
        if self.get_conversation(conversation_id) is None:
            raise ValueError(f"unknown conversation {conversation_id!r}")
        aid = _new_id("att")
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO attachments (id, conversation_id, message_id, filename, "
                "kind, mime, size_bytes, path, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (aid, conversation_id, message_id, filename, kind, mime,
                 size_bytes, path, _now()),
            )
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM attachments WHERE id = ?", (aid,)
            ).fetchone()
        return dict(row)

    def list_attachments(self, conversation_id: str) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM attachments WHERE conversation_id = ? ORDER BY created_at",
                (conversation_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    # -- export ---------------------------------------------------------------

    def export_conversation(self, conversation_id: str) -> Optional[dict]:
        """Everything needed to reconstruct a conversation elsewhere.

        The user's words are theirs; a chat store with no way out is a trap.
        """
        conv = self.get_conversation(conversation_id)
        if conv is None:
            return None
        return {
            "conversation": conv,
            "messages": self.list_messages(conversation_id, limit=10000),
            "attachments": self.list_attachments(conversation_id),
            "exported_at": _now(),
        }

    def close(self) -> None:
        with self._lock:
            self._conn.close()


#: Process-wide singleton, created lazily so importing this module touches no
#: disk (mirrors pricing_store / usage_tracker).
_store: Optional[ChatStore] = None
_store_lock = threading.Lock()


def get_store() -> ChatStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = ChatStore()
    return _store
