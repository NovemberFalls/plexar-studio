"""Phone-created sessions must be visible to the desktop UI (N4).

The desktop only renders terminals it POSTed itself or adopts from the
GET /api/terminals poll, so Studio Remote's create must leave a marker that
poll can see: `origin: "remote"`. A desktop-created terminal carries none.
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from starlette.testclient import TestClient

import server


def test_remote_create_is_tagged_in_terminal_list(monkeypatch):
    async def fake_create(body, parent_id=None):
        return {"id": body["name"], "name": body["name"]}

    monkeypatch.setattr(server, "_create_terminal_from_body", fake_create)
    monkeypatch.setattr(server, "_remote_origin_ids", set())
    monkeypatch.setattr(
        server.pty_manager, "list_terminals",
        lambda: [{"id": "phone1", "alive": True}, {"id": "desk1", "alive": True}],
    )

    @asynccontextmanager
    async def _no_lifespan(_app):
        yield

    monkeypatch.setattr(server.app.router, "lifespan_context", _no_lifespan)

    created = asyncio.run(server._create_remote_terminal({"name": "phone1"}))
    assert created["origin"] == "remote"

    with TestClient(server.app, base_url="http://127.0.0.1") as client:
        terminals = {t["id"]: t for t in client.get("/api/terminals").json()["terminals"]}
    assert terminals["phone1"]["origin"] == "remote"
    assert "origin" not in terminals["desk1"]

