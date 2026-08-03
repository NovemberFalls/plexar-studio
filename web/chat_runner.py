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

import app_paths

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

#: Max bytes in ONE stream-json line. asyncio defaults this to 64 KiB, which a
#: tool result carrying a file blows through instantly — see the comment at the
#: create_subprocess_exec call. 16 MiB is chosen to sit above any plausible
#: single event while still being a bound: without one, a runaway process could
#: buffer without limit, and "no ceiling" is not a fix for "ceiling too low".
_STREAM_LINE_LIMIT = 16 * 1024 * 1024


def chat_workspace() -> str:
    """A NEUTRAL working directory for chat turns.

    THE COST THIS AVOIDS, measured rather than assumed: the CLI injects the
    CLAUDE.md of whatever directory it starts in, every turn. Cockpit's server
    runs inside its own repo, whose CLAUDE.md is ~16 500 tokens — so every
    chat message, however short, arrived carrying this project's engineering
    conventions as context.

    That is wrong twice over. It is a large per-turn cost, and it is the wrong
    context: a Chat conversation is not necessarily about this repository, and
    silently prepending one project's instructions to every question shapes
    answers in a way the user never asked for and cannot see.

    Created on demand under the data dir so it is stable across restarts and a
    user can drop their own CLAUDE.md there deliberately, which is the honest
    way to get project context into Chat.
    """
    path = app_paths.data_dir() / "chat-workspace"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


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
        # MEASURED 2026-08-01 against a live capture of the CLI's own request
        # body. Loading this machine's MCP servers added 58 tool schemas —
        # ~12k tokens of definitions for tools a chat turn cannot use anyway,
        # paid on EVERY turn. `--allowedTools` does NOT help: it gates
        # permission, while every schema is still sent to the model.
        #
        # 58 400 -> 46 500 tokens from this flag alone; the rest of the saving
        # comes from the neutral working directory (see CHAT_WORKSPACE).
        "--strict-mcp-config",
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


