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
    python "$PLEXAR_STUDIO_CLI" clear reviewer --then-prompt "Read BOOT.md"   # confirmed reset
    python "$PLEXAR_STUDIO_CLI" adopt FW-World           # the user approves in the desktop
    python "$PLEXAR_STUDIO_CLI" self-refresh --prompt "Read HANDOFF.md"   # needs approval
    python "$PLEXAR_STUDIO_CLI" events --follow          # one JSON line per worker event
    python "$PLEXAR_STUDIO_CLI" roster up --file agents.json [--only A,B] [--adopt]
    python "$PLEXAR_STUDIO_CLI" roster status --file agents.json

Every command prints the server's JSON. Exit code: 0 ok, 1 refused (4xx/5xx, the error
is printed), 2 not inside a Studio pane, 3 a wait timed out / stalled / did not match,
a clear was not confirmed, or an approval is denied / expired / failed / still pending.
Stdlib only, so it runs on any Python the agent already has.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
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


def _wait_approval(out: dict, wait_s: float) -> tuple[int, dict]:
    """Block until the user answers a pending approval (or wait_s passes)."""
    a = out.get("approval")
    if not a or a.get("status") != "pending" or wait_s <= 0:
        return 0, out
    deadline = time.monotonic() + wait_s
    while a.get("status") == "pending" and time.monotonic() < deadline:
        step = min(120.0, max(deadline - time.monotonic(), 0.1))
        code, got = _call("GET", f"/api/agent/approvals/{_ref(a['id'])}",
                          query={"wait_ms": int(step * 1000)}, timeout=step + 30)
        if code:
            return code, got
        a = got["approval"]
    return 0, {"approval": a}


def _roster_rows(path: str, only: str | None) -> list[dict]:
    """agents.json rows. Accepts a plain {"agents": [{"name", ...}]} and the Fellwake
    shape (session_name, boot_file, legacy_names, spawn: up | on_demand | external)."""
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    picked = {x.strip() for x in only.split(",")} if only else None
    rows = []
    for r in doc.get("agents", []):
        name = r.get("session_name") or r.get("name")
        if not name:
            continue
        rid = r.get("id") or name
        kind = r.get("spawn", "up")
        wanted = (picked is None and kind == "up") or (
            picked is not None and (rid in picked or name in picked) and kind != "external")
        prompt = r.get("prompt") or (
            f"Read {r['boot_file']} and follow it as your standing instructions."
            if r.get("boot_file") else None)
        body = {k: v for k, v in {"name": name, "harness": r.get("harness"),
                                   "model": r.get("model"), "effort": r.get("effort"),
                                   "cwd": r.get("cwd"), "prompt": prompt}.items() if v}
        rows.append({"id": rid, "name": name, "also": list(r.get("legacy_names") or []),
                     "kind": kind, "wanted": wanted, "body": body})
    return rows


