"""Tests for POST /api/local/{provider_id}/endpoint (SSRF-guarded provider
endpoint reconfiguration) and its persistence helpers.

Covers:
  1. Accepted hosts (loopback / RFC-1918 private / "localhost") -> 200,
     _PROVIDERS["vllm-local"] management_url/broker_url updated, endpoint_hint
     returned.
  2. Rejected hosts/ports (public IPv4/IPv6, link-local, unspecified,
     hostnames, bad ports) -> 400, provider state UNCHANGED.
  3. Routing: unknown provider -> 404; non-local scope -> 403.
  4. Persistence: successful set writes {"vllm-local": url} to the (redirected)
     JSON file; apply_persisted_endpoints() reads a temp file and updates
     _PROVIDERS accordingly, ignoring unsafe URLs.

Isolation:
  - _PROVIDERS["vllm-local"]["management_url"/"broker_url"] are saved/restored
    around every test (the route mutates the module-level dict in place).
  - server._PROVIDER_ENDPOINTS_FILE is monkeypatched directly to a tmp_path
    file for every test that touches persistence, so the real
    ~/.claude-cockpit/provider-endpoints.json is never written.

Uses httpx AsyncClient + ASGITransport, matching the existing test pattern.
"""

from __future__ import annotations

import json
import os
import sys

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.fixture(autouse=True)
def _restore_vllm_local():
    provider = server_module._PROVIDERS["vllm-local"]
    orig_mgmt = provider.get("management_url")
    orig_broker = provider.get("broker_url")
    yield
    provider["management_url"] = orig_mgmt
    provider["broker_url"] = orig_broker


@pytest.fixture()
def endpoints_file(tmp_path, monkeypatch):
    """Redirect the persisted-endpoints file to a tmp path so tests never
    write the real ~/.claude-cockpit/provider-endpoints.json."""
    path = str(tmp_path / "provider-endpoints.json")
    monkeypatch.setattr(server_module, "_PROVIDER_ENDPOINTS_FILE", path)
    return path


# ── Accept cases ───────────────────────────────────────────

@pytest.mark.parametrize("host,port", [
    ("127.0.0.1", 8001),
    ("localhost", 9000),
    ("192.168.1.50", 8001),
    ("10.0.0.5", 9000),
])
@pytest.mark.asyncio
async def test_accepts_local_hosts(client, endpoints_file, host, port):
    res = await client.post(
        "/api/local/vllm-local/endpoint", json={"host": host, "port": port}
    )
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["endpoint_hint"] == f"{host}:{port}"
    provider = server_module._PROVIDERS["vllm-local"]
    assert provider["management_url"] == f"http://{host}:{port}"
    assert provider["broker_url"] == f"http://{host}:{port}"


# ── Reject cases ───────────────────────────────────────────

@pytest.mark.parametrize("body", [
    {"host": "8.8.8.8", "port": 8001},                       # public v4
    {"host": "169.254.169.254", "port": 8001},                # link-local / metadata
    {"host": "0.0.0.0", "port": 8001},                        # unspecified
    {"host": "2001:4860:4860::8888", "port": 8001},           # public v6
    {"host": "fe80::1", "port": 8001},                        # link-local v6
    {"host": "evil.example.com", "port": 8001},                # hostname
    {"host": "127.0.0.1", "port": 0},                          # port too low
    {"host": "127.0.0.1", "port": 70000},                      # port too high
    {"host": "127.0.0.1", "port": "abc"},                      # non-int port
    {"port": 8001},                                            # missing host
    {"host": "127.0.0.1"},                                     # missing port
])
@pytest.mark.asyncio
async def test_rejects_unsafe_or_malformed(client, endpoints_file, body):
    provider = server_module._PROVIDERS["vllm-local"]
    before_mgmt = provider.get("management_url")
    before_broker = provider.get("broker_url")

    res = await client.post("/api/local/vllm-local/endpoint", json=body)

    assert res.status_code == 400
    assert provider.get("management_url") == before_mgmt
    assert provider.get("broker_url") == before_broker


# ── Routing ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unknown_provider_404(client, endpoints_file):
    res = await client.post(
        "/api/local/does-not-exist/endpoint", json={"host": "127.0.0.1", "port": 8001}
    )
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_non_local_scope_403(client, endpoints_file, monkeypatch):
    fake = {
        "id": "x-remote",
        "label": "Remote Fake",
        "kind": "fake",
        "scope": "remote",
        "broker_url": "https://example.com",
        "capabilities": [],
    }
    monkeypatch.setitem(server_module._PROVIDERS, "x-remote", fake)

    res = await client.post(
        "/api/local/x-remote/endpoint", json={"host": "127.0.0.1", "port": 8001}
    )
    assert res.status_code == 403


