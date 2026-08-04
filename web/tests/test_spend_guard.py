"""Tests for the spend guardrails: settings validation, period math, cost-class
split, the three refusal rules, and the two enforcement points.

The load-bearing assertions here are the REFUSALS, not the happy path:

  * ``block.equivalent: true`` under ``mode: "subscription"`` must NOT block,
    however the flag got into settings.json (refusal 1);
  * a real block computed from untrustworthy prices must downgrade to an alert
    (refusal 2);
  * a block switch with a ``None`` cap must be inert, not an error (refusal 3).

A regression in any of those either blocks free work or hard-stops on a number
Cockpit made up, which is the failure mode the whole feature exists to avoid.

Isolation: every DB-touching test builds a UsageTracker on tmp_path (which gets
its own sibling PricingStore automatically) and inserts usage rows with SQL, so
the real ~/.claude-cockpit stores are never read or written. Rows are inserted
directly rather than ingested from JSONL because these tests are about what the
guard does with a frozen cost, not about ingest.
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import bridge_manager as bm_module
import pricing_store as pricing_store_module
import settings_store
import spend_guard
from server import app
from usage_tracker import UsageTracker


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture()
def isolated_settings(tmp_path, monkeypatch):
    """Point settings_store at a throwaway config dir for this test only."""
    config_dir = tmp_path / ".claude-cockpit"
    monkeypatch.setattr(settings_store, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(settings_store, "CONFIG_FILE", config_dir / "config.json")
    monkeypatch.setattr(settings_store, "SETTINGS_FILE", config_dir / "settings.json")
    return config_dir / "settings.json"


@pytest.fixture()
def tracker(tmp_path):
    t = UsageTracker(db_path=tmp_path / "usage.sqlite3")
    yield t
    t.close()


def add_usage(tracker, *, model, cost, ts, price_source="exact", uuid_="u"):
    """Insert one usage_events row with a pre-frozen cost."""
    tracker._conn.execute(
        "INSERT INTO usage_events (terminal_id, jsonl_path, message_uuid, ts, model, "
        "input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, "
        "cost_usd, price_source) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ("term-1", "/tmp/a.jsonl", uuid_, ts, model, 100, 100, 0, 0, cost, price_source),
    )
    tracker._conn.commit()


def add_local_run(tracker, *, ts):
    tracker._conn.execute(
        "INSERT INTO local_runs (ts, terminal_id, workdir, provider_id, model, "
        "input_tokens, output_tokens, wall_ms) VALUES (?,?,?,?,?,?,?,?)",
        (ts, "term-1", "/tmp", "vllm-local", "qwen", 5000, 5000, 100.0),
    )
    tracker._conn.commit()


def give_openrouter_snapshot(tracker):
    """Make ``has_openrouter_snapshot`` true for this tracker's price store."""
    tracker._pricing.record_snapshot(
        [{"model": "deepseek/deepseek-v4-pro", "provider": "deepseek",
          "input_per_mtok": 1.0, "output_per_mtok": 2.0,
          "cache_read_per_mtok": None, "cache_write_per_mtok": None}],
        pricing_store_module.SOURCE_OPENROUTER,
    )


def settings_with(**spend):
    """A full settings blob whose ``spend`` tree is defaults + *spend*."""
    base = {k: (dict(v) if isinstance(v, dict) else v)
            for k, v in settings_store.DEFAULT_SETTINGS["spend"].items()}
    base.update(spend)
    return {"spend": base}


NOW = datetime(2026, 7, 15, 12, 0, 0, tzinfo=timezone.utc)
TS = "2026-07-15T10:00:00+00:00"


# ---------------------------------------------------------------------------
# PART 1 — settings validation (each rejection)
# ---------------------------------------------------------------------------


def test_spend_defaults_shape(isolated_settings):
    s = settings_store.read_settings()["spend"]
    assert s["mode"] == "subscription"
    assert s["period"] == "monthly"
    assert s["monthly_reset_day"] == 1
    assert s["caps"] == {"real_usd": None, "equivalent_usd": None}
    assert s["alert_at_percent"] == 80
    assert s["block"] == {"real": False, "equivalent": False}
    assert s["enforce_on"] == {"bridges": True, "new_sessions": False}


