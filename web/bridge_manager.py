"""Peer-bridge manager for Claude Cockpit.

Provides two relay modes between any two live PTY sessions:

V1 — Manual relay (``start_manual``):
    One-shot. Wraps a caller-supplied message in bracketed-paste escapes and
    injects it directly into the target session's PTY.  No persistent state is
    kept after the write completes.

V2 — Auto relay (``start_auto``):
    Autonomous bridge.  Sends a structured kickoff prompt to BOTH sessions
    simultaneously, then spawns one asyncio task per side.  Each task tails
    that session's JSONL file and forwards every new assistant turn to the peer
    session, waiting until the peer is idle before injecting.  The bridge ends
    when any of these conditions is met:

        * ``max_turns`` round-trips have been relayed (``ended_capped``)
        * Either session emits the ``BRIDGE-DONE`` sentinel in its reply
          (``ended_sentinel`` — the final message is still delivered first)
        * The caller calls ``stop(bridge_id)`` (``ended_user``)
        * A session dies or a write fails (``errored``)

    Bridge state is kept in memory for ~60 seconds after termination so that
    frontend pollers can observe the final state.

This module does NOT:
    - Define or register FastAPI routes (Ash does that in server.py)
    - Spawn or kill PTY sessions
    - Write or read the JSONL files directly (jsonl_watcher handles that)
    - Persist bridge state to disk
    - Rate-limit how often a session can participate in bridges
"""

from __future__ import annotations

import asyncio
import logging
import pathlib
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from jsonl_watcher import tail_jsonl
from pty_manager import pty_manager

logger = logging.getLogger("cockpit.bridge")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Bracketed-paste escape sequences — wrapping injected text prevents each
# embedded newline from auto-submitting the input before the full message
# is received by the PTY.
_BP_START = "\x1b[200~"
_BP_END = "\x1b[201~"

# Carriage-return used to submit the pasted block once bracketed-paste ends.
_SUBMIT = "\r"

_IDLE_POLL_INTERVAL = 0.5

# How long _wait_for_idle will wait for a *live* peer to become idle before
# giving up with a non-fatal "timeout" result.  Real Claude turns routinely
# exceed 10 seconds, so we give each relay injection up to 5 minutes of
# patience before skipping (not killing) the bridge.
_BUSY_WAIT_MAX = 300.0

# Timeout for the V1 one-shot manual relay idle gate.  V1 is user-triggered
# and returns an HTTP response, so we keep this moderate (60s) rather than
# the full 5-minute V2/V3 cap.  A normal 15–30s Claude turn should always
# clear within this window without the user seeing a spurious "busy" error.
_MANUAL_WAIT_MAX = 60.0

# Bridge typing-quiet window — bridge injection waits this long after the
# user's last keystroke before grabbing the PTY. Prevents stutter where the
# bridge's bracketed-paste chunks interleave with user typing.
_TYPING_QUIET_WINDOW = 1.0

# Grace period (seconds) to keep a terminated bridge record in memory so
# frontend pollers can read the final state.
_RECORD_TTL = 60.0

# ---------------------------------------------------------------------------
# File-handoff constants and relay directory
# ---------------------------------------------------------------------------

# Messages larger than this byte threshold are written to a relay file instead
# of being injected inline. ConPTY's input pipe buffer drops bytes under a fast
# burst, so keeping the bracketed-paste payload small is critical for
# correctness on the desktop (Tauri/ConPTY) build.
_RELAY_INLINE_MAX = 2048

# One-time relay scratch directory. Created at import time (mirrors the
# UPLOAD_DIR pattern from server.py). The directory is never explicitly removed
# on exit — the OS cleans temp dirs on reboot, which is fine for relay files.
_RELAY_DIR = pathlib.Path(tempfile.mkdtemp(prefix="cockpit_relays_"))

# Relay files older than this (seconds) are deleted opportunistically when a
# new relay file is written (10 minutes — bounds secrets-at-rest exposure).
_RELAY_FILE_MAX_AGE = 600.0


# ---------------------------------------------------------------------------
# Internal bridge record
# ---------------------------------------------------------------------------

@dataclass
class _BridgeRecord:
    """Internal state for a single auto-bridge run."""

    bridge_id: str
    from_id: str
    to_id: str
    from_name: str
    to_name: str
    max_turns: int

    state: str = "active"           # active | ended_user | ended_sentinel | ended_capped | errored
    turns_used: int = 0             # completed round-trips (min of per-side relay counts)
    # Free-text detail for the terminal state. The state ENUM is deliberately not
    # extended (the frontend switches on those five values); a spend-cap stop
    # reuses ``ended_capped`` and explains itself here.
    end_reason: Optional[str] = None

    # Per-side relay counters (each individual relay increments one side)
    _relays_from: int = field(default=0, repr=False)
    _relays_to: int = field(default=0, repr=False)

    # asyncio Tasks — cancelled on stop() or natural end
    _task_from: Optional[asyncio.Task] = field(default=None, repr=False)
    _task_to: Optional[asyncio.Task] = field(default=None, repr=False)

    # Stop event — set to ask relay tasks to exit gracefully
    _stop_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    # Timestamp when the record was marked as finished (for TTL GC)
    _ended_at: Optional[float] = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "bridge_id": self.bridge_id,
            "from_id": self.from_id,
            "to_id": self.to_id,
            "from_name": self.from_name,
            "to_name": self.to_name,
            "turns_used": self.turns_used,
            "max_turns": self.max_turns,
            "state": self.state,
            "end_reason": self.end_reason,
        }

    def _update_turns(self) -> None:
        """Recalculate turns_used as completed round-trips."""
        self.turns_used = min(self._relays_from, self._relays_to)


# ---------------------------------------------------------------------------
# Helper — bracketed-paste wrap
# ---------------------------------------------------------------------------

def _wrap(text: str) -> str:
    """Wrap *text* in bracketed-paste escapes and append a carriage-return."""
    return f"{_BP_START}{text}{_BP_END}{_SUBMIT}"


# ---------------------------------------------------------------------------
# Helper — snapshot a JSONL file's size before a kickoff write
# ---------------------------------------------------------------------------

def _snapshot_jsonl_size(jsonl_path: str | None) -> int:
    """Return the current byte size of *jsonl_path*, or 0 if unknown/missing.

    Callers (start_auto / ChannelManager.start) call this BEFORE injecting a
    kickoff prompt, then pass the result as ``start_offset`` to ``tail_jsonl``
    for the corresponding watcher. This anchors the watch position to a
    point-in-time that predates the kickoff, closing the race where the
    watcher task's async generator doesn't actually start iterating (and
    therefore doesn't stat the file) until after the kickoff's reply has
    already been appended — which would otherwise cause that reply to be
    silently skipped forever. See ``tail_jsonl``'s ``start_offset`` parameter.
    """
    if not jsonl_path:
        return 0
    try:
        return pathlib.Path(jsonl_path).stat().st_size
    except OSError:
        return 0


# ---------------------------------------------------------------------------
# Helper — file handoff for large relay payloads
# ---------------------------------------------------------------------------

