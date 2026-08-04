"""Tests for server endpoints — uses FastAPI TestClient."""

import pytest
from httpx import AsyncClient, ASGITransport

# Import must happen after env setup
import logging_config
logging_config.setup("WARNING")

from server import app
import server as server_module


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    # Loopback base_url, not "http://test": the origin guard's anti-rebinding
    # clause refuses a non-loopback Host, so a test client presenting an
    # imaginary hostname would 403 on every route. Presenting as the app is
    # really reached is also the more honest fixture.
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.mark.asyncio
async def test_health_endpoint(client):
    res = await client.get("/health")
    assert res.status_code == 200
    data = res.json()
    assert data["status"] == "ok"
    assert "sessions" in data
    assert "uptime_seconds" in data


@pytest.mark.asyncio
async def test_browse_drives(client):
    res = await client.get("/api/browse")
    assert res.status_code == 200
    data = res.json()
    assert "dirs" in data
    # On Windows, should have at least C:\
    assert len(data["dirs"]) > 0


@pytest.mark.asyncio
async def test_browse_invalid_path(client):
    res = await client.get("/api/browse?path=Z:\\definitely_not_real_path_xyz")
    assert res.status_code == 200
    data = res.json()
    assert data["dirs"] == []


@pytest.mark.asyncio
async def test_me_local(client):
    """Local mode: /api/me always returns authenticated."""
    res = await client.get("/api/me")
    assert res.status_code == 200
    data = res.json()
    assert data["authenticated"] is True
    assert data["mode"] == "local"


@pytest.mark.asyncio
async def test_git_status_non_git_dir(client):
    """Git status on a non-git directory returns git=False."""
    import tempfile
    with tempfile.TemporaryDirectory() as tmpdir:
        res = await client.get(f"/api/git/status?path={tmpdir}")
        assert res.status_code == 200
        data = res.json()
        assert data["git"] is False


# ── Upload endpoint tests ─────────────────────────────────


@pytest.mark.asyncio
async def test_upload_normal_py_file(client):
    """A normal .py upload succeeds and returns a path inside UPLOAD_DIR."""
    import server
    content = b"print('hello')"
    res = await client.post(
        "/api/upload",
        files=[("files", ("hello.py", content, "text/plain"))],
    )
    assert res.status_code == 200
    data = res.json()
    assert "paths" in data
    assert len(data["paths"]) == 1
    returned_path = data["paths"][0]
    assert returned_path.startswith(str(server.UPLOAD_DIR))
    assert returned_path.endswith("hello.py")
    assert "errors" not in data


@pytest.mark.asyncio
async def test_upload_multiple_files(client):
    """Multiple files in a single multipart request all succeed."""
    files = [
        ("files", ("a.py", b"x = 1", "text/plain")),
        ("files", ("b.txt", b"hello", "text/plain")),
        ("files", ("c.md", b"# heading", "text/plain")),
    ]
    res = await client.post("/api/upload", files=files)
    assert res.status_code == 200
    data = res.json()
    assert len(data["paths"]) == 3
    assert "errors" not in data


@pytest.mark.asyncio
async def test_upload_filename_with_spaces(client):
    """A filename containing spaces is accepted and the path is returned."""
    import server
    content = b"data"
    res = await client.post(
        "/api/upload",
        files=[("files", ("my notes.txt", content, "text/plain"))],
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["paths"]) == 1
    assert data["paths"][0].startswith(str(server.UPLOAD_DIR))
    assert "errors" not in data


@pytest.mark.asyncio
async def test_upload_path_traversal_forward_slash(client):
    """
    Filename '../../etc/passwd.txt' must be sanitised to 'passwd.txt'
    and saved inside UPLOAD_DIR, not outside it.

    Would have been RED before Fix 1: the old code used
    `f"{uuid}_{upload.filename}"` which would embed the raw '../..' into the
    destination path, writing outside UPLOAD_DIR.
    """
    import server
    content = b"root:x:0:0"
    res = await client.post(
        "/api/upload",
        files=[("files", ("../../etc/passwd.txt", content, "text/plain"))],
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["paths"]) == 1
    returned_path = data["paths"][0]
    # Must be inside UPLOAD_DIR
    assert returned_path.startswith(str(server.UPLOAD_DIR))
    # Base name must be just 'passwd.txt', not contain '..'
    from pathlib import Path
    assert ".." not in Path(returned_path).name
    assert Path(returned_path).name.endswith("passwd.txt")


@pytest.mark.asyncio
async def test_upload_path_traversal_backslash(client):
    """
    Filename '..\\..\\Windows\\evil.py' must be sanitised to 'evil.py'
    and saved inside UPLOAD_DIR.

    Would have been RED before Fix 1: raw filename embedded in dest path
    could escape UPLOAD_DIR on Windows where backslash is a path separator.
    """
    import server
    from pathlib import Path
    content = b"import os"
    res = await client.post(
        "/api/upload",
        files=[("files", ("..\\..\\Windows\\evil.py", content, "text/plain"))],
    )
    assert res.status_code == 200
    data = res.json()
    assert len(data["paths"]) == 1
    returned_path = data["paths"][0]
    assert returned_path.startswith(str(server.UPLOAD_DIR))
    assert ".." not in Path(returned_path).name
    assert Path(returned_path).name.endswith("evil.py")


