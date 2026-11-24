"""The local-network listener serves the remote surface and nothing else.

Owner, 2026-11-23: "we are missing the local tab for those whom are local."
Studio's main port can never be opened to a network (its /api routes carry no
authentication), so local mode is a SECOND port with an allowlist in front.
"""

import asyncio
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import remote_gateway  # noqa: E402
import remote_lan  # noqa: E402
import settings_store  # noqa: E402


@pytest.mark.parametrize("host,expected", [
    ("192.168.1.20", True),
    ("10.0.0.7", True),
    ("172.16.4.1", True),
    ("127.0.0.1", True),
    ("169.254.10.2", True),
    ("100.101.102.103", True),      # CGNAT, where overlay networks live
    ("::1", True),
    ("fd12:3456::1", True),
    ("fe80::1%eth0", True),
    ("::ffff:192.168.1.20", True),
    ("8.8.8.8", False),
    ("192.0.2.1", False),           # documentation range, not a LAN
    ("198.18.0.1", False),
    ("240.0.0.1", False),
    ("255.255.255.255", False),
    ("172.32.0.1", False),
    ("100.128.0.1", False),
    ("2001:4860:4860::8888", False),
    ("::ffff:8.8.8.8", False),
    ("0.0.0.0", False),
    ("example.com", False),
    ("", False),
    (None, False),
])
def test_only_private_range_clients_are_served(host, expected):
    assert remote_lan.client_allowed(host) is expected


@pytest.mark.parametrize("path,expected", [
    ("/remote/v1/hello", True),
    ("/remote/v1/pair", True),
    ("/remote/v1/sessions/abc/stream", True),
    ("/.well-known/plexar", True),
    ("/", False),
    ("/api/version", False),
    ("/api/terminals", False),
    ("/api/remote/status", False),
    ("/ws/terminal/abc", False),
    ("/ws/peer/a/b", False),
    ("/shim/lmstudio/s/x", False),
    ("/v1/messages", False),
    ("/remote/v10/hello", False),
    ("/remote/v1/../../api/version", False),
    ("/remote/v1//api", False),
    ("/remote/v1/..\\api", False),
    (None, False),
])
def test_only_the_remote_surface_is_a_path_here(path, expected):
    assert remote_lan.path_allowed(path) is expected


class _Inner:
    def __init__(self):
        self.calls = []

    async def __call__(self, scope, receive, send):
        self.calls.append((scope["type"], scope.get("path")))
        if scope["type"] == "http":
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"inner"})


async def _drive(app, scope, messages=()):
    sent = []
    queue = list(messages)

    async def receive():
        return queue.pop(0)

    async def send(message):
        sent.append(message)

    await app(scope, receive, send)
    return sent


def _scope(kind, path, client="192.168.1.50"):
    return {"type": kind, "path": path, "client": (client, 50000)}


async def test_a_remote_path_from_the_network_reaches_the_app():
    inner = _Inner()
    sent = await _drive(remote_lan.restricted_app(inner), _scope("http", "/remote/v1/hello"))
    assert inner.calls == [("http", "/remote/v1/hello")]
    assert sent[0]["status"] == 200


@pytest.mark.parametrize("path", ["/api/terminals", "/api/version", "/", "/api/shutdown", "/remote/v1/../../api/version"])
async def test_everything_else_is_404_before_the_app(path):
    inner = _Inner()
    sent = await _drive(remote_lan.restricted_app(inner), _scope("http", path))
    assert inner.calls == []
    assert sent[0]["status"] == 404
    assert json.loads(sent[1]["body"]) == {"error": "not found"}


async def test_a_public_client_is_refused_even_on_a_remote_path():
    inner = _Inner()
    sent = await _drive(remote_lan.restricted_app(inner), _scope("http", "/remote/v1/hello", client="8.8.8.8"))
    assert inner.calls == []
    assert sent[0]["status"] == 404


async def test_a_request_with_no_client_address_is_refused():
    inner = _Inner()
    sent = await _drive(remote_lan.restricted_app(inner), {"type": "http", "path": "/remote/v1/hello"})
    assert inner.calls == []
    assert sent[0]["status"] == 404


async def test_the_terminal_socket_is_refused_before_accept_and_the_stream_is_not():
    inner = _Inner()
    app = remote_lan.restricted_app(inner)
    sent = await _drive(app, _scope("websocket", "/ws/terminal/abc"))
    assert inner.calls == []
    assert sent == [{"type": "websocket.close", "code": 1008}]
    await _drive(app, _scope("websocket", "/remote/v1/sessions/abc/stream"))
    assert inner.calls == [("websocket", "/remote/v1/sessions/abc/stream")]