def _cleanup_and_write_relay_file(full_text: str) -> pathlib.Path:
    """Blocking helper: GC stale relay files, then write *full_text* to a fresh one.

    Contains ALL the synchronous filesystem work for the file-handoff path
    (directory iteration, per-file stat/unlink, and the relay file write
    itself). Deliberately factored out so ``_maybe_file_handoff`` can run it
    via ``asyncio.to_thread`` instead of blocking the event loop — see the
    caller for why that matters.
    """
    # Opportunistic cleanup of old relay files — best-effort, never raise.
    try:
        now = time.time()
        for old_file in _RELAY_DIR.iterdir():
            try:
                age = now - old_file.stat().st_mtime
                if age > _RELAY_FILE_MAX_AGE:
                    old_file.unlink(missing_ok=True)
                    logger.debug("Deleted stale relay file: %s (age=%.0fs)", old_file, age)
            except Exception:
                logger.debug("Could not check/delete relay file %s", old_file, exc_info=True)
    except Exception:
        logger.debug("Relay dir cleanup failed", exc_info=True)

    # Write to a new relay file.
    relay_path = _RELAY_DIR / f"{uuid.uuid4().hex[:8]}_relay.txt"
    relay_path.write_text(full_text, encoding="utf-8")
    return relay_path


async def _maybe_file_handoff(full_text: str, peer_name: str | None) -> str:
    """If *full_text* exceeds the inline threshold, persist it to a relay file
    and return a compact reference prompt instead.  Otherwise return *full_text*
    unchanged.

    The compact prompt names the relay file on its own line so Claude Code's
    Read tool can open it without any path mangling.

    Also opportunistically deletes relay files in ``_RELAY_DIR`` that are older
    than ``_RELAY_FILE_MAX_AGE`` seconds (best-effort; never raises).

    Async gotcha: the GC scan and file write are blocking filesystem calls.
    They run via ``asyncio.to_thread`` (see ``_cleanup_and_write_relay_file``)
    so a large relay payload never stalls the single event loop shared by
    every session's WebSocket read/write and PTY I/O. The small/inline path
    (the common case — most relay messages are under the threshold) does no
    I/O at all and returns synchronously without ever reaching a thread hop.
    """
    encoded = full_text.encode("utf-8")
    if len(encoded) <= _RELAY_INLINE_MAX:
        return full_text

    relay_path = await asyncio.to_thread(_cleanup_and_write_relay_file, full_text)

    logger.info(
        "File handoff: relay payload too large (%d bytes, peer=%r) — saved to %s",
        len(encoded),
        peer_name,
        relay_path,
    )

    if peer_name:
        return (
            f'[PEER REPLY from session "{peer_name}"]\n'
            f"The full message was large, so it was saved to:\n"
            f"{relay_path}\n"
            f"Read that file to see the complete message, then respond."
        )
    else:
        return (
            f"A large message was saved to:\n"
            f"{relay_path}\n"
            f"Read that file to see the complete content, then respond."
        )


# ---------------------------------------------------------------------------
# Relay directory cleanup — called on graceful shutdown
# ---------------------------------------------------------------------------

def cleanup_relay_dir() -> None:
    """Remove the relay scratch directory and its contents (called on shutdown)."""
    import shutil
    shutil.rmtree(_RELAY_DIR, ignore_errors=True)


# ---------------------------------------------------------------------------
# Helper — idle gate (simple, no bridge record required)
# ---------------------------------------------------------------------------

async def _wait_for_idle_simple(terminal_id: str, timeout: float | None = None) -> bool:
    """Poll *terminal_id*'s tracker until it reaches 'idle' or *timeout* elapses.

    Returns True if idle was reached; False if the wait timed out or the
    session died.  Does NOT require a bridge record.

    Used by ``start_manual`` which has no persistent bridge record.  The
    default timeout is ``_MANUAL_WAIT_MAX`` (60s) — generous enough that a
    normal 15–30s Claude turn does not spuriously fail a one-shot manual
    relay, while still being finite so the HTTP handler eventually returns.
    The timeout parameter is read from the module constant at call time so
    tests can monkeypatch it without the default-arg early-binding issue.
    """
    if timeout is None:
        timeout = _MANUAL_WAIT_MAX
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        session = pty_manager.get_terminal(terminal_id)
        if session is None or not session.alive:
            return False
        # Typing-quiet gate: don't inject while the user is actively typing.
        # Prevents bridge bracketed-paste chunks from interleaving with keystrokes.
        if (time.monotonic() - session.last_user_input_time) < _TYPING_QUIET_WINDOW:
            await asyncio.sleep(_IDLE_POLL_INTERVAL)
            continue
        if session.tracker.state == "idle":
            return True
        await asyncio.sleep(_IDLE_POLL_INTERVAL)
    return False


# ---------------------------------------------------------------------------
# Helper — idle gate (requires a bridge/channel record for stop-event support)
# ---------------------------------------------------------------------------

async def _wait_for_idle(
    terminal_id: str, record: _BridgeRecord | _ChannelRecord
) -> str:
    """Poll *terminal_id*'s tracker until it reaches 'idle' or a terminal condition.

    Returns one of four string sentinels so callers can distinguish fatal from
    transient outcomes without using exceptions:

        "idle"    — session became idle; safe to inject.
        "dead"    — session not found or process has exited (FATAL — end bridge).
        "stopped" — the bridge/channel stop event was set (teardown in progress).
        "timeout" — session is alive but did not reach idle within _BUSY_WAIT_MAX
                    (NON-FATAL — skip this relay turn, keep bridge alive).

    The inner loop polls every _IDLE_POLL_INTERVAL seconds.  The total patience
    is _BUSY_WAIT_MAX (300s / 5 min) so that slow-but-running Claude turns never
    prematurely kill the bridge.  Fatal conditions (dead session, stop event) are
    checked on every iteration so teardown is still prompt.
    """
    deadline = time.monotonic() + _BUSY_WAIT_MAX
    while time.monotonic() < deadline:
        if record._stop_event.is_set():
            return "stopped"
        session = pty_manager.get_terminal(terminal_id)
        if session is None or not session.alive:
            return "dead"
        # Typing-quiet gate: don't inject while the user is actively typing.
        # Prevents bridge bracketed-paste chunks from interleaving with keystrokes.
        if (time.monotonic() - session.last_user_input_time) < _TYPING_QUIET_WINDOW:
            await asyncio.sleep(_IDLE_POLL_INTERVAL)
            continue
        if session.tracker.state == "idle":
            return "idle"
        await asyncio.sleep(_IDLE_POLL_INTERVAL)
    return "timeout"


# ---------------------------------------------------------------------------
# Helper — liveness check
# ---------------------------------------------------------------------------

def _session_alive(terminal_id: str) -> bool:
    """Return True if the session exists and its PTY process is alive."""
    session = pty_manager.get_terminal(terminal_id)
    return session is not None and session.alive


# ---------------------------------------------------------------------------
# Helper — inject message into PTY
# ---------------------------------------------------------------------------

