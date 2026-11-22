"""App background image: one user-chosen picture stored in the data directory.

The stored filename is fixed by the server (``background.<ext>``); nothing from
the upload's name or declared type is trusted. The format is decided by magic
bytes and limited to PNG, JPEG and WebP. SVG is refused because it can carry
script, and no image library is used.
"""

from __future__ import annotations

import asyncio
import logging
import os
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

import app_paths

logger = logging.getLogger("cockpit.server")

router = APIRouter()

MAX_BYTES = 15 * 1024 * 1024
_CHUNK = 64 * 1024

# ext -> content type
_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}

# Tests point this at a tmp dir; None means the real data directory.
_data_dir_override: Path | None = None


def set_data_dir_for_tests(path: Path | None) -> None:
    global _data_dir_override
    _data_dir_override = path


def _dir() -> Path:
    return _data_dir_override if _data_dir_override is not None else app_paths.data_dir()


def sniff(head: bytes) -> str | None:
    """Return 'png' | 'jpg' | 'webp' from leading magic bytes, else None."""
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(head) >= 12 and head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


def _current() -> Path | None:
    d = _dir()
    for ext in _TYPES:
        p = d / f"background.{ext}"
        if p.is_file():
            return p
    return None


def _meta() -> dict:
    p = _current()
    if p is None:
        return {"set": False, "version": None, "bytes": 0, "type": None}
    try:
        st = p.stat()
    except OSError:
        logger.warning("background stat failed", exc_info=True)
        return {"set": False, "version": None, "bytes": 0, "type": None}
    return {
        "set": True,
        "version": f"{st.st_mtime_ns}-{st.st_size}",
        "bytes": st.st_size,
        "type": _TYPES[p.suffix.lstrip(".")],
    }


def _store(data: bytes, ext: str) -> None:
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".background-", suffix=".tmp", dir=str(d))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, d / f"background.{ext}")
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            logger.warning("background temp cleanup failed", exc_info=True)
        raise
    for other in _TYPES:
        if other != ext:
            try:
                (d / f"background.{other}").unlink(missing_ok=True)
            except OSError:
                logger.warning("could not remove old background.%s", other, exc_info=True)


def _remove() -> None:
    d = _dir()
    for ext in _TYPES:
        try:
            (d / f"background.{ext}").unlink(missing_ok=True)
        except OSError:
            logger.warning("could not remove background.%s", ext, exc_info=True)


@router.get("/api/background")
async def get_background_meta():
    return JSONResponse(await asyncio.to_thread(_meta))


@router.get("/api/background/image")
async def get_background_image():
    p = await asyncio.to_thread(_current)
    if p is None:
        raise HTTPException(status_code=404, detail="no background set")
    return FileResponse(
        p,
        media_type=_TYPES[p.suffix.lstrip(".")],
        headers={"Cache-Control": "private, max-age=0, must-revalidate"},
    )


@router.put("/api/background")
async def put_background(file: UploadFile):
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_BYTES:
            return JSONResponse({"error": "image exceeds 15 MB limit"}, status_code=413)
        chunks.append(chunk)
    data = b"".join(chunks)
    ext = sniff(data[:16])
    if ext is None:
        return JSONResponse({"error": "only PNG, JPEG or WebP images are accepted"}, status_code=400)
    await asyncio.to_thread(_store, data, ext)
    return JSONResponse(await asyncio.to_thread(_meta))


@router.delete("/api/background")
async def delete_background():
    await asyncio.to_thread(_remove)
    return JSONResponse({"set": False})
