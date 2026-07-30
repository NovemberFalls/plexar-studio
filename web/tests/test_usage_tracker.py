"""Tests for web/usage_tracker.py — pricing, cost math, ingest, and summaries."""

import json
import tempfile
from pathlib import Path

import pytest

from usage_tracker import UsageTracker, _pricing_for, _row_cost, PRICING, DEFAULT_PRICING


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


# --- pricing lookup ---------------------------------------------------------

def test_pricing_prefix_lookup():
    assert _pricing_for("claude-opus-4-20260101") == PRICING["claude-opus"]
    assert _pricing_for("claude-sonnet-5") == PRICING["claude-sonnet"]
    assert _pricing_for("claude-haiku-3") == PRICING["claude-haiku"]


def test_pricing_fallback_for_unknown_model():
    assert _pricing_for("some-unknown-model") == DEFAULT_PRICING
    assert _pricing_for("") == DEFAULT_PRICING
    assert _pricing_for(None) == DEFAULT_PRICING


def test_pricing_longest_prefix_wins():
    # "claude-fable-5" and other keys don't overlap here, but verify exact match wins.
    assert _pricing_for("claude-fable-5-preview") == PRICING["claude-fable-5"]


# --- cost math ---------------------------------------------------------------

def test_cost_math_opus_1m_in_1m_out():
    # claude-opus: input=5.0, output=25.0 per 1M tokens => 5 + 25 = 30.0
    cost = _row_cost("claude-opus-4", 1_000_000, 1_000_000, 0, 0)
    assert cost == 30.0


def test_cost_math_cache_creation_and_read():
    # claude-sonnet: input=3.0, output=15.0
    # cache_creation = 1.25x input price, cache_read = 0.1x input price
    cost = _row_cost("claude-sonnet-5", 0, 0, 1_000_000, 1_000_000)
    expected = (3.0 * 1.25) + (3.0 * 0.1)
    assert cost == pytest.approx(expected)


def test_cost_math_default_pricing():
    cost = _row_cost("totally-unknown", 1_000_000, 1_000_000, 0, 0)
    assert cost == pytest.approx(DEFAULT_PRICING["input"] + DEFAULT_PRICING["output"])


# --- tool_use ingest ---------------------------------------------------------

def _assistant_tool_line(uuid, content, model="claude-opus-4",
                         ts="2026-07-19T10:00:00Z", usage=True):
    """Assistant line with an arbitrary `content` block list; `usage=False`
    omits the usage block entirely (tools-without-usage turn)."""
    message = {"model": model, "content": content}
    if usage:
        message["usage"] = {
            "input_tokens": 100, "output_tokens": 50,
            "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
        }
    return json.dumps({"type": "assistant", "uuid": uuid, "timestamp": ts, "message": message})


def _tool_use(name, tid="t1"):
    return {"type": "tool_use", "id": tid, "name": name}


def _tool_rows(tracker):
    return tracker._conn.execute(
        "SELECT uuid, block_index, terminal_id, ts, model, tool_name, workdir "
        "FROM tool_events ORDER BY uuid, block_index"
    ).fetchall()


def _write_and_ingest(tracker, tmp_path, lines, terminal_id="term-t",
                      name="tools.jsonl", workdir=None):
    p = tmp_path / name
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return tracker.ingest_jsonl(terminal_id, str(p), workdir), p


def test_tool_use_block_persisted_with_name(tracker, tmp_path):
    _write_and_ingest(tracker, tmp_path, [
        _assistant_tool_line("u1", [_tool_use("Read")]),
    ], workdir=r"C:\Code\my-repo")
    rows = _tool_rows(tracker)
    assert len(rows) == 1
    assert rows[0]["tool_name"] == "Read"
    assert rows[0]["uuid"] == "u1"
    assert rows[0]["block_index"] == 0
    assert rows[0]["terminal_id"] == "term-t"
    assert rows[0]["model"] == "claude-opus-4"
    assert rows[0]["ts"] == "2026-07-19T10:00:00Z"
    assert rows[0]["workdir"] == r"C:\Code\my-repo"


def test_multiple_tool_blocks_get_distinct_block_index(tracker, tmp_path):
    _write_and_ingest(tracker, tmp_path, [
        _assistant_tool_line("u1", [
            {"type": "text", "text": "thinking out loud"},
            _tool_use("Read", "a"),
            _tool_use("Edit", "b"),
            _tool_use("Read", "c"),
        ]),
    ])
    rows = _tool_rows(tracker)
    assert [(r["block_index"], r["tool_name"]) for r in rows] == [
        (1, "Read"), (2, "Edit"), (3, "Read"),
    ]


def test_tool_reingest_is_idempotent(tracker, tmp_path):
    """Re-ingest happens routinely (offset reset / file rotation). A duplicate-
    inflating counter here would be silent data corruption."""
    lines = [
        _assistant_tool_line("u1", [_tool_use("Read", "a"), _tool_use("Bash", "b")]),
        _assistant_tool_line("u2", [_tool_use("Edit", "c")]),
    ]
    _write_and_ingest(tracker, tmp_path, lines)
    assert len(_tool_rows(tracker)) == 3

    # Force a full re-read of the identical file (as a rotation would).
    tracker._offsets.clear()
    _write_and_ingest(tracker, tmp_path, lines)
    assert len(_tool_rows(tracker)) == 3