@pytest.mark.parametrize("patch, needle", [
    ({"spend": {"mode": "invoice"}}, "spend.mode"),
    ({"spend": {"mode": 3}}, "spend.mode"),
    ({"spend": {"period": "hourly"}}, "spend.period"),
    ({"spend": {"monthly_reset_day": 0}}, "spend.monthly_reset_day"),
    ({"spend": {"monthly_reset_day": 29}}, "spend.monthly_reset_day"),
    ({"spend": {"alert_at_percent": 0}}, "spend.alert_at_percent"),
    ({"spend": {"alert_at_percent": 101}}, "spend.alert_at_percent"),
    ({"spend": {"caps": {"real_usd": 0}}}, "spend.caps.real_usd"),
    ({"spend": {"caps": {"real_usd": -5}}}, "spend.caps.real_usd"),
    ({"spend": {"caps": {"equivalent_usd": 0}}}, "spend.caps.equivalent_usd"),
    ({"spend": {"caps": {"equivalent_usd": "20"}}}, "spend.caps.equivalent_usd"),
    ({"spend": {"caps": {"equivalent_usd": True}}}, "spend.caps.equivalent_usd"),
    ({"spend": {"block": {"real": "yes"}}}, "spend.block.real"),
    ({"spend": {"enforce_on": {"bridges": 1}}}, "spend.enforce_on.bridges"),
])
def test_spend_validation_rejections(isolated_settings, patch, needle):
    with pytest.raises(ValueError) as exc:
        settings_store.update_settings(patch)
    assert needle in str(exc.value)
    # All-or-nothing: nothing was written.
    assert not isolated_settings.exists()


def test_zero_cap_rejection_message_explains_null(isolated_settings):
    with pytest.raises(ValueError) as exc:
        settings_store.update_settings({"spend": {"caps": {"real_usd": 0}}})
    assert "null" in str(exc.value)


def test_spend_valid_patch_accepted(isolated_settings):
    effective = settings_store.update_settings({"spend": {
        "mode": "api", "period": "weekly", "monthly_reset_day": 28,
        "caps": {"real_usd": 20.5, "equivalent_usd": None},
        "alert_at_percent": 100,
        "block": {"real": True},
        "enforce_on": {"new_sessions": True},
    }})
    s = effective["spend"]
    assert s["mode"] == "api"
    assert s["caps"]["real_usd"] == 20.5
    assert s["caps"]["equivalent_usd"] is None
    assert s["block"] == {"real": True, "equivalent": False}
    assert s["enforce_on"] == {"bridges": True, "new_sessions": True}


# ---------------------------------------------------------------------------
# PART 2a — period math
# ---------------------------------------------------------------------------


def test_period_daily_is_the_utc_day():
    p = spend_guard.resolve_period("daily", 1, NOW)
    assert p["start"].startswith("2026-07-15T00:00:00")
    assert p["end"].startswith("2026-07-16T00:00:00")
    assert "2026-07-15" in p["label"]


def test_period_weekly_is_trailing_seven_days():
    p = spend_guard.resolve_period("weekly", 1, NOW)
    assert p["start"] == (NOW - timedelta(days=7)).isoformat()
    assert p["end"] == NOW.isoformat()


def test_period_monthly_before_reset_day_uses_previous_month():
    """Reset day 20, now the 15th → the period started LAST month."""
    p = spend_guard.resolve_period("monthly", 20, NOW)
    assert p["start"].startswith("2026-06-20T00:00:00")
    assert p["end"].startswith("2026-07-20T00:00:00")
    assert "resets day 20" in p["label"]


def test_period_monthly_on_or_after_reset_day_uses_this_month():
    p = spend_guard.resolve_period("monthly", 10, NOW)
    assert p["start"].startswith("2026-07-10T00:00:00")
    assert p["end"].startswith("2026-08-10T00:00:00")