@pytest.mark.asyncio
async def test_upload_traversal_only_separators_rejected(client):
    """
    Filename '../../../' strips to '' then falls back to 'upload', but
    that fallback name has no extension, so the extension check rejects it.

    Would have been RED before Fix 1: the old code embedded the raw filename
    (containing only separators) into the path, causing a confusing OS error
    or an escape, rather than a clean extension-check rejection.
    """
    content = b"malicious"
    res = await client.post(
        "/api/upload",
        files=[("files", ("../../../", content, "text/plain"))],
    )
    assert res.status_code == 200
    data = res.json()
    # No paths saved; error reported for the unsupported extension
    assert data["paths"] == []
    assert "errors" in data
    assert len(data["errors"]) == 1


@pytest.mark.asyncio
async def test_upload_disallowed_extension(client):
    """A .exe file is rejected with an error; no path is returned."""
    content = b"MZ\x90\x00"
    res = await client.post(
        "/api/upload",
        files=[("files", ("evil.exe", content, "application/octet-stream"))],
    )
    assert res.status_code == 200
    data = res.json()
    assert data["paths"] == []
    assert "errors" in data
    assert "evil.exe" in data["errors"][0]


@pytest.mark.asyncio
async def test_upload_file_too_large(client):
    """A file exceeding 50MB is rejected; no path is returned."""
    import server
    from unittest.mock import patch
    # Patch MAX_FILE_SIZE down to 10 bytes so we don't need a real 50MB payload
    small_limit = 10
    oversized_content = b"x" * (small_limit + 1)
    with patch.object(server, "MAX_FILE_SIZE", small_limit):
        res = await client.post(
            "/api/upload",
            files=[("files", ("big.txt", oversized_content, "text/plain"))],
        )
    assert res.status_code == 200
    data = res.json()
    assert data["paths"] == []
    assert "errors" in data
    assert "50MB" in data["errors"][0]


@pytest.mark.asyncio
async def test_upload_quota_exceeded_sequentially(client):
    """
    Sequential uploads that together exceed MAX_UPLOAD_DIR_SIZE are rejected
    once the quota is full.

    Uses a patched MAX_UPLOAD_DIR_SIZE of 50 bytes so the test runs quickly.
    """
    import server
    from unittest.mock import patch

    small_quota = 50
    chunk = b"x" * 30  # 30 bytes each; two of these exceed 50 bytes

    with patch.object(server, "MAX_UPLOAD_DIR_SIZE", small_quota):
        # Also reset the running total so prior tests don't interfere
        original_size = server._upload_dir_size
        server._upload_dir_size = 0
        try:
            # First upload: 30 bytes < 50 → accepted
            res1 = await client.post(
                "/api/upload",
                files=[("files", ("first.txt", chunk, "text/plain"))],
            )
            data1 = res1.json()
            assert len(data1["paths"]) == 1, "first upload should succeed"

            # Second upload: 30 + 30 = 60 > 50 → rejected
            res2 = await client.post(
                "/api/upload",
                files=[("files", ("second.txt", chunk, "text/plain"))],
            )
            data2 = res2.json()
            assert data2["paths"] == [], "second upload should be rejected (quota full)"
            assert "errors" in data2
            assert "200MB" in data2["errors"][0]
        finally:
            server._upload_dir_size = original_size


@pytest.mark.asyncio
async def test_upload_concurrent_quota_enforcement(client):
    """
    Two concurrent uploads that together exceed MAX_UPLOAD_DIR_SIZE must result
    in exactly one success and one rejection — not both succeeding.

    This is the race-condition regression test for Fix 2.
    Would have been RED before Fix 2: without _upload_lock, both coroutines
    could read the same (non-full) _upload_dir_size value, both pass the check,
    and both write, exceeding the quota.
    """
    import asyncio
    import server
    from unittest.mock import patch

    # Quota: 50 bytes. Each file: 35 bytes. Together they exceed quota.
    small_quota = 50
    chunk = b"y" * 35

    with patch.object(server, "MAX_UPLOAD_DIR_SIZE", small_quota):
        original_size = server._upload_dir_size
        server._upload_dir_size = 0
        try:
            async def upload_one(name: str):
                return await client.post(
                    "/api/upload",
                    files=[("files", (name, chunk, "text/plain"))],
                )

            res_a, res_b = await asyncio.gather(
                upload_one("concurrent_a.txt"),
                upload_one("concurrent_b.txt"),
            )

            paths_a = res_a.json().get("paths", [])
            paths_b = res_b.json().get("paths", [])
            errors_a = res_a.json().get("errors", [])
            errors_b = res_b.json().get("errors", [])

            total_accepted = len(paths_a) + len(paths_b)
            total_rejected = len(errors_a) + len(errors_b)

            # Exactly one must succeed and one must fail
            assert total_accepted == 1, (
                f"Expected exactly 1 accepted upload, got {total_accepted}. "
                "This suggests the race condition (Fix 2) is not working."
            )
            assert total_rejected == 1, (
                f"Expected exactly 1 rejected upload, got {total_rejected}."
            )
        finally:
            server._upload_dir_size = original_size