def test_tool_use_without_usage_block_still_recorded(tracker, tmp_path):
    inserted, _ = _write_and_ingest(tracker, tmp_path, [
        _assistant_tool_line("u1", [_tool_use("Read"), _tool_use("Bash", "b")], usage=False),
    ])
    assert inserted == 0, "no usage block -> no usage row"
    assert [r["tool_name"] for r in _tool_rows(tracker)] == ["Read", "Bash"]


def test_usage_without_tools_still_recorded(tracker, tmp_path):
    inserted, _ = _write_and_ingest(tracker, tmp_path, [_assistant_line("u1")])
    assert inserted == 1
    assert _tool_rows(tracker) == []
    assert tracker.session_summary("term-t")["input_tokens"] == 100


def test_malformed_content_block_does_not_abort_the_line(tracker, tmp_path):
    _write_and_ingest(tracker, tmp_path, [
        _assistant_tool_line("u1", [
            _tool_use("Read", "a"),
            "a bare string, not a block",
            None,
            {"type": "tool_use"},          # no name -> "unknown"
            _tool_use("Bash", "b"),
        ]),
    ])
    rows = _tool_rows(tracker)
    assert [r["tool_name"] for r in rows] == ["Read", "unknown", "Bash"]
    # The usage row on the same line survived too.
    assert tracker.session_summary("term-t")["input_tokens"] == 100


def test_content_not_a_list_is_ignored(tracker, tmp_path):
    _write_and_ingest(tracker, tmp_path, [
        _assistant_tool_line("u1", "just a string content"),
    ])
    assert _tool_rows(tracker) == []


@pytest.mark.parametrize("name", [None, "", "   "])
def test_missing_or_blank_tool_name_becomes_unknown(tracker, tmp_path, name):
    block = {"type": "tool_use", "id": "x"}
    if name is not None:
        block["name"] = name
    _write_and_ingest(tracker, tmp_path, [_assistant_tool_line("u1", [block])])
    rows = _tool_rows(tracker)
    assert len(rows) == 1, "a call happened -- never skip it"
    assert rows[0]["tool_name"] == "unknown"


def test_non_tool_blocks_are_not_recorded(tracker, tmp_path):
    _write_and_ingest(tracker, tmp_path, [
        _assistant_tool_line("u1", [
            {"type": "text", "text": "hi"},
            {"type": "thinking", "thinking": "hmm"},
        ]),
    ])
    assert _tool_rows(tracker) == []


# --- schema migration for existing databases ---------------------------------

def test_pre_migration_db_upgrades_without_error_or_data_loss(tmp_path):
    """An existing usage.sqlite3 written before tool_events existed must open,
    gain the new table, and keep every pre-existing row."""
    import sqlite3 as _sqlite3

    db = tmp_path / "legacy.sqlite3"
    conn = _sqlite3.connect(str(db))
    conn.executescript(
        """
        CREATE TABLE usage_events (
          id INTEGER PRIMARY KEY,
          terminal_id TEXT NOT NULL,
          jsonl_path TEXT NOT NULL,
          message_uuid TEXT NOT NULL,
          ts TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          UNIQUE(jsonl_path, message_uuid)
        );
        """
    )
    conn.execute(
        "INSERT INTO usage_events (terminal_id, jsonl_path, message_uuid, ts, model,"
        " input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens)"
        " VALUES ('old-term', '/x.jsonl', 'legacy-1', '2026-01-01T00:00:00Z',"
        " 'claude-opus', 111, 222, 0, 0)"
    )
    conn.commit()
    conn.close()

    t = UsageTracker(db_path=db)
    try:
        # Legacy row intact, including the column added by an earlier migration.
        summary = t.session_summary("old-term")
        assert summary["input_tokens"] == 111
        assert summary["output_tokens"] == 222
        # New table exists and is usable.
        assert t._conn.execute("SELECT COUNT(*) FROM tool_events").fetchone()[0] == 0
        p = tmp_path / "after.jsonl"
        p.write_text(_assistant_tool_line("u1", [_tool_use("Read")]) + "\n", encoding="utf-8")
        t.ingest_jsonl("new-term", str(p))
        assert t._conn.execute("SELECT COUNT(*) FROM tool_events").fetchone()[0] == 1
        # And the legacy row is still reported.
        assert t.range_report("all")["kpis"]["total_tokens"] == 111 + 222 + 150
    finally:
        t.close()


# --- ingest --------------------------------------------------------------------

