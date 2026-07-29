"""In-process Anthropic -> OpenAI translation shim so the ``claude`` CLI can
drive a local vLLM server (OpenAI protocol only) with no extra process.

Mounted at ``/shim/vllm`` on the main FastAPI ``app`` (see server.py). The
CLI is pointed at it via ``ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/shim/vllm``
and calls ``POST /shim/vllm/v1/messages`` exactly as it would call the real
Anthropic API.

Fidelity is the whole point of this module: a prior middlebox (LiteLLM) was
found to silently drop tool-call arguments in translation, which the vendored
broker README calls out as a disqualifying failure mode (see
web/lane_broker/README.md ~line 19). Every code path here -- non-streaming,
streaming, and the request-side translation -- is written to carry tool
arguments through byte-for-byte (JSON round-trip), never lossily.

This module intentionally does NOT queue or serialize requests -- vLLM does
its own continuous batching; adding a queue here would defeat that (see the
project's "vllm coexists beside the lane broker, not behind it" architecture
note in CLAUDE.md).
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, AsyncIterator

import httpx
from fastapi import APIRouter, Request
from starlette.responses import JSONResponse, StreamingResponse

logger = logging.getLogger("cockpit.vllm_shim")

router = APIRouter(prefix="/shim/vllm")

# Generous timeout: local generation can run long, especially for big
# worker-card contexts. connect timeout kept tight so a dead/unstarted
# vLLM fails fast rather than hanging the CLI.
_TIMEOUT = httpx.Timeout(connect=5.0, read=600.0, write=30.0, pool=600.0)

_FINISH_REASON_MAP = {
    "stop": "end_turn",
    "length": "max_tokens",
    "tool_calls": "tool_use",
    "content_filter": "end_turn",
}


def _vllm_base_url() -> str:
    """Resolve the vLLM upstream URL from the provider registry, not a
    hardcoded constant -- keeps this module in sync with whatever the user
    (or SSRF-guarded endpoint route) has configured for ``vllm-local``.
    """
    import server as server_module  # local import: avoids a circular import

    # Fall back to management_url == broker_url for vllm-local (they're
    # always kept equal -- see server.py's provider registry comment).
    provider = server_module._PROVIDERS.get("vllm-local") or {}
    return (provider.get("management_url") or server_module._VLLM_URL).rstrip("/")


# ---------------------------------------------------------------------------
# Request translation: Anthropic Messages body -> OpenAI chat/completions body
# ---------------------------------------------------------------------------


def _anthropic_content_to_text(content: Any) -> str:
    """Flatten an Anthropic ``content`` field (string or block array) into a
    single text string. Used for the system prompt and for plain-text
    message content.
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(block.get("text", ""))
        return "".join(parts)
    return str(content)


def _translate_tool_choice(tool_choice: dict | None) -> Any:
    if not tool_choice:
        return None
    kind = tool_choice.get("type")
    if kind == "auto":
        return "auto"
    if kind == "any":
        return "required"
    if kind == "tool":
        name = tool_choice.get("name")
        if name:
            return {"type": "function", "function": {"name": name}}
    return "auto"


def _translate_tools(tools: list | None) -> list | None:
    if not tools:
        return None
    out = []
    for t in tools:
        out.append(
            {
                "type": "function",
                "function": {
                    "name": t.get("name"),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {"type": "object", "properties": {}}),
                },
            }
        )
    return out


