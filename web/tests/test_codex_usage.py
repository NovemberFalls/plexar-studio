import json
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from codex_usage import CodexUsageReader, discover_rollout, reference_pricing


def usage(inp=100, cached=70, out=10):
    return dict(input_tokens=inp, cached_input_tokens=cached, output_tokens=out,
                reasoning_output_tokens=4, total_tokens=inp + out)


def count(totals=None, last=None, window=1000):
    return {"timestamp": "2026-09-07T00:00:00Z", "type": "event_msg", "payload": {
        "type": "token_count", "info": {"total_token_usage": totals or usage(),
        "last_token_usage": last or usage(), "model_context_window": window}}}


def write(path, *entries):
    with path.open("a", encoding="utf-8") as stream:
        for entry in entries:
            stream.write(json.dumps(entry) + "\n")


def model(name):
    return {"type": "turn_context", "payload": {"model": name}}


def rates(inp=2, out=10, cached=.2):
    return dict(input_per_mtok=inp, output_per_mtok=out, cache_read_per_mtok=cached)


def test_cumulative_snapshots_not_summed_and_last_usage_drives_context(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, model("gpt-fixture"), count(), count(usage(300, 250, 30), usage(200, 180, 20)))
    pricing = Mock()
    pricing.price_for.return_value = rates()
    reader = CodexUsageReader()
    result = reader.read(path, pricing)
    assert result["total_tokens"] == 330
    assert result["cached_input_tokens"] == 250
    assert result["context_tokens"] == 220
    assert result["context_window"] == 1000
    assert result["context_percent"] == 22
    assert result["estimated_cost_usd"] == pytest.approx((50 * 2 + 250 * .2 + 30 * 10) / 1e6)
    assert reader.read(path, pricing) == result
    write(path, count(usage(300, 250, 30), usage(200, 180, 20)))
    assert reader.read(path, pricing)["estimated_cost_usd"] == result["estimated_cost_usd"]


def test_model_switch_prices_only_increment(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, model("old"), count(), model("new"), count(usage(200, 140, 20)))
    pricing = Mock()
    pricing.price_for.side_effect = lambda name, ts: rates(inp=2 if name == "old" else 20)
    result = CodexUsageReader().read(path, pricing)
    assert result["estimated_cost_usd"] == pytest.approx((30*2 + 70*.2 + 10*10 + 30*20 + 70*.2 + 10*10)/1e6)


@pytest.mark.parametrize("rate", [None, {}, rates(cached=None), rates(inp=-1), rates(out=float("nan"))])
def test_unknown_price_does_not_become_zero_or_claude_fallback(tmp_path, rate):
    path = tmp_path / "usage.jsonl"
    write(path, model("unknown"), count(window=None))
    pricing = Mock()
    pricing.price_for.return_value = rate
    result = CodexUsageReader().read(path, pricing)
    assert result["usage_available"]
    assert result["estimated_cost_usd"] is None
    assert result["price_source"] == "unpriced"
    assert result["context_window"] is None
    assert result["context_percent"] is None


def test_partial_lines_complete_on_next_read(tmp_path):
    path = tmp_path / "usage.jsonl"
    encoded = json.dumps(count())
    path.write_text(encoded[:30], encoding="utf-8")
    reader = CodexUsageReader()
    assert reader.read(path)["total_tokens"] is None
    with path.open("a") as stream:
        stream.write(encoded[30:] + "\n")
    assert reader.read(path)["total_tokens"] == 110


def test_corrupt_usage_is_unknown_and_no_conversation_text_retained(tmp_path):
    path = tmp_path / "usage.jsonl"
    broken = usage()
    broken["cached_input_tokens"] = 900
    write(path, {"type": "response_item", "payload": {"text": "PRIVATE-CONVERSATION"}}, count(broken))
    reader = CodexUsageReader()
    assert reader.read(path)["total_tokens"] is None
    assert "PRIVATE-CONVERSATION" not in repr(reader._files)


def test_counter_reset_does_not_create_negative_cost(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, count(), count(usage(10, 0, 1)))
    pricing = Mock()
    pricing.price_for.return_value = rates()
    result = CodexUsageReader().read(path, pricing)
    assert result["total_tokens"] == 11
    assert result["estimated_cost_usd"] is None