async def _inject(
    terminal_id: str, text: str, record: _BridgeRecord | _ChannelRecord
) -> str:
    """Wait for the peer to become idle, then inject *text*.

    Returns one of three string sentinels that callers must handle:

        "ok"      — injection succeeded; relay turn delivered.
        "skip"    — non-fatal; peer was alive but timed out (_BUSY_WAIT_MAX)
                    or the stop event was set.  Caller should NOT end the bridge.
        "fatal"   — peer died or PTY write failed.  Caller MUST end the bridge.

    Design note: "skip" on stop-event is safe because the relay task's outer
    loop checks record.state != "active" on every iteration; once the stop
    event fires the task exits cleanly on the next loop iteration rather than
    needing _inject to do the teardown.
    """
    if not _session_alive(terminal_id):
        logger.warning(
            "[bridge %s] Peer %s is not alive before injection",
            record.bridge_id, terminal_id,
        )
        return "fatal"

    gate_result = await _wait_for_idle(terminal_id, record)

    if gate_result == "dead":
        logger.warning(
            "[bridge %s] Peer %s died while waiting to become idle",
            record.bridge_id, terminal_id,
        )
        return "fatal"

    if gate_result == "stopped":
        # Stop event fires — teardown is already underway; caller just returns.
        return "skip"

    if gate_result == "timeout":
        # Peer is alive but slow — skip this relay turn without killing the bridge.
        logger.warning(
            "[bridge %s] Peer %s alive but did not reach idle within %.0fs — skipping relay turn",
            record.bridge_id, terminal_id, _BUSY_WAIT_MAX,
        )
        return "skip"

    # gate_result == "idle" — safe to inject.
    # Apply file-handoff AFTER the idle gate so the compact prompt is the only
    # thing that enters the PTY pipe.  peer_name=None because the framing
    # (e.g. [PEER REPLY from "X"]) is already embedded inside *text* by the
    # caller (_relay_message / _channel_*_kickoff); the handoff prompt omits
    # a redundant attribution header.
    inject_text = await _maybe_file_handoff(text, peer_name=None)

    ok = await pty_manager.write_pty_async(terminal_id, _wrap(inject_text))
    if not ok:
        logger.warning(
            "[bridge %s] write_pty_async returned False for %s",
            record.bridge_id, terminal_id,
        )
        return "fatal"
    return "ok"


# ---------------------------------------------------------------------------
# Helper — extract relay text from an assistant JSONL entry
# ---------------------------------------------------------------------------

def _extract_text(entry: dict) -> str:
    """Return a newline-joined string of all text blocks in an assistant entry.

    Returns an empty string if no text blocks are found or if the entry is not
    an assistant message.
    """
    if entry.get("type") != "assistant":
        return ""
    parts: list[str] = []
    for block in entry.get("content", []):
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text", "")
            if text:
                parts.append(text)
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Bridge message templates
# ---------------------------------------------------------------------------

def _kickoff_message(peer_name: str, prompt: str) -> str:
    return (
        f'[BRIDGE START — peer coordination with session "{peer_name}"]\n'
        f"You are temporarily linked with another Claude Code session. Reply concisely with the\n"
        f"requested information. Your reply will be relayed to the peer agent. End your message\n"
        f"with BRIDGE-DONE if no further coordination is needed.\n\n"
        f"Question: {prompt}\n"
        f"[/BRIDGE]"
    )


def _relay_message(peer_name: str, text: str) -> str:
    return (
        f'[PEER REPLY from session "{peer_name}"]\n'
        f"{text}\n"
        f"[/PEER]"
    )


# ---------------------------------------------------------------------------
# Helper — spend guardrail check at a turn boundary
# ---------------------------------------------------------------------------

async def _spend_stop_reason() -> str | None:
    """A reason string if the spend guard now blocks unattended relay work.

    Called at TURN BOUNDARIES only — after an injection has fully completed and
    its counter has been updated — so a cap can never interrupt a write that is
    already in the PTY pipe. Returns None when ``spend.enforce_on.bridges`` is
    off (the check then costs nothing), when no cap has tripped, or when the
    guard downgraded the block to an alert.

    Async gotcha: ``spend_guard.evaluate`` does synchronous sqlite reads against
    the usage and pricing DBs. It runs via ``asyncio.to_thread`` so a slow disk
    cannot stall the single event loop that also drives every session's
    WebSocket and PTY I/O. Both stores are opened with ``check_same_thread=False``
    and serialise their own statements under an internal lock, so a thread hop
    is safe here.

    Best-effort by contract: any failure returns None (bridge continues). A
    guardrail that fails closed would silently end bridges on a transient DB
    error, which is a worse failure than one missed stop.
    """
    try:
        import spend_guard

        return await asyncio.to_thread(spend_guard.block_reason, "bridges")
    except Exception:
        logger.warning("Spend guard check failed at turn boundary — continuing", exc_info=True)
        return None


# ---------------------------------------------------------------------------
# Relay task — watches one side and relays to the other
# ---------------------------------------------------------------------------

