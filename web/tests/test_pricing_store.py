"""Tests for web/pricing_store.py -- the append-only price history that makes
Cockpit's historical cost figures immutable.

The load-bearing test in here is
``test_price_change_does_not_move_an_old_timestamps_price``: it is the direct
proof that appending a new price cannot re-price the past.
"""

from __future__ import annotations

import json
import urllib.error

import pytest

import logging_config
logging_config.setup("CRITICAL")

import pricing_store as ps
from pricing_store import EPOCH, PricingStore, parse_openrouter_models, per_mtok


OLD = "2026-01-01T00:00:00+00:00"
MID = "2026-06-01T00:00:00+00:00"
NEW = "2026-07-01T00:00:00+00:00"


@pytest.fixture()
def store(tmp_path):
    s = PricingStore(db_path=tmp_path / "pricing.sqlite3")
    yield s
    s.close()


def _row(model, inp=3.0, out=15.0, cache_read=None, cache_write=None, provider="test"):
    return {
        "model": model,
        "provider": provider,
        "input_per_mtok": inp,
        "output_per_mtok": out,
        "cache_read_per_mtok": cache_read,
        "cache_write_per_mtok": cache_write,
    }


def _openrouter_payload(entries):
    return {"data": entries}


# -- append-only / no-churn ------------------------------------------------


def test_unchanged_price_on_second_poll_writes_no_row(store):
    rows = [_row("vendor/a", 3.0, 15.0), _row("vendor/b", 1.0, 2.0)]
    assert store.record_snapshot(rows, "openrouter", OLD) == 2
    # Same prices, later poll -> nothing appended. Without this, a daily poll
    # over ~1000 OpenRouter models would grow the table forever.
    assert store.record_snapshot(rows, "openrouter", NEW) == 0
    assert store.count_rows() == 2


def test_changed_price_appends_instead_of_updating(store):
    store.record_snapshot([_row("vendor/a", 3.0, 15.0)], "openrouter", OLD)
    store.record_snapshot([_row("vendor/a", 6.0, 30.0)], "openrouter", NEW)
    history = store.price_history("vendor/a")
    assert len(history) == 2, "a price change must APPEND, never overwrite"
    assert [h["effective_from"] for h in history] == [OLD, NEW]
    assert [h["input_per_mtok"] for h in history] == [3.0, 6.0]


def test_price_change_does_not_move_an_old_timestamps_price(store):
    """THE anti-retroactive guarantee.

    A price recorded later must not change what an earlier timestamp resolves
    to. This is what stops last month's spend from silently re-pricing.
    """
    store.record_snapshot([_row("vendor/a", 3.0, 15.0)], "openrouter", OLD)

    before = store.price_for("vendor/a", MID)
    assert before["input_per_mtok"] == 3.0

    store.record_snapshot([_row("vendor/a", 99.0, 999.0)], "openrouter", NEW)

    # Same query, after the change: still the OLD price.
    after = store.price_for("vendor/a", MID)
    assert after["input_per_mtok"] == 3.0
    assert after["output_per_mtok"] == 15.0
    assert after["effective_from"] == OLD

    # And a timestamp after the change gets the NEW price.
    later = store.price_for("vendor/a", "2026-08-01T00:00:00+00:00")
    assert later["input_per_mtok"] == 99.0
    assert later["effective_from"] == NEW


def test_price_for_returns_none_before_any_snapshot(store):
    store.record_snapshot([_row("vendor/a")], "openrouter", NEW)
    assert store.price_for("vendor/a", OLD) is None


def test_price_for_unknown_model_is_none(store):
    assert store.price_for("nobody/knows-me", NEW) is None
    assert store.price_for("", NEW) is None


def test_none_to_zero_is_treated_as_a_change(store):
    """None (unknown) and 0.0 (free) are different facts, so the transition
    between them must append a row rather than be swallowed as 'unchanged'."""
    store.record_snapshot([_row("vendor/a", None, 15.0)], "openrouter", OLD)
    assert store.record_snapshot([_row("vendor/a", 0.0, 15.0)], "openrouter", NEW) == 1
    assert store.price_for("vendor/a", NEW)["input_per_mtok"] == 0.0


def test_prefix_fallback_resolves_anthropic_family_ids(store):
    store.record_snapshot([_row("claude-opus", 5.0, 25.0)], "default", EPOCH)
    store.record_snapshot([_row("claude-opus-4-mini", 1.0, 2.0)], "default", EPOCH)
    # Longest matching prefix wins, mirroring usage_tracker._pricing_for.
    assert store.price_for("claude-opus-4-mini-20260101", NEW)["input_per_mtok"] == 1.0
    assert store.price_for("claude-opus-4-20260101", NEW)["input_per_mtok"] == 5.0


