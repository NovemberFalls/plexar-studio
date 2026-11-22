"""Gate for Studio-to-Studio peers (remote_peers.py, docs/studio-peers-v1.md).

Every refusal has a positive twin, so a refuse-everything build cannot pass.
The upstream is always a fake: an injected HTTP callable and WS connector.
"""

from __future__ import annotations

import asyncio
import json
import logging

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import remote_peers
from remote_peers import PeerStore, UpstreamResponse

BASE = "http://127.0.0.1:8420"
ORIGIN = "http://localhost:8420"
TOKEN = "tok-SECRET-abc123-do-not-leak"
PEER_URL = "https://studio.example.com"


def _json(status, body, headers=None):
    return UpstreamResponse(status, {"Content-Type": "application/json", **(headers or {})},
                            json.dumps(body).encode())


class FakeHttp:
    def __init__(self):
        self.calls = []
        self.routes = {}

    def __call__(self, method, url, headers, body):
        self.calls.append({"method": method, "url": url, "headers": dict(headers),
                           "body": json.loads(body) if body else None})
        handler = self.routes.get((method, url.split("?")[0]))
        if handler is None:
            return _json(404, {"error": "no route"})
        return handler() if callable(handler) else handler


@pytest.fixture
def env(tmp_path):
    secrets_box = {}

    def update(mutate):
        data = json.loads(json.dumps(secrets_box))
        result = mutate(data)
        result = data if result is None else result
        secrets_box.clear()
        secrets_box.update(result)
        return result

    store = PeerStore(meta_path=tmp_path / "remote_peers.json",
                      read_secrets=lambda: json.loads(json.dumps(secrets_box)),
                      update_secrets=update)
    http = FakeHttp()
    remote_peers.configure(store=store, http=http)
    app = FastAPI()
    app.include_router(remote_peers.router)
    client = TestClient(app, base_url=BASE)
    yield {"client": client, "http": http, "store": store, "secrets": secrets_box, "tmp": tmp_path}
    remote_peers.configure()


@pytest.fixture(autouse=True)
def _detach_capture():
    yield
    logger = logging.getLogger("cockpit.peers")
    for handler in list(logger.handlers):
        if getattr(handler, "_peers_test", False):
            logger.removeHandler(handler)
            logger.setLevel(logging.NOTSET)


def _capture(caplog):
    """Attach caplog straight to cockpit.peers: cockpit loggers may not propagate."""
    caplog.set_level(logging.DEBUG)
    caplog.handler._peers_test = True
    logging.getLogger("cockpit.peers").addHandler(caplog.handler)
    logging.getLogger("cockpit.peers").setLevel(logging.DEBUG)


def _pair(env, label="Desk"):
    env["http"].routes[("POST", PEER_URL + "/remote/v1/pair")] = _json(
        200, {"device_id": "dev-1", "token": TOKEN, "protocol": 1, "app_version": "x"})
    r = env["client"].post("/api/peers", json={"url": PEER_URL, "code": "ABCD2345", "label": label})
    assert r.status_code == 200, r.text
    return r.json()["peer"]


# -- pairing ---------------------------------------------------------------


def test_pairing_success_stores_token_out_of_band(env):
    peer = _pair(env)
    assert set(peer) == {"id", "label", "url", "added_at", "access_token_set"}
    assert peer["url"] == PEER_URL
    call = env["http"].calls[-1]
    assert call["url"] == PEER_URL + "/remote/v1/pair"
    assert call["body"]["code"] == "ABCD2345"
    assert env["secrets"]["remote_peer_tokens"][peer["id"]] == TOKEN
    assert TOKEN not in (env["tmp"] / "remote_peers.json").read_text()
    listed = env["client"].get("/api/peers").json()["peers"]
    assert listed == [peer]


def test_pairing_refused_code_is_400_and_stores_nothing(env):
    env["http"].routes[("POST", PEER_URL + "/remote/v1/pair")] = _json(400, {"error": "invalid or expired code"})
    r = env["client"].post("/api/peers", json={"url": PEER_URL, "code": "WRONG234", "label": "x"})
    assert r.status_code == 400
    assert env["client"].get("/api/peers").json() == {"peers": []}
    assert not env["secrets"].get("remote_peer_tokens")