def _roster(a) -> tuple[int, dict]:
    """Per row: live (your worker), live_elsewhere (another session's: --adopt asks
    for it), or down (`up` spawns it). Never spawns a twin of a live name."""
    code, mine = _call("GET", "/api/agent/children")
    if code:
        return code, mine
    code, others = _call("GET", "/api/agent/peers")
    if code:
        return code, others
    report, failed = [], False
    for r in _roster_rows(a.file, a.only):
        names = [r["name"]] + r["also"]
        own = next((w for w in mine["children"] if w["name"] in names), None)
        peer = next((p for p in others["peers"] if p["name"] in names), None)
        entry = {"id": r["id"], "name": r["name"], "spawn": r["kind"]}
        if own:
            entry.update(status="live", worker=own["id"], live_as=own["name"])
        elif peer:
            entry.update(status="live_elsewhere", session=peer["id"], live_as=peer["name"],
                         parent_name=peer.get("parent_name"))
            if a.action == "up" and a.adopt and r["wanted"] and not a.dry_run:
                c, out = _call("POST", "/api/agent/adopt", {"peer": peer["id"]})
                entry["adopt"] = out.get("approval") or out
                failed |= bool(c)
        else:
            entry["status"] = "down"
            if a.action == "up" and r["wanted"]:
                if a.dry_run:
                    entry["would_spawn"] = r["body"]
                else:
                    c, out = _call("POST", "/api/agent/spawn", r["body"], timeout=180)
                    entry.update(status="spawned" if not c else "spawn_failed",
                                 result=out.get("worker", out))
                    failed |= bool(c)
        report.append(entry)
    return (1 if failed else 0), {"roster": report}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="plexar-studio", description=__doc__.split("\n\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami")
    sub.add_parser("list", help="your live workers")
    sub.add_parser("peers", help="every other live session (read-only; adopt to control)")
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
    cl = sub.add_parser("clear", help="reset a worker's conversation, confirmed")
    cl.add_argument("worker")
    cl.add_argument("--then-prompt", help="boot line to submit after; '-' reads stdin")
    ad = sub.add_parser("adopt", help="ask the user to make a peer one of your workers")
    ad.add_argument("peer", help="session id or name from `peers`")
    ad.add_argument("--wait-s", type=float, default=600, help="0 returns at once (pending)")
    sr = sub.add_parser("self-refresh", help="clear YOURSELF and restart on a boot line")
    sr.add_argument("--prompt", required=True, help="'-' reads stdin")
    ap = sub.add_parser("approval", help="status of an adopt / self-refresh request")
    ap.add_argument("id")
    ap.add_argument("--wait-s", type=float, default=0)
    ev = sub.add_parser("events", help="worker idle / asking / ended / gone events")
    ev.add_argument("--after", type=int)
    ev.add_argument("--timeout-ms", type=int, default=60_000)
    ev.add_argument("--follow", action="store_true",
                    help="never return: one JSON line per event (run it under Monitor)")
    ro = sub.add_parser("roster", help="bring a named set of workers up from a file")
    ro.add_argument("action", choices=["up", "status"])
    ro.add_argument("--file", required=True)
    ro.add_argument("--only", help="comma-separated ids or names")
    ro.add_argument("--adopt", action="store_true",
                    help="request adoption of rows already live in another session")
    ro.add_argument("--dry-run", action="store_true")
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
    elif a.cmd == "close":
        code, out = _call("DELETE", f"/api/agent/{_ref(a.worker)}")
    elif a.cmd == "clear":
        body = {"then_prompt": stdin_or(a.then_prompt)} if a.then_prompt else {}
        code, out = _call("POST", f"/api/agent/{_ref(a.worker)}/clear", body, timeout=120)
    elif a.cmd == "adopt":
        code, out = _call("POST", "/api/agent/adopt", {"peer": a.peer})
        if not code:
            code, out = _wait_approval(out, a.wait_s)
    elif a.cmd == "self-refresh":
        # Never waits: the refresh runs once THIS turn ends, so the agent must end it.
        code, out = _call("POST", "/api/agent/self/refresh", {"prompt": stdin_or(a.prompt)})
    elif a.cmd == "approval":
        code, out = _call("GET", f"/api/agent/approvals/{_ref(a.id)}")
        if not code:
            code, out = _wait_approval(out, a.wait_s)
    elif a.cmd == "events" and a.follow:
        after = a.after
        while True:
            code, out = _call("GET", "/api/agent/events",
                              query={"after": after, "timeout_ms": 60_000}, timeout=120)
            if code:
                print(json.dumps(out), flush=True)
                time.sleep(5)
                continue
            for e in out["events"]:
                print(json.dumps(e), flush=True)
            after = out["next"]
    elif a.cmd == "events":
        code, out = _call("GET", "/api/agent/events",
                          query={"after": a.after, "timeout_ms": a.timeout_ms},
                          timeout=a.timeout_ms / 1000 + 30)
    else:  # roster
        code, out = _roster(a)

    print(json.dumps(out, indent=2))
    if code:
        return 1
    if wait_timeout is not None and (out.get("timed_out") or out.get("stalled")
                                     or out.get("matched") is False):
        return 3
    if a.cmd == "clear" and out.get("confirmed") is False:
        return 3
    if a.cmd in ("adopt", "approval") and (out.get("approval") or {}).get("status") in (
            "pending", "denied", "expired", "failed"):
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