def test_latest_prices_returns_one_current_row_per_model(store):
    store.record_snapshot([_row("vendor/a", 3.0, 15.0), _row("vendor/b", 1.0, 2.0)], "openrouter", OLD)
    store.record_snapshot([_row("vendor/a", 6.0, 30.0)], "openrouter", NEW)
    latest = {r["model"]: r for r in store.latest_prices()}
    assert set(latest) == {"vendor/a", "vendor/b"}
    assert latest["vendor/a"]["input_per_mtok"] == 6.0
    assert latest["vendor/a"]["effective_from"] == NEW
    assert latest["vendor/b"]["input_per_mtok"] == 1.0


def test_seed_is_effective_from_epoch_and_idempotent(store):
    assert store.seed([_row("claude-opus", 5.0, 25.0)], "default") == 1
    assert store.price_for("claude-opus", "1999-01-01T00:00:00+00:00")["input_per_mtok"] == 5.0
    assert store.seed([_row("claude-opus", 5.0, 25.0)], "default") == 0


# -- per-token -> per-Mtok conversion, free vs missing ---------------------


def test_per_mtok_converts_per_token_strings():
    assert per_mtok("0.000003") == pytest.approx(3.0)
    assert per_mtok("0.000015") == pytest.approx(15.0)
    assert per_mtok(0.000003) == pytest.approx(3.0)


def test_per_mtok_zero_string_is_free_not_unknown():
    assert per_mtok("0") == 0.0
    assert per_mtok("0.0") == 0.0


def test_per_mtok_missing_or_unparsable_is_none_not_zero():
    # A missing price must NOT become 0.0 -- that would hide real money.
    assert per_mtok(None) is None
    assert per_mtok("") is None
    assert per_mtok("   ") is None
    assert per_mtok("not-a-number") is None
    assert per_mtok("-1") is None  # OpenRouter's "variable pricing" sentinel
    assert per_mtok(True) is None


def test_parse_distinguishes_free_from_missing():
    rows = parse_openrouter_models(_openrouter_payload([
        {"id": "free/model", "pricing": {"prompt": "0", "completion": "0"}},
        {"id": "partial/model", "pricing": {"prompt": "0.000002"}},
    ]))
    by_id = {r["model"]: r for r in rows}
    assert by_id["free/model"]["input_per_mtok"] == 0.0
    assert by_id["free/model"]["output_per_mtok"] == 0.0
    assert by_id["partial/model"]["input_per_mtok"] == pytest.approx(2.0)
    assert by_id["partial/model"]["output_per_mtok"] is None


def test_parse_reads_cache_rates_when_published():
    rows = parse_openrouter_models(_openrouter_payload([
        {"id": "v/m", "pricing": {
            "prompt": "0.000003", "completion": "0.000015",
            "input_cache_read": "0.0000003", "input_cache_write": "0.00000375",
        }},
    ]))
    assert rows[0]["cache_read_per_mtok"] == pytest.approx(0.3)
    assert rows[0]["cache_write_per_mtok"] == pytest.approx(3.75)


def test_parse_derives_provider_from_model_id():
    rows = parse_openrouter_models(_openrouter_payload([
        {"id": "deepseek/deepseek-v4-pro", "pricing": {"prompt": "0.000001"}},
        {"id": "bare-model", "pricing": {"prompt": "0.000001"}},
    ]))
    by_id = {r["model"]: r for r in rows}
    assert by_id["deepseek/deepseek-v4-pro"]["provider"] == "deepseek"
    assert by_id["bare-model"]["provider"] == "openrouter"


def test_parse_skips_junk_without_dropping_siblings():
    rows = parse_openrouter_models(_openrouter_payload([
        "not-a-dict",
        {"no_id": True, "pricing": {"prompt": "0.000001"}},
        {"id": "", "pricing": {"prompt": "0.000001"}},
        {"id": "no/pricing/at/all"},                       # nothing known -> skipped
        {"id": "good/model", "pricing": {"prompt": "0.000004"}},
    ]))
    assert [r["model"] for r in rows] == ["good/model"]


def test_parse_rejects_wrong_shaped_payloads():
    assert parse_openrouter_models(None) == []
    assert parse_openrouter_models({}) == []
    assert parse_openrouter_models({"data": "nope"}) == []
    assert parse_openrouter_models([{"id": "a/b"}]) == []


# -- the refresh: failures change nothing ---------------------------------