def metadata(path, cwd, source="cli", thread_source="user"):
    write(path, {"type": "session_meta", "payload": {"id": path.stem, "cwd": str(cwd),
                                                       "source": source, "thread_source": thread_source}})


def test_binding_ignores_subagents_and_claims_and_refuses_untimed_ambiguity(tmp_path):
    """Ported from the handle-enumeration era (R-194): the same identity rules,
    now proven against real files instead of a mocked `open_files()`."""
    root = tmp_path / "sessions"
    root.mkdir()
    first, other, child = [root / f"rollout-{name}.jsonl" for name in ("owned", "other", "child")]
    metadata(first, tmp_path)
    metadata(child, tmp_path, thread_source="subagent")
    assert discover_rollout(123, str(tmp_path), sessions_root=root) == first
    assert discover_rollout(123, str(tmp_path), claimed_paths=[first], sessions_root=root) is None
    metadata(other, tmp_path)
    assert discover_rollout(123, str(tmp_path), sessions_root=root) is None


def test_binding_excludes_wrong_cwd_external_path_and_unreadable_root(tmp_path):
    root = tmp_path / "sessions"
    root.mkdir()
    foreign = tmp_path / "rollout-external.jsonl"   # outside the sessions root
    wrong = root / "rollout-wrong.jsonl"            # a different working directory
    metadata(foreign, tmp_path)
    metadata(wrong, root)
    assert discover_rollout(123, str(tmp_path), sessions_root=root) is None
    assert discover_rollout(123, str(tmp_path), sessions_root=tmp_path / "absent") is None
    assert discover_rollout(0, str(tmp_path), sessions_root=root) is None


def test_reference_prices_include_long_context_and_cache_write(tmp_path):
    path = tmp_path / "usage.jsonl"
    totals = usage(300000, 100000, 100)
    totals["cache_write_input_tokens"] = 50000
    write(path, model("gpt-6-astra"), count(totals))
    result = CodexUsageReader().read(path, reference_pricing())
    assert result["estimated_cost_usd"] == pytest.approx((150000*20 + 100000*2 + 50000*25 + 100*75)/1e6)
    assert reference_pricing().price_for("gpt-unknown", "2026-09-07") is None


def test_persistent_events_dedupe_after_resume_and_preserve_models(tmp_path):
    from usage_tracker import UsageTracker
    path = tmp_path / "rollout.jsonl"
    write(path, {"type": "session_meta", "payload": {"id": "native-id"}},
          model("gpt-6-astra"), count(), model("gpt-5.6-terra"), count(usage(200, 140, 20)))
    reader = CodexUsageReader()
    reader.read(path, reference_pricing())
    events = reader.take_events(path)
    assert len(events) == 2
    assert reader.take_events(path) == []
    reader.restore_events(path, events)
    assert reader.take_events(path) == events
    store = UsageTracker(db_path=tmp_path / "usage.sqlite3")
    try:
        assert store.ingest_codex_events("original-pane", str(path), events, "cwd") == 2
        assert store.ingest_codex_events("resumed-pane", "moved-rollout.jsonl", events, "cwd") == 0
        rows = store._conn.execute("SELECT * FROM usage_events ORDER BY id").fetchall()
        assert [row["model"] for row in rows] == ["gpt-6-astra", "gpt-5.6-terra"]
        assert all(row["terminal_id"] == "original-pane" for row in rows)
        assert sum(row["input_tokens"] + row["output_tokens"] + row["cache_read_tokens"] for row in rows) == 220
        assert sum(row["cost_usd"] for row in rows) == pytest.approx((30*10+70*1+10*50+30*2+70*.2+10*12)/1e6)
        assert all(row["price_source"] == "backfill" for row in rows)
    finally:
        store.close()


def test_unknown_cost_and_malformed_events_never_get_default_pricing(tmp_path):
    from usage_tracker import UsageTracker
    store = UsageTracker(db_path=tmp_path / "usage.sqlite3")
    event = dict(session_id="native", uuid="codex:native:1", timestamp="2026-09-07T00:00:00Z",
                 model="unpriced", input_tokens=10, output_tokens=1, cache_read_tokens=0,
                 cache_creation_tokens=0, estimated_cost_usd=None)
    try:
        assert store.ingest_codex_events("t", "path", [event, {**event, "uuid": "bad"}, {**event, "input_tokens": -1}]) == 1
        row = store._conn.execute("SELECT * FROM usage_events").fetchone()
        assert row["price_source"] == "unpriced"
        assert row["cost_usd"] == 0
    finally:
        store.close()


