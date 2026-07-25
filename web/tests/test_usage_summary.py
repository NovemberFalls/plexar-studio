"""Tests for UsageTracker.summary() — the API-side comparison source for the
Routing & Reporting dashboard (W3)."""

import json
from datetime import datetime, timedelta, timezone

import pytest

from usage_tracker import UsageTracker, _row_cost


@pytest.fixture()
def tracker(tmp_path):
    db_path = tmp_path / "usage.sqlite3"
    t = UsageTracker(db_path=db_path)
    yield t
    t.close()


def _assistant_line(uuid, model="claude-opus-4", input_tokens=100, output_tokens=50,
                     cache_creation=0, cache_read=0, ts="2026-07-19T10:00:00Z"):
    return json.dumps({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
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


def test_summary_lifetime_totals_and_cost(tracker, tmp_path):
    jsonl_path = tmp_path / "s1.jsonl"
    lines = [
        _assistant_line("u1", model="claude-opus-4", input_tokens=1000, output_tokens=500),
        _assistant_line("u2", model="claude-sonnet-5", input_tokens=2000, output_tokens=1000),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-1", str(jsonl_path))

    summary = tracker.summary("lifetime")
    assert summary["window"] == "lifetime"
    assert summary["runs"] == 2
    assert summary["tokens"]["prompt"] == 3000
    assert summary["tokens"]["completion"] == 1500

    expected_cost = (
        _row_cost("claude-opus-4", 1000, 500, 0, 0)
        + _row_cost("claude-sonnet-5", 2000, 1000, 0, 0)
    )
    assert summary["cost_usd"] == pytest.approx(round(expected_cost, 4))


def test_summary_ttft_and_wall_ms_are_null(tracker, tmp_path):
    jsonl_path = tmp_path / "s2.jsonl"
    jsonl_path.write_text(_assistant_line("u1") + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-2", str(jsonl_path))

    summary = tracker.summary("lifetime")
    assert summary["ttft_ms"] == {"p50": None, "p95": None}
    assert summary["wall_ms"] == {"p50": None, "p95": None}
    assert summary["errors_total"] == 0


def test_summary_by_model_breakdown(tracker, tmp_path):
    jsonl_path = tmp_path / "s3.jsonl"
    lines = [
        _assistant_line("u1", model="claude-opus-4", input_tokens=1_000_000, output_tokens=0),
        _assistant_line("u2", model="claude-opus-4", input_tokens=500_000, output_tokens=0),
        _assistant_line("u3", model="claude-sonnet-5", input_tokens=100_000, output_tokens=0),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-3", str(jsonl_path))

    summary = tracker.summary("lifetime")
    by_model = {b["model"]: b for b in summary["by_model"]}
    assert by_model["claude-opus-4"]["runs"] == 2
    assert by_model["claude-opus-4"]["tokens"] == 1_500_000
    assert by_model["claude-opus-4"]["cost_usd"] == pytest.approx(
        round(_row_cost("claude-opus-4", 1_500_000, 0, 0, 0), 4)
    )
    assert by_model["claude-sonnet-5"]["runs"] == 1
    # sorted by tokens descending
    assert summary["by_model"][0]["model"] == "claude-opus-4"


def test_summary_window_filters_24h(tracker, tmp_path):
    now = datetime.now(timezone.utc)
    old_ts = (now - timedelta(days=2)).isoformat()
    recent_ts = (now - timedelta(hours=1)).isoformat()

    jsonl_path = tmp_path / "s4.jsonl"
    lines = [
        _assistant_line("old", input_tokens=100, output_tokens=50, ts=old_ts),
        _assistant_line("recent", input_tokens=200, output_tokens=100, ts=recent_ts),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-4", str(jsonl_path))

    summary_24h = tracker.summary("24h")
    assert summary_24h["runs"] == 1
    assert summary_24h["tokens"]["prompt"] == 200

    summary_lifetime = tracker.summary("lifetime")
    assert summary_lifetime["runs"] == 2


def test_summary_session_window_excludes_preexisting_rows(tracker, tmp_path):
    # Rows timestamped before this tracker instance started should be excluded
    # from the "session" window (it starts counting from tracker init).
    old_ts = "2020-01-01T00:00:00+00:00"
    jsonl_path = tmp_path / "s5.jsonl"
    jsonl_path.write_text(
        _assistant_line("old", input_tokens=100, output_tokens=50, ts=old_ts) + "\n",
        encoding="utf-8",
    )
    tracker.ingest_jsonl("term-5", str(jsonl_path))

    summary = tracker.summary("session")
    assert summary["runs"] == 0
    assert summary["tokens"]["prompt"] == 0


def test_summary_empty_store(tracker):
    summary = tracker.summary("lifetime")
    assert summary["runs"] == 0
    assert summary["tokens"] == {"prompt": 0, "completion": 0}
    assert summary["cost_usd"] == 0.0
    assert summary["by_model"] == []


def test_summary_invalid_window_falls_back_to_lifetime(tracker, tmp_path):
    jsonl_path = tmp_path / "s6.jsonl"
    jsonl_path.write_text(_assistant_line("u1") + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-6", str(jsonl_path))

    summary = tracker.summary("bogus-window")
    assert summary["window"] == "lifetime"
    assert summary["runs"] == 1