def test_period_monthly_day_28_in_february():
    """Day 28 is the validated maximum precisely so February can honour it."""
    p = spend_guard.resolve_period("monthly", 28, datetime(2026, 2, 28, 1, 0, tzinfo=timezone.utc))
    assert p["start"].startswith("2026-02-28T00:00:00")
    assert p["end"].startswith("2026-03-28T00:00:00")

    # A day earlier in February, the window reaches back into January.
    p2 = spend_guard.resolve_period("monthly", 28, datetime(2026, 2, 27, 1, 0, tzinfo=timezone.utc))
    assert p2["start"].startswith("2026-01-28T00:00:00")
    assert p2["end"].startswith("2026-02-28T00:00:00")


def test_period_monthly_crosses_the_year_boundary():
    p = spend_guard.resolve_period("monthly", 15, datetime(2026, 1, 5, tzinfo=timezone.utc))
    assert p["start"].startswith("2025-12-15T00:00:00")
    assert p["end"].startswith("2026-01-15T00:00:00")


def test_period_naive_now_is_treated_as_utc():
    p = spend_guard.resolve_period("daily", 1, datetime(2026, 7, 15, 12, 0))
    assert p["start"].startswith("2026-07-15T00:00:00")


# ---------------------------------------------------------------------------
# PART 2b — real vs equivalent classification
# ---------------------------------------------------------------------------


def test_classification_subscription_real_is_openrouter_only(tracker):
    add_usage(tracker, model="deepseek/deepseek-v4-pro", cost=3.0, ts=TS, uuid_="a")
    add_usage(tracker, model="claude-opus-4-1", cost=7.0, ts=TS, uuid_="b")
    add_local_run(tracker, ts=TS)

    period = spend_guard.resolve_period("daily", 1, NOW)
    spend = spend_guard.window_spend(period, "subscription", tracker=tracker)

    assert spend["real"] == 3.0            # OpenRouter is billed today
    assert spend["equivalent"] == 10.0     # includes the subscription Claude turn
    assert spend["local_runs"] == 1
    assert spend["openrouter_events"] == 1


def test_classification_api_mode_counts_anthropic_as_real(tracker):
    add_usage(tracker, model="deepseek/deepseek-v4-pro", cost=3.0, ts=TS, uuid_="a")
    add_usage(tracker, model="claude-opus-4-1", cost=7.0, ts=TS, uuid_="b")

    period = spend_guard.resolve_period("daily", 1, NOW)
    spend = spend_guard.window_spend(period, "api", tracker=tracker)
    assert spend["real"] == 10.0
    assert spend["equivalent"] == 10.0


def test_local_run_alone_counts_toward_neither_class(tracker):
    add_local_run(tracker, ts=TS)
    period = spend_guard.resolve_period("daily", 1, NOW)
    spend = spend_guard.window_spend(period, "api", tracker=tracker)
    assert spend["real"] == 0.0
    assert spend["equivalent"] == 0.0
    assert spend["local_runs"] == 1


def test_rows_outside_the_window_are_excluded(tracker):
    add_usage(tracker, model="deepseek/x", cost=99.0, ts="2026-07-01T00:00:00+00:00", uuid_="old")
    period = spend_guard.resolve_period("daily", 1, NOW)
    spend = spend_guard.window_spend(period, "api", tracker=tracker)
    assert spend["real"] == 0.0


def test_window_spend_survives_a_broken_tracker():
    broken = MagicMock()
    broken._window_rows.side_effect = RuntimeError("db gone")
    spend = spend_guard.window_spend(
        {"start": "a", "end": "b"}, "api", tracker=broken
    )
    assert spend["unavailable"] is True
    assert spend["real"] == 0.0


# ---------------------------------------------------------------------------
# PART 2c — evaluate(): percent, states
# ---------------------------------------------------------------------------


