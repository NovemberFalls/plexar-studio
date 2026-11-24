"""Peer panes, round 2: host names itself, viewer names, rename, relabel, subagents.

The host half (Remote v1) runs on the gateway's own recording fake; the viewer half
(`remote_peers`) on the fake HTTP client. Neither touches a network or real files.
"""

from __future__ import annotations

import dataclasses
import json

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

import remote_gateway
import remote_peers
from remote_devices import DeviceStore
from tests.test_remote_gateway import BASE, Backend, auth, pair
from tests.test_remote_peers import PEER_URL, TOKEN, FakeHttp, _json
from remote_peers import PeerStore

# -- host: Remote v1 ---------------------------------------------------------


@pytest.fixture
def host(tmp_path, monkeypatch):
    backend = Backend()
    store = DeviceStore(tmp_path / "remote_devices.json")
    monkeypatch.setattr(remote_gateway, "_locations_file", lambda: tmp_path / "remote_locations.json")
    monkeypatch.setattr(remote_gateway.socket, "gethostname", lambda: " DESK-HOST ")
    reports = []

    async def report(tid, aid):
        reports.append((tid, aid))
        return {"id": aid, "text": "done"} if aid == "abc123" else None

    remote = dataclasses.replace(
        backend.as_remote_backend(),
        subagents=lambda: {"t1": [{"id": "abc123", "agent_type": "general-purpose"}]},
        subagent_report=report,
    )
    remote_gateway.configure(remote, store)
    app = FastAPI()
    app.include_router(remote_gateway.router)
    with TestClient(app, base_url=BASE) as client:
        yield {"backend": backend, "store": store, "client": client, "remote": remote,
               "reports": reports}


def test_pair_and_hello_carry_machine_name(host):
    body = pair(host["client"], host["store"])
    assert body["machine_name"] == "DESK-HOST"
    hello = host["client"].get("/remote/v1/hello", headers=auth(body["token"])).json()
    assert hello["machine_name"] == "DESK-HOST"


def test_machine_name_is_capped_and_never_raises(monkeypatch):
    monkeypatch.setattr(remote_gateway.socket, "gethostname", lambda: "x" * 100)
    assert remote_gateway.machine_name() == "x" * 64

    def boom():
        raise OSError("no name")

    monkeypatch.setattr(remote_gateway.socket, "gethostname", boom)
    assert remote_gateway.machine_name() == ""


def test_sessions_keep_fourteen_fields(host):
    token = pair(host["client"], host["store"])["token"]
    rows = host["client"].get("/remote/v1/sessions", headers=auth(token)).json()["sessions"]
    assert len(rows[0]) == 14


def test_subagents_route(host):
    client = host["client"]
    assert client.get("/remote/v1/subagents").status_code == 401
    token = pair(client, host["store"])["token"]
    assert client.get("/remote/v1/subagents", headers=auth(token)).json() == {
        "subagents": {"t1": [{"id": "abc123", "agent_type": "general-purpose"}]}}
    host["backend"].settings_dict["remote"]["enabled"] = False
    assert client.get("/remote/v1/subagents", headers=auth(token)).status_code == 404


def test_subagents_absent_callable_is_empty_and_report_404(host):
    client = host["client"]
    token = pair(client, host["store"])["token"]
    remote_gateway.configure(dataclasses.replace(host["remote"], subagents=None, subagent_report=None),
                             host["store"])
    assert client.get("/remote/v1/subagents", headers=auth(token)).json() == {"subagents": {}}
    assert client.get("/remote/v1/sessions/t1/subagents/abc123", headers=auth(token)).status_code == 404


def test_subagent_report_route(host):
    client = host["client"]
    url = "/remote/v1/sessions/t1/subagents/abc123"
    assert client.get(url).status_code == 401
    token = pair(client, host["store"])["token"]
    assert client.get(url, headers=auth(token)).json() == {"id": "abc123", "text": "done"}
    assert client.get("/remote/v1/sessions/t1/subagents/zzz9", headers=auth(token)).status_code == 404
    assert client.get("/remote/v1/sessions/nope/subagents/abc123", headers=auth(token)).status_code == 404
    host["backend"].settings_dict["remote"]["enabled"] = False
    assert client.get(url, headers=auth(token)).status_code == 404


@pytest.mark.parametrize("agent_id", ["..%2F..%2Fsecret", "a.b", "a-b", "%2E%2E"])
def test_subagent_report_refuses_traversal_shaped_ids(host, agent_id):
    token = pair(host["client"], host["store"])["token"]
    r = host["client"].get(f"/remote/v1/sessions/t1/subagents/{agent_id}", headers=auth(token))
    assert r.status_code == 404
    assert host["reports"] == []


