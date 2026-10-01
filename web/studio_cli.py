#!/usr/bin/env python
"""plexar-studio workers CLI -- the agent-facing front of /api/agent/* (agent_api.py).

Runs inside a Studio pane, where PLEXAR_STUDIO_URL and PLEXAR_STUDIO_TOKEN are set:

    python "$PLEXAR_STUDIO_CLI" spawn --name reviewer --prompt "Review the diff"
    python "$PLEXAR_STUDIO_CLI" spawn --harness shell --name tests
    python "$PLEXAR_STUDIO_CLI" spawn --harness plexar --worktree feat/x --prompt "..."
    python "$PLEXAR_STUDIO_CLI" run tests "npm test"            # prints the `after` mark
    python "$PLEXAR_STUDIO_CLI" wait-output tests --regex "passed|failed" --after 42
    python "$PLEXAR_STUDIO_CLI" prompt reviewer "Now check the tests"
    python "$PLEXAR_STUDIO_CLI" wait reviewer
    python "$PLEXAR_STUDIO_CLI" read reviewer --lines 120
    python "$PLEXAR_STUDIO_CLI" keys reviewer esc
    python "$PLEXAR_STUDIO_CLI" list | peers | whoami
    python "$PLEXAR_STUDIO_CLI" close reviewer

Every command prints the server's JSON. Exit code: 0 ok, 1 refused (4xx/5xx, the error
is printed), 2 not inside a Studio pane, 3 a wait timed out / stalled / did not match.
Stdlib only, so it runs on any Python the agent already has.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request


def _call(method: str, path: str, body: dict | None = None, query: dict | None = None,
          timeout: float = 60.0):
    base = os.environ.get("PLEXAR_STUDIO_URL", "").rstrip("/")
    token = os.environ.get("PLEXAR_STUDIO_TOKEN", "")
    if not base or not token:
        print("not inside a Plexar Studio pane (PLEXAR_STUDIO_URL / PLEXAR_STUDIO_TOKEN unset)",
              file=sys.stderr)
        sys.exit(2)
    url = base + path
    if query:
        url += "?" + urllib.parse.urlencode({k: v for k, v in query.items() if v is not None})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "X-Plexar-Session-Token": token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return 0, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read() or b"{}")
        except ValueError:
            payload = {"error": f"HTTP {exc.code}"}
        return 1, payload
    except urllib.error.URLError as exc:
        return 1, {"error": f"Studio unreachable: {exc.reason}"}


def _ref(name: str) -> str:
    return urllib.parse.quote(name, safe="")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="plexar-studio", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami")
    sub.add_parser("list", help="your live workers")
    sub.add_parser("peers", help="the user's other sessions (read-only)")
    sp = sub.add_parser("spawn")
    sp.add_argument("--name")
    sp.add_argument("--harness", help="claude-code | codex | plexar (plexar-harness) | shell")
    sp.add_argument("--model")
    sp.add_argument("--effort")
    sp.add_argument("--cwd")
    sp.add_argument("--worktree", help="branch for a fresh git worktree (created if missing)")
    sp.add_argument("--prompt", help="initial prompt; '-' reads it from stdin")
    pp = sub.add_parser("prompt")
    pp.add_argument("worker")
    pp.add_argument("text", help="'-' reads from stdin")
    rp = sub.add_parser("run")
    rp.add_argument("worker")
    rp.add_argument("command")
    wp = sub.add_parser("wait")
    wp.add_argument("worker")
    wp.add_argument("--until", default="settled", choices=["settled", "idle", "waiting"])
    wp.add_argument("--timeout-ms", type=int, default=600_000)
    wo = sub.add_parser("wait-output")
    wo.add_argument("worker")
    g = wo.add_mutually_exclusive_group(required=True)
    g.add_argument("--match")
    g.add_argument("--regex")
    wo.add_argument("--after", type=int)
    wo.add_argument("--timeout-ms", type=int, default=600_000)
    rd = sub.add_parser("read")
    rd.add_argument("worker")
    rd.add_argument("--lines", type=int, default=80)
    rd.add_argument("--ansi", action="store_true")
    kp = sub.add_parser("keys")
    kp.add_argument("worker")
    kp.add_argument("keys", nargs="+", help="esc, ctrl+c, enter, up, down, tab, y, n, ...")
    cp = sub.add_parser("close")
    cp.add_argument("worker")
    a = p.parse_args(argv)

    def stdin_or(v):
        return sys.stdin.read() if v == "-" else v

    wait_timeout = None
    if a.cmd == "whoami":
        code, out = _call("GET", "/api/agent/whoami")
    elif a.cmd == "list":
        code, out = _call("GET", "/api/agent/children")
    elif a.cmd == "peers":
        code, out = _call("GET", "/api/agent/peers")
    elif a.cmd == "spawn":
        body = {k: v for k, v in {"name": a.name, "harness": a.harness, "model": a.model,
                                   "effort": a.effort, "cwd": a.cwd, "worktree": a.worktree,
                                   "prompt": stdin_or(a.prompt) if a.prompt else None}.items()
                if v is not None}
        code, out = _call("POST", "/api/agent/spawn", body, timeout=180)
    elif a.cmd == "prompt":
        code, out = _call("POST", f"/api/agent/{_ref(a.worker)}/prompt", {"text": stdin_or(a.text)})
    elif a.cmd == "run":
        code, out = _call("POST", f"/api/agent/{_ref(a.worker)}/run", {"command": a.command})
    elif a.cmd == "wait":
        wait_timeout = a.timeout_ms
        code, out = _call("GET", f"/api/agent/{_ref(a.worker)}/wait",
                          query={"until": a.until, "timeout_ms": a.timeout_ms},
                          timeout=a.timeout_ms / 1000 + 30)
    elif a.cmd == "wait-output":
        wait_timeout = a.timeout_ms
        code, out = _call("GET", f"/api/agent/{_ref(a.worker)}/wait-output",
                          query={"match": a.match, "regex": a.regex, "after": a.after,
                                 "timeout_ms": a.timeout_ms},
                          timeout=a.timeout_ms / 1000 + 30)
    elif a.cmd == "read":
        code, out = _call("GET", f"/api/agent/{_ref(a.worker)}/read",
                          query={"lines": a.lines, "format": "ansi" if a.ansi else "text"})
    elif a.cmd == "keys":
        code, out = _call("POST", f"/api/agent/{_ref(a.worker)}/keys", {"keys": a.keys})
    else:  # close
        code, out = _call("DELETE", f"/api/agent/{_ref(a.worker)}")

    print(json.dumps(out, indent=2))
    if code:
        return 1
    if wait_timeout is not None and (out.get("timed_out") or out.get("stalled")
                                     or out.get("matched") is False):
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