def test_percent_is_null_with_no_cap(tracker):
    add_usage(tracker, model="deepseek/x", cost=5.0, ts=TS)
    result = spend_guard.evaluate(
        now=NOW, settings=settings_with(period="daily"),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["real"]["cap"] is None
    assert result["real"]["percent"] is None      # not 0, not 100
    assert result["equivalent"]["percent"] is None
    assert result["blocking"] is False


def test_alert_state_at_threshold(tracker):
    add_usage(tracker, model="deepseek/x", cost=8.5, ts=TS)
    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(period="daily", caps={"real_usd": 10.0, "equivalent_usd": None}),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["real"]["state"] == "alert"
    assert result["real"]["percent"] == 85.0
    assert result["blocking"] is False           # alert only — no block switch


def test_over_state_without_block_switch_does_not_block(tracker):
    add_usage(tracker, model="deepseek/x", cost=25.0, ts=TS)
    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(period="daily", caps={"real_usd": 10.0, "equivalent_usd": None}),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["real"]["state"] == "over"
    assert result["blocking"] is False


def test_real_block_fires_when_prices_are_trustworthy(tracker):
    give_openrouter_snapshot(tracker)
    add_usage(tracker, model="deepseek/x", cost=25.0, ts=TS, price_source="exact")
    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            period="daily", caps={"real_usd": 10.0, "equivalent_usd": None},
            block={"real": True, "equivalent": False},
        ),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["blocking"] is True
    assert result["enforcement_available"] is True
    assert result["reasons"] and "cap" in result["reasons"][0]


# ---------------------------------------------------------------------------
# REFUSAL 1 — equivalent block is refused under a subscription
# ---------------------------------------------------------------------------


def test_equivalent_block_true_under_subscription_does_not_block(tracker):
    """settings.json can carry the flag from an API-billing period. The server
    refuses independently of the (disabled) UI switch."""
    give_openrouter_snapshot(tracker)
    add_usage(tracker, model="claude-opus-4-1", cost=500.0, ts=TS, price_source="exact")

    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            mode="subscription", period="daily",
            caps={"real_usd": None, "equivalent_usd": 100.0},
            block={"real": False, "equivalent": True},   # explicitly true
        ),
        tracker=tracker, pricing=tracker._pricing,
    )

    assert result["equivalent"]["state"] == "over"       # still reported honestly
    assert result["blocking"] is False                   # but nothing is blocked
    assert result["equivalent"]["enforcement_available"] is False
    assert result["enforcement_available"] is False
    assert any("subscription" in c for c in result["caveats"])


def test_equivalent_block_does_fire_under_api_billing(tracker):
    give_openrouter_snapshot(tracker)
    add_usage(tracker, model="claude-opus-4-1", cost=500.0, ts=TS, price_source="exact")
    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            mode="api", period="daily",
            caps={"real_usd": None, "equivalent_usd": 100.0},
            block={"real": False, "equivalent": True},
        ),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["blocking"] is True


# ---------------------------------------------------------------------------
# REFUSAL 2 — never hard-block on a number we made up
# ---------------------------------------------------------------------------


def _real_block_settings():
    return settings_with(
        period="daily", caps={"real_usd": 10.0, "equivalent_usd": None},
        block={"real": True, "equivalent": False},
    )


def test_real_block_downgrades_when_no_openrouter_snapshot(tracker):
    """The pricing poll may never have run (true on a fresh install)."""
    assert spend_guard.has_openrouter_snapshot(tracker._pricing) is False
    add_usage(tracker, model="deepseek/x", cost=25.0, ts=TS, price_source="exact")

    result = spend_guard.evaluate(
        now=NOW, settings=_real_block_settings(),
        tracker=tracker, pricing=tracker._pricing,
    )

    assert result["real"]["state"] == "over"              # still surfaced
    assert result["blocking"] is False                    # downgraded to alert
    assert result["real"]["enforcement_available"] is False
    assert result["enforcement_available"] is False
    assert any("OpenRouter price snapshot" in c for c in result["caveats"])
    assert any("DOWNGRADED" in c for c in result["caveats"])