def _translate_messages(system: Any, messages: list) -> list[dict]:
    """Anthropic messages[] (+ optional system) -> OpenAI messages[].

    tool_use blocks in an assistant turn become an assistant message with
    ``tool_calls``; tool_result blocks in a user turn become one ``role:
    tool`` message each (OpenAI requires tool results as separate messages,
    Anthropic nests them inside a user turn's content array).
    """
    out: list[dict] = []

    system_text = _anthropic_content_to_text(system) if system else ""
    if system_text:
        out.append({"role": "system", "content": system_text})

    for msg in messages or []:
        role = msg.get("role")
        content = msg.get("content")

        if isinstance(content, str):
            out.append({"role": role, "content": content})
            continue

        if not isinstance(content, list):
            out.append({"role": role, "content": _anthropic_content_to_text(content)})
            continue

        if role == "assistant":
            text_parts = []
            tool_calls = []
            for block in content:
                btype = block.get("type")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    tool_calls.append(
                        {
                            "id": block.get("id") or f"call_{uuid.uuid4().hex[:24]}",
                            "type": "function",
                            "function": {
                                "name": block.get("name"),
                                # Fidelity-critical: input MUST round-trip as
                                # exact JSON, not a lossy str() of the dict.
                                "arguments": json.dumps(block.get("input", {})),
                            },
                        }
                    )
            entry: dict = {"role": "assistant"}
            entry["content"] = "".join(text_parts) if text_parts else None
            if tool_calls:
                entry["tool_calls"] = tool_calls
            out.append(entry)
            continue

        if role == "user":
            text_parts = []
            tool_results = []
            for block in content:
                btype = block.get("type")
                if btype == "text":
                    text_parts.append(block.get("text", ""))
                elif btype == "tool_result":
                    tool_results.append(block)
                elif btype == "image":
                    # Not translated -- vLLM/qwen3_coder text-tool path does
                    # not need image support for this tier; skip silently
                    # rather than crash the whole request.
                    logger.warning("vllm_shim: dropping unsupported image content block")

            if text_parts:
                out.append({"role": "user", "content": "".join(text_parts)})

            for tr in tool_results:
                tr_content = tr.get("content")
                if isinstance(tr_content, list):
                    tr_text = _anthropic_content_to_text(tr_content)
                elif isinstance(tr_content, str):
                    tr_text = tr_content
                else:
                    tr_text = json.dumps(tr_content) if tr_content is not None else ""
                out.append(
                    {
                        "role": "tool",
                        "tool_call_id": tr.get("tool_use_id"),
                        "content": tr_text,
                    }
                )
            continue

        # Unknown role -- pass through best-effort.
        out.append({"role": role, "content": _anthropic_content_to_text(content)})

    return out


def anthropic_to_openai(body: dict) -> dict:
    """Translate a full Anthropic /v1/messages request body into an OpenAI
    /v1/chat/completions request body.
    """
    openai_body: dict = {
        "model": body.get("model"),
        "messages": _translate_messages(body.get("system"), body.get("messages", [])),
    }

    if "max_tokens" in body and body["max_tokens"] is not None:
        openai_body["max_tokens"] = body["max_tokens"]
    if "temperature" in body and body["temperature"] is not None:
        openai_body["temperature"] = body["temperature"]
    if "top_p" in body and body["top_p"] is not None:
        openai_body["top_p"] = body["top_p"]
    if body.get("stop_sequences"):
        openai_body["stop"] = body["stop_sequences"]

    tools = _translate_tools(body.get("tools"))
    if tools:
        openai_body["tools"] = tools
    tool_choice = _translate_tool_choice(body.get("tool_choice"))
    if tool_choice is not None:
        openai_body["tool_choice"] = tool_choice

    stream = bool(body.get("stream"))
    openai_body["stream"] = stream
    if stream:
        openai_body["stream_options"] = {"include_usage": True}

    return openai_body


# ---------------------------------------------------------------------------
# Response translation: OpenAI chat/completions -> Anthropic Messages
# ---------------------------------------------------------------------------


def _parse_tool_arguments(raw: str, *, tool_call_id: str | None, name: str | None) -> dict:
    """Parse an OpenAI tool_call's ``arguments`` JSON string. Guards against
    malformed JSON (should not happen with a well-behaved vLLM + tool
    parser, but must not crash the response translation if it does) --
    falls back to wrapping the raw string so the model's output is not
    silently discarded, and logs loudly since this is exactly the failure
    mode we must never reproduce silently.
    """
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        logger.error(
            "vllm_shim: tool_call arguments for %s (id=%s) failed to parse as JSON; "
            "passing raw string through under '_raw' rather than dropping it: %r",
            name,
            tool_call_id,
            raw,
        )
        return {"_raw": raw}


def openai_to_anthropic(resp: dict, *, model: str) -> dict:
    """Translate a non-streaming OpenAI chat/completions response into an
    Anthropic Messages response.
    """
    choice = (resp.get("choices") or [{}])[0]
    message = choice.get("message", {}) or {}

    content_blocks: list[dict] = []

    text = message.get("content")
    if text:
        content_blocks.append({"type": "text", "text": text})

    for tc in message.get("tool_calls") or []:
        func = tc.get("function", {}) or {}
        name = func.get("name")
        args = _parse_tool_arguments(func.get("arguments", ""), tool_call_id=tc.get("id"), name=name)
        content_blocks.append(
            {
                "type": "tool_use",
                "id": tc.get("id") or f"call_{uuid.uuid4().hex[:24]}",
                "name": name,
                "input": args,
            }
        )

    if not content_blocks:
        content_blocks.append({"type": "text", "text": ""})

    finish_reason = choice.get("finish_reason")
    stop_reason = _FINISH_REASON_MAP.get(finish_reason, "end_turn")

    usage = resp.get("usage") or {}
    anthropic_usage = {
        "input_tokens": usage.get("prompt_tokens", 0) or 0,
        "output_tokens": usage.get("completion_tokens", 0) or 0,
    }

    return {
        "id": resp.get("id") or f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content_blocks,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": anthropic_usage,
    }


