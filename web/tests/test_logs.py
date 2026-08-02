"""Tests for the log file sink (web/logging_config.py) and the log routes:

  GET  /api/logs         — redacted tail
  GET  /api/logs/level   — current cockpit logger level
  PUT  /api/logs/level   — set it, validated
  POST /api/logs/reveal  — always 200

No test writes to the real ~/.claude-cockpit/logs directory: every test points
logging_config at tmp_path via the COCKPIT_LOG_DIR override.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
import sys

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from server import app
import server as server_module


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture()
def log_dir(tmp_path, monkeypatch):
    """Redirect the log path to tmp_path for this test only."""
    d = tmp_path / "logs"
    monkeypatch.setenv("COCKPIT_LOG_DIR", str(d))
    return d


@pytest.fixture()
def restore_level():
    logger = logging.getLogger("cockpit")
    previous = logger.level
    yield
    logger.setLevel(previous)


# ---------------------------------------------------------------------------
# Rotation config
# ---------------------------------------------------------------------------


def test_rotation_is_bounded():
    cfg = logging_config.rotation_config()
    assert cfg["max_bytes"] > 0
    assert cfg["backup_count"] > 0
    # A long-running desktop app must have a hard ceiling, and a modest one.
    assert cfg["max_total_bytes"] == cfg["max_bytes"] * (cfg["backup_count"] + 1)
    assert cfg["max_total_bytes"] <= 32 * 1024 * 1024


def test_setup_installs_a_rotating_file_handler(log_dir):
    root = logging_config.setup("WARNING")
    try:
        handlers = [h for h in root.handlers
                    if isinstance(h, logging.handlers.RotatingFileHandler)]
        assert len(handlers) == 1
        assert handlers[0].maxBytes == logging_config.LOG_MAX_BYTES
        assert handlers[0].backupCount == logging_config.LOG_BACKUP_COUNT
        # The stderr handler is still there -- file logging is additive.
        assert any(type(h) is logging.StreamHandler for h in root.handlers)
        assert logging_config.file_logging_active() is True
        assert logging_config.log_file_path() == str(log_dir / "cockpit.log")
    finally:
        logging_config.setup("WARNING")


def test_repeated_setup_does_not_stack_handlers(log_dir):
    try:
        logging_config.setup("WARNING")
        first = len(logging.getLogger("cockpit").handlers)
        logging_config.setup("WARNING")
        assert len(logging.getLogger("cockpit").handlers) == first
    finally:
        logging_config.setup("WARNING")


def test_unwritable_log_dir_degrades_to_stderr_only(monkeypatch, tmp_path):
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("", encoding="utf-8")
    monkeypatch.setenv("COCKPIT_LOG_DIR", str(blocker / "logs"))
    try:
        root = logging_config.setup("WARNING")
        assert logging_config.file_logging_active() is False
        assert any(type(h) is logging.StreamHandler for h in root.handlers)
    finally:
        # RE-POINT, NEVER UNSET. `delenv` here took effect IMMEDIATELY while
        # monkeypatch's restore only runs at teardown, so the setup() below ran
        # with no override at all -- log_dir() then fell back to
        # app_paths.data_path("logs"), the USER'S REAL LOG DIRECTORY, and
        # installed a RotatingFileHandler on it that survived for the rest of
        # the pytest session. Every test after this one wrote its (deliberately
        # alarming) fixture tracebacks into the log of the running app, and two
        # processes rotating one file on Windows is a rename against an open
        # handle. Found 2026-08-02 by reading the live log and seeing
        # tests/test_managed_vllm.py in it.
        monkeypatch.setenv("COCKPIT_LOG_DIR", str(tmp_path / "restored-logs"))
        logging_config.setup("WARNING")


# ---------------------------------------------------------------------------
# _tail_file
# ---------------------------------------------------------------------------


def test_tail_returns_last_n_lines_in_order(tmp_path):
    path = tmp_path / "cockpit.log"
    path.write_text("".join(f"line {i}\n" for i in range(1000)), encoding="utf-8")

    lines, truncated, size = server_module._tail_file(path, 5)

    assert lines == ["line 995", "line 996", "line 997", "line 998", "line 999"]
    assert truncated is True
    assert size == path.stat().st_size


def test_tail_of_short_file_returns_everything_untruncated(tmp_path):
    path = tmp_path / "cockpit.log"
    path.write_text("a\nb\nc\n", encoding="utf-8")

    lines, truncated, _size = server_module._tail_file(path, 500)

    assert lines == ["a", "b", "c"]
    assert truncated is False


def test_tail_spanning_multiple_blocks(tmp_path):
    """Forces the backwards-read loop past its 64 KiB block size."""
    path = tmp_path / "cockpit.log"
    path.write_text("".join(f"{i:>07}" + "x" * 100 + "\n" for i in range(3000)),
                    encoding="utf-8")

    lines, truncated, _size = server_module._tail_file(path, 700)

    assert len(lines) == 700
    assert lines[-1].startswith("0002999")
    assert lines[0].startswith("0002300")
    assert truncated is True


def test_tail_missing_file_is_clean_empty(tmp_path):
    lines, truncated, size = server_module._tail_file(tmp_path / "nope.log", 100)
    assert lines == []
    assert truncated is False
    assert size == 0


# ---------------------------------------------------------------------------
# Redaction
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("secret", [
    "sk-ant-api03-AAAAbbbbCCCCddddEEEEffff",
    "sk-or-v1-0123456789abcdef0123456789abcdef",
    "sk-proj-ZZZZyyyyXXXXwwww",
])
def test_redaction_hides_key_shapes(secret):
    line = f"2026-07-30 [INFO] cockpit.server: using {secret} now"
    out = server_module._redact(line)
    assert secret not in out
    assert "<redacted>" in out
    # The prefix survives so the reader still knows which key leaked.
    assert secret.split("-")[0] + "-" in out


def test_redaction_hides_bearer_tokens():
    line = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"
    out = server_module._redact(line)
    assert "abcdefghijklmnopqrstuvwxyz123456" not in out
    assert "Bearer <redacted>" in out


def test_redaction_leaves_ordinary_lines_alone():
    line = "2026-07-30 [INFO] cockpit.pty: spawned C:\\Users\\x\\.local\\bin\\claude.exe"
    assert server_module._redact(line) == line


@pytest.mark.asyncio
async def test_logs_route_redacts(client, log_dir):
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "cockpit.log").write_text(
        "plain line\nleaked sk-ant-api03-AAAAbbbbCCCCddddEEEE tail\n", encoding="utf-8",
    )

    async with client as c:
        body = (await c.get("/api/logs")).json()

    joined = "\n".join(body["lines"])
    assert "sk-ant-api03-AAAAbbbbCCCCddddEEEE" not in joined
    assert "sk-ant-<redacted>" in joined
    assert body["path"] == str(log_dir / "cockpit.log")


# ---------------------------------------------------------------------------
# GET /api/logs
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_logs_missing_file_is_clean(client, log_dir):
    async with client as c:
        resp = await c.get("/api/logs")

    assert resp.status_code == 200
    body = resp.json()
    assert body["lines"] == []
    assert body["truncated"] is False
    assert body["size_bytes"] == 0
    assert body["rotation"]["backup_count"] == logging_config.LOG_BACKUP_COUNT


@pytest.mark.asyncio
async def test_logs_lines_clamped_at_both_ends(client, log_dir):
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "cockpit.log").write_text(
        "".join(f"line {i}\n" for i in range(5000)), encoding="utf-8",
    )

    async with client as c:
        low = (await c.get("/api/logs?lines=0")).json()
        high = (await c.get("/api/logs?lines=999999")).json()
        junk = (await c.get("/api/logs?lines=abc")).json()

    assert len(low["lines"]) == 1
    assert len(high["lines"]) == 2000
    # Non-numeric input falls back to the default rather than 400ing.
    assert len(junk["lines"]) == 500


# ---------------------------------------------------------------------------
# Level
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_and_put_level_roundtrip(client, restore_level):
    async with client as c:
        assert (await c.get("/api/logs/level")).json()["levels"] == [
            "DEBUG", "INFO", "WARNING", "ERROR",
        ]
        resp = await c.put("/api/logs/level", json={"level": "debug"})
        assert resp.status_code == 200
        assert resp.json()["level"] == "DEBUG"
        assert (await c.get("/api/logs/level")).json()["level"] == "DEBUG"

    assert logging.getLogger("cockpit").level == logging.DEBUG


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [
    {"level": "TRACE"},
    {"level": "CRITICAL"},
    {"level": 10},
    {"level": None},
    {},
])
async def test_put_level_rejects_junk(client, restore_level, body):
    async with client as c:
        resp = await c.put("/api/logs/level", json=body)
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# Reveal
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reveal_always_200(client, log_dir, monkeypatch):
    calls = []
    monkeypatch.setattr(server_module.subprocess, "Popen", lambda argv, **kw: calls.append(argv))

    async with client as c:
        resp = await c.post("/api/logs/reveal")

    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    assert calls and isinstance(calls[0], list)


@pytest.mark.asyncio
async def test_reveal_failure_still_200(client, log_dir, monkeypatch):
    def boom(argv, **kw):
        raise OSError("no file manager")

    monkeypatch.setattr(server_module.subprocess, "Popen", boom)

    async with client as c:
        resp = await c.post("/api/logs/reveal")

    assert resp.status_code == 200
    assert resp.json()["ok"] is False