def test_refresh_records_prices_from_openrouter(store, monkeypatch):
    monkeypatch.setattr(PricingStore, "_fetch_openrouter", lambda self: _openrouter_payload([
        {"id": "vendor/a", "pricing": {"prompt": "0.000003", "completion": "0.000015"}},
    ]))
    result = store.refresh_openrouter(NEW)
    assert result["ok"] is True
    assert result["models_seen"] == 1
    assert result["rows_written"] == 1
    assert store.price_for("vendor/a", NEW)["input_per_mtok"] == pytest.approx(3.0)
    assert store.last_refresh(ps.SOURCE_OPENROUTER) == NEW


def test_refresh_second_time_unchanged_writes_no_rows_but_updates_last_refresh(store, monkeypatch):
    payload = _openrouter_payload([
        {"id": "vendor/a", "pricing": {"prompt": "0.000003", "completion": "0.000015"}},
    ])
    monkeypatch.setattr(PricingStore, "_fetch_openrouter", lambda self: payload)
    store.refresh_openrouter(OLD)
    second = store.refresh_openrouter(NEW)
    assert second["ok"] is True
    assert second["rows_written"] == 0
    assert store.count_rows() == 1
    # last_refresh must still advance, or we would re-poll on every startup.
    assert store.last_refresh(ps.SOURCE_OPENROUTER) == NEW


def test_network_failure_changes_nothing_and_does_not_raise(store, monkeypatch):
    store.record_snapshot([_row("vendor/a", 3.0, 15.0)], "openrouter", OLD)

    def _boom(self):
        raise urllib.error.URLError("no route to host")

    monkeypatch.setattr(PricingStore, "_fetch_openrouter", _boom)
    result = store.refresh_openrouter(NEW)
    assert result["ok"] is False
    assert result["rows_written"] == 0
    assert store.count_rows() == 1
    assert store.price_for("vendor/a", NEW)["input_per_mtok"] == 3.0
    assert store.last_refresh(ps.SOURCE_OPENROUTER) is None


def test_malformed_json_body_changes_nothing_and_does_not_raise(store, monkeypatch):
    def _bad_json(self):
        raise json.JSONDecodeError("bad", "<<<", 0)

    monkeypatch.setattr(PricingStore, "_fetch_openrouter", _bad_json)
    assert store.refresh_openrouter(NEW)["ok"] is False
    assert store.count_rows() == 0


def test_unexpected_shape_changes_nothing_and_does_not_raise(store, monkeypatch):
    monkeypatch.setattr(PricingStore, "_fetch_openrouter", lambda self: {"error": "nope"})
    result = store.refresh_openrouter(NEW)
    assert result["ok"] is False
    assert result["rows_written"] == 0
    assert store.count_rows() == 0
    assert store.last_refresh(ps.SOURCE_OPENROUTER) is None


def test_unexpected_exception_is_swallowed(store, monkeypatch):
    def _explode(self):
        raise RuntimeError("something truly unexpected")

    monkeypatch.setattr(PricingStore, "_fetch_openrouter", _explode)
    assert store.refresh_openrouter(NEW)["ok"] is False
    assert store.count_rows() == 0


def test_refresh_works_without_an_openrouter_key(store, monkeypatch):
    """The models endpoint is public -- a missing key must not stop the poll."""
    import settings_store

    monkeypatch.setattr(settings_store, "resolve_openrouter_key", lambda: (None, None))
    captured = {}

    class _Resp:
        def read(self):
            return json.dumps(_openrouter_payload([
                {"id": "vendor/a", "pricing": {"prompt": "0.000003"}},
            ])).encode("utf-8")

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _urlopen(req, timeout=None):
        captured["headers"] = dict(req.headers)
        return _Resp()

    monkeypatch.setattr(ps.urllib.request, "urlopen", _urlopen)
    assert store.refresh_openrouter(NEW)["ok"] is True
    assert not any(k.lower() == "authorization" for k in captured["headers"])


def test_refresh_sends_key_when_configured(store, monkeypatch):
    import settings_store

    monkeypatch.setattr(settings_store, "resolve_openrouter_key", lambda: ("sk-or-v1-abc", "ui"))
    captured = {}

    class _Resp:
        def read(self):
            return json.dumps(_openrouter_payload([
                {"id": "vendor/a", "pricing": {"prompt": "0.000003"}},
            ])).encode("utf-8")

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _urlopen(req, timeout=None):
        captured["headers"] = {k.lower(): v for k, v in req.headers.items()}
        return _Resp()

    monkeypatch.setattr(ps.urllib.request, "urlopen", _urlopen)
    store.refresh_openrouter(NEW)
    assert captured["headers"]["Authorization".lower()] == "Bearer sk-or-v1-abc"


