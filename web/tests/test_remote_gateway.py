"""Tests for the Studio Remote gateway routers.

The app here includes BOTH routers and nothing else -- no origin guard, no
server.py. That is the point: the gateway is wired through ``configure()`` with
fake callables, so its contract is exercised without the application it will
eventually live inside.
"""

from __future__ import annotations

import json
import logging
import os
import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import remote_gateway  # noqa: E402
from remote_devices import DeviceStore  # noqa: E402
from remote_gateway import PROTOCOL_VERSION, RemoteBackend  # noqa: E402

BASE = "http://127.0.0.1:8420"

FULL_SESSION = {
    "id": "t1",
    "name": "work",
    "harness": "claude-code",
    "model": "claude-opus-5",
    "working_dir": "C:/tmp",
    "alive": True,
    "activity_state": "idle",
    "created_at": "2026-09-08T00:00:00+00:00",
    "effort": "high",
    # Fields that must NEVER reach a phone:
    "jsonl_path": "C:/secret.jsonl",
    "cost": 1.23,
    "tokens": 4567,
    "claude_session_id": "abc-def",
}


def browse_entry(path, name, *, git=False, branch=None, sessions=0):
    """One row shaped like server._browse_entry -- extra fields included.

    `entry_count`, `dirty` and `skipped` are here ON PURPOSE: the gateway must
    drop them, and a fixture that never produced them could not prove it.
    """
    return {
        "name": name,
        "path": path,
        "git": git,
        "branch": branch,
        "dirty": None,
        "session_count": sessions,
        "entry_count": 12,
        "skipped": False,
    }


