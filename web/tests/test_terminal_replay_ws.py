import asyncio
import time
from unittest.mock import MagicMock

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import server
from pty_manager import TerminalSession
from terminal_history import TerminalHistory

# Each TestClient runs the app on its OWN event loop, while the shipped server has
# exactly one for the life of the process. asyncio.Event binds to the first loop
# that waits on it, so a test opening several sockets against one session would hit
# a cross-loop wait that production cannot reach. Hand every connection a fresh,
# unbound Event rather than weakening the server to tolerate a test-only shape.
_LIVE_SESSION = None


@pytest.fixture
def session(monkeypatch):
    global _LIVE_SESSION
    value = TerminalSession(id="replay-test", name="test", pty=MagicMock(), created_at="")
    monkeypatch.setattr(server.pty_manager, "get_terminal", lambda _: value)
    monkeypatch.setattr(server.pty_manager, "resync_alive", lambda _: True)
    _LIVE_SESSION = value
    yield value
    _LIVE_SESSION = None


def connect(query="", origin="http://localhost:8420"):
    if _LIVE_SESSION is not None:
        _LIVE_SESSION.history_changed = asyncio.Event()
    client = TestClient(server.app)
    return client.websocket_connect("/ws/terminal/replay-test?replay=1" + query,
        headers={"host": "localhost:8420", "origin": origin})


def _drain_to_replay_end(socket):
    """Return the output frames of the initial replay, consuming its replay_end."""
    frames = []
    while True:
        frame = socket.receive_json()
        if frame["type"] == "replay_end":
            return frames
        if frame["type"] == "output":
            frames.append(frame)


def test_fresh_view_replays_and_reconnect_only_sends_missing_chunks(session):
    session.history.append("OLD CONTEXT\r\n")
    with connect() as socket:
        assert socket.receive_json() == {"type": "replay_start", "reset": True, "truncated": False}
        assert socket.receive_json() == {"type": "output", "seq": 1, "data": "OLD CONTEXT\r\n"}
        assert socket.receive_json() == {"type": "replay_end", "seq": 1}
    session.history.append("NEW CONTEXT\r\n")
    with connect("&after=1") as socket:
        assert socket.receive_json() == {"type": "replay_start", "reset": False, "truncated": False}
        assert socket.receive_json() == {"type": "output", "seq": 2, "data": "NEW CONTEXT\r\n"}
        assert socket.receive_json()["type"] == "replay_end"
    with connect() as socket:
        socket.receive_json()
        # The popout still receives the complete retained stream — it now arrives
        # coalesced into ONE frame carrying the LAST seq it covers, which the
        # client records as "accepted through 2" (utils/terminalReplay.js).
        assert socket.receive_json() == {
            "type": "output", "seq": 2, "data": "OLD CONTEXT\r\nNEW CONTEXT\r\n",
        }
        assert socket.receive_json() == {"type": "replay_end", "seq": 2}


def test_cursor_gap_is_visible_and_foreign_origin_cannot_replay(session):
    session.history = TerminalHistory(max_bytes=4)
    session.history.append("OLD!")
    session.history.append("NEW!")
    with connect("&after=0") as socket:
        assert socket.receive_json() == {"type": "replay_start", "reset": True, "truncated": True}
        assert socket.receive_json()["data"] == "NEW!"
    with pytest.raises(WebSocketDisconnect):
        with connect(origin="https://foreign.example"):
            pytest.fail("Foreign origin received a replay socket")


def test_an_idle_replay_socket_does_not_re_snapshot_history(session):
    """Delivery is the event, not a cadence.

    The 25 ms poll this replaces called snapshot() ~40 times per idle second PER
    socket, which is what saturated the event loop with four or five panes open.
    """
    session.history.append("SETTLED\r\n")
    calls = []
    real_snapshot = session.history.snapshot

    def counted(after=None):
        calls.append(after)
        return real_snapshot(after)

    session.history.snapshot = counted

    with connect() as socket:
        _drain_to_replay_end(socket)
        time.sleep(1.0)
        settled = len(calls)

    assert settled <= 3, f"idle replay still polls history: {settled} snapshots in one idle second"


