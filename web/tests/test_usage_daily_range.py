"""daily_summary reads today's rows through the ts index, and selects the same rows.

Measured 2026-11-22 on the owner's 559,423-row store: the old `substr(ts, 1, 10) = ?`
read every row (157 to 213 ms per call, asked every 3 s); the range reads 8,506 in 4 ms.
"""
import sqlite3

import usage_tracker


def test_the_range_bound_matches_exactly_the_rows_a_prefix_match_would():
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (ts TEXT)")
    stamps = ["2026-11-21T23:59:59.999Z", "2026-11-22", "2026-11-22T00:00:00Z",
              "2026-11-22T23:59:59.999999+00:00", "2026-11-22 12:00:00", "2026-11-22~odd",
              "2026-11-23T00:00:00Z", "2026-11-2", "", "2026-11-220"]
    conn.executemany("INSERT INTO t VALUES (?)", [(s,) for s in stamps])
    day = "2026-11-22"
    old = {r[0] for r in conn.execute("SELECT ts FROM t WHERE substr(ts, 1, 10) = ?", (day,))}
    new = {r[0] for r in conn.execute("SELECT ts FROM t WHERE ts >= ? AND ts < ?",
                                      (day, day + usage_tracker._PREFIX_END))}
    assert new == old and "2026-11-23T00:00:00Z" not in new and "2026-11-220" in new


def test_daily_summary_uses_the_ts_index():
    import inspect
    src = inspect.getsource(usage_tracker.UsageTracker.daily_summary)
    assert "substr(ts" not in src.split('"""')[0] or "ts >= ? AND ts < ?" in src
    assert "ts >= ? AND ts < ?" in src
