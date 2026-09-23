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
    # Set by a test before creating a session to make new_session() return a
    # specific configOptions payload (e.g. the real captured fixture shape),
    # instead of the trivial {"id": "model"} placeholder.
    instances_pending_config: list | None = None

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
        self.set_option_calls: list[tuple[str, str, str]] = []
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
        config = FakeRuntime.instances_pending_config
        if config is None:
            config = [{"id": "model"}]
        return {"sessionId": f"s{self.n}", "configOptions": config}

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
        self.set_option_calls.append((sid, cid, value))
        config = FakeRuntime.instances_pending_config
        if config is None:
            return {"configOptions": [{"id": cid, "currentValue": value}]}
        return {"configOptions": config}




KEY = "plx_test_SECRET_key"


@pytest.fixture
def env(monkeypatch, tmp_path):
    # The developer's own PLEXAR_HARNESS_KEY must not leak into these tests.
    monkeypatch.delenv("PLEXAR_HARNESS_KEY", raising=False)
    monkeypatch.delenv("COCKPIT_PLEXAR_URL", raising=False)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(hm, "_labels_path", lambda: tmp_path / "harness_labels.json")
    monkeypatch.setattr(hm, "_models_cache_path", lambda: tmp_path / "harness_models_cache.json")
    monkeypatch.setattr(hm, "_harness_settings", lambda: {"permission_mode": "read-only", "root": ""})
    FakeRuntime.instances.clear()
    FakeRuntime.instances_pending_config = None
    monkeypatch.setattr(hm, "_last_config_options", None)
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
    # No harness.rig_url and no stored Plexar provider base_url -> tier 2's
    # own fallback (settings_store.resolve_plexar_base_url's loopback
    # default) resolves, so PLEXAR_RIG_URL IS set here, sourced "plexar_provider".
    assert rt.env == {
        "PLEXAR_HARNESS_KEY": KEY, "DSH_PERMISSION_MODE": "read-only",
        "PLEXAR_RIG_URL": "http://127.0.0.1:8760",
    }
    assert "PLEXAR_API_KEY" not in rt.env and rt.harness_root is None
    await m.stop_all()


@pytest.mark.asyncio
async def test_rig_url_source_plexar_provider(env, monkeypatch):
    ws, _ = env
    hm.set_key(KEY)
    monkeypatch.setattr(settings_store, "read_settings",
                        lambda: {"providers": {"plexar": {"base_url": "https://plexar-llm.example.com"}}})
    m = make()
    await m.new_session(ws)
    rt = FakeRuntime.instances[0]
    assert rt.env["PLEXAR_RIG_URL"] == "https://plexar-llm.example.com"
    await m.stop_all()


def test_resolve_rig_url_harness_default_when_provider_url_empty(env, monkeypatch):
    monkeypatch.setattr(settings_store, "resolve_plexar_base_url", lambda: "")
    url, source = hm.resolve_rig_url({"rig_url": ""})
    assert url is None and source == "harness_default"


def test_resolve_rig_url_tiers(env, monkeypatch):
    monkeypatch.setattr(settings_store, "resolve_plexar_base_url", lambda: "http://127.0.0.1:8760")
    # Tier 1: explicit harness.rig_url wins.
    assert hm.resolve_rig_url({"rig_url": "https://explicit.example.com"}) == \
        ("https://explicit.example.com", "harness")
    # Tier 2: falls back to the resolved Plexar provider address.
    assert hm.resolve_rig_url({"rig_url": ""}) == ("http://127.0.0.1:8760", "plexar_provider")


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


@pytest.mark.asyncio
async def test_rig_url_passed_when_set(env, monkeypatch):
    ws, _ = env
    hm.set_key(KEY)
    monkeypatch.setattr(hm, "_harness_settings",
                        lambda: {"permission_mode": "read-only", "root": "", "rig_url": "https://rig.example.com"})
    m = make()
    await m.new_session(ws)
    rt = FakeRuntime.instances[0]
    assert rt.env["PLEXAR_RIG_URL"] == "https://rig.example.com"
    await m.stop_all()


@pytest.mark.asyncio
async def test_bad_rig_url_refuses_gracefully(env, monkeypatch):
    ws, _ = env
    hm.set_key(KEY)
    monkeypatch.setattr(hm, "_harness_settings",
                        lambda: {"permission_mode": "read-only", "root": "", "rig_url": "not-a-url"})
    m = make()
    with pytest.raises(hm.HarnessError) as ei:
        await m.new_session(ws)
    assert ei.value.reason == "bad_rig_url"
    assert FakeRuntime.instances == []
    assert "The Plexar Harness rig URL" in hm.friendly(ei.value.reason)