# ── Persistence ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_successful_set_persists_to_file(client, endpoints_file):
    res = await client.post(
        "/api/local/vllm-local/endpoint", json={"host": "127.0.0.1", "port": 8001}
    )
    assert res.status_code == 200
    assert os.path.exists(endpoints_file)
    with open(endpoints_file, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert data == {"vllm-local": "http://127.0.0.1:8001"}


def test_apply_persisted_endpoints_updates_local_provider(tmp_path, monkeypatch):
    path = str(tmp_path / "provider-endpoints.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"vllm-local": "http://192.168.1.50:8001"}, f)
    monkeypatch.setattr(server_module, "_PROVIDER_ENDPOINTS_FILE", path)

    server_module.apply_persisted_endpoints()

    provider = server_module._PROVIDERS["vllm-local"]
    assert provider["management_url"] == "http://192.168.1.50:8001"
    assert provider["broker_url"] == "http://192.168.1.50:8001"


def test_apply_persisted_endpoints_ignores_unsafe_url(tmp_path, monkeypatch):
    provider = server_module._PROVIDERS["vllm-local"]
    orig_mgmt = provider.get("management_url")
    orig_broker = provider.get("broker_url")

    path = str(tmp_path / "provider-endpoints.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"vllm-local": "file:///etc/passwd"}, f)
    monkeypatch.setattr(server_module, "_PROVIDER_ENDPOINTS_FILE", path)

    server_module.apply_persisted_endpoints()

    # Unsafe URL rejected by _is_safe_provider_url -> ignored, state unchanged.
    assert provider.get("management_url") == orig_mgmt
    assert provider.get("broker_url") == orig_broker


# ── Regression: apply_persisted_endpoints allowlist symmetry ─────────────
#
# _is_allowed_local_host must gate the PERSISTED-file load path exactly like
# it gates the live setter route (POST /api/local/{id}/endpoint) — otherwise
# a hand-crafted provider-endpoints.json is a DNS-rebinding / SSRF bypass
# that never touches the setter's validation at all.

@pytest.fixture()
def _restore_lmstudio_local():
    provider = server_module._PROVIDERS["lmstudio-local"]
    orig_mgmt = provider.get("management_url")
    orig_broker = provider.get("broker_url")
    yield
    provider["management_url"] = orig_mgmt
    provider["broker_url"] = orig_broker


@pytest.mark.parametrize("url", [
    "http://8.8.8.8:80",                # public IPv4
    "http://evil.example.com:80",       # arbitrary hostname (DNS rebinding)
    "http://169.254.169.254:80",        # link-local / cloud metadata
    "file:///etc/passwd",               # non-http(s) scheme
])
def test_apply_persisted_endpoints_skips_unsafe_hosts(tmp_path, monkeypatch, _restore_lmstudio_local, url):
    provider = server_module._PROVIDERS["lmstudio-local"]
    orig_mgmt = provider.get("management_url")
    orig_broker = provider.get("broker_url")

    path = str(tmp_path / "provider-endpoints.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"lmstudio-local": url}, f)
    monkeypatch.setattr(server_module, "_PROVIDER_ENDPOINTS_FILE", path)

    server_module.apply_persisted_endpoints()

    assert provider.get("management_url") == orig_mgmt
    assert provider.get("broker_url") == orig_broker


def test_apply_persisted_endpoints_applies_safe_host(tmp_path, monkeypatch, _restore_lmstudio_local):
    path = str(tmp_path / "provider-endpoints.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"lmstudio-local": "http://127.0.0.1:1234"}, f)
    monkeypatch.setattr(server_module, "_PROVIDER_ENDPOINTS_FILE", path)

    server_module.apply_persisted_endpoints()

    provider = server_module._PROVIDERS["lmstudio-local"]
    assert provider["management_url"] == "http://127.0.0.1:1234"
    assert provider["broker_url"] == "http://127.0.0.1:1234"


# ── Regression: _is_allowed_local_host unit coverage ─────────────────────

@pytest.mark.parametrize("host", [
    "localhost",
    "127.0.0.1",
    "192.168.1.50",
    "10.0.0.5",
    "172.16.5.5",
    "fd00::1",
])
def test_is_allowed_local_host_true(host):
    assert server_module._is_allowed_local_host(host) is True


@pytest.mark.parametrize("host", [
    "8.8.8.8",
    "169.254.169.254",
    "0.0.0.0",
    "evil.example.com",
    "2001:4860:4860::8888",
    "fe80::1",
])
def test_is_allowed_local_host_false(host):
    assert server_module._is_allowed_local_host(host) is False


# ── Regression: no-redirect fetch (302 SSRF bypass fix) ──────────────────

def test_no_redirect_opener_disables_redirects():
    assert server_module._NO_REDIRECT_OPENER is not None

    handler = None
    for h in server_module._NO_REDIRECT_OPENER.handlers:
        if isinstance(h, server_module._urllib_request.HTTPRedirectHandler):
            handler = h
            break
    assert handler is not None, "no HTTPRedirectHandler registered on _NO_REDIRECT_OPENER"
    assert isinstance(handler, server_module._NoRedirect)

    # redirect_request must be neutered -> returns None regardless of args,
    # which makes urllib raise the 3xx as an HTTPError instead of following it.
    result = handler.redirect_request(None, None, 302, "Found", {}, "http://evil.example.com/")
    assert result is None