# -- host: the shared desktop/remote report helper ----------------------------


def test_report_helper_requires_a_known_agent(tmp_path, monkeypatch):
    import asyncio

    import server

    class S:
        alive = True
        harness = "claude-code"

    monkeypatch.setattr(server.pty_manager, "get_terminal", lambda tid: S() if tid == "t1" else None)
    transcript = tmp_path / "sess.jsonl"
    monkeypatch.setattr(server.pty_manager, "_get_jsonl_path", lambda _s: str(transcript))
    agents = tmp_path / "sess" / "subagents"
    agents.mkdir(parents=True)
    (agents / "agent-abc123.jsonl").write_text(json.dumps(
        {"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}) + "\n")
    monkeypatch.setattr(server.subagent_watch, "subagents_dir", lambda _p: str(agents))

    run = asyncio.run
    assert run(server._subagent_report("nope", "abc123")) is None
    assert run(server._subagent_report("t1", "missing", require_known=True)) is None
    assert run(server._subagent_report("t1", "../x", require_known=True)) is None
    assert run(server._subagent_report("t1", "abc123", require_known=True))["id"] == "abc123"
    # The desktop keeps its 200-with-null for an agent with no transcript.
    assert run(server._subagent_report("t1", "missing")) == {"id": "missing", "text": None}


# -- viewer: remote_peers -----------------------------------------------------

BASE_VIEWER = "http://127.0.0.1:8420"


@pytest.fixture
def viewer(tmp_path, monkeypatch):
    box = {}

    def update(mutate):
        data = json.loads(json.dumps(box))
        result = mutate(data)
        result = data if result is None else result
        box.clear()
        box.update(result)
        return result

    store = PeerStore(meta_path=tmp_path / "remote_peers.json",
                      read_secrets=lambda: json.loads(json.dumps(box)), update_secrets=update)
    http = FakeHttp()
    remote_peers.configure(store=store, http=http)
    monkeypatch.setattr(remote_peers.socket, "gethostname", lambda: "LAPTOP")
    app = FastAPI()
    app.include_router(remote_peers.router)
    yield {"client": TestClient(app, base_url=BASE_VIEWER), "http": http, "store": store}
    remote_peers.configure()


def _pair(v, label=None, machine_name="DESK-HOST"):
    reply = {"device_id": "dev-1", "token": TOKEN, "protocol": 1, "app_version": "x"}
    if machine_name is not None:
        reply["machine_name"] = machine_name
    v["http"].routes[("POST", PEER_URL + "/remote/v1/pair")] = _json(200, reply)
    body = {"url": PEER_URL, "code": "ABCD2345"}
    if label is not None:
        body["label"] = label
    r = v["client"].post("/api/peers", json=body)
    assert r.status_code == 200, r.text
    return r.json()["peer"]


def test_device_name_is_this_machine_not_the_label(viewer):
    _pair(viewer, label="My Desktop")
    sent = viewer["http"].calls[-1]["body"]
    assert sent["device_name"] == "Plexar Studio (LAPTOP)"
    assert "My Desktop" not in sent["device_name"]


def test_device_name_falls_back_without_a_hostname(viewer, monkeypatch):
    def boom():
        raise OSError

    monkeypatch.setattr(remote_peers.socket, "gethostname", boom)
    _pair(viewer, label="x")
    assert viewer["http"].calls[-1]["body"]["device_name"] == "Plexar Studio"


@pytest.mark.parametrize("label,machine,expected", [
    ("Typed", "DESK-HOST", "Typed"),
    ("   ", "DESK-HOST", "DESK-HOST"),
    (None, "DESK-HOST", "DESK-HOST"),
    (None, "", "studio.example.com"),
    (None, None, "studio.example.com"),
])
def test_label_fallback_order(viewer, label, machine, expected):
    assert _pair(viewer, label=label, machine_name=machine)["label"] == expected


def test_rename(viewer):
    peer = _pair(viewer, label="Old")
    client = viewer["client"]
    r = client.put(f"/api/peers/{peer['id']}", json={"label": "  New name  "})
    assert r.status_code == 200
    assert r.json()["peer"]["label"] == "New name"
    assert viewer["store"].get(peer["id"]).label == "New name"
    for bad in ({"label": ""}, {"label": "   "}, {"label": "x" * 61}, {"label": 5}, {}):
        resp = client.put(f"/api/peers/{peer['id']}", json=bad)
        assert resp.status_code == 400 and "error" in resp.json()
    assert client.put(f"/api/peers/{peer['id']}", content=b"nope").status_code == 400
    r = client.put("/api/peers/unknown1", json={"label": "ok"})
    assert r.status_code == 404 and r.json() == {"error": "unknown peer"}
    assert TOKEN not in r.text


def _status(v, peer, hello):
    v["http"].routes[("GET", PEER_URL + "/remote/v1/hello")] = _json(200, hello)
    r = v["client"].get(f"/api/peers/{peer['id']}/status")
    assert r.status_code == 200
    return r.json()


def test_status_carries_machine_name_without_relabel(viewer):
    peer = _pair(viewer, label="Desk")
    body = _status(viewer, peer, {"protocol": 1, "machine_name": "DESK-HOST"})
    assert body["machine_name"] == "DESK-HOST" and body["relabelled"] is False
    assert viewer["store"].get(peer["id"]).label == "Desk"


def test_status_relabels_a_peer_named_after_this_machine(viewer):
    peer = _pair(viewer, label="laptop")  # this machine's name, case-insensitively
    body = _status(viewer, peer, {"protocol": 1, "machine_name": "DESK-HOST"})
    assert body["relabelled"] is True
    assert viewer["store"].get(peer["id"]).label == "DESK-HOST"
    # Second poll: the label no longer matches this machine, nothing more happens.
    assert _status(viewer, peer, {"protocol": 1, "machine_name": "DESK-HOST"})["relabelled"] is False


@pytest.mark.parametrize("hello", [
    {"protocol": 1},
    {"protocol": 1, "machine_name": ""},
    {"protocol": 1, "machine_name": "Laptop"},  # the host IS called that: no change
])
def test_status_does_not_relabel_otherwise(viewer, hello):
    peer = _pair(viewer, label="LAPTOP")
    body = _status(viewer, peer, hello)
    assert body["relabelled"] is False
    assert viewer["store"].get(peer["id"]).label == "LAPTOP"


def test_subagent_proxies(viewer):
    peer = _pair(viewer, label="Desk")
    http, client = viewer["http"], viewer["client"]
    http.routes[("GET", PEER_URL + "/remote/v1/subagents")] = _json(200, {"subagents": {"t1": []}})
    http.routes[("GET", PEER_URL + "/remote/v1/sessions/t1/subagents/abc")] = _json(
        200, {"id": "abc", "text": "hi"})
    assert client.get(f"/api/peers/{peer['id']}/subagents").json() == {"subagents": {"t1": []}}
    assert client.get(f"/api/peers/{peer['id']}/sessions/t1/subagents/abc").json() == {
        "id": "abc", "text": "hi"}
    assert http.calls[-1]["headers"]["Authorization"] == f"Bearer {TOKEN}"
    # An older host: its 404 passes through.
    assert client.get(f"/api/peers/{peer['id']}/sessions/t1/subagents/zzz").status_code == 404
    assert client.get("/api/peers/nope/subagents").status_code == 404


def test_subagent_report_proxy_refuses_bad_segments_and_quotes(viewer):
    peer = _pair(viewer, label="Desk")
    client, http = viewer["client"], viewer["http"]
    before = len(http.calls)
    # The HTTP client normalises a literal `..` away, so the route is driven directly.
    import asyncio
    for sid, aid in (("t1", ".."), ("..", "abc"), ("t1", "."), (" ", "abc")):
        resp = asyncio.run(remote_peers.peer_subagent_report(peer["id"], sid, aid))
        assert resp.status_code == 404
    assert len(http.calls) == before
    client.get(f"/api/peers/{peer['id']}/sessions/t1/subagents/a%3Fb")
    assert http.calls[-1]["url"].endswith("/remote/v1/sessions/t1/subagents/a%3Fb")


def test_bridge_drops_a_resize_no_terminal_could_have():
    import json as _json

    for cols, rows in ((10**12, 40), (80, 10**6), (0, 24)):
        assert remote_peers.page_frame(_json.dumps({"type": "resize", "cols": cols, "rows": rows})) == ("skip", None)


def test_a_label_keeps_only_printable_characters():
    assert remote_peers._clean_label(" Desk" + chr(27) + "[31mtop" + chr(10) + " ") == "Desk[31mtop"
    assert remote_peers._clean_label(chr(0) + chr(10)) is None