def _extract_tools(event: dict) -> list[dict]:
    """Pull tool CALLS out of one event, as ``[{id, verb, targets}]``.

    CHAT.md §6 renders these as a quiet log — "a bordered group ... never a set
    of coloured cards" — so what a caller needs is the verb and what it touched,
    not the raw arguments. Reading the whole input blob into the transcript
    would leak file contents and prompts into a surface that is meant to be
    scannable.
    """
    if not isinstance(event, dict) or event.get("type") != "assistant":
        return []
    content = (event.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []

    out = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "tool_use":
            continue
        args = block.get("input") if isinstance(block.get("input"), dict) else {}
        # The fields that name WHAT was touched, in the order the CLI's tools
        # actually use. Anything else stays out of the transcript.
        targets = [
            str(args[k]) for k in ("file_path", "path", "pattern", "command", "url")
            if args.get(k)
        ]
        out.append({
            "id": block.get("id"),
            # A tool call with no name still happened; "unknown" beats dropping
            # it, which is the same call usage_tracker makes for tool_events.
            "verb": block.get("name") or "unknown",
            "targets": targets,
        })
    return out


def _extract_tool_results(event: dict) -> list[dict]:
    """Pull tool RESULTS out of a user-role event: ``[{id, is_error}]``.

    Only the outcome, never the payload — a tool result can be an entire file.
    """
    if not isinstance(event, dict) or event.get("type") != "user":
        return []
    content = (event.get("message") or {}).get("content")
    if not isinstance(content, list):
        return []
    return [
        {"id": b.get("tool_use_id"), "is_error": bool(b.get("is_error"))}
        for b in content
        if isinstance(b, dict) and b.get("type") == "tool_result"
    ]


async def stream_reply(
    prompt: str,
    *,
    model: Optional[str] = None,
    session_id: Optional[str] = None,
    allow_write: bool = False,
    allow_exec: bool = False,
    allow_net: bool = False,
    cwd_scope: Optional[str] = None,
    env_overlay: Optional[dict] = None,
    timeout_s: float = DEFAULT_TIMEOUT_S,
) -> AsyncIterator[dict]:
    """Run one turn, yielding normalised events.

    Yields ``{"type": "delta"|"session"|"done"|"error", ...}``. The caller
    persists; this function owns no storage, so a failed turn cannot leave a
    half-written assistant message behind.

    ``env_overlay`` reroutes this turn onto a non-Anthropic endpoint — the
    ANTHROPIC_BASE_URL/AUTH_TOKEN set that pty_manager already uses for a
    terminal session on a local provider. It is supplied by the CALLER, which
    owns the provider registry, because a URL must never come from the
    browser (the SSRF stance the rest of the registry takes).
    """
    argv = build_argv(
        model=model, session_id=session_id, allow_write=allow_write,
        allow_exec=allow_exec, allow_net=allow_net, cwd_scope=cwd_scope,
    )

    # Inherit, then overlay. A bare overlay as the child's whole environment
    # would strip PATH and the CLI's own credential store, so a local-model
    # turn would fail for reasons having nothing to do with the local model.
    #
    # A None value REMOVES the variable rather than blanking it. The CLI treats
    # a present-but-empty ANTHROPIC_API_KEY as "an auth source is set" and says
    # so on stderr; deleting it is what the CLI actually asks for, and it also
    # guarantees no fallback to a real key inherited from this process.
    child_env = None
    if env_overlay:
        child_env = dict(os.environ)
        for key, value in env_overlay.items():
            if value is None:
                child_env.pop(key, None)
            else:
                child_env[key] = str(value)

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=child_env,
            # Never the server's own directory — see chat_workspace().
            cwd=chat_workspace(),
            # THE 64KB CLIFF. asyncio's StreamReader defaults to a 64 KiB line
            # limit, and stream-json puts ONE EVENT PER LINE. A tool result
            # carrying a file — which is the entire point of a read-only tool
            # set — routinely exceeds that, and readline() then raises
            # "Separator is found, but chunk is longer than limit", killing the
            # whole reply. Observed live: asking Chat to read a ~60KB markdown
            # file failed every time, and the failure looked like the model
            # breaking rather than a buffer limit.
            limit=_STREAM_LINE_LIMIT,
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

    # THE TWO MUST BE KEPT APART. With --include-partial-messages the CLI emits
    # the token deltas AND, at the end of the block, the complete `assistant`
    # message carrying the same text. Accumulating both duplicated every reply
    # verbatim — observed live as an answer printed twice, end to end, with no
    # separator. Deltas are the truth; the whole message is only a FALLBACK for
    # the case where no deltas arrived at all.
    delta_parts: list[str] = []
    message_parts: list[str] = []
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

            for call in _extract_tools(event):
                yield {"type": "tool", **call}
            for res in _extract_tool_results(event):
                yield {"type": "tool_result", **res}

            etype = event.get("type")
            if etype == "stream_event":
                chunk = _extract_text(event)
                if chunk:
                    delta_parts.append(chunk)
                    yield {"type": "delta", "text": chunk}
            elif etype == "assistant":
                # Collected but NOT yielded: this is the same text the deltas
                # already streamed. Emitting it would double the reply on
                # screen as well as in the store.
                whole = _extract_text(event)
                if whole:
                    message_parts.append(whole)

            if event.get("type") == "result":
                result = event
    except asyncio.TimeoutError:
        proc.kill()
        yield {"type": "error", "detail": "The harness produced nothing for too long."}
        return
    except ValueError:
        # readline() raises a bare ValueError when a single line exceeds the
        # limit above. Its message ("Separator is found, but chunk is longer
        # than limit") describes a buffer, not anything the user did, so it is
        # translated. Raising the ceiling made this rare; it did not make it
        # impossible, and an unexplained failure on a big file is exactly the
        # case where a real explanation matters.
        proc.kill()
        logger.error("chat: a stream-json line exceeded the read limit", exc_info=True)
        yield {
            "type": "error",
            "detail": (
                "A single result from the harness was too large to read "
                "(over 16 MB). Try a smaller file, or ask for part of it."
            ),
        }
        return
    except Exception as exc:
        proc.kill()
        logger.error("Harness stream failed", exc_info=True)
        yield {"type": "error", "detail": str(exc)}
        return

    await proc.wait()
    stderr = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()

    if proc.returncode != 0 or result.get("is_error"):
        # THE RESULT EVENT WINS OVER STDERR. The CLI writes advisory notices to
        # stderr -- a connectors warning, a version notice -- while the actual
        # failure arrives in the result event's `result` field. Preferring
        # stderr showed "claude.ai connectors are disabled" to a user whose
        # real problem was the engine refusing an oversized prompt: a true
        # sentence about something else, which is worse than no message,
        # because it sends them off to fix the wrong thing.
        detail = None
        if result.get("is_error") and isinstance(result.get("result"), str):
            detail = result["result"].strip() or None
        yield {
            "type": "error",
            "detail": detail or stderr
                      or f"The harness exited with code {proc.returncode}.",
        }
        return

    # Deltas first, then the whole-message fallback, then the result summary.
    # Never a concatenation of two of them — that is the doubling bug.
    text = (
        "".join(delta_parts)
        or "".join(message_parts)
        or (result.get("result") or "")
    )
    yield {
        "type": "done",
        "text": text,
        "session_id": result.get("session_id"),
        # Reported per turn. Under a SUBSCRIPTION this is API-EQUIVALENT, not
        # money billed — spend_guard already draws that line and Chat must not
        # redraw it.
        #
        # NULL ON A REROUTED TURN, and this is a DISPLAY fix rather than a data
        # one — nothing persists this field and no UI reads it today. The CLI
        # prices its own harness usage from its internal Anthropic table and
        # DOES NOT KNOW its ANTHROPIC_BASE_URL was pointed at a local rig, so on
        # a rerouted turn `total_cost_usd` is a real number about an imaginary
        # transaction. Measured 2026-08-02: a local turn served free by
        # `qwen3-30b-instruct` reported $0.1466 and 29,306 context tokens while
        # the rig recorded 28 prompt tokens for the whole window.
        #
        # The evidence record was never at risk and that was checked before
        # this line was written: priced Anthropic traffic and free local traffic
        # live in SEPARATE TABLES and only `usage_events` has a money column —
        # `local_runs` has none, so a local turn cannot move a spend cap because
        # there is nowhere to put the money. `price_for()` also returns None for
        # an unknown model rather than falling back to a Claude rate.
        #
        # So why fix it at all: an unread wrong value is a trap for whoever
        # later decides to display it, and this codebase has repeatedly found a
        # consumer starting to read a field nobody had checked. `env_overlay` is
        # the exact discriminator — it is set precisely when this turn was
        # rerouted off Anthropic.
        "cost_usd": None if env_overlay else result.get("total_cost_usd"),
        "is_error": bool(result.get("is_error")),
        **_usage(result),
    }


def _usage(result: dict) -> dict:
    """Context and output tokens for the turn, or nulls.

    THE TRAP, measured rather than assumed: on a real turn ``input_tokens`` was
    **2** while ``cache_read_input_tokens`` was **20592**. Reading input_tokens
    alone would report 2 tokens of context for a conversation actually carrying
    ~20.6k — a meter that reads near-empty right up until the model refuses.

    Context in flight is therefore input + cache_read + cache_creation: every
    token the model had to be given, however it was billed.

    A missing usage block yields ``None``, never 0. "We were not told" and
    "the context is empty" are opposite claims, and a 0 here would show a
    reassuring empty bar on a conversation about to overflow.
    """
    u = result.get("usage")
    if not isinstance(u, dict):
        return {"context_tokens": None, "output_tokens": None}

    def n(key):
        v = u.get(key)
        return v if isinstance(v, int) else 0

    total = n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens")
    return {
        "context_tokens": total or None,
        "output_tokens": u.get("output_tokens") if isinstance(u.get("output_tokens"), int) else None,
    }
