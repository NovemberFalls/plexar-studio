"""Tests for the V4 mailbox-bridge FastAPI routes.

Covers:
  POST   /api/bridge/mailbox                  — validation, conflict guard, spend guard
  POST   /api/bridge/mb/{id}/post             — the route a SESSION calls via curl
  POST   /api/bridge/mb/{id}/extend           — the human gate
  GET    /api/bridge/mb/{id}/transcript       — the UI's read
  DELETE /api/bridge/mb/{id}                  — stop
  GET    /api/bridge/mb                       — list shape

Also pins that the V4 conflict guard is MUTUAL: a mailbox bridge and a V1/V2/V3
bridge cannot claim the same session from either direction. That is the whole
job of ``_bridge_busy_ids``, and it is easy to half-wire.

Uses httpx AsyncClient + ASGITransport with a loopback base_url — anything else
sends a non-loopback Host and origin_guard 403s every route (see CLAUDE.md).
"""

from __future__ import annotations

import os
import sys
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config

logging_config.setup("WARNING")

from server import app  # noqa: E402
import server as server_module  # noqa: E402


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.fixture(autouse=True)
def no_spend_block(monkeypatch):
    """Spend enforcement is tested in its own module; keep it out of the way."""
    monkeypatch.setattr(server_module, "_spend_refusal", AsyncMock(return_value=None))


@pytest.fixture()
def mb(monkeypatch):
    """A stub MailboxManager wired into the server module."""

    class _Stub:
        def __init__(self):
            self.started = None
            self.posted = None
            self.extended = None
            self.stopped = None
            self.busy = set()
            self.record = None
            self.bridges = []

        async def start(self, lead_id, worker_ids, topic, max_rounds, base_url):
            self.started = (lead_id, worker_ids, topic, max_rounds, base_url)
            return {"ok": True, "mailbox_id": "mb-1", "state": "active"}

        async def post(self, mailbox_id, sender, to, body, ack, done):
            self.posted = (mailbox_id, sender, to, body, ack, done)
            return {"ok": True, "seq": 1, "state": "active"}

        async def extend(self, mailbox_id, additional):
            self.extended = (mailbox_id, additional)
            return {"ok": True, "state": "active", "max_rounds": 16}

        async def stop(self, mailbox_id, reason=None):
            self.stopped = mailbox_id
            return mailbox_id == "mb-1"

        def get(self, mailbox_id):
            return self.record

        def list_active(self):
            return self.bridges

        def member_ids(self):
            return set(self.busy)

    stub = _Stub()
    monkeypatch.setattr(server_module, "mailbox_manager", stub)
    return stub


# ---------------------------------------------------------------------------
# POST /api/bridge/mailbox
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_start_happy_path(client, mb):
    async with client as c:
        r = await c.post(
            "/api/bridge/mailbox",
            json={
                "lead_id": "t1",
                "worker_ids": ["t2", "t3"],
                "topic": "Refactor the parser",
                "max_rounds": 20,
            },
        )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert mb.started[:4] == ("t1", ["t2", "t3"], "Refactor the parser", 20)


@pytest.mark.asyncio
async def test_start_briefs_point_at_the_server_not_the_browser_origin(client, mb):
    """The brief's curl target must be the sidecar's loopback bind.

    A session posts from its own shell, so a browser-origin URL (the Vite dev
    server on :5174 in dev) would be an address the session cannot reach.
    """
    async with client as c:
        await c.post(
            "/api/bridge/mailbox",
            json={"lead_id": "t1", "worker_ids": ["t2"], "topic": "x"},
        )
    base_url = mb.started[4]
    assert base_url == f"http://127.0.0.1:{os.getenv('PORT', '8420')}"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"worker_ids": ["t2"], "topic": "x"},          # no lead
        {"lead_id": "t1", "topic": "x"},                # no workers
        {"lead_id": "t1", "worker_ids": ["t2"]},        # no topic
        {"lead_id": "t1", "worker_ids": [], "topic": "x"},
    ],
)
async def test_start_requires_lead_workers_and_topic(client, mb, payload):
    async with client as c:
        r = await c.post("/api/bridge/mailbox", json=payload)
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_start_rejects_non_string_workers_and_bad_rounds(client, mb):
    async with client as c:
        r = await c.post(
            "/api/bridge/mailbox",
            json={"lead_id": "t1", "worker_ids": [1, 2], "topic": "x"},
        )
        assert r.status_code == 400

        r = await c.post(
            "/api/bridge/mailbox",
            json={"lead_id": "t1", "worker_ids": ["t2"], "topic": "x", "max_rounds": "many"},
        )
        assert r.status_code == 400


@pytest.mark.asyncio
async def test_start_caps_worker_count(client, mb):
    async with client as c:
        r = await c.post(
            "/api/bridge/mailbox",
            json={
                "lead_id": "t1",
                "worker_ids": [f"t{i}" for i in range(2, 11)],
                "topic": "x",
            },
        )
    assert r.status_code == 400
    assert "Maximum 7" in r.json()["error"]


@pytest.mark.asyncio
async def test_start_refuses_a_session_already_in_a_mailbox_bridge(client, mb):
    mb.busy = {"t2"}
    async with client as c:
        r = await c.post(
            "/api/bridge/mailbox",
            json={"lead_id": "t1", "worker_ids": ["t2"], "topic": "x"},
        )
    assert r.status_code == 409
    assert "t2" in r.json()["error"]


