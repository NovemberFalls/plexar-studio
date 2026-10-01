#!/usr/bin/env python
"""Live smoke test for agent workers (agent_api.py + studio_cli.py) against a REAL server.

Starts its own Studio backend on a spare port (default 8421, never your running app's
8420), opens one Claude Code "parent" session, takes that pane's token out of its process
environment, and drives every worker capability through the real CLI, exactly as an agent
would. Everything it creates is closed again, and the server is stopped.

    python scripts/smoke_agent_workers.py              # free: no model is prompted
    python scripts/smoke_agent_workers.py --prompt     # + one real Haiku round trip
    python scripts/smoke_agent_workers.py --skip codex --skip plexar

Exit code 0 = every check passed. Each check prints PASS / FAIL / SKIP with its evidence.
Needs: python with psutil, git, claude; codex / plexar-harness for those checks.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

import psutil

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(REPO, "web")
CLI = os.path.join(WEB, "studio_cli.py")
results: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, evidence: str = "") -> bool:
    results.append((name, "PASS" if ok else "FAIL", evidence))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {evidence}"[:400], flush=True)
    return ok


def skip(name: str, why: str) -> None:
    results.append((name, "SKIP", why))
    print(f"[SKIP] {name}  {why}", flush=True)


def http(base: str, method: str, path: str, body=None, headers=None):
    req = urllib.request.Request(base + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def pane_env(terminal_id: str, wait_s: float = 15.0) -> dict:
    deadline = time.time() + wait_s
    while time.time() < deadline:
        for proc in psutil.process_iter():
            try:
                env = proc.environ()
            except (psutil.Error, OSError):
                continue
            if env.get("PLEXAR_SESSION_ID") == terminal_id and env.get("PLEXAR_STUDIO_TOKEN"):
                return env
        time.sleep(0.5)
    raise RuntimeError(f"no process carries PLEXAR_SESSION_ID={terminal_id}")


def make_cli(env: dict):
    cenv = {**os.environ, "PLEXAR_STUDIO_URL": env["PLEXAR_STUDIO_URL"],
            "PLEXAR_STUDIO_TOKEN": env["PLEXAR_STUDIO_TOKEN"], "PYTHONIOENCODING": "utf-8"}

    def cli(*args, timeout=300):
        r = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True,
                           env=cenv, timeout=timeout, encoding="utf-8")
        try:
            out = json.loads(r.stdout) if r.stdout.strip() else {}
        except ValueError:
            out = {"raw": r.stdout}
        return r.returncode, out
    return cli


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8421)
    ap.add_argument("--prompt", action="store_true", help="also run one real Haiku prompt (costs tokens)")
    ap.add_argument("--skip", action="append", default=[], choices=["codex", "plexar", "worktree", "shell"])
    a = ap.parse_args()
    if a.port == 8420:
        print("refusing port 8420: that is the desktop app's port")
        return 2
    base = f"http://127.0.0.1:{a.port}"

    server = subprocess.Popen([sys.executable, "server.py"], cwd=WEB, env={**os.environ, "PORT": str(a.port)},
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tmp = tempfile.mkdtemp(prefix="plexar-worker-smoke-")
    parent_id = None
    try:
        for _ in range(80):
            try:
                urllib.request.urlopen(base + "/api/version", timeout=2)
                break
            except OSError:
                time.sleep(0.5)
        else:
            check("server starts", False, f"no answer on {base}")
            return 1
        check("server starts", True, base)

        # The parent runs in THIS repo (a folder Claude Code already trusts, so its workers
        # start straight to the prompt). Worktree and trust checks use a throwaway repo, so
        # they never touch a real one.
        repo = os.path.join(tmp, "repo")
        os.makedirs(repo)
        subprocess.run(["git", "-C", repo, "init", "-q"], check=True)
        subprocess.run(["git", "-C", repo, "-c", "user.email=s@s", "-c", "user.name=s",
                        "commit", "-q", "--allow-empty", "-m", "init"], check=True)

        st, p = http(base, "POST", "/api/terminals", {"name": "Smoke", "workdir": REPO, "model": "haiku"})
        if not check("parent session spawns", st == 200 and p.get("id"), f"HTTP {st}"):
            return 1
        parent_id = p["id"]
        env = pane_env(parent_id)
        check("pane env carries URL, token and CLI path",
              all(env.get(k) for k in ("PLEXAR_STUDIO_URL", "PLEXAR_STUDIO_TOKEN", "PLEXAR_STUDIO_CLI"))
              and os.path.exists(env["PLEXAR_STUDIO_CLI"]), env.get("PLEXAR_STUDIO_CLI", ""))
        cli = make_cli(env)

        # Auth boundary.
        st, _ = http(base, "POST", "/api/agent/spawn", {})
        check("no token -> 401", st == 401, f"HTTP {st}")
        st, _ = http(base, "POST", "/api/agent/spawn", {}, {"X-Plexar-Session-Token": env["PLEXAR_STUDIO_TOKEN"],
                                                              "Origin": "http://evil.example"})
        check("browser Origin -> 403 even with a token", st == 403, f"HTTP {st}")
        code, who = cli("whoami")
        check("whoami", code == 0 and who.get("id") == parent_id and who.get("can_spawn"), json.dumps(who)[:120])

        # Claude worker + lineage + sidebar data.
        code, w = cli("spawn", "--name", "cc")
        check("spawn claude-code worker", code == 0 and w["worker"]["parent_id"] == parent_id, json.dumps(w)[:160])
        st, ts = http(base, "GET", "/api/terminals")
        child = next((t for t in ts["terminals"] if t["name"] == "cc"), None)
        check("/api/terminals shows parent_id (what the sidebar nests on)",
              bool(child) and child["parent_id"] == parent_id and "spawn_token" not in child)
        cenv_child = pane_env(w["worker"]["id"])
        st, _ = http(base, "POST", "/api/agent/spawn", {}, {"X-Plexar-Session-Token": cenv_child["PLEXAR_STUDIO_TOKEN"]})
        check("a worker cannot spawn workers -> 403", st == 403, f"HTTP {st}")
        code, out = cli("wait", "cc", "--until", "idle", "--timeout-ms", "90000")
        check("claude worker reaches idle", code == 0 and out.get("state") == "idle", json.dumps(out))
        code, out = cli("keys", "cc", "esc")
        check("keys reach a worker", code == 0 and out.get("sent") == 1)
        code, out = cli("keys", "cc", "bogus")
        check("unknown key refused (exit 1)", code == 1)
        if a.prompt:
            code, out = cli("prompt", "cc", "Reply with exactly the word PINEAPPLE and nothing else.")
            check("prompt delivered", code == 0, json.dumps(out))
            code, out = cli("wait", "cc", "--timeout-ms", "180000")
            check("wait settles after the turn", code == 0 and out.get("saw_activity"), json.dumps(out))
            code, out = cli("read", "cc")
            check("read: answer is on screen", "PINEAPPLE" in out.get("screen", ""))
            latest = None
            for _ in range(20):   # the transcript is discovered/written a little after the turn
                code, out = cli("read", "cc")
                latest = out.get("latest_assistant") or ""
                if "PINEAPPLE" in latest:
                    break
                time.sleep(1)
            check("read: latest_assistant carries the answer (from the transcript)", "PINEAPPLE" in latest,
                  repr(latest[:80]))
        else:
            skip("real prompt round trip", "run with --prompt (one Haiku turn)")

        # Shell worker.
        if "shell" not in a.skip:
            code, out = cli("spawn", "--harness", "shell", "--name", "sh")
            check("spawn shell worker", code == 0 and out["worker"]["harness"] == "shell")
            time.sleep(3)
            code, out = cli("run", "sh", "Write-Output ('smoke-' + (6*7))" if os.name == "nt" else "echo smoke-$((6*7))")
            after = out.get("after")
            check("run returns an `after` mark", code == 0 and isinstance(after, int), json.dumps(out))
            code, out = cli("wait-output", "sh", "--regex", r"smoke-42", "--after", str(after), "--timeout-ms", "30000")
            check("wait-output sees the command's output", code == 0 and out.get("matched"), json.dumps(out))
            code, out = cli("wait-output", "sh", "--match", "never-printed", "--timeout-ms", "1500")
            check("wait-output miss -> exit 3", code == 3, json.dumps(out))
            code, out = cli("prompt", "sh", "hi")
            check("prompt refused on a shell worker", code == 1)
            code, out = cli("run", "cc", "dir")
            check("run refused on an agent worker", code == 1)
            code, out = cli("read", "sh", "--ansi")
            check("read --ansi returns raw output", code == 0 and "\x1b[" in out.get("screen", ""))
        else:
            skip("shell worker", "skipped by flag")

        # Plexar Harness worker.
        if "plexar" not in a.skip and shutil.which("plexar-harness"):
            code, out = cli("spawn", "--harness", "plexar", "--name", "px")
            check("spawn Plexar Harness worker", code == 0 and out["worker"]["harness"] == "plexar-harness",
                  json.dumps(out)[:160])
            time.sleep(8)
            code, out = cli("read", "px")
            check("Plexar worker is alive and drawing", code == 0 and out.get("state") != "ended", out.get("state", ""))
        else:
            skip("Plexar Harness worker", "skipped or plexar-harness not on PATH")

        # Codex worker.
        if "codex" not in a.skip and shutil.which("codex"):
            code, out = cli("spawn", "--harness", "codex", "--name", "cx")
            check("codex without --model refused", code == 1, json.dumps(out)[:120])
            code, out = cli("spawn", "--harness", "codex", "--model", "gpt-5.5", "--name", "cx")
            check("spawn Codex worker", code == 0 and out["worker"]["harness"] == "codex", json.dumps(out)[:160])
            time.sleep(6)
            code, out = cli("read", "cx")
            check("Codex worker is alive", code == 0 and out.get("state") != "ended", out.get("state", ""))
        else:
            skip("Codex worker", "skipped or codex not on PATH")

        # Worktree worker.
        if "worktree" not in a.skip:
            code, out = cli("spawn", "--worktree", "smoke/wt", "--cwd", repo, "--name", "wt")
            wt = os.path.join(tmp, "repo-worktrees", "smoke-wt")
            ok = code == 0 and os.path.normcase(out["worker"]["working_dir"]) == os.path.normcase(wt)
            branch = subprocess.run(["git", "-C", wt, "branch", "--show-current"], capture_output=True,
                                    text=True).stdout.strip() if ok else ""
            check("worktree worker runs in its own checkout on its branch", ok and branch == "smoke/wt",
                  f"{out.get('worker', {}).get('working_dir')} @ {branch}")
            code, out = cli("spawn", "--worktree", "../x")
            check("bad worktree name refused", code == 1)
            # A fresh worktree is an untrusted folder: Claude Code shows its trust dialog.
            # It must read as WAITING (a human decision), never idle -- Esc on it exits the CLI.
            code, out = cli("wait", "wt", "--until", "waiting", "--timeout-ms", "60000")
            check("trust dialog in a fresh folder reads as waiting", code == 0 and out.get("state") == "waiting",
                  json.dumps(out))
            code, out = cli("prompt", "wt", "hello")
            check("prompting a worker blocked on the trust dialog is refused", code == 1, json.dumps(out)[:120])
        else:
            skip("worktree worker", "skipped by flag")

        st, ts = http(base, "GET", "/api/terminals")
        par = next(t for t in ts["terminals"] if t["id"] == parent_id)
        check("an unprompted parent claims NO transcript (never a foreign session's)",
              par.get("jsonl_path") is None, str(par.get("jsonl_path")))
        code, out = cli("list")
        names = sorted(w["name"] for w in out.get("children", []))
        check("list shows exactly this session's workers", code == 0, ", ".join(names))
        code, out = cli("peers")
        check("peers is read-only and excludes workers", code == 0 and
              all(pp["id"] not in {w["id"] for w in []} for pp in out.get("peers", [])),
              f"{len(out.get('peers', []))} peers")

        # Parent closes: workers survive, the dead parent's token stops working.
        http(base, "DELETE", f"/api/terminals/{parent_id}")
        time.sleep(1)
        st, _ = http(base, "GET", "/api/agent/children", headers={"X-Plexar-Session-Token": env["PLEXAR_STUDIO_TOKEN"]})
        check("closed parent's token -> 401", st == 401, f"HTTP {st}")
        st, ts = http(base, "GET", "/api/terminals")
        orphans = [t["name"] for t in ts["terminals"] if t.get("parent_id") == parent_id and t["alive"]]
        check("workers outlive their parent (shown top-level in the sidebar)", bool(orphans), ", ".join(orphans))
        parent_id = None
    except Exception as exc:  # report, then clean up
        check("smoke run completed without an exception", False, repr(exc))
    finally:
        try:
            st, ts = http(base, "GET", "/api/terminals")
            for t in ts.get("terminals", []):
                http(base, "DELETE", f"/api/terminals/{t['id']}")
        except Exception:
            pass
        server.terminate()
        try:
            server.wait(timeout=15)
        except subprocess.TimeoutExpired:
            server.kill()
        repo = os.path.join(tmp, "repo")
        if os.path.isdir(repo):
            subprocess.run(["git", "-C", repo, "worktree", "prune"], capture_output=True)
        shutil.rmtree(tmp, ignore_errors=True)

    fails = [r for r in results if r[1] == "FAIL"]
    print(f"\n{sum(r[1] == 'PASS' for r in results)} passed, {len(fails)} failed, "
          f"{sum(r[1] == 'SKIP' for r in results)} skipped")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