# ---------------------------------------------------------------------------
# Streaming translation: OpenAI SSE chunks -> Anthropic SSE event sequence
# ---------------------------------------------------------------------------


class _StreamState:
    """Accumulates state across an OpenAI SSE stream so it can be re-emitted
    as the Anthropic event protocol. One instance per request.

    Anthropic content blocks are strictly ordered and each must be
    start/delta*/stop before the next one begins; OpenAI deltas arrive keyed
    by index (text has no index, tool_calls carry an ``index``). We track
    which anthropic content-block index (0-based, contiguous) each OpenAI
    tool_call "index" maps to, and whether the text block has been opened,
    so interleaving never desyncs the two protocols.
    """

    def __init__(self, message_id: str, model: str):
        self.message_id = message_id
        self.model = model
        self.text_block_index: int | None = None
        # openai tool_call index -> anthropic content block index
        self.tool_block_index: dict[int, int] = {}
        self.tool_ids: dict[int, str] = {}
        self.tool_names: dict[int, str] = {}
        self.next_block_index = 0
        self.finish_reason: str | None = None
        self.usage: dict = {}
        self.message_start_sent = False


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _message_start_event(state: _StreamState) -> str:
    state.message_start_sent = True
    return _sse(
        "message_start",
        {
            "type": "message_start",
            "message": {
                "id": state.message_id,
                "type": "message",
                "role": "assistant",
                "model": state.model,
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        },
    )


async def _translate_openai_stream(
    upstream: AsyncIterator[bytes], *, model: str, usage_holder: dict | None = None
) -> AsyncIterator[str]:
    state = _StreamState(message_id=f"msg_{uuid.uuid4().hex[:24]}", model=model)

    async for raw_line in _iter_sse_lines(upstream):
        line = raw_line.strip()
        if not line or not line.startswith("data:"):
            continue
        data_str = line[len("data:"):].strip()
        if data_str == "[DONE]":
            break
        try:
            chunk = json.loads(data_str)
        except json.JSONDecodeError:
            logger.warning("vllm_shim: skipping malformed SSE chunk from upstream: %r", data_str)
            continue

        if not state.message_start_sent:
            yield _message_start_event(state)

        choices = chunk.get("choices") or []
        if choices:
            choice = choices[0]
            delta = choice.get("delta", {}) or {}
            if choice.get("finish_reason"):
                state.finish_reason = choice["finish_reason"]

            text_piece = delta.get("content")
            if text_piece:
                if state.text_block_index is None:
                    state.text_block_index = state.next_block_index
                    state.next_block_index += 1
                    yield _sse(
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": state.text_block_index,
                            "content_block": {"type": "text", "text": ""},
                        },
                    )
                yield _sse(
                    "content_block_delta",
                    {
                        "type": "content_block_delta",
                        "index": state.text_block_index,
                        "delta": {"type": "text_delta", "text": text_piece},
                    },
                )

            for tc in delta.get("tool_calls") or []:
                oa_idx = tc.get("index", 0)
                func = tc.get("function", {}) or {}
                if oa_idx not in state.tool_block_index:
                    # First fragment for this tool call: open a new
                    # anthropic content block. id/name normally arrive only
                    # on this first fragment per the OpenAI streaming shape.
                    block_index = state.next_block_index
                    state.next_block_index += 1
                    state.tool_block_index[oa_idx] = block_index
                    tool_id = tc.get("id") or f"call_{uuid.uuid4().hex[:24]}"
                    tool_name = func.get("name") or ""
                    state.tool_ids[oa_idx] = tool_id
                    state.tool_names[oa_idx] = tool_name
                    yield _sse(
                        "content_block_start",
                        {
                            "type": "content_block_start",
                            "index": block_index,
                            "content_block": {
                                "type": "tool_use",
                                "id": tool_id,
                                "name": tool_name,
                                "input": {},
                            },
                        },
                    )
                block_index = state.tool_block_index[oa_idx]
                args_piece = func.get("arguments")
                if args_piece:
                    yield _sse(
                        "content_block_delta",
                        {
                            "type": "content_block_delta",
                            "index": block_index,
                            "delta": {"type": "input_json_delta", "partial_json": args_piece},
                        },
                    )

        usage = chunk.get("usage")
        if usage:
            state.usage = usage
            if usage_holder is not None:
                usage_holder["prompt_tokens"] = usage.get("prompt_tokens")
                usage_holder["completion_tokens"] = usage.get("completion_tokens")

    # An upstream stream that never carried a data chunk (empty, or only
    # [DONE]) must still produce a well-formed Anthropic sequence -- the
    # tail below unconditionally emits message_delta/message_stop, so
    # message_start must be guaranteed to precede them even when no chunk
    # ever triggered it above.
    if not state.message_start_sent:
        yield _message_start_event(state)

    # Close any open content blocks in the order they were opened.
    closed_indices = set()
    if state.text_block_index is not None:
        yield _sse(
            "content_block_stop",
            {"type": "content_block_stop", "index": state.text_block_index},
        )
        closed_indices.add(state.text_block_index)
    for block_index in state.tool_block_index.values():
        if block_index in closed_indices:
            continue
        yield _sse(
            "content_block_stop",
            {"type": "content_block_stop", "index": block_index},
        )

    stop_reason = _FINISH_REASON_MAP.get(state.finish_reason, "end_turn")
    yield _sse(
        "message_delta",
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop_reason, "stop_sequence": None},
            "usage": {
                "input_tokens": state.usage.get("prompt_tokens", 0) or 0,
                "output_tokens": state.usage.get("completion_tokens", 0) or 0,
            },
        },
    )
    yield _sse("message_stop", {"type": "message_stop"})