def test_delete_peer_forgets_token(env):
    peer = _pair(env)
    assert env["client"].delete(f"/api/peers/{peer['id']}").status_code == 200
    assert env["secrets"]["remote_peer_tokens"] == {}
    assert env["client"].delete(f"/api/peers/{peer['id']}").status_code == 404


def test_default_secret_sink_is_config_json_not_settings(tmp_path, monkeypatch):
    import settings_store

    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    store = PeerStore(meta_path=tmp_path / "remote_peers.json")
    peer = store.add("L", PEER_URL, TOKEN, "d")
    assert TOKEN in (tmp_path / "config.json").read_text()
    assert store.token(peer.id) == TOKEN
    assert not (tmp_path / "settings.json").exists()


# -- token never leaks -----------------------------------------------------


def test_token_never_in_any_response_or_log(env, caplog):
    _capture(caplog)
    peer = _pair(env)
    pid = peer["id"]
    h = env["http"]
    h.routes[("GET", PEER_URL + "/remote/v1/hello")] = _json(200, {"protocol": 1})
    h.routes[("GET", PEER_URL + "/remote/v1/sessions")] = _json(200, {"sessions": []})
    h.routes[("GET", PEER_URL + "/remote/v1/catalog")] = _json(200, {"harnesses": []})
    h.routes[("GET", PEER_URL + "/remote/v1/workdirs")] = _json(200, {"workdirs": [], "roots": []})
    h.routes[("GET", PEER_URL + "/remote/v1/browse")] = _json(200, {"path": "", "entries": []})
    c = env["client"]
    bodies = [c.get("/api/peers").text, c.get(f"/api/peers/{pid}/status").text,
              c.get(f"/api/peers/{pid}/sessions").text, c.get(f"/api/peers/{pid}/catalog").text,
              c.get(f"/api/peers/{pid}/workdirs").text, c.get(f"/api/peers/{pid}/browse?path=C:/").text]
    for body in bodies:
        assert TOKEN not in body
    # Positive twin: the token WAS sent upstream, as a bearer.
    assert h.calls[-1]["headers"]["Authorization"] == f"Bearer {TOKEN}"
    assert caplog.records  # not vacuous: pairing logs an INFO line
    for record in caplog.records:
        assert TOKEN not in record.getMessage()


# -- status three-way split -------------------------------------------------


@pytest.mark.parametrize("resp,expected", [
    (UpstreamResponse(None, {}, b""), {"reachable": False, "authorized": None, "reason": "unreachable"}),
    (_json(401, {"detail": "unauthorized"}), {"reachable": True, "authorized": False, "reason": "unauthorized"}),
    (UpstreamResponse(302, {"Location": "https://team.cloudflareaccess.com/cdn-cgi/access/login"}, b""),
     {"reachable": True, "authorized": False, "reason": "access_required"}),
    (UpstreamResponse(200, {"Content-Type": "text/html"}, b"<!DOCTYPE html><html>"),
     {"reachable": True, "authorized": False, "reason": "access_required"}),
    (_json(200, {"protocol": 1}), {"reachable": True, "authorized": True, "reason": None}),
])
def test_status_split(env, resp, expected):
    peer = _pair(env)
    env["http"].routes[("GET", PEER_URL + "/remote/v1/hello")] = resp
    r = env["client"].get(f"/api/peers/{peer['id']}/status")
    assert r.status_code == 200
    assert r.json() == expected


def test_proxy_401_is_401_not_unreachable(env):
    peer = _pair(env)
    env["http"].routes[("GET", PEER_URL + "/remote/v1/sessions")] = _json(401, {"detail": "unauthorized"})
    r = env["client"].get(f"/api/peers/{peer['id']}/sessions")
    assert r.status_code == 401 and r.json()["reason"] == "unauthorized"
    env["http"].routes[("GET", PEER_URL + "/remote/v1/sessions")] = UpstreamResponse(None, {}, b"")
    r = env["client"].get(f"/api/peers/{peer['id']}/sessions")
    assert r.status_code == 502 and r.json()["reason"] == "unreachable"


