"""Tests for GET /api/cli and GET /api/version.

Nothing here executes a real `claude` binary: resolution is exercised against
throwaway files in tmp_path, and the `--version` probe is monkeypatched (a real
hang is simulated by raising subprocess.TimeoutExpired, so the suite itself
never waits).
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from server import app
import server as server_module
import pty_manager as pty_manager_module


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def clear_version_cache():
    """The version cache is process-lifetime by design -- clear it per test."""
    server_module._cli_version_cache.clear()
    yield
    server_module._cli_version_cache.clear()


def _fake_binary(tmp_path, name):
    path = tmp_path / name
    path.write_text("#!/bin/sh\necho 1.10.1\n", encoding="utf-8")
    path.chmod(0o755)
    return path


# ---------------------------------------------------------------------------
# GET /api/cli
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cli_env_override_reported_as_env(client, tmp_path, monkeypatch):
    binary = _fake_binary(tmp_path, "claude.exe" if sys.platform == "win32" else "claude")
    monkeypatch.setenv(pty_manager_module._CLAUDE_CLI_PATH_ENV, str(binary))
    monkeypatch.setattr(server_module, "_probe_cli_version", lambda path: "1.10.1")

    async with client as c:
        resp = await c.get("/api/cli")

    assert resp.status_code == 200
    body = resp.json()
    assert body["path"] == str(binary)
    assert body["source"] == "env"
    assert body["version"] == "1.10.1"
    assert body["override_set"] is True
    assert body["override_env"] == "CLAUDE_CLI_PATH"
    assert body["expected_name"] == "claude"
    assert body["name_matches"] is True


@pytest.mark.asyncio
async def test_cli_search_fallback_reported_as_search(client, tmp_path, monkeypatch):
    binary = _fake_binary(tmp_path, "claude.exe" if sys.platform == "win32" else "claude")
    monkeypatch.delenv(pty_manager_module._CLAUDE_CLI_PATH_ENV, raising=False)
    # No override: resolution comes from the search path, which is "search".
    monkeypatch.setattr(
        pty_manager_module, "resolve_claude_cli", lambda search: (str(binary), search),
    )
    monkeypatch.setattr(server_module, "_probe_cli_version", lambda path: "1.9.0")

    async with client as c:
        body = (await c.get("/api/cli")).json()

    assert body["source"] == "search"
    assert body["override_set"] is False
    assert body["version"] == "1.9.0"


@pytest.mark.asyncio
async def test_cli_not_found_is_an_explicit_state(client, monkeypatch):
    monkeypatch.delenv(pty_manager_module._CLAUDE_CLI_PATH_ENV, raising=False)

    def boom(search):
        raise pty_manager_module.ClaudeCliNotFound("nope", ["/a", "/b"])

    monkeypatch.setattr(pty_manager_module, "resolve_claude_cli", boom)

    async with client as c:
        resp = await c.get("/api/cli")

    assert resp.status_code == 200          # not a 500 -- an honest payload
    body = resp.json()
    assert body["path"] is None
    assert body["source"] == "not_found"
    assert body["version"] is None
    assert body["name_matches"] is False


@pytest.mark.asyncio
async def test_cli_name_mismatch_flagged(client, tmp_path, monkeypatch):
    binary = _fake_binary(tmp_path, "klaude-fork.exe")
    monkeypatch.setenv(pty_manager_module._CLAUDE_CLI_PATH_ENV, str(binary))
    monkeypatch.setattr(server_module, "_probe_cli_version", lambda path: "1.10.1")

    async with client as c:
        body = (await c.get("/api/cli")).json()

    assert body["name_matches"] is False
    assert body["expected_name"] == "claude"


@pytest.mark.asyncio
async def test_cli_version_timeout_yields_null_not_a_guess(client, tmp_path, monkeypatch):
    binary = _fake_binary(tmp_path, "claude.exe" if sys.platform == "win32" else "claude")
    monkeypatch.setenv(pty_manager_module._CLAUDE_CLI_PATH_ENV, str(binary))

    def hang(argv, **kwargs):
        # Exactly what subprocess.run raises when its own timeout fires; the
        # suite never actually blocks.
        assert kwargs.get("timeout") == server_module._CLI_VERSION_TIMEOUT
        assert isinstance(argv, list) and argv[1] == "--version"
        raise subprocess.TimeoutExpired(argv, kwargs["timeout"])

    monkeypatch.setattr(server_module.subprocess, "run", hang)

    async with client as c:
        body = (await c.get("/api/cli")).json()

    assert body["path"] == str(binary)
    assert body["version"] is None


@pytest.mark.asyncio
async def test_cli_nonzero_exit_yields_null_version(client, tmp_path, monkeypatch):
    binary = _fake_binary(tmp_path, "claude.exe" if sys.platform == "win32" else "claude")
    monkeypatch.setenv(pty_manager_module._CLAUDE_CLI_PATH_ENV, str(binary))

    class Result:
        returncode = 1
        stdout = b""
        stderr = b"not a real cli"

    monkeypatch.setattr(server_module.subprocess, "run", lambda argv, **kw: Result())

    async with client as c:
        body = (await c.get("/api/cli")).json()

    assert body["version"] is None


def test_probe_extracts_version_from_noisy_output(tmp_path, monkeypatch):
    class Result:
        returncode = 0
        stdout = b"1.10.1 (Claude Code)\n"
        stderr = b""

    monkeypatch.setattr(server_module.subprocess, "run", lambda argv, **kw: Result())
    assert server_module._probe_cli_version("claude") == "1.10.1"


def test_probe_refuses_to_invent_a_version(monkeypatch):
    class Result:
        returncode = 0
        stdout = b"command not recognised\n"
        stderr = b""

    monkeypatch.setattr(server_module.subprocess, "run", lambda argv, **kw: Result())
    assert server_module._probe_cli_version("claude") is None


@pytest.mark.asyncio
async def test_cli_version_is_cached(client, tmp_path, monkeypatch):
    binary = _fake_binary(tmp_path, "claude.exe" if sys.platform == "win32" else "claude")
    monkeypatch.setenv(pty_manager_module._CLAUDE_CLI_PATH_ENV, str(binary))
    calls = []

    def probe(path):
        calls.append(path)
        return "1.10.1"

    monkeypatch.setattr(server_module, "_probe_cli_version", probe)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        await c.get("/api/cli")
        await c.get("/api/cli")

    assert len(calls) == 1


# ---------------------------------------------------------------------------
# GET /api/version
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_version_shape(client, monkeypatch):
    monkeypatch.setattr(server_module, "_probe_cli_version", lambda path: "1.10.1")

    async with client as c:
        resp = await c.get("/api/version")

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"app", "cli", "python", "platform"}
    assert body["platform"] == sys.platform
    assert body["python"].startswith(f"{sys.version_info[0]}.{sys.version_info[1]}")
    assert body["app"] is None or isinstance(body["app"], str)
    assert body["cli"] is None or isinstance(body["cli"], str)


@pytest.mark.asyncio
async def test_version_survives_missing_cli(client, monkeypatch):
    def boom(search):
        raise pty_manager_module.ClaudeCliNotFound("nope", [])

    monkeypatch.setattr(pty_manager_module, "resolve_claude_cli", boom)

    async with client as c:
        resp = await c.get("/api/version")

    assert resp.status_code == 200
    assert resp.json()["cli"] is None


def test_app_version_comes_from_package_json():
    """Not hardcoded: it must match frontend/package.json exactly."""
    import json
    from pathlib import Path

    pkg = Path(__file__).resolve().parents[1] / "frontend" / "package.json"
    if not pkg.is_file():
        pytest.skip("frontend/package.json not present in this checkout")
    expected = json.loads(pkg.read_text(encoding="utf-8"))["version"]
    assert server_module._app_version() == expected
