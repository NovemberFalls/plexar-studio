"""The per-conversation root API: validate at the control, refuse at the write.

Two rules from other lanes bear directly on these routes:

  * **A constraint printed but not enforced is worse than one never mentioned.**
    The rig's mint form displayed its own rule and still accepted the violation.
    So `/validate` exists to refuse a bad root while the user is still looking
    at it -- AND the PUT validates again, because a client that skips the dialog
    must not be able to store a root a turn cannot use. The first is a courtesy;
    the second is the guarantee.
  * **A one-time decision needs feedback.** This write decides where a person's
    transcripts live. It returns its error rather than swallowing it, so the
    dialog can stay open on a write that did not land.
"""

from __future__ import annotations

import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app_paths  # noqa: E402
import chat_runner  # noqa: E402
import server as server_module  # noqa: E402
from chat_store import ChatStore  # noqa: E402
from server import app  # noqa: E402


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(app_paths.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("PLEXAR_DATA_DIR", raising=False)
    monkeypatch.delenv("COCKPIT_DATA_DIR", raising=False)
    app_paths.reset_for_tests()
    s = ChatStore(db_path=str(tmp_path / "chat.sqlite3"))
    monkeypatch.setattr(server_module, "_chat", lambda: s)
    yield s
    app_paths.reset_for_tests()


@pytest.fixture()
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# ── Refused AT THE CONTROL ─────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_validate_accepts_a_real_writable_folder(client, tmp_path, store):
    d = tmp_path / "project"; d.mkdir()
    r = await client.post("/api/chat/root/validate", json={"root": str(d)})
    assert r.json() == {"ok": True, "resolved": str(d), "error": None}


@pytest.mark.asyncio
async def test_validate_creates_NOTHING(client, tmp_path, store):
    """Validating a half-typed path must not litter the disk with folders."""
    ghost = tmp_path / "not-typed-yet"
    r = await client.post("/api/chat/root/validate", json={"root": str(ghost)})
    assert r.json()["ok"] is True, "a creatable folder should validate"
    assert not ghost.exists(), "validation created the directory"


@pytest.mark.asyncio
async def test_validate_refuses_a_file_a_relative_path_and_a_dead_parent(
    client, tmp_path, store
):
    afile = tmp_path / "f.txt"; afile.write_text("x", encoding="utf-8")
    cases = {
        "file": str(afile),
        "relative": "some/relative/path",
        "dead-parent": str(tmp_path / "missing" / "child"),
        "empty": "",
    }
    for name, value in cases.items():
        body = (await client.post("/api/chat/root/validate", json={"root": value})).json()
        assert body["ok"] is False, f"{name} was accepted"
        assert body["error"], f"{name} refused without saying why"


@pytest.mark.asyncio
async def test_validate_refuses_STUDIOS_OWN_DATA_DIRECTORY(client, tmp_path, store):
    """A chat turn runs a coding agent with the user's privileges.

    Pointing it at the folder holding chat.sqlite3, usage.sqlite3 and the
    provider key means an ordinary "tidy up this folder" turn can reach the
    application's own state.
    """
    for target in (app_paths.data_dir(), app_paths.data_dir() / "nested"):
        body = (await client.post("/api/chat/root/validate",
                                  json={"root": str(target)})).json()
        assert body["ok"] is False, f"{target} was accepted as a working root"
        assert "application data" in body["error"]


# ── And refused AT THE WRITE, for a client that skips the dialog ───────────

@pytest.mark.asyncio
async def test_put_refuses_an_invalid_custom_root_and_SAYS_WHY(client, tmp_path, store):
    cid = store.create_conversation(title="c")["id"]
    r = await client.put(f"/api/chat/conversations/{cid}/root",
                         json={"choice": "custom", "root": str(tmp_path / "no" / "such")})
    assert r.status_code == 400
    assert r.json()["error"], "refused without a reason the dialog can show"
    # And nothing was stored: a refused write must not half-land.
    assert store.get_conversation(cid)["root_choice"] is None


@pytest.mark.asyncio
async def test_put_refuses_an_unknown_choice(client, store):
    cid = store.create_conversation(title="c")["id"]
    r = await client.put(f"/api/chat/conversations/{cid}/root",
                         json={"choice": "maybe", "root": None})
    assert r.status_code == 400
    assert store.get_conversation(cid)["root_choice"] is None


@pytest.mark.asyncio
async def test_put_on_an_unknown_conversation_is_404_not_a_silent_ok(client, store):
    r = await client.put("/api/chat/conversations/cnv_nope/root",
                         json={"choice": "default", "root": None})
    assert r.status_code == 404


# ── The three answers, pairwise distinct (R10), declared (R19) ─────────────

@pytest.mark.asyncio
async def test_the_three_answers_are_stored_and_mutually_distinguishable(
    client, tmp_path, store
):
    d = tmp_path / "chosen"; d.mkdir()
    ids = {k: store.create_conversation(title=k)["id"]
           for k in ("default", "custom", "declined")}

    assert (await client.put(f"/api/chat/conversations/{ids['default']}/root",
                             json={"choice": "default", "root": None})).status_code == 200
    assert (await client.put(f"/api/chat/conversations/{ids['custom']}/root",
                             json={"choice": "custom", "root": str(d)})).status_code == 200
    assert (await client.put(f"/api/chat/conversations/{ids['declined']}/root",
                             json={"choice": "declined", "root": None})).status_code == 200

    never = store.create_conversation(title="never asked")["id"]
    got = {k: (store.get_conversation(v)["root"], store.get_conversation(v)["root_choice"])
           for k, v in {**ids, "never": never}.items()}

    assert got == {
        "default": (None, "default"),
        "custom": (str(d), "custom"),
        "declined": (None, "declined"),
        "never": (None, None),
    }
    # The pair the whole design turns on: declined and never-asked both carry a
    # NULL root, and if they stopped differing the prompt would return to a user
    # who already said no.
    assert got["declined"] != got["never"], "declined renders as never-asked"
    assert len(set(got.values())) == 4


@pytest.mark.asyncio
async def test_the_default_route_reports_the_app_paths_location(client, store):
    """Displayed by the dialog, so it must be the truth and not a literal."""
    body = (await client.get("/api/chat/root/default")).json()
    assert body["path"] == str(app_paths.data_dir() / "chat-workspace")


# ── THE SEAM (R26): a stored root reaches the CHILD PROCESS ────────────────

@pytest.mark.asyncio
async def test_a_stored_root_reaches_the_subprocess_cwd(client, tmp_path, store,
                                                        monkeypatch):
    """End to end: PUT the root, then read the `cwd` the child was given.

    Not the resolver's return value -- the argument `create_subprocess_exec`
    was actually called with. Every layer between them is exercised: the route,
    the store, `get_conversation`, the thread through `stream_reply`.
    """
    d = tmp_path / "reach-me"; d.mkdir()
    cid = store.create_conversation(title="c")["id"]
    assert (await client.put(f"/api/chat/conversations/{cid}/root",
                             json={"choice": "custom", "root": str(d)})).status_code == 200

    seen = {}

    async def fake_exec(*a, **kw):
        seen["cwd"] = kw.get("cwd")
        raise RuntimeError("stop: the cwd is what we came for")

    monkeypatch.setattr(chat_runner.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(chat_runner, "resolve_cli", lambda: "claude")

    conv = store.get_conversation(cid)
    _ = [e async for e in chat_runner.stream_reply(
        "hi", conversation_root=conv.get("root"))]

    assert seen.get("cwd") == str(d), (
        f"the child started in {seen.get('cwd')!r}, not the stored root"
    )


@pytest.mark.asyncio
async def test_declining_leaves_the_child_in_the_DEFAULT_workspace(
    client, tmp_path, store, monkeypatch
):
    """Declining is an answer, and the location it implies is the stated one."""
    cid = store.create_conversation(title="c")["id"]
    await client.put(f"/api/chat/conversations/{cid}/root",
                     json={"choice": "declined", "root": None})

    seen = {}

    async def fake_exec(*a, **kw):
        seen["cwd"] = kw.get("cwd")
        raise RuntimeError("stop")

    monkeypatch.setattr(chat_runner.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(chat_runner, "resolve_cli", lambda: "claude")
    monkeypatch.setattr(server_module.settings_store, "read_settings",
                        lambda: {"chat": {"root": ""}})

    conv = store.get_conversation(cid)
    _ = [e async for e in chat_runner.stream_reply(
        "hi", conversation_root=conv.get("root"))]

    assert seen.get("cwd") == str(app_paths.data_dir() / "chat-workspace")
