"""The upload dir is a CACHE, not a ceiling.

The bug these pin: `MAX_UPLOAD_DIR_SIZE` was a one-way ratchet. Nothing in the
app ever called `DELETE /api/upload`, so a long-lived session accumulated
uploads until every subsequent paste was refused -- including a tiny one,
because the check is on the directory total rather than the file. Only a
process restart cleared it.
"""

import pytest
from fastapi.testclient import TestClient

import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    """A client with an isolated, small upload dir.

    base_url must be loopback -- `http://test` sends `Host: test` and the
    origin guard 403s every route (see CLAUDE.md).
    """
    monkeypatch.setattr(server, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(server, "MAX_UPLOAD_DIR_SIZE", 1000)
    monkeypatch.setattr(server, "_upload_dir_size", 0)
    with TestClient(server.app, base_url="http://127.0.0.1:8420") as c:
        yield c


def _png(nbytes):
    return ("shot.png", b"x" * nbytes, "image/png")


def test_upload_past_the_cap_evicts_instead_of_refusing(client, tmp_path):
    """The regression itself: the (N+1)th upload succeeds."""
    for _ in range(3):
        r = client.post("/api/upload", files={"files": _png(300)})
        assert r.status_code == 200
        assert r.json()["paths"], r.json()

    # 900/1000 used. This one does not fit; it must still land.
    r = client.post("/api/upload", files={"files": _png(300)})
    body = r.json()
    assert body["paths"], f"upload refused after cap -- the ratchet is back: {body}"
    assert "errors" not in body, body
    assert server._upload_dir_size <= server.MAX_UPLOAD_DIR_SIZE


def test_eviction_takes_the_oldest_first(client, tmp_path):
    """Newest survive: the oldest belong to conversations that already ended."""
    import os

    paths = []
    for i in range(3):
        p = client.post("/api/upload", files={"files": _png(300)}).json()["paths"][0]
        # Force distinct, ordered mtimes -- a fast loop can write identical ones.
        os.utime(p, (1000 + i, 1000 + i))
        paths.append(p)

    client.post("/api/upload", files={"files": _png(300)})

    from pathlib import Path

    assert not Path(paths[0]).exists(), "oldest should have been evicted"
    assert Path(paths[2]).exists(), "newest must survive eviction"


def test_quota_total_stays_truthful_after_eviction(client, tmp_path):
    """The counter must track the disk, or the next check is made-up."""
    for _ in range(6):
        client.post("/api/upload", files={"files": _png(300)})

    on_disk = sum(f.stat().st_size for f in tmp_path.iterdir() if f.is_file())
    assert server._upload_dir_size == on_disk


def test_oversize_single_file_is_still_refused(client):
    """Eviction must not become a way to smuggle past MAX_FILE_SIZE."""
    r = client.post("/api/upload", files={"files": _png(10)})
    assert r.json()["paths"]

    import server as s

    original = s.MAX_FILE_SIZE
    try:
        s.MAX_FILE_SIZE = 5
        r = client.post("/api/upload", files={"files": _png(10)})
        body = r.json()
        assert not body["paths"]
        assert body["errors"], body
    finally:
        s.MAX_FILE_SIZE = original


def test_disallowed_extension_is_still_refused(client):
    r = client.post("/api/upload", files={"files": ("x.exe", b"MZ", "application/octet-stream")})
    body = r.json()
    assert not body["paths"]
    assert "unsupported file type" in body["errors"][0]
