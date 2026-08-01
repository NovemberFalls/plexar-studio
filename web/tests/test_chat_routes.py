"""Chat REST surface.

The routes are deliberately thin — validation lives in chat_store, because a
rule enforced in a route is a rule the next caller skips. So these tests cover
what the ROUTE layer uniquely owns: status-code choice, and the PATCH semantics
where `null` is a real value rather than "unspecified".
"""

from __future__ import annotations

import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import chat_store  # noqa: E402
import server as server_module  # noqa: E402
from server import app  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """A store per test, pointed at tmp_path — never the developer's real chats."""
    store = chat_store.ChatStore(tmp_path / "chat.sqlite3")
    monkeypatch.setattr(server_module.chat_store, "get_store", lambda: store)
    yield AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
    store.close()


async def _conv(client, **body):
    res = await client.post("/api/chat/conversations", json=body or {"title": "t"})
    return res.json()


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_create_and_fetch_a_conversation_with_its_history(client):
    conv = await _conv(client, title="Design review")
    await client.post(f"/api/chat/conversations/{conv['id']}/messages",
                      json={"role": "user", "content": "hello"})
    await client.post(f"/api/chat/conversations/{conv['id']}/messages",
                      json={"role": "assistant", "content": "hi"})

    body = (await client.get(f"/api/chat/conversations/{conv['id']}")).json()
    assert body["conversation"]["title"] == "Design review"
    assert [m["content"] for m in body["messages"]] == ["hello", "hi"]


@pytest.mark.asyncio
async def test_unknown_conversation_is_404_not_an_empty_chat(client):
    """An empty 200 would render as a real, blank conversation."""
    res = await client.get("/api/chat/conversations/cnv_nope")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_a_thousand_line_paste_round_trips_through_http(client):
    conv = await _conv(client)
    big = "\n".join(f"line {i} — ünicode\ttab" for i in range(4000))
    res = await client.post(f"/api/chat/conversations/{conv['id']}/messages",
                            json={"role": "user", "content": big})
    assert res.status_code == 200

    body = (await client.get(f"/api/chat/conversations/{conv['id']}")).json()
    assert body["messages"][0]["content"] == big, "verbatim, not normalised"


@pytest.mark.asyncio
async def test_an_oversized_message_is_413_not_a_silent_trim(client):
    conv = await _conv(client)
    res = await client.post(
        f"/api/chat/conversations/{conv['id']}/messages",
        json={"role": "user", "content": "x" * (chat_store.MAX_MESSAGE_BYTES + 1)},
    )
    assert res.status_code == 413, "refusing loudly beats shortening what was typed"
    body = (await client.get(f"/api/chat/conversations/{conv['id']}")).json()
    assert body["messages"] == []


@pytest.mark.asyncio
async def test_a_message_to_a_missing_conversation_is_404(client):
    res = await client.post("/api/chat/conversations/cnv_nope/messages",
                            json={"role": "user", "content": "hi"})
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_a_bad_role_is_400(client):
    conv = await _conv(client)
    res = await client.post(f"/api/chat/conversations/{conv['id']}/messages",
                            json={"role": "narrator", "content": "hi"})
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# PATCH — where `null` is a value, not an absence
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_moving_a_conversation_to_the_root_is_expressible(client):
    """`{"group_id": null}` means MOVE TO ROOT and must not read as "unchanged"."""
    grp = (await client.post("/api/chat/groups", json={"name": "Work"})).json()
    conv = await _conv(client, title="t", group_id=grp["id"])

    res = await client.patch(f"/api/chat/conversations/{conv['id']}",
                             json={"group_id": None})
    assert res.json()["group_id"] is None


@pytest.mark.asyncio
async def test_a_title_edit_does_not_refile_the_conversation(client):
    """Omitting group_id must leave the chat where the user put it."""
    grp = (await client.post("/api/chat/groups", json={"name": "Work"})).json()
    conv = await _conv(client, title="t", group_id=grp["id"])

    res = await client.patch(f"/api/chat/conversations/{conv['id']}",
                             json={"title": "renamed"})
    assert res.json()["group_id"] == grp["id"]
    assert res.json()["title"] == "renamed"


@pytest.mark.asyncio
async def test_moving_into_an_unknown_group_is_400(client):
    conv = await _conv(client)
    res = await client.patch(f"/api/chat/conversations/{conv['id']}",
                             json={"group_id": "grp_nope"})
    assert res.status_code == 400


# ---------------------------------------------------------------------------
# Groups — a shelf, not a container
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_deleting_a_group_keeps_the_chats_and_says_how_many_moved(client):
    grp = (await client.post("/api/chat/groups", json={"name": "Work"})).json()
    conv = await _conv(client, title="keep me", group_id=grp["id"])

    res = await client.delete(f"/api/chat/groups/{grp['id']}")
    assert res.json()["conversations_moved"] == 1, (
        "a silent re-home leaves the user hunting for chats they think are gone"
    )
    survivor = (await client.get(f"/api/chat/conversations/{conv['id']}")).json()
    assert survivor["conversation"]["group_id"] is None


@pytest.mark.asyncio
async def test_root_listing_is_distinct_from_listing_everything(client):
    grp = (await client.post("/api/chat/groups", json={"name": "Work"})).json()
    await _conv(client, title="grouped", group_id=grp["id"])
    await _conv(client, title="loose")

    every = (await client.get("/api/chat/conversations")).json()["conversations"]
    root = (await client.get("/api/chat/conversations?group_id=root")).json()["conversations"]
    assert len(every) == 2
    assert [c["title"] for c in root] == ["loose"]


@pytest.mark.asyncio
async def test_an_unnamed_group_is_refused(client):
    assert (await client.post("/api/chat/groups", json={"name": "   "})).status_code == 400


@pytest.mark.asyncio
async def test_deleting_an_unknown_group_is_404(client):
    assert (await client.delete("/api/chat/groups/grp_nope")).status_code == 404


# ---------------------------------------------------------------------------
# Attachments + export
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_an_attachment_records_a_path_and_lists_back(client):
    conv = await _conv(client)
    await client.post(f"/api/chat/conversations/{conv['id']}/attachments",
                      json={"filename": "book.xlsx", "path": "/tmp/book.xlsx",
                            "kind": "spreadsheet", "size_bytes": 41_000_000})
    body = (await client.get(f"/api/chat/conversations/{conv['id']}")).json()
    assert body["attachments"][0]["filename"] == "book.xlsx"


@pytest.mark.asyncio
async def test_export_returns_everything_needed_to_rebuild(client):
    conv = await _conv(client, title="t")
    await client.post(f"/api/chat/conversations/{conv['id']}/messages",
                      json={"role": "user", "content": "q"})
    out = (await client.get(f"/api/chat/conversations/{conv['id']}/export")).json()
    assert out["messages"][0]["content"] == "q"
    assert out["exported_at"]


@pytest.mark.asyncio
async def test_deleting_a_conversation_removes_it(client):
    conv = await _conv(client)
    assert (await client.delete(f"/api/chat/conversations/{conv['id']}")).status_code == 200
    assert (await client.get(f"/api/chat/conversations/{conv['id']}")).status_code == 404