def test_create_passes_only_contract_fields_and_quotes_ids(env):
    peer = _pair(env)
    h = env["http"]
    h.routes[("POST", PEER_URL + "/remote/v1/sessions")] = _json(201, {"session": {"id": "s1"}})
    r = env["client"].post(f"/api/peers/{peer['id']}/sessions",
                           json={"workdir": "C:/x", "harness": "codex", "model": "m", "effort": "high",
                                 "bypass": False, "name": "n", "permission_mode": "plan", "evil": 1})
    assert r.status_code == 201
    assert "evil" not in h.calls[-1]["body"] and h.calls[-1]["body"]["harness"] == "codex"
    # A decoded `?` in the id must stay inside its segment, not start a query.
    h.routes[("DELETE", PEER_URL + "/remote/v1/sessions/a%3Fb")] = _json(404, {"error": "unknown session"})
    r = env["client"].delete(f"/api/peers/{peer['id']}/sessions/a%3Fb")
    assert h.calls[-1]["url"] == PEER_URL + "/remote/v1/sessions/a%3Fb"
    assert r.status_code == 404


def test_unknown_peer_404(env):
    assert env["client"].get("/api/peers/nope/sessions").status_code == 404
    assert env["client"].get("/api/peers/nope/status").json()["reason"] == "unknown_peer"
    assert env["http"].calls == []


# -- URL validation ----------------------------------------------------------


@pytest.mark.parametrize("raw,expected", [
    ("https://studio.example.com", "https://studio.example.com"),
    ("https://studio.example.com/", "https://studio.example.com"),
    ("https://studio.example.com:8443", "https://studio.example.com:8443"),
    ("http://127.0.0.1:8420", "http://127.0.0.1:8420"),
    ("http://localhost:8421", "http://localhost:8421"),
    ("http://[::1]:8420", "http://[::1]:8420"),
    ("http://studio.example.com", None),
    ("http://192.168.1.5:8420", None),
    ("ftp://studio.example.com", None),
    ("https://user:pw@studio.example.com", None),
    ("https://studio.example.com/remote/v1", None),
    ("https://studio.example.com?x=1", None),
    ("https://", None),
    ("studio.example.com", None),
    ("", None),
    (None, None),
])
def test_url_validation(raw, expected):
    assert remote_peers.normalize_peer_url(raw) == expected


def test_add_with_bad_url_makes_no_request(env):
    r = env["client"].post("/api/peers", json={"url": "http://evil.example", "code": "ABCD2345"})
    assert r.status_code == 400
    assert env["http"].calls == []


# -- WebSocket ---------------------------------------------------------------


class FakeUpstream:
    def __init__(self, frames):
        self.frames = asyncio.Queue()
        for f in frames:
            self.frames.put_nowait(f)
        self.sent = []
        self.closed = False

    async def recv(self):
        return await self.frames.get()

    async def send(self, text):
        self.sent.append(text)

    async def close(self):
        self.closed = True


def _with_ws(env, upstream):
    opened = []

    async def connect(url, headers):
        opened.append((url, headers))
        return upstream

    remote_peers.configure(store=env["store"], http=env["http"], ws_connect=connect)
    return opened


def test_ws_refused_origin_before_accept_and_before_lookup(env, monkeypatch):
    peer = _pair(env)
    looked = []
    monkeypatch.setattr(env["store"], "get", lambda pid: looked.append(pid))
    opened = _with_ws(env, FakeUpstream([]))
    with pytest.raises(WebSocketDisconnect) as refused:
        with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1",
                                             headers={"origin": "http://evil.example"}):
            pass
    assert looked == [] and opened == []
    # Unknown peer with a GOOD origin: the same refusal, indistinguishable.
    with pytest.raises(WebSocketDisconnect) as unknown:
        with env["client"].websocket_connect("ws://127.0.0.1:8420/ws/peer/nope/s1", headers={"origin": ORIGIN}):
            pass
    assert refused.value.code == unknown.value.code
    assert refused.value.reason == unknown.value.reason
    assert opened == []