@pytest.mark.asyncio
async def test_upload_response_format(client):
    """Successful upload always returns the {'paths': [...]} shape."""
    content = b"data = 42"
    res = await client.post(
        "/api/upload",
        files=[("files", ("shape_check.py", content, "text/plain"))],
    )
    assert res.status_code == 200
    data = res.json()
    assert "paths" in data
    assert isinstance(data["paths"], list)
    # 'errors' key absent when there are no errors
    assert "errors" not in data


@pytest.mark.asyncio
async def test_upload_mixed_valid_invalid_returns_partial(client):
    """
    One valid and one invalid file in the same request: the valid file is
    saved and the invalid file gets an error entry — both in the same response.
    """
    files = [
        ("files", ("good.py", b"x = 1", "text/plain")),
        ("files", ("bad.exe", b"MZ", "application/octet-stream")),
    ]
    res = await client.post("/api/upload", files=files)
    assert res.status_code == 200
    data = res.json()
    assert len(data["paths"]) == 1
    assert "errors" in data
    assert len(data["errors"]) == 1
    assert "bad.exe" in data["errors"][0]


# ---------------------------------------------------------------------------
# main() — default bind host (fix: insecure default was HOST=0.0.0.0)
#
# uvicorn.run is monkeypatched in every test below so main() never actually
# binds a real port or starts a server — we only assert what main() WOULD
# hand to uvicorn, and whether it logged the no-authentication warning.
# server_module.logger.warning is monkeypatched directly (rather than using
# caplog) because logging_config.setup() sets propagate=False on the
# "cockpit" logger, which would prevent records from reaching caplog's
# root-attached capture handler.
# ---------------------------------------------------------------------------


def _patch_uvicorn_run(monkeypatch):
    """Replace uvicorn.run with a stub that records its args instead of
    binding a real port. Returns the dict the stub will populate.
    """
    import uvicorn
    captured = {}

    def fake_run(app, host, port):
        captured["host"] = host
        captured["port"] = port

    monkeypatch.setattr(uvicorn, "run", fake_run)
    return captured


def _patch_server_warning(monkeypatch):
    """Wrap server_module.logger.warning to record formatted messages."""
    warnings: list[str] = []
    original_warning = server_module.logger.warning

    def tracked_warning(msg, *args, **kwargs):
        warnings.append(msg % args if args else msg)
        return original_warning(msg, *args, **kwargs)

    monkeypatch.setattr(server_module.logger, "warning", tracked_warning)
    return warnings


def test_main_defaults_to_loopback_host(monkeypatch):
    """main() binds 127.0.0.1 by default (not 0.0.0.0) when HOST is unset,
    and does not log the no-authentication warning (127.0.0.1 is loopback).
    """
    monkeypatch.delenv("HOST", raising=False)
    monkeypatch.setenv("PORT", "18420")
    monkeypatch.setenv("NO_BROWSER", "1")  # skip the browser-open timer thread

    captured = _patch_uvicorn_run(monkeypatch)
    warnings = _patch_server_warning(monkeypatch)

    server_module.main()

    assert captured["host"] == "127.0.0.1"
    assert captured["port"] == 18420
    assert not any("no authentication" in w.lower() for w in warnings)


def test_main_warns_when_host_overridden_to_non_loopback(monkeypatch):
    """main() logs a prominent warning when HOST is explicitly set to a
    non-loopback address, since the API has no authentication.
    """
    monkeypatch.setenv("HOST", "0.0.0.0")
    monkeypatch.setenv("PORT", "18421")
    monkeypatch.setenv("NO_BROWSER", "1")

    captured = _patch_uvicorn_run(monkeypatch)
    warnings = _patch_server_warning(monkeypatch)

    server_module.main()

    assert captured["host"] == "0.0.0.0"
    assert any(
        "no authentication" in w.lower() and "0.0.0.0" in w for w in warnings
    ), f"Expected a prominent non-loopback warning; got: {warnings}"


def test_main_host_env_override_to_loopback_alias_does_not_warn(monkeypatch):
    """HOST=localhost (a recognised loopback alias) is respected and does NOT
    trigger the no-authentication warning.
    """
    monkeypatch.setenv("HOST", "localhost")
    monkeypatch.setenv("PORT", "18422")
    monkeypatch.setenv("NO_BROWSER", "1")

    captured = _patch_uvicorn_run(monkeypatch)
    warnings = _patch_server_warning(monkeypatch)

    server_module.main()

    assert captured["host"] == "localhost"
    assert not any("no authentication" in w.lower() for w in warnings)