async def _iter_sse_lines(byte_iter: AsyncIterator[bytes]) -> AsyncIterator[str]:
    """Buffer an async byte stream into complete lines. httpx's aiter_lines
    already does this, but this helper keeps the translator agnostic to
    whether it's fed real httpx output or a synthetic test iterator of raw
    SSE text lines (both are supported by call sites below).
    """
    buf = ""
    async for chunk in byte_iter:
        if isinstance(chunk, bytes):
            buf += chunk.decode("utf-8", errors="replace")
        else:
            buf += chunk
        while "\n" in buf:
            line, buf = buf.split("\n", 1)
            yield line
    if buf:
        yield buf


# ---------------------------------------------------------------------------
# Error shaping
# ---------------------------------------------------------------------------


def _anthropic_error(message: str, *, status_code: int = 502, err_type: str = "api_error") -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"type": "error", "error": {"type": err_type, "message": message}},
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.post("/v1/messages")
async def messages(request: Request):
    return await _handle_messages(request, session_id=None)


@router.post("/s/{session_id}/v1/messages")
async def messages_scoped(request: Request, session_id: str):
    return await _handle_messages(request, session_id=session_id)


async def _handle_messages(request: Request, *, session_id: str | None):
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return _anthropic_error("Request body is not valid JSON", status_code=400, err_type="invalid_request_error")

    model = body.get("model", "vllm")
    stream = bool(body.get("stream"))

    try:
        openai_body = anthropic_to_openai(body)
    except Exception:
        logger.error("vllm_shim: failed to translate Anthropic request to OpenAI shape", exc_info=True)
        return _anthropic_error("Failed to translate request", status_code=400, err_type="invalid_request_error")

    upstream_url = f"{_vllm_base_url()}/v1/chat/completions"

    if stream:
        return await _proxy_stream(upstream_url, openai_body, model=model, session_id=session_id)
    return await _proxy_non_stream(upstream_url, openai_body, model=model, session_id=session_id)


def _resolve_workdir(session_id: str | None) -> str | None:
    """Look up the session's workdir via pty_manager by terminal id --
    denormalized at write time (into local_runs.workdir) so the row survives
    the session later being closed. Best-effort: returns None if the session
    can't be resolved (never guesses).
    """
    if not session_id:
        return None
    try:
        import pty_manager as pty_manager_module

        session = pty_manager_module.pty_manager.sessions.get(session_id)
        if session is not None:
            return session.working_dir or None
    except Exception:
        logger.debug("vllm_shim: failed resolving workdir for session %s", session_id, exc_info=True)
    return None


def _record_local_run(*, session_id: str | None, model: str, input_tokens, output_tokens, wall_ms: float) -> None:
    """Best-effort local-run recording -- never raises into the request path."""
    try:
        import usage_tracker as usage_tracker_module

        usage_tracker_module.usage_tracker.record_local_run(
            terminal_id=session_id,
            provider_id="vllm-local",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            wall_ms=wall_ms,
            workdir=_resolve_workdir(session_id),
        )
    except Exception:
        logger.error("vllm_shim: failed to record local run", exc_info=True)