def record(response, values):
    return {"timestamp": "2026-09-07T00:00:00Z", "type": "token_usage_record",
            "payload": {"thread_id": "native-id", "response_id": response, "usage": values}}


def test_response_records_survive_snapshot_reset_and_preserve_models(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, {"type": "session_meta", "payload": {"id": "native-id", "cli_version": "0.153.0"}},
          model("gpt-6-astra"), record("first", usage()), count(),
          model("gpt-5.6-terra"), record("second", usage(20, 0, 5)), count(usage(20, 0, 5), usage(20, 0, 5)))
    reader = CodexUsageReader()
    result = reader.read(path, reference_pricing())
    assert result["total_tokens"] == 135
    assert result["context_tokens"] == 25
    assert result["estimated_cost_usd"] == pytest.approx((30*10+70*1+10*50+20*2+5*12)/1e6)
    events = reader.take_events(path)
    assert len(events) == 2
    assert all(":response:" in event["uuid"] for event in events)
    write(path, record("second", usage(20, 0, 5)))
    assert reader.read(path, reference_pricing())["total_tokens"] == 135
    assert reader.take_events(path) == []


def test_current_cli_snapshots_are_not_persisted_before_first_response(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, {"type": "session_meta", "payload": {"id": "native-id", "cli_version": "0.153.4"}},
          model("gpt-6-astra"), count())
    reader = CodexUsageReader()
    reader.read(path, reference_pricing())
    assert reader.take_events(path) == []
    write(path, record("first", usage()))
    assert reader.read(path, reference_pricing())["total_tokens"] == 110
    assert len(reader.take_events(path)) == 1


def test_compaction_clears_stale_context_until_native_measurement(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, count(), {"type": "compacted", "payload": {}})
    result = CodexUsageReader().read(path)
    assert result["context_tokens"] is None
    assert result["context_percent"] is None


def quota(identifier="codex", percent=28, minutes=10080, reset=4102444800):
    return {"timestamp": "2026-09-07T20:00:00Z", "type": "event_msg", "payload": {
        "type": "token_count", "info": None, "rate_limits": {"limit_id": identifier,
        "primary": {"used_percent": percent, "window_minutes": minutes, "resets_at": reset},
        "secondary": None}}}


def test_subscription_native_week_window_works_without_usage_info(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, quota())
    value = CodexUsageReader().read(path)["subscription_limits"]
    assert value["available"]
    assert value["limits"] == [{"kind": "codex:primary", "label": "Codex · 7 days", "percent": 28,
                                "resets_at": "2100-01-01T00:00:00+00:00", "severity": "normal"}]
    assert value["observed_at"] == "2026-09-07T20:00:00Z"
    assert "Observed" in value["detail"]


def test_subscription_snapshots_preserve_distinct_limit_ids_and_update_same_id(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, quota(), quota("gpt-fixture", 80, 300), quota(percent=40))
    limits = CodexUsageReader().read(path)["subscription_limits"]["limits"]
    assert [(limit["kind"], limit["percent"]) for limit in limits] == [("codex:primary", 40), ("gpt-fixture:primary", 80)]
    assert limits[1]["label"] == "gpt-fixture · 5 hours"
    assert limits[1]["severity"] == "warning"


@pytest.mark.parametrize("entry", [count(), quota(percent=None), quota(percent=-1), quota(percent=True), quota(minutes=0)])
def test_absent_or_invalid_limits_never_become_zero(tmp_path, entry):
    path = tmp_path / "usage.jsonl"
    write(path, entry)
    value = CodexUsageReader().read(path)["subscription_limits"]
    assert not value["available"]
    assert value["limits"] == []


def test_expired_subscription_observation_is_unavailable(tmp_path):
    path = tmp_path / "usage.jsonl"
    write(path, quota(reset=1))
    value = CodexUsageReader().read(path)["subscription_limits"]
    assert not value["available"]
    assert "Expired" in value["detail"]