@pytest.mark.asyncio
async def test_start_refuses_a_session_held_by_a_legacy_channel(client, mb, monkeypatch):
    """The guard must see across bridge generations, not only its own."""
    monkeypatch.setattr(
        server_module.channel_manager, "member_ids", lambda: {"t1"}
    )
    async with client as c:
        r = await c.post(
            "/api/bridge/mailbox",
            json={"lead_id": "t1", "worker_ids": ["t2"], "topic": "x"},
        )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_legacy_auto_bridge_refuses_a_session_held_by_a_mailbox(client, mb, monkeypatch):
    """...and in the other direction, which is the half that gets forgotten."""
    mb.busy = {"t2"}
    monkeypatch.setattr(server_module.bridge_manager, "list_active", lambda: [])
    monkeypatch.setattr(server_module.channel_manager, "member_ids", lambda: set())
    async with client as c:
        r = await c.post(
            "/api/bridge/auto",
            json={
                "from_terminal_id": "t1",
                "to_terminal_id": "t2",
                "kickoff_prompt": "hi",
            },
        )
    assert r.status_code == 409


@pytest.mark.asyncio
async def test_start_honours_the_spend_guard(client, mb, monkeypatch):
    monkeypatch.setattr(
        server_module,
        "_spend_refusal",
        AsyncMock(return_value={"blocked": True, "caveats": []}),
    )
    monkeypatch.setattr(server_module, "_spend_error_text", lambda s: "cap tripped")
    async with client as c:
        r = await c.post(
            "/api/bridge/mailbox",
            json={"lead_id": "t1", "worker_ids": ["t2"], "topic": "x"},
        )
    assert r.status_code == 409
    assert r.json()["error"] == "cap tripped"
    assert "spend" in r.json()


# ---------------------------------------------------------------------------
# POST /api/bridge/mb/{id}/post
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_forwards_the_protocol_fields(client, mb):
    async with client as c:
        r = await c.post(
            "/api/bridge/mb/mb-1/post",
            json={"from": "w1", "to": "lead", "body": "done", "ack": 3, "done": True},
        )
    assert r.status_code == 200
    assert mb.posted == ("mb-1", "w1", "lead", "done", 3, True)


@pytest.mark.asyncio
async def test_post_defaults_ack_to_null_and_done_to_false(client, mb):
    async with client as c:
        await c.post("/api/bridge/mb/mb-1/post", json={"from": "w1", "to": "lead", "body": "hi"})
    assert mb.posted[4] is None
    assert mb.posted[5] is False


@pytest.mark.asyncio
async def test_post_rejects_a_non_integer_ack(client, mb):
    async with client as c:
        r = await c.post(
            "/api/bridge/mb/mb-1/post",
            json={"from": "w1", "to": "lead", "body": "hi", "ack": "three"},
        )
    assert r.status_code == 400
    assert mb.posted is None


@pytest.mark.asyncio
async def test_post_rejects_malformed_body(client, mb):
    async with client as c:
        r = await c.post(
            "/api/bridge/mb/mb-1/post",
            content=b"not json",
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 400

        r = await c.post("/api/bridge/mb/mb-1/post", json=["a", "list"])
        assert r.status_code == 400


@pytest.mark.asyncio
async def test_post_propagates_the_managers_status_code(client, mb):
    """A paused bridge answers 409 so the session knows to stand down.

    The manager returns the code; the route must not flatten every refusal to
    400, or a paused bridge is indistinguishable from a malformed post and the
    session retries forever.
    """

    async def _paused(mailbox_id, sender, to, body, ack, done):
        return {"ok": False, "error": "paused", "state": "awaiting_human", "status": 409}

    mb.post = _paused
    async with client as c:
        r = await c.post(
            "/api/bridge/mb/mb-1/post", json={"from": "w1", "to": "lead", "body": "hi"}
        )
    assert r.status_code == 409
    assert r.json()["state"] == "awaiting_human"
    assert "status" not in r.json()  # popped, not leaked into the body


# ---------------------------------------------------------------------------
# Extend / stop / list / transcript
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_extend_forwards_the_grant(client, mb):
    async with client as c:
        r = await c.post("/api/bridge/mb/mb-1/extend", json={"additional": 4})
    assert r.status_code == 200
    assert mb.extended == ("mb-1", 4)


@pytest.mark.asyncio
async def test_extend_rejects_a_non_integer(client, mb):
    async with client as c:
        r = await c.post("/api/bridge/mb/mb-1/extend", json={"additional": "lots"})
    assert r.status_code == 400
    assert mb.extended is None


@pytest.mark.asyncio
async def test_stop_known_and_unknown(client, mb):
    async with client as c:
        assert (await c.delete("/api/bridge/mb/mb-1")).status_code == 200
        assert (await c.delete("/api/bridge/mb/nope")).status_code == 404


@pytest.mark.asyncio
async def test_list_shape(client, mb):
    mb.bridges = [{"mailbox_id": "mb-1", "state": "awaiting_human"}]
    async with client as c:
        r = await c.get("/api/bridge/mb")
    assert r.status_code == 200
    assert r.json() == {"bridges": [{"mailbox_id": "mb-1", "state": "awaiting_human"}]}


@pytest.mark.asyncio
async def test_transcript_404_when_unknown(client, mb):
    mb.record = None
    async with client as c:
        r = await c.get("/api/bridge/mb/nope/transcript")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_transcript_returns_state_and_messages(client, mb, monkeypatch):
    class _Rec:
        def to_dict(self):
            return {"mailbox_id": "mb-1", "state": "active"}

    mb.record = _Rec()
    monkeypatch.setattr(
        server_module, "read_mailbox", lambda record, limit: [{"seq": 1, "body": "hi"}]
    )
    async with client as c:
        r = await c.get("/api/bridge/mb/mb-1/transcript")
    body = r.json()
    assert r.status_code == 200
    assert body["state"] == "active"
    assert body["messages"] == [{"seq": 1, "body": "hi"}]
