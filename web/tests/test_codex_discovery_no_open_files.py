"""Rollout discovery is a directory scan, and MUST NOT enumerate handles (R-194).

`psutil.Process.open_files()` enumerates every handle on the machine on Windows
and holds the GIL for the whole call: 2.9 s per scan measured 2026-09-11 against
a live nine-process Codex tree, with a competing Python thread reduced to 38% of
its rate. It ran on periodic paths (`refresh_codex_usage` from the ingest loop's
executor, and the sync usage route), so the asyncio loop stalled, the Tauri
watchdog stopped getting `/api/version` answers, and the sidecar — with every
session in it — was killed. The structural test below is the guard: it makes the
call raise, so any future re-introduction on these paths fails loudly.

The behavioural half pins what replaced it: candidates are rollout files in the
session's cwd created or written at/after its spawn time, minus claimed paths.
"""

import json
import os
import threading
import time
from types import SimpleNamespace

import pytest

import codex_usage
from codex_usage import discover_rollout
from pty_manager import PtyManager


def _set_creation_time(path, when):
    """Windows records creation time in st_ctime and os.utime does not move it,
    so a test about age has to set it the way the OS does."""
    if os.name != "nt":
        return                       # POSIX has no birth time here; mtime is used
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateFileW.restype = wintypes.HANDLE
    handle = kernel32.CreateFileW(str(path), 0x100, 0, None, 3, 0x80, None)
    if handle in (None, wintypes.HANDLE(-1).value, -1):
        raise OSError(f"cannot open {path} to set its creation time")
    try:
        ticks = int((when + 11644473600) * 10_000_000)
        stamp = wintypes.FILETIME(ticks & 0xFFFFFFFF, ticks >> 32)
        if not kernel32.SetFileTime(wintypes.HANDLE(handle), ctypes.byref(stamp), None, None):
            raise OSError(f"cannot set the creation time of {path}")
    finally:
        kernel32.CloseHandle(wintypes.HANDLE(handle))


def write_rollout(path, cwd, identity, *, born, source="cli", thread_source="user"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "session_meta", "payload": {
        "id": identity, "cwd": str(cwd), "source": source, "thread_source": thread_source,
    }}) + "\n", encoding="utf-8")
    # Both stamps: discovery accepts a file when EITHER its creation or its last
    # write is inside the window, which is what lets a resumed rollout bind.
    os.utime(path, (born, born))
    _set_creation_time(path, born)
    return path


@pytest.fixture()
def no_open_files(monkeypatch):
    import psutil

    def forbidden(self, *args, **kwargs):
        raise AssertionError("open_files() must never run on a discovery path")

    monkeypatch.setattr(psutil.Process, "open_files", forbidden, raising=True)


def test_discovery_never_enumerates_process_handles(tmp_path, no_open_files):
    root = tmp_path / "sessions"
    write_rollout(root / "rollout-a.jsonl", tmp_path, "sid-a", born=time.time())
    assert discover_rollout(os.getpid(), str(tmp_path), sessions_root=root).name == "rollout-a.jsonl"


def test_refresh_codex_usage_never_enumerates_process_handles(tmp_path, no_open_files, monkeypatch):
    root = tmp_path / "sessions"
    rollout = write_rollout(root / "rollout-a.jsonl", tmp_path, "sid-a", born=time.time())
    monkeypatch.setenv("CODEX_HOME", str(tmp_path))
    session = SimpleNamespace(
        id="owned", harness="codex", alive=True,
        pty=SimpleNamespace(pid=os.getpid(), isalive=lambda: True), working_dir=str(tmp_path),
        codex_usage_lock=threading.Lock(), codex_usage_checked=0,
        codex_rollout_path=None, codex_usage_reader=None, codex_session_id=None,
        codex_usage={}, effort="high", created_at="2026-09-11T00:00:00+00:00",
    )
    manager = object.__new__(PtyManager)
    manager.sessions = {session.id: session}
    manager.refresh_codex_usage(session)
    assert session.codex_rollout_path == str(rollout.resolve())
    assert session.codex_session_id == "sid-a"