def test_real_block_downgrades_when_window_is_predominantly_not_exact(tracker):
    give_openrouter_snapshot(tracker)
    add_usage(tracker, model="deepseek/x", cost=20.0, ts=TS, price_source="backfill", uuid_="a")
    add_usage(tracker, model="deepseek/x", cost=5.0, ts=TS, price_source="unpriced", uuid_="b")
    add_usage(tracker, model="deepseek/x", cost=5.0, ts=TS, price_source="exact", uuid_="c")

    result = spend_guard.evaluate(
        now=NOW, settings=_real_block_settings(),
        tracker=tracker, pricing=tracker._pricing,
    )

    assert result["real"]["state"] == "over"
    assert result["blocking"] is False
    assert any("priced at ingest" in c for c in result["caveats"])


def test_real_block_downgrades_when_exactly_half_are_exact(tracker):
    """A tie is not a majority — the floor is deliberately exclusive."""
    give_openrouter_snapshot(tracker)
    add_usage(tracker, model="deepseek/x", cost=20.0, ts=TS, price_source="exact", uuid_="a")
    add_usage(tracker, model="deepseek/x", cost=20.0, ts=TS, price_source="backfill", uuid_="b")
    result = spend_guard.evaluate(
        now=NOW, settings=_real_block_settings(),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["blocking"] is False


def test_untrusted_pricing_explains_itself_even_under_the_cap(tracker):
    """THE REPORTED DEFECT. Block on, cap $50, spend well under it, no OpenRouter
    snapshot: the class is not enforceable, so a caveat MUST say why. Previously
    the flag went false while the only caveat was about local runs."""
    assert spend_guard.has_openrouter_snapshot(tracker._pricing) is False
    add_usage(tracker, model="deepseek/x", cost=2.0, ts=TS, price_source="exact")
    add_local_run(tracker, ts=TS)

    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            period="daily", caps={"real_usd": 50.0, "equivalent_usd": None},
            block={"real": True, "equivalent": False},
        ),
        tracker=tracker, pricing=tracker._pricing,
    )

    assert result["real"]["state"] == "ok"          # nowhere near the cap
    assert result["blocking"] is False
    assert result["real"]["enforcement_available"] is False
    explaining = [c for c in result["caveats"] if "OpenRouter price snapshot" in c]
    assert explaining, result["caveats"]
    assert any("CANNOT FIRE" in c for c in result["caveats"])
    assert any("price refresh" in c for c in result["caveats"])


def test_no_downgrade_caveat_when_the_block_switch_is_off(tracker):
    """Nothing is configured, so there is nothing to correct — and no marker."""
    add_usage(tracker, model="deepseek/x", cost=2.0, ts=TS, price_source="backfill")
    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            period="daily", caps={"real_usd": 50.0, "equivalent_usd": 50.0},
            block={"real": False, "equivalent": False},
        ),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["real"]["enforcement_available"] is True       # nothing to enforce
    assert result["real"]["pricing_trusted"] is False            # reported, unmarked
    assert not any("CANNOT FIRE" in c for c in result["caveats"])
    assert not any("DOWNGRADED" in c for c in result["caveats"])
    assert result["enforcement_available"] is True


# The invariant, asserted directly rather than case by case: any future branch
# that can set enforcement_available False must bring its own explanation with it.
_CLASS_TOKEN = {"real": "real", "equivalent": "equivalent"}