async def _relay_task(
    record: _BridgeRecord,
    watch_id: str,
    watch_name: str,
    target_id: str,
    target_name: str,
    side: str,  # "from" or "to" — identifies which per-side counter to increment
    start_offset: int = 0,
) -> None:
    """Tail *watch_id*'s JSONL and relay each new assistant turn to *target_id*.

    *start_offset* is the JSONL byte size snapshotted (by the caller) BEFORE
    the kickoff prompt was injected into *watch_id* — see
    ``_snapshot_jsonl_size`` / ``tail_jsonl``'s ``start_offset`` parameter for
    why this matters (closes the watcher-start race).

    Ends when:
        - max_turns round-trips have been completed
        - BRIDGE-DONE sentinel is detected in the relayed text
        - The bridge stop event is set
        - A liveness or write error occurs
    """
    watch_session = pty_manager.get_terminal(watch_id)
    if watch_session is None:
        logger.warning("[bridge %s] Watch session %s not found at task start", record.bridge_id, watch_id)
        _end_bridge(record, "errored")
        return

    jsonl_path = pty_manager._get_jsonl_path(watch_session)
    if not jsonl_path:
        # JSONL may not yet exist — wait briefly for it to appear (Claude Code
        # creates the file on first message after kickoff)
        waited = 0.0
        while waited < 15.0:
            if record._stop_event.is_set():
                return
            await asyncio.sleep(0.5)
            waited += 0.5
            # Re-query; claude_session_id may have been discovered by then
            watch_session = pty_manager.get_terminal(watch_id)
            if watch_session is None:
                _end_bridge(record, "errored")
                return
            jsonl_path = pty_manager._get_jsonl_path(watch_session)
            if jsonl_path:
                break

        if not jsonl_path:
            logger.warning(
                "[bridge %s] JSONL path not available for %s after wait — ending bridge",
                record.bridge_id, watch_id,
            )
            _end_bridge(record, "errored")
            return

    logger.debug(
        "[bridge %s] Relay task starting: watching %s (%s) → target %s (%s), JSONL: %s",
        record.bridge_id, watch_id, watch_name, target_id, target_name, jsonl_path,
    )

    try:
        async for entry in tail_jsonl(jsonl_path, from_beginning=False, start_offset=start_offset):
            if record._stop_event.is_set():
                logger.debug("[bridge %s] Stop event set — relay task exiting", record.bridge_id)
                return

            if record.state != "active":
                return

            text = _extract_text(entry)
            if not text:
                continue

            logger.debug(
                "[bridge %s] Relaying from %s → %s (%d chars)",
                record.bridge_id, watch_name, target_name, len(text),
            )

            # Detect sentinel BEFORE deciding to relay — we still relay the final
            # message as required, then end.
            sentinel_detected = "BRIDGE-DONE" in text

            relay_body = _relay_message(watch_name, text)
            inject_result = await _inject(target_id, relay_body, record)
            if inject_result == "fatal":
                _end_bridge(record, "errored")
                return
            if inject_result == "skip":
                # Non-fatal: stop event or peer alive-but-slow timeout.
                # The outer loop will detect the stop event on the next
                # iteration if teardown is in progress; otherwise continue.
                continue

            # inject_result == "ok" — increment per-side counter and recalculate round-trips
            if side == "from":
                record._relays_from += 1
            else:
                record._relays_to += 1
            record._update_turns()

            if sentinel_detected:
                logger.info(
                    "[bridge %s] BRIDGE-DONE sentinel detected from %s — ending bridge",
                    record.bridge_id, watch_name,
                )
                _end_bridge(record, "ended_sentinel")
                return

            if record.turns_used >= record.max_turns:
                logger.info(
                    "[bridge %s] Turn cap %d reached — ending bridge",
                    record.bridge_id, record.max_turns,
                )
                _end_bridge(record, "ended_capped")
                return

            # Spend guardrail: max_turns bounds TURNS, not dollars, and an
            # autonomous bridge runs unattended. Re-check the cap here — the
            # same termination path the turn cap uses, no second teardown.
            spend_reason = await _spend_stop_reason()
            if spend_reason:
                logger.info(
                    "[bridge %s] Spend cap reached — ending bridge: %s",
                    record.bridge_id, spend_reason,
                )
                _end_bridge(record, "ended_capped", reason=f"spend cap: {spend_reason}")
                return

    except asyncio.CancelledError:
        logger.debug("[bridge %s] Relay task cancelled", record.bridge_id)
        raise
    except Exception:
        logger.warning(
            "[bridge %s] Relay task error watching %s",
            record.bridge_id, watch_id,
            exc_info=True,
        )
        _end_bridge(record, "errored")


def _end_bridge(record: _BridgeRecord, new_state: str, reason: str | None = None) -> None:
    """Transition a bridge to a terminal state if it is still active.

    Idempotent — only the first caller wins; subsequent calls are no-ops.
    Cancels peer relay tasks and sets the stop event so both sides wind down.

    *reason* is optional free text stored on the record (surfaced as
    ``end_reason``); the state enum itself is never extended.
    """
    if record.state != "active":
        return

    record.state = new_state
    record.end_reason = reason
    record._ended_at = time.monotonic()
    record._stop_event.set()

    # Cancel sibling tasks — they may be sleeping inside tail_jsonl or _inject.
    for task in (record._task_from, record._task_to):
        if task is not None and not task.done():
            task.cancel()

    logger.info(
        "[bridge %s] Ended with state=%s (turns=%d/%d, from=%s, to=%s)",
        record.bridge_id, new_state, record.turns_used, record.max_turns,
        record.from_name, record.to_name,
    )


# ---------------------------------------------------------------------------
# BridgeManager
# ---------------------------------------------------------------------------

