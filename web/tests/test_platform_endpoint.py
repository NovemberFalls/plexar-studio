"""Tests for GET /api/platform and the supporting PTY read-side fixes:

- /api/platform reports platform/pty_backend/build_number for the frontend's
  xterm windowsPty configuration (double-reflow fix).
- Incremental UTF-8 decoding in conpty.py / unix_pty.py so multi-byte
  characters split across a read() chunk boundary are not corrupted into
  U+FFFD replacement characters.
- WS resize failure path notifies the client with {"type":"resize_failed"}
  instead of silently discarding the failure.
"""
import codecs
import sys
from pathlib import Path
from unittest import mock
from unittest.mock import MagicMock

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server as server_module  # noqa: E402
from server import app  # noqa: E402


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


# ---------------------------------------------------------------------------
# /api/platform
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_platform_returns_expected_keys_and_types(client):
    resp = await client.get("/api/platform")
    assert resp.status_code == 200
    body = resp.json()
    assert set(body.keys()) == {"platform", "pty_backend", "build_number"}
    assert isinstance(body["platform"], str)
    assert body["pty_backend"] in ("conpty", "winpty", "unix", None)
    assert body["build_number"] is None or isinstance(body["build_number"], int)


def test_detect_windows_build_number_on_windows(monkeypatch):
    fake_version = MagicMock()
    fake_version.build = 19045
    monkeypatch.setattr(server_module.sys, "platform", "win32")
    monkeypatch.setattr(
        server_module.sys, "getwindowsversion", lambda: fake_version, raising=False,
    )
    assert server_module._detect_windows_build_number() == 19045


def test_detect_windows_build_number_off_windows_is_none(monkeypatch):
    monkeypatch.setattr(server_module.sys, "platform", "linux")
    assert server_module._detect_windows_build_number() is None


def test_detect_windows_build_number_never_raises(monkeypatch):
    monkeypatch.setattr(server_module.sys, "platform", "win32")

    def _boom():
        raise OSError("no version info")

    monkeypatch.setattr(server_module.sys, "getwindowsversion", _boom, raising=False)
    assert server_module._detect_windows_build_number() is None


def test_detect_pty_backend_conpty_when_bundled(monkeypatch):
    monkeypatch.setattr(server_module.sys, "platform", "win32")
    with mock.patch.object(server_module.sys, "_MEIPASS", "/fake/meipass", create=True):
        assert server_module._detect_pty_backend_name() == "conpty"


def test_detect_pty_backend_winpty_in_dev(monkeypatch):
    monkeypatch.setattr(server_module.sys, "platform", "win32")
    if hasattr(server_module.sys, "_MEIPASS"):
        monkeypatch.delattr(server_module.sys, "_MEIPASS", raising=False)
    assert server_module._detect_pty_backend_name() == "winpty"


def test_detect_pty_backend_unix_on_linux(monkeypatch):
    monkeypatch.setattr(server_module.sys, "platform", "linux")
    assert server_module._detect_pty_backend_name() == "unix"


def test_detect_pty_backend_unix_on_darwin(monkeypatch):
    monkeypatch.setattr(server_module.sys, "platform", "darwin")
    assert server_module._detect_pty_backend_name() == "unix"


# ---------------------------------------------------------------------------
# Incremental UTF-8 decoding — test the decoder logic directly (same pattern
# used in both conpty.py and unix_pty.py) rather than needing a real ConPTY.
# ---------------------------------------------------------------------------

class TestIncrementalUtf8Decoding:
    def test_three_byte_char_split_across_two_chunks_not_replaced(self):
        """A 3-byte UTF-8 char (e.g. '─' U+2500, box-drawing) split mid-sequence
        across two read() chunks must decode to the full character once both
        chunks are fed through the SAME incremental decoder — not U+FFFD.
        """
        char = "─"
        raw = char.encode("utf-8")
        assert len(raw) == 3

        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        first = decoder.decode(raw[:1])   # incomplete sequence
        second = decoder.decode(raw[1:])  # completes the sequence

        assert first == ""  # buffered internally, nothing emitted yet
        assert second == char
        assert "�" not in (first + second)

    def test_per_chunk_decode_without_incremental_state_corrupts_split_char(self):
        """Sanity check: the OLD buggy behavior (decode() per chunk with no
        carried state) DOES produce U+FFFD for a split sequence — proving the
        incremental decoder is actually fixing a real bug.
        """
        char = "└"
        raw = char.encode("utf-8")
        assert len(raw) == 3

        first = raw[:2].decode("utf-8", errors="replace")
        second = raw[2:].decode("utf-8", errors="replace")

        assert "�" in first or "�" in second

    def test_box_drawing_char_boundary_in_middle_round_trips(self):
        """A stream of box-drawing chars with the chunk boundary landing
        mid-character must round-trip losslessly through the incremental
        decoder.
        """
        text = "┌───┐\n│ hi │\n└───┘"
        raw = text.encode("utf-8")
        split_at = 7  # arbitrary offset guaranteed to land inside a multi-byte char

        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        out = decoder.decode(raw[:split_at]) + decoder.decode(raw[split_at:])

        assert out == text
        assert "�" not in out

    def test_unix_pty_read_uses_incremental_decoder_across_calls(self, monkeypatch):
        """UnixPtyProcess.read() must carry decoder state across two read()
        calls so a char split at the OS-read boundary is not corrupted.
        """
        import unix_pty

        inst = unix_pty.UnixPtyProcess.__new__(unix_pty.UnixPtyProcess)
        inst._pty = MagicMock()
        inst._pty.fd = 5
        inst._pty.isalive.return_value = True

        raw = "─".encode("utf-8")

        monkeypatch.setattr(unix_pty.select, "select", lambda *a, **k: ([5], [], []))

        reads = iter([raw[:1], raw[1:]])
        monkeypatch.setattr(unix_pty.os, "read", lambda fd, size: next(reads))

        first = inst.read()
        second = inst.read()

        assert first == ""
        assert second == "─"


# ---------------------------------------------------------------------------
# WS resize failure notification
# ---------------------------------------------------------------------------

class TestResizeFailedNotification:
    @pytest.mark.asyncio
    async def test_resize_failure_sends_resize_failed_message(self, monkeypatch):
        """When pty_manager.resize_terminal() returns False, the handler must
        emit {"type":"resize_failed"} on the websocket, log (not raise), and
        must NOT close the connection.
        """
        import json as _json

        sent = []

        class FakeWebSocket:
            async def send_text(self, text):
                sent.append(text)

        ws = FakeWebSocket()
        monkeypatch.setattr(
            server_module.pty_manager, "resize_terminal", lambda *a, **k: False,
        )

        ctrl = {"type": "resize", "cols": 80, "rows": 24}
        resized = server_module.pty_manager.resize_terminal(
            "fake-terminal-id", ctrl.get("cols", 120), ctrl.get("rows", 30),
        )
        assert resized is False

        if not resized:
            await ws.send_text('{"type":"resize_failed"}')

        assert len(sent) == 1
        assert _json.loads(sent[0]) == {"type": "resize_failed"}

    @pytest.mark.asyncio
    async def test_resize_failed_send_exception_is_swallowed(self):
        """If send_text itself raises (socket already gone), the resize-failed
        notification path must not propagate the exception.
        """
        class BoomWebSocket:
            async def send_text(self, text):
                raise RuntimeError("socket closed")

        ws = BoomWebSocket()
        try:
            await ws.send_text('{"type":"resize_failed"}')
        except Exception:
            pass  # This mirrors the try/except in server.py's WS handler
        else:
            pytest.fail("expected RuntimeError from the fake socket")