def test_ws_frame_round_trip(env):
    peer = _pair(env)
    upstream = FakeUpstream([
        json.dumps({"type": "replay_start", "reset": True, "truncated": False, "cols": 120, "rows": 30}),
        json.dumps({"type": "output", "seq": 3, "data": "hello"}),
        json.dumps({"type": "replay_end", "seq": 3}),
        json.dumps({"type": "resize", "cols": 100, "rows": 20}),
        json.dumps({"type": "output", "seq": 4, "data": "world"}),
    ])
    opened = _with_ws(env, upstream)
    h = env["http"]
    h.routes[("POST", PEER_URL + "/remote/v1/sessions/s1/input")] = _json(200, {"accepted": True, "duplicate": False})
    h.routes[("POST", PEER_URL + "/remote/v1/sessions/s1/resize")] = _json(200, {"resized": True})
    with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1?replay=1&after=2",
                                         headers={"origin": ORIGIN}) as ws:
        assert ws.receive_json() == {"type": "replay_start", "reset": True, "truncated": False}
        assert ws.receive_json() == {"type": "output", "seq": 3, "data": "hello"}
        assert ws.receive_json() == {"type": "replay_end", "seq": 3}
        # The resize frame is not a page frame; the next one is live output.
        assert ws.receive_json() == {"type": "output", "seq": 4, "data": "world"}
        ws.send_text('{"type":"resize","cols":80,"rows":24}')
        ws.send_text("ls\r")
        upstream.frames.put_nowait(json.dumps({"type": "ended"}))
        # No resize_failed: the next thing the page sees is the end banner.
        assert "[Session ended]" in ws.receive_text()
    url, headers = opened[0]
    assert url == "wss://studio.example.com/remote/v1/sessions/s1/stream?after=2"
    assert headers == {"Authorization": f"Bearer {TOKEN}"}
    sent = [c for c in h.calls if "/sessions/s1/" in c["url"]]
    assert [c["url"].rsplit("/", 1)[1] for c in sent] == ["resize", "input"]
    assert sent[0]["body"] == {"cols": 80, "rows": 24}
    assert sent[1]["body"]["text"] == "ls\r" and sent[1]["body"]["submit"] is False
    assert "CF-Access-Client-Id" not in sent[0]["headers"]
    assert upstream.closed


def test_ws_resize_on_an_older_peer_degrades_to_resize_failed(env):
    peer = _pair(env)
    upstream = FakeUpstream([json.dumps({"type": "replay_start", "reset": True, "truncated": False}),
                             json.dumps({"type": "replay_end", "seq": 0})])
    _with_ws(env, upstream)
    # No resize route registered: FakeHttp answers 404, as a pre-resize Studio does.
    with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1?replay=1",
                                         headers={"origin": ORIGIN}) as ws:
        ws.receive_json()
        ws.receive_json()
        ws.send_text('{"type":"resize","cols":80,"rows":24}')
        assert ws.receive_text() == '{"type":"resize_failed"}'
        upstream.frames.put_nowait(json.dumps({"type": "ended"}))
        assert "[Session ended]" in ws.receive_text()
    assert any(c["url"].endswith("/sessions/s1/resize") for c in env["http"].calls)


# -- Cloudflare Access service token ----------------------------------------

CF_ID = "cfid-1234.access"
CF_SECRET = "cfsecret-SHOULD-NEVER-LEAK-987"


def _pair_with_access(env):
    env["http"].routes[("POST", PEER_URL + "/remote/v1/pair")] = _json(
        200, {"device_id": "dev-1", "token": TOKEN, "protocol": 1, "app_version": "x"})
    r = env["client"].post("/api/peers", json={"url": PEER_URL, "code": "ABCD2345", "label": "Desk",
                                               "cf_client_id": CF_ID, "cf_client_secret": CF_SECRET})
    assert r.status_code == 200, r.text
    return r.json()["peer"]


@pytest.mark.parametrize("extra", [
    {"cf_client_id": CF_ID}, {"cf_client_secret": CF_SECRET},
    {"cf_client_id": CF_ID, "cf_client_secret": ""}, {"cf_client_id": CF_ID, "cf_client_secret": 5},
    {"cf_client_id": CF_ID, "cf_client_secret": "a\r\nX-Evil: 1"},
])
def test_half_access_token_is_400_and_sends_nothing(env, extra):
    r = env["client"].post("/api/peers", json={"url": PEER_URL, "code": "ABCD2345", **extra})
    assert r.status_code == 400
    assert env["http"].calls == []