async def _proxy_non_stream(
    upstream_url: str, openai_body: dict, *, model: str, session_id: str | None = None
) -> JSONResponse:
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(upstream_url, json=openai_body)
            resp.raise_for_status()
            oa_resp = resp.json()
    except httpx.HTTPStatusError as exc:
        logger.error("vllm_shim: upstream vLLM returned an error status", exc_info=True)
        return _anthropic_error(
            f"Upstream vLLM error: {exc.response.status_code}", status_code=502
        )
    except httpx.HTTPError:
        logger.error("vllm_shim: failed to reach upstream vLLM at %s", upstream_url, exc_info=True)
        return _anthropic_error(f"Could not reach vLLM upstream at {upstream_url}", status_code=503)
    except (json.JSONDecodeError, ValueError):
        logger.error("vllm_shim: upstream vLLM response was not valid JSON", exc_info=True)
        return _anthropic_error("Upstream vLLM returned a malformed response", status_code=502)

    try:
        anthropic_resp = openai_to_anthropic(oa_resp, model=model)
    except Exception:
        logger.error("vllm_shim: failed to translate OpenAI response to Anthropic shape", exc_info=True)
        return _anthropic_error("Failed to translate upstream response", status_code=502)

    wall_ms = (time.monotonic() - start) * 1000
    usage = oa_resp.get("usage") or {}
    _record_local_run(
        session_id=session_id,
        model=model,
        input_tokens=usage.get("prompt_tokens"),
        output_tokens=usage.get("completion_tokens"),
        wall_ms=wall_ms,
    )

    return JSONResponse(content=anthropic_resp)


async def _proxy_stream(
    upstream_url: str, openai_body: dict, *, model: str, session_id: str | None = None
) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=_TIMEOUT)
    start = time.monotonic()

    async def event_gen() -> AsyncIterator[str]:
        usage_holder: dict = {}
        try:
            async with client.stream("POST", upstream_url, json=openai_body) as resp:
                resp.raise_for_status()
                async for event in _translate_openai_stream(
                    resp.aiter_lines(), model=model, usage_holder=usage_holder
                ):
                    yield event
        except httpx.HTTPStatusError as exc:
            logger.error("vllm_shim: upstream vLLM returned an error status during streaming", exc_info=True)
            yield _sse(
                "error",
                {
                    "type": "error",
                    "error": {
                        "type": "api_error",
                        "message": f"Upstream vLLM error: {exc.response.status_code}",
                    },
                },
            )
        except httpx.HTTPError:
            logger.error("vllm_shim: failed to reach upstream vLLM at %s during streaming", upstream_url, exc_info=True)
            yield _sse(
                "error",
                {
                    "type": "error",
                    "error": {"type": "api_error", "message": f"Could not reach vLLM upstream at {upstream_url}"},
                },
            )
        finally:
            wall_ms = (time.monotonic() - start) * 1000
            _record_local_run(
                session_id=session_id,
                model=model,
                input_tokens=usage_holder.get("prompt_tokens"),
                output_tokens=usage_holder.get("completion_tokens"),
                wall_ms=wall_ms,
            )
            await client.aclose()

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@router.post("/v1/messages/count_tokens")
async def count_tokens(request: Request):
    return await _handle_count_tokens(request)


@router.post("/s/{session_id}/v1/messages/count_tokens")
async def count_tokens_scoped(request: Request, session_id: str):
    return await _handle_count_tokens(request)


async def _handle_count_tokens(request: Request):
    """Best-effort, non-proxying token estimate (chars/4 heuristic) -- claude
    may call this before a request; vLLM has no equivalent endpoint, and an
    approximate answer is fine here (this is explicitly documented as an
    estimate, matching Anthropic's own guidance that tokenization is
    model-specific).
    """
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return _anthropic_error("Request body is not valid JSON", status_code=400, err_type="invalid_request_error")

    system_text = _anthropic_content_to_text(body.get("system"))
    messages_text = "".join(_anthropic_content_to_text(m.get("content")) for m in body.get("messages", []))
    tools_text = json.dumps(body.get("tools", []))

    total_chars = len(system_text) + len(messages_text) + len(tools_text)
    estimate = max(1, total_chars // 4)

    return JSONResponse(content={"input_tokens": estimate})
