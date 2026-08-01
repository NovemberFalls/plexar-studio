"""`POST /api/chat/conversations/{id}/respond` — the streamed reply.

Send and reply are ONE route on purpose. Split across two calls, a failure
between them leaves a user message saved with nothing ever answering it, and
the UI cannot tell that apart from a slow model.

The other rule under test is the security rail: the tool allow-list is read
from the CONVERSATION, never from the request body. A client that could ask
for `Bash` by setting a flag would make the server-side boundary decorative.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import chat_store  # noqa: E402
import server as server_module  # noqa: E402
from server import app  # noqa: E402


@pytest.fixture()
def store(tmp_path, monkeypatch):
    s = chat_store.ChatStore(tmp_path / "chat.sqlite3")
    monkeypatch.setattr(server_module.chat_store, "get_store", lambda: s)
    yield s
    s.close()


@pytest.fixture()
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def fake_stream(events, captured=None):
    async def _gen(prompt, **kwargs):
        if captured is not None:
            captured.append({"prompt": prompt, **kwargs})
        for e in events:
            yield e
    return _gen


def sse_payloads(text):
    out = []
    for line in text.splitlines():
        if line.startswith("data: "):
            out.append(json.loads(line[6:]))
    return out


DONE = {"type": "done", "text": "Hello there", "session_id": "s1",
        "cost_usd": 0.02, "is_error": False}


@pytest.mark.asyncio
async def test_a_reply_streams_and_is_persisted(client, store, monkeypatch):
    monkeypatch.setattr(server_module.chat_runner, "stream_reply", fake_stream([
        {"type": "delta", "text": "Hello "},
        {"type": "delta", "text": "there"},
        DONE,
    ]))
    conv = store.create_conversation("t")

    res = await client.post(f"/api/chat/conversations/{conv['id']}/respond",
                            json={"content": "hi"})
    assert res.status_code == 200
    kinds = [p["type"] for p in sse_payloads(res.text)]
    assert kinds == ["delta", "delta", "done"]

    msgs = store.list_messages(conv["id"])
    assert [(m["role"], m["content"]) for m in msgs] == [
        ("user", "hi"), ("assistant", "Hello there")
    ]


@pytest.mark.asyncio
async def test_the_session_is_recorded_so_the_next_turn_resumes(client, store, monkeypatch):
    """Without this every turn re-sends the transcript as input tokens."""
    monkeypatch.setattr(server_module.chat_runner, "stream_reply",
                        fake_stream([DONE]))
    conv = store.create_conversation("t")
    await client.post(f"/api/chat/conversations/{conv['id']}/respond",
                      json={"content": "hi"})

    assert store.get_conversation(conv["id"])["harness_session_id"] == "s1"


@pytest.mark.asyncio
async def test_a_known_session_is_passed_back_to_the_runner(client, store, monkeypatch):
    captured = []
    monkeypatch.setattr(server_module.chat_runner, "stream_reply",
                        fake_stream([DONE], captured))
    conv = store.create_conversation("t")
    store.set_harness_session(conv["id"], "earlier-session")

    await client.post(f"/api/chat/conversations/{conv['id']}/respond",
                      json={"content": "hi"})
    assert captured[0]["session_id"] == "earlier-session"


@pytest.mark.asyncio
async def test_the_client_cannot_grant_itself_tools(client, store, monkeypatch):
    """THE rail. These tools run on this machine with the user's privileges,
    so the allow-list must not be settable from the request body."""
    captured = []
    monkeypatch.setattr(server_module.chat_runner, "stream_reply",
                        fake_stream([DONE], captured))
    conv = store.create_conversation("t")

    await client.post(
        f"/api/chat/conversations/{conv['id']}/respond",
        json={"content": "hi", "allow_exec": True, "allow_write": True,
              "allow_net": True},
    )
    assert captured[0]["allow_exec"] is False
    assert captured[0]["allow_write"] is False
    assert captured[0]["allow_net"] is False


@pytest.mark.asyncio
async def test_an_empty_reply_is_not_persisted_as_a_silent_turn(client, store, monkeypatch):
    """An empty assistant row renders as the model replying with silence."""
    monkeypatch.setattr(server_module.chat_runner, "stream_reply", fake_stream([
        {"type": "done", "text": "   ", "session_id": "s1"},
    ]))
    conv = store.create_conversation("t")
    await client.post(f"/api/chat/conversations/{conv['id']}/respond",
                      json={"content": "hi"})

    roles = [m["role"] for m in store.list_messages(conv["id"])]
    assert roles == ["user"], "the user's message stays; no empty assistant turn"


@pytest.mark.asyncio
async def test_a_runner_error_reaches_the_client_and_writes_no_reply(client, store, monkeypatch):
    monkeypatch.setattr(server_module.chat_runner, "stream_reply", fake_stream([
        {"type": "error", "detail": "harness exited 1"},
    ]))
    conv = store.create_conversation("t")

    res = await client.post(f"/api/chat/conversations/{conv['id']}/respond",
                            json={"content": "hi"})
    payloads = sse_payloads(res.text)
    assert payloads[-1]["type"] == "error"
    assert "exited 1" in payloads[-1]["detail"]
    assert [m["role"] for m in store.list_messages(conv["id"])] == ["user"]


@pytest.mark.asyncio
async def test_the_user_message_is_saved_even_though_the_reply_failed(client, store, monkeypatch):
    """Losing what the user typed because the model failed is the worst
    outcome available; their words are the thing with no upstream."""
    monkeypatch.setattr(server_module.chat_runner, "stream_reply", fake_stream([
        {"type": "error", "detail": "nope"},
    ]))
    conv = store.create_conversation("t")
    await client.post(f"/api/chat/conversations/{conv['id']}/respond",
                      json={"content": "keep me"})
    assert store.list_messages(conv["id"])[0]["content"] == "keep me"


@pytest.mark.asyncio
async def test_an_oversized_message_is_413_before_any_model_runs(client, store, monkeypatch):
    called = []
    monkeypatch.setattr(server_module.chat_runner, "stream_reply",
                        fake_stream([DONE], called))
    conv = store.create_conversation("t")

    res = await client.post(
        f"/api/chat/conversations/{conv['id']}/respond",
        json={"content": "x" * (chat_store.MAX_MESSAGE_BYTES + 1)},
    )
    assert res.status_code == 413
    assert called == [], "nothing is spent on a message that cannot be stored"


@pytest.mark.asyncio
async def test_empty_and_unknown_are_refused(client, store):
    conv = store.create_conversation("t")
    assert (await client.post(f"/api/chat/conversations/{conv['id']}/respond",
                              json={"content": "   "})).status_code == 400
    assert (await client.post("/api/chat/conversations/cnv_nope/respond",
                              json={"content": "hi"})).status_code == 404


@pytest.mark.asyncio
async def test_harness_status_is_always_200_and_says_why(client, monkeypatch):
    monkeypatch.setattr(server_module.chat_runner, "resolve_cli", lambda: None)
    body = (await client.get("/api/chat/harness")).json()
    assert body["available"] is False
    assert body["reason"] == "cli_not_found"
    assert body["detail"]

    monkeypatch.setattr(server_module.chat_runner, "resolve_cli", lambda: "/x/claude")
    body = (await client.get("/api/chat/harness")).json()
    assert body["available"] is True
    assert "Read" in body["read_only_tools"]
