"""Serving an uploaded file back — the route that makes thumbnails possible.

A chip reading "photo.png" and a chip SHOWING the photo are different products:
only the second one lets someone catch "that is the wrong screenshot" before
they send it. That needs the bytes back in the browser, which is why this route
exists and why it is a hand-written handler rather than a mounted static dir.

Everything here is about the sandbox. The upload directory holds
attacker-influenced filenames, and this is the one route that reads out of it.
"""

from __future__ import annotations

import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server as server_module  # noqa: E402
from server import app  # noqa: E402


@pytest.fixture()
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture()
def an_upload():
    """A real file inside the real upload dir, cleaned up afterwards."""
    path = server_module.UPLOAD_DIR / "abcd1234_shot.png"
    path.write_bytes(b"\x89PNG\r\n\x1a\n-not-really-a-png")
    yield path
    path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_an_uploaded_file_comes_back(client, an_upload):
    res = await client.get("/api/upload/abcd1234_shot.png")
    assert res.status_code == 200
    assert res.content == an_upload.read_bytes()


@pytest.mark.asyncio
async def test_a_traversal_attempt_misses_rather_than_escaping(client):
    """`Path(name).name` degrades "../../x" to "x", so the lookup simply fails
    inside the sandbox instead of resolving outside it."""
    for probe in (
        "../../../../etc/passwd",
        "..%2F..%2Fserver.py",
        "....//server.py",
    ):
        res = await client.get(f"/api/upload/{probe}")
        assert res.status_code == 404, probe


@pytest.mark.asyncio
async def test_a_file_outside_the_upload_dir_is_never_served(client):
    """Named directly, by a path that really exists on this machine."""
    res = await client.get("/api/upload/server.py")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_a_missing_file_and_a_present_but_unservable_one_look_identical(client):
    """A probe must not learn WHICH rule refused it. Both of these reach the
    handler (unlike a traversal with a slash, which never matches the route at
    all), so both must answer with the same body as well as the same code —
    otherwise the response distinguishes "not there" from "there but not
    allowed", which is a file-existence oracle."""
    present_but_unservable = server_module.UPLOAD_DIR / "secrets.env"
    present_but_unservable.write_bytes(b"TOKEN=hunter2")
    try:
        missing = await client.get("/api/upload/definitely-not-here.png")
        refused = await client.get("/api/upload/secrets.env")
        assert missing.status_code == refused.status_code == 404
        assert missing.json() == refused.json()
    finally:
        present_but_unservable.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_only_image_types_are_served_back(client):
    """THE FINDING that shaped this route: the UPLOAD allow-list is wide —
    .env, .py, .sql, .html, .svg — because it governs what the MODEL may read
    with its own Read tool in a subprocess. Serving those over HTTP from the
    app's origin is a different act entirely.

    So the preview route carries its own, much narrower list. SVG is excluded
    despite being an image: it is a script-bearing document."""
    for name, body in (
        ("evil.html", b"<script>alert(1)</script>"),
        ("evil.svg", b"<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>"),
        ("creds.env", b"TOKEN=hunter2"),
        ("code.py", b"print('hi')"),
    ):
        path = server_module.UPLOAD_DIR / name
        path.write_bytes(body)
        try:
            res = await client.get(f"/api/upload/{name}")
            assert res.status_code == 404, f"{name} must not be served over HTTP"
        finally:
            path.unlink(missing_ok=True)


@pytest.mark.asyncio
async def test_content_is_never_served_inline(client, an_upload):
    """An SVG served inline from our own origin runs script in the app's
    context. `<img>` renders an attachment-disposition response perfectly well,
    so nothing is lost by refusing to inline."""
    res = await client.get("/api/upload/abcd1234_shot.png")
    assert res.headers["content-disposition"].startswith("attachment")
    assert res.headers["x-content-type-options"] == "nosniff"