class BridgeManager:
    """Manages peer-bridge sessions between PTY terminals.

    Thread-safety:
        ``_bridges`` is only accessed from the asyncio event loop (all public
        methods are async or synchronous but called from the same loop).
        No additional locking is required.

    GC:
        ``_gc_task`` is a background asyncio task that wakes every 10 seconds
        and removes bridge records that have been in a terminal state for
        longer than ``_RECORD_TTL`` seconds.  It is created lazily on the
        first ``start_auto`` call and lives for the lifetime of the process.
    """

    def __init__(self) -> None:
        # Keyed by bridge_id (12-char hex string).
        # Protected implicitly by asyncio's single-threaded event loop.
        self._bridges: dict[str, _BridgeRecord] = {}
        self._gc_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start_manual(
        self,
        from_terminal_id: str,
        to_terminal_id: str,
        message: str,
        prefix: str | None = None,
    ) -> dict:
        """One-shot relay.

        Wraps *message* in bracketed-paste escapes and writes it to
        *to_terminal_id*'s PTY.  If *prefix* is supplied it is prepended on
        its own line (e.g. ``[From session "Foo"]:``) so the receiving agent
        has attribution context.

        The source session (*from_terminal_id*) is validated for existence but
        is not written to.

        Returns:
            ``{ok: True}`` on success.
            ``{ok: False, error: "<reason>"}`` on any failure.
        """
        # Validate source session exists
        from_session = pty_manager.get_terminal(from_terminal_id)
        if from_session is None or not from_session.alive:
            return {"ok": False, "error": f"Source session {from_terminal_id!r} not found or dead"}

        # Validate target session
        to_session = pty_manager.get_terminal(to_terminal_id)
        if to_session is None or not to_session.alive:
            return {"ok": False, "error": f"Target session {to_terminal_id!r} not found or dead"}

        # Build the full text to inject
        if prefix:
            full_text = f"{prefix}\n{message}"
        else:
            full_text = message

        logger.info(
            "Manual relay: %s (%s) → %s (%s), %d chars",
            from_terminal_id, from_session.name,
            to_terminal_id, to_session.name,
            len(full_text),
        )

        # Fix A: wait for the target to become idle before injecting.
        # Injecting while the session is mid-render causes truncation/corruption
        # on ConPTY because the input pipe buffer can overflow before claude.exe
        # drains it.
        idle = await _wait_for_idle_simple(to_terminal_id)
        if not idle:
            logger.warning(
                "Manual relay: target %s (%s) did not reach idle within %.1fs — aborting",
                to_terminal_id, to_session.name, _MANUAL_WAIT_MAX,
            )
            return {"ok": False, "error": "Target session is busy — try again when it is idle"}

        # Fix B: apply file-handoff so large payloads never overwhelm the PTY
        # pipe.  Pass the source session name so the compact inline prompt keeps
        # sender attribution even when the full body lives in the relay file.
        inject_text = await _maybe_file_handoff(full_text, peer_name=from_session.name)

        ok = await pty_manager.write_pty_async(to_terminal_id, _wrap(inject_text))
        if not ok:
            return {"ok": False, "error": "PTY write failed for target session"}
        return {"ok": True}

    async def start_auto(
        self,
        from_terminal_id: str,
        to_terminal_id: str,
        kickoff_prompt: str,
        max_turns: int = 4,
    ) -> dict:
        """Start an autonomous bridge between two sessions.

        Sends the framed kickoff prompt to BOTH sessions simultaneously, then
        spawns two asyncio relay tasks — one watching each side — that forward
        assistant turns to the peer until a termination condition is reached.

        Args:
            from_terminal_id: Terminal ID of the initiating session.
            to_terminal_id:   Terminal ID of the peer session.
            kickoff_prompt:   The seed question/prompt sent to both agents.
            max_turns:        Maximum round-trips before the bridge is capped.

        Returns:
            ``{bridge_id: str, ok: True}`` on successful start.
            ``{ok: False, error: "<reason>"}`` if sessions are invalid or
            JSONL paths cannot be resolved.
        """
        # Validate both sessions up-front
        from_session = pty_manager.get_terminal(from_terminal_id)
        if from_session is None or not from_session.alive:
            return {"ok": False, "error": f"Session {from_terminal_id!r} not found or dead"}

        to_session = pty_manager.get_terminal(to_terminal_id)
        if to_session is None or not to_session.alive:
            return {"ok": False, "error": f"Session {to_terminal_id!r} not found or dead"}

        # JSONL availability is NOT checked here. Claude Code creates the JSONL
        # file on the session's first message, which is the kickoff prompt we are
        # about to send. For brand-new sessions that have never spoken, the file
        # does not exist yet — and that is fine. Each relay task waits up to 15s
        # post-kickoff for the file to appear before declaring an error.

        bridge_id = uuid.uuid4().hex[:12]
        record = _BridgeRecord(
            bridge_id=bridge_id,
            from_id=from_terminal_id,
            to_id=to_terminal_id,
            from_name=from_session.name,
            to_name=to_session.name,
            max_turns=max_turns,
        )
        self._bridges[bridge_id] = record

        logger.info(
            "[bridge %s] Starting auto bridge: %s (%s) ↔ %s (%s), max_turns=%d",
            bridge_id,
            from_terminal_id, from_session.name,
            to_terminal_id, to_session.name,
            max_turns,
        )

        # Build kickoff messages — each side receives the OTHER side's name as the peer.
        from_kickoff = _kickoff_message(to_session.name, kickoff_prompt)
        to_kickoff = _kickoff_message(from_session.name, kickoff_prompt)

        # Snapshot each side's JSONL size BEFORE injecting the kickoff prompt —
        # see _snapshot_jsonl_size for why this closes the watcher-start race.
        from_start_offset = _snapshot_jsonl_size(pty_manager._get_jsonl_path(from_session))
        to_start_offset = _snapshot_jsonl_size(pty_manager._get_jsonl_path(to_session))

        # Send kickoff to both sides simultaneously.
        from_ok, to_ok = await asyncio.gather(
            pty_manager.write_pty_async(from_terminal_id, _wrap(from_kickoff)),
            pty_manager.write_pty_async(to_terminal_id, _wrap(to_kickoff)),
        )

        if not from_ok or not to_ok:
            failed_side = from_terminal_id if not from_ok else to_terminal_id
            logger.warning(
                "[bridge %s] Kickoff write failed for %s — bridge aborted",
                bridge_id, failed_side,
            )
            record.state = "errored"
            record._ended_at = time.monotonic()
            return {"ok": False, "error": f"Kickoff write failed for {failed_side}"}

        # Spawn relay tasks
        task_from = asyncio.create_task(
            _relay_task(
                record=record,
                watch_id=from_terminal_id,
                watch_name=from_session.name,
                target_id=to_terminal_id,
                target_name=to_session.name,
                side="from",
                start_offset=from_start_offset,
            ),
            name=f"bridge-{bridge_id}-from",
        )
        task_to = asyncio.create_task(
            _relay_task(
                record=record,
                watch_id=to_terminal_id,
                watch_name=to_session.name,
                target_id=from_terminal_id,
                target_name=from_session.name,
                side="to",
                start_offset=to_start_offset,
            ),
            name=f"bridge-{bridge_id}-to",
        )

        record._task_from = task_from
        record._task_to = task_to

        # Ensure GC is running
        self._ensure_gc()

        return {"bridge_id": bridge_id, "ok": True}

    def stop(self, bridge_id: str) -> bool:
        """User-initiated stop of an auto bridge.

        Cancels both relay tasks and sets the bridge state to ``ended_user``.

        Returns:
            True if the bridge was found and stopped.
            False if no bridge with *bridge_id* exists (already ended or
            never started).
        """
        record = self._bridges.get(bridge_id)
        if record is None:
            return False

        if record.state != "active":
            # Already in a terminal state — still return True so the caller
            # knows the bridge exists.
            return True

        logger.info("[bridge %s] User stop requested", bridge_id)
        _end_bridge(record, "ended_user")
        return True

    def list_active(self) -> list[dict]:
        """Return serialisable info for all known bridges (active and recently ended).

        Pruning of expired records happens lazily in the GC task; this method
        never mutates ``_bridges``.

        Returns:
            List of dicts with keys:
            ``bridge_id``, ``from_id``, ``to_id``, ``from_name``, ``to_name``,
            ``turns_used``, ``max_turns``, ``state``.
            ``state`` is one of:
            ``active | ended_user | ended_sentinel | ended_capped | errored``.
        """
        return [r.to_dict() for r in self._bridges.values()]

    # ------------------------------------------------------------------
    # GC
    # ------------------------------------------------------------------

    def _ensure_gc(self) -> None:
        """Start the GC background task if it is not already running."""
        if self._gc_task is None or self._gc_task.done():
            self._gc_task = asyncio.create_task(
                self._gc_loop(), name="bridge-gc"
            )

    async def _gc_loop(self) -> None:
        """Background task: remove expired terminal bridge records every 10s."""
        while True:
            try:
                await asyncio.sleep(10.0)
                now = time.monotonic()
                expired = [
                    bid
                    for bid, rec in self._bridges.items()
                    if rec.state != "active"
                    and rec._ended_at is not None
                    and (now - rec._ended_at) > _RECORD_TTL
                ]
                for bid in expired:
                    del self._bridges[bid]
                    logger.debug("[bridge GC] Removed expired record %s", bid)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.warning("Bridge GC loop error", exc_info=True)


# ---------------------------------------------------------------------------
# Module-level singleton — mirrors pty_manager export pattern
# ---------------------------------------------------------------------------

bridge_manager = BridgeManager()


# ---------------------------------------------------------------------------
# Channel message templates
# ---------------------------------------------------------------------------

def _channel_lead_kickoff(worker_names: list[str], prompt: str) -> str:
    """Kickoff prompt sent to the lead session at channel start."""
    names_quoted = ", ".join(f'"{n}"' for n in worker_names)
    n = len(worker_names)
    return (
        f"[CHANNEL START — you are the LEAD]\n"
        f"You are coordinating {n} worker session{'s' if n != 1 else ''}: {names_quoted}.\n"
        f"You will receive their output. Direct them as needed.\n"
        f"End your message with BRIDGE-DONE when coordination is complete.\n\n"
        f"Question/Task: {prompt}\n"
        f"[/CHANNEL]"
    )


