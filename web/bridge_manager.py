"""Peer-bridge manager for Plexar Studio.

Provides the V1 manual relay (``start_manual``) and the injection primitives the
V4 mailbox bridge and the agent API ride on.

V1 -- Manual relay (``start_manual``):
    One-shot. Wraps a caller-supplied message in bracketed-paste escapes and
    injects it directly into the target session's PTY.  No persistent state is
    kept after the write completes.

The autonomous (V2) and channel (V3) bridges were removed; ``mailbox_bridge.py``
is the bridge.

This module does NOT:
    - Define or register FastAPI routes (server.py does that)
    - Spawn or kill PTY sessions
    - Persist bridge state to disk
"""

from __future__ import annotations

import asyncio
import logging
import pathlib
import tempfile
import time
import uuid

import temp_sweep
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

# Delay between the bracketed-paste write and the submit carriage-return.
#
# The CR MUST NOT ride in the same write as the paste payload.  Claude Code's
# TUI buffers stdin on `\x1b[200~` and flushes on `\x1b[201~`; a CR arriving in
# that same read is consumed as *pasted content* (a newline inside a paste
# inserts a line — it does not submit).  That is the "bridge pastes the prompt
# but never sends it, so a human has to hit Enter" failure mode.  Writing the
# CR separately, after the TUI has drained and re-rendered the paste, makes the
# submit land as a real keypress.
_SUBMIT_DELAY = 1.0

_IDLE_POLL_INTERVAL = 0.5

# Timeout for the V1 one-shot manual relay idle gate.  V1 is user-triggered
# and returns an HTTP response, so we keep this moderate (60s) rather than
# a long wait.  A normal 15–30s Claude turn should always clear within this window without the user seeing a spurious "busy" error.
_MANUAL_WAIT_MAX = 60.0

# Bridge typing-quiet window — bridge injection waits this long after the
# user's last keystroke before grabbing the PTY. Prevents stutter where the
# bridge's bracketed-paste chunks interleave with user typing.
_TYPING_QUIET_WINDOW = 1.0

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
# Ownership marker, so a LATER process's startup sweep can PROVE this directory
# still belongs to a live sidecar instead of inferring it from age.
temp_sweep.mark_owner(_RELAY_DIR)

# Relay files older than this (seconds) are deleted opportunistically when a
# new relay file is written (10 minutes — bounds secrets-at-rest exposure).
_RELAY_FILE_MAX_AGE = 600.0


# ---------------------------------------------------------------------------

def _wrap(text: str) -> str:
    """Wrap *text* in bracketed-paste escapes.

    Deliberately does NOT append the submit carriage-return — see
    ``_SUBMIT_DELAY`` and ``_paste_and_submit``.  A CR in the same write is
    swallowed as pasted content and the message never sends.
    """
    return f"{_BP_START}{text}{_BP_END}"


async def _paste_and_submit(terminal_id: str, text: str) -> bool:
    """Paste *text* into *terminal_id*, then submit it as a separate keypress.

    Two writes with ``_SUBMIT_DELAY`` between them.  The first carries the
    bracketed-paste block; the second carries a bare carriage-return once the
    TUI has drained and re-rendered the paste.  Returns True only if BOTH
    writes succeed — a paste that lands without its submit is exactly the
    stuck-in-the-composer state this split exists to prevent, so callers must
    treat it as a failed relay rather than a delivered one.
    """
    if not await pty_manager.write_pty_async(terminal_id, _wrap(text)):
        return False
    await asyncio.sleep(_SUBMIT_DELAY)
    return await pty_manager.write_pty_async(terminal_id, _SUBMIT)


# ---------------------------------------------------------------------------
# Helper — snapshot a JSONL file's size before a kickoff write
# ---------------------------------------------------------------------------

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


class BridgeManager:
    """Holds the V1 manual relay.  Stateless: nothing is kept after a relay."""

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

        ok = await _paste_and_submit(to_terminal_id, inject_text)
        if not ok:
            return {"ok": False, "error": "PTY write failed for target session"}
        return {"ok": True}


# ---------------------------------------------------------------------------
# Module-level singleton -- mirrors pty_manager export pattern
# ---------------------------------------------------------------------------

bridge_manager = BridgeManager()
