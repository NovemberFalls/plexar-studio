"""Plexar Harness session client (contract v3) — what Studio vendors.

Stdlib only. Speaks ACP (agentclientprotocol.com) over the child's stdio to the
`plexar-acp` profile, so Studio can house sessions the way it does for Claude Code
and Codex: start, stop, list, resume, prompt, cancel, close, set model and effort,
and answer tool-permission prompts. Pinned by `check_api_drift.py` against
`docs/plexar/07-studio-api-contract.md`.
"""
from __future__ import annotations

import itertools
import json
import os
import queue
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator

CONTRACT_VERSION = "3"
PROTOCOL_VERSION = 1
REQUESTS = (
    "initialize", "session/new", "session/list", "session/resume", "session/prompt",
    "session/set_config_option", "session/close",
)
CLIENT_NOTIFICATIONS = ("session/cancel",)
SERVER_NOTIFICATIONS = ("session/update",)
SERVER_REQUESTS = ("session/request_permission",)
CONFIG_OPTIONS = ("model", "reasoning_effort")

DEFAULT_HARNESS_ROOT = Path(os.environ.get("PLEXAR_HARNESS_ROOT", r"C:\Code\Personal\plexar-harness"))

# Studio's decision for a tool-permission prompt: return "allow-once" or "reject-once".
PermissionHandler = Callable[[dict], str]


class HarnessError(RuntimeError):
    """A JSON-RPC error reply, a timeout, or the runtime exiting underneath a call.

    When the runtime exited, `exit_code` is its exit status and `reason` is the launcher's failure code
    (`node_too_old`, `key_missing`, `profile_install_failed`, `key_rejected`, `rig_unreachable`) parsed from
    its `plexar-harness: error <code>: ...` stderr line, or None when the exit had no such line.
    """

    def __init__(self, message: str, exit_code: int | None = None, reason: str | None = None) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.reason = reason


@dataclass
class Update:
    """One `session/update` notification."""

    session_id: str
    kind: str
    payload: dict