@pytest.mark.parametrize("mode", ["subscription", "api"])
@pytest.mark.parametrize("block_real", [True, False])
@pytest.mark.parametrize("block_equivalent", [True, False])
@pytest.mark.parametrize("cap", [None, 10.0])
@pytest.mark.parametrize("trusted", [True, False])
@pytest.mark.parametrize("spent", [2.0, 25.0])
def test_invariant_unenforceable_class_always_carries_a_caveat(
    tracker, mode, block_real, block_equivalent, cap, trusted, spent
):
    """For every reachable combination: if a class cannot enforce, some caveat
    names that class. And a False top-level flag never comes with empty caveats."""
    if trusted:
        give_openrouter_snapshot(tracker)
        source = "exact"
    else:
        source = "backfill"
    # Both classes get events: an OpenRouter row (real + equivalent) and a native
    # Anthropic row (equivalent, and real too under api billing).
    add_usage(tracker, model="deepseek/x", cost=spent / 2, ts=TS, price_source=source, uuid_="a")
    add_usage(tracker, model="claude-opus-4-1", cost=spent / 2, ts=TS, price_source=source, uuid_="b")

    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            mode=mode, period="daily",
            caps={"real_usd": cap, "equivalent_usd": cap},
            block={"real": block_real, "equivalent": block_equivalent},
        ),
        tracker=tracker, pricing=tracker._pricing,
    )

    switches = {"real": block_real, "equivalent": block_equivalent}
    for kind, token in _CLASS_TOKEN.items():
        if result[kind]["enforcement_available"] is False:
            assert switches[kind] is True, (
                f"{kind} reported unenforceable with its block switch off — that paints "
                "a NOT ENFORCING marker on a setting the user never made"
            )
            assert any(token in c for c in result["caveats"]), (
                f"{kind} is unenforceable with no caveat naming it: {result['caveats']}"
            )

    if result["enforcement_available"] is False:
        assert result["caveats"], "top-level enforcement_available False with no caveats"

    # A block can only be reported as active when the class is enforceable.
    if result["blocking"]:
        assert result["real"]["enforcement_available"] or result["equivalent"]["enforcement_available"]


# ---------------------------------------------------------------------------
# REFUSAL 3 — a None cap never blocks
# ---------------------------------------------------------------------------


def test_block_true_with_null_cap_does_not_block(tracker):
    give_openrouter_snapshot(tracker)
    add_usage(tracker, model="deepseek/x", cost=9999.0, ts=TS, price_source="exact")
    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            period="daily", caps={"real_usd": None, "equivalent_usd": None},
            block={"real": True, "equivalent": True},
        ),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["blocking"] is False
    assert result["real"]["percent"] is None
    assert any("no real cap is set" in c for c in result["caveats"])