def _pair_scope(client="192.168.1.50", content_type=b"application/json"):
    scope = _scope("http", "/remote/v1/pair", client=client)
    scope["method"] = "POST"
    scope["headers"] = [(b"content-type", content_type)] if content_type else []
    return scope


async def test_pairing_on_this_port_needs_json_so_a_browser_page_cannot_send_it():
    inner = _Inner()
    app = remote_lan.restricted_app(inner)
    for content_type in (b"text/plain", b"application/x-www-form-urlencoded", None):
        sent = await _drive(app, _pair_scope(content_type=content_type))
        assert sent[0]["status"] == 415
    assert inner.calls == []
    sent = await _drive(app, _pair_scope(content_type=b"application/json; charset=utf-8"))
    assert sent[0]["status"] == 200


async def test_one_address_cannot_send_the_five_misses_that_burn_a_code():
    inner = _Inner()
    app = remote_lan.restricted_app(inner)
    statuses = [(await _drive(app, _pair_scope()))[0]["status"] for _ in range(6)]
    assert statuses == [200, 200, 200, 200, 429, 429]
    assert len(inner.calls) == 4
    # Another device on the network is counted on its own.
    assert (await _drive(app, _pair_scope(client="192.168.1.51")))[0]["status"] == 200


def test_the_pairing_window_reopens_and_the_table_stays_bounded():
    throttle = remote_lan._PairThrottle()
    assert [throttle.allow("a", now=t) for t in (0, 1, 2, 3, 4)] == [True, True, True, True, False]
    assert throttle.allow("a", now=301.5) is True
    for i in range(1000):
        throttle.allow(f"c{i}", now=400)
    assert len(throttle._seen) <= remote_lan._PAIR_TRACKED_CLIENTS


async def test_lifespan_is_never_forwarded_to_the_app():
    inner = _Inner()
    sent = await _drive(
        remote_lan.restricted_app(inner), {"type": "lifespan"},
        [{"type": "lifespan.startup"}, {"type": "lifespan.shutdown"}],
    )
    assert inner.calls == []
    assert [m["type"] for m in sent] == ["lifespan.startup.complete", "lifespan.shutdown.complete"]


@pytest.mark.parametrize("settings,expected", [
    ({}, (False, 8421)),
    ({"remote": {"enabled": True}}, (False, 8421)),
    ({"remote": {"enabled": True, "lan": {"enabled": True, "port": 9000}}}, (True, 9000)),
    ({"remote": {"enabled": False, "lan": {"enabled": True, "port": 9000}}}, (False, 9000)),
    ({"remote": {"enabled": True, "lan": {"enabled": False}}}, (False, 8421)),
    ({"remote": {"enabled": True, "lan": {"enabled": True, "port": 80}}}, (True, 8421)),
    ({"remote": {"enabled": True, "lan": {"enabled": True, "port": "x"}}}, (True, 8421)),
    ({"remote": {"enabled": True, "lan": {"enabled": True, "port": True}}}, (True, 8421)),
    (None, (False, 8421)),
])
def test_the_listener_needs_both_switches(settings, expected):
    assert remote_lan.lan_settings(settings) == expected


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(port, path):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return type(e).__name__, b""


async def test_a_real_listener_starts_serves_and_stops():
    port = _free_port()
    state = {"remote": {"enabled": True, "lan": {"enabled": True, "port": port}}}
    inner = _Inner()
    listener = remote_lan.LanListener()
    listener.configure(inner, lambda: state)
    try:
        status = await listener.reconcile()
        assert status == {"running": True, "port": port, "error": None}
        assert await asyncio.to_thread(_get, port, "/remote/v1/hello") == (200, b"inner")
        assert (await asyncio.to_thread(_get, port, "/api/terminals"))[0] == 404
        assert inner.calls == [("http", "/remote/v1/hello")]

        # Saving the same settings again leaves the running server alone.
        server = listener._server
        await listener.reconcile()
        assert listener._server is server

        state["remote"]["lan"]["enabled"] = False
        status = await listener.reconcile()
        assert status == {"running": False, "port": None, "error": None}
        assert (await asyncio.to_thread(_get, port, "/remote/v1/hello"))[0] not in (200, 404)
    finally:
        await listener.stop()