def test_only_a_rollout_from_after_the_spawn_binds(tmp_path):
    root = tmp_path / "sessions"
    spawn = time.time() - 300
    old = write_rollout(root / "rollout-old.jsonl", tmp_path, "sid-old", born=spawn - 86400)
    new = write_rollout(root / "rollout-new.jsonl", tmp_path, "sid-new", born=spawn + 10)
    assert discover_rollout(123, str(tmp_path), sessions_root=root, spawned_at=spawn) == new.resolve()
    # Without a spawn time both are in the 24 h window and ambiguity is unknown.
    os.utime(old, (time.time(), time.time()))
    assert discover_rollout(123, str(tmp_path), sessions_root=root) is None


def test_a_claimed_path_is_skipped_and_expected_id_disambiguates(tmp_path):
    root = tmp_path / "sessions"
    now = time.time()
    first = write_rollout(root / "rollout-first.jsonl", tmp_path, "sid-1", born=now - 60)
    second = write_rollout(root / "rollout-second.jsonl", tmp_path, "sid-2", born=now)
    assert discover_rollout(123, str(tmp_path), claimed_paths=[second],
                            sessions_root=root) == first.resolve()
    assert discover_rollout(123, str(tmp_path), sessions_root=root,
                            expected_session_id="sid-1") == first.resolve()
    assert discover_rollout(123, str(tmp_path), sessions_root=root,
                            expected_session_id="sid-absent") is None
    # Several unclaimed candidates WITH a spawn time: the newest created wins,
    # the documented departure from "never search by recency".
    assert discover_rollout(123, str(tmp_path), sessions_root=root,
                            spawned_at=now - 600) == second.resolve()


def test_an_exact_expected_id_binds_a_rollout_older_than_the_spawn_window(tmp_path):
    """`codex resume <id>`: the rollout predates the pane and is not written to
    until the first turn, so the spawn window cannot see it — but the id is
    unique, so an exact match is safe and must bind immediately."""
    root = tmp_path / "sessions"
    now = time.time()
    old = write_rollout(root / "rollout-old-aaaa.jsonl", tmp_path, "old", born=now - 3600)
    write_rollout(root / "rollout-new-bbbb.jsonl", tmp_path, "new", born=now - 5)
    assert discover_rollout(123, str(tmp_path), sessions_root=root, spawned_at=now - 60,
                            expected_session_id="old") == old.resolve()
    # Reachable from a day directory well outside the spawn window too.
    buried = write_rollout(root / "2019" / "05" / "04" / "rollout-old-cccc.jsonl",
                           tmp_path, "buried", born=now - 3600)
    assert discover_rollout(123, str(tmp_path), sessions_root=root, spawned_at=now - 60,
                            expected_session_id="buried") == buried.resolve()
    # The other filters are untouched: claimed, and the window for the no-id case.
    assert discover_rollout(123, str(tmp_path), sessions_root=root, spawned_at=now - 60,
                            claimed_paths=[old], expected_session_id="old") is None
    assert discover_rollout(123, str(tmp_path), sessions_root=root,
                            spawned_at=now - 60).name == "rollout-new-bbbb.jsonl"


def test_day_directories_are_scanned_and_the_rest_of_the_tree_is_not(tmp_path):
    root = tmp_path / "sessions"
    today = time.localtime()
    nested = root / f"{today.tm_year:04d}" / f"{today.tm_mon:02d}" / f"{today.tm_mday:02d}" / "rollout-day.jsonl"
    write_rollout(nested, tmp_path, "sid-day", born=time.time())
    buried = root / "1999" / "01" / "01" / "rollout-ancient.jsonl"
    write_rollout(buried, tmp_path, "sid-ancient", born=time.time())
    assert discover_rollout(123, str(tmp_path), sessions_root=root) == nested.resolve()


def test_spawn_epoch_reads_the_session_timestamp_format():
    assert codex_usage.spawn_epoch("2026-09-11T00:00:00+00:00") == pytest.approx(1789084800, abs=1)
    assert codex_usage.spawn_epoch("2026-09-11T00:00:00Z") == codex_usage.spawn_epoch("2026-09-11T00:00:00")
    assert codex_usage.spawn_epoch("not a timestamp") is None
    assert codex_usage.spawn_epoch(None) is None
    assert codex_usage.spawn_epoch(1789084800) == 1789084800.0