# -- cadence ---------------------------------------------------------------


def test_refresh_due_on_a_fresh_store(store):
    assert store.refresh_due() is True


def test_refresh_is_skipped_when_last_refresh_is_recent(store, monkeypatch):
    from datetime import datetime, timedelta, timezone

    monkeypatch.setenv("COCKPIT_PRICING_REFRESH_HOURS", "24")
    recent = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    store.mark_refresh(ps.SOURCE_OPENROUTER, at_iso=recent, ok=True)
    assert store.refresh_due() is False


def test_refresh_becomes_due_once_the_cadence_elapses(store, monkeypatch):
    from datetime import datetime, timedelta, timezone

    monkeypatch.setenv("COCKPIT_PRICING_REFRESH_HOURS", "24")
    stale = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat()
    store.mark_refresh(ps.SOURCE_OPENROUTER, at_iso=stale, ok=True)
    assert store.refresh_due() is True


def test_failed_refresh_leaves_the_poll_due(store, monkeypatch):
    from datetime import datetime, timezone

    monkeypatch.setenv("COCKPIT_PRICING_REFRESH_HOURS", "24")
    store.mark_refresh(
        ps.SOURCE_OPENROUTER, at_iso=datetime.now(timezone.utc).isoformat(),
        ok=False, error="boom",
    )
    assert store.refresh_due() is True


def test_refresh_hours_env_parsing(monkeypatch):
    monkeypatch.setenv("COCKPIT_PRICING_REFRESH_HOURS", "6")
    assert ps.refresh_hours() == 6.0
    monkeypatch.setenv("COCKPIT_PRICING_REFRESH_HOURS", "nonsense")
    assert ps.refresh_hours() == 24.0
    monkeypatch.setenv("COCKPIT_PRICING_REFRESH_HOURS", "0")
    assert ps.refresh_hours() == 24.0
    monkeypatch.delenv("COCKPIT_PRICING_REFRESH_HOURS")
    assert ps.refresh_hours() == 24.0


def test_unparsable_last_refresh_is_treated_as_due(store):
    store.mark_refresh(ps.SOURCE_OPENROUTER, at_iso="not-a-timestamp", ok=True)
    assert store.refresh_due() is True


# -- seeds / corruption discipline ----------------------------------------


def test_json_seed_rows_read_the_checked_in_file():
    rows = ps.load_json_seed_rows()
    assert rows, "pricing_models.json should yield seed rows"
    by_id = {r["model"]: r for r in rows}
    assert by_id["opus"]["input_per_mtok"] == 5.0
    assert by_id["opus"]["cache_read_per_mtok"] is None