@dataclass
class HarnessRuntime:
    """One harness process for one workspace. Hosts many sessions; outlives none of them on disk."""

    workspace: Path
    profile: str = "plexar-acp"
    harness_root: Path = DEFAULT_HARNESS_ROOT
    node: str = "node"
    env: dict[str, str] = field(default_factory=dict)
    on_permission: PermissionHandler = lambda _req: "reject-once"

    def __post_init__(self) -> None:
        self.workspace = Path(self.workspace).resolve()
        self._ids = itertools.count(1)
        self._pending: dict[int, queue.Queue] = {}
        self._updates: queue.Queue[Update | None] = queue.Queue()
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self.stderr_tail: list[str] = []
        self.agent_info: dict = {}

    # -- process lifecycle: start / stop -------------------------------------------
    def command(self) -> list[str]:
        """Launcher first: `plexar-harness acp` found on PATH (run as `node <dir>/plexar-harness.mjs acp`, so no
        .cmd shim sits between Studio and the process). Without it, fall back to the source launch under
        `harness_root` (development only). The launcher's pre-ACP failures exit 10-14; see contract "Launch"."""
        found = shutil.which("plexar-harness")
        if found and self.profile == "plexar-acp":
            script = Path(found).resolve().parent / "plexar-harness.mjs"
            if script.exists():
                return [self.node, str(script), "acp"]
        loader = (self.harness_root / "node_modules/tsx/dist/esm/index.mjs").resolve().as_uri()
        return [self.node, "--import", loader, str(self.harness_root / "apps/cli/src/bin.ts"), "--profile", self.profile]

    def start(self, timeout: float = 120) -> dict:
        env = {**os.environ, "TSX_TSCONFIG_PATH": str(self.harness_root / "tsconfig.json"), **self.env}
        self._proc = subprocess.Popen(
            self.command(), cwd=self.workspace, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self.agent_info = self.request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False},
        }, timeout=timeout)
        return self.agent_info

    def stop(self, timeout: float = 30) -> int | None:
        """Stop the runtime. Sessions stay on disk and can be resumed by a later runtime."""
        if not self._proc:
            return None
        if self._proc.poll() is None:
            self._proc.stdin.close()
        try:
            return self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._proc.kill()
            return self._proc.wait()

    @property
    def running(self) -> bool:
        return self._proc is not None and self._proc.poll() is None

    def __enter__(self) -> "HarnessRuntime":
        self.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self.stop()

    # -- sessions --------------------------------------------------------------------
    def new_session(self) -> dict:
        """Create a persistent session. Returns {sessionId, configOptions}."""
        return self.request("session/new", {"cwd": str(self.workspace), "mcpServers": []})

    def list_sessions(self, cursor: str | None = None, this_workspace: bool = True) -> dict:
        """Newest-first page of resumable sessions: {sessions:[...], nextCursor?}."""
        params: dict[str, Any] = {}
        if this_workspace:
            params["cwd"] = str(self.workspace)
        if cursor:
            params["cursor"] = cursor
        return self.request("session/list", params)

    def resume_session(self, session_id: str) -> dict:
        return self.request("session/resume", {"sessionId": session_id, "cwd": str(self.workspace), "mcpServers": []})

    def close_session(self, session_id: str) -> dict:
        """Quiesce, flush and release one session; it stays resumable on disk."""
        return self.request("session/close", {"sessionId": session_id})

    def set_option(self, session_id: str, config_id: str, value: str) -> dict:
        if config_id not in CONFIG_OPTIONS:
            raise ValueError(f"{config_id!r} not in {CONFIG_OPTIONS}")
        return self.request("session/set_config_option", {"sessionId": session_id, "configId": config_id, "value": value})

    def set_model(self, session_id: str, model: str) -> dict:
        return self.set_option(session_id, "model", model)

    def set_effort(self, session_id: str, effort: str) -> dict:
        return self.set_option(session_id, "reasoning_effort", effort)

    def cancel(self, session_id: str) -> None:
        """Stop the prompt in flight; its `prompt()` returns stopReason `cancelled`."""
        self._send({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}})

    # -- prompting -------------------------------------------------------------------
    def prompt(self, session_id: str, text: str, timeout: float = 900) -> dict:
        """Run one turn to completion. Returns {stopReason}; updates arrive via updates()."""
        return self.request("session/prompt", {"sessionId": session_id, "prompt": [{"type": "text", "text": text}]}, timeout=timeout)

    def prompt_async(self, session_id: str, text: str, timeout: float = 900) -> threading.Thread:
        """Run a turn on a thread so Studio can cancel() it. Result lands in thread.result."""
        t = threading.Thread(target=lambda: setattr(t, "result", self._safe_prompt(session_id, text, timeout)), daemon=True)
        t.start()
        return t

    def _safe_prompt(self, session_id: str, text: str, timeout: float) -> dict:
        try:
            return self.prompt(session_id, text, timeout)
        except HarnessError as e:
            return {"error": str(e)}

    def updates(self, timeout: float | None = None) -> Iterator[Update]:
        """Every session/update for every session in this runtime; filter by session_id."""
        while True:
            try:
                item = self._updates.get(timeout=timeout)
            except queue.Empty:
                return
            if item is None:
                return
            yield item

    def drain(self, session_id: str) -> list[Update]:
        """Collect this session's already-arrived updates without blocking."""
        out, keep = [], []
        while True:
            try:
                u = self._updates.get_nowait()
            except queue.Empty:
                break
            if u is None:
                keep.append(u)
                break
            (out if u.session_id == session_id else keep).append(u)
        for u in keep:
            self._updates.put(u)
        return out

    # -- wire ------------------------------------------------------------------------
    def request(self, method: str, params: Any, timeout: float = 120) -> Any:
        if method not in REQUESTS:
            raise ValueError(f"{method!r} is not in contract v{CONTRACT_VERSION}")
        rid = next(self._ids)
        box: queue.Queue = queue.Queue(maxsize=1)
        self._pending[rid] = box
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        try:
            reply = box.get(timeout=timeout)
        except queue.Empty:
            raise HarnessError(f"{method}: no reply in {timeout}s; stderr: {self.stderr_tail[-5:]}") from None
        if reply is None:
            code = self._proc.wait(timeout=5) if self._proc else None
            reason = next((m.group(1) for line in reversed(self.stderr_tail)
                           if (m := re.match(r"plexar-harness: error (\w+):", line))), None)
            raise HarnessError(f"{method}: runtime exited ({code}); stderr: {self.stderr_tail[-5:]}", code, reason)
        if "error" in reply:
            raise HarnessError(f"{method}: {reply['error']}")
        return reply.get("result")

    def _send(self, frame: dict) -> None:
        with self._lock:
            self._proc.stdin.write(json.dumps(frame) + "\n")
            self._proc.stdin.flush()

    def _read_stdout(self) -> None:
        for line in self._proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                self.stderr_tail.append(f"[non-frame stdout] {line[:200]}")
                continue
            if "id" in msg and ("result" in msg or "error" in msg) and "method" not in msg:
                box = self._pending.pop(msg["id"], None)
                if box:
                    box.put(msg)
            elif msg.get("method") == "session/request_permission":
                threading.Thread(target=self._answer_permission, args=(msg,), daemon=True).start()
            elif msg.get("method") == "session/update":
                p = msg.get("params") or {}
                upd = p.get("update") or {}
                self._updates.put(Update(p.get("sessionId", ""), upd.get("sessionUpdate", "?"), upd))
            elif "id" in msg and "method" in msg:  # any other agent->client request: refuse, never hang it
                self._send({"jsonrpc": "2.0", "id": msg["id"], "error": {"code": -32601, "message": f"unsupported: {msg['method']}"}})
        for box in list(self._pending.values()):
            box.put(None)
        self._updates.put(None)

    def _answer_permission(self, msg: dict) -> None:
        try:
            choice = self.on_permission(msg.get("params") or {})
        except Exception:  # a crashing handler must not leave the agent waiting forever
            choice = "reject-once"
        outcome = {"outcome": "selected", "optionId": choice} if choice else {"outcome": "cancelled"}
        self._send({"jsonrpc": "2.0", "id": msg["id"], "result": {"outcome": outcome}})

    def _read_stderr(self) -> None:
        for line in self._proc.stderr:
            self.stderr_tail = (self.stderr_tail + [line.rstrip()])[-50:]


def text_of(updates: list[Update]) -> str:
    """Assistant answer text from a turn's updates (agent_message_chunk blocks)."""
    out = []
    for u in updates:
        if u.kind == "agent_message_chunk":
            c = u.payload.get("content") or {}
            if c.get("type") == "text":
                out.append(c.get("text", ""))
    return "".join(out).strip()


if __name__ == "__main__":  # smoke: python plexar_harness_client.py <workspace>
    import sys

    ws = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    with HarnessRuntime(ws) as rt:
        print("agent:", rt.agent_info.get("agentInfo") or rt.agent_info.get("protocolVersion"))
        s = rt.new_session()
        sid = s["sessionId"]
        print("session:", sid, "options:", [o.get("id") for o in s.get("configOptions", [])])
        print("effort off:", bool(rt.set_effort(sid, "off")))
        print("prompt:", rt.prompt(sid, "Reply with exactly PLEXAR_OK."))
        print("answer:", text_of(rt.drain(sid)))
        print("listed:", sid in [x.get("sessionId") for x in rt.list_sessions().get("sessions", [])])
        print("close:", rt.close_session(sid))