def test_hand_edited_zero_cap_reads_as_no_cap(tracker):
    """Validation rejects 0 on write; a hand-edited file must still be safe."""
    result = spend_guard.evaluate(
        now=NOW,
        settings=settings_with(
            period="daily", caps={"real_usd": 0, "equivalent_usd": -1},
            block={"real": True, "equivalent": True},
        ),
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["real"]["cap"] is None
    assert result["blocking"] is False


def test_garbage_settings_degrade_to_defaults(tracker):
    result = spend_guard.evaluate(
        now=NOW, settings={"spend": "not a dict"},
        tracker=tracker, pricing=tracker._pricing,
    )
    assert result["mode"] == "subscription"
    assert result["blocking"] is False


# ---------------------------------------------------------------------------
# check_start — the enforce_on gate
# ---------------------------------------------------------------------------


def _write_blocking_settings(monkeypatch, tracker, *, bridges=True, new_sessions=False):
    """Make module-level evaluate() see a tripped, trustworthy real cap."""
    give_openrouter_snapshot(tracker)
    add_usage(tracker, model="deepseek/x", cost=25.0, ts=TS, price_source="exact")
    blob = settings_with(
        period="daily", caps={"real_usd": 10.0, "equivalent_usd": None},
        block={"real": True, "equivalent": False},
        enforce_on={"bridges": bridges, "new_sessions": new_sessions},
    )
    monkeypatch.setattr(settings_store, "read_settings", lambda: blob)
    monkeypatch.setattr(spend_guard, "_default_tracker", lambda: tracker)
    monkeypatch.setattr(spend_guard, "_default_pricing", lambda: tracker._pricing)
    return blob


def test_check_start_blocks_bridges_when_enforced(monkeypatch, tracker):
    _write_blocking_settings(monkeypatch, tracker, bridges=True)
    payload = spend_guard.check_start("bridges", now=NOW)
    assert payload is not None
    assert payload["blocking"] is True
    assert spend_guard.block_reason("bridges", now=NOW)


def test_nothing_blocks_when_enforce_on_bridges_is_false(monkeypatch, tracker):
    _write_blocking_settings(monkeypatch, tracker, bridges=False)
    assert spend_guard.check_start("bridges", now=NOW) is None
    assert spend_guard.block_reason("bridges", now=NOW) is None
    # The cap itself has still tripped — only enforcement is opted out of.
    assert spend_guard.evaluate(now=NOW)["blocking"] is True


def test_new_sessions_scope_is_off_by_default(monkeypatch, tracker):
    _write_blocking_settings(monkeypatch, tracker, bridges=True, new_sessions=False)
    assert spend_guard.check_start("new_sessions", now=NOW) is None


def test_check_start_allows_on_unexpected_failure(monkeypatch):
    def boom():
        raise RuntimeError("settings on fire")

    monkeypatch.setattr(spend_guard, "_spend_settings", lambda *a, **k: boom())
    assert spend_guard.check_start("bridges") is None


# ---------------------------------------------------------------------------
# PART 3 — enforcement points
# ---------------------------------------------------------------------------


@pytest.fixture()
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420")


_BLOCKING_PAYLOAD = {
    "period": {"start": "s", "end": "e", "label": "today"},
    "mode": "api",
    "real": {"spent": 25.0, "cap": 10.0, "percent": 250.0, "state": "over",
             "enforcement_available": True},
    "equivalent": {"spent": 25.0, "cap": None, "percent": None, "state": "ok",
                   "enforcement_available": True},
    "blocking": True,
    "reasons": ["Real spend $25.00 has reached the $10.00 cap for today."],
    "enforcement_available": True,
    "caveats": [],
}


@pytest.mark.asyncio
async def test_bridge_auto_refuses_with_409_and_spend_payload(client, monkeypatch):
    monkeypatch.setattr(
        spend_guard, "check_start",
        lambda scope, now=None: _BLOCKING_PAYLOAD if scope == "bridges" else None,
    )
    async with client as c:
        res = await c.post("/api/bridge/auto", json={
            "from_terminal_id": "a", "to_terminal_id": "b", "kickoff_prompt": "hi",
        })
    assert res.status_code == 409
    body = res.json()
    assert body["ok"] is False
    assert "Real spend" in body["error"]
    assert body["spend"]["real"]["cap"] == 10.0


@pytest.mark.asyncio
async def test_channel_start_refuses_with_409_and_spend_payload(client, monkeypatch):
    monkeypatch.setattr(
        spend_guard, "check_start",
        lambda scope, now=None: _BLOCKING_PAYLOAD if scope == "bridges" else None,
    )
    async with client as c:
        res = await c.post("/api/bridge/channel", json={
            "lead_id": "a", "worker_ids": ["b"], "kickoff_prompt": "hi",
        })
    assert res.status_code == 409
    assert res.json()["spend"]["blocking"] is True


@pytest.mark.asyncio
async def test_bridge_auto_proceeds_when_not_blocking(client, monkeypatch):
    monkeypatch.setattr(spend_guard, "check_start", lambda scope, now=None: None)
    called = {"n": 0}

    async def fake_start_auto(*args, **kwargs):
        called["n"] += 1
        return {"ok": True, "bridge_id": "abc"}

    monkeypatch.setattr(bm_module.bridge_manager, "start_auto", fake_start_auto)
    monkeypatch.setattr(bm_module.channel_manager, "member_ids", lambda: set())
    async with client as c:
        res = await c.post("/api/bridge/auto", json={
            "from_terminal_id": "a", "to_terminal_id": "b", "kickoff_prompt": "hi",
        })
    assert res.status_code == 200
    assert called["n"] == 1


@pytest.mark.asyncio
async def test_spend_status_endpoint_always_200(client):
    async with client as c:
        ok = await c.get("/api/spend/status")
    assert ok.status_code == 200
    assert "period" in ok.json() and "blocking" in ok.json()


# ---------------------------------------------------------------------------
# Turn-boundary enforcement inside a live bridge
# ---------------------------------------------------------------------------


def _mock_session(tid, name):
    s = MagicMock()
    s.id = tid
    s.name = name
    s.alive = True
    s.tracker = MagicMock()
    s.tracker.state = "idle"
    s.claude_session_id = "claude-abc"
    s.last_user_input_time = 0.0
    return s


@pytest.mark.asyncio
async def test_bridge_in_flight_ends_via_existing_path_when_cap_trips(monkeypatch):
    """A cap tripping mid-bridge must end it through _end_bridge (the same path
    BRIDGE-DONE and the turn cap use), with the reason recorded — not a second
    teardown, and never mid-write."""
    a = _mock_session("from-1", "Lead")
    b = _mock_session("to-1", "Worker")
    sessions = {a.id: a, b.id: b}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    writes: list = []

    async def fake_write(tid, data):
        writes.append((tid, data))
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    counter = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        counter["n"] += 1
        if counter["n"] == 1:
            yield {"type": "assistant", "content": [{"type": "text", "text": "working on it"}]}
        await asyncio.sleep(10)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)

    async def blocked():
        return "Real spend $25.00 has reached the $10.00 cap for today."

    monkeypatch.setattr(bm_module, "_spend_stop_reason", blocked)

    manager = bm_module.BridgeManager()
    result = await manager.start_auto(a.id, b.id, "kickoff", max_turns=10)
    assert result["ok"] is True
    record = manager._bridges[result["bridge_id"]]

    for _ in range(20):
        if record.state != "active":
            break
        await asyncio.sleep(0.05)

    assert record.state == "ended_capped"        # existing terminal state, not a new one
    assert "spend cap" in (record.end_reason or "")
    assert record._stop_event.is_set()
    assert record.to_dict()["end_reason"].startswith("spend cap")
    # The relay that was already in flight completed — a cap never kills a write.
    assert any(b.id == tid for tid, _ in writes)


