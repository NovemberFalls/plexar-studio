"""N03 — uvicorn's WebSocket keepalive must not turn a loop stall into a mass
disconnect.

uvicorn 0.34's defaults are ws_ping_interval=20.0 / ws_ping_timeout=20.0: any
event-loop stall longer than 20s (measured: a GIL-holding psutil scan) makes
uvicorn close EVERY open /ws/terminal socket with 1011 "keepalive ping
timeout" the instant the loop frees up, even though the app's own 30s
heartbeat + client-side replay-from-cursor already make the server-side ping
redundant as a liveness signal. server.main() must widen ws_ping_timeout so a
stall shorter than the Tauri watchdog's own tolerance self-heals via
reconnect instead of a hard close, while leaving log_config=None (load-bearing
per CLAUDE.md -- uvicorn's default dictConfig strips its own loggers'
handlers, which is how a bind-error [Errno 10048] stays out of cockpit.log).
"""

import uvicorn

import instance_guard
import server as server_module


def _patch_uvicorn_run(monkeypatch):
    """Replace uvicorn.run with a stub that records its kwargs instead of
    binding a real port. Mirrors tests/test_server.py's _patch_uvicorn_run.
    """
    captured = {}

    def fake_run(app, host, port, **kwargs):
        captured["host"] = host
        captured["port"] = port
        captured["log_config"] = kwargs.get("log_config", "unset")
        captured["ws_ping_interval"] = kwargs.get("ws_ping_interval", "unset")
        captured["ws_ping_timeout"] = kwargs.get("ws_ping_timeout", "unset")

    monkeypatch.setattr(uvicorn, "run", fake_run)
    monkeypatch.setattr(
        instance_guard, "resolve_port",
        lambda host, port, **kw: instance_guard.PortVerdict("free", None, None, "stubbed"),
    )
    return captured


def test_main_passes_widened_ws_keepalive_kwargs(monkeypatch):
    """main() must hand uvicorn.run the exact widened keepalive values.

    WATCH-TO-FAIL: this must go RED if server.py stops passing these kwargs,
    or reverts to uvicorn's bare defaults (20.0/20.0) -- silently dropping
    back to 20s would reintroduce the mass-disconnect this test exists to
    catch, and a test that only checked "some value was passed" would not
    notice a regression to the very defaults it is meant to widen past.
    """
    monkeypatch.delenv("HOST", raising=False)
    monkeypatch.setenv("PORT", "18421")
    monkeypatch.setenv("NO_BROWSER", "1")

    captured = _patch_uvicorn_run(monkeypatch)

    server_module.main()

    # log_config=None stays load-bearing (CLAUDE.md) -- must not regress
    # alongside this change.
    assert captured["log_config"] is None
    assert captured["ws_ping_interval"] == server_module._WS_PING_INTERVAL_S
    assert captured["ws_ping_timeout"] == server_module._WS_PING_TIMEOUT_S
    # Pin the exact numbers too, independent of the module constants, so a
    # change to the constants' values is a deliberate, visible edit here.
    assert captured["ws_ping_interval"] == 20.0
    assert captured["ws_ping_timeout"] == 120.0
    # The timeout must exceed uvicorn's bare default: the whole point is to
    # tolerate a stall longer than 20s.
    assert captured["ws_ping_timeout"] > 20.0
