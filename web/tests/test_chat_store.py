"""The Chat store — Cockpit's first SYSTEM OF RECORD.

Every other store here records what already happened somewhere else: a JSONL a
CLI wrote, a price a vendor published. Lose a row and you re-ingest. This one
holds the user's own words, and there is no upstream to recover from.

So these tests are weighted toward the ways a store silently loses or reorders
what someone actually typed, rather than toward CRUD coverage.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from chat_store import MAX_MESSAGE_BYTES, ChatStore  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    s = ChatStore(tmp_path / "chat.sqlite3")
    yield s
    s.close()


# ---------------------------------------------------------------------------
# Ordering — seq, never timestamps
# ---------------------------------------------------------------------------

def test_messages_come_back_in_send_order(store):
    c = store.create_conversation("t")
    for i in range(50):
        store.add_message(c["id"], "user", f"line {i}")
    got = [m["content"] for m in store.list_messages(c["id"])]
    assert got == [f"line {i}" for i in range(50)]


def test_ordering_does_not_depend_on_the_clock(store):
    """Two messages CAN land in the same millisecond.

    Ordering by created_at would then be non-deterministic, and a chat that
    renders differently on reload is broken in a way users do not forgive.
    """
    c = store.create_conversation("t")
    a = store.add_message(c["id"], "user", "first")
    b = store.add_message(c["id"], "assistant", "second")

    assert b["seq"] > a["seq"]
    # Even if the two share a timestamp exactly, seq still separates them.
    store._conn.execute(
        "UPDATE messages SET created_at = ? WHERE conversation_id = ?",
        (a["created_at"], c["id"]),
    )
    store._conn.commit()
    assert [m["content"] for m in store.list_messages(c["id"])] == ["first", "second"]


def test_seq_is_per_conversation_not_global(store):
    a = store.create_conversation("a")
    b = store.create_conversation("b")
    store.add_message(a["id"], "user", "x")
    first_in_b = store.add_message(b["id"], "user", "y")
    assert first_in_b["seq"] == 1, "a new conversation starts at 1, not after a's rows"


def test_concurrent_appends_do_not_collide(store):
    """seq is MAX+1, so an unlocked allocation would race to the same number
    and the UNIQUE constraint would REJECT one — losing a sent message."""
    import threading

    c = store.create_conversation("t")
    errors = []

    def send(n):
        try:
            store.add_message(c["id"], "user", f"m{n}")
        except Exception as exc:  # pragma: no cover - only on a real regression
            errors.append(exc)

    threads = [threading.Thread(target=send, args=(i,)) for i in range(24)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == [], f"a message was lost to a seq collision: {errors}"
    seqs = [m["seq"] for m in store.list_messages(c["id"])]
    assert len(seqs) == 24
    assert len(set(seqs)) == 24, "every message kept a distinct position"


# ---------------------------------------------------------------------------
# Content fidelity — thousands of lines, verbatim
# ---------------------------------------------------------------------------

def test_a_thousand_line_paste_survives_byte_for_byte(store):
    c = store.create_conversation("t")
    big = "\n".join(f"{i}: def thing_{i}():  # trailing space   " for i in range(5000))
    m = store.add_message(c["id"], "user", big)
    assert store.get_message(m["id"])["content"] == big


def test_whitespace_and_unicode_are_not_normalised(store):
    """A store that tidies what the user typed is a store that lies."""
    c = store.create_conversation("t")
    raw = "  leading\ttab\r\nCRLF\n\n\nblank lines   \n— em dash — 🎛 ​"
    m = store.add_message(c["id"], "user", raw)
    assert store.get_message(m["id"])["content"] == raw


def test_an_oversized_message_is_refused_loudly_not_trimmed(store):
    c = store.create_conversation("t")
    with pytest.raises(ValueError, match="over the"):
        store.add_message(c["id"], "user", "x" * (MAX_MESSAGE_BYTES + 1))
    assert store.list_messages(c["id"]) == [], "nothing partial was written"


def test_empty_content_is_allowed(store):
    """An empty assistant turn is a real thing (a tool-only reply)."""
    c = store.create_conversation("t")
    assert store.add_message(c["id"], "assistant", "")["content"] == ""


def test_an_unknown_role_is_refused(store):
    c = store.create_conversation("t")
    with pytest.raises(ValueError):
        store.add_message(c["id"], "narrator", "hi")


def test_a_message_to_a_missing_conversation_is_refused(store):
    with pytest.raises(ValueError):
        store.add_message("cnv_nope", "user", "hi")


# ---------------------------------------------------------------------------
# Grouping — a group is a shelf, not a container
# ---------------------------------------------------------------------------

def test_deleting_a_group_keeps_its_conversations(store):
    """THE rule. One mis-click must not take a month of chats with it."""
    g = store.create_group("Work")
    c = store.create_conversation("keep me", group_id=g["id"])

    result = store.delete_group(g["id"])

    assert result["conversations_moved"] == 1, "and the UI can say so"
    survivor = store.get_conversation(c["id"])
    assert survivor is not None, "deleting a shelf must not destroy what sat on it"
    assert survivor["group_id"] is None, "re-parented to the root, not orphaned"


def test_deleting_a_group_lifts_child_groups_rather_than_stranding_them(store):
    parent = store.create_group("Parent")
    child = store.create_group("Child", parent_id=parent["id"])
    store.delete_group(parent["id"])
    assert store.get_group(child["id"])["parent_id"] is None


def test_deleting_a_conversation_does_take_its_messages(store):
    """A conversation genuinely CONTAINS its messages — cascade is honest here."""
    c = store.create_conversation("t")
    m = store.add_message(c["id"], "user", "hi")
    assert store.delete_conversation(c["id"]) is True
    assert store.get_message(m["id"]) is None


def test_a_conversation_can_be_moved_out_of_a_group(store):
    """`None` means "the root" and must be expressible.

    A plain-None default on the update would make this impossible to say --
    the caller could never distinguish it from "leave the group alone".
    """
    g = store.create_group("Work")
    c = store.create_conversation("t", group_id=g["id"])
    moved = store.update_conversation(c["id"], group_id=None)
    assert moved["group_id"] is None


def test_omitting_group_id_leaves_the_group_alone(store):
    g = store.create_group("Work")
    c = store.create_conversation("t", group_id=g["id"])
    renamed = store.update_conversation(c["id"], title="new title")
    assert renamed["group_id"] == g["id"], "a title edit must not re-file the chat"
    assert renamed["title"] == "new title"


def test_moving_to_an_unknown_group_is_refused(store):
    c = store.create_conversation("t")
    with pytest.raises(ValueError):
        store.update_conversation(c["id"], group_id="grp_nope")
    assert store.get_conversation(c["id"])["group_id"] is None


def test_listing_the_root_is_distinct_from_listing_everything(store):
    """`None` filter = all groups; "root" = ungrouped. Conflating them makes
    the root unreachable."""
    g = store.create_group("Work")
    store.create_conversation("grouped", group_id=g["id"])
    store.create_conversation("loose")

    assert len(store.list_conversations()) == 2
    root = store.list_conversations(group_id="root")
    assert [c["title"] for c in root] == ["loose"]


def test_archived_conversations_are_hidden_but_not_lost(store):
    c = store.create_conversation("old")
    store.update_conversation(c["id"], archived=True)
    assert store.list_conversations() == []
    assert len(store.list_conversations(include_archived=True)) == 1


# ---------------------------------------------------------------------------
# Denormalised counters + attachments + export
# ---------------------------------------------------------------------------

def test_the_list_preview_counters_track_reality(store):
    c = store.create_conversation("t")
    store.add_message(c["id"], "user", "a")
    store.add_message(c["id"], "assistant", "b")
    row = store.get_conversation(c["id"])
    assert row["message_count"] == 2
    assert row["last_message_at"] is not None


def test_attachments_record_a_path_not_bytes(store):
    c = store.create_conversation("t")
    a = store.add_attachment(c["id"], "book.xlsx", "/tmp/up/book.xlsx",
                             kind="spreadsheet", size_bytes=41_000_000)
    assert a["path"].endswith("book.xlsx")
    assert a["size_bytes"] == 41_000_000
    assert store.list_attachments(c["id"])[0]["id"] == a["id"]


def test_export_round_trips_everything_needed_to_rebuild(store):
    """A chat store with no way out is a trap. These are the user's words."""
    g = store.create_group("Work")
    c = store.create_conversation("t", group_id=g["id"])
    store.add_message(c["id"], "user", "question")
    store.add_message(c["id"], "assistant", "answer")
    store.add_attachment(c["id"], "d.csv", "/tmp/d.csv")

    out = store.export_conversation(c["id"])
    assert [m["content"] for m in out["messages"]] == ["question", "answer"]
    assert out["conversation"]["group_id"] == g["id"]
    assert len(out["attachments"]) == 1


def test_the_store_survives_a_reopen(tmp_path):
    """WAL + a real file: a restart must not lose the conversation."""
    path = tmp_path / "chat.sqlite3"
    s1 = ChatStore(path)
    c = s1.create_conversation("persisted")
    s1.add_message(c["id"], "user", "still here?")
    s1.close()

    s2 = ChatStore(path)
    try:
        assert [m["content"] for m in s2.list_messages(c["id"])] == ["still here?"]
    finally:
        s2.close()