class Backend:
    """A recording fake of everything the gateway is allowed to reach."""

    def __init__(self):
        self.settings_dict = {"remote": {"enabled": True, "hostname": ""}}
        self.sessions = [dict(FULL_SESSION)]
        self.submitted = []
        self.raw = []
        self.interrupts = []
        self.created = []
        self.create_error = None
        self.deleted = []
        self.delete_result = True
        self.browsed = []
        self.browse_error = None
        self.browse_reply = {
            "dirs": ["C:/tmp/a"],
            "parent": "C:/tmp",
            "entries": [browse_entry("C:/tmp/a", "a", git=True, branch="main", sessions=2)],
        }
        self.roots_reply = {"dirs": ["C:\\", "D:\\"], "parent": "", "entries": []}
        self.history = [
            {"path": "C:/hist/one", "last_used": "2026-09-01T00:00:00+00:00"},
            {"path": "C:/hist/two", "last_used": "2026-08-01T00:00:00+00:00"},
        ]
        # Set by the rig fixture to a real tmp directory.
        self.upload_root = None
        self.branches = {"C:/tmp": "main"}
        self.claude_messages = []
        self.codex_page = {"messages": [], "before": None, "has_more": False, "available": True}
        self.saved = []
        self.save_error = None
        self.models_reply = {
            "models": [
                {"id": "claude-opus-5", "display_name": "Claude Opus 5"},
                {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5"},
            ],
            "source": "live",
        }

    def as_remote_backend(self) -> RemoteBackend:
        return RemoteBackend(
            settings=lambda: self.settings_dict,
            app_version=lambda: "2.1.7",
            list_sessions=lambda: self.sessions,
            get_session=self._get_session,
            create_session=self._create,
            submit=self._submit,
            write_raw=self._write_raw,
            interrupt=self._interrupt,
            browse=self._browse,
            delete_session=self._delete,
            recent_workdirs=self._recent_workdirs,
            anthropic_models=self._models,
            messages_claude=self._claude_messages,
            transcript_codex=self._codex_transcript,
            upload_dir=lambda: str(self.upload_root),
            save_upload=self._save_upload,
            git_branch=lambda workdir: self.branches.get(workdir),
        )

    def _claude_messages(self, session):
        return self.claude_messages

    def _codex_transcript(self, session, before, limit):
        self.codex_args = (before, limit)
        return self.codex_page

    async def _save_upload(self, filename, content):
        if self.save_error:
            raise ValueError(self.save_error)
        dest = os.path.join(str(self.upload_root), filename)
        with open(dest, "wb") as handle:
            handle.write(content)
        self.saved.append((filename, len(content)))
        return dest

    def _get_session(self, terminal_id):
        return next((s for s in self.sessions if s["id"] == terminal_id), None)

    async def _browse(self, path):
        self.browsed.append(path)
        if self.browse_error is not None:
            raise self.browse_error
        return self.roots_reply if path == "" else self.browse_reply

    def _delete(self, terminal_id):
        """SYNCHRONOUS on purpose -- pty_manager.kill_terminal is."""
        self.deleted.append(terminal_id)
        self.sessions = [s for s in self.sessions if s["id"] != terminal_id]
        return self.delete_result

    def _recent_workdirs(self, limit):
        self.history_limit = limit
        return self.history

    async def _models(self):
        return self.models_reply

    async def _create(self, body):
        if self.create_error:
            raise ValueError(self.create_error)
        self.created.append(body)
        made = dict(FULL_SESSION)
        made["id"] = "t2"
        made["name"] = body.get("name") or "new"
        self.sessions.append(made)
        return made

    async def _submit(self, terminal_id, text):
        self.submitted.append((terminal_id, text))
        return True

    async def _write_raw(self, terminal_id, data):
        self.raw.append((terminal_id, data))
        return True

    async def _interrupt(self, terminal_id):
        self.interrupts.append(terminal_id)
        return True


@pytest.fixture
def rig(tmp_path, monkeypatch):
    backend = Backend()
    backend.upload_root = tmp_path / "uploads"
    backend.upload_root.mkdir()
    store = DeviceStore(tmp_path / "remote_devices.json")
    # The saved-locations file is resolved through this one function precisely
    # so a test never writes into the user's real ~/.plexar-studio.
    monkeypatch.setattr(
        remote_gateway, "_locations_file", lambda: tmp_path / "remote_locations.json"
    )
    remote_gateway.configure(backend.as_remote_backend(), store)
    app = FastAPI()
    app.include_router(remote_gateway.admin_router)
    app.include_router(remote_gateway.router)
    with TestClient(app, base_url=BASE) as client:
        yield backend, store, client


def pair(client, store, name="Pixel"):
    code = store.create_pairing()["code"]
    resp = client.post("/remote/v1/pair", json={"code": code, "device_name": name})
    assert resp.status_code == 200, resp.text
    return resp.json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


# -- pairing ---------------------------------------------------------------


def test_pairing_round_trip_over_http(rig):
    _backend, store, client = rig
    body = pair(client, store)
    assert body["protocol"] == PROTOCOL_VERSION
    assert body["app_version"] == "2.1.7"
    assert body["device_id"].startswith("dv_")
    assert store.authenticate(body["token"]) is not None


def test_bad_code_is_400_with_the_one_message(rig):
    _backend, _store, client = rig
    resp = client.post("/remote/v1/pair", json={"code": "ZZZZ-ZZZZ", "device_name": "P"})
    assert resp.status_code == 400
    assert resp.json() == {"error": "invalid or expired code"}


@pytest.fixture
def remote_caplog(caplog):
    """cockpit.* loggers are configured with propagate=False (they route to
    their own file sinks in production), so pytest's root-attached caplog
    handler never sees their records unless attached directly."""
    logger = logging.getLogger("cockpit.remote")
    logger.addHandler(caplog.handler)
    orig_level = logger.level
    logger.setLevel(logging.DEBUG)
    try:
        yield caplog
    finally:
        logger.removeHandler(caplog.handler)
        logger.setLevel(orig_level)


def test_failed_pair_attempts_are_logged_with_reason_but_never_code(rig, remote_caplog):
    """W9: pair failures must be logged at WARNING with the reason and
    client host, and must never log the code or a token."""
    _backend, _store, client = rig
    secret_code = "ZZZZ-ZZZZ"
    resp = client.post("/remote/v1/pair", json={"code": secret_code, "device_name": "P"})
    assert resp.status_code == 400
    warnings = [r for r in remote_caplog.records if r.levelname == "WARNING"]
    assert warnings, "expected a WARNING log line for the failed pair attempt"
    for record in warnings:
        text = record.getMessage()
        assert secret_code not in text
        assert "ZZZZZZZZ" not in text
    assert any("unknown code" in r.getMessage() for r in warnings)


def test_successful_pair_still_logs_info_not_warning(rig, remote_caplog):
    _backend, store, client = rig
    pair(client, store)
    assert not any(r.levelname == "WARNING" for r in remote_caplog.records)
    assert any("paired" in r.getMessage() for r in remote_caplog.records)


# -- admin routes ----------------------------------------------------------


def test_admin_pairings_payload_shape(rig):
    backend, _store, client = rig
    backend.settings_dict["remote"]["hostname"] = "https://studio.example.com/"
    resp = client.post("/api/remote/pairings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["url"] == "https://studio.example.com"
    assert json.loads(body["qr_payload"]) == {
        "v": 1,
        "url": "https://studio.example.com",
        "code": body["code"],
    }
    assert body["expires_at"] > 0


def test_admin_pairings_falls_back_to_a_lan_url(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setenv("PORT", "8420")
    body = client.post("/api/remote/pairings").json()
    assert body["url"].startswith("http://")
    assert body["url"].endswith(":8420")


def test_admin_pairings_409_when_disabled(rig):
    backend, _store, client = rig
    backend.settings_dict["remote"]["enabled"] = False
    resp = client.post("/api/remote/pairings")
    assert resp.status_code == 409
    assert resp.json() == {"error": "remote disabled"}


def test_admin_status(rig):
    _backend, store, client = rig
    pair(client, store, "Pixel")
    body = client.get("/api/remote/status").json()
    assert body["enabled"] is True
    assert body["protocol"] == PROTOCOL_VERSION
    assert body["hostname"] == ""
    assert len(body["devices"]) == 1
    assert set(body["devices"][0]) == {
        "id",
        "name",
        "created_at",
        "last_seen",
        "revoked_at",
    }


def test_admin_revoke_then_401(rig):
    _backend, store, client = rig
    paired = pair(client, store)
    resp = client.delete(f"/api/remote/devices/{paired['device_id']}")
    assert resp.status_code == 200 and resp.json() == {"revoked": True}
    assert client.get("/remote/v1/hello", headers=auth(paired["token"])).status_code == 401
    assert client.delete("/api/remote/devices/dv_nope").status_code == 404


# -- the remote gate -------------------------------------------------------


def test_disabled_404s_every_remote_route_including_pair(rig):
    backend, store, client = rig
    paired = pair(client, store)
    backend.settings_dict["remote"]["enabled"] = False
    headers = auth(paired["token"])
    checks = [
        client.post("/remote/v1/pair", json={"code": "A", "device_name": "P"}),
        client.get("/remote/v1/hello", headers=headers),
        client.get("/remote/v1/sessions", headers=headers),
        client.post("/remote/v1/sessions", json={}, headers=headers),
        client.post("/remote/v1/sessions/t1/input", json={"text": "hi"}, headers=headers),
        client.post("/remote/v1/sessions/t1/interrupt", headers=headers),
        client.delete("/remote/v1/sessions/t1", headers=headers),
        client.get("/remote/v1/workdirs", headers=headers),
        client.get("/remote/v1/browse", headers=headers),
        client.get("/remote/v1/catalog", headers=headers),
    ]
    for resp in checks:
        assert resp.status_code == 404, resp.request.url


def test_missing_and_bad_tokens_are_401(rig):
    _backend, _store, client = rig
    assert client.get("/remote/v1/hello").status_code == 401
    assert client.get("/remote/v1/hello", headers=auth("nope")).status_code == 401
    assert client.get(
        "/remote/v1/hello", headers={"Authorization": "Basic xyz"}
    ).status_code == 401


def test_disabled_wins_over_a_bad_token(rig):
    backend, _store, client = rig
    backend.settings_dict["remote"]["enabled"] = False
    assert client.get("/remote/v1/hello", headers=auth("nope")).status_code == 404


def test_authenticate_websocket_mirrors_the_rules(rig):
    backend, store, client = rig
    paired = pair(client, store)

    class FakeWs:
        def __init__(self, headers):
            self.headers = headers

    good = FakeWs({"authorization": f"Bearer {paired['token']}"})
    assert remote_gateway.authenticate_websocket(good).id == paired["device_id"]
    assert remote_gateway.authenticate_websocket(FakeWs({})) is None
    backend.settings_dict["remote"]["enabled"] = False
    assert remote_gateway.authenticate_websocket(good) is None
    assert remote_gateway.remote_enabled() is False


# -- sessions --------------------------------------------------------------


def test_sessions_list_carries_only_the_thirteen_fields(rig):
    _backend, store, client = rig
    paired = pair(client, store)
    body = client.get("/remote/v1/sessions", headers=auth(paired["token"])).json()
    assert list(body["sessions"][0]) == list(remote_gateway.SESSION_FIELDS)
    assert len(remote_gateway.SESSION_FIELDS) == 13


def test_hello(rig):
    _backend, store, client = rig
    paired = pair(client, store, "Pixel")
    body = client.get("/remote/v1/hello", headers=auth(paired["token"])).json()
    assert body == {
        "protocol": PROTOCOL_VERSION,
        "app_version": "2.1.7",
        "device": {"id": paired["device_id"], "name": "Pixel"},
        "session_count": 1,
    }


def test_create_session(rig):
    backend, store, client = rig
    paired = pair(client, store)
    resp = client.post(
        "/remote/v1/sessions",
        json={"name": "phone", "workdir": "C:/x", "harness": "codex", "model": "gpt-5.5"},
        headers=auth(paired["token"]),
    )
    assert resp.status_code == 201
    assert list(resp.json()["session"]) == list(remote_gateway.SESSION_FIELDS)
    assert backend.created == [
        {"name": "phone", "workdir": "C:/x", "harness": "codex", "model": "gpt-5.5"}
    ]


def test_create_session_surfaces_valueerror_as_400(rig):
    backend, store, client = rig
    paired = pair(client, store)
    backend.create_error = "unsupported harness"
    resp = client.post("/remote/v1/sessions", json={}, headers=auth(paired["token"]))
    assert resp.status_code == 400
    assert resp.json() == {"error": "unsupported harness"}


# -- input -----------------------------------------------------------------


def test_input_submit_vs_raw_routing(rig):
    backend, store, client = rig
    paired = pair(client, store)
    headers = auth(paired["token"])
    client.post("/remote/v1/sessions/t1/input", json={"text": "hello"}, headers=headers)
    client.post(
        "/remote/v1/sessions/t1/input",
        json={"text": "\x03", "submit": False},
        headers=headers,
    )
    assert backend.submitted == [("t1", "hello")]
    assert backend.raw == [("t1", "\x03")]


def test_input_is_idempotent_per_request_id(rig):
    backend, store, client = rig
    paired = pair(client, store)
    headers = auth(paired["token"])
    payload = {"text": "once", "request_id": "req-1"}
    first = client.post("/remote/v1/sessions/t1/input", json=payload, headers=headers)
    second = client.post("/remote/v1/sessions/t1/input", json=payload, headers=headers)
    assert first.json() == {"accepted": True, "duplicate": False}
    assert second.json() == {"accepted": True, "duplicate": True}
    assert backend.submitted == [("t1", "once")]


def test_without_a_request_id_every_call_writes(rig):
    backend, store, client = rig
    paired = pair(client, store)
    headers = auth(paired["token"])
    for _ in range(3):
        client.post("/remote/v1/sessions/t1/input", json={"text": "x"}, headers=headers)
    assert backend.submitted == [("t1", "x")] * 3


def test_idempotency_is_scoped_per_device(rig):
    backend, store, client = rig
    one = pair(client, store, "One")
    two = pair(client, store, "Two")
    payload = {"text": "x", "request_id": "shared"}
    client.post("/remote/v1/sessions/t1/input", json=payload, headers=auth(one["token"]))
    resp = client.post(
        "/remote/v1/sessions/t1/input", json=payload, headers=auth(two["token"])
    )
    assert resp.json()["duplicate"] is False
    assert len(backend.submitted) == 2


def test_input_and_interrupt_404_on_unknown_session(rig):
    _backend, store, client = rig
    headers = auth(pair(client, store)["token"])
    assert (
        client.post("/remote/v1/sessions/nope/input", json={"text": "x"}, headers=headers).status_code
        == 404
    )
    assert client.post("/remote/v1/sessions/nope/interrupt", headers=headers).status_code == 404


def test_interrupt(rig):
    backend, store, client = rig
    headers = auth(pair(client, store)["token"])
    resp = client.post("/remote/v1/sessions/t1/interrupt", headers=headers)
    assert resp.status_code == 200 and resp.json() == {"accepted": True}
    assert backend.interrupts == ["t1"]


# -- registry --------------------------------------------------------------


# -- access_required in qr_payload ------------------------------------------


def test_qr_payload_carries_access_only_when_required(rig):
    backend, _store, client = rig
    resp = client.post("/api/remote/pairings")
    assert "access" not in json.loads(resp.json()["qr_payload"])

    backend.settings_dict["remote"]["access_required"] = True
    resp = client.post("/api/remote/pairings")
    assert json.loads(resp.json()["qr_payload"])["access"] is True


# -- cloudflared config -------------------------------------------------------


def test_cloudflared_config_shape(rig, monkeypatch):
    monkeypatch.setenv("PORT", "8420")
    _backend, _store, client = rig
    resp = client.get("/api/remote/cloudflared-config", params={"hostname": "studio.example.com"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["hostname"] == "studio.example.com"
    assert body["config_yml"] == (
        "tunnel: <tunnel-id>\n"
        "credentials-file: %USERPROFILE%\\.cloudflared\\<tunnel-id>.json\n"
        "\n"
        "ingress:\n"
        "  - hostname: studio.example.com\n"
        "    path: ^/remote/v1/\n"
        "    service: http://127.0.0.1:8420\n"
        "\n"
        "  - service: http_status:404\n"
    )
    assert body["commands"] == [
        "cloudflared tunnel login",
        "cloudflared tunnel create plexar-studio",
        "cloudflared tunnel route dns plexar-studio studio.example.com",
        "Write the config above to %USERPROFILE%\\.cloudflared\\config.yml",
        "cloudflared service install",
    ]


@pytest.mark.parametrize(
    "hostname",
    ["", "a", "ab", "bad host.com", "-lead.com", "https://", "https://bad host.com/"],
)
def test_cloudflared_config_rejects_bad_hostnames(rig, hostname):
    _backend, _store, client = rig
    resp = client.get("/api/remote/cloudflared-config", params={"hostname": hostname})
    assert resp.status_code == 400
    assert "error" in resp.json()


@pytest.mark.parametrize(
    "given",
    ["UPPER.example.com", "https://studio.example.com", "https://Studio.Example.com/remote/v1/", "studio.example.com:8443"],
)
def test_cloudflared_config_accepts_the_public_url_as_entered(rig, given):
    # The Public URL field holds a URL; the tools reduce it to the hostname
    # rather than telling a correctly configured desktop "invalid hostname".
    _backend, _store, client = rig
    resp = client.get("/api/remote/cloudflared-config", params={"hostname": given})
    assert resp.status_code == 200
    assert resp.json()["hostname"] in {"upper.example.com", "studio.example.com"}
    yml = resp.json()["config_yml"]
    assert "hostname: studio.example.com" in yml or "hostname: upper.example.com" in yml


def test_cloudflared_config_accepts_long_and_short_valid_hostnames(rig):
    _backend, _store, client = rig
    assert client.get("/api/remote/cloudflared-config", params={"hostname": "a.co"}).status_code == 200


# -- cloudflared status --------------------------------------------------------


def test_cloudflared_status_installed_and_running(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway.shutil, "which", lambda name: r"C:\tools\cloudflared.exe")

    class FakeProc:
        info = {"name": "cloudflared.exe"}

    monkeypatch.setitem(
        sys.modules, "psutil", type("M", (), {"process_iter": staticmethod(lambda attrs: [FakeProc()])})
    )
    resp = client.get("/api/remote/cloudflared")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "installed": True,
        "path": r"C:\tools\cloudflared.exe",
        "version": None,
        "running": True,
    }


def test_cloudflared_status_not_installed_not_running(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway.shutil, "which", lambda name: None)
    monkeypatch.setattr(remote_gateway.os.path, "isfile", lambda p: False)
    monkeypatch.setitem(
        sys.modules, "psutil", type("M", (), {"process_iter": staticmethod(lambda attrs: [])})
    )
    resp = client.get("/api/remote/cloudflared")
    assert resp.status_code == 200
    body = resp.json()
    assert body["installed"] is False
    assert body["path"] is None
    assert body["running"] is False


# -- probe classification ------------------------------------------------------


def test_probe_rejects_bad_hostname(rig):
    _backend, _store, client = rig
    resp = client.post("/api/remote/probe", json={"hostname": "not a host"})
    assert resp.status_code == 400


def test_probe_classifies_access_via_redirect(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (302, {"Location": "https://plexar.cloudflareaccess.com/login"}, ""),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "access"


def test_probe_classifies_access_via_html_body(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (200, {"Content-Type": "text/html"}, "<!doctype html><html></html>"),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "access"


def test_probe_classifies_guarded(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (401, {"Content-Type": "application/json"}, json.dumps({"detail": "unauthorized"})),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "guarded"


def test_probe_classifies_disabled(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(
        remote_gateway,
        "_fetch_probe",
        lambda hostname: (404, {"Content-Type": "application/json"}, json.dumps({"error": "remote disabled"})),
    )
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "disabled"


def test_probe_classifies_unreachable(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway, "_fetch_probe", lambda hostname: (None, {}, ""))
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    assert resp.json()["classification"] == "unreachable"


def test_probe_classifies_unexpected(rig, monkeypatch):
    _backend, _store, client = rig
    monkeypatch.setattr(remote_gateway, "_fetch_probe", lambda hostname: (500, {}, "server error"))
    resp = client.post("/api/remote/probe", json={"hostname": "studio.example.com"})
    body = resp.json()
    assert body["classification"] == "unexpected"
    assert body["status"] == 500


# -- saved locations (admin) -------------------------------------------------


def test_locations_put_persists_and_reports_a_count(rig):
    _backend, _store, client = rig
    resp = client.put(
        "/api/remote/locations",
        json={
            "locations": [
                {"path": "C:\\Code\\Personal", "name": "Personal"},
                {"path": "/srv/work", "name": None},
                {"path": "\\\\nas\\share", "name": "  "},
            ]
        },
    )
    assert resp.status_code == 200
    assert resp.json() == {"count": 3}
    assert remote_gateway._read_locations() == [
        {"path": "C:\\Code\\Personal", "name": "Personal"},
        {"path": "/srv/work", "name": None},
        {"path": "\\\\nas\\share", "name": None},
    ]


def test_locations_put_replaces_wholesale(rig):
    _backend, _store, client = rig
    client.put("/api/remote/locations", json={"locations": [{"path": "/a", "name": "A"}]})
    client.put("/api/remote/locations", json={"locations": [{"path": "/b", "name": "B"}]})
    assert remote_gateway._read_locations() == [{"path": "/b", "name": "B"}]


def test_locations_put_accepts_an_empty_list(rig):
    _backend, _store, client = rig
    client.put("/api/remote/locations", json={"locations": [{"path": "/a", "name": "A"}]})
    resp = client.put("/api/remote/locations", json={"locations": []})
    assert resp.status_code == 200 and resp.json() == {"count": 0}
    assert remote_gateway._read_locations() == []


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"locations": "nope"},
        {"locations": [{"path": ""}]},
        {"locations": [{"path": "relative/path"}]},
        {"locations": [{"path": "C:"}]},
        {"locations": [{"name": "no path"}]},
        {"locations": ["C:\\Code"]},
        {"locations": [{"path": 7}]},
    ],
)
def test_locations_put_rejects_bad_input_without_writing(rig, payload):
    _backend, _store, client = rig
    client.put("/api/remote/locations", json={"locations": [{"path": "/keep", "name": "K"}]})
    resp = client.put("/api/remote/locations", json=payload)
    assert resp.status_code == 400
    assert "error" in resp.json()
    # All-or-nothing: the previous list survives a refused write.
    assert remote_gateway._read_locations() == [{"path": "/keep", "name": "K"}]


def test_locations_put_caps_the_list(rig):
    _backend, _store, client = rig
    many = [{"path": f"/p/{i}", "name": None} for i in range(remote_gateway.MAX_SAVED_LOCATIONS + 1)]
    assert client.put("/api/remote/locations", json={"locations": many}).status_code == 400
    ok = many[: remote_gateway.MAX_SAVED_LOCATIONS]
    resp = client.put("/api/remote/locations", json={"locations": ok})
    assert resp.status_code == 200
    assert resp.json() == {"count": remote_gateway.MAX_SAVED_LOCATIONS}


def test_missing_locations_file_reads_as_empty(rig):
    _backend, _store, client = rig
    assert remote_gateway._read_locations() == []
    body = client.get(
        "/remote/v1/workdirs", headers=auth(pair(client, _store)["token"])
    ).json()
    assert all(w["source"] != "saved" for w in body["workdirs"])


# -- workdirs ----------------------------------------------------------------


def _session(terminal_id, workdir, created_at):
    session = dict(FULL_SESSION)
    session.update({"id": terminal_id, "working_dir": workdir, "created_at": created_at})
    return session


def test_workdirs_orders_saved_then_sessions_then_history(rig):
    backend, store, client = rig
    remote_gateway._write_locations(
        [{"path": "C:/saved/one", "name": "One"}, {"path": "C:/hist/one", "name": "Also saved"}]
    )
    backend.sessions = [
        _session("t1", "C:/older", "2026-09-01T00:00:00+00:00"),
        _session("t2", "C:/newer", "2026-09-05T00:00:00+00:00"),
    ]
    body = client.get("/remote/v1/workdirs", headers=auth(pair(client, store)["token"])).json()
    assert [(w["path"], w["source"]) for w in body["workdirs"]] == [
        ("C:/saved/one", "saved"),
        ("C:/hist/one", "saved"),
        ("C:/newer", "session"),
        ("C:/older", "session"),
        ("C:/hist/two", "history"),
    ]
    # First occurrence wins: the folder that is BOTH saved and in history keeps
    # the stronger label and its saved name.
    assert body["workdirs"][1]["name"] == "Also saved"
    assert body["workdirs"][2]["name"] is None
    assert body["workdirs"][2]["last_used"] == "2026-09-05T00:00:00+00:00"
    assert body["workdirs"][4]["last_used"] == "2026-08-01T00:00:00+00:00"
    assert backend.history_limit == 30


def test_workdirs_row_shape_and_roots(rig):
    backend, store, client = rig
    body = client.get("/remote/v1/workdirs", headers=auth(pair(client, store)["token"])).json()
    assert set(body) == {"workdirs", "roots"}
    assert set(body["workdirs"][0]) == {"path", "name", "source", "last_used"}
    # The roots are exactly what browse("") answered -- one source, not a second
    # platform guess written here.
    assert body["roots"] == ["C:\\", "D:\\"]
    assert "" in backend.browsed


def test_workdirs_falls_back_to_posix_root_when_browse_cannot_answer(rig):
    backend, store, client = rig
    backend.roots_reply = {"dirs": [], "parent": "", "entries": []}
    body = client.get("/remote/v1/workdirs", headers=auth(pair(client, store)["token"])).json()
    assert body["roots"] == ["/"]


def test_workdirs_ignores_trailing_separators_when_deduping(rig):
    backend, store, client = rig
    remote_gateway._write_locations([{"path": "C:/dup/one", "name": "One"}])
    backend.sessions = [_session("t1", "C:/dup/one/", "2026-09-01T00:00:00+00:00")]
    backend.history = [{"path": "C:/dup/one\\", "last_used": "2026-08-01T00:00:00+00:00"}]
    body = client.get("/remote/v1/workdirs", headers=auth(pair(client, store)["token"])).json()
    assert [(w["path"], w["source"]) for w in body["workdirs"]] == [("C:/dup/one", "saved")]


@pytest.mark.skipif(os.name != "nt", reason="paths are case-insensitive on Windows only")
def test_workdirs_dedupe_folds_case_on_windows(rig):
    backend, store, client = rig
    remote_gateway._write_locations([{"path": "C:/Case/One", "name": "One"}])
    backend.sessions = []
    backend.history = [{"path": "c:/case/one", "last_used": "2026-08-01T00:00:00+00:00"}]
    body = client.get("/remote/v1/workdirs", headers=auth(pair(client, store)["token"])).json()
    assert [w["path"] for w in body["workdirs"]] == ["C:/Case/One"]


@pytest.mark.skipif(os.name == "nt", reason="two casings ARE two directories off Windows")
def test_workdirs_keeps_two_casings_apart_off_windows(rig):
    backend, store, client = rig
    remote_gateway._write_locations([{"path": "/case/One", "name": "One"}])
    backend.sessions = []
    backend.history = [{"path": "/case/one", "last_used": "2026-08-01T00:00:00+00:00"}]
    body = client.get("/remote/v1/workdirs", headers=auth(pair(client, store)["token"])).json()
    assert [w["path"] for w in body["workdirs"]] == ["/case/One", "/case/one"]


def test_workdirs_survives_an_unreadable_usage_history(rig):
    backend, store, client = rig
    backend.sessions = [_session("t1", "C:/live", "2026-09-01T00:00:00+00:00")]

    def boom(_limit):
        raise RuntimeError("usage db is locked")

    backend_obj = backend.as_remote_backend()
    remote_gateway.configure(
        remote_gateway.RemoteBackend(
            **{**backend_obj.__dict__, "recent_workdirs": boom}
        ),
        store,
    )
    body = client.get("/remote/v1/workdirs", headers=auth(pair(client, store)["token"])).json()
    assert [w["path"] for w in body["workdirs"]] == ["C:/live"]


# -- browse ------------------------------------------------------------------


def test_browse_returns_only_the_five_entry_fields(rig):
    backend, store, client = rig
    body = client.get(
        "/remote/v1/browse",
        params={"path": "C:/tmp"},
        headers=auth(pair(client, store)["token"]),
    ).json()
    assert body["path"] == "C:/tmp"
    assert body["parent"] == "C:/tmp"
    assert list(body["entries"][0]) == list(remote_gateway.BROWSE_ENTRY_FIELDS)
    assert body["entries"][0] == {
        "path": "C:/tmp/a",
        "name": "a",
        "git": True,
        "branch": "main",
        "session_count": 2,
    }
    assert backend.browsed == ["C:/tmp"]


def test_browse_with_no_path_asks_for_the_roots(rig):
    backend, store, client = rig
    body = client.get("/remote/v1/browse", headers=auth(pair(client, store)["token"])).json()
    assert backend.browsed == [""]
    assert body["path"] == ""
    assert body["parent"] is None
    assert body["entries"] == []


@pytest.mark.parametrize(
    "path",
    ["relative/dir", "dir", "C:", "../etc", "C:/tmp/../secret", "C:\\tmp\\..\\secret", "..\\x"],
)
def test_browse_refuses_a_non_absolute_or_traversing_path(rig, path):
    backend, store, client = rig
    resp = client.get(
        "/remote/v1/browse", params={"path": path}, headers=auth(pair(client, store)["token"])
    )
    assert resp.status_code == 400
    assert "error" in resp.json()
    # Refused BEFORE the walk: the backend was never asked.
    assert backend.browsed == []


@pytest.mark.parametrize("path", ["C:\\Code", "C:/Code", "/srv/work", "\\\\nas\\share"])
def test_browse_accepts_every_absolute_spelling(rig, path):
    backend, store, client = rig
    resp = client.get(
        "/remote/v1/browse", params={"path": path}, headers=auth(pair(client, store)["token"])
    )
    assert resp.status_code == 200
    assert backend.browsed == [path]


def test_browse_reports_an_unwalkable_folder_as_200_with_an_error(rig):
    backend, store, client = rig
    backend.browse_error = PermissionError("access is denied")
    resp = client.get(
        "/remote/v1/browse",
        params={"path": "C:/locked"},
        headers=auth(pair(client, store)["token"]),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["entries"] == []
    assert body["path"] == "C:/locked"
    assert "access is denied" in body["error"]


def test_browse_reads_a_jsonresponse_backend(rig):
    """server.browse_directories is a route and hands back a JSONResponse."""
    backend, store, client = rig
    from fastapi.responses import JSONResponse as _JSONResponse

    async def as_response(path):
        backend.browsed.append(path)
        return _JSONResponse(backend.browse_reply)

    wired = backend.as_remote_backend()
    remote_gateway.configure(
        remote_gateway.RemoteBackend(**{**wired.__dict__, "browse": as_response}), store
    )
    body = client.get(
        "/remote/v1/browse",
        params={"path": "C:/tmp"},
        headers=auth(pair(client, store)["token"]),
    ).json()
    assert body["entries"][0]["path"] == "C:/tmp/a"


# -- catalog -----------------------------------------------------------------


def test_catalog_shape(rig):
    _backend, store, client = rig
    body = client.get("/remote/v1/catalog", headers=auth(pair(client, store)["token"])).json()
    assert set(body) == {"harnesses", "permission_modes", "efforts"}
    claude, codex = body["harnesses"]
    assert claude["id"] == "claude-code" and claude["label"] == "Claude Code"
    assert claude["models"] == [
        {"id": "claude-opus-5", "label": "Claude Opus 5"},
        {"id": "claude-sonnet-5", "label": "Claude Sonnet 5"},
    ]
    assert claude["default_model"] == "claude-opus-5"
    assert codex["id"] == "codex" and codex["label"] == "Codex"
    assert codex["models"] == [{"id": i, "label": lbl} for i, lbl in remote_gateway.CODEX_MODELS]
    assert codex["default_model"] == "gpt-6-astra"
    assert body["permission_modes"] == [
        {"id": "default", "label": "Ask before edits"},
        {"id": "acceptEdits", "label": "Accept edits"},
        {"id": "plan", "label": "Plan only"},
        {"id": "bypassPermissions", "label": "Bypass permissions"},
    ]
    assert body["efforts"] == ["low", "medium", "high", "xhigh"]


def test_catalog_prefers_the_configured_session_model(rig):
    backend, store, client = rig
    backend.settings_dict["sessions"] = {"model": "claude-sonnet-5"}
    body = client.get("/remote/v1/catalog", headers=auth(pair(client, store)["token"])).json()
    assert body["harnesses"][0]["default_model"] == "claude-sonnet-5"


def test_catalog_falls_back_to_the_id_when_a_model_has_no_display_name(rig):
    backend, store, client = rig
    backend.models_reply = {"models": [{"id": "claude-fable-5"}, {"nope": 1}, "junk"]}
    body = client.get("/remote/v1/catalog", headers=auth(pair(client, store)["token"])).json()
    assert body["harnesses"][0]["models"] == [{"id": "claude-fable-5", "label": "claude-fable-5"}]


def test_catalog_says_nothing_rather_than_guessing_when_the_catalog_is_empty(rig):
    backend, store, client = rig
    backend.models_reply = {"models": [], "source": "fallback"}
    body = client.get("/remote/v1/catalog", headers=auth(pair(client, store)["token"])).json()
    assert body["harnesses"][0]["models"] == []
    assert body["harnesses"][0]["default_model"] is None
    # Codex is a static list and is unaffected by an Anthropic outage.
    assert body["harnesses"][1]["default_model"] == "gpt-6-astra"


# -- create with the new options --------------------------------------------


def test_create_maps_the_three_option_fields(rig):
    backend, store, client = rig
    resp = client.post(
        "/remote/v1/sessions",
        json={
            "name": "phone",
            "workdir": "C:/x",
            "harness": "claude-code",
            "model": "claude-opus-5",
            "permission_mode": "acceptEdits",
            "effort": "xhigh",
            "bypass": True,
        },
        headers=auth(pair(client, store)["token"]),
    )
    assert resp.status_code == 201
    assert backend.created == [
        {
            "name": "phone",
            "workdir": "C:/x",
            "harness": "claude-code",
            "model": "claude-opus-5",
            "permissionMode": "acceptEdits",
            "effort": "xhigh",
            "bypassPermissions": True,
        }
    ]


def test_create_omits_options_the_caller_did_not_send(rig):
    backend, store, client = rig
    client.post(
        "/remote/v1/sessions",
        json={"name": "plain", "permission_mode": None, "effort": None, "bypass": None},
        headers=auth(pair(client, store)["token"]),
    )
    assert set(backend.created[0]) == {"name", "workdir", "harness", "model"}


def test_create_accepts_bypass_false_as_a_real_value(rig):
    backend, store, client = rig
    client.post(
        "/remote/v1/sessions",
        json={"bypass": False},
        headers=auth(pair(client, store)["token"]),
    )
    assert backend.created[0]["bypassPermissions"] is False


@pytest.mark.parametrize(
    "body,message",
    [
        ({"permission_mode": "nope"}, "unknown permission_mode"),
        ({"permission_mode": ["plan"]}, "unknown permission_mode"),
        ({"effort": "extreme"}, "unknown effort"),
        ({"effort": 3}, "unknown effort"),
        ({"bypass": "yes"}, "bypass must be a boolean"),
        ({"bypass": 1}, "bypass must be a boolean"),
    ],
)
def test_create_refuses_unknown_option_values(rig, body, message):
    backend, store, client = rig
    resp = client.post(
        "/remote/v1/sessions", json=body, headers=auth(pair(client, store)["token"])
    )
    assert resp.status_code == 400
    assert resp.json() == {"error": message}
    assert backend.created == []


@pytest.mark.parametrize("mode", ["default", "acceptEdits", "plan", "bypassPermissions"])
def test_create_accepts_every_listed_permission_mode(rig, mode):
    backend, store, client = rig
    resp = client.post(
        "/remote/v1/sessions",
        json={"permission_mode": mode},
        headers=auth(pair(client, store)["token"]),
    )
    assert resp.status_code == 201
    assert backend.created[0]["permissionMode"] == mode


@pytest.mark.parametrize("effort", ["low", "medium", "high", "xhigh"])
def test_create_accepts_every_listed_effort(rig, effort):
    backend, store, client = rig
    resp = client.post(
        "/remote/v1/sessions",
        json={"effort": effort},
        headers=auth(pair(client, store)["token"]),
    )
    assert resp.status_code == 201
    assert backend.created[0]["effort"] == effort


# -- close -------------------------------------------------------------------


def test_delete_session_closes_and_reports(rig):
    backend, store, client = rig
    resp = client.delete("/remote/v1/sessions/t1", headers=auth(pair(client, store)["token"]))
    assert resp.status_code == 200
    assert resp.json() == {"closed": True}
    assert backend.deleted == ["t1"]


def test_delete_unknown_session_is_404_and_kills_nothing(rig):
    backend, store, client = rig
    resp = client.delete("/remote/v1/sessions/nope", headers=auth(pair(client, store)["token"]))
    assert resp.status_code == 404
    assert resp.json() == {"error": "unknown session"}
    assert backend.deleted == []


def test_delete_reports_a_failed_kill_rather_than_claiming_success(rig):
    backend, store, client = rig
    backend.delete_result = False
    resp = client.delete("/remote/v1/sessions/t1", headers=auth(pair(client, store)["token"]))
    assert resp.status_code == 200
    assert resp.json() == {"closed": False}


# -- an unwired backend answers 503, never 500 -------------------------------


def test_stage1c_routes_are_503_when_the_backend_does_not_supply_them(rig):
    backend, store, client = rig
    wired = backend.as_remote_backend()
    remote_gateway.configure(
        remote_gateway.RemoteBackend(
            **{**wired.__dict__, "browse": None, "delete_session": None}
        ),
        store,
    )
    headers = auth(pair(client, store)["token"])
    assert client.get("/remote/v1/browse", headers=headers).status_code == 503
    assert client.delete("/remote/v1/sessions/t1", headers=headers).status_code == 503
    # workdirs still answers -- roots degrade to POSIX root, sources still list.
    body = client.get("/remote/v1/workdirs", headers=headers).json()
    assert body["roots"] == ["/"]


@pytest.mark.asyncio
async def test_registry_closes_a_devices_sockets():
    class FakeSocket:
        def __init__(self):
            self.closed = None

        async def close(self, code=1000):
            self.closed = code

    reg = remote_gateway.StreamRegistry()
    sock = FakeSocket()
    reg.register("dv_1", sock)
    assert reg.count("dv_1") == 1
    await reg.close_device("dv_1")
    assert sock.closed == 4401
    assert reg.count("dv_1") == 0
    reg.unregister("dv_1", sock)  # idempotent



# -- the chat view: messages, uploads, files --------------------------------


def claude_entry(uuid, role, content, *, entry_type=None, ts="2026-09-08T00:00:00Z"):
    """One jsonl_watcher-shaped entry. `type` defaults to the role."""
    return {
        "id": uuid,
        "type": entry_type or role,
        "role": role,
        "content": content,
        "timestamp": ts,
        "parentId": None,
    }


def chat_rig(rig, *, entries=None, harness="claude-code", workdir=None):
    """Pair a device and point the single session at *harness*/*workdir*."""
    backend, store, client = rig
    backend.sessions[0]["harness"] = harness
    if workdir is not None:
        backend.sessions[0]["working_dir"] = str(workdir)
    if entries is not None:
        backend.claude_messages = entries
    return backend, client, auth(pair(client, store)["token"])


def test_messages_map_every_claude_block_type(rig):
    entries = [
        claude_entry("u1", "user", [{"type": "text", "text": "hello"}]),
        claude_entry(
            "a1",
            "assistant",
            [
                {"type": "text", "text": "hi"},
                {"type": "thinking", "text": "hmm"},
                {"type": "tool_use", "tool_name": "Read", "tool_id": "tu1", "input": {}},
            ],
        ),
        claude_entry(
            "r1",
            "user",
            [{"type": "tool_result", "tool_use_id": "tu1", "content": "x" * 3000}],
            entry_type="tool_result",
        ),
        claude_entry("s1", "system", [{"type": "text", "text": "note"}]),
    ]
    _backend, client, headers = chat_rig(rig, entries=entries)
    body = client.get("/remote/v1/sessions/t1/messages", headers=headers).json()
    assert body["harness"] == "claude-code"
    assert body["activity_state"] == "idle"
    assert body["complete"] is True
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["user", "assistant", "tool", "system"]
    assert body["messages"][0]["blocks"] == [{"type": "text", "text": "hello"}]
    assert body["messages"][1]["blocks"] == [
        {"type": "text", "text": "hi"},
        {"type": "thinking", "text": "hmm"},
        {"type": "tool_use", "name": "Read"},
    ]
    result = body["messages"][2]["blocks"][0]
    assert result["type"] == "tool_result" and len(result["text"]) == 2000
    assert body["messages"][0]["timestamp"] == "2026-09-08T00:00:00Z"


def test_user_image_paths_become_image_blocks_including_quoted(rig, tmp_path):
    workdir = tmp_path / "proj"
    workdir.mkdir()
    spaced = workdir / "my shot.png"
    spaced.write_bytes(b"x")
    backend, _store, _client = rig
    upload_png = os.path.join(str(backend.upload_root), "a.png")
    with open(upload_png, "wb") as handle:
        handle.write(b"x")
    entries = [
        claude_entry(
            "u1",
            "user",
            [{"type": "text", "text": 'look at %s and "%s"' % (upload_png, spaced)}],
        ),
        # OUTSIDE both roots -- must NOT become an image block.
        claude_entry(
            "u2", "user", [{"type": "text", "text": str(tmp_path / "elsewhere.png")}]
        ),
        # An assistant message naming an in-root image is still text only.
        claude_entry("a1", "assistant", [{"type": "text", "text": upload_png}]),
    ]
    _backend, client, headers = chat_rig(rig, entries=entries, workdir=workdir)
    messages = client.get("/remote/v1/sessions/t1/messages", headers=headers).json()["messages"]
    images = [b for b in messages[0]["blocks"] if b["type"] == "image"]
    assert [b["path"] for b in images] == [upload_png, str(spaced)]
    assert all(b["type"] != "image" for b in messages[1]["blocks"])
    assert all(b["type"] != "image" for b in messages[2]["blocks"])


def test_messages_paging_after_before_and_unknown_cursor(rig):
    entries = [claude_entry("m%d" % i, "user", [{"type": "text", "text": str(i)}]) for i in range(10)]
    _backend, client, headers = chat_rig(rig, entries=entries)

    tail = client.get("/remote/v1/sessions/t1/messages?limit=3", headers=headers).json()
    assert [m["id"] for m in tail["messages"]] == ["m7", "m8", "m9"]
    assert tail["complete"] is False and "cursor_reset" not in tail

    after = client.get("/remote/v1/sessions/t1/messages?after=m7&limit=5", headers=headers).json()
    assert [m["id"] for m in after["messages"]] == ["m8", "m9"]
    assert after["complete"] is True

    before = client.get("/remote/v1/sessions/t1/messages?before=m7&limit=3", headers=headers).json()
    assert [m["id"] for m in before["messages"]] == ["m4", "m5", "m6"]
    assert before["complete"] is False

    start = client.get("/remote/v1/sessions/t1/messages?before=m2&limit=5", headers=headers).json()
    assert [m["id"] for m in start["messages"]] == ["m0", "m1"]
    assert start["complete"] is True

    unknown = client.get("/remote/v1/sessions/t1/messages?after=nope&limit=2", headers=headers).json()
    assert [m["id"] for m in unknown["messages"]] == ["m8", "m9"]
    assert unknown["cursor_reset"] is True


def test_messages_limit_is_clamped_and_empty_transcript_is_a_200(rig):
    _backend, client, headers = chat_rig(rig, entries=[])
    body = client.get("/remote/v1/sessions/t1/messages?limit=9999", headers=headers).json()
    assert body == {
        "messages": [],
        "harness": "claude-code",
        "activity_state": "idle",
        "complete": True,
    }


def test_messages_404_for_an_unknown_session(rig):
    _backend, store, client = rig
    headers = auth(pair(client, store)["token"])
    resp = client.get("/remote/v1/sessions/nope/messages", headers=headers)
    assert resp.status_code == 404
    assert resp.json() == {"error": "unknown session"}


def test_codex_messages_map_by_index_and_page(rig):
    backend, client, headers = chat_rig(rig, harness="codex")
    backend.codex_page = {
        "messages": [
            {"index": 10, "role": "user", "text": "hi", "timestamp": "2026-09-08T00:00:00Z"},
            {"index": 20, "role": "assistant", "text": "yo", "timestamp": None},
        ],
        "before": 10,
        "has_more": True,
        "available": True,
    }
    body = client.get("/remote/v1/sessions/t1/messages?limit=2", headers=headers).json()
    assert body["harness"] == "codex"
    assert body["complete"] is False
    assert [m["id"] for m in body["messages"]] == ["10", "20"]
    assert body["messages"][0]["blocks"] == [{"type": "text", "text": "hi"}]
    assert body["messages"][1]["timestamp"] is None

    after = client.get("/remote/v1/sessions/t1/messages?after=10", headers=headers).json()
    assert [m["id"] for m in after["messages"]] == ["20"]
    assert after["complete"] is True

    client.get("/remote/v1/sessions/t1/messages?before=20&limit=7", headers=headers)
    assert backend.codex_args == (20, 7)

    reset = client.get("/remote/v1/sessions/t1/messages?before=abc", headers=headers).json()
    assert reset["cursor_reset"] is True
    assert backend.codex_args[0] is None


def test_messages_503_when_the_backend_cannot_read_them(rig):
    backend, store, client = rig
    wired = backend.as_remote_backend()
    remote_gateway.configure(
        remote_gateway.RemoteBackend(**{**wired.__dict__, "messages_claude": None}), store
    )
    headers = auth(pair(client, store)["token"])
    assert client.get("/remote/v1/sessions/t1/messages", headers=headers).status_code == 503


# -- upload ------------------------------------------------------------------


def test_upload_saves_files_and_returns_absolute_paths(rig):
    backend, client, headers = chat_rig(rig)
    resp = client.post(
        "/remote/v1/sessions/t1/upload",
        headers=headers,
        files=[
            ("files", ("a.png", b"one", "image/png")),
            ("files", ("b.png", b"two", "image/png")),
        ],
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["errors"] == []
    assert len(body["paths"]) == 2
    assert all(os.path.isabs(p) for p in body["paths"])
    assert backend.saved == [("a.png", 3), ("b.png", 3)]


def test_upload_refuses_more_than_four_and_reports_per_file_errors(rig):
    backend, client, headers = chat_rig(rig)
    too_many = [("files", ("%d.png" % i, b"x", "image/png")) for i in range(5)]
    resp = client.post("/remote/v1/sessions/t1/upload", headers=headers, files=too_many)
    assert resp.status_code == 400
    assert resp.json() == {"error": "at most 4 files"}

    backend.save_error = "Rejected 'x.exe': unsupported file type '.exe'"
    resp = client.post(
        "/remote/v1/sessions/t1/upload",
        headers=headers,
        files=[("files", ("x.exe", b"x", "application/octet-stream"))],
    )
    assert resp.status_code == 201
    assert resp.json() == {"paths": [], "errors": [backend.save_error]}


def test_upload_404s_for_an_unknown_session(rig):
    _backend, client, headers = chat_rig(rig)
    resp = client.post(
        "/remote/v1/sessions/nope/upload",
        headers=headers,
        files=[("files", ("a.png", b"x", "image/png"))],
    )
    assert resp.status_code == 404


# -- files -------------------------------------------------------------------


def test_files_serves_an_image_under_the_upload_dir(rig):
    backend, client, headers = chat_rig(rig)
    target = os.path.join(str(backend.upload_root), "shot.png")
    with open(target, "wb") as handle:
        handle.write(b"\x89PNG\r\n")
    resp = client.get("/remote/v1/files", params={"path": target}, headers=headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/png")
    assert resp.content == b"\x89PNG\r\n"


def test_files_serves_an_image_under_a_live_sessions_workdir(rig, tmp_path):
    workdir = tmp_path / "proj"
    workdir.mkdir()
    target = workdir / "pic.jpg"
    target.write_bytes(b"jpegbytes")
    _backend, client, headers = chat_rig(rig, workdir=workdir)
    resp = client.get("/remote/v1/files", params={"path": str(target)}, headers=headers)
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("image/jpeg")


@pytest.mark.parametrize("case", ["wrong_ext", "outside", "traversal", "unc", "missing", "empty"])
def test_files_refuses_everything_else_with_one_body(rig, tmp_path, case):
    workdir = tmp_path / "proj"
    workdir.mkdir(exist_ok=True)
    backend, client, headers = chat_rig(rig, workdir=workdir)
    upload_root = str(backend.upload_root)
    script = os.path.join(upload_root, "evil.py")
    with open(script, "wb") as handle:
        handle.write(b"print(1)")
    outside = tmp_path / "outside.png"
    outside.write_bytes(b"x")
    paths = {
        "wrong_ext": script,
        "outside": str(outside),
        "traversal": os.path.join(upload_root, "..", "outside.png"),
        "unc": "\\\\evil-host\\share\\pic.png",
        "missing": os.path.join(upload_root, "nope.png"),
        "empty": "",
    }
    resp = client.get("/remote/v1/files", params={"path": paths[case]}, headers=headers)
    assert resp.status_code == 404
    assert resp.json() == {"error": "not served"}


def test_files_refuses_an_oversized_image(rig, monkeypatch):
    backend, client, headers = chat_rig(rig)
    target = os.path.join(str(backend.upload_root), "big.png")
    monkeypatch.setattr(remote_gateway, "FILES_MAX_BYTES", 16)
    with open(target, "wb") as handle:
        handle.write(b"x" * 64)
    resp = client.get("/remote/v1/files", params={"path": target}, headers=headers)
    assert resp.status_code == 404
    assert resp.json() == {"error": "not served"}


def test_chat_routes_need_a_device_token(rig):
    _backend, _store, client = rig
    assert client.get("/remote/v1/sessions/t1/messages").status_code == 401
    assert client.get("/remote/v1/files", params={"path": "C:/x.png"}).status_code == 401
    assert client.post("/remote/v1/sessions/t1/upload").status_code == 401