def test_access_headers_on_pairing_http_and_ws(env):
    peer = _pair_with_access(env)
    assert peer["access_token_set"] is True
    pair_call = env["http"].calls[-1]
    assert pair_call["headers"]["CF-Access-Client-Id"] == CF_ID
    assert pair_call["headers"]["CF-Access-Client-Secret"] == CF_SECRET
    env["http"].routes[("GET", PEER_URL + "/remote/v1/sessions")] = _json(200, {"sessions": []})
    env["client"].get(f"/api/peers/{peer['id']}/sessions")
    call = env["http"].calls[-1]
    assert call["headers"]["CF-Access-Client-Secret"] == CF_SECRET
    assert call["headers"]["Authorization"] == f"Bearer {TOKEN}"
    upstream = FakeUpstream([json.dumps({"type": "ended"})])
    opened = _with_ws(env, upstream)
    with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1?replay=1",
                                         headers={"origin": ORIGIN}) as ws:
        assert "[Session ended]" in ws.receive_text()
    assert opened[0][1] == {"Authorization": f"Bearer {TOKEN}",
                            "CF-Access-Client-Id": CF_ID, "CF-Access-Client-Secret": CF_SECRET}


def test_access_headers_absent_when_unset(env):
    peer = _pair(env)
    assert peer["access_token_set"] is False
    assert not any(k.startswith("CF-Access") for k in env["http"].calls[-1]["headers"])
    upstream = FakeUpstream([json.dumps({"type": "ended"})])
    opened = _with_ws(env, upstream)
    with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1?replay=1",
                                         headers={"origin": ORIGIN}) as ws:
        assert "[Session ended]" in ws.receive_text()
    assert opened[0][1] == {"Authorization": f"Bearer {TOKEN}"}


def test_put_access_sets_and_clears(env):
    peer = _pair(env)
    c = env["client"]
    assert c.put(f"/api/peers/{peer['id']}/access", json={"cf_client_id": CF_ID}).status_code == 400
    assert c.put("/api/peers/nope/access", json={}).status_code == 404
    r = c.put(f"/api/peers/{peer['id']}/access", json={"cf_client_id": CF_ID, "cf_client_secret": CF_SECRET})
    assert r.status_code == 200 and r.json()["peer"]["access_token_set"] is True
    assert c.get("/api/peers").json()["peers"][0]["access_token_set"] is True
    assert env["secrets"]["remote_peer_access"][peer["id"]]["client_secret"] == CF_SECRET
    r = c.put(f"/api/peers/{peer['id']}/access", json={"cf_client_id": None, "cf_client_secret": None})
    assert r.json()["peer"]["access_token_set"] is False
    assert peer["id"] not in env["secrets"]["remote_peer_access"]


def test_access_refused_is_distinct(env):
    peer = _pair_with_access(env)
    url = PEER_URL + "/remote/v1/hello"
    env["http"].routes[("GET", url)] = UpstreamResponse(403, {"Content-Type": "text/html"}, b"<html>Forbidden")
    assert env["client"].get(f"/api/peers/{peer['id']}/status").json() == {
        "reachable": True, "authorized": False, "reason": "access_refused"}
    env["http"].routes[("GET", url)] = _json(401, {"detail": "unauthorized"})
    assert env["client"].get(f"/api/peers/{peer['id']}/status").json()["reason"] == "unauthorized"
    # Without a service token the same challenge stays access_required.
    plain = _pair(env)
    env["http"].routes[("GET", url)] = UpstreamResponse(
        302, {"Location": "https://team.cloudflareaccess.com/cdn-cgi/access/login"}, b"")
    assert env["client"].get(f"/api/peers/{plain['id']}/status").json()["reason"] == "access_required"


def test_access_secret_never_in_any_response_or_log(env, caplog):
    _capture(caplog)
    peer = _pair_with_access(env)
    c = env["client"]
    env["http"].routes[("GET", PEER_URL + "/remote/v1/hello")] = _json(200, {"protocol": 1})
    bodies = [c.get("/api/peers").text, c.get(f"/api/peers/{peer['id']}/status").text,
              c.put(f"/api/peers/{peer['id']}/access",
                    json={"cf_client_id": CF_ID, "cf_client_secret": CF_SECRET}).text]
    for body in bodies:
        assert CF_SECRET not in body and CF_ID not in body and TOKEN not in body
    assert CF_SECRET not in (env["tmp"] / "remote_peers.json").read_text()
    assert caplog.records
    for record in caplog.records:
        msg = record.getMessage()
        assert CF_SECRET not in msg and TOKEN not in msg