def _channel_worker_kickoff(lead_name: str, prompt: str) -> str:
    """Kickoff prompt sent to each worker session at channel start."""
    return (
        f'[CHANNEL START — you are a WORKER]\n'
        f'Your lead/coordinator is session "{lead_name}".\n'
        f"Follow their direction and report your progress.\n"
        f"End your message with BRIDGE-DONE when your task is complete.\n\n"
        f"Task: {prompt}\n"
        f"[/CHANNEL]"
    )


# ---------------------------------------------------------------------------
# Internal channel record
# ---------------------------------------------------------------------------

@dataclass
class _ChannelRecord:
    """Internal state for a single channel (1 lead + N workers)."""

    channel_id: str
    lead_id: str
    lead_name: str
    worker_ids: list[str]           # ordered list of worker terminal IDs
    worker_names: dict[str, str]    # terminal_id → display name
    max_turns: int

    state: str = "active"           # active | ended_user | ended_sentinel | ended_capped | errored
    turns_used: int = 0             # total relays completed across all members
    # See _BridgeRecord.end_reason — free-text detail, the enum is not extended.
    end_reason: Optional[str] = None
    _tasks: list = field(default_factory=list, repr=False)
    _stop_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _ended_at: Optional[float] = field(default=None, repr=False)

    @property
    def bridge_id(self) -> str:
        # _inject() logs record.bridge_id — alias channel_id so it works for channels too
        return self.channel_id

    def to_dict(self) -> dict:
        return {
            "channel_id": self.channel_id,
            "lead_id": self.lead_id,
            "lead_name": self.lead_name,
            "worker_ids": list(self.worker_ids),
            "worker_names": dict(self.worker_names),
            "turns_used": self.turns_used,
            "max_turns": self.max_turns,
            "state": self.state,
            "end_reason": self.end_reason,
        }


# ---------------------------------------------------------------------------
# Channel end helper
# ---------------------------------------------------------------------------

def _end_channel(record: _ChannelRecord, new_state: str, reason: str | None = None) -> None:
    """Transition a channel to a terminal state if it is still active.

    Idempotent — only the first caller wins; subsequent calls are no-ops.
    Cancels all relay tasks and sets the stop event so all sides wind down.

    *reason* is optional free text stored as ``end_reason``.
    """
    if record.state != "active":
        return

    record.state = new_state
    record.end_reason = reason
    record._ended_at = time.monotonic()
    record._stop_event.set()

    for task in record._tasks:
        if task is not None and not task.done():
            task.cancel()

    logger.info(
        "[channel %s] Ended with state=%s (turns=%d/%d, lead=%s, workers=%s)",
        record.channel_id, new_state, record.turns_used, record.max_turns,
        record.lead_name, list(record.worker_names.values()),
    )


# ---------------------------------------------------------------------------
# Channel relay tasks
# ---------------------------------------------------------------------------

async def _worker_relay_task(
    record: _ChannelRecord,
    worker_id: str,
    worker_name: str,
    start_offset: int = 0,
) -> None:
    """Tail *worker_id*'s JSONL and relay each new assistant turn to the lead.

    *start_offset* is the JSONL byte size snapshotted (by the caller) BEFORE
    the kickoff prompt was injected into *worker_id* — see
    ``_snapshot_jsonl_size`` / ``tail_jsonl``'s ``start_offset`` parameter for
    why this matters (closes the watcher-start race).

    Ends when:
        - BRIDGE-DONE sentinel is detected in the worker's reply
        - ``max_turns`` total relays have been completed across all members
        - The channel stop event is set
        - A liveness or write error occurs
    """
    worker_session = pty_manager.get_terminal(worker_id)
    if worker_session is None:
        logger.warning(
            "[channel %s] Worker session %s not found at task start",
            record.channel_id, worker_id,
        )
        _end_channel(record, "errored")
        return

    jsonl_path = pty_manager._get_jsonl_path(worker_session)
    if not jsonl_path:
        # Wait briefly for the JSONL file to appear after kickoff write.
        waited = 0.0
        while waited < 15.0:
            if record._stop_event.is_set():
                return
            await asyncio.sleep(0.5)
            waited += 0.5
            worker_session = pty_manager.get_terminal(worker_id)
            if worker_session is None:
                _end_channel(record, "errored")
                return
            jsonl_path = pty_manager._get_jsonl_path(worker_session)
            if jsonl_path:
                break

        if not jsonl_path:
            logger.warning(
                "[channel %s] JSONL path not available for worker %s after wait — ending channel",
                record.channel_id, worker_id,
            )
            _end_channel(record, "errored")
            return

    logger.debug(
        "[channel %s] Worker relay task starting: watching %s (%s) → lead %s (%s), JSONL: %s",
        record.channel_id, worker_id, worker_name, record.lead_id, record.lead_name, jsonl_path,
    )

    try:
        async for entry in tail_jsonl(jsonl_path, from_beginning=False, start_offset=start_offset):
            if record._stop_event.is_set():
                logger.debug(
                    "[channel %s] Stop event set — worker relay task for %s exiting",
                    record.channel_id, worker_name,
                )
                return

            if record.state != "active":
                return

            text = _extract_text(entry)
            if not text:
                continue

            logger.debug(
                "[channel %s] Relaying from worker %s → lead %s (%d chars)",
                record.channel_id, worker_name, record.lead_name, len(text),
            )

            sentinel_detected = "BRIDGE-DONE" in text

            relay_body = _relay_message(worker_name, text)
            inject_result = await _inject(record.lead_id, relay_body, record)
            if inject_result == "fatal":
                _end_channel(record, "errored")
                return
            if inject_result == "skip":
                # Non-fatal: stop event or lead alive-but-slow timeout.
                continue

            # inject_result == "ok"
            record.turns_used += 1

            if sentinel_detected:
                logger.info(
                    "[channel %s] BRIDGE-DONE sentinel detected from worker %s — ending channel",
                    record.channel_id, worker_name,
                )
                _end_channel(record, "ended_sentinel")
                return

            if record.turns_used >= record.max_turns:
                logger.info(
                    "[channel %s] Turn cap %d reached — ending channel",
                    record.channel_id, record.max_turns,
                )
                _end_channel(record, "ended_capped")
                return

            # Spend guardrail at the turn boundary — see _spend_stop_reason.
            spend_reason = await _spend_stop_reason()
            if spend_reason:
                logger.info(
                    "[channel %s] Spend cap reached — ending channel: %s",
                    record.channel_id, spend_reason,
                )
                _end_channel(record, "ended_capped", reason=f"spend cap: {spend_reason}")
                return

    except asyncio.CancelledError:
        logger.debug(
            "[channel %s] Worker relay task for %s cancelled",
            record.channel_id, worker_name,
        )
        raise
    except Exception:
        logger.warning(
            "[channel %s] Worker relay task error watching %s",
            record.channel_id, worker_id,
            exc_info=True,
        )
        _end_channel(record, "errored")