@pytest.mark.asyncio
async def test_bridge_in_flight_continues_when_not_blocking(monkeypatch):
    a = _mock_session("from-2", "Lead")
    b = _mock_session("to-2", "Worker")
    sessions = {a.id: a, b.id: b}
    monkeypatch.setattr(bm_module.pty_manager, "get_terminal", lambda tid: sessions.get(tid))
    monkeypatch.setattr(bm_module.pty_manager, "_get_jsonl_path", lambda s: "/tmp/fake.jsonl")

    async def fake_write(tid, data):
        return True

    monkeypatch.setattr(bm_module.pty_manager, "write_pty_async", fake_write)

    counter = {"n": 0}

    async def fake_tail(path, from_beginning=False, **kwargs):
        counter["n"] += 1
        if counter["n"] == 1:
            yield {"type": "assistant", "content": [{"type": "text", "text": "hello"}]}
        await asyncio.sleep(10)

    monkeypatch.setattr(bm_module, "tail_jsonl", fake_tail)

    async def clear():
        return None

    monkeypatch.setattr(bm_module, "_spend_stop_reason", clear)

    manager = bm_module.BridgeManager()
    result = await manager.start_auto(a.id, b.id, "kickoff", max_turns=10)
    record = manager._bridges[result["bridge_id"]]
    for _ in range(6):
        await asyncio.sleep(0.05)
    assert record.state == "active"
    assert record.end_reason is None


@pytest.mark.asyncio
async def test_spend_stop_reason_is_none_when_bridges_not_enforced(monkeypatch, tracker):
    _write_blocking_settings(monkeypatch, tracker, bridges=False)
    assert await bm_module._spend_stop_reason() is None


@pytest.mark.asyncio
async def test_spend_stop_reason_survives_a_guard_failure(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("guard exploded")

    monkeypatch.setattr(spend_guard, "block_reason", boom)
    assert await bm_module._spend_stop_reason() is None
