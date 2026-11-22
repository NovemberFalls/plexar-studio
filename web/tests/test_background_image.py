"""Tests for background_image: magic-byte typing, size cap, replace and delete."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

import background_image

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32
WEBP = b"RIFF\x00\x00\x00\x00WEBP" + b"\x00" * 32


@pytest.fixture()
def client(tmp_path):
    background_image.set_data_dir_for_tests(tmp_path)
    app = FastAPI()
    app.include_router(background_image.router)
    yield TestClient(app, base_url="http://127.0.0.1:8420"), tmp_path
    background_image.set_data_dir_for_tests(None)


def _put(c, data, name="x.png", ctype="image/png"):
    return c.put("/api/background", files={"file": (name, data, ctype)})


def _stored(tmp_path):
    return sorted(p.name for p in tmp_path.glob("background.*"))


@pytest.mark.parametrize(
    "data,ext,ctype",
    [(PNG, "png", "image/png"), (JPG, "jpg", "image/jpeg"), (WEBP, "webp", "image/webp")],
)
def test_each_type_accepted(client, data, ext, ctype):
    c, tmp = client
    r = _put(c, data, name="whatever.bin", ctype="application/octet-stream")
    assert r.status_code == 200
    assert r.json()["type"] == ctype
    assert _stored(tmp) == [f"background.{ext}"]
    img = c.get("/api/background/image")
    assert img.status_code == 200
    assert img.headers["content-type"] == ctype
    assert "private" in img.headers["cache-control"]
    assert img.content == data


def test_renamed_text_file_refused(client):
    c, tmp = client
    r = _put(c, b"just some text, not an image", name="evil.png", ctype="image/png")
    assert r.status_code == 400
    assert _stored(tmp) == []


def test_svg_refused(client):
    c, _ = client
    r = _put(c, b"<svg xmlns='http://www.w3.org/2000/svg'/>", name="a.svg", ctype="image/svg+xml")
    assert r.status_code == 400


def test_oversize_413(client):
    c, tmp = client
    big = PNG + b"\x00" * (background_image.MAX_BYTES + 1)
    assert _put(c, big).status_code == 413
    assert _stored(tmp) == []


def test_replace_png_with_jpg_leaves_one_file(client):
    c, tmp = client
    _put(c, PNG)
    _put(c, JPG, name="b.jpg", ctype="image/jpeg")
    assert _stored(tmp) == ["background.jpg"]


def test_version_changes_on_replace(client):
    c, _ = client
    _put(c, PNG)
    v1 = c.get("/api/background").json()["version"]
    _put(c, PNG + b"\x01" * 10)
    v2 = c.get("/api/background").json()["version"]
    assert v1 and v2 and v1 != v2


def test_delete_then_image_404(client):
    c, tmp = client
    _put(c, PNG)
    assert c.delete("/api/background").status_code == 200
    assert c.get("/api/background/image").status_code == 404
    assert _stored(tmp) == []
    assert c.delete("/api/background").status_code == 200


def test_meta_never_4xx(client):
    c, _ = client
    r = c.get("/api/background")
    assert r.status_code == 200
    assert r.json() == {"set": False, "version": None, "bytes": 0, "type": None}
    _put(c, PNG)
    assert c.get("/api/background").status_code == 200