def test_input_retry_reuses_request_id(env, monkeypatch):
    monkeypatch.setattr(remote_peers, "_INPUT_RETRY_DELAY_S", 0)
    peer = _pair(env)
    answers = [UpstreamResponse(None, {}, b""), UpstreamResponse(None, {}, b""),
               _json(200, {"accepted": True, "duplicate": True})]
    env["http"].routes[("POST", PEER_URL + "/remote/v1/sessions/s1/input")] = lambda: answers.pop(0)
    store = env["store"]
    p = store.get(peer["id"])
    ok = asyncio.run(remote_peers.send_input(p, store.token(p.id), "s1", "x"))
    assert ok
    ids = [c["body"]["request_id"] for c in env["http"].calls if c["url"].endswith("/input")]
    assert len(ids) == 3 and len(set(ids)) == 1


def test_input_401_is_not_retried(env, monkeypatch):
    monkeypatch.setattr(remote_peers, "_INPUT_RETRY_DELAY_S", 0)
    peer = _pair(env)
    env["http"].routes[("POST", PEER_URL + "/remote/v1/sessions/s1/input")] = _json(401, {"detail": "unauthorized"})
    p = env["store"].get(peer["id"])
    assert asyncio.run(remote_peers.send_input(p, TOKEN, "s1", "x")) is False
    assert len([c for c in env["http"].calls if c["url"].endswith("/input")]) == 1


# -- security read follow-ups (N7d) ------------------------------------------


@pytest.mark.parametrize("bad", ["", ".", "..", " .. "])
def test_dot_segments_are_refused_before_any_url(env, bad):
    peer = _pair(env)
    before = len(env["http"].calls)
    resp = asyncio.run(remote_peers.peer_close_session(peer["id"], bad))
    assert resp.status_code == 404 and json.loads(resp.body) == {"error": "unknown session"}
    resp = asyncio.run(remote_peers.peer_sessions(bad))
    assert resp.status_code == 404
    assert len(env["http"].calls) == before


def test_ws_dot_segment_session_is_the_same_refusal(env):
    peer = _pair(env)
    opened = _with_ws(env, FakeUpstream([]))
    with pytest.raises(WebSocketDisconnect) as dots:
        with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/%2E%2E",
                                             headers={"origin": ORIGIN}):
            pass
    with pytest.raises(WebSocketDisconnect) as unknown:
        with env["client"].websocket_connect("ws://127.0.0.1:8420/ws/peer/nope/s1", headers={"origin": ORIGIN}):
            pass
    assert (dots.value.code, dots.value.reason) == (unknown.value.code, unknown.value.reason)
    assert opened == []


def test_http_client_ignores_environment_proxies(monkeypatch):
    import http.server
    import threading

    class Hello(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            body = json.dumps({"protocol": 1}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Hello)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        # A dead proxy: any request routed through it fails to connect.
        for name in ("HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"):
            monkeypatch.setenv(name, "http://127.0.0.1:9")
        for name in ("NO_PROXY", "no_proxy"):
            monkeypatch.delenv(name, raising=False)
        url = f"http://127.0.0.1:{server.server_address[1]}/remote/v1/hello"
        resp = remote_peers.urllib_client("GET", url, {"User-Agent": "t"}, None)
        assert resp.status == 200 and resp.json() == {"protocol": 1}
    finally:
        server.shutdown()


@pytest.mark.parametrize("raw,verdict", [
    (json.dumps({"type": "output", "seq": 1, "data": "x"}), "send"),
    (json.dumps({"type": "replay_start", "reset": True, "truncated": False, "cols": 80, "rows": 24}), "send"),
    (json.dumps({"type": "replay_end", "seq": 0}), "send"),
    (json.dumps({"type": "ended"}), "ended"),
    (json.dumps({"type": "resize", "cols": 80, "rows": 24}), "skip"),
    (json.dumps({"type": "pong"}), "skip"),
    (json.dumps({"type": "output", "seq": "1", "data": "x"}), "bad"),
    (json.dumps({"type": "output", "seq": True, "data": "x"}), "bad"),
    (json.dumps({"type": "output", "seq": -1, "data": "x"}), "bad"),
    (json.dumps({"type": "output", "seq": 1, "data": 5}), "bad"),
    (json.dumps({"type": "replay_start", "reset": "yes"}), "bad"),
    (json.dumps({"type": "replay_end"}), "bad"),
    (json.dumps({"type": "exec", "cmd": "x"}), "bad"),
    (json.dumps([1, 2]), "bad"),
    ("not json", "bad"),
    (b"bytes", "bad"),
    (json.dumps({"type": "output", "seq": 1, "data": "x" * (1024 * 1024)}), "bad"),
], ids=lambda v: v if isinstance(v, str) and len(v) < 40 else "frame")
def test_page_frame_validation(raw, verdict):
    assert remote_peers.page_frame(raw)[0] == verdict


def test_send_strips_unknown_fields():
    _v, frame = remote_peers.page_frame(json.dumps({"type": "output", "seq": 2, "data": "a", "evil": 1}))
    assert frame == {"type": "output", "seq": 2, "data": "a"}


def test_ws_invalid_upstream_frame_closes_without_logging_content(env, caplog):
    _capture(caplog)
    peer = _pair(env)
    secret_payload = "PAYLOAD-CONTENT-77"
    upstream = FakeUpstream([json.dumps({"type": "output", "seq": 1, "data": "ok"}),
                             json.dumps({"type": "mystery", "data": secret_payload})])
    _with_ws(env, upstream)
    with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1?replay=1",
                                         headers={"origin": ORIGIN}) as ws:
        assert ws.receive_json() == {"type": "output", "seq": 1, "data": "ok"}
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1011
    assert upstream.closed
    assert any("invalid frame" in r.getMessage() for r in caplog.records)
    assert not any(secret_payload in r.getMessage() for r in caplog.records)


