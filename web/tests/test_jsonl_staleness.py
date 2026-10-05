"""JSONL staleness re-resolution after in-terminal /resume (bug #15 family).

When a session's locked JSONL stops growing while the session is still
producing PTY output, _get_jsonl_path must re-lock onto the live file —
without stealing a file claimed by another session.
"""
import os
import time
import types


from pty_manager import PtyManager as PTYManager


def _manager_with_sessions(sessions):
    mgr = PTYManager.__new__(PTYManager)  # skip __init__ (spawns cleanup work)
    mgr.sessions = sessions
    return mgr


def _fake_session(sid, claude_id, last_output_offset=1.0):
    return types.SimpleNamespace(
        id=sid,
        claude_session_id=claude_id,
        last_output_time=time.monotonic() - last_output_offset,
    )


def _touch(path, age_seconds):
    path.write_text("{}\n")
    ts = time.time() - age_seconds
    os.utime(path, (ts, ts))


def test_fresh_file_not_stale(tmp_path):
    mgr = _manager_with_sessions({})
    s = _fake_session("t1", "aaa")
    f = tmp_path / "aaa.jsonl"
    _touch(f, age_seconds=5)
    assert mgr._jsonl_is_stale(s, str(f)) is False


def test_stale_file_with_recent_output_detected(tmp_path):
    mgr = _manager_with_sessions({})
    s = _fake_session("t1", "aaa", last_output_offset=2.0)
    s.last_user_input_time = time.monotonic() - 30.0  # typed after the last write
    f = tmp_path / "aaa.jsonl"
    _touch(f, age_seconds=600)
    assert mgr._jsonl_is_stale(s, str(f)) is True


def test_output_without_typing_is_never_stale(tmp_path):
    """Measured 2026-10-04: a pane spawned with --resume printed its banner over a
    transcript last written long ago, was judged stale, and took another pane's file."""
    mgr = _manager_with_sessions({})
    f = tmp_path / "aaa.jsonl"
    _touch(f, age_seconds=600)
    never_typed = _fake_session("t1", "aaa", last_output_offset=2.0)
    never_typed.last_user_input_time = 0.0
    assert mgr._jsonl_is_stale(never_typed, str(f)) is False
    # Typed, but BEFORE the file's last write: a long tool call, not a /resume.
    typed_earlier = _fake_session("t1", "aaa", last_output_offset=2.0)
    typed_earlier.last_user_input_time = time.monotonic() - 900.0
    assert mgr._jsonl_is_stale(typed_earlier, str(f)) is False


def test_rediscover_never_takes_a_file_another_pane_once_held(tmp_path):
    """The swap: pane B drifted off 'bbb', leaving it unclaimed, and pane A took it."""
    a = _fake_session("t1", "aaa")
    b = _fake_session("t2", "zzz")
    b.jsonl_ids_held = {"bbb", "zzz"}
    mgr = _manager_with_sessions({"t1": a, "t2": b})
    _touch(tmp_path / "aaa.jsonl", age_seconds=600)
    _touch(tmp_path / "bbb.jsonl", age_seconds=3)
    assert mgr._rediscover_jsonl(a, str(tmp_path)) is None
    assert a.claude_session_id == "aaa"
    # ...while B itself can still return to it.
    assert mgr._rediscover_jsonl(b, str(tmp_path)) == str(tmp_path / "bbb.jsonl")


def test_no_output_activity_never_stale(tmp_path):
    mgr = _manager_with_sessions({})
    s = _fake_session("t1", "aaa")
    s.last_output_time = 0.0
    f = tmp_path / "aaa.jsonl"
    _touch(f, age_seconds=600)
    assert mgr._jsonl_is_stale(s, str(f)) is False


def test_rediscover_picks_live_unclaimed_file(tmp_path):
    s = _fake_session("t1", "aaa")
    other = _fake_session("t2", "ccc")
    mgr = _manager_with_sessions({"t1": s, "t2": other})
    _touch(tmp_path / "aaa.jsonl", age_seconds=600)   # own stale file
    _touch(tmp_path / "bbb.jsonl", age_seconds=3)     # live resumed file
    _touch(tmp_path / "ccc.jsonl", age_seconds=2)     # claimed by other session
    _touch(tmp_path / "ddd.jsonl", age_seconds=9999)  # old junk
    got = mgr._rediscover_jsonl(s, str(tmp_path))
    assert got == str(tmp_path / "bbb.jsonl")
    assert s.claude_session_id == "bbb"


def test_rediscover_returns_none_when_only_claimed_or_old(tmp_path):
    s = _fake_session("t1", "aaa")
    other = _fake_session("t2", "ccc")
    mgr = _manager_with_sessions({"t1": s, "t2": other})
    _touch(tmp_path / "aaa.jsonl", age_seconds=600)
    _touch(tmp_path / "ccc.jsonl", age_seconds=2)
    _touch(tmp_path / "ddd.jsonl", age_seconds=9999)
    assert mgr._rediscover_jsonl(s, str(tmp_path)) is None
    assert s.claude_session_id == "aaa"


# ---------------------------------------------------------------------------
# Strategy 3 — resume fallback in _get_jsonl_path (the "resumed session shows
# $0.00 forever" bug: the resumed conversation's JSONL predates spawn, so the
# new-file diff never finds it and claude_session_id stays None).
# ---------------------------------------------------------------------------

