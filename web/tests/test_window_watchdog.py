"""window_watchdog: replace a hung desktop window, never anything else."""

import sys

import pytest

import window_watchdog as ww


def test_not_due_until_hung_for_threshold():
    t = ww.HangTracker(hung_after=30, max_restarts=3, window=3600)
    assert t.observe(0, {10}) == []
    assert t.observe(29, {10}) == []
    assert t.observe(30, {10}) == [10]


def test_recovery_resets_the_clock():
    t = ww.HangTracker(hung_after=30)
    t.observe(0, {10})
    t.observe(20, set())  # pumped messages again
    assert t.observe(40, {10}) == []
    assert t.observe(70, {10}) == [10]


def test_restart_rate_limit():
    t = ww.HangTracker(hung_after=0, max_restarts=2, window=100)
    for now in (0, 1):
        assert t.observe(now, {now + 1}) == [now + 1]
        t.restarted(now + 1, now)
    assert t.observe(2, {9}) == []  # limit reached
    assert t.observe(101, {9}) == [9]  # first restart aged out


def test_enabled_flags(monkeypatch):
    monkeypatch.setenv("PLEXAR_WINDOW_WATCHDOG", "0")
    assert ww.enabled() is False
    monkeypatch.delenv("PLEXAR_WINDOW_WATCHDOG")
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert ww.enabled() is False  # dev / test servers never run it
    monkeypatch.setenv("PLEXAR_WINDOW_WATCHDOG", "1")
    assert ww.enabled() is (sys.platform == "win32")


class _Proc:
    def __init__(self, name):
        self._name = name
        self.killed = False

    def name(self):
        return self._name

    def exe(self):
        return "C:/x/" + self._name

    def kill(self):
        self.killed = True

    def wait(self, timeout=None):
        return 0


def test_replace_refuses_anything_but_the_window(monkeypatch, tmp_path):
    import psutil
    proc = _Proc("plexar-studio-server.exe")
    monkeypatch.setattr(psutil, "Process", lambda pid: proc)
    monkeypatch.setattr(ww, "_write_dump", lambda *a: pytest.fail("dumped a non-window"))
    assert ww._replace(1, tmp_path) is False
    assert proc.killed is False


def test_replace_dumps_before_kill_then_relaunches(monkeypatch, tmp_path):
    import psutil
    order = []
    proc = _Proc(ww.WINDOW_EXE)
    proc.kill = lambda: order.append("kill")
    monkeypatch.setattr(psutil, "Process", lambda pid: proc)
    monkeypatch.setattr(ww, "_write_dump", lambda pid, d: order.append("dump"))
    monkeypatch.setattr(ww.subprocess, "Popen", lambda argv, **k: order.append(("launch", argv)))
    if not hasattr(ww.subprocess, "DETACHED_PROCESS"):
        monkeypatch.setattr(ww.subprocess, "DETACHED_PROCESS", 0, raising=False)
        monkeypatch.setattr(ww.subprocess, "CREATE_NEW_PROCESS_GROUP", 0, raising=False)
    assert ww._replace(1, tmp_path) is True
    assert order == ["dump", "kill", ("launch", ["C:/x/" + ww.WINDOW_EXE])]


@pytest.mark.skipif(sys.platform != "win32", reason="Win32 window enumeration")
def test_window_probe_runs_on_this_machine():
    result = ww._window_pids()
    assert isinstance(result, dict)
    assert all(isinstance(v, bool) for v in result.values())


@pytest.mark.skipif(sys.platform != "win32", reason="MiniDumpWriteDump")
def test_dump_of_a_real_process(tmp_path):
    import subprocess
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        path = ww._write_dump(child.pid, tmp_path)
        assert path is not None and path.stat().st_size > 0
    finally:
        child.kill()
