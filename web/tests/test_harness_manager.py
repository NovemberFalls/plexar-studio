"""HarnessManager against a FAKE runtime (no node): key refusal, busy, permissions,
per-workspace fan-out, runtime exit, labels, session list union."""
from __future__ import annotations

import asyncio
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import harness_manager as hm  # noqa: E402
import settings_store  # noqa: E402
import queue  # noqa: E402
import threading  # noqa: E402

from plexar_harness_client import Update  # noqa: E402


class FakeRuntime:
    instances: list["FakeRuntime"] = []

    def __init__(self, workspace, env=None, on_permission=None, harness_root=None, **_):
        self.workspace = workspace
        self.env = dict(env or {})
        self.on_permission = on_permission
        self.harness_root = harness_root
        self.q: queue.Queue = queue.Queue()
        self.started = self.stopped = False
        self.turn_gate = threading.Event()
        self.turn_gate.set()
        self.prompt_error: Exception | None = None
        self.stderr_tail: list[str] = []
        self.listed = [{"sessionId": "old-1", "cwd": str(workspace)}]
        self.n = 0
        FakeRuntime.instances.append(self)

    def start(self):
        self.started = True
        return {}

    def stop(self):
        self.stopped = True
        self.q.put(None)
        return 0

    def updates(self):
        while True:
            item = self.q.get()
            if item is None:
                return
            yield item

    def emit(self, sid, kind="agent_message_chunk", payload=None):
        self.q.put(Update(sid, kind, payload or {"content": {"type": "text", "text": "hi"}}))

    def new_session(self):
        self.n += 1
        return {"sessionId": f"s{self.n}", "configOptions": [{"id": "model"}]}

    def list_sessions(self, cursor=None):
        if cursor is None:
            return {"sessions": self.listed[:1], "nextCursor": "c2"}
        return {"sessions": self.listed[1:]}

    def resume_session(self, sid):
        return {"configOptions": [{"id": "reasoning_effort"}]}

    def prompt(self, sid, text, timeout=900):
        self.turn_gate.wait(5)
        if self.prompt_error:
            raise self.prompt_error
        return {"stopReason": "end_turn"}

    def cancel(self, sid):
        pass

    def close_session(self, sid):
        return {}

    def set_option(self, sid, cid, value):
        return {"configOptions": [{"id": cid, "currentValue": value}]}




KEY = "plx_test_SECRET_key"


@pytest.fixture
def env(monkeypatch, tmp_path):
    # The developer's own PLEXAR_HARNESS_KEY must not leak into these tests.
    monkeypatch.delenv("PLEXAR_HARNESS_KEY", raising=False)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(hm, "_labels_path", lambda: tmp_path / "harness_labels.json")
    monkeypatch.setattr(hm, "_harness_settings", lambda: {"permission_mode": "read-only", "root": ""})
    FakeRuntime.instances.clear()
    ws = tmp_path / "ws"
    ws.mkdir()
    other = tmp_path / "other"
    other.mkdir()
    return str(ws), str(other)


def make(**kw):
    return hm.HarnessManager(runtime_factory=FakeRuntime, **kw)


async def settle(pred, timeout=3.0):
    for _ in range(int(timeout / 0.01)):
        if pred():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never became true")


@pytest.mark.asyncio
async def test_key_missing_refuses_without_spawning(env):
    ws, _ = env
    m = make()
    with pytest.raises(hm.HarnessError) as ei:
        await m.new_session(ws)
    assert ei.value.reason == "key_missing"
    assert FakeRuntime.instances == []


