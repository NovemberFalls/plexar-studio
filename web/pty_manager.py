"""PTY session manager for Plexar Studio.

Spawns interactive CLI processes via Windows ConPTY
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
from terminal_history import TerminalHistory

logger = logging.getLogger("cockpit.pty")

# Warn-only; the read is still awaited, so bytes the executor thread already took
# off the ConPTY pipe are never discarded.
_PTY_READ_WARN_AFTER = 10.0

# Inter-chunk delay for large PTY writes.  ConPTY's input pipe buffer is
# shallower than winpty's; a 10 ms pause between 200-byte chunks gives the
# pseudoconsole host (claude.exe) enough time to drain the pipe before the
# next chunk arrives.  sleep(0) was enough for winpty but caused silent byte
# drops on the desktop (Tauri/ConPTY) build with large bracketed-paste blocks.
# Halved chunk size + tripled delay compared to earlier defaults to address
# paste fragmentation on ~400-byte pastes where ConPTY silently drops bytes.
_INTER_CHUNK_DELAY = 0.010

# Size at or below which a write goes out as ONE call, uncut.
#
# HISTORY — this value has now been wrong in both directions, so read before
# changing it.
#
# It was 200. I raised it to 65536 to fix the bridge: the slicer cut at blind
# byte offsets, so a boundary could land *inside* the `\x1b[200~` / `\x1b[201~`
# markers, and a split marker means the receiving TUI never enters paste mode.
# That diagnosis was right, but the remedy was wrong. Removing the cut also
# removed the PACING, and the pacing was load-bearing: ConPTY's input buffer
# drops or overwrites when written faster than claude.exe drains it. The result
# was a ~4 KB paste arriving with its HEAD missing and only its tail intact,
# while every layer reported success.
#
# The actual fix for the bridge was never the large single write — it was
# _split_preserving_escapes, which makes a boundary unable to bisect an escape.
# With that in place the pacing can come back at its previously-proven size and
# both properties hold at once: markers stay intact AND the pipe is not
# overrun.
#
# So: 200 bytes per write with _INTER_CHUNK_DELAY between them, boundaries
# escape-aware. A 4 KB paste is ~20 chunks ≈ 200 ms, which is not perceptible.
# If this is raised again, the thing to verify is not "does the bridge work"
# but "does a multi-KB paste arrive COMPLETE, head included."
_SINGLE_WRITE_MAX = 200

# Chunk size used above _SINGLE_WRITE_MAX.
_CHUNK_SIZE = 200

def _split_preserving_escapes(data: str, chunk_size: int) -> list[str]:
    """Split *data* into ~*chunk_size* pieces without ever cutting an escape.

    A boundary that falls inside an ANSI escape sequence (notably the
    bracketed-paste markers ``\\x1b[200~`` / ``\\x1b[201~``) delivers a broken
    sequence to the receiving TUI, which then never enters paste mode and
    treats every embedded newline as a submit — one message arrives as several
    fragments.  This walks each candidate boundary backwards to the start of
    any escape sequence it landed in, so sequences always cross intact.

    A boundary is unsafe when an ``\\x1b`` appears within the short window
    before it with no sequence-terminating byte in between.  ANSI CSI
    terminators are ``@``-``~`` (0x40-0x7E); the search window is bounded so a
    lone stray ESC in ordinary text can never rewind the split arbitrarily far.
    """
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")

    # Longest escape sequence we guard against; bracketed-paste markers are 6
    # bytes, so 16 is generous headroom without unbounded backtracking.
    max_escape_len = 16

    chunks: list[str] = []
    pos = 0
    n = len(data)
    while pos < n:
        end = min(pos + chunk_size, n)
        if end < n:
            # Walk back to just before an ESC that this boundary would bisect.
            window_start = max(pos, end - max_escape_len)
            esc = data.rfind("\x1b", window_start, end)
            if esc != -1:
                # Unsafe only if the sequence has not already terminated.
                # For CSI (``ESC [``) the terminator search must start AFTER the
                # ``[`` introducer — ``[`` is 0x5B and so sits inside the
                # 0x40-0x7E final-byte range, which would otherwise read every
                # CSI sequence as already complete the moment its ``[`` arrived.
                tail = data[esc:end]
                body = tail[2:] if tail[1:2] == "[" else tail[1:]
                if not any("\x40" <= ch <= "\x7e" for ch in body):
                    # Never emit an empty chunk — if the ESC sits at the very
                    # start of this chunk the sequence is longer than the
                    # window, so take the boundary as-is rather than stall.
                    if esc > pos:
                        end = esc
        chunks.append(data[pos:end])
        pos = end
    return chunks


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
                "fallback probe. Plexar Studio's PATH is likely stale — restarting it "
                "from a fresh shell avoids this lookup.",
                found,
            )
            return found, directory + os.pathsep + search_path

    raise ClaudeCliNotFound(
        "Could not find the `claude` CLI. Install Claude Code "
        "(https://claude.com/download), then restart Plexar Studio so it "
        "picks up the new PATH. If `claude` is installed somewhere unusual, "
        f"set the {_CLAUDE_CLI_PATH_ENV} environment variable to its full "
        "path. Searched PATH plus: " + ", ".join(searched),
        searched,
    )


# Environment override for the OpenAI `codex` CLI, mirroring
# _CLAUDE_CLI_PATH_ENV. Separate variable because the two harnesses are
# separate installs — a user can have one somewhere unusual and not the other.
_CODEX_CLI_PATH_ENV = "COCKPIT_CODEX_CLI_PATH"


class CodexCliNotFound(FileNotFoundError):
    """Raised when no `codex` executable can be located.

    Mirrors ClaudeCliNotFound exactly (including `.searched`) so server.py's
    existing `except FileNotFoundError` fallback still catches it, while a
    harness-aware caller can report which CLI was missing.
    """

    def __init__(self, message: str, searched: list[str] | None = None):
        super().__init__(message)
        self.searched = searched or []


def resolve_codex_cli(search_path: str) -> tuple[str, str]:
    """Locate the `codex` executable.

    Same contract as resolve_claude_cli: returns ``(codex_exe,
    effective_path)`` with the path extended when the CLI had to be found via
    the fallback probe, because the child resolves `codex` off PATH.

    Reuses ``_candidate_claude_dirs()`` deliberately and WITHOUT renaming it:
    that list is a npm-global / user-bin directory list, not a Claude-specific
    one, and `codex` ships via `npm install -g` into exactly those same
    directories. Duplicating it would give us two lists to keep in sync.
    """
    override = os.environ.get(_CODEX_CLI_PATH_ENV, "").strip().strip('"')
    if override:
        if os.path.isfile(override):
            override_dir = os.path.dirname(os.path.abspath(override))
            logger.info("Using %s override: %s", _CODEX_CLI_PATH_ENV, override)
            return override, override_dir + os.pathsep + search_path
        raise CodexCliNotFound(
            f"{_CODEX_CLI_PATH_ENV} is set to {override!r} but no file exists "
            "there. Point it at the full path of the `codex` executable, or "
            "unset it to fall back to PATH discovery.",
            [override],
        )

    found = shutil.which("codex", path=search_path)
    if found:
        return found, search_path

    searched = _candidate_claude_dirs()
    for directory in searched:
        if not os.path.isdir(directory):
            continue
        found = shutil.which("codex", path=directory)
        if found:
            logger.warning(
                "`codex` was not on the inherited PATH; found it at %s via the "
                "fallback probe. Plexar Studio's PATH is likely stale — restarting it "
                "from a fresh shell avoids this lookup.",
                found,
            )
            return found, directory + os.pathsep + search_path

    raise CodexCliNotFound(
        "Could not find the `codex` CLI. Install it with "
        "`npm install -g @openai/codex`, then restart Plexar Studio so it "
        "picks up the new PATH. If `codex` is installed somewhere unusual, "
        f"set the {_CODEX_CLI_PATH_ENV} environment variable to its full "
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
# Context fill printed by Claude Code itself, e.g. "Context window is 73% full".
# Kept as the PRECEDING source (not the primary one) -- see SessionStateTracker.
_CONTEXT_PCT_RE = re.compile(r"context\D{0,30}?(\d{1,3})\s*%", re.IGNORECASE)
# Terminal-title escape: ESC ] 0;<title> BEL (icon+title) or ESC ] 2;<title> BEL
# (title only), with ST (ESC \) accepted as the terminator too. Only OSC 0 and 2
# are titles -- OSC 8 (hyperlinks) and every other OSC number are ignored.
_OSC_TITLE_RE = re.compile(r"\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)")

# Leading "decoration" run stripped by normalize_cli_title: status glyphs,
# spinners, emoji, box-drawing -- anything that is not a character a real
# title would legitimately start with.
_TITLE_LEADING_DECORATION_RE = re.compile(
    "^[^A-Za-z0-9_(\\[\"']*\\s*"
)


def normalize_cli_title(raw: Optional[str]) -> Optional[str]:
    """Normalize a raw CLI-emitted terminal title, or None if unusable.

    The CLI's terminal title is ``<status glyph> <label>`` and the glyph
    animates (see the R-177 measurement in CLAUDE.md), so the raw OSC value is
    never itself the session name -- only the label after the leading
    decoration is. Internal punctuation/emoji are preserved; only the LEADING
    run is stripped.

    Returns None (never adopt) when: the value contains decode damage
    (``�``), the remainder after stripping leading decoration and
    trailing whitespace is empty, or it case-folds to "claude"/"codex" (every
    CLI sets the title to its own binary name on startup -- not a rename).
    """
    if raw is None:
        return None
    value = raw.strip()
    if not value:
        return None
    if "�" in value:
        return None
    value = _TITLE_LEADING_DECORATION_RE.sub("", value)
    value = value.rstrip()
    if not value:
        return None
    value = value[:120]
    if value.casefold() in ("claude", "codex"):
        return None
    return value


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
        # Context window fill. TWO independent sources, in strict precedence
        # order -- see the `context_percent` property below.
        #   reported_* : scraped from PTY text when Claude Code prints a context
        #                line. Rare, but an explicitly reported number beats
        #                anything we derive, so it wins when present.
        #   derived_*  : computed from the LATEST usage_events turn
        #                (input + cache_read tokens / model context window) by
        #                PtyManager.refresh_derived_context. This is the normal
        #                source: the scrape used to be the ONLY source, and
        #                because Claude Code does not routinely print that
        #                string, context_percent was permanently None.
        self.reported_context_percent: Optional[int] = None
        self.derived_context_percent: Optional[int] = None
        self.effort: Optional[str] = None  # last effort level seen in PTY output (e.g. "high")
        # Last terminal title the CLI set via OSC 0/2. This is the ONLY channel
        # through which a Codex-side rename is observable (its rollout carries
        # no title record); for claude-code it is a second channel beside the
        # transcript's custom-title record. None means "never seen one".
        self.osc_title: Optional[str] = None

    @property
    def context_percent(self) -> Optional[int]:
        """Context window fill %, or None when genuinely unknown.

        PRECEDENCE: a percentage Claude Code itself printed (``reported_``) wins
        over the one we derive from token counts (``derived_``). The session's own
        accounting is authoritative; ours is a reconstruction whose denominator
        can be wrong (unknown model, wrong variant).

        None means "not measurable", NOT zero -- the frontend renders an em dash
        plus "not reported" for None and a true 0% only when no turn exists.
        Read-only on purpose: writing through this name is what let the scrape
        silently monopolise the value.
        """
        if self.reported_context_percent is not None:
            return self.reported_context_percent
        return self.derived_context_percent

    def feed(self, raw_data: str) -> None:
        """Process new PTY output data."""
        self.last_output_time = time.time()
        self.state = "busy"

        # Terminal-title extraction. A SEPARATE pass over the same chunk, run
        # before the ANSI strip (which deletes OSC sequences outright), so it
        # cannot perturb state/token/cost detection below. A title split across
        # two PTY reads is missed -- accepted: the CLI re-emits its title, and
        # buffering partial escapes here would put parser state on the hot path.
        for m in _OSC_TITLE_RE.finditer(raw_data):
            value = m.group(1).strip()
            if value:
                self.osc_title = value

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
        #
        # This is the FALLBACK-shaped source that used to be the only one: it
        # takes precedence when it fires (see the context_percent property), but
        # Claude Code rarely prints such a line, so it is not what makes the ring
        # work -- refresh_derived_context is.
        ctx_match = _CONTEXT_PCT_RE.search(clean)
        if ctx_match:
            self.reported_context_percent = int(ctx_match.group(1))

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
    # Which CLI this PTY is actually running: "claude-code" | "codex". Defaults
    # to the historical value so every existing construction site (tests, the
    # bridge fixtures) keeps meaning what it meant.
    harness: str = "claude-code"
    working_dir: str = ""
    claude_session_id: Optional[str] = None  # for --resume
    codex_session_id: Optional[str] = None
    codex_rollout_path: Optional[str] = None
    codex_usage: dict = field(default_factory=dict)
    codex_usage_reader: Any = None
    codex_usage_lock: Any = field(default_factory=threading.Lock)
    codex_usage_checked: float = 0.0
    # When the owned rollout was last SEARCHED FOR (R-193) — separate from the
    # 2 s usage read above, because the search is the expensive half.
    codex_discover_checked: float = 0.0
    codex_binding_status: str = "retained"
    history: TerminalHistory = field(default_factory=TerminalHistory)
    history_changed: asyncio.Event = field(default_factory=asyncio.Event)
    # One asyncio.Event per attached Studio Remote stream socket. Separate from
    # history_changed on purpose: the desktop replay socket owns that one, and a
    # phone must never share (or displace) the desktop's wakeup or its
    # active_consumer generation. _session_reader sets every member on append.
    remote_listeners: set = field(default_factory=set)
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
    # Vestigial: nothing writes this and nothing reads it. The serialised value
    # comes from `session.tracker.context_percent` (both _session_to_dict here
    # and server.py's single-terminal route read the tracker). Left in place only
    # because it is part of the dataclass signature; do not start using it.
    context_percent: Optional[int] = None
    write_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    last_user_input_time: float = 0.0  # monotonic timestamp of last user keystroke (bridge typing-quiet gate)
    last_output_time: float = 0.0  # monotonic timestamp of last PTY output (JSONL staleness detection)
    # Which side last named this session: "studio" (a desktop/API rename) or
    # "cli" (a /rename inside Claude Code, or a terminal title from Codex).
    # The most recent act wins on either side; this records which that was.
    name_source: str = "studio"
    cli_title: Optional[str] = None  # last CLI-side title observed, from either channel
    _cli_title_checked: float = 0.0  # monotonic throttle stamp for _refresh_cli_title


def _resolve_max_sessions() -> int:
    """Concurrent-session cap: env var wins, else settings.json, else 8.

    `sessions.max_sessions` has been in DEFAULT_SETTINGS since the facelift and
    NOTHING read it -- one of the documented "persisted but not yet enforced"
    keys. It is read here now, so the Settings field means something.

    Precedence is env-first because MAX_SESSIONS is how a headless/CI run pins
    the value, and a settings file on disk must not override an operator who
    set it explicitly for this process.

    This is deliberately NOT removed as a cap. It is the backstop against a
    runaway spawn loop; what changed is that it is a value the user can raise
    (up to the 1-64 bound in settings_store) rather than a constant matching
    the old 8-pane grid. Read ONCE at import: the limit is checked on every
    create, and a live read would let a settings save change it mid-flight
    with no way to see that it had.
    """
    env = os.getenv("MAX_SESSIONS")
    if env is not None:
        try:
            return max(1, int(env))
        except ValueError:
            logger.warning("MAX_SESSIONS=%r is not an integer -- falling back to settings", env)
    try:
        from settings_store import read_settings

        value = read_settings().get("sessions", {}).get("max_sessions")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 1:
            return value
    except Exception:
        logger.warning("Could not read sessions.max_sessions from settings", exc_info=True)
    return 8


MAX_SESSIONS = _resolve_max_sessions()

# How often a Codex session's rollout is RE-SEARCHED (R-193). The search used
# to call `psutil.Process.open_files()` on the CLI and every child — which on
# Windows enumerates every handle on the machine and holds the GIL while it
# does, so its cost grew with Unreal, browsers and everything else running.
# MEASURED 2026-09-10 on the owner's sidecar with six sessions: ~64% of all
# py-spy samples in the process, every 2 s, even after the rollout was already
# bound; 2026-09-11, 2.9 s per scan. R-194 replaced it with a directory scan,
# which is cheap — this spacing is kept anyway, because a search that need not
# run is a search that should not. Reading the bound rollout stays every 2 s
# (it is incremental and cheap); only the search is spaced out. The cost of
# the spacing: after a native `/new` or `/resume`, usage follows the new chat
# within _BOUND seconds instead of 2. Nothing is lost — the new rollout is
# read from its start once found.
_CODEX_REDISCOVER_BOUND_S = 30.0
_CODEX_REDISCOVER_UNBOUND_S = 10.0
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

# Allowed harnesses — which CLI is spawned in the PTY. "claude-code" is the
# default and the historical behaviour; "codex" spawns OpenAI's `codex` CLI
# instead. The harness is orthogonal to the provider: a codex session can still
# be routed at OpenRouter, which is why this is a separate dimension rather
# than another _ALLOWED_PROVIDERS value.
_ALLOWED_HARNESSES = {"claude-code", "codex"}

# Codex model-id validator. The Anthropic regex does not apply: Codex ids carry
# no "[1m]" long-context suffix, and their catalog is static (Codex publishes no
# live /v1/models route we consume), so a closed allowlist here would drift the
# same way the Anthropic one did. Same anti-injection intent though — the id is
# interpolated into the cmd string after `-m`, so the first character must be
# alphanumeric to block a "--flag"-shaped value, and the remainder is limited to
# a charset with no spaces/quotes/semicolons/slashes.
_CODEX_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

# Anthropic model ids, recognised so the codex harness can REFUSE them.
#
# This is deliberately a NEGATIVE check rather than a positive allowlist of
# Codex ids. A positive list would drift the moment OpenAI ships a model —
# exactly the failure _CODEX_MODEL_RE's comment above is guarding against, and
# exactly what happened to CODEX_MODEL_GROUPS' retired gpt-5.4 entries. The set
# we CAN enumerate without drift is the other side: Anthropic's own ids all
# begin "claude-", plus the three bare CLI aliases. A model id that is not one
# of those is not our business to judge, and is allowed through.
_ANTHROPIC_MODEL_ALIASES = frozenset({"sonnet", "opus", "haiku"})


def _looks_anthropic(model: str) -> bool:
    """True for a model id that is unambiguously Claude's, never for a Codex id.

    Case-insensitive on the prefix only; the bare aliases are matched exactly,
    because `claude --model sonnet` is the spelling the CLI accepts.
    """
    if not isinstance(model, str):
        return False
    stripped = model.strip()
    return stripped.lower().startswith("claude-") or stripped in _ANTHROPIC_MODEL_ALIASES

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
# "--flag"-style injection landing in ANTHROPIC_MODEL.
#
# THIS IS NOW A COMMAND-LINE VALUE, not only an env var. The old comment here
# said "only ever placed into env vars, never the cmd string" -- true while the
# claude harness owned this path, and false the moment a local model could ride
# `codex -m <id>`. The charset was already safe for that (no whitespace, no
# quote, no shell metacharacter), so the widened use needs no change to the
# pattern -- but the reason it is safe is now load-bearing rather than
# incidental, and must not be relaxed.
_LOCAL_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-\/]{0,127}$")

# A local provider id, for the same reason. Under the codex harness the id is
# interpolated into `-c model_provider=<id>` and three `model_providers.<id>.*`
# keys, so it crosses shlex and (for .cmd installs) cmd.exe. Ids come from the
# registry -- including one an operator supplies via COCKPIT_PROVIDERS_FILE --
# so "it can only be one of ours" is an assumption about a config file, not a
# guarantee. Also a valid TOML bare key, which is what codex parses it as.
_LOCAL_PROVIDER_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$")

# The env var a codex session's provider config names as its `env_key`. One
# fixed name rather than one per provider: a session talks to exactly one
# engine, and a per-provider name would have to be derived from the id, which
# contains hyphens and is therefore not a legal env var name everywhere.
_CODEX_LOCAL_KEY_ENV = "PLEXAR_STUDIO_LOCAL_KEY"


class PtyManager:
    """Manages PTY-backed terminal sessions."""

    # File that tracks PIDs of claude processes spawned by this cockpit instance.
    # Only these PIDs are killed during orphan cleanup — never random Claude sessions.
    #
    # **PORT-SCOPED, and that is load-bearing.** This used to be one fixed path
    # shared by every instance started from this directory, which made the file a
    # cross-instance channel rather than a per-instance record: a second server
    # (a dev run, a test rig, a probe on another port) read the LIVE server's
    # tracked child PIDs and `cleanup_orphans()` killed them at startup. The
    # user's running sessions died because someone started a second copy. Two
    # servers cannot share a port, so the port is exactly the right discriminator.
    _PID_TRACK_DIR = os.path.dirname(__file__)
    # The pre-port-scoping name. Read ONCE, and only by the instance that would
    # have owned it, then deleted — see `_migrate_legacy_pid_file`.
    _LEGACY_PID_TRACK_FILE = os.path.join(_PID_TRACK_DIR, ".cockpit-child-pids")

    # Interval (seconds) at which the background state ticker calls tick() on
    # every live session.  1 second is fine-grained enough that the bridge idle
    # gate sees a fresh state within one poll cycle without significant overhead.
    _STATE_TICKER_INTERVAL = 1.0
    # Refresh the derived context percentage every Nth tick -> 5s, matching
    # server.py's usage-ingest loop. Ingest is what puts new turns in the DB, so
    # polling faster than it cannot see anything new.
    _CONTEXT_REFRESH_TICKS = 5

    def __init__(self):
        self.sessions: dict[str, TerminalSession] = {}
        self._lock = threading.Lock()  # Protects sessions dict and PID file
        self._pty_executor = ThreadPoolExecutor(max_workers=64)
        self._state_ticker_task: Optional[asyncio.Task] = None
        # Resolved per instance, at construction, from the port this process will
        # serve. Read here rather than at class-definition time so a test (or the
        # probe launcher) that sets PORT before constructing gets its own file.
        self._PID_TRACK_FILE = os.path.join(
            self._PID_TRACK_DIR, f".cockpit-child-pids-{os.getenv('PORT', '8420')}"
        )

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

    def _migrate_legacy_pid_file(self) -> None:
        """Adopt the pre-port-scoping PID file, exactly once, and only if it is ours.

        A build that predates port scoping wrote `.cockpit-child-pids` with no
        port. Ignoring it outright would strand those PIDs forever — one upgrade
        where a crash's orphans are never reaped.

        **The guard is the whole point: only the DEFAULT-port instance adopts it.**
        A dev server or a probe on another port must never read that file, because
        the process that wrote it may be an older build that is *still running*,
        and adopting its PIDs is precisely the cross-instance kill this scoping
        exists to prevent. Two servers cannot both hold 8420, so the default-port
        instance is the only one that can safely claim to be its successor.
        """
        if os.getenv("PORT", "8420") != "8420":
            return
        legacy = self._LEGACY_PID_TRACK_FILE
        if not os.path.exists(legacy):
            return
        try:
            with open(legacy) as f:
                pids = {int(ln.strip()) for ln in f if ln.strip().isdigit()}
            if pids:
                with self._lock:
                    merged = self._load_child_pids() | pids
                    self._write_child_pids(merged)
                logger.info("Adopted %d PID(s) from the legacy child-PID file", len(pids))
            os.remove(legacy)
        except Exception:
            logger.debug("Legacy child-PID migration failed — continuing", exc_info=True)

    def cleanup_orphans(self):
        """Kill cockpit-spawned claude processes left over from a previous crash.

        Only kills processes whose PIDs were tracked in THIS instance's child-PID
        file. Never touches Claude sessions running in other terminals or editors,
        and — since the file is port-scoped — never another cockpit instance's.
        """
        self._migrate_legacy_pid_file()
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
                    logger.info("Killing orphaned Plexar Studio child: %s (PID %d)", proc.name(), pid)
                    proc.kill()
                    killed += 1
                else:
                    logger.debug("PID %d reused by '%s' — skipping", pid, proc.name())
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                logger.debug("PID %d gone or inaccessible during orphan cleanup — skipping", pid, exc_info=True)
                continue

        self._clear_child_pids()

        if killed:
            logger.info("Cleaned up %d orphaned Plexar Studio process(es)", killed)
        else:
            logger.debug("No orphaned Plexar Studio processes found")

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
        harness: str = "claude-code",
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

        harness selects which CLI is spawned:
          - "claude-code" (default): the `claude` CLI, unchanged behaviour.
          - "codex": OpenAI's `codex` CLI. Orthogonal to ``provider`` —
            provider="anthropic" means "Codex's own backend" here, and
            provider="openrouter" reroutes it via Codex's custom
            model_provider config. provider="local" is REFUSED (Codex speaks
            the Responses API; the local engines serve Chat Completions).
        """
        if len(self.sessions) >= MAX_SESSIONS:
            raise RuntimeError(f"Maximum session limit ({MAX_SESSIONS}) reached")

        # Validate provider against the allowlist before anything else — every
        # branch below depends on knowing which provider we're spawning for.
        if provider not in _ALLOWED_PROVIDERS:
            raise ValueError(f"Invalid provider: {provider!r}")
        # Validated here too, beside provider, because the two together decide
        # every branch below — the model validator, the command build, and
        # which CLI gets resolved.
        if harness not in _ALLOWED_HARNESSES:
            raise ValueError(f"Invalid harness: {harness!r}")
        # A local engine under Codex is refused ONLY when the engine has been
        # MEASURED not to serve the Responses API.
        #
        # This used to be a blanket refusal on the grounds that local providers
        # serve Chat Completions and Codex speaks Responses. The second half is
        # still true (codex-cli rejects `wire_api = "chat"` outright); the first
        # half went stale -- vLLM gained /v1/responses and Plexar passes it
        # through, so `codex` drives a Plexar rig end to end. Refusing the pair
        # on the KIND rather than on the engine's actual protocol locked users
        # out of a combination that works.
        #
        # The check is deferred to the probe in server.py, which answers
        # True / False / None. None means the engine could not be reached and
        # has therefore told us nothing: it is NOT a refusal, because reporting
        # "your engine cannot do this" about an engine we failed to ask is the
        # same false claim about machine state that the models route's
        # `authorized` split exists to prevent.
        if harness == "codex" and provider == "local" and provider_model:
            import server as _probe_server
            _pid = provider_model.split("::", 1)[0]
            if _probe_server.provider_speaks_responses(_pid) is False:
                raise ValueError(
                    f"{_pid} does not serve the Responses API, which is the only "
                    "wire protocol the Codex CLI speaks. Switch the harness to "
                    "Claude Code to use this engine."
                )

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
            if not _LOCAL_PROVIDER_ID_RE.match(local_provider_id):
                raise ValueError(f"Invalid local provider id: {local_provider_id!r}")
            # URL resolution is server-side only (SSRF stance) — the browser
            # never supplies a URL, only the provider id. server.py owns the
            # provider registry, so we lazy-import it here (server.py already
            # imports pty_manager at module scope, so importing server from
            # here at module scope would be circular; a call-time import is
            # safe since server.py is fully loaded by the time a session is
            # created).
            import server as _server
            if harness == "codex":
                # Codex needs the ENGINE's own OpenAI surface. resolve_local_base_url
                # hands back Studio's /shim/* routes, which translate the Anthropic
                # wire shape for the `claude` CLI -- handing a Responses request to an
                # Anthropic translator would 404 every turn.
                local_base_url = _server.resolve_local_openai_base_url(local_provider_id)
            else:
                local_base_url = _server.resolve_local_base_url(local_provider_id, terminal_id)
            if not local_base_url:
                raise ValueError(f"Unknown or non-local provider id: {local_provider_id!r}")
        elif harness == "codex":
            # Defense in depth, the twin of the provider="local" refusal above.
            # `claude-opus-5` satisfies _CODEX_MODEL_RE — it is alphanumeric,
            # hyphenated and injection-free — so the regex alone happily
            # spawned `codex -m claude-opus-5`, which authenticates fine and
            # then 400s on every turn. That pair was reachable from the UI on
            # 2.1.0 (TopBar restored harness="codex" and model="claude-opus-5"
            # from two independent localStorage keys), and it stays reachable
            # by a direct POST regardless of what the frontend does.
            #
            # BEFORE the charset regex, deliberately. A long-context id like
            # "claude-opus-5[1m]" carries brackets that _CODEX_MODEL_RE rejects
            # anyway, so ordering does not change WHETHER it is refused — only
            # which message the user gets. "Invalid Codex model" is true and
            # useless; it reads as a malformed id when the id is perfectly
            # well-formed and simply belongs to the other CLI. The actionable
            # message has to win for every Claude id, not just the ones that
            # happen to survive the regex.
            #
            # Scoped to provider="anthropic": under provider="openrouter" the
            # id that reaches the CLI is provider_model (an OpenRouter slug
            # like "anthropic/claude-opus-5"), which Codex reaches legitimately
            # through its custom model_provider — refusing that would break a
            # supported combination.
            if provider == "anthropic" and _looks_anthropic(model):
                raise ValueError(
                    f"{model!r} is a Claude model and the Codex harness cannot run it — "
                    "pick a Codex model, or switch the harness to Claude Code."
                )
            # Codex model ids are not Anthropic ids, so the Anthropic
            # allowlist/regex would reject every valid one. Same injection
            # guard, different charset — see _CODEX_MODEL_RE.
            if not _CODEX_MODEL_RE.match(model):
                raise ValueError(f"Invalid Codex model: {model!r}")
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

        # 3. STRIP INHERITED COLOUR SUPPRESSION. `NO_COLOR` is a real standard
        #    and a legitimate preference for a CONSOLE program. This is not one:
        #    Studio renders ANSI into xterm.js by construction, and the variable
        #    it inherits belongs to whatever shell happened to launch the GUI.
        #
        #    MEASURED 2026-08-03, not hypothesised: `NO_COLOR=1` existed in the
        #    PROCESS environment only -- not User, not Machine -- because Studio
        #    was started from an agent shell that carried it. That shell had
        #    already exited. The CLI correctly disabled colour, the terminal went
        #    grey, and nothing anywhere was wrong except the inheritance.
        #
        #    STRIP RATHER THAN OVERRIDE, deliberately. Forcing `FORCE_COLOR=1`
        #    would override the CLI's own detection in cases that have nothing to
        #    do with this bug -- a redirected stream, a genuinely dumb terminal.
        #    Removing an inherited signal that was never about this app leaves
        #    the CLI free to decide correctly; forcing a value takes that away.
        #
        #    A GUI app's rendering must not be a function of its parent process:
        #    the same launch, from two different shells, produced two different
        #    terminals and neither the user nor the app could see why.
        blocked_keys |= {"NO_COLOR"}
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

        # THE ESCAPE HATCH, and it must exist. A colourless terminal is a
        # legitimate thing to want -- for accessibility, for a screen reader,
        # for a preference. What it must never be is an ACCIDENT OF LAUNCH
        # CONTEXT. So it is reachable from settings and nowhere else: an
        # inherited NO_COLOR is discarded above as launcher noise, and a
        # deliberate one is re-applied here as intent. The distinction between
        # noise and intent is the whole fix.
        try:
            # NO local `import settings_store` here: the module is already
            # imported at module scope (line 24), and a function-local import
            # makes the name LOCAL for the ENTIRE function -- which turned the
            # openrouter key lookup 120 lines above into an UnboundLocalError.
            # Six existing tests caught it; the fix is to use the import that
            # already exists rather than to add a second one.
            if bool((settings_store.read_settings().get("terminal") or {}).get("no_color")):
                env["NO_COLOR"] = "1"
        except Exception:
            logger.warning("Could not read terminal.no_color; leaving colour enabled",
                           exc_info=True)

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

        if provider == "openrouter" and harness == "codex":
            # Codex reads NONE of the ANTHROPIC_* plumbing below — it is routed
            # by the `-c model_providers.openrouter.*` config emitted in the
            # command build, and that config names OPENROUTER_API_KEY as its
            # env_key. So the ONE thing this branch owes the child is that
            # variable. Setting the ANTHROPIC_* vars here would be inert at
            # best and misleading at worst.
            env["OPENROUTER_API_KEY"] = openrouter_key
            # NEVER log the key itself — var names only.
            logger.info("OpenRouter provider (codex harness): set env vars %s",
                        ["OPENROUTER_API_KEY"])
        elif provider == "openrouter":
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
        elif provider == "local" and harness == "codex":
            # Codex is routed by the `-c model_providers.*` config emitted in the
            # command build, and that config names _CODEX_LOCAL_KEY_ENV as its
            # env_key. The ONE thing this branch owes the child is that variable
            # -- exactly the shape the openrouter+codex branch above uses.
            #
            # The dummy matters: codex refuses a provider whose env_key names an
            # unset variable, and an engine that needs no credential (LM Studio)
            # would otherwise be unlaunchable. Same reasoning as the "local"
            # dummy on the claude path -- None from resolve_local_auth_token
            # means "none needed", never "we could not find one".
            env[_CODEX_LOCAL_KEY_ENV] = (
                _server.resolve_local_auth_token(local_provider_id) or "local"
            )
            logger.info("Local provider (codex harness): set env vars %s",
                        [_CODEX_LOCAL_KEY_ENV])
        elif provider == "local":
            # Reroute this session's `claude` CLI onto a local inference
            # server (LM Studio via the broker, or vLLM via cockpit's own
            # /shim/vllm route) — base URL resolved server-side above.
            # ANTHROPIC_API_KEY is explicitly cleared for the same reason as
            # the openrouter branch — no fallback to a real Anthropic key.
            #
            # ANTHROPIC_AUTH_TOKEN was a hard-coded "local" dummy, which was
            # right while every local provider was unauthenticated. Plexar
            # gates /v1/*, so the dummy 401s and the session fails on its
            # first turn. The real credential is resolved server-side (the
            # browser never sees it) and the dummy remains for providers that
            # need no credential — the CLI refuses an empty value.
            env["ANTHROPIC_BASE_URL"] = local_base_url
            env["ANTHROPIC_AUTH_TOKEN"] = (
                _server.resolve_local_auth_token(local_provider_id) or "local"
            )
            env["ANTHROPIC_API_KEY"] = ""
            env["ANTHROPIC_MODEL"] = local_model_id
            # Without this, the CLI's default small/fast model (a
            # claude-3-5-haiku-ish id, used for background tasks like title
            # generation) still gets sent to the LOCAL base URL and 404s —
            # the local server doesn't know that model id. Point it at the
            # same local model, mirroring the openrouter branch.
            env["ANTHROPIC_SMALL_FAST_MODEL"] = local_model_id
            # Local-lane fix: the CLI's default ~32k output reservation counts
            # against the window, so a local server 500s partway through a
            # conversation. Derived from the window this provider actually
            # published where that is known — a flat 8000 against a 12288-token
            # window would leave ~4k of usable input. Falls back to the old
            # constant when the window is unknown rather than inventing one.
            env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = str(
                _server.resolve_local_output_reservation(local_provider_id, local_model_id)
                or 8000
            )
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
        #
        # Skipped entirely under the codex harness: ~/.claude/projects is
        # Claude Code's store and a codex session never writes to it, so a
        # snapshot there would be a diff against a directory this session
        # cannot touch. Leaving _pre_spawn_files unset also keeps
        # claude_session_id None — see _get_jsonl_path, which refuses to
        # discover for a non-claude harness rather than let Strategy 3 claim
        # some other pane's transcript.
        pre_spawn_files: Optional[set] = None
        if harness == "claude-code":
            home = os.path.expanduser("~")
            project_id = workdir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
            jsonl_dir = os.path.join(home, ".claude", "projects", project_id)
            pre_spawn_files = set()
            if os.path.isdir(jsonl_dir):
                pre_spawn_files = {f for f in os.listdir(jsonl_dir) if f.endswith(".jsonl")}

        if harness == "codex":
            # `codex -m <model>`: unlike the claude CLI there is no env-var
            # route for model selection, so the id (or the OpenRouter slug)
            # always rides the command line. Both are regex-validated above.
            codex_model = (
                provider_model if provider == "openrouter"
                else local_model_id if provider == "local"
                else model
            )
            # Embedded panes need the normal screen buffer: Codex's alternate
            # screen has no terminal scrollback. Its inline mode is the Codex
            # equivalent of CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN above.
            cmd = f"codex -m {codex_model} --no-alt-screen"
            if provider == "openrouter":
                # Codex's own config-override syntax. wire_api=responses
                # because that is the only wire protocol Codex speaks, and
                # OpenRouter serves it.
                cmd += (
                    " -c model_provider=openrouter"
                    " -c model_providers.openrouter.name=OpenRouter"
                    " -c model_providers.openrouter.base_url=https://openrouter.ai/api/v1"
                    " -c model_providers.openrouter.env_key=OPENROUTER_API_KEY"
                    " -c model_providers.openrouter.wire_api=responses"
                )
            elif provider == "local":
                # The same override shape as OpenRouter above, pointed at the
                # engine the user picked. `wire_api=responses` is not a choice:
                # codex-cli refuses `chat` outright ("`wire_api = \"chat\"` is no
                # longer supported"), which is why create_terminal refuses a
                # provider measured not to serve Responses rather than emitting
                # a config that cannot work.
                #
                # The provider id is the config key. It is validated against
                # _LOCAL_PROVIDER_ID_RE before interpolation -- these strings go
                # through shlex and, for .cmd installs, cmd.exe, so an id
                # carrying a space or a shell metacharacter is a command
                # injection, not a typo.
                cmd += (
                    f" -c model_provider={local_provider_id}"
                    f" -c model_providers.{local_provider_id}.name={local_provider_id}"
                    f" -c model_providers.{local_provider_id}.base_url={local_base_url}"
                    f" -c model_providers.{local_provider_id}.env_key={_CODEX_LOCAL_KEY_ENV}"
                    f" -c model_providers.{local_provider_id}.wire_api=responses"
                )
        elif provider in ("openrouter", "local"):
            # OpenRouter slugs and local model ids (e.g. "qwen/qwen3-coder-next"
            # or "/models/Qwen3-Coder-30B-A3B-AWQ") are not valid --model values
            # for the claude CLI — model selection rides ANTHROPIC_MODEL (set
            # above) instead. --model is omitted entirely.
            cmd = "claude"
        else:
            cmd = f"claude --model {model}"
        if harness == "claude-code":
            # Names cross both shlex and (for .cmd installs) cmd.exe /c.
            # Keep one quoted argument. Unsupported names retain their exact
            # UI label; explicit later renames still use the existing relay.
            if name.startswith("-") or any(ord(char) < 32 or ord(char) == 127 or char in '\"\\%!$`&|<>^()' for char in name):
                logger.info("Terminal %s: CLI --name omitted because label needs unsafe command quoting",
                            terminal_id)
            else:
                cmd += f' --name "{name}"'
        if harness == "codex" and (resume_session_id or continue_last):
            target = resume_session_id if resume_session_id else "--last"
            cmd = cmd.replace("codex ", f"codex resume {target} ", 1)
        elif resume_session_id:
            cmd += f" --resume {resume_session_id}"
        elif continue_last:
            cmd += " --continue"

        # Permission mode logic:
        # bypass_permissions (legacy boolean) or permission_mode == "bypassPermissions"
        # both map to --dangerously-skip-permissions; bypass wins and we do NOT
        # also append --permission-mode to avoid duplicate/conflicting flags.
        effective_bypass = bypass_permissions or (permission_mode == "bypassPermissions")
        if harness == "codex":
            # Codex expresses the same intent as a sandbox level plus an
            # approval policy, not as one --permission-mode flag. Mapped rather
            # than passed through so the pane's existing permission control
            # keeps meaning the same thing to the user across both harnesses.
            if effective_bypass:
                cmd += " --dangerously-bypass-approvals-and-sandbox"
            elif permission_mode == "acceptEdits":
                cmd += " --sandbox workspace-write --ask-for-approval on-request"
            elif permission_mode == "plan":
                # read-only + untrusted is the closest Codex gets to plan mode:
                # it can look but every action needs a human.
                cmd += " --sandbox read-only --ask-for-approval untrusted"
            # default/auto/dontAsk: no flags — Codex's own defaults apply.
        elif effective_bypass:
            cmd += " --dangerously-skip-permissions"
        elif permission_mode and permission_mode != "default":
            # All values in _ALLOWED_PERMISSION_MODES are allowlist-validated above.
            cmd += f" --permission-mode {permission_mode}"

        # Effort level: empty string means "use model default" (no flag appended).
        # Skipped entirely for openrouter/local — foreign/local models don't support --effort.
        if effort and harness == "codex":
            # Codex takes reasoning effort as a config override, not a flag.
            # Values are allowlist-validated above and share the {low..max}
            # vocabulary, so the same string carries across.
            cmd += f" -c model_reasoning_effort={effort}"
        elif effort and provider in ("openrouter", "local"):
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
        if fast and harness == "codex":
            # Fast mode is a Claude Code settings key. Codex has no equivalent,
            # so the request is dropped loudly rather than silently — same
            # shape as the openrouter/local skips below.
            logger.info("Fast mode requested but skipped — not supported by the codex harness")
        elif fast and provider in ("openrouter", "local"):
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
        if harness == "codex":
            cli_path, current_path = resolve_codex_cli(current_path)
        else:
            cli_path, current_path = resolve_claude_cli(current_path)
        env["PATH"] = current_path
        logger.info("Spawning: %s", cmd)
        logger.info("Harness %s found at: %s", harness, cli_path)
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
            harness=harness,
            working_dir=workdir,
            # Each harness keeps its own native transcript identity.
            claude_session_id=None if harness == "codex" else (resume_session_id or None),
            codex_session_id=(resume_session_id or None) if harness == "codex" else None,
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
        logger.info("Terminal %s alive=true cause=spawned harness=%s", terminal_id, harness)

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
        if session.alive:
            logger.info("Terminal %s alive=false cause=kill-requested", terminal_id)
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
        # Every strategy below reads ~/.claude/projects, which only the claude
        # CLI writes. A codex session has no file there — and Strategy 3 would
        # happily hand it the most recently written unclaimed transcript
        # belonging to some other pane (the bug #15 mis-attribution family).
        # Refuse rather than guess; Codex transcripts are not read at all.
        if getattr(session, "harness", "claude-code") != "claude-code":
            return None

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
            if session.alive:
                logger.info("Terminal %s alive=false cause=list-process-exited", session.id)
            session.alive = False
        else:
            session.tracker.tick()
        return {
            "id": session.id,
            "name": session.name,
            "name_source": session.name_source,
            "cli_title": session.cli_title,
            "model": session.model,
            "provider": session.provider,
            "harness": session.harness,
            "created_at": session.created_at,
            "working_dir": session.working_dir,
            "claude_session_id": session.claude_session_id,
            "codex_session_id": session.codex_session_id,
            "jsonl_path": self._get_jsonl_path(session),
            "bypass_permissions": session.bypass_permissions,
            "cols": session.cols,
            "rows": session.rows,
            "alive": alive,
            "activity_state": session.tracker.state,
            "tokens": session.tracker.total_tokens,
            "cost": session.tracker.total_cost,
            "context_percent": (
                session.codex_usage.get("context_percent")
                if session.harness == "codex" else session.tracker.context_percent
            ),
        }

    def list_terminals(self) -> list[dict]:
        """List all terminals, marking dead ones but NOT removing them.

        Dead sessions are left in the dict so that concurrent code paths
        (e.g. the post-spawn health check) can still find them.  They are
        cleaned up by explicit ``kill_terminal`` or ``cleanup_idle_sessions``.
        """
        return [self._session_to_dict(session) for session in self.sessions.values()]

    def refresh_codex_usage(self, session, usage_store=None):
        """Bind only the owned process's rollout; unknown identity stays unknown."""
        from codex_usage import CodexUsageReader, discover_rollout, reference_pricing, spawn_epoch
        with session.codex_usage_lock:
            now = time.monotonic()
            prior_check = session.codex_usage_checked
            if now - prior_check < 2:
                return dict(session.codex_usage)
            session.codex_usage_checked = now
            previous_path = session.codex_rollout_path
            candidate_path = previous_path
            binding_status = "retained"
            live = session.alive and session.pty.isalive()
            # A check time of 0 means "never refreshed" (and is how callers and
            # tests force a full refresh): the search runs. Otherwise it runs only
            # when due — see _CODEX_REDISCOVER_*. Reads with defaults because
            # callers may pass a lightweight session object.
            last_search = getattr(session, "codex_discover_checked", 0.0)
            interval = _CODEX_REDISCOVER_BOUND_S if previous_path else _CODEX_REDISCOVER_UNBOUND_S
            search_due = prior_check == 0 or last_search == 0 or now - last_search >= interval
            if live and not search_due:
                binding_status = getattr(session, "codex_binding_status", "retained")
            if live and search_due:
                session.codex_discover_checked = now
                pid = getattr(session.pty, "pid", None)
                if not isinstance(pid, int):
                    pid = getattr(getattr(session.pty, "_pi", None), "dwProcessId", None)
                if isinstance(pid, int) and pid > 0:
                    claimed = [other.codex_rollout_path for other in self.sessions.values()
                               if other.id != session.id and other.alive and other.codex_rollout_path]
                    # created_at is an ISO-8601 UTC string; discovery wants epoch
                    # seconds, and None there means "search the last 24 h".
                    path = discover_rollout(pid, session.working_dir, claimed,
                                            expected_session_id=None if previous_path else session.codex_session_id,
                                            spawned_at=spawn_epoch(getattr(session, "created_at", None)))
                    if path:
                        candidate_path = str(path)
                        binding_status = "verified"
                    else:
                        binding_status = "last_known"
            if not candidate_path:
                return {"usage_available": False, "total_tokens": None, "est_cost_usd": None,
                        "context_percent": None, "context_tokens": None, "context_window": None}
            if session.codex_usage_reader is None:
                session.codex_usage_reader = CodexUsageReader()
            reader = session.codex_usage_reader
            pending_paths = getattr(session, "codex_pending_paths", set())
            session.codex_pending_paths = pending_paths

            def flush_events(path):
                if usage_store is None:
                    pending_paths.add(path)
                    return
                events = reader.take_events(path)
                if events:
                    try:
                        usage_store.ingest_codex_events(session.id, path, events, session.working_dir)
                    except Exception:
                        reader.restore_events(path, events)
                        raise
                pending_paths.discard(path)

            switching = previous_path is not None and candidate_path != previous_path
            if switching:
                # Read the old chat's final append before handing the pane over.
                # Retain its reader/event queue if this caller has no store.
                reader.read(previous_path, reference_pricing())
                flush_events(previous_path)
            data = reader.read(candidate_path, reference_pricing())
            if not data.get("session_id") or (
                    session.codex_session_id and not switching
                    and data.get("session_id") != session.codex_session_id):
                session.codex_rollout_path = None
                session.codex_usage = {}
                logger.warning("Codex transcript identity mismatch for terminal %s", session.id)
                return {"usage_available": False, "est_cost_usd": None}
            session.codex_rollout_path = candidate_path
            if data.get("session_id"):
                session.codex_session_id = data["session_id"]
            data["est_cost_usd"] = data.pop("estimated_cost_usd", None)
            data["effort"] = session.effort or None
            data["binding_status"] = binding_status
            session.codex_binding_status = binding_status
            session.codex_usage = data
            flush_events(candidate_path)
            if usage_store is not None:
                for pending_path in list(pending_paths):
                    flush_events(pending_path)
            return dict(data)

    def rename_terminal(self, terminal_id: str, name: str) -> Optional[TerminalSession]:
        """Rename a terminal's Plexar Studio-side display name.

        This does NOT touch the underlying Claude Code session — it only
        updates the label shown in the Plexar Studio UI (``GET /api/terminals``).
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
        session.name_source = "studio"
        # cli_title is deliberately NOT cleared: it is the record of what the
        # CLI last called itself, not a pending change. A LATER CLI rename to a
        # different title still wins -- the most recent act wins on either side.
        return session

    _CLI_TITLE_THROTTLE = 5.0  # seconds between per-session title checks

    def _refresh_cli_title(self, session) -> Optional[str]:
        """Adopt a rename made INSIDE the CLI as this session's name.

        Two channels, neither authoritative over the other -- whichever moves is
        the most recent act:

        * claude-code writes ``/rename`` to its transcript as a ``custom-title``
          record; ``jsonl_watcher.latest_custom_title`` tail-reads it.
        * Either harness may set the terminal title (OSC 0/2), captured by
          ``SessionStateTracker``. This is the only Codex channel, since a Codex
          rollout carries no rename record at all.

        The OSC channel signals a CHANGE, not a value (see the R-177 follow-up
        in CLAUDE.md): the CLI's terminal title is ``<status glyph> <label>``
        and the glyph animates, so the raw title is never itself the name. The
        FIRST title a session's CLI emits is its startup default and is only
        SEEDED (recorded, not adopted); only a later title that differs from
        the seed is an active rename and gets adopted.

        Blocking disk I/O: call this OFF the event loop (the state ticker hands
        it to ``self._pty_executor``). Throttled to once per
        ``_CLI_TITLE_THROTTLE`` seconds per session.

        Returns the adopted title, or None when nothing changed.
        """
        now = time.monotonic()
        if now - session._cli_title_checked < self._CLI_TITLE_THROTTLE:
            return None
        session._cli_title_checked = now

        # Repair an already-corrupted name once per session: a name adopted
        # before normalization existed (or before this session's title was
        # normalized) may still carry leading decoration. Never blank a name
        # the user can see -- only replace when the normalized form differs
        # and is non-empty.
        if session.name_source == "cli":
            repaired = normalize_cli_title(session.name)
            if repaired is not None and repaired != session.name:
                logger.info(
                    "Terminal %s name repaired (decoration stripped): %r -> %r",
                    session.id,
                    session.name,
                    repaired,
                )
                session.name = repaired

        # The claude-code JSONL custom-title record keeps precedence and is
        # unchanged: when it supplies a title the OSC branch is not consulted.
        title: Optional[str] = None
        if getattr(session, "harness", "claude-code") == "claude-code":
            path = self._get_jsonl_path(session)
            if path:
                from jsonl_watcher import latest_custom_title

                title = latest_custom_title(path)

        if title:
            if title.lower() in ("claude", "codex"):
                return None
            if title == session.cli_title or title == session.name:
                return None  # unchanged -- must not re-log
            session.cli_title = title
            session.name = title
            session.name_source = "cli"
            logger.info("Terminal %s renamed by the CLI: %r", session.id, title)
            return title

        # OSC channel: adopts on CHANGE, never on value.
        osc_title = normalize_cli_title(session.tracker.osc_title)
        if osc_title is None:
            return None
        if session.cli_title is None:
            # SEED: the first title this CLI emitted is its startup default,
            # not a rename. Record it, but do not touch name/name_source and
            # do not log at INFO.
            session.cli_title = osc_title
            logger.debug(
                "Terminal %s OSC title seeded (not adopted): %r", session.id, osc_title
            )
            return None
        if osc_title == session.cli_title:
            return None  # no churn, no re-log

        session.cli_title = osc_title
        session.name = osc_title
        session.name_source = "cli"
        logger.info("Terminal %s renamed by the CLI: %r", session.id, osc_title)
        return osc_title

    def refresh_cli_titles(self) -> None:
        """Run ``_refresh_cli_title`` over every live session (executor entry point)."""
        for session in list(self.sessions.values()):
            if not session.alive:
                continue
            try:
                self._refresh_cli_title(session)
            except Exception:
                logger.warning(
                    "CLI title refresh failed for session %s", session.id, exc_info=True
                )

    def get_terminal(self, terminal_id: str) -> Optional[TerminalSession]:
        """Get a terminal session by ID."""
        session = self.sessions.get(terminal_id)
        if session and not session.pty.isalive():
            if session.alive:
                logger.info("Terminal %s alive=false cause=get-process-exited", session.id)
            session.alive = False
        return session

    async def read_pty(self, terminal_id: str, size: int = 65536) -> str:
        """Read from PTY (runs in a dedicated executor; a slow read is waited out, never abandoned).

        This used to be an ``asyncio.wait_for`` with a 10 s timeout. Cancelling the
        wait does NOT stop the executor thread — it has already consumed those bytes
        from the ConPTY pipe, and returning "" threw them away. An event-loop stall
        (the shape that made every session log "PTY read timed out" in the same
        second) therefore showed up as silently missing terminal output. The wait is
        now unbounded and the old timeout is only a warning threshold.
        """
        session = self.sessions.get(terminal_id)
        if not session or not session.alive:
            return ""
        loop = asyncio.get_event_loop()
        try:
            fut = loop.run_in_executor(self._pty_executor, session.pty.read, size)
            done, _ = await asyncio.wait({fut}, timeout=_PTY_READ_WARN_AFTER)
            if fut not in done:
                logger.warning(
                    "PTY read for %s has not returned after %.0fs; still waiting, no output is discarded",
                    terminal_id, _PTY_READ_WARN_AFTER,
                )
            data = await fut
            return data
        except EOFError:
            if session.alive:
                logger.info("Terminal %s alive=false cause=read-eof", terminal_id)
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

        For payloads above the paced-write ceiling, writes in chunks with async yields between
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

            # Small writes avoid pacing overhead. Larger pastes keep pacing
            # and escape-aware boundaries so the head and markers both survive.
            if data_len <= _SINGLE_WRITE_MAX:
                try:
                    return await asyncio.wait_for(
                        loop.run_in_executor(
                            self._pty_executor, self._write_pty_sync, terminal_id, data
                        ),
                        timeout=timeout,
                    )
                except asyncio.TimeoutError:
                    # A timeout means THIS write did not land; it does not prove
                    # the process is gone. Confirm before declaring death.
                    self._mark_dead_if_process_gone(session, terminal_id, "write timed out")
                    return False
                except Exception:
                    logger.warning("PTY async write error for %s", terminal_id, exc_info=True)
                    return False

            # Above the ceiling: chunk with async yields to let the pipe drain,
            # on boundaries that never fall inside an ANSI escape sequence.
            chunks = _split_preserving_escapes(data, _CHUNK_SIZE)
            for chunk_index, chunk in enumerate(chunks):
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
                    self._mark_dead_if_process_gone(
                        session, terminal_id,
                        f"write timed out at chunk {chunk_index + 1}/{len(chunks)}",
                    )
                    return False
                except Exception:
                    logger.warning("PTY async write error for %s", terminal_id, exc_info=True)
                    return False
                # Yield to event loop between chunks so the ConPTY pipe can drain
                # and heartbeats stay responsive.  A real delay (not just sleep(0))
                # is required for ConPTY — the pseudoconsole input buffer drops
                # bytes when chunks arrive faster than claude.exe can consume them.
                if chunk_index + 1 < len(chunks):
                    await asyncio.sleep(_INTER_CHUNK_DELAY)
            return True

    def _mark_dead_if_process_gone(self, session, terminal_id: str, why: str) -> bool:
        """Declare a session dead ONLY if its process has actually exited.

        Returns True if the session was marked dead.

        This exists because the opposite — declaring death on any I/O failure —
        produced a zombie that was worse than either real state. A transient
        write error (a busy pipe while the child repaints a full-screen TUI, for
        instance) used to set ``alive = False`` unconditionally. The WS forwarder
        then printed "[Session ended]" and stopped, while ``pty.isalive()`` was
        still True — so the dead-session purge, which requires BOTH flags, never
        collected it. The user was left with a pane that said the session had
        ended, refused input, and had a live claude.exe behind it.

        The process is the source of truth. If it is still running, a failed
        write is a failed write, not a death.
        """
        try:
            still_running = session.pty.isalive()
        except Exception:
            # If we cannot even ask, assume the worst — an unqueryable PTY is
            # not one we can keep forwarding to.
            still_running = False

        if still_running:
            logger.warning(
                "PTY %s for terminal %s, but the process is still alive — "
                "failing this write only, session stays open",
                why, terminal_id, exc_info=True,
            )
            return False

        logger.warning(
            "PTY %s for terminal %s and the process has exited — marking dead",
            why, terminal_id,
        )
        session.alive = False
        return True

    def resync_alive(self, terminal_id: str) -> bool:
        """Re-derive ``session.alive`` from the process, healing a stale flag.

        Returns the reconciled liveness.

        A session whose ``alive`` flag said False while its process was still
        running could never recover: the WS forwarder's loop is gated on
        ``session.alive``, so every reconnect exited immediately and re-sent the
        "[Session ended]" banner, and the purge never collected it because the
        process was up. Reconnecting is exactly the moment to re-ask the
        question, so a user who hit that state gets their session back instead
        of having to kill a pane whose process was healthy all along.
        """
        session = self.sessions.get(terminal_id)
        if session is None:
            return False
        try:
            running = session.pty.isalive()
        except Exception:
            logger.warning("Could not query liveness for %s", terminal_id, exc_info=True)
            return session.alive

        if running and not session.alive:
            logger.warning(
                "Terminal %s was flagged dead but its process is alive — restoring",
                terminal_id,
            )
            session.alive = True
        elif not running and session.alive:
            logger.info("Terminal %s process has exited — marking dead", terminal_id)
            session.alive = False
        return session.alive

    def _write_pty_sync(self, terminal_id: str, data: str) -> bool:
        """Executor-safe PTY write (avoids isalive() kernel call on event loop)."""
        session = self.sessions.get(terminal_id)
        if not session:
            return False
        try:
            if not session.pty.isalive():
                if session.alive:
                    logger.info("Terminal %s alive=false cause=write-process-exited", terminal_id)
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
            # Was: logger.debug(...) + unconditional session.alive = False.
            # Both halves were wrong. DEBUG meant the only path that killed a
            # session was invisible at the default INFO level, so this failure
            # left no trace in the log at all; and killing the session on any
            # exception created the zombie described in
            # _mark_dead_if_process_gone.
            self._mark_dead_if_process_gone(session, terminal_id, "write raised")
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

        It ALSO refreshes the derived context percentage, but only every
        _CONTEXT_REFRESH_TICKS-th tick (5s) -- see refresh_derived_context for why
        that cadence and not per-tick or per-chunk.

        Error handling: a bad session's tick() must never kill the loop.
        Exceptions per session are caught and logged; the loop continues.
        CancelledError propagates cleanly to allow graceful shutdown.
        """
        ticks = 0
        try:
            while True:
                await asyncio.sleep(self._STATE_TICKER_INTERVAL)
                ticks += 1
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
                # CLI-side renames. The JSONL tail read is blocking disk I/O, so
                # it goes to the PTY executor for the same reason the context
                # refresh does. Per-session throttling lives in
                # _refresh_cli_title; this only has to offer it the chance.
                try:
                    loop = asyncio.get_running_loop()
                    await loop.run_in_executor(
                        self._pty_executor, self.refresh_cli_titles
                    )
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.warning(
                        "State ticker: CLI title refresh failed", exc_info=True
                    )
                if ticks % self._CONTEXT_REFRESH_TICKS == 0:
                    # sqlite3 is synchronous: run the reads in the PTY executor so
                    # a slow disk cannot stall the event loop (and with it every
                    # session's output forwarding).
                    try:
                        loop = asyncio.get_running_loop()
                        await loop.run_in_executor(
                            self._pty_executor, self.refresh_derived_context
                        )
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        logger.warning(
                            "State ticker: context refresh failed", exc_info=True
                        )
        except asyncio.CancelledError:
            raise

    def refresh_derived_context(self) -> None:
        """Recompute every live session's derived context percentage.

        CADENCE: called from the state ticker every 5s, matching server.py's
        usage-ingest loop -- there is no new information to read between two
        ingests, so anything faster is pure I/O. Explicitly NOT on the PTY read
        path: feed() runs per output chunk on a PTY reader thread, and a sqlite
        read there would put disk latency in front of terminal output.

        For each session: read the LATEST usage_events turn, take
        input + cache_read as the prompt size, and divide by the window resolved
        from the session's CONFIGURED model (which is the only string carrying the
        "[1m]" long-context variant -- the JSONL's model id does not).

        Sets derived_context_percent to None when the window is unknown, so the
        ring stays an honest em dash rather than showing a number computed from a
        guessed denominator. Never raises: a usage-DB hiccup must not disturb a
        session.
        """
        # Imported lazily: keeps pty_manager importable (and cheap) without the
        # usage DB, which several test modules rely on.
        import context_window
        from usage_tracker import usage_tracker

        for session in list(self.sessions.values()):
            if not session.alive:
                continue
            try:
                window = context_window.resolve_context_window(
                    session.model, provider=session.provider
                )
                if window is None:
                    session.tracker.derived_context_percent = None
                    continue
                turn = usage_tracker.latest_turn(session.id)
                if turn is None:
                    # No recorded turn: the context genuinely holds nothing yet.
                    # Left as None rather than 0 -- the frontend derives its true
                    # "0% / no turns yet" state from the usage payload's
                    # last_event_ts, and a 0 here would instead be read as a
                    # measured percentage.
                    session.tracker.derived_context_percent = None
                    continue
                prompt_tokens = context_window.prompt_tokens_from_event(
                    turn.get("input_tokens"), turn.get("cache_read_tokens")
                )
                result = context_window.context_percent(prompt_tokens, window)
                if result is None:
                    session.tracker.derived_context_percent = None
                    continue
                display, raw = result
                if raw > 100.0:
                    # A real session cannot exceed its own window; this means the
                    # denominator is wrong (most likely a 1M-variant session whose
                    # configured model lost its "[1m]" suffix somewhere).
                    logger.debug(
                        "Context fill %.1f%% exceeds 100%% for session %s "
                        "(model=%r provider=%s prompt=%d window=%d) -- window is "
                        "probably wrong, clamping to 100%% for display",
                        raw, session.id, session.model, session.provider,
                        prompt_tokens, window,
                    )
                session.tracker.derived_context_percent = display
            except Exception:
                logger.warning(
                    "Context refresh failed for session %s", session.id, exc_info=True
                )

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
