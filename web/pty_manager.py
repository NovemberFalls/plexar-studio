"""PTY session manager for Claude Cockpit.

Spawns interactive Claude CLI processes via Windows ConPTY (pywinpty)
and bridges them to WebSocket connections.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import sys
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Optional

import settings_store

logger = logging.getLogger("cockpit.pty")

# Inter-chunk delay for large PTY writes.  ConPTY's input pipe buffer is
# shallower than winpty's; a 10 ms pause between 200-byte chunks gives the
# pseudoconsole host (claude.exe) enough time to drain the pipe before the
# next chunk arrives.  sleep(0) was enough for winpty but caused silent byte
# drops on the desktop (Tauri/ConPTY) build with large bracketed-paste blocks.
# Halved chunk size + tripled delay compared to earlier defaults to address
# paste fragmentation on ~400-byte pastes where ConPTY silently drops bytes.
_INTER_CHUNK_DELAY = 0.010

# Environment override letting a user point cockpit at a `claude` binary that
# lives somewhere none of the standard installers use.
_CLAUDE_CLI_PATH_ENV = "CLAUDE_CLI_PATH"


class ClaudeCliNotFound(FileNotFoundError):
    """Raised when no `claude` executable can be located.

    Subclasses FileNotFoundError so existing `except FileNotFoundError`
    handlers (server.py's spawn route) keep working unchanged, while callers
    that want the searched-location detail can read `.searched`.
    """

    def __init__(self, message: str, searched: list[str] | None = None):
        super().__init__(message)
        self.searched = searched or []


def _candidate_claude_dirs() -> list[str]:
    """Directories the official Claude Code installers write `claude` into.

    Probed only as a fallback when the inherited PATH does not contain the CLI
    — which happens whenever cockpit is launched from a process whose PATH
    snapshot predates the install (Explorer, a long-running shell, the Tauri
    desktop app started before `claude` was installed).
    """
    home = os.path.expanduser("~")
    if sys.platform == "win32":
        user_profile = os.environ.get("USERPROFILE", home)
        appdata = os.environ.get(
            "APPDATA", os.path.join(user_profile, "AppData", "Roaming")
        )
        local_appdata = os.environ.get(
            "LOCALAPPDATA", os.path.join(user_profile, "AppData", "Local")
        )
        return [
            os.path.join(user_profile, ".local", "bin"),   # native installer
            os.path.join(appdata, "npm"),                  # npm -g
            os.path.join(local_appdata, "Programs", "claude"),
            os.path.join(user_profile, "bin"),
        ]
    return [
        os.path.join(home, ".local", "bin"),   # native installer
        "/usr/local/bin",
        "/opt/homebrew/bin",                   # Homebrew on Apple Silicon
        os.path.join(home, ".npm-global", "bin"),
        os.path.join(home, ".bun", "bin"),
    ]


def resolve_claude_cli(search_path: str) -> tuple[str, str]:
    """Locate the `claude` executable.

    Returns ``(claude_exe, effective_path)`` where ``effective_path`` is
    ``search_path`` extended with the CLI's directory when it had to be found
    via the fallback probe — the child process resolves `claude` off PATH, so
    the directory must travel with it.

    Raises ClaudeCliNotFound with the list of searched locations when the CLI
    is nowhere to be found.
    """
    override = os.environ.get(_CLAUDE_CLI_PATH_ENV, "").strip().strip('"')
    if override:
        if os.path.isfile(override):
            override_dir = os.path.dirname(os.path.abspath(override))
            logger.info("Using %s override: %s", _CLAUDE_CLI_PATH_ENV, override)
            return override, override_dir + os.pathsep + search_path
        raise ClaudeCliNotFound(
            f"{_CLAUDE_CLI_PATH_ENV} is set to {override!r} but no file exists "
            "there. Point it at the full path of the `claude` executable, or "
            "unset it to fall back to PATH discovery.",
            [override],
        )

    found = shutil.which("claude", path=search_path)
    if found:
        return found, search_path

    searched = _candidate_claude_dirs()
    for directory in searched:
        if not os.path.isdir(directory):
            continue
        found = shutil.which("claude", path=directory)
        if found:
            logger.warning(
                "`claude` was not on the inherited PATH; found it at %s via the "
                "fallback probe. Cockpit's PATH is likely stale — restarting it "
                "from a fresh shell avoids this lookup.",
                found,
            )
            return found, directory + os.pathsep + search_path

    raise ClaudeCliNotFound(
        "Could not find the `claude` CLI. Install Claude Code "
        "(https://claude.com/download), then restart Claude Cockpit so it "
        "picks up the new PATH. If `claude` is installed somewhere unusual, "
        f"set the {_CLAUDE_CLI_PATH_ENV} environment variable to its full "
        "path. Searched PATH plus: " + ", ".join(searched),
        searched,
    )


# Regex to strip ANSI escape sequences
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b\].*?\x1b\\")
# Patterns for state detection
_IDLE_PATTERNS = ["❯", "$ "]
_WAITING_PATTERNS = ["Allow", "Yes/No", "y/n", "Do you want", "(y)es", "(n)o"]
# Patterns for token/cost parsing
_TOKEN_RE = re.compile(r"(\d[\d,]*)\s*tokens?")
_COST_RE = re.compile(r"\$(\d+\.?\d*)")
# Live effort-level change, e.g. "Set effort level to high" (from the /effort slash command output)
_EFFORT_RE = re.compile(r"Set effort level to (\w+)")


class SessionStateTracker:
    """Tracks activity state, tokens, and cost from PTY output."""

    def __init__(self):
        self.state: str = "starting"  # idle | busy | waiting | starting
        self.last_output_time: float = time.time()
        self.buffer: str = ""  # rolling ~2000 chars of ANSI-stripped text
        self.total_tokens: int = 0
        self.total_cost: float = 0.0
        self._last_token_val: int = 0
        self._last_cost_val: float = 0.0
        self.output_lines: deque = deque(maxlen=500)  # ring buffer: last 500 ANSI-stripped lines
        self._line_fragment: str = ""  # incomplete line accumulator
        self.context_percent: Optional[int] = None  # last seen context window fill %
        self.effort: Optional[str] = None  # last effort level seen in PTY output (e.g. "high")

    def feed(self, raw_data: str) -> None:
        """Process new PTY output data."""
        self.last_output_time = time.time()
        self.state = "busy"

        # Strip ANSI and append to rolling buffer
        clean = _ANSI_RE.sub("", raw_data)
        self.buffer += clean
        if len(self.buffer) > 2000:
            self.buffer = self.buffer[-2000:]

        # Accumulate into per-line ring buffer for history/resume
        combined = self._line_fragment + clean
        lines = combined.split("\n")
        self._line_fragment = lines[-1]
        complete = [line for line in lines[:-1] if line.strip()]
        if complete:
            self.output_lines.extend(complete)

        # Parse tokens/cost from the clean data
        for m in _TOKEN_RE.finditer(clean):
            val = int(m.group(1).replace(",", ""))
            if val > self._last_token_val:
                self.total_tokens = val
                self._last_token_val = val

        for m in _COST_RE.finditer(clean):
            val = float(m.group(1))
            if val > self._last_cost_val:
                self.total_cost = val
                self._last_cost_val = val

        # Detect context window fill percentage from Claude Code output.
        # Matches patterns like "Context window is 73% full", "73% of context", etc.
        # The regex looks for "context" followed (within 30 non-digit chars) by a percentage.
        ctx_match = re.search(r'context\D{0,30}?(\d{1,3})\s*%', clean, re.IGNORECASE)
        if ctx_match:
            self.context_percent = int(ctx_match.group(1))

        # Detect live effort-level changes (e.g. from the /effort slash command).
        effort_match = _EFFORT_RE.search(clean)
        if effort_match:
            self.effort = effort_match.group(1)

    def tick(self) -> str:
        """Check for idle/waiting state based on buffer tail and timing."""
        elapsed = time.time() - self.last_output_time

        if elapsed < 1.0:
            return self.state  # Still receiving output, stay busy

        # Check the tail of the buffer for patterns.
        # NOTE: feed() runs on the PTY read thread and tick() on the event loop;
        # this read is intentionally lock-free. It is safe only because feed()
        # mutates self.buffer via whole-string reassignment, which is atomic
        # under the CPython GIL — tick() always sees a consistent old-or-new
        # string, never a torn one. Do not change feed() to mutate in place.
        tail = self.buffer[-200:] if self.buffer else ""

        # Check waiting patterns first (higher priority)
        for pattern in _WAITING_PATTERNS:
            if pattern.lower() in tail.lower():
                self.state = "waiting"
                return self.state

        # Check idle patterns
        for pattern in _IDLE_PATTERNS:
            if pattern in tail:
                self.state = "idle"
                return self.state

        # If no output for 10s+ but no recognized pattern, assume idle.
        # Previous 3s threshold was too aggressive — Claude thinking pauses
        # were misclassified as idle before output was complete.
        if elapsed > 10.0 and self.state == "busy":
            self.state = "idle"

        return self.state


@dataclass
class TerminalSession:
    """Represents a single interactive Claude CLI terminal."""

    id: str
    name: str
    pty: Any  # winpty.PtyProcess or conpty.PtyProcess
    created_at: str
    model: str = "sonnet"
    provider: str = "anthropic"  # "anthropic" | "openrouter" — for display + reroute detection
    working_dir: str = ""
    claude_session_id: Optional[str] = None  # for --resume
    bypass_permissions: bool = False
    permission_mode: str = "default"
    effort: str = ""
    fast: bool = False
    cols: int = 120
    rows: int = 30
    alive: bool = True
    tracker: SessionStateTracker = field(default_factory=SessionStateTracker)
    output_queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=200))
    # Monotonically-incrementing counter. Each new WS connection bumps this and captures
    # its own value as my_generation. Only the forwarder whose my_generation matches
    # active_consumer is allowed to drain output_queue — "latest connection wins".
    # Mutated only from the asyncio event loop (single-threaded), so no lock is needed.
    active_consumer: int = 0
    context_percent: Optional[int] = None  # last seen context window fill % (from tracker)
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_user_input_time: float = 0.0  # monotonic timestamp of last user keystroke (bridge typing-quiet gate)
    last_output_time: float = 0.0  # monotonic timestamp of last PTY output (JSONL staleness detection)


MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "8"))
IDLE_TIMEOUT = int(os.getenv("IDLE_TIMEOUT", "0"))  # 0 = disabled (no auto-close)

# Allowed model names — prevents command injection via the model parameter.
_ALLOWED_MODELS = {
    "sonnet", "opus", "haiku",
    "claude-opus-5", "claude-opus-5[1m]",
    "claude-opus-4-7", "claude-opus-4-7[1m]",
    "claude-opus-4-8", "claude-opus-4-8[1m]",
    "claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001",
    "claude-sonnet-4-6[1m]", "claude-opus-4-6[1m]",
    "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022",
    "claude-fable-5",
}

# Allowed permission modes — full CLI set so future UI additions don't require a backend change.
# Maps directly to --permission-mode <mode> choices in claude --help.
_ALLOWED_PERMISSION_MODES = {
    "default", "plan", "acceptEdits", "bypassPermissions", "auto", "dontAsk",
}

# Drift-proof model-id validator. The picker is now driven by the live
# /v1/models list (see server.py::get_models), so a closed allowlist would
# re-introduce the exact drift that missed Opus 5. Instead we accept any
# well-formed Anthropic model id: first char alphanumeric (blocks "--flag"
# injection), remainder limited to the model-id charset plus an optional
# "[1m]" long-context suffix. No spaces/quotes/semicolons/slashes — so it
# stays safe to interpolate into the spawn command string. The _ALLOWED_MODELS
# aliases (sonnet/opus/haiku) are still accepted verbatim below.
_ANTHROPIC_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,62}(?:\[1m\])?$")

# Allowed effort levels — empty string means "unset" (model default, no flag appended).
# Non-empty values map directly to --effort <level>.
_ALLOWED_EFFORT_LEVELS = {"", "low", "medium", "high", "xhigh", "max"}

# Claude session ID format: hex or UUID-style
_SESSION_ID_RE = re.compile(r"^[a-f0-9\-]{8,64}$", re.IGNORECASE)

# Allowed providers — "anthropic" (default, official Claude API/subscription),
# "openrouter" (reroutes the session through OpenRouter's Anthropic-compatible
# endpoint via env vars; see create_terminal()), or "local" (reroutes onto a
# local inference server — LM Studio or vLLM — via ANTHROPIC_BASE_URL).
_ALLOWED_PROVIDERS = {"anthropic", "openrouter", "local"}

# OpenRouter model slug format: "<vendor>/<model>", e.g. "qwen/qwen3-coder-next"
# or "anthropic/claude-3.7-sonnet:beta". Vendor segment must start with an
# alnum char (lowercase enforced upstream by OpenRouter's own catalog); model
# segment additionally allows ":" for variant suffixes like ":free"/":beta".
# The slug is only ever placed into env vars (ANTHROPIC_MODEL), never the cmd
# string, but it is validated anyway as defense in depth.
_OPENROUTER_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-\.]*\/[a-z0-9][a-z0-9\-\.:]*$")

# Local model id format: LM Studio/vLLM model ids can contain path-ish
# segments ("/"), dots, colons, and dashes (e.g. "qwen3-coder-30b-a3b-awq" or
# "/models/Qwen3-Coder-30B-A3B-AWQ"). First char must be alnum to block a
# "--flag"-style injection landing in ANTHROPIC_MODEL. Only ever placed into
# env vars, never the cmd string, but validated anyway as defense in depth.
_LOCAL_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-\/]{0,127}$")


class PtyManager:
    """Manages PTY-backed terminal sessions."""

    # File that tracks PIDs of claude processes spawned by this cockpit instance.
    # Only these PIDs are killed during orphan cleanup — never random Claude sessions.
    _PID_TRACK_FILE = os.path.join(os.path.dirname(__file__), ".cockpit-child-pids")

    # Interval (seconds) at which the background state ticker calls tick() on
    # every live session.  1 second is fine-grained enough that the bridge idle
    # gate sees a fresh state within one poll cycle without significant overhead.
    _STATE_TICKER_INTERVAL = 1.0

    def __init__(self):
        self.sessions: dict[str, TerminalSession] = {}
        self._lock = threading.Lock()  # Protects sessions dict and PID file
        self._pty_executor = ThreadPoolExecutor(max_workers=64)
        self._state_ticker_task: Optional[asyncio.Task] = None

    def _load_child_pids(self) -> set[int]:
        """Load previously tracked child PIDs."""
        try:
            with open(self._PID_TRACK_FILE) as f:
                return {int(line.strip()) for line in f if line.strip().isdigit()}
        except FileNotFoundError:
            return set()
        except Exception:
            logger.debug("Failed to load child PIDs", exc_info=True)
            return set()

    def _write_child_pids(self, pids: set[int]) -> None:
        """Persist child PID set to disk."""
        try:
            with open(self._PID_TRACK_FILE, "w") as f:
                f.write("\n".join(str(p) for p in pids))
        except Exception:
            logger.debug("Failed to write child PIDs", exc_info=True)

    def _save_child_pid(self, pid: int) -> None:
        """Record a spawned child PID for crash-recovery cleanup."""
        with self._lock:
            pids = self._load_child_pids()
            pids.add(pid)
            self._write_child_pids(pids)

    def _remove_child_pid(self, pid: int) -> None:
        """Remove a child PID after graceful termination."""
        with self._lock:
            pids = self._load_child_pids()
            pids.discard(pid)
            self._write_child_pids(pids)

    def _clear_child_pids(self) -> None:
        """Clear the PID tracking file."""
        self._write_child_pids(set())

    def cleanup_orphans(self):
        """Kill cockpit-spawned claude processes left over from a previous crash.

        Only kills processes whose PIDs were tracked in the child-PID file.
        Never touches Claude sessions running in other terminals or editors.
        """
        tracked_pids = self._load_child_pids()
        if not tracked_pids:
            logger.debug("No tracked child PIDs — skipping orphan cleanup")
            return

        try:
            import psutil
        except ImportError:
            logger.warning("psutil not installed — skipping orphan cleanup")
            return

        killed = 0
        for pid in tracked_pids:
            try:
                proc = psutil.Process(pid)
                name = proc.name().lower()
                # Only kill if it's actually a claude/node process (PID could have been reused)
                if "claude" in name or "node" in name:
                    logger.info("Killing orphaned cockpit child: %s (PID %d)", proc.name(), pid)
                    proc.kill()
                    killed += 1
                else:
                    logger.debug("PID %d reused by '%s' — skipping", pid, proc.name())
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                logger.debug("PID %d gone or inaccessible during orphan cleanup — skipping", pid, exc_info=True)
                continue

        self._clear_child_pids()

        if killed:
            logger.info("Cleaned up %d orphaned cockpit process(es)", killed)
        else:
            logger.debug("No orphaned cockpit processes found")

    def cleanup_idle_sessions(self):
        """Kill sessions that have been idle longer than IDLE_TIMEOUT.

        Also purges sessions whose process has already exited (dead for >30s)
        so they don't accumulate indefinitely in the sessions dict.

        Only kills sessions whose underlying process is still alive but has
        produced no output. Sessions whose process is actively consuming CPU
        (e.g. long-running Claude tasks) are spared even if they haven't
        produced terminal output recently.

        Uses a two-pass CPU check: first pass primes psutil's internal
        counters (interval=None returns 0.0 on first call), second pass
        after a single short sleep gets the actual reading — avoiding the
        blocking cpu_percent(interval=0.1) per session.
        """
        # First pass: purge sessions whose process is already dead.
        # Grace period of 30s avoids racing with post-spawn health checks.
        now = time.time()
        dead_ids = []
        for tid, session in self.sessions.items():
            if not session.alive and not session.pty.isalive():
                elapsed = now - session.tracker.last_output_time
                if elapsed > 30:
                    dead_ids.append(tid)
        for tid in dead_ids:
            logger.info("Purging dead session %s", tid)
            self.kill_terminal(tid)

        if IDLE_TIMEOUT <= 0:
            return
        candidates = []
        for tid, session in self.sessions.items():
            elapsed = now - session.tracker.last_output_time
            if elapsed <= IDLE_TIMEOUT:
                continue
            session.tracker.tick()
            if session.tracker.state != "idle":
                continue
            candidates.append((tid, elapsed))

        if not candidates:
            return

        # Two-pass CPU check: prime all processes, sleep once, then read
        pid_procs = {}
        try:
            import psutil
            for tid, _ in candidates:
                session = self.sessions.get(tid)
                if not session:
                    continue
                child_pid = self._get_child_pid(session)
                if child_pid:
                    try:
                        proc = psutil.Process(child_pid)
                        proc.cpu_percent(interval=None)  # Prime (non-blocking)
                        pid_procs[tid] = proc
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        logger.debug("Child PID for session %s gone or inaccessible during CPU priming", tid, exc_info=True)
            if pid_procs:
                time.sleep(0.1)  # Single sleep for all sessions
        except ImportError:
            logger.warning("psutil not installed — skipping CPU-based idle sparing")

        to_kill = []
        for tid, elapsed in candidates:
            proc = pid_procs.get(tid)
            if proc:
                try:
                    cpu = proc.cpu_percent(interval=None)
                    if cpu > 5.0:
                        logger.debug("Session %s idle %.0fs but CPU %.1f%% — sparing", tid, elapsed, cpu)
                        continue
                except Exception:
                    logger.debug("CPU check failed for session %s — treating as idle", tid, exc_info=True)
            to_kill.append(tid)

        for tid in to_kill:
            session = self.sessions.get(tid)
            if session:
                logger.info("Killing idle session %s (idle %.0fs)", tid, now - session.tracker.last_output_time)
                self.kill_terminal(tid)

    def get_output_buffer(self, terminal_id: str) -> list:
        """Return last 500 ANSI-stripped lines of output for a session (history/resume)."""
        session = self.sessions.get(terminal_id)
        if not session:
            return []
        return list(session.tracker.output_lines)

    def create_terminal(
        self,
        name: str = "",
        workdir: str = "",
        model: str = "sonnet",
        provider: str = "anthropic",
        provider_model: str = "",
        resume_session_id: str = "",
        continue_last: bool = False,
        bypass_permissions: bool = False,
        permission_mode: str = "default",
        effort: str = "",
        fast: bool = False,
        cols: int = 120,
        rows: int = 30,
    ) -> TerminalSession:
        """Spawn a new interactive Claude CLI session in a PTY.

        provider selects which backend the spawned ``claude`` CLI talks to:
          - "anthropic" (default): official Claude API/subscription, unchanged
            behavior. ``model`` is validated against ``_ALLOWED_MODELS`` and
            passed via ``--model``.
          - "openrouter": reroutes the session through OpenRouter's
            Anthropic-compatible endpoint. ``provider_model`` (an OpenRouter
            slug, e.g. "qwen/qwen3-coder-next") is REQUIRED and becomes the
            session's effective model via the ANTHROPIC_MODEL env var —
            OpenRouter slugs are not valid ``--model`` values, so ``--model``
            is omitted entirely and the ``model`` param is ignored (it is
            not even allowlist-validated for this provider).
        """
        if len(self.sessions) >= MAX_SESSIONS:
            raise RuntimeError(f"Maximum session limit ({MAX_SESSIONS}) reached")

        # Validate provider against the allowlist before anything else — every
        # branch below depends on knowing which provider we're spawning for.
        if provider not in _ALLOWED_PROVIDERS:
            raise ValueError(f"Invalid provider: {provider!r}")

        # Generated up front (not down with the rest of the session fields
        # below) so the provider="local" branch can pass it into
        # resolve_local_base_url() for session-scoped attribution.
        terminal_id = uuid.uuid4().hex[:8]

        openrouter_key: Optional[str] = None
        local_base_url: Optional[str] = None
        local_model_id: Optional[str] = None
        if provider == "openrouter":
            if not provider_model:
                raise ValueError("provider_model is required when provider='openrouter'")
            # Validated even though the slug only ever reaches env vars (never
            # the cmd string) — defense in depth against a malformed value
            # landing in ANTHROPIC_MODEL.
            if not _OPENROUTER_SLUG_RE.match(provider_model):
                raise ValueError(f"Invalid provider_model slug: {provider_model!r}")
            openrouter_key, _key_source = settings_store.resolve_openrouter_key()
            if not openrouter_key:
                raise ValueError(
                    "OpenRouter key not configured — add one via the key icon "
                    "in the top bar or set OPENROUTER_API_KEY"
                )
        elif provider == "local":
            if not provider_model:
                raise ValueError("provider_model is required when provider='local'")
            # Contract: providerModel = "<local_provider_id>::<model_id>",
            # e.g. "lmstudio-local::qwen3-coder-30b" — split on the FIRST "::"
            # so a model id that itself contains "::" (unlikely, but the regex
            # below wouldn't allow it anyway) doesn't get mis-parsed.
            if "::" not in provider_model:
                raise ValueError(
                    f"Invalid provider_model for provider='local' (expected "
                    f"'<local_provider_id>::<model_id>'): {provider_model!r}"
                )
            local_provider_id, local_model_id = provider_model.split("::", 1)
            if not _LOCAL_MODEL_ID_RE.match(local_model_id):
                raise ValueError(f"Invalid local model id: {local_model_id!r}")
            # URL resolution is server-side only (SSRF stance) — the browser
            # never supplies a URL, only the provider id. server.py owns the
            # provider registry, so we lazy-import it here (server.py already
            # imports pty_manager at module scope, so importing server from
            # here at module scope would be circular; a call-time import is
            # safe since server.py is fully loaded by the time a session is
            # created).
            import server as _server
            local_base_url = _server.resolve_local_base_url(local_provider_id, terminal_id)
            if not local_base_url:
                raise ValueError(f"Unknown or non-local provider id: {local_provider_id!r}")
        else:
            # Validate model to prevent command injection (e.g. "sonnet --dangerously-skip-permissions").
            # Skipped for provider="openrouter": model selection there rides
            # ANTHROPIC_MODEL (see above), not this allowlist/--model flag.
            if model not in _ALLOWED_MODELS and not _ANTHROPIC_MODEL_RE.match(model):
                raise ValueError(f"Invalid model: {model!r}")

        # Validate permission_mode against allowlist — value is interpolated into the cmd string.
        if permission_mode not in _ALLOWED_PERMISSION_MODES:
            raise ValueError(f"Invalid permission_mode: {permission_mode!r}")

        # Validate effort against allowlist — value is interpolated into the cmd string.
        if effort not in _ALLOWED_EFFORT_LEVELS:
            raise ValueError(f"Invalid effort: {effort!r}")

        # Validate resume_session_id if provided (must be hex/UUID, no shell metacharacters)
        if resume_session_id and not _SESSION_ID_RE.match(resume_session_id):
            raise ValueError(f"Invalid session ID format: {resume_session_id!r}")

        if not name:
            name = f"Session {len(self.sessions) + 1}"
        if not workdir:
            workdir = os.getcwd()

        # Build a clean environment for child processes:
        # 1. Remove Claude Code markers (avoids "inside another session" error)
        # 2. Remove PyInstaller artifacts (avoids DLL conflicts)
        blocked_keys = {"CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"}
        if provider not in ("openrouter", "local"):
            # A machine-global OpenRouter/local config (e.g. exported in the
            # user's shell profile for other tools, or left behind by a
            # previous openrouter/local-provider session's parent shell) must
            # never leak into an anthropic-provider pane and silently reroute
            # a paid Claude subscription session onto a foreign endpoint.
            # openrouter/local-provider sessions set these two vars explicitly
            # below instead.
            blocked_keys |= {"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"}
        pyi_prefixes = ("_PYI", "_MEI")
        env = {}
        for k, v in os.environ.items():
            if k in blocked_keys:
                continue
            if k.startswith(pyi_prefixes):
                continue
            env[k] = v

        # Force Claude Code's classic (inline) renderer instead of its v2.1.89+
        # fullscreen TUI, which draws into the terminal's ALTERNATE SCREEN BUFFER
        # (ESC[?1049h, like vim/htop). The alternate buffer has no scrollback, so
        # inside cockpit's embedded xterm.js it makes the conversation impossible
        # to scroll up — history appears "truncated" (Claude Code issue #42670).
        # This env var (Claude Code v2.1.132+) forces the classic renderer
        # regardless of the user's global `tui` setting, restoring xterm's
        # 10000-line scrollback. It affects only cockpit-spawned sessions; the
        # user's native-terminal TUI preference is left untouched.
        env["CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN"] = "1"

        # Suppress Claude Code's built-in auto-updater. With up to MAX_SESSIONS
        # (default 8) concurrent cockpit-spawned `claude` processes all holding
        # a handle on the same claude.exe, the updater can never win the file
        # replace and every session logs "Auto-update failed: claude.exe in
        # use...". The update itself is harmless to skip here — the user is
        # expected to update Claude Code manually (outside cockpit) when a new
        # version ships. Scoped to this child's env dict only; does not touch
        # the running cockpit server's own os.environ.
        env["DISABLE_AUTOUPDATER"] = "1"

        import sys as _sys
        meipass = getattr(_sys, "_MEIPASS", None)
        current_path = env.get("PATH", env.get("Path", ""))

        # Strip PyInstaller's temp extraction directory from PATH
        if meipass:
            meipass_lower = meipass.lower().rstrip(os.sep)
            cleaned_parts = []
            for p in current_path.split(os.pathsep):
                p_stripped = p.strip()
                if not p_stripped:
                    continue
                p_lower = p_stripped.lower().rstrip(os.sep)
                if p_lower == meipass_lower or p_lower.startswith(meipass_lower + os.sep):
                    continue
                cleaned_parts.append(p_stripped)
            current_path = os.pathsep.join(cleaned_parts)

        # Ensure critical system directories and tool globals are in PATH
        if _sys.platform == "win32":
            sys_root = os.environ.get("SystemRoot", r"C:\Windows")
            user_profile = os.environ.get("USERPROFILE", os.path.expanduser("~"))
            npm_dir = os.path.join(user_profile, "AppData", "Roaming", "npm")
            # Claude Code's native (non-npm) installer drops claude.exe in
            # %USERPROFILE%\.local\bin. If cockpit was launched from a shell or
            # Explorer session whose PATH predates that install, shutil.which()
            # misses it and every spawn fails with "'claude' CLI not found".
            local_bin = os.path.join(user_profile, ".local", "bin")
            essential_dirs = [
                os.path.join(sys_root, "System32"),
                sys_root,
                os.path.join(sys_root, "System32", "Wbem"),
                npm_dir,
                local_bin,
            ]
            path_lower = current_path.lower()
            for d in essential_dirs:
                if os.path.isdir(d) and d.lower() not in path_lower:
                    current_path = d + os.pathsep + current_path
            env.setdefault("SystemRoot", sys_root)
        else:
            home = os.path.expanduser("~")
            extra_dirs = [f"{home}/.local/bin", "/usr/local/bin"]
            path_set = set(current_path.split(os.pathsep))
            prepend = [d for d in extra_dirs if os.path.isdir(d) and d not in path_set]
            if prepend:
                current_path = os.pathsep.join(prepend) + os.pathsep + current_path
        env["PATH"] = current_path

        if provider == "openrouter":
            # Reroute this session's `claude` CLI onto OpenRouter's Anthropic-
            # compatible endpoint. ANTHROPIC_API_KEY is explicitly cleared so
            # the CLI can't fall back to a real Anthropic key that happens to
            # be set in the parent environment — ANTHROPIC_AUTH_TOKEN is the
            # only credential the CLI should see for this session.
            env["ANTHROPIC_BASE_URL"] = "https://openrouter.ai/api"
            env["ANTHROPIC_AUTH_TOKEN"] = openrouter_key
            env["ANTHROPIC_API_KEY"] = ""
            env["ANTHROPIC_MODEL"] = provider_model
            env["ANTHROPIC_SMALL_FAST_MODEL"] = "qwen/qwen3-coder-next"
            # NEVER log the key itself — var names only.
            logger.info(
                "OpenRouter provider: set env vars %s",
                ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
                 "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"],
            )
        elif provider == "local":
            # Reroute this session's `claude` CLI onto a local inference
            # server (LM Studio via the broker, or vLLM via cockpit's own
            # /shim/vllm route) — base URL resolved server-side above.
            # ANTHROPIC_AUTH_TOKEN is a dummy value: local servers don't
            # authenticate, but the CLI requires the var to be non-empty.
            # ANTHROPIC_API_KEY is explicitly cleared for the same reason as
            # the openrouter branch — no fallback to a real Anthropic key.
            env["ANTHROPIC_BASE_URL"] = local_base_url
            env["ANTHROPIC_AUTH_TOKEN"] = "local"
            env["ANTHROPIC_API_KEY"] = ""
            env["ANTHROPIC_MODEL"] = local_model_id
            # Without this, the CLI's default small/fast model (a
            # claude-3-5-haiku-ish id, used for background tasks like title
            # generation) still gets sent to the LOCAL base URL and 404s —
            # the local server doesn't know that model id. Point it at the
            # same local model, mirroring the openrouter branch.
            env["ANTHROPIC_SMALL_FAST_MODEL"] = local_model_id
            # Local-lane fix: the 49152-token vLLM context window minus the
            # CLI's default ~32k output-token reservation otherwise 500s past
            # ~17k input tokens. Caps the CLI's own output reservation so it
            # fits comfortably inside a local server's smaller context.
            env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = "8000"
            # NEVER log the URL here to avoid noise; var names only.
            logger.info(
                "Local provider: set env vars %s",
                ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
                 "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_MAX_OUTPUT_TOKENS"],
            )

        # Build the command

        # Snapshot existing JSONL files BEFORE spawning so we can detect which
        # new file Claude Code creates. Claude ignores --session-id and generates
        # its own UUID, so we discover it by diffing the directory.
        home = os.path.expanduser("~")
        project_id = workdir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
        jsonl_dir = os.path.join(home, ".claude", "projects", project_id)
        pre_spawn_files = set()
        if os.path.isdir(jsonl_dir):
            pre_spawn_files = {f for f in os.listdir(jsonl_dir) if f.endswith(".jsonl")}

        if provider in ("openrouter", "local"):
            # OpenRouter slugs and local model ids (e.g. "qwen/qwen3-coder-next"
            # or "/models/Qwen3-Coder-30B-A3B-AWQ") are not valid --model values
            # for the claude CLI — model selection rides ANTHROPIC_MODEL (set
            # above) instead. --model is omitted entirely.
            cmd = "claude"
        else:
            cmd = f"claude --model {model}"
        if resume_session_id:
            cmd += f" --resume {resume_session_id}"
        elif continue_last:
            cmd += " --continue"

        # Permission mode logic:
        # bypass_permissions (legacy boolean) or permission_mode == "bypassPermissions"
        # both map to --dangerously-skip-permissions; bypass wins and we do NOT
        # also append --permission-mode to avoid duplicate/conflicting flags.
        effective_bypass = bypass_permissions or (permission_mode == "bypassPermissions")
        if effective_bypass:
            cmd += " --dangerously-skip-permissions"
        elif permission_mode and permission_mode != "default":
            # All values in _ALLOWED_PERMISSION_MODES are allowlist-validated above.
            cmd += f" --permission-mode {permission_mode}"

        # Effort level: empty string means "use model default" (no flag appended).
        # Skipped entirely for openrouter/local — foreign/local models don't support --effort.
        if effort and provider in ("openrouter", "local"):
            logger.info("Effort level %r requested but skipped — not supported for provider=%s", effort, provider)
        elif effort:
            # Value is allowlist-validated above — safe to interpolate.
            cmd += f" --effort {effort}"

        # Fast mode (Opus-only): implemented via --settings <path> with {"fastMode":true}.
        # Verified empirically: `claude --settings '{"fastMode":true}' -p "hi" --output-format json`
        # returns "fast_mode_state":"on" with zero stderr and no unknown-key warnings (2026-06-01).
        # We write a temp JSON file (not inline JSON) because the cmd is spawned through
        # ConPTY/winpty where inline braces/quotes are mangled by the shell.
        # Gate: fast mode is only available for Opus models. The /fast toggle in the TUI
        # silently no-ops on non-Opus models, so we skip the flag entirely for non-Opus.
        # Also skipped entirely for openrouter/local — foreign/local models don't support fast mode.
        _fast_settings_path: Optional[str] = None
        if fast and provider in ("openrouter", "local"):
            logger.info("Fast mode requested but skipped — not supported for provider=%s", provider)
        elif fast and "opus" in model.lower():
            import json as _json
            import tempfile as _tempfile
            try:
                fd, _fast_settings_path = _tempfile.mkstemp(
                    suffix=".json", prefix="cockpit_fast_", text=True
                )
                with os.fdopen(fd, "w") as _fh:
                    _json.dump({"fastMode": True}, _fh)
                # Quote the path: %TEMP% can legitimately contain a space (e.g. a
                # Windows username "First Last" → C:\Users\First Last\...\Temp\...).
                # The cmd string is shlex-tokenized by every backend (never shell=True),
                # so an unquoted path with a space splits into two argv tokens and
                # breaks --settings parsing. Double-quoting keeps it one token: the
                # ConPTY backend strips the quotes and list2cmdline re-adds them; the
                # POSIX backend's shlex(posix=True) consumes them. The path comes from
                # mkstemp() (not user input) and can never contain a literal quote, so
                # this is purely a correctness/robustness guard, not injection defense.
                cmd += f' --settings "{_fast_settings_path}"'
                logger.info("Fast mode: enabled via --settings %s", _fast_settings_path)
            except Exception:
                logger.warning("Fast mode: failed to write settings file — skipping", exc_info=True)
                _fast_settings_path = None
        elif fast:
            logger.info("Fast mode: requested but model %r is not Opus — ignoring", model)

        # Resolve the CLI before spawning so a missing install fails here with
        # an actionable message, rather than as a bare "Command not found" from
        # deep inside the PTY backend. resolve_claude_cli may extend PATH when
        # it locates the CLI outside the inherited one — that extension has to
        # reach the child, so re-stamp env["PATH"].
        claude_path, current_path = resolve_claude_cli(current_path)
        env["PATH"] = current_path
        logger.info("Spawning: %s", cmd)
        logger.info("Claude found at: %s", claude_path)
        logger.info("CWD: %s", workdir)
        logger.debug("Bundled: %s", bool(meipass))
        if effective_bypass:
            logger.warning("Permissions: BYPASSED")
        if permission_mode and permission_mode != "default" and not effective_bypass:
            logger.info("Permission mode: %s", permission_mode)
        if effort:
            logger.info("Effort level: %s", effort)

        # Select the appropriate PTY backend for this environment.
        # The backend abstraction (pty_backend.py) makes cross-platform support
        # a matter of adding a new class — no changes needed here.
        from pty_backend import get_backend
        backend = get_backend()
        logger.info("PTY backend: %s", backend.__name__)
        try:
            pty_process = backend.spawn(
                cmd,
                dimensions=(rows, cols),
                cwd=workdir,
                env=env,
            )
        except BaseException:
            # Spawn failed after the fast-mode settings file was written. The
            # success-path cleanup in server.py never runs on this branch (it keys
            # off session._fast_settings_path, and no session is created here), so
            # remove the orphaned temp file now to avoid leaking it into %TEMP% on
            # every failed Opus fast-mode spawn. Re-raise so the caller still sees
            # the original spawn error.
            if _fast_settings_path:
                try:
                    os.unlink(_fast_settings_path)
                except OSError:
                    logger.debug(
                        "Fast mode: failed to remove temp settings file after spawn failure: %s",
                        _fast_settings_path, exc_info=True,
                    )
            raise
        # Post-spawn health check is deferred to the async caller (server.py)
        # so it can use asyncio.sleep() without blocking the event loop.

        # Display model: for openrouter/local, `model` is ignored entirely
        # (never allowlist-validated, never passed as --model) — the
        # session's effective/displayed model is the OpenRouter slug or the
        # parsed local model id instead.
        if provider == "openrouter":
            display_model = provider_model
        elif provider == "local":
            display_model = local_model_id
        else:
            display_model = model

        session = TerminalSession(
            id=terminal_id,
            name=name,
            pty=pty_process,
            created_at=datetime.now(timezone.utc).isoformat(),
            model=display_model,
            provider=provider,
            working_dir=workdir,
            claude_session_id=resume_session_id or None,
            bypass_permissions=effective_bypass,
            permission_mode=permission_mode,
            effort=effort,
            fast=fast,
            cols=cols,
            rows=rows,
        )
        # Store pre-spawn file snapshot for JSONL discovery
        session._pre_spawn_files = pre_spawn_files
        # Store the fast-mode settings file path so server.py can delete it after
        # the post-spawn health check (1.5s).  The file must survive until the
        # claude process has read its config on startup.  Deleting it here (before
        # Node.js has a chance to parse it) risks a race on a loaded system.
        session._fast_settings_path = _fast_settings_path
        self.sessions[terminal_id] = session

        # Track child PID for crash-recovery cleanup
        child_pid = self._get_child_pid(session)
        if child_pid:
            self._save_child_pid(child_pid)

        return session

    def _get_child_pid(self, session: TerminalSession) -> int | None:
        """Extract the child PID from a PTY session."""
        pid = getattr(session.pty, "pid", None)
        if pid is None:
            pi = getattr(session.pty, "_pi", None)
            if pi:
                pid = getattr(pi, "dwProcessId", None)
        return pid

    def kill_terminal(self, terminal_id: str) -> bool:
        """Kill a terminal session and its entire process tree."""
        session = self.sessions.pop(terminal_id, None)
        if not session:
            return False

        child_pid = self._get_child_pid(session)
        if child_pid:
            self._remove_child_pid(child_pid)

        # conpty.PtyProcess uses Job Objects internally for tree killing.
        # For pywinpty, kill the process tree via psutil before terminating.
        has_job = getattr(session.pty, "_job", None) is not None
        if not has_job and child_pid:
            self._kill_process_tree(child_pid)

        try:
            if session.pty.isalive():
                session.pty.terminate(force=True)
        except Exception:
            logger.warning("Failed to terminate PTY %s", terminal_id, exc_info=True)
        session.alive = False
        return True

    @staticmethod
    def _kill_process_tree(pid: int) -> None:
        """Kill a process and all its descendants (for pywinpty mode)."""
        try:
            import psutil
        except ImportError:
            # psutil is unbound here — must not be referenced in this except's
            # exception tuple (that would raise NameError and mask the real
            # error). Handle the missing-dependency case in its own clause.
            logger.debug("psutil unavailable — skipping process tree kill for PID %d", pid, exc_info=True)
            return
        try:
            parent = psutil.Process(pid)
            children = parent.children(recursive=True)
            for child in children:
                try:
                    child.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    logger.debug("Child process %s already gone or inaccessible during tree kill", child, exc_info=True)
        except psutil.NoSuchProcess:
            logger.debug("Parent process gone — skipping process tree kill for PID %d", pid, exc_info=True)

    def resize_terminal(self, terminal_id: str, cols: int, rows: int) -> bool:
        """Resize a terminal's PTY dimensions."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return False
        try:
            session.pty.setwinsize(rows, cols)
            session.cols = cols
            session.rows = rows
            return True
        except Exception:
            logger.debug("Resize failed for %s", terminal_id, exc_info=True)
            return False

    def _get_jsonl_path(self, session) -> str | None:
        """Derive the path to Claude Code's JSONL session file.

        Claude Code stores conversation data at:
          ~/.claude/projects/<project-id>/<session-id>.jsonl

        Discovery strategy (in order):
        1. If we know the session ID, use it directly
        2. Find new files that appeared after this session was spawned
        3. Fallback: use the most recently modified JSONL file in the project
           (covers /resume which reuses existing files)
        """
        if not session.working_dir:
            return None

        home = os.path.expanduser("~")
        project_id = session.working_dir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
        jsonl_dir = os.path.join(home, ".claude", "projects", project_id)

        # Strategy 1: known session ID. Locked while fresh, but an in-terminal
        # /resume makes Claude Code append to the RESUMED conversation's file,
        # leaving the locked file permanently stale (bug #15 family). Detect
        # that: session produced PTY output recently, yet the locked file
        # hasn't been written in a long stretch → unlock and re-discover.
        if session.claude_session_id:
            path = os.path.join(jsonl_dir, f"{session.claude_session_id}.jsonl")
            if os.path.isfile(path):
                if not self._jsonl_is_stale(session, path):
                    return path
                fresher = self._rediscover_jsonl(session, jsonl_dir)
                if fresher:
                    return fresher
                return path  # stale but nothing better — keep it

        if not os.path.isdir(jsonl_dir):
            return None

        # Strategy 2: find new files since spawn
        pre = getattr(session, '_pre_spawn_files', None)
        if pre is not None:
            current_files = {f for f in os.listdir(jsonl_dir) if f.endswith(".jsonl")}
            new_files = current_files - pre
            if new_files:
                newest = max(new_files, key=lambda f: os.path.getmtime(os.path.join(jsonl_dir, f)))
                discovered_id = newest.replace(".jsonl", "")
                session.claude_session_id = discovered_id
                logger.info("Discovered JSONL (new file): %s for terminal %s", discovered_id, session.id)
                return os.path.join(jsonl_dir, newest)

        # Strategy 3 (the docstring's promised /resume fallback — previously
        # unimplemented, leaving resumed sessions with claude_session_id=None
        # and zero usage tracking forever): the resumed conversation's JSONL
        # predates spawn, so Strategy 2's new-file diff never finds it. Claim
        # the most recently *written* unclaimed JSONL instead — but only when
        # this session has actually produced output (an idle pane must never
        # grab another session's file: bug #15 mis-attribution family).
        if session.last_output_time > 0:
            found = self._rediscover_jsonl(session, jsonl_dir)
            if found:
                logger.info(
                    "Discovered JSONL (resume fallback): %s for terminal %s",
                    session.claude_session_id, session.id,
                )
                return found

        return None

    # Locked JSONL is considered stale when the session has produced PTY output
    # within this window but the file hasn't been written for longer than it.
    _JSONL_STALE_SECONDS = 180.0

    def _jsonl_is_stale(self, session, path: str) -> bool:
        if session.last_output_time <= 0:
            return False  # no output activity recorded — nothing to compare against
        try:
            file_age = time.time() - os.path.getmtime(path)
        except OSError:
            return True
        output_age = time.monotonic() - session.last_output_time
        return output_age < self._JSONL_STALE_SECONDS and file_age > self._JSONL_STALE_SECONDS

    def _rediscover_jsonl(self, session, jsonl_dir: str) -> str | None:
        """Find the JSONL the session is actually writing to after a /resume.

        Candidates: recently-modified files in the project dir NOT claimed by any
        other live session. Pick the most recently modified one.
        """
        claimed = {
            s.claude_session_id
            for s in self.sessions.values()
            if s.id != session.id and s.claude_session_id
        }
        best, best_mtime = None, 0.0
        try:
            names = os.listdir(jsonl_dir)
        except OSError:
            return None
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            sid = name[:-6]
            if sid == session.claude_session_id or sid in claimed:
                continue
            full = os.path.join(jsonl_dir, name)
            try:
                mtime = os.path.getmtime(full)
            except OSError:
                continue
            # Only files written very recently qualify — the live conversation
            # file is updated continuously while the session produces output.
            if time.time() - mtime < self._JSONL_STALE_SECONDS and mtime > best_mtime:
                best, best_mtime = full, mtime
        if best:
            new_id = os.path.basename(best)[:-6]
            logger.info(
                "Re-locking JSONL for terminal %s: %s -> %s (stale after /resume)",
                session.id, session.claude_session_id, new_id,
            )
            session.claude_session_id = new_id
        return best

    def _session_to_dict(self, session: TerminalSession) -> dict:
        """Build the REST-facing dict for a single session.

        Shared by ``list_terminals`` (bulk) and single-terminal callers (e.g.
        the PATCH rename route in server.py, which echoes the updated record
        back to the caller) so the shape never drifts between the two.
        """
        alive = session.pty.isalive()
        if not alive:
            session.alive = False
        else:
            session.tracker.tick()
        return {
            "id": session.id,
            "name": session.name,
            "model": session.model,
            "provider": session.provider,
            "created_at": session.created_at,
            "working_dir": session.working_dir,
            "claude_session_id": session.claude_session_id,
            "jsonl_path": self._get_jsonl_path(session),
            "bypass_permissions": session.bypass_permissions,
            "cols": session.cols,
            "rows": session.rows,
            "alive": alive,
            "activity_state": session.tracker.state,
            "tokens": session.tracker.total_tokens,
            "cost": session.tracker.total_cost,
            "context_percent": session.tracker.context_percent,
        }

    def list_terminals(self) -> list[dict]:
        """List all terminals, marking dead ones but NOT removing them.

        Dead sessions are left in the dict so that concurrent code paths
        (e.g. the post-spawn health check) can still find them.  They are
        cleaned up by explicit ``kill_terminal`` or ``cleanup_idle_sessions``.
        """
        return [self._session_to_dict(session) for session in self.sessions.values()]

    def rename_terminal(self, terminal_id: str, name: str) -> Optional[TerminalSession]:
        """Rename a terminal's Cockpit-side display name.

        This does NOT touch the underlying Claude Code session — it only
        updates the label shown in the Cockpit UI (``GET /api/terminals``).
        Callers that also want to sync the name into the Claude Code session
        itself (via the ``/rename`` slash command) do so separately after
        this call succeeds — see server.py's PATCH /api/terminals/{id} route.

        Concurrency: plain string attribute assignment on a dataclass is
        atomic under the GIL (single reassignment, not an in-place mutation),
        matching the existing pattern used by ``resize_terminal`` for
        ``session.cols``/``session.rows``. No additional lock is needed.

        Returns the updated session, or None if *terminal_id* is unknown.
        """
        session = self.sessions.get(terminal_id)
        if session is None:
            return None
        session.name = name
        return session

    def get_terminal(self, terminal_id: str) -> Optional[TerminalSession]:
        """Get a terminal session by ID."""
        session = self.sessions.get(terminal_id)
        if session and not session.pty.isalive():
            session.alive = False
        return session

    async def read_pty(self, terminal_id: str, size: int = 65536) -> str:
        """Read from PTY (runs in dedicated executor with timeout to avoid blocking)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.alive:
            return ""
        loop = asyncio.get_event_loop()
        try:
            data = await asyncio.wait_for(
                loop.run_in_executor(self._pty_executor, session.pty.read, size),
                timeout=10.0,
            )
            return data
        except asyncio.TimeoutError:
            # Read hung — process may be in a zombie state
            logger.warning("PTY read timed out for %s", terminal_id)
            return ""
        except EOFError:
            session.alive = False
            return ""
        except Exception:
            logger.debug("PTY read error for %s", terminal_id)
            return ""

    def write_pty(self, terminal_id: str, data: str) -> bool:
        """Write to PTY stdin (synchronous)."""
        session = self.sessions.get(terminal_id)
        if not session or not session.pty.isalive():
            return False
        try:
            session.pty.write(data)
            return True
        except Exception:
            logger.debug("PTY write error for %s", terminal_id)
            return False

    async def write_pty_async(self, terminal_id: str, data: str) -> bool:
        """Write to PTY stdin (non-blocking, runs in executor with timeout).

        For large payloads (>8KB), writes in chunks with async yields between
        them so the ConPTY pipe buffer can drain.  Timeout scales with data
        size to support multi-thousand-line pastes.
        """
        session = self.sessions.get(terminal_id)
        if not session or not session.alive:
            return False
        async with session.write_lock:
            loop = asyncio.get_event_loop()

            # Scale timeout: 5s base + 1s per 32KB of data
            data_len = len(data.encode("utf-8")) if isinstance(data, str) else len(data)
            timeout = max(5.0, 5.0 + (data_len / 32768))

            # Small payloads: single write (fast path).
            # Threshold is 200 bytes — lowered from 400 to match the new chunk
            # size so that any paste that would have been chunked still goes
            # through the slower path with inter-chunk delays.
            if data_len <= 200:
                try:
                    return await asyncio.wait_for(
                        loop.run_in_executor(
                            self._pty_executor, self._write_pty_sync, terminal_id, data
                        ),
                        timeout=timeout,
                    )
                except asyncio.TimeoutError:
                    logger.warning("PTY write timed out for %s — marking session dead", terminal_id)
                    session.alive = False
                    return False
                except Exception:
                    logger.debug("PTY async write error for %s", terminal_id)
                    return False

            # Larger payloads: chunk with async yields to let the pipe drain.
            # 200-byte chunks keep each write well under ConPTY's pipe limit.
            chunk_size = 200
            offset = 0
            while offset < len(data):
                chunk = data[offset:offset + chunk_size]
                try:
                    ok = await asyncio.wait_for(
                        loop.run_in_executor(
                            self._pty_executor, self._write_pty_sync, terminal_id, chunk
                        ),
                        timeout=10.0,
                    )
                    if not ok:
                        return False
                except asyncio.TimeoutError:
                    logger.warning(
                        "PTY write timed out for %s at offset %d/%d",
                        terminal_id, offset, len(data),
                    )
                    session.alive = False
                    return False
                except Exception:
                    logger.debug("PTY async write error for %s", terminal_id)
                    return False
                offset += chunk_size
                # Yield to event loop between chunks so the ConPTY pipe can drain
                # and heartbeats stay responsive.  A real delay (not just sleep(0))
                # is required for ConPTY — the pseudoconsole input buffer drops
                # bytes when chunks arrive faster than claude.exe can consume them.
                if offset < len(data):
                    await asyncio.sleep(_INTER_CHUNK_DELAY)
            return True

    def _write_pty_sync(self, terminal_id: str, data: str) -> bool:
        """Executor-safe PTY write (avoids isalive() kernel call on event loop)."""
        session = self.sessions.get(terminal_id)
        if not session:
            return False
        try:
            if not session.pty.isalive():
                session.alive = False
                return False
            data_bytes = data.encode("utf-8")
            total = len(data_bytes)
            written_bytes = 0
            remaining = data
            max_retries = 50
            retries = 0
            while remaining:
                if retries >= max_retries:
                    logger.error(
                        "PTY write safety valve tripped for %s — %d/%d bytes written",
                        terminal_id, written_bytes, total,
                    )
                    return False
                n = session.pty.write(remaining)
                # ConPTY's write() returns None — it handles partials internally,
                # so treat None as a complete write.
                if n is None:
                    break
                if n <= 0:
                    logger.error(
                        "PTY write returned %d for %s — %d/%d bytes written",
                        n, terminal_id, written_bytes, total,
                    )
                    return False
                written_bytes += n
                if written_bytes >= total:
                    break
                if n < len(remaining.encode("utf-8")):
                    logger.warning(
                        "PTY partial write for %s — wrote %d of %d remaining bytes",
                        terminal_id, n, len(remaining.encode("utf-8")),
                    )
                try:
                    remaining = data_bytes[written_bytes:].decode("utf-8")
                except UnicodeDecodeError:
                    logger.warning(
                        "PTY partial write split UTF-8 character for %s — %d/%d bytes",
                        terminal_id, written_bytes, total,
                    )
                    return False
                retries += 1
            return True
        except Exception:
            logger.debug("PTY write error for %s", terminal_id, exc_info=True)
            session.alive = False
            return False

    def start_state_ticker(self) -> None:
        """Start the background asyncio task that calls tick() on every live session.

        Must be called from the asyncio event loop (e.g. the FastAPI startup
        handler) so that asyncio.create_task() has a running loop available.
        Idempotent — if the task is already running this is a no-op.
        """
        if self._state_ticker_task is not None and not self._state_ticker_task.done():
            return
        self._state_ticker_task = asyncio.create_task(
            self._state_ticker_loop(), name="pty-state-ticker"
        )
        logger.info("State ticker started (interval=%.1fs)", self._STATE_TICKER_INTERVAL)

    async def stop_state_ticker(self) -> None:
        """Cancel the background state ticker and wait for it to exit.

        Called from the FastAPI shutdown handler alongside other cleanup tasks.
        Safe to call even if the ticker was never started.
        """
        task = self._state_ticker_task
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        logger.info("State ticker stopped")

    async def _state_ticker_loop(self) -> None:
        """Background loop: call tick() on every live session every second.

        This makes SessionStateTracker.state authoritative independently of
        frontend polling (/api/terminals), which was the only previous tick()
        call site.  Without this, the bridge idle gate could read a stale
        'busy' state long after the session had actually become idle, causing
        spurious bridge terminations.

        Error handling: a bad session's tick() must never kill the loop.
        Exceptions per session are caught and logged; the loop continues.
        CancelledError propagates cleanly to allow graceful shutdown.
        """
        try:
            while True:
                await asyncio.sleep(self._STATE_TICKER_INTERVAL)
                # Snapshot sessions to avoid mutation during iteration.
                for session in list(self.sessions.values()):
                    if not session.alive:
                        continue
                    try:
                        session.tracker.tick()
                    except Exception:
                        logger.warning(
                            "State ticker: tick() failed for session %s",
                            session.id,
                            exc_info=True,
                        )
        except asyncio.CancelledError:
            raise

    def shutdown(self):
        """Kill all sessions and clean up resources."""
        count = len(self.sessions)
        if count:
            logger.info("Shutting down %d session(s)...", count)
        for tid in list(self.sessions.keys()):
            self.kill_terminal(tid)
        self._pty_executor.shutdown(wait=True, cancel_futures=True)
        logger.info("PTY manager shutdown complete")


# Singleton
pty_manager = PtyManager()