@pytest.mark.asyncio
async def test_env_carries_key_and_mode(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make()
    await m.new_session(ws)
    rt = FakeRuntime.instances[0]
    assert rt.env == {"PLEXAR_HARNESS_KEY": KEY, "DSH_PERMISSION_MODE": "read-only"}
    assert "PLEXAR_API_KEY" not in rt.env and rt.harness_root is None
    await m.stop_all()


@pytest.mark.asyncio
async def test_busy_and_turn_end(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make()
    key, q = m.subscribe(ws)
    sid = (await m.new_session(ws))["session_id"]
    rt = FakeRuntime.instances[0]
    rt.turn_gate.clear()
    await m.prompt(sid, "hello")
    with pytest.raises(hm.SessionBusy):
        await m.prompt(sid, "again")
    rt.turn_gate.set()
    frame = await asyncio.wait_for(q.get(), 3)
    assert frame == {"type": "turn_end", "session_id": sid, "stop_reason": "end_turn", "error": None}
    rt.prompt_error = hm.HarnessError("session/prompt: engine_unavailable")
    await m.prompt(sid, "x")
    frame = await asyncio.wait_for(q.get(), 3)
    assert frame["error"] == "session/prompt: engine_unavailable" and frame["stop_reason"] is None
    m.unsubscribe(key, q)
    await m.stop_all()


@pytest.mark.asyncio
async def test_unknown_session(env):
    m = make()
    with pytest.raises(hm.UnknownSession):
        await m.prompt("nope", "x")


@pytest.mark.asyncio
async def test_permission_allow_and_timeout_reject(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make(permission_timeout=0.3)
    key, q = m.subscribe(ws)
    await m.new_session(ws)
    rt = FakeRuntime.instances[0]
    fut = asyncio.ensure_future(asyncio.to_thread(rt.on_permission, {"sessionId": "s1", "toolCall": {}}))
    frame = await asyncio.wait_for(q.get(), 3)
    assert frame["type"] == "permission" and frame["session_id"] == "s1"
    assert m.answer_permission(frame["request_id"], "allow-once")
    assert await fut == "allow-once"
    assert not m.answer_permission(frame["request_id"], "allow-once")  # expired

    fut = asyncio.ensure_future(asyncio.to_thread(rt.on_permission, {"sessionId": "s1"}))
    await asyncio.wait_for(q.get(), 3)
    assert await fut == "reject-once"
    m.unsubscribe(key, q)
    await m.stop_all()


@pytest.mark.asyncio
async def test_permission_without_subscriber_rejects(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make()
    await m.new_session(ws)
    rt = FakeRuntime.instances[0]
    assert await asyncio.to_thread(rt.on_permission, {"sessionId": "s1"}) == "reject-once"
    await m.stop_all()


@pytest.mark.asyncio
async def test_pump_fans_out_per_workspace(env):
    ws, other = env
    hm.set_key(KEY)
    m = make()
    k1, q1 = m.subscribe(ws)
    k2, q2 = m.subscribe(other)
    await m.new_session(ws)
    await m.new_session(other)
    rt_ws, rt_other = FakeRuntime.instances
    rt_ws.emit("s1")
    frame = await asyncio.wait_for(q1.get(), 3)
    assert frame["type"] == "update" and frame["session_id"] == "s1" and frame["kind"] == "agent_message_chunk"
    await asyncio.sleep(0.05)
    assert q2.empty()
    rt_other.emit("s1", "usage_update", {"used": 1})
    frame = await asyncio.wait_for(q2.get(), 3)
    assert frame["kind"] == "usage_update"
    assert q1.empty()
    await m.stop_all()


@pytest.mark.asyncio
async def test_runtime_exit_broadcasts_and_drops(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make()
    key, q = m.subscribe(ws)
    await m.new_session(ws)
    rt = FakeRuntime.instances[0]
    rt.stderr_tail = ["plexar-harness: error key_rejected: the rig said 401"]
    rt.q.put(None)
    frame = await asyncio.wait_for(q.get(), 3)
    assert frame["type"] == "runtime_error" and frame["reason"] == "key_rejected"
    assert KEY not in str(frame)
    await settle(lambda: key not in m._runtimes)
    await m.new_session(ws)  # next use restarts
    assert len(FakeRuntime.instances) == 2
    await m.stop_all()


@pytest.mark.asyncio
async def test_intentional_stop_does_not_broadcast(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make()
    key, q = m.subscribe(ws)
    await m.new_session(ws)
    await m.stop_all()
    await asyncio.sleep(0.1)
    assert q.empty() and FakeRuntime.instances[0].stopped


@pytest.mark.asyncio
async def test_idle_stop_after_last_subscriber(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make(idle_stop_after=0.05)
    key, q = m.subscribe(ws)
    await m.new_session(ws)
    m.unsubscribe(key, q)
    await settle(lambda: FakeRuntime.instances[0].stopped)


@pytest.mark.asyncio
async def test_list_union_open_with_labels(env):
    ws, _ = env
    hm.set_key(KEY)
    m = make()
    new = await m.new_session(ws, label="My chat")
    FakeRuntime.instances[0].listed = [{"sessionId": "old-1"}, {"sessionId": "old-2"}]
    rows = await m.list_sessions(ws)
    ids = [r["session_id"] for r in rows]
    assert set(ids) == {new["session_id"], "old-1", "old-2"}
    mine = next(r for r in rows if r["session_id"] == new["session_id"])
    assert mine["open"] is True and mine["label"] == "My chat" and mine["busy"] is False
    await m.stop_all()


def test_labels_round_trip(env):
    hm.write_label("abc", "First")
    hm.write_label("def", "Second")
    assert hm.read_labels() == {"abc": "First", "def": "Second"}
    hm.write_label("abc", None)
    assert hm.read_labels() == {"def": "Second"}


def test_key_is_stored_in_config_not_settings(env):
    hm.set_key(KEY)
    assert settings_store._read_config()[hm.KEY_FIELD] == KEY
    assert hm.get_key() == KEY
    hm.clear_key()
    assert hm.get_key() is None


def test_node_ok():
    assert hm.node_ok("v22.19.0") and hm.node_ok("v24.1.0")
    assert not hm.node_ok("v22.18.9") and not hm.node_ok(None)


def test_key_falls_back_to_environment_and_settings_wins(env, monkeypatch):
    assert hm.key_source() is None and hm.get_key() is None
    monkeypatch.setenv("PLEXAR_HARNESS_KEY", "env-key")
    assert hm.key_source() == "environment" and hm.get_key() == "env-key"
    hm.set_key("saved-key")
    assert hm.key_source() == "settings" and hm.get_key() == "saved-key"
    hm.clear_key()
    assert hm.key_source() == "environment"