@pytest.mark.asyncio
async def test_running_runtime_restarts_when_setting_changes(env, monkeypatch):
    ws, _ = env
    hm.set_key(KEY)
    settings = {"permission_mode": "read-only", "root": "", "rig_url": ""}
    monkeypatch.setattr(hm, "_harness_settings", lambda: dict(settings))
    m = make()
    await m.new_session(ws)
    assert len(FakeRuntime.instances) == 1
    # No prompt in flight -> the next ensure_runtime call restarts it.
    settings["rig_url"] = "https://new-rig.example.com"
    await m.new_session(ws)
    assert len(FakeRuntime.instances) == 2
    assert FakeRuntime.instances[0].stopped is True
    assert FakeRuntime.instances[1].env["PLEXAR_RIG_URL"] == "https://new-rig.example.com"
    await m.stop_all()


@pytest.mark.asyncio
async def test_running_runtime_keeps_env_while_busy(env, monkeypatch):
    ws, _ = env
    hm.set_key(KEY)
    settings = {"permission_mode": "read-only", "root": "", "rig_url": ""}
    monkeypatch.setattr(hm, "_harness_settings", lambda: dict(settings))
    m = make()
    sid = (await m.new_session(ws))["session_id"]
    rt = FakeRuntime.instances[0]
    rt.turn_gate.clear()
    await m.prompt(sid, "hi")  # busy now
    settings["rig_url"] = "https://new-rig.example.com"
    await m.list_sessions(ws)  # calls ensure_runtime again
    assert len(FakeRuntime.instances) == 1  # not restarted mid-turn
    rt.turn_gate.set()
    await m.stop_all()


def test_parse_models_from_config_options_live_fixture():
    import json as _json
    fixture_path = os.path.join(os.path.dirname(__file__), "fixtures", "harness_config_options_live.json")
    config_options = _json.load(open(fixture_path, encoding="utf-8"))["configOptions"]
    models = hm.parse_models_from_config_options(config_options)
    # "" ("Provider default") is a real effort value and must survive.
    assert models == [{
        "id": "[\"plexar\",\"qwen3.8-27b\"]", "label": "Plexar Qwen", "efforts": ["", "off", "high"],
    }]


def test_parse_models_efforts_null_when_entry_absent():
    models = hm.parse_models_from_config_options(
        [{"id": "model", "options": [{"value": "m1", "name": "M1"}]}])
    assert models == [{"id": "m1", "label": "M1", "efforts": None}]


def test_parse_models_efforts_empty_list_when_entry_present_but_empty():
    models = hm.parse_models_from_config_options([
        {"id": "model", "options": [{"value": "m1", "name": "M1"}]},
        {"id": "reasoning_effort", "options": []},
    ])
    assert models == [{"id": "m1", "label": "M1", "efforts": []}]


def test_list_models_session_source_takes_priority(env, monkeypatch):
    monkeypatch.setattr(hm, "_last_config_options",
                        [{"id": "model", "options": [{"value": "m1", "name": "M1"}]}])
    result = hm.list_models()
    assert result == {"models": [{"id": "m1", "label": "M1", "efforts": None}], "source": "session"}


def test_list_models_none_when_nothing_ever_observed(env, monkeypatch):
    monkeypatch.setattr(hm, "_last_config_options", None)
    result = hm.list_models()
    assert result == {"models": [], "source": "none"}


def test_list_models_no_rig_http_fallback_plexar_signal_never_appears(env, monkeypatch):
    """The dropped `/v1/models` rig fallback used to be the ONLY path that
    could list `plexar-signal` (a classifier, never a selectable chat model).
    With no in-memory or disk-cached configOptions, the answer must be
    "none", never a rig probe -- and there is no `_fetch_rig_models` left to
    monkeypatch, which is itself the regression guard."""
    hm.set_key(KEY)
    monkeypatch.setattr(hm, "_last_config_options", None)
    assert not hasattr(hm, "_fetch_rig_models")
    result = hm.list_models()
    assert result == {"models": [], "source": "none"}


def test_list_models_cache_source_persists_and_survives_process_restart(env, monkeypatch):
    config_options = [{"id": "model", "options": [{"value": "m1", "name": "M1"}]},
                       {"id": "reasoning_effort", "options": [{"value": "off", "name": "Off"}]}]
    hm.record_config_options(config_options)
    # Simulate a process restart: no in-memory cache, only the disk file.
    monkeypatch.setattr(hm, "_last_config_options", None)
    result = hm.list_models()
    assert result == {"models": [{"id": "m1", "label": "M1", "efforts": ["off"]}], "source": "cache"}
    assert hm._models_cache_path().exists()


def test_key_falls_back_to_environment_and_settings_wins(env, monkeypatch):
    assert hm.key_source() is None and hm.get_key() is None
    monkeypatch.setenv("PLEXAR_HARNESS_KEY", "env-key")
    assert hm.key_source() == "environment" and hm.get_key() == "env-key"
    hm.set_key("saved-key")
    assert hm.key_source() == "settings" and hm.get_key() == "saved-key"
    hm.clear_key()
    assert hm.key_source() == "environment"