async def _lead_relay_task(record: _ChannelRecord, start_offset: int = 0) -> None:
    """Tail the lead's JSONL and relay each new assistant turn to ALL workers.

    *start_offset* is the JSONL byte size snapshotted (by the caller) BEFORE
    the kickoff prompt was injected into the lead — see
    ``_snapshot_jsonl_size`` / ``tail_jsonl``'s ``start_offset`` parameter for
    why this matters (closes the watcher-start race).

    Ends when:
        - BRIDGE-DONE sentinel is detected in the lead's reply
        - ``max_turns`` total relays have been completed across all members
        - The channel stop event is set
        - A liveness or write error occurs
    """
    lead_session = pty_manager.get_terminal(record.lead_id)
    if lead_session is None:
        logger.warning(
            "[channel %s] Lead session %s not found at task start",
            record.channel_id, record.lead_id,
        )
        _end_channel(record, "errored")
        return

    jsonl_path = pty_manager._get_jsonl_path(lead_session)
    if not jsonl_path:
        # Wait briefly for the JSONL file to appear after kickoff write.
        waited = 0.0
        while waited < 15.0:
            if record._stop_event.is_set():
                return
            await asyncio.sleep(0.5)
            waited += 0.5
            lead_session = pty_manager.get_terminal(record.lead_id)
            if lead_session is None:
                _end_channel(record, "errored")
                return
            jsonl_path = pty_manager._get_jsonl_path(lead_session)
            if jsonl_path:
                break

        if not jsonl_path:
            logger.warning(
                "[channel %s] JSONL path not available for lead %s after wait — ending channel",
                record.channel_id, record.lead_id,
            )
            _end_channel(record, "errored")
            return

    logger.debug(
        "[channel %s] Lead relay task starting: watching lead %s (%s) → %d worker(s), JSONL: %s",
        record.channel_id, record.lead_id, record.lead_name, len(record.worker_ids), jsonl_path,
    )

    try:
        async for entry in tail_jsonl(jsonl_path, from_beginning=False, start_offset=start_offset):
            if record._stop_event.is_set():
                logger.debug("[channel %s] Stop event set — lead relay task exiting", record.channel_id)
                return

            if record.state != "active":
                return

            text = _extract_text(entry)
            if not text:
                continue

            logger.debug(
                "[channel %s] Relaying from lead %s → %d worker(s) (%d chars)",
                record.channel_id, record.lead_name, len(record.worker_ids), len(text),
            )

            sentinel_detected = "BRIDGE-DONE" in text

            relay_body = _relay_message(record.lead_name, text)

            # Inject into all workers CONCURRENTLY rather than sequentially.
            # A sequential for-loop means one slow worker (each _inject can wait
            # up to _BUSY_WAIT_MAX == 300s for its idle gate) head-of-line-blocks
            # every worker after it in record.worker_ids. asyncio.gather runs all
            # N idle-gate waits + injections in parallel, and return_exceptions=True
            # isolates one worker's unexpected failure from the others — a raised
            # exception for worker A must not prevent worker B's coroutine from
            # completing (or being reflected in the results below).
            inject_results = await asyncio.gather(
                *(_inject(worker_id, relay_body, record) for worker_id in record.worker_ids),
                return_exceptions=True,
            )

            any_fatal = False
            delivered_any = False
            for worker_id, inject_result in zip(record.worker_ids, inject_results):
                if isinstance(inject_result, BaseException):
                    # Preserve prior semantics: before this change, an exception
                    # raised out of _inject propagated to the outer try/except
                    # around the whole relay loop, which ended the channel with
                    # 'errored'. return_exceptions=True stops that propagation,
                    # so we must explicitly treat it as fatal here to keep the
                    # channel's end-state behavior coherent.
                    logger.warning(
                        "[channel %s] _inject raised for worker %s",
                        record.channel_id, worker_id,
                        exc_info=inject_result,
                    )
                    any_fatal = True
                    continue
                if inject_result == "fatal":
                    # A worker died or its PTY write failed — end the whole channel.
                    logger.warning(
                        "[channel %s] Fatal delivery failure for worker %s",
                        record.channel_id, worker_id,
                    )
                    any_fatal = True
                    continue
                if inject_result == "skip":
                    # Worker alive-but-slow timeout, or stop event.  Skip this
                    # worker's delivery for this turn; other workers still got
                    # their own concurrent delivery attempt.
                    logger.warning(
                        "[channel %s] Skipping relay to slow/stopped worker %s for this turn",
                        record.channel_id, worker_id,
                    )
                    continue
                # inject_result == "ok" — delivered successfully
                delivered_any = True

            if any_fatal:
                _end_channel(record, "errored")
                return

            # Stop event may have been set during the worker loop above.
            if record._stop_event.is_set() or record.state != "active":
                return

            # If every worker was skipped (all alive-but-slow), nothing was
            # delivered this turn — do NOT burn a turn against max_turns, and
            # do not act on the sentinel/cap.  Tail for the next lead turn.
            # This mirrors the skip→continue (before counting) behaviour of
            # _relay_task and _worker_relay_task.
            if not delivered_any:
                continue

            record.turns_used += 1

            if sentinel_detected:
                logger.info(
                    "[channel %s] BRIDGE-DONE sentinel detected from lead %s — ending channel",
                    record.channel_id, record.lead_name,
                )
                _end_channel(record, "ended_sentinel")
                return

            if record.turns_used >= record.max_turns:
                logger.info(
                    "[channel %s] Turn cap %d reached — ending channel",
                    record.channel_id, record.max_turns,
                )
                _end_channel(record, "ended_capped")
                return

            # Spend guardrail at the turn boundary — see _spend_stop_reason.
            spend_reason = await _spend_stop_reason()
            if spend_reason:
                logger.info(
                    "[channel %s] Spend cap reached — ending channel: %s",
                    record.channel_id, spend_reason,
                )
                _end_channel(record, "ended_capped", reason=f"spend cap: {spend_reason}")
                return

    except asyncio.CancelledError:
        logger.debug("[channel %s] Lead relay task cancelled", record.channel_id)
        raise
    except Exception:
        logger.warning(
            "[channel %s] Lead relay task error watching lead %s",
            record.channel_id, record.lead_id,
            exc_info=True,
        )
        _end_channel(record, "errored")


# ---------------------------------------------------------------------------
# ChannelManager
# ---------------------------------------------------------------------------