def test_json_seed_rows_never_raise_on_bad_file(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert ps.load_json_seed_rows(bad) == []
    assert ps.load_json_seed_rows(tmp_path / "missing.json") == []
    weird = tmp_path / "weird.json"
    weird.write_text('{"models": "nope"}', encoding="utf-8")
    assert ps.load_json_seed_rows(weird) == []


def test_reopening_the_store_preserves_history(tmp_path):
    path = tmp_path / "pricing.sqlite3"
    s1 = PricingStore(db_path=path)
    s1.record_snapshot([_row("vendor/a", 3.0, 15.0)], "openrouter", OLD)
    s1.record_snapshot([_row("vendor/a", 6.0, 30.0)], "openrouter", NEW)
    s1.close()

    s2 = PricingStore(db_path=path)
    try:
        assert len(s2.price_history("vendor/a")) == 2
        assert s2.price_for("vendor/a", MID)["input_per_mtok"] == 3.0
    finally:
        s2.close()


def test_record_snapshot_ignores_junk_rows(store):
    written = store.record_snapshot(
        ["nope", {"no_model": 1}, {"model": "   "}, _row("vendor/a")], "openrouter", NEW
    )
    assert written == 1
    assert store.count_rows() == 1


def test_record_snapshot_with_no_rows_is_a_noop(store):
    assert store.record_snapshot([], "openrouter", NEW) == 0
    assert store.record_snapshot(None, "openrouter", NEW) == 0


# -- HTTP surface ----------------------------------------------------------


@pytest.fixture()
def client():
    from httpx import ASGITransport, AsyncClient
    from server import app

    return AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420")


@pytest.mark.asyncio
async def test_get_pricing_returns_latest_prices_and_bookkeeping(client, store, monkeypatch):
    import server as server_module

    store.record_snapshot([_row("vendor/a", 3.0, 15.0)], ps.SOURCE_OPENROUTER, OLD)
    store.record_snapshot([_row("vendor/a", 6.0, 30.0)], ps.SOURCE_OPENROUTER, NEW)
    store.mark_refresh(ps.SOURCE_OPENROUTER, at_iso=NEW, ok=True, models_seen=1, rows_written=1)
    monkeypatch.setattr(server_module, "pricing_store", store)

    res = await client.get("/api/pricing")
    assert res.status_code == 200
    data = res.json()
    assert set(data) == {"models", "last_refresh", "next_refresh", "refresh_hours"}
    # Only the CURRENT price per model is returned; older snapshots stay in the
    # DB so historical costs keep resolving to the rate in effect then.
    assert [m["model"] for m in data["models"]] == ["vendor/a"]
    assert data["models"][0]["input_per_mtok"] == 6.0
    assert data["last_refresh"]["openrouter"] == NEW
    assert data["last_refresh"]["json"] is None
    assert data["next_refresh"] is not None
    assert data["refresh_hours"] == 24.0


@pytest.mark.asyncio
async def test_get_pricing_on_empty_store(client, store, monkeypatch):
    import server as server_module

    monkeypatch.setattr(server_module, "pricing_store", store)
    data = (await client.get("/api/pricing")).json()
    assert data["models"] == []
    assert data["last_refresh"] == {"openrouter": None, "json": None}
    assert data["next_refresh"] is None


@pytest.mark.asyncio
async def test_manual_refresh_records_and_reports(client, store, monkeypatch):
    import server as server_module

    monkeypatch.setattr(PricingStore, "_fetch_openrouter", lambda self: _openrouter_payload([
        {"id": "vendor/a", "pricing": {"prompt": "0.000003", "completion": "0.000015"}},
    ]))
    monkeypatch.setattr(server_module, "pricing_store", store)

    data = (await client.post("/api/pricing/refresh")).json()
    assert data["refresh"]["ok"] is True
    assert data["refresh"]["rows_written"] == 1
    assert data["models"][0]["model"] == "vendor/a"


@pytest.mark.asyncio
async def test_manual_refresh_reports_failure_as_200_and_changes_nothing(client, store, monkeypatch):
    import server as server_module

    store.record_snapshot([_row("vendor/a", 3.0, 15.0)], ps.SOURCE_OPENROUTER, OLD)

    def _boom(self):
        raise urllib.error.URLError("offline")

    monkeypatch.setattr(PricingStore, "_fetch_openrouter", _boom)
    monkeypatch.setattr(server_module, "pricing_store", store)

    res = await client.post("/api/pricing/refresh")
    assert res.status_code == 200
    data = res.json()
    assert data["refresh"]["ok"] is False
    assert data["models"][0]["input_per_mtok"] == 3.0
    assert store.count_rows() == 1


@pytest.mark.asyncio
async def test_pricing_refresh_loop_skips_when_not_due(store, monkeypatch):
    """The loop must honour the cadence -- no poll when the last one is recent."""
    import asyncio
    from datetime import datetime, timedelta, timezone

    import server as server_module

    monkeypatch.setenv("COCKPIT_PRICING_REFRESH_HOURS", "24")
    store.mark_refresh(
        ps.SOURCE_OPENROUTER,
        at_iso=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat(),
        ok=True,
    )
    calls = []
    monkeypatch.setattr(PricingStore, "_fetch_openrouter", lambda self: calls.append(1) or {})
    monkeypatch.setattr(server_module, "pricing_store", store)
    monkeypatch.setattr(server_module, "_PRICING_LOOP_TICK_SECONDS", 3600)

    task = asyncio.create_task(server_module._pricing_refresh_loop())
    await asyncio.sleep(0.05)
    task.cancel()
    await task
    assert calls == []


@pytest.mark.asyncio
async def test_pricing_refresh_loop_polls_when_due(store, monkeypatch):
    import asyncio

    import server as server_module

    calls = []

    def _fetch(self):
        calls.append(1)
        return _openrouter_payload([{"id": "vendor/a", "pricing": {"prompt": "0.000003"}}])

    monkeypatch.setattr(PricingStore, "_fetch_openrouter", _fetch)
    monkeypatch.setattr(server_module, "pricing_store", store)
    monkeypatch.setattr(server_module, "_PRICING_LOOP_TICK_SECONDS", 3600)

    task = asyncio.create_task(server_module._pricing_refresh_loop())
    await asyncio.sleep(0.1)
    task.cancel()
    await task
    assert calls == [1]
    assert store.count_rows() == 1
