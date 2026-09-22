"""The updater's shutdown must not be undone by the supervisor.

THE DEFECT (reported: "every time he opens it it's asking him to redownload").
The updater POSTed /api/shutdown, waited 800 ms and started a 52 MB download.
The sidecar's exit looked like a crash to lib.rs, which restarted it after a 2 s
backoff -- mid-download. The fresh sidecar held plexar-studio-server.exe open,
NSIS could not replace it, the install did not take, and the next launch offered
the same update again.
"""
from __future__ import annotations

import os
import re
import sys
from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server as server_module  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..")


@pytest.mark.asyncio
async def test_update_shutdown_exits_with_the_no_restart_code():
    scheduled = []
    class _Loop:
        def call_later(self, delay, fn):
            scheduled.append(fn)
    with patch.object(server_module.asyncio, "get_event_loop", return_value=_Loop()), \
         patch.object(server_module.os, "_exit") as ex:
        async with AsyncClient(transport=ASGITransport(app=server_module.app),
                               base_url="http://127.0.0.1:8420") as c:
            r = await c.post("/api/shutdown?reason=update")
        assert r.status_code == 200
        scheduled[0]()
        ex.assert_called_once_with(server_module.UPDATE_EXIT_CODE)


def test_the_supervisor_stands_down_on_that_exact_code():
    """The Python half is worthless unless lib.rs honours it -- and the two
    numbers must be the same number."""
    lib = open(os.path.join(ROOT, "frontend", "src-tauri", "src", "lib.rs"), encoding="utf-8").read()
    m = re.search(r"if status\.code == Some\((\d+)\) \{\s*supervisor_log\(\"sidecar exited \d+: stopped for an update[^}]*break;", lib)
    assert m, "lib.rs must break (not restart) on the update exit code"
    assert int(m.group(1)) == server_module.UPDATE_EXIT_CODE


def test_the_updater_requests_the_update_exit_and_waits_for_it():
    app = open(os.path.join(ROOT, "frontend", "src", "App.jsx"), encoding="utf-8").read()
    assert "/api/shutdown?reason=update" in app
    assert "setTimeout(r, 800)" not in app, "a fixed 800 ms guess is what raced the respawn"
