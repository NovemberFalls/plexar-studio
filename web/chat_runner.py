"""Drives a reply for the Chat surface by running the `claude` CLI headlessly.

WHY THE HARNESS RATHER THAN A MODEL API
---------------------------------------
Proven live before this module was written: `claude -p --output-format json`
read a CSV off disk with its own `Read` tool and returned the answer. That buys
three things a raw API call does not:

  * the full Claude Code toolset — Read, Grep, WebFetch and the rest;
  * **no API key** — the CLI uses the user's existing subscription OAuth, the
    same credential Cockpit already reads for the usage pill;
  * a per-turn cost figure and a resumable session id.

SECURITY — the rail, and it is server-side
------------------------------------------
`claude` executes its tools on THIS machine. Docker is nowhere in this path,
and the model being containerised elsewhere says nothing about it. So the tool
set is an explicit allow-list that defaults to READ-ONLY, and it is enforced
here rather than in the UI: a toggle a client could lie about is not a
boundary. `Bash`, `Write` and `Edit` are opt-in per conversation, never
default, and never implied by "the user seems to want it".

TWO CLI TRAPS, both learned the hard way
----------------------------------------
1. ``--allowedTools`` is VARIADIC. A prompt passed positionally after it gets
   swallowed as another tool name and the CLI then dies with "Input must be
   provided either through stdin or as a prompt argument". So the prompt goes
   on **stdin** and argv stays flag-only — which also removes every quoting
   problem with a multi-thousand-line paste.
2. A conversation resumes by session id. Re-sending the whole transcript each
   turn would work but costs the entire history as input tokens every time,
   which is exactly what the model-switch warning tells users to avoid.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
from typing import AsyncIterator, Optional

logger = logging.getLogger("cockpit.chatrunner")

#: Tools a chat may use with no further consent. Every one is a READ: they can
#: inform an answer, none of them can change the machine or reach the network.
READ_ONLY_TOOLS = ("Read", "Grep", "Glob")

#: Opt-in per conversation. Kept as a named set so "what did we allow" is one
#: greppable place rather than a string built at a call site.
WRITE_TOOLS = ("Write", "Edit", "NotebookEdit")
EXEC_TOOLS = ("Bash",)
NET_TOOLS = ("WebFetch", "WebSearch")

#: A reply that has produced nothing for this long is treated as hung. Generous,
#: because a real turn with tool calls legitimately takes minutes.
DEFAULT_TIMEOUT_S = 600.0


class ChatRunnerError(RuntimeError):
    """The harness could not be started or did not produce a usable reply."""


def resolve_cli() -> Optional[str]:
    """Locate the `claude` executable, or None.

    Absence is a normal, reportable state — the same stance the voice service
    takes — not an exception, because a user without the CLI installed should
    read an explanation rather than a stack trace.
    """
    return os.getenv("COCKPIT_CLAUDE_CLI") or shutil.which("claude")


def build_argv(
    *,
    model: Optional[str] = None,
    session_id: Optional[str] = None,
    allow_write: bool = False,
    allow_exec: bool = False,
    allow_net: bool = False,
    cwd_scope: Optional[str] = None,
) -> list[str]:
    """Compose the CLI arguments. FLAG-ONLY: the prompt never appears here.

    Returned as data so the decision of what a chat may do is testable without
    spawning anything.
    """
    cli = resolve_cli()
    if not cli:
        raise ChatRunnerError("The `claude` CLI was not found on PATH.")

    tools = list(READ_ONLY_TOOLS)
    if allow_write:
        tools += list(WRITE_TOOLS)
    if allow_exec:
        tools += list(EXEC_TOOLS)
    if allow_net:
        tools += list(NET_TOOLS)

    argv = [
        cli, "-p",
        "--output-format", "stream-json",
        # Token-by-token deltas, so the transcript can stream rather than
        # appearing in one block after a minute of silence.
        "--include-partial-messages",
        "--verbose",
    ]
    if model:
        argv += ["--model", model]
    if session_id:
        # Resume rather than re-sending the transcript: the whole history as
        # input tokens on every turn is the cost the model-switch warning
        # exists to describe.
        argv += ["--resume", session_id]
    if cwd_scope:
        # Scope filesystem reach to one directory rather than the whole disk.
        argv += ["--add-dir", cwd_scope]
    # LAST, because it is variadic and swallows anything following it.
    argv += ["--allowedTools", *tools]
    return argv


def _extract_text(event: dict) -> str:
    """Pull user-visible text out of one stream-json event, or "".

    Deliberately conservative: an event shape we do not recognise contributes
    nothing rather than being coerced into the transcript. Garbage in a chat is
    worse than a gap, because the user cannot tell it came from us.
    """
    if not isinstance(event, dict):
        return ""
    etype = event.get("type")

    if etype == "stream_event":
        delta = (event.get("event") or {}).get("delta") or {}
        if delta.get("type") == "text_delta":
            return delta.get("text") or ""
        return ""

    if etype == "assistant":
        content = (event.get("message") or {}).get("content")
        if isinstance(content, list):
            return "".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
    return ""


async def stream_reply(
    prompt: str,
    *,
    model: Optional[str] = None,
    session_id: Optional[str] = None,
    allow_write: bool = False,
    allow_exec: bool = False,
    allow_net: bool = False,
    cwd_scope: Optional[str] = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> AsyncIterator[dict]:
    """Run one turn, yielding normalised events.

    Yields ``{"type": "delta"|"session"|"done"|"error", ...}``. The caller
    persists; this function owns no storage, so a failed turn cannot leave a
    half-written assistant message behind.
    """
    argv = build_argv(
        model=model, session_id=session_id, allow_write=allow_write,
        allow_exec=allow_exec, allow_net=allow_net, cwd_scope=cwd_scope,
    )

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except Exception as exc:
        logger.error("Could not start the claude CLI", exc_info=True)
        yield {"type": "error", "detail": f"Could not start the harness: {exc}"}
        return

    # Prompt on stdin — see the module docstring. Closing stdin is what tells
    # the CLI the prompt is complete.
    try:
        proc.stdin.write(prompt.encode("utf-8"))
        await proc.stdin.drain()
        proc.stdin.close()
    except Exception:
        logger.warning("Failed writing the prompt to the harness", exc_info=True)

    text_parts: list[str] = []
    result: dict = {}
    try:
        while True:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout_s)
            if not line:
                break
            try:
                event = json.loads(line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                # The CLI prints non-JSON diagnostics on occasion. Skipping is
                # right; surfacing it as assistant text would be a lie.
                continue

            if event.get("session_id"):
                yield {"type": "session", "session_id": event["session_id"]}

            chunk = _extract_text(event)
            if chunk:
                text_parts.append(chunk)
                yield {"type": "delta", "text": chunk}

            if event.get("type") == "result":
                result = event
    except asyncio.TimeoutError:
        proc.kill()
        yield {"type": "error", "detail": "The harness produced nothing for too long."}
        return
    except Exception as exc:
        proc.kill()
        logger.error("Harness stream failed", exc_info=True)
        yield {"type": "error", "detail": str(exc)}
        return

    await proc.wait()
    stderr = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()

    if proc.returncode != 0:
        # A non-zero exit with no text is a failure, and must not be persisted
        # as an empty assistant turn.
        yield {"type": "error",
               "detail": stderr or f"The harness exited with code {proc.returncode}."}
        return

    text = "".join(text_parts) or (result.get("result") or "")
    yield {
        "type": "done",
        "text": text,
        "session_id": result.get("session_id"),
        # Reported per turn. Under a SUBSCRIPTION this is API-EQUIVALENT, not
        # money billed — spend_guard already draws that line and Chat must not
        # redraw it.
        "cost_usd": result.get("total_cost_usd"),
        "is_error": bool(result.get("is_error")),
    }
