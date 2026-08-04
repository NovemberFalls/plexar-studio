"""The PID files are per-instance, not per-directory.

Both files used to be one fixed path shared by every server started from `web/`,
which made them a cross-instance channel: a second server (a dev run, a test rig,
a probe on another port) read the LIVE server's tracked child PIDs and killed them
in `cleanup_orphans()` at startup. Starting a second copy killed the user's
running sessions.
"""

from __future__ import annotations

import os
import subprocess
import sys

import pty_manager


def _manager_on_port(monkeypatch, port: str) -> pty_manager.PtyManager:
    monkeypatch.setenv("PORT", port)
    return pty_manager.PtyManager()


def test_two_ports_do_not_share_a_child_pid_file(monkeypatch):
    """The arm the whole change exists for."""
    a = _manager_on_port(monkeypatch, "8420")
    b = _manager_on_port(monkeypatch, "8421")
    assert a._PID_TRACK_FILE != b._PID_TRACK_FILE


def test_a_second_instance_cannot_see_the_first_instances_pids(monkeypatch, tmp_path):
    """Stated as behaviour, not as a path comparison — a path test passes if both
    are wrong in the same way."""
    monkeypatch.setattr(pty_manager.PtyManager, "_PID_TRACK_DIR", str(tmp_path))
    live = _manager_on_port(monkeypatch, "8420")
    live._save_child_pid(4242)
    assert 4242 in live._load_child_pids()

    probe = _manager_on_port(monkeypatch, "8421")
    assert probe._load_child_pids() == set()  # would have been {4242}


def test_the_port_is_read_at_construction_not_at_import(monkeypatch, tmp_path):
    """A class-level constant would freeze the first port the process ever saw."""
    monkeypatch.setattr(pty_manager.PtyManager, "_PID_TRACK_DIR", str(tmp_path))
    monkeypatch.setenv("PORT", "9999")
    assert "9999" in pty_manager.PtyManager()._PID_TRACK_FILE


def test_default_port_instance_adopts_the_legacy_file_then_deletes_it(
    monkeypatch, tmp_path
):
    """Ignoring it outright would strand a crash's orphans forever, once."""
    monkeypatch.setattr(pty_manager.PtyManager, "_PID_TRACK_DIR", str(tmp_path))
    legacy = tmp_path / ".cockpit-child-pids"
    legacy.write_text("111\n222\n")
    monkeypatch.setattr(pty_manager.PtyManager, "_LEGACY_PID_TRACK_FILE", str(legacy))

    m = _manager_on_port(monkeypatch, "8420")
    m._migrate_legacy_pid_file()

    assert m._load_child_pids() == {111, 222}
    assert not legacy.exists()  # exactly once


def test_a_non_default_port_NEVER_adopts_the_legacy_file(monkeypatch, tmp_path):
    """The guard that keeps the migration from recreating the bug.

    The process that wrote the legacy file may be an older build that is STILL
    RUNNING. Adopting its PIDs from a dev server is precisely the cross-instance
    kill this scoping exists to prevent.
    """
    monkeypatch.setattr(pty_manager.PtyManager, "_PID_TRACK_DIR", str(tmp_path))
    legacy = tmp_path / ".cockpit-child-pids"
    legacy.write_text("111\n222\n")
    monkeypatch.setattr(pty_manager.PtyManager, "_LEGACY_PID_TRACK_FILE", str(legacy))

    m = _manager_on_port(monkeypatch, "8421")
    m._migrate_legacy_pid_file()

    assert m._load_child_pids() == set()
    assert legacy.exists()  # untouched — it is not ours to delete


def test_server_pid_file_is_port_scoped_and_agrees_with_the_manager():
    """The two files must scope the same way, or one says 'instance on 8421' and
    the other just says 'instance'.

    Run in a SUBPROCESS, deliberately. `server.PID_FILE` is resolved at import, so
    proving it VARIES with PORT needs a fresh import — and `importlib.reload(server)`
    does that by detonating module state every other test in the session depends on
    (measured: it turned a green suite into 20 failures and 57 errors). A child
    process is the isolation that a reload only pretends to be.
    """
    src = (
        "import os, sys; sys.path.insert(0, %r); "
        "import server; print(server.PID_FILE.name)" % os.path.dirname(pty_manager.__file__)
    )
    env = dict(os.environ, PORT="8421")
    out = subprocess.run(
        [sys.executable, "-c", src], capture_output=True, text=True, env=env, timeout=120
    )
    assert out.returncode == 0, out.stderr
    assert "8421" in out.stdout.strip(), out.stdout


def test_cleanup_orphans_on_a_second_port_kills_nothing(monkeypatch, tmp_path):
    """End-to-end on the actual failure: the live instance's children survive."""
    monkeypatch.setattr(pty_manager.PtyManager, "_PID_TRACK_DIR", str(tmp_path))
    monkeypatch.setattr(
        pty_manager.PtyManager,
        "_LEGACY_PID_TRACK_FILE",
        str(tmp_path / ".cockpit-child-pids"),
    )
    live = _manager_on_port(monkeypatch, "8420")
    live._save_child_pid(os.getpid())  # a real, live PID

    killed = []
    monkeypatch.setattr(pty_manager, "logger", pty_manager.logger)

    probe = _manager_on_port(monkeypatch, "8421")
    probe.cleanup_orphans()  # must find nothing to kill

    assert killed == []
    assert live._load_child_pids() == {os.getpid()}  # and must not clear ours