def test_ingest_skips_malformed_and_duplicate(tracker, tmp_path):
    jsonl_path = tmp_path / "session.jsonl"
    lines = [
        _assistant_line("uuid-1"),
        _assistant_line("uuid-2"),
        "{not valid json!!",
        _assistant_line("uuid-3"),
        _assistant_line("uuid-1"),  # duplicate uuid
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    inserted = tracker.ingest_jsonl("term-1", str(jsonl_path))
    assert inserted == 3

    summary = tracker.session_summary("term-1")
    assert summary["input_tokens"] == 300
    assert summary["output_tokens"] == 150


def test_ingest_idempotent_reingest(tracker, tmp_path):
    jsonl_path = tmp_path / "session2.jsonl"
    lines = [_assistant_line("uuid-a"), _assistant_line("uuid-b")]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    first = tracker.ingest_jsonl("term-2", str(jsonl_path))
    assert first == 2

    # No new content -> no new rows.
    second = tracker.ingest_jsonl("term-2", str(jsonl_path))
    assert second == 0

    summary = tracker.session_summary("term-2")
    assert summary["input_tokens"] == 200
    assert summary["output_tokens"] == 100


def test_ingest_appends_new_lines_incrementally(tracker, tmp_path):
    jsonl_path = tmp_path / "session3.jsonl"
    jsonl_path.write_text(_assistant_line("uuid-x") + "\n", encoding="utf-8")

    first = tracker.ingest_jsonl("term-3", str(jsonl_path))
    assert first == 1

    with open(jsonl_path, "a", encoding="utf-8") as f:
        f.write(_assistant_line("uuid-y") + "\n")

    second = tracker.ingest_jsonl("term-3", str(jsonl_path))
    assert second == 1

    summary = tracker.session_summary("term-3")
    assert summary["input_tokens"] == 200


# --- session_summary -----------------------------------------------------------

def test_session_summary_totals(tracker, tmp_path):
    jsonl_path = tmp_path / "session4.jsonl"
    lines = [
        _assistant_line("u1", model="claude-opus-4", input_tokens=1000, output_tokens=500),
        _assistant_line("u2", model="claude-sonnet-5", input_tokens=2000, output_tokens=1000),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-4", str(jsonl_path))

    summary = tracker.session_summary("term-4")
    assert summary["terminal_id"] == "term-4"
    assert summary["input_tokens"] == 3000
    assert summary["output_tokens"] == 1500
    assert summary["total_tokens"] == 4500
    assert set(summary["models"]) == {"claude-opus-4", "claude-sonnet-5"}
    assert summary["last_event_ts"] is not None
    assert summary["est_cost_usd"] > 0


def test_session_summary_empty_terminal(tracker):
    summary = tracker.session_summary("nonexistent")
    assert summary["input_tokens"] == 0
    assert summary["output_tokens"] == 0
    assert summary["total_tokens"] == 0
    assert summary["models"] == []
    assert summary["last_event_ts"] is None
    assert summary["est_cost_usd"] == 0.0


# --- daily_summary --------------------------------------------------------------

def test_daily_summary_by_model(tracker, tmp_path):
    jsonl_path = tmp_path / "session5.jsonl"
    day = "2026-07-19"
    lines = [
        _assistant_line("d1", model="claude-opus-4", input_tokens=1_000_000,
                         output_tokens=1_000_000, ts=f"{day}T09:00:00Z"),
        _assistant_line("d2", model="claude-opus-4", input_tokens=500_000,
                         output_tokens=0, ts=f"{day}T10:00:00Z"),
        _assistant_line("d3", model="claude-sonnet-5", input_tokens=1_000_000,
                         output_tokens=0, ts=f"{day}T11:00:00Z"),
        # different day, should be excluded
        _assistant_line("d4", model="claude-opus-4", input_tokens=1_000_000,
                         output_tokens=1_000_000, ts="2026-07-18T09:00:00Z"),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-5", str(jsonl_path))

    summary = tracker.daily_summary(day)
    assert summary["day"] == day
    assert "claude-opus-4" in summary["by_model"]
    assert "claude-sonnet-5" in summary["by_model"]
    # opus: 1.5M input, 1M output
    opus_cost = summary["by_model"]["claude-opus-4"]["est_cost_usd"]
    expected_opus_cost = round((1_500_000 * 5.0 + 1_000_000 * 25.0) / 1_000_000, 4)
    assert opus_cost == pytest.approx(expected_opus_cost)
    assert "term-5" in summary["by_terminal"]
    # the excluded (different-day) row should not contribute
    assert summary["input_tokens"] == 2_500_000


def test_daily_summary_defaults_to_today(tracker):
    summary = tracker.daily_summary()
    assert "day" in summary
    assert summary["est_cost_usd"] == 0.0


# --- persistence after JSONL deletion --------------------------------------------

def test_persistence_after_jsonl_deletion(tracker, tmp_path):
    jsonl_path = tmp_path / "session6.jsonl"
    lines = [_assistant_line("p1", input_tokens=100, output_tokens=200)]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-6", str(jsonl_path))

    before = tracker.session_summary("term-6")
    assert before["input_tokens"] == 100

    jsonl_path.unlink()

    # Re-ingesting a missing file should be a no-op, not raise, and not lose data.
    inserted = tracker.ingest_jsonl("term-6", str(jsonl_path))
    assert inserted == 0

    after = tracker.session_summary("term-6")
    assert after == before