async def test_turning_remote_access_off_stops_the_listener():
    port = _free_port()
    state = {"remote": {"enabled": True, "lan": {"enabled": True, "port": port}}}
    listener = remote_lan.LanListener()
    listener.configure(_Inner(), lambda: state)
    try:
        assert (await listener.reconcile())["running"] is True
        state["remote"]["enabled"] = False
        assert (await listener.reconcile())["running"] is False
    finally:
        await listener.stop()


async def test_a_taken_port_is_a_reported_state_not_an_exit():
    taken = socket.socket()
    taken.bind(("0.0.0.0", 0))
    taken.listen(1)
    port = taken.getsockname()[1]
    listener = remote_lan.LanListener()
    listener.configure(_Inner(), lambda: {"remote": {"enabled": True, "lan": {"enabled": True, "port": port}}})
    try:
        status = await listener.reconcile()
        assert status["running"] is False
        assert str(port) in status["error"]
    finally:
        taken.close()
        await listener.stop()


async def test_an_unconfigured_listener_does_nothing():
    listener = remote_lan.LanListener()
    assert await listener.reconcile() == {"running": False, "port": None, "error": None}


async def test_a_settings_read_that_raises_is_reported_not_raised():
    def boom():
        raise RuntimeError("disk")

    listener = remote_lan.LanListener()
    listener.configure(_Inner(), boom)
    status = await listener.reconcile()
    assert status["running"] is False and status["error"]


# -- what the pairing code carries ------------------------------------------


def _backend(settings):
    return SimpleNamespace(settings=lambda: settings)


def test_pairing_uses_the_local_address_in_local_mode(monkeypatch):
    monkeypatch.setattr(remote_gateway, "_lan_ipv4", lambda: "192.168.1.20")
    monkeypatch.setattr(remote_gateway, "_backend", _backend({
        "remote": {"enabled": True, "hostname": "https://studio.example.com", "access_required": True,
                   "lan": {"enabled": True, "port": 8421}},
    }))
    assert remote_gateway._pairing_url() == "http://192.168.1.20:8421"
    # Access sits in front of a tunnel, never in front of this listener.
    assert json.loads(remote_gateway.qr_payload("http://192.168.1.20:8421", "ABCD2345")) == {
        "v": 1, "url": "http://192.168.1.20:8421", "code": "ABCD2345",
    }


def test_pairing_keeps_the_saved_address_when_local_mode_is_off(monkeypatch):
    monkeypatch.setattr(remote_gateway, "_backend", _backend({
        "remote": {"enabled": True, "hostname": "https://studio.example.com/", "access_required": True,
                   "lan": {"enabled": False, "port": 8421}},
    }))
    assert remote_gateway._pairing_url() == "https://studio.example.com"
    assert json.loads(remote_gateway.qr_payload("https://studio.example.com", "ABCD2345"))["access"] is True


def test_status_offers_an_address_only_while_something_listens(monkeypatch):
    monkeypatch.setattr(remote_gateway, "_lan_ipv4", lambda: "192.168.1.20")
    monkeypatch.setattr(remote_gateway, "_backend", _backend({
        "remote": {"enabled": True, "lan": {"enabled": True, "port": 8421}},
    }))
    monkeypatch.setattr(remote_lan.listener, "status", lambda: {"running": False, "port": None, "error": "Port 8421 is not available"})  # noqa: E501
    assert remote_gateway._lan_status() == {
        "enabled": True, "port": 8421, "running": False, "url": "", "error": "Port 8421 is not available",
    }
    monkeypatch.setattr(remote_lan.listener, "status", lambda: {"running": True, "port": 8421, "error": None})
    assert remote_gateway._lan_status()["url"] == "http://192.168.1.20:8421"


# -- the setting -------------------------------------------------------------


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_store, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    return settings_store


def test_local_mode_is_off_by_default(store):
    assert store.read_settings()["remote"]["lan"] == {"enabled": False, "port": 8421}


def test_the_port_is_a_whole_number_above_the_privileged_range(store):
    assert store.update_settings({"remote": {"lan": {"enabled": True, "port": 9000}}})["remote"]["lan"] == {
        "enabled": True, "port": 9000,
    }
    for bad in (80, 70000, 8421.5, "8421"):
        with pytest.raises(ValueError):
            store.update_settings({"remote": {"lan": {"port": bad}}})
    assert store.read_settings()["remote"]["lan"]["port"] == 9000
