"""Tests for the Reports page's single feeding endpoint: GET /api/usage/report
and its backing query method UsageTracker.range_report().

Covers range validation, gap-filled day series, local tokens costed at $0 but
present in local_share, unpriced models kept (never dropped, never crashing),
cache_hit_rate zero-denominator, and sessions sorted by tokens desc.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app
from usage_tracker import UsageTracker, _row_cost


@pytest.fixture()
def tracker(tmp_path):
    t = UsageTracker(db_path=tmp_path / "usage.sqlite3")
    yield t
    t.close()


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


def _iso(days_ago: float = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


def _assistant_line(uuid, model="claude-opus-4", input_tokens=100, output_tokens=50,
                    cache_creation=0, cache_read=0, ts=None):
    return json.dumps({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts or _iso(0),
        "message": {
            "model": model,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": cache_creation,
                "cache_read_input_tokens": cache_read,
            },
        },
    })


def _ingest(tracker, tmp_path, lines, terminal_id="term-1", workdir=r"C:\Code\my-repo", name="s.jsonl"):
    p = tmp_path / name
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl(terminal_id, str(p), workdir)


# -- range validation ------------------------------------------------------


@pytest.mark.parametrize("rng", ["24h", "7d", "30d", "all"])
def test_range_report_accepts_valid_ranges(tracker, rng):
    report = tracker.range_report(rng)
    assert report["range"] == rng
    assert set(report) == {"range", "generated_at", "kpis", "by_day", "by_model", "sessions"}


def test_range_report_rejects_bad_range(tracker):
    with pytest.raises(ValueError):
        tracker.range_report("lifetime")


@pytest.mark.asyncio
@pytest.mark.parametrize("rng", ["24h", "7d", "30d", "all"])
async def test_endpoint_accepts_valid_ranges(client, rng):
    res = await client.get(f"/api/usage/report?range={rng}")
    assert res.status_code == 200
    assert res.json()["range"] == rng


@pytest.mark.asyncio
async def test_endpoint_rejects_bad_range(client):
    res = await client.get("/api/usage/report?range=forever")
    assert res.status_code == 400
    assert "error" in res.json()


@pytest.mark.asyncio
async def test_endpoint_defaults_to_7d(client):
    res = await client.get("/api/usage/report")
    assert res.status_code == 200
    assert res.json()["range"] == "7d"


@pytest.mark.asyncio
async def test_endpoint_shape_matches_contract(client, tracker, tmp_path, monkeypatch):
    _ingest(tracker, tmp_path, [_assistant_line("u1", input_tokens=10, output_tokens=5)])
    monkeypatch.setattr(server_module, "usage_tracker", tracker)
    res = await client.get("/api/usage/report?range=7d")
    data = res.json()
    assert set(data["kpis"]) == {
        "total_tokens", "cost", "cache_hit_rate", "local_share", "turns", "tool_calls",
    }
    day = data["by_day"][0]
    for key in ("day", "input", "output", "cache_read", "cache_write", "local", "total", "cost"):
        assert key in day
    model = data["by_model"][0]
    for key in ("model", "provider", "tokens", "cost", "share", "is_local"):
        assert key in model
    sess = data["sessions"][0]
    for key in ("terminal_id", "name", "project", "model", "input", "output",
                "cache_read", "cache_write", "total", "turns", "cost", "tool_calls"):
        assert key in sess
    assert sess["project"] == "my-repo"


# -- gap filling -----------------------------------------------------------


def test_by_day_is_gap_filled_contiguous(tracker, tmp_path):
    # Activity only 6 days ago and today -> the days between must still appear.
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", ts=_iso(6)),
        _assistant_line("u2", ts=_iso(0)),
    ])
    series = tracker.range_report("7d")["by_day"]
    days = [row["day"] for row in series]
    assert days == sorted(days)
    assert len(days) == 7
    parsed = [date.fromisoformat(d) for d in days]
    for a, b in zip(parsed, parsed[1:]):
        assert (b - a).days == 1, "day series must be contiguous"
    assert parsed[-1] == datetime.now(timezone.utc).date()
    # Interior gap days are present with zeros, not missing.
    zeros = [r for r in series if r["total"] == 0]
    assert len(zeros) == 5
    assert all(r["cost"] == 0.0 and r["local"] == 0 for r in zeros)


def test_by_day_gap_filled_for_30d(tracker):
    series = tracker.range_report("30d")["by_day"]
    assert len(series) == 30
    assert all(row["total"] == 0 for row in series)


def test_by_day_all_range_starts_at_first_event(tracker, tmp_path):
    _ingest(tracker, tmp_path, [_assistant_line("u1", ts=_iso(3))])
    series = tracker.range_report("all")["by_day"]
    first = date.fromisoformat(series[0]["day"])
    assert first == (datetime.now(timezone.utc) - timedelta(days=3)).date()
    assert len(series) == 4  # 3 days ago .. today, inclusive


# -- costs, local tokens, unpriced models ---------------------------------


def test_local_tokens_excluded_from_cost_but_in_local_share(tracker, tmp_path):
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", model="claude-opus", input_tokens=1000, output_tokens=0),
    ])
    tracker.record_local_run(
        terminal_id="term-1", provider_id="vllm-local", model="qwen3-coder-30b",
        input_tokens=600, output_tokens=400, wall_ms=120.0, workdir=r"C:\Code\my-repo",
    )
    report = tracker.range_report("24h")
    api_cost = _row_cost("claude-opus", 1000, 0, 0, 0)

    assert report["kpis"]["cost"] == pytest.approx(round(api_cost, 4))
    assert report["kpis"]["total_tokens"] == 1000 + 1000
    assert report["kpis"]["local_share"] == pytest.approx(0.5)

    local = [m for m in report["by_model"] if m["is_local"]]
    assert len(local) == 1
    assert local[0]["tokens"] == 1000
    assert local[0]["cost"] == 0.0
    assert local[0]["provider"] == "vllm-local"

    # And the day bucket separates local from api tokens.
    today = [r for r in report["by_day"] if r["local"] > 0][0]
    assert today["local"] == 1000
    assert today["input"] == 1000
    assert today["total"] == 2000


def test_local_share_zero_when_no_local_runs(tracker, tmp_path):
    _ingest(tracker, tmp_path, [_assistant_line("u1")])
    assert tracker.range_report("24h")["kpis"]["local_share"] == 0.0


def test_unpriced_model_keeps_tokens_and_does_not_crash(tracker, tmp_path):
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", model="some-brand-new-model-9000",
                        input_tokens=500, output_tokens=250),
    ])
    report = tracker.range_report("all")
    rows = [m for m in report["by_model"] if m["model"] == "some-brand-new-model-9000"]
    assert len(rows) == 1, "an unpriced model must still appear"
    assert rows[0]["tokens"] == 750
    assert rows[0]["cost"] >= 0.0
    assert report["kpis"]["total_tokens"] == 750


def test_openrouter_model_tagged_as_openrouter(tracker, tmp_path):
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", model="deepseek/deepseek-v4-pro", input_tokens=10, output_tokens=5),
    ])
    row = tracker.range_report("all")["by_model"][0]
    assert row["provider"] == "openrouter"
    assert row["is_local"] is False


def test_model_shares_sum_to_one(tracker, tmp_path):
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", model="claude-opus", input_tokens=100, output_tokens=0),
        _assistant_line("u2", model="claude-haiku", input_tokens=300, output_tokens=0),
    ])
    report = tracker.range_report("all")
    assert sum(m["share"] for m in report["by_model"]) == pytest.approx(1.0, abs=1e-4)


# -- cache hit rate --------------------------------------------------------


def test_cache_hit_rate_zero_denominator(tracker, tmp_path):
    # Output-only rows: input == 0 and cache_read == 0 -> denominator 0 -> 0.0
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", input_tokens=0, output_tokens=500, cache_read=0),
    ])
    assert tracker.range_report("all")["kpis"]["cache_hit_rate"] == 0.0


def test_cache_hit_rate_empty_db(tracker):
    report = tracker.range_report("7d")
    assert report["kpis"]["cache_hit_rate"] == 0.0
    assert report["kpis"]["total_tokens"] == 0
    assert report["kpis"]["turns"] == 0


def test_cache_hit_rate_formula(tracker, tmp_path):
    # cache_read / (cache_read + input) = 750 / (750 + 250) = 0.75
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", input_tokens=250, output_tokens=10, cache_read=750, cache_creation=100),
    ])
    assert tracker.range_report("all")["kpis"]["cache_hit_rate"] == pytest.approx(0.75)


# -- sessions --------------------------------------------------------------


def test_sessions_sorted_by_total_tokens_desc(tracker, tmp_path):
    _ingest(tracker, tmp_path, [_assistant_line("a1", input_tokens=100, output_tokens=0)],
            terminal_id="small", workdir=r"C:\Code\alpha", name="a.jsonl")
    _ingest(tracker, tmp_path, [_assistant_line("b1", input_tokens=9000, output_tokens=0)],
            terminal_id="big", workdir=r"C:\Code\beta", name="b.jsonl")
    _ingest(tracker, tmp_path, [_assistant_line("c1", input_tokens=500, output_tokens=0)],
            terminal_id="mid", workdir=r"C:\Code\gamma", name="c.jsonl")

    sessions = tracker.range_report("all")["sessions"]
    assert [s["terminal_id"] for s in sessions] == ["big", "mid", "small"]
    totals = [s["total"] for s in sessions]
    assert totals == sorted(totals, reverse=True)
    assert [s["project"] for s in sessions] == ["beta", "gamma", "alpha"]


def test_session_turns_and_model(tracker, tmp_path):
    _ingest(tracker, tmp_path, [
        _assistant_line("u1", model="claude-opus", input_tokens=10, output_tokens=5),
        _assistant_line("u2", model="claude-opus", input_tokens=10, output_tokens=5),
        _assistant_line("u3", model="claude-haiku", input_tokens=1, output_tokens=1),
    ])
    report = tracker.range_report("all")
    assert report["kpis"]["turns"] == 3
    s = report["sessions"][0]
    assert s["turns"] == 3
    assert s["model"] == "claude-opus"  # dominant by tokens


def test_tool_calls_is_null_not_zero(tracker, tmp_path):
    """Tool invocations are not persisted in the usage schema, so the honest
    answer is null -- a 0 would read as 'no tools were used'."""
    _ingest(tracker, tmp_path, [_assistant_line("u1")])
    report = tracker.range_report("all")
    assert report["kpis"]["tool_calls"] is None
    assert report["sessions"][0]["tool_calls"] is None


def test_range_filters_old_rows_out(tracker, tmp_path):
    _ingest(tracker, tmp_path, [
        _assistant_line("old", input_tokens=1000, output_tokens=0, ts=_iso(40)),
        _assistant_line("new", input_tokens=7, output_tokens=0, ts=_iso(0)),
    ])
    assert tracker.range_report("24h")["kpis"]["total_tokens"] == 7
    assert tracker.range_report("7d")["kpis"]["total_tokens"] == 7
    assert tracker.range_report("all")["kpis"]["total_tokens"] == 1007


@pytest.mark.asyncio
async def test_endpoint_returns_503_on_tracker_failure(client, monkeypatch):
    class Boom:
        def range_report(self, rng):
            raise RuntimeError("db gone")

    monkeypatch.setattr(server_module, "usage_tracker", Boom())
    res = await client.get("/api/usage/report?range=7d")
    assert res.status_code == 503
    assert res.json() == {"reachable": False}