class ChannelManager:
    """Manages multi-session channels: one lead coordinating N workers.

    Thread-safety:
        ``_channels`` is only accessed from the asyncio event loop (all public
        methods are async or synchronous but called from the same loop).
        No additional locking is required.

    GC:
        ``_gc_task`` is a background asyncio task that wakes every 10 seconds
        and removes channel records that have been in a terminal state for
        longer than ``_RECORD_TTL`` seconds.  It is created lazily on the
        first ``start`` call and lives for the lifetime of the process.
    """

    def __init__(self) -> None:
        # Keyed by channel_id (12-char hex string).
        self._channels: dict[str, _ChannelRecord] = {}
        self._gc_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(
        self,
        lead_id: str,
        worker_ids: list[str],
        kickoff_prompt: str,
        max_turns: int = 6,
    ) -> dict:
        """Start a channel: one lead coordinating N workers.

        Validates all sessions and JSONL paths up-front, sends kickoff prompts
        to all participants simultaneously, then spawns N+1 relay tasks.

        Args:
            lead_id:        Terminal ID of the lead (coordinator) session.
            worker_ids:     Ordered list of worker terminal IDs (minimum 1).
            kickoff_prompt: The seed question/task sent to all participants.
            max_turns:      Maximum total relays before the channel is capped.

        Returns:
            ``{channel_id: str, ok: True}`` on successful start.
            ``{ok: False, error: "<reason>"}`` if validation fails.
        """
        # Validate minimum topology
        if not worker_ids:
            return {"ok": False, "error": "At least one worker_id is required"}

        # Validate no duplicate IDs
        all_ids = [lead_id] + list(worker_ids)
        if len(all_ids) != len(set(all_ids)):
            return {"ok": False, "error": "Duplicate terminal IDs in channel members"}

        # Validate lead
        lead_session = pty_manager.get_terminal(lead_id)
        if lead_session is None or not lead_session.alive:
            return {"ok": False, "error": f"Lead session {lead_id!r} not found or dead"}

        # Validate all workers
        worker_sessions = {}
        for wid in worker_ids:
            ws = pty_manager.get_terminal(wid)
            if ws is None or not ws.alive:
                return {"ok": False, "error": f"Worker session {wid!r} not found or dead"}
            worker_sessions[wid] = ws

        # JSONL availability is NOT checked here. Claude Code creates the JSONL
        # file on the session's first message, which is the kickoff prompt we are
        # about to send. For brand-new sessions that have never spoken, the file
        # does not exist yet — and that is fine. Each relay task (worker and lead)
        # waits up to 15s post-kickoff for the file to appear before declaring an
        # error.

        channel_id = uuid.uuid4().hex[:12]
        worker_names = {wid: worker_sessions[wid].name for wid in worker_ids}

        record = _ChannelRecord(
            channel_id=channel_id,
            lead_id=lead_id,
            lead_name=lead_session.name,
            worker_ids=list(worker_ids),
            worker_names=worker_names,
            max_turns=max_turns,
        )
        self._channels[channel_id] = record

        logger.info(
            "[channel %s] Starting: lead=%s (%s), workers=%s, max_turns=%d",
            channel_id,
            lead_id, lead_session.name,
            [(wid, worker_sessions[wid].name) for wid in worker_ids],
            max_turns,
        )

        # Build kickoff messages
        lead_kickoff = _channel_lead_kickoff(
            [worker_sessions[wid].name for wid in worker_ids],
            kickoff_prompt,
        )
        worker_kickoffs = {
            wid: _channel_worker_kickoff(lead_session.name, kickoff_prompt)
            for wid in worker_ids
        }

        # Snapshot each participant's JSONL size BEFORE injecting kickoff
        # prompts — see _snapshot_jsonl_size for why this closes the
        # watcher-start race (applies to the lead and every worker).
        lead_start_offset = _snapshot_jsonl_size(pty_manager._get_jsonl_path(lead_session))
        worker_start_offsets = {
            wid: _snapshot_jsonl_size(pty_manager._get_jsonl_path(worker_sessions[wid]))
            for wid in worker_ids
        }

        # Send all kickoffs simultaneously
        kickoff_coros = [
            pty_manager.write_pty_async(lead_id, _wrap(lead_kickoff)),
        ] + [
            pty_manager.write_pty_async(wid, _wrap(worker_kickoffs[wid]))
            for wid in worker_ids
        ]
        results = await asyncio.gather(*kickoff_coros)

        # Check for any kickoff write failure — index 0 is lead, rest are workers
        if not results[0]:
            logger.warning("[channel %s] Kickoff write failed for lead %s — channel aborted", channel_id, lead_id)
            record.state = "errored"
            record._ended_at = time.monotonic()
            return {"ok": False, "error": f"Kickoff write failed for lead {lead_id!r}"}
        for idx, wid in enumerate(worker_ids):
            if not results[idx + 1]:
                logger.warning(
                    "[channel %s] Kickoff write failed for worker %s — channel aborted",
                    channel_id, wid,
                )
                record.state = "errored"
                record._ended_at = time.monotonic()
                return {"ok": False, "error": f"Kickoff write failed for worker {wid!r}"}

        # Spawn N+1 relay tasks: one per worker + one for the lead
        tasks: list[asyncio.Task] = []

        for wid in worker_ids:
            t = asyncio.create_task(
                _worker_relay_task(
                    record, wid, worker_sessions[wid].name,
                    start_offset=worker_start_offsets[wid],
                ),
                name=f"channel-{channel_id}-worker-{wid}",
            )
            tasks.append(t)

        lead_task = asyncio.create_task(
            _lead_relay_task(record, start_offset=lead_start_offset),
            name=f"channel-{channel_id}-lead",
        )
        tasks.append(lead_task)

        record._tasks = tasks

        # Ensure GC is running
        self._ensure_gc()

        return {"channel_id": channel_id, "ok": True}

    def stop(self, channel_id: str) -> bool:
        """User-initiated stop of a channel.

        Cancels all relay tasks and sets the channel state to ``ended_user``.

        Returns:
            True if the channel was found and stopped (or already terminal).
            False if no channel with *channel_id* exists.
        """
        record = self._channels.get(channel_id)
        if record is None:
            return False

        if record.state != "active":
            return True

        logger.info("[channel %s] User stop requested", channel_id)
        _end_channel(record, "ended_user")
        return True

    def list_active(self) -> list[dict]:
        """Return serialisable info for all known channels (active and recently ended).

        Returns:
            List of dicts with keys:
            ``channel_id``, ``lead_id``, ``lead_name``, ``worker_ids``,
            ``worker_names``, ``turns_used``, ``max_turns``, ``state``.
        """
        return [r.to_dict() for r in self._channels.values()]

    def member_ids(self) -> set[str]:
        """Return the set of all terminal IDs currently enrolled in any active channel.

        Used by server.py as a conflict guard — callers should check this before
        allowing a new channel or bridge to include a session that is already
        participating in an active channel.
        """
        ids: set[str] = set()
        for record in self._channels.values():
            if record.state == "active":
                ids.add(record.lead_id)
                ids.update(record.worker_ids)
        return ids

    # ------------------------------------------------------------------
    # GC
    # ------------------------------------------------------------------

    def _ensure_gc(self) -> None:
        """Start the GC background task if it is not already running."""
        if self._gc_task is None or self._gc_task.done():
            self._gc_task = asyncio.create_task(
                self._gc_loop(), name="channel-gc"
            )

    async def _gc_loop(self) -> None:
        """Background task: remove expired channel records every 10s."""
        while True:
            try:
                await asyncio.sleep(10.0)
                now = time.monotonic()
                expired = [
                    cid
                    for cid, rec in self._channels.items()
                    if rec.state != "active"
                    and rec._ended_at is not None
                    and (now - rec._ended_at) > _RECORD_TTL
                ]
                for cid in expired:
                    del self._channels[cid]
                    logger.debug("[channel GC] Removed expired record %s", cid)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.warning("Channel GC loop error", exc_info=True)


channel_manager = ChannelManager()