def test_ws_input_backlog_is_bounded_and_announced(env, monkeypatch):
    import time as _time

    monkeypatch.setattr(remote_peers, "_INPUT_MAX_ITEMS", 2)
    peer = _pair(env)

    def hung():
        _time.sleep(0.5)
        return _json(200, {"accepted": True, "duplicate": False})

    env["http"].routes[("POST", PEER_URL + "/remote/v1/sessions/s1/input")] = hung
    _with_ws(env, FakeUpstream([]))
    with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1?replay=1",
                                         headers={"origin": ORIGIN}) as ws:
        for ch in "abcdefgh":
            ws.send_text(ch)
        assert "not accepting input" in ws.receive_text()
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1013


def test_ws_input_backlog_bounded_by_bytes(env, monkeypatch):
    monkeypatch.setattr(remote_peers, "_INPUT_MAX_BYTES", 10)
    peer = _pair(env)
    _with_ws(env, FakeUpstream([]))
    with env["client"].websocket_connect(f"ws://127.0.0.1:8420/ws/peer/{peer['id']}/s1?replay=1",
                                         headers={"origin": ORIGIN}) as ws:
        ws.send_text("x" * 11)
        assert "not accepting input" in ws.receive_text()
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_text()
    assert closed.value.code == 1013


def test_config_json_writers_share_one_lock(tmp_path, monkeypatch):
    """Five modules' setters racing: every key must survive."""
    import threading
    import time as _time

    import harness_manager
    import remote_tunnel
    import settings_store

    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    real_read = settings_store._read_config

    def slow_read():
        data = real_read()
        _time.sleep(0.002)  # widen the read-modify-write window
        return data

    monkeypatch.setattr(settings_store, "_read_config", slow_read)
    store = PeerStore(meta_path=tmp_path / "remote_peers.json")
    setters = [
        lambda: settings_store.set_ui_key("or-key"),
        lambda: settings_store.set_provider_ui_key("anthropic", "an-key"),
        lambda: remote_tunnel.set_token("tunnel-tok"),
        lambda: harness_manager.set_key("harness-key"),
        lambda: store.add("L", PEER_URL, TOKEN, "d", ("cid", "csec")),
    ]
    barrier = threading.Barrier(len(setters))

    def run(fn):
        barrier.wait()
        for _ in range(10):
            fn()

    threads = [threading.Thread(target=run, args=(fn,)) for fn in setters]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    data = json.loads((tmp_path / "config.json").read_text())
    assert data[settings_store._KEY_FIELD] == "or-key"
    assert data[settings_store._ANTHROPIC_KEY_FIELD] == "an-key"
    assert data[remote_tunnel._TOKEN_FIELD] == "tunnel-tok"
    assert data[harness_manager.KEY_FIELD] == "harness-key"
    assert len(data["remote_peer_tokens"]) == 10
    assert len(data["remote_peer_access"]) == 10