def _resume_session(sid, working_dir, pre_spawn_files):
    s = _fake_session(sid, None)
    s.working_dir = working_dir
    s._pre_spawn_files = pre_spawn_files
    s.resumed_at_spawn = True
    return s


def _project_dir(tmp_path, monkeypatch, working_dir):
    """Build the ~/.claude/projects/<id> dir _get_jsonl_path derives."""
    monkeypatch.setattr(os.path, "expanduser", lambda p: str(tmp_path))
    project_id = working_dir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
    d = tmp_path / ".claude" / "projects" / project_id
    d.mkdir(parents=True)
    return d


def test_resume_fallback_claims_live_preexisting_jsonl(tmp_path, monkeypatch):
    """csid=None + no new files + recent output → claim the live unclaimed file."""
    wd = "C:/proj/x"
    d = _project_dir(tmp_path, monkeypatch, wd)
    _touch(d / "resumed.jsonl", age_seconds=3)    # the resumed convo, being written
    _touch(d / "ancient.jsonl", age_seconds=9999)
    s = _resume_session("t1", wd, pre_spawn_files={"resumed.jsonl", "ancient.jsonl"})
    mgr = _manager_with_sessions({"t1": s})
    got = mgr._get_jsonl_path(s)
    assert got == str(d / "resumed.jsonl")
    assert s.claude_session_id == "resumed"


def test_resume_fallback_requires_output_activity(tmp_path, monkeypatch):
    """An idle pane must never grab another session's file (mis-attribution)."""
    wd = "C:/proj/y"
    d = _project_dir(tmp_path, monkeypatch, wd)
    _touch(d / "someone-elses.jsonl", age_seconds=3)
    s = _resume_session("t1", wd, pre_spawn_files={"someone-elses.jsonl"})
    s.last_output_time = 0.0  # no output ever produced
    mgr = _manager_with_sessions({"t1": s})
    assert mgr._get_jsonl_path(s) is None
    assert s.claude_session_id is None


def test_resume_fallback_skips_files_claimed_by_other_sessions(tmp_path, monkeypatch):
    wd = "C:/proj/z"
    d = _project_dir(tmp_path, monkeypatch, wd)
    _touch(d / "claimed.jsonl", age_seconds=2)
    s = _resume_session("t1", wd, pre_spawn_files={"claimed.jsonl"})
    other = _fake_session("t2", "claimed")
    mgr = _manager_with_sessions({"t1": s, "t2": other})
    assert mgr._get_jsonl_path(s) is None
    assert s.claude_session_id is None


def test_fresh_pane_with_banner_output_never_claims_a_foreign_file(tmp_path, monkeypatch):
    """Measured 2026-09-30: a fresh, never-prompted pane printed its banner (output > 0)
    and claimed the transcript of a Claude Code session running outside Studio in the same
    repo. Without --resume/--continue or user input there is no conversation to find."""
    wd = "C:/proj/fresh"
    d = _project_dir(tmp_path, monkeypatch, wd)
    _touch(d / "external-session.jsonl", age_seconds=2)
    s = _resume_session("t1", wd, pre_spawn_files={"external-session.jsonl"})
    s.resumed_at_spawn = False
    s.last_user_input_time = 0.0
    mgr = _manager_with_sessions({"t1": s})
    assert mgr._get_jsonl_path(s) is None
    assert s.claude_session_id is None


def test_in_terminal_resume_after_typing_still_claims(tmp_path, monkeypatch):
    wd = "C:/proj/typed"
    d = _project_dir(tmp_path, monkeypatch, wd)
    _touch(d / "resumed.jsonl", age_seconds=2)
    s = _resume_session("t1", wd, pre_spawn_files={"resumed.jsonl"})
    s.resumed_at_spawn = False
    s.last_user_input_time = time.monotonic()
    mgr = _manager_with_sessions({"t1": s})
    assert mgr._get_jsonl_path(s) == str(d / "resumed.jsonl")


def test_assigned_session_id_with_no_file_yet_never_infers(tmp_path, monkeypatch):
    """A pane Studio launched with --session-id knows its transcript. Before it writes
    one, a NEW file in the folder (another pane's) must not be taken -- measured
    2026-09-30, the older never-prompted pane claimed the newer pane's file."""
    wd = "C:/proj/assigned"
    d = _project_dir(tmp_path, monkeypatch, wd)
    _touch(d / "other-pane.jsonl", age_seconds=1)
    s = _resume_session("t1", wd, pre_spawn_files=set())
    s.claude_session_id = "my-assigned-id"
    s.session_id_assigned = True
    s.resumed_at_spawn = False
    s.last_user_input_time = 0.0
    mgr = _manager_with_sessions({"t1": s})
    assert mgr._get_jsonl_path(s) is None
    assert s.claude_session_id == "my-assigned-id"


def test_new_file_owned_by_another_live_session_is_not_taken(tmp_path, monkeypatch):
    wd = "C:/proj/owned"
    d = _project_dir(tmp_path, monkeypatch, wd)
    _touch(d / "theirs.jsonl", age_seconds=1)
    s = _resume_session("t1", wd, pre_spawn_files=set())
    s.resumed_at_spawn = False
    other = _fake_session("t2", "theirs")
    mgr = _manager_with_sessions({"t1": s, "t2": other})
    assert mgr._get_jsonl_path(s) is None