def test_new_output_wakes_the_socket_without_waiting_for_the_liveness_tick(session, monkeypatch):
    async def echo(terminal_id, data):
        # Runs ON the app's event loop — the only thread-safe place a TestClient
        # test can set the event the replay task is waiting on.
        session.history.append("ECHO:" + data)
        session.history_changed.set()
        return True

    monkeypatch.setattr(server.pty_manager, "write_pty_async", echo)

    with connect() as socket:
        _drain_to_replay_end(socket)
        socket.send_text("k")
        started = time.monotonic()
        frame = socket.receive_json()
        elapsed = time.monotonic() - started

    assert frame == {"type": "output", "seq": 1, "data": "ECHO:k"}
    # receive_json() blocks, so the wall clock is the proof: a 0.5 s liveness tick
    # would land well outside this window.
    assert elapsed < 0.25, f"output waited for the liveness tick ({elapsed:.3f}s), it was not event-driven"


def test_a_long_retained_stream_replays_in_a_handful_of_frames(session):
    for _ in range(500):
        session.history.append("x\r\n")

    with connect() as socket:
        assert socket.receive_json()["type"] == "replay_start"
        frames = _drain_to_replay_end(socket)

    assert len(frames) < 5, f"500 retained chunks replayed as {len(frames)} frames"
    assert frames[-1]["seq"] == 500
    assert "".join(frame["data"] for frame in frames) == "x\r\n" * 500


# -- A1: the PTY's size reaches every replay socket --------------------------


def _foreign(session, monkeypatch, action):
    """Route a keystroke to `action`, run ON the app's loop (where resize_terminal runs)."""
    monkeypatch.setitem(server.pty_manager.sessions, session.id, session)

    async def run(terminal_id, data):
        action(data)
        return True

    monkeypatch.setattr(server.pty_manager, "write_pty_async", run)


def test_no_resize_frame_on_connect(session, monkeypatch):
    def echo(data):
        session.history.append("ECHO:" + data)
        session.history_changed.set()

    _foreign(session, monkeypatch, echo)
    with connect() as socket:
        _drain_to_replay_end(socket)
        socket.send_text("k")
        assert socket.receive_json() == {"type": "output", "seq": 1, "data": "ECHO:k"}


def test_a_foreign_resize_sends_one_frame_and_needs_no_output(session, monkeypatch):
    # A phone or peer Studio resizing: no output is appended, only resize_terminal.
    _foreign(session, monkeypatch,
             lambda _d: server.pty_manager.resize_terminal(session.id, 100, 40))
    with connect() as socket:
        _drain_to_replay_end(socket)
        socket.send_text("k")
        started = time.monotonic()
        frame = socket.receive_json()
        elapsed = time.monotonic() - started
    assert frame == {"type": "resize", "cols": 100, "rows": 40}
    assert elapsed < 0.25, f"resize waited for the liveness tick ({elapsed:.3f}s)"
    assert session.history.snapshot(None)["chunks"] == []


def test_an_unchanged_size_sends_no_frame(session, monkeypatch):
    def same_size_then_echo(data):
        assert server.pty_manager.resize_terminal(session.id, session.cols, session.rows)
        session.history.append("ECHO:" + data)
        session.history_changed.set()

    _foreign(session, monkeypatch, same_size_then_echo)
    with connect() as socket:
        _drain_to_replay_end(socket)
        socket.send_text("k")
        assert socket.receive_json() == {"type": "output", "seq": 1, "data": "ECHO:k"}


def test_resize_terminal_wakes_history_and_remote_listeners_only_on_change(session, monkeypatch):
    monkeypatch.setitem(server.pty_manager.sessions, session.id, session)
    listener = asyncio.Event()
    session.remote_listeners.add(listener)
    session.history_changed = asyncio.Event()
    assert server.pty_manager.resize_terminal(session.id, session.cols, session.rows)
    assert not session.history_changed.is_set() and not listener.is_set()
    assert server.pty_manager.resize_terminal(session.id, 90, 25)
    assert session.history_changed.is_set() and listener.is_set()
