"""Thin tagging proxy so LM Studio (via the lane broker) traffic can be
attributed to the Cockpit session/repo that caused it.

Mounted at ``/shim/lmstudio`` on the main FastAPI ``app`` (see server.py).
The `claude` CLI cannot be told to send custom HTTP headers, so Cockpit
cannot tag outgoing requests with a session id that way. What Cockpit DOES
control is the base URL each session is launched with -- so every session
gets a SESSION-SCOPED base URL (``/shim/lmstudio/s/{terminal_id}``) and this
proxy adds the broker's attribution headers on the way out:

  - ``X-Lane-Class: interactive`` -- an interactive Cockpit pane is always
    the broker's "interactive" lane class.
  - ``X-Client-Id`` / ``X-Agent-Id`` -- set to the session id when present
    (the broker's per-session/per-agent breakdowns key off these).

This is a NON-TRANSLATING passthrough -- the broker already speaks the
Anthropic ``/v1/messages`` shape directly (unlike vLLM, which needs
web/vllm_shim.py's OpenAI translation). The body is forwarded BYTE-VERBATIM
in both directions: the vendored broker README is explicit that
byte-verbatim relay is mandatory (a prior middlebox that re-encoded bodies
silently dropped tool-call arguments -- see vllm_shim.py's module docstring
for the same lesson learned the hard way). Streaming responses are relayed
as a raw SSE byte passthrough with no re-encoding.
"""

from __future__ import annotations

import json
import logging
import time
from typing import AsyncIterator

import httpx
from fastapi import APIRouter, Request
from starlette.responses import JSONResponse, Response, StreamingResponse

logger = logging.getLogger("cockpit.lmstudio_proxy")

router = APIRouter(prefix="/shim/lmstudio")

# Mirrors vllm_shim's timeout stance: generous read timeout for local
# generation, tight connect timeout so a dead broker fails fast.
_TIMEOUT = httpx.Timeout(connect=5.0, read=600.0, write=30.0, pool=600.0)


def _broker_base_url() -> str:
    """Resolve the LM Studio broker's URL from the provider registry, not a
    hardcoded constant -- keeps this module in sync with whatever the user
    (or COCKPIT_PROVIDERS_FILE) has configured for ``lmstudio-local``.
    """
    import server as server_module  # local import: avoids a circular import

    provider = server_module._PROVIDERS.get("lmstudio-local") or {}
    return (provider.get("broker_url") or server_module._LOCAL_BROKER_URL).rstrip("/")


def _anthropic_error(message: str, *, status_code: int = 502, err_type: str = "api_error") -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={"type": "error", "error": {"type": err_type, "message": message}},
    )


def _resolve_workdir(session_id: str | None) -> str | None:
    """Best-effort workdir lookup via pty_manager, denormalized at write
    time so the recorded row survives the session later being closed.
    """
    if not session_id:
        return None
    try:
        import pty_manager as pty_manager_module

        session = pty_manager_module.pty_manager.sessions.get(session_id)
        if session is not None:
            return session.working_dir or None
    except Exception:
        logger.debug("lmstudio_proxy: failed resolving workdir for session %s", session_id, exc_info=True)
    return None


def _record_local_run(*, session_id: str | None, model, input_tokens, output_tokens, wall_ms: float) -> None:
    """Best-effort local-run recording -- never raises into the request path."""
    try:
        import usage_tracker as usage_tracker_module

        usage_tracker_module.usage_tracker.record_local_run(
            terminal_id=session_id,
            provider_id="lmstudio-local",
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            wall_ms=wall_ms,
            workdir=_resolve_workdir(session_id),
        )
    except Exception:
        logger.error("lmstudio_proxy: failed to record local run", exc_info=True)


def _extract_usage(oa_like_resp: dict) -> tuple:
    """Anthropic /v1/messages responses carry usage at top-level ``usage``
    ({"input_tokens":..,"output_tokens":..}) -- the broker forwards LM
    Studio's Anthropic-shaped response verbatim, so no translation needed
    here (unlike vllm_shim, which translates from OpenAI's usage shape).
    """
    usage = oa_like_resp.get("usage") if isinstance(oa_like_resp, dict) else None
    if not isinstance(usage, dict):
        return None, None
    return usage.get("input_tokens"), usage.get("output_tokens")


@router.post("/v1/messages")
async def messages(request: Request):
    return await _handle_messages(request, session_id=None)


@router.post("/s/{session_id}/v1/messages")
async def messages_scoped(request: Request, session_id: str):
    return await _handle_messages(request, session_id=session_id)


async def _handle_messages(request: Request, *, session_id: str | None):
    body_bytes = await request.body()

    try:
        body_obj = json.loads(body_bytes) if body_bytes else {}
    except (json.JSONDecodeError, ValueError):
        body_obj = {}
    model = body_obj.get("model") if isinstance(body_obj, dict) else None
    stream = bool(body_obj.get("stream")) if isinstance(body_obj, dict) else False

    upstream_url = f"{_broker_base_url()}/v1/messages"

    headers = {"Content-Type": "application/json", "X-Lane-Class": "interactive"}
    if session_id:
        headers["X-Client-Id"] = session_id
        headers["X-Agent-Id"] = session_id

    if stream:
        return await _proxy_stream(upstream_url, body_bytes, headers, model=model, session_id=session_id)
    return await _proxy_non_stream(upstream_url, body_bytes, headers, model=model, session_id=session_id)


async def _proxy_non_stream(
    upstream_url: str, body_bytes: bytes, headers: dict, *, model, session_id: str | None
) -> Response:
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            # Byte-verbatim forward: `content=` sends the exact bytes we
            # received, with NO re-encoding/re-parsing of the body.
            resp = await client.post(upstream_url, content=body_bytes, headers=headers)
    except httpx.HTTPError:
        logger.error("lmstudio_proxy: failed to reach broker at %s", upstream_url, exc_info=True)
        return _anthropic_error(f"Could not reach LM Studio broker at {upstream_url}", status_code=503)

    wall_ms = (time.monotonic() - start) * 1000

    try:
        resp_obj = json.loads(resp.content) if resp.content else {}
    except (json.JSONDecodeError, ValueError):
        resp_obj = {}
    resp_model = resp_obj.get("model") if isinstance(resp_obj, dict) else None
    input_tokens, output_tokens = _extract_usage(resp_obj) if isinstance(resp_obj, dict) else (None, None)

    if resp.status_code < 400:
        _record_local_run(
            session_id=session_id,
            model=resp_model or model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            wall_ms=wall_ms,
        )

    # Byte-verbatim relay of the response body too -- no JSON round-trip.
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


async def _proxy_stream(
    upstream_url: str, body_bytes: bytes, headers: dict, *, model, session_id: str | None
) -> StreamingResponse:
    client = httpx.AsyncClient(timeout=_TIMEOUT)
    start = time.monotonic()

    async def event_gen() -> AsyncIterator[bytes]:
        buf = b""
        final_usage: dict = {}
        seen_model = model
        try:
            async with client.stream("POST", upstream_url, content=body_bytes, headers=headers) as resp:
                async for chunk in resp.aiter_bytes():
                    # Raw byte passthrough -- no re-encoding of SSE frames.
                    yield chunk
                    # Best-effort usage/model extraction for recording only;
                    # never mutates what's yielded to the client.
                    buf += chunk
                    while b"\n\n" in buf:
                        frame, buf = buf.split(b"\n\n", 1)
                        for line in frame.split(b"\n"):
                            if not line.startswith(b"data:"):
                                continue
                            data_str = line[len(b"data:"):].strip()
                            if not data_str or data_str == b"[DONE]":
                                continue
                            try:
                                evt = json.loads(data_str)
                            except (json.JSONDecodeError, ValueError):
                                continue
                            if isinstance(evt, dict):
                                msg = evt.get("message")
                                if isinstance(msg, dict) and msg.get("model"):
                                    seen_model = msg.get("model")
                                usage = evt.get("usage")
                                if isinstance(usage, dict):
                                    final_usage.update(usage)
        except httpx.HTTPError:
            logger.error("lmstudio_proxy: failed to reach broker at %s during streaming", upstream_url, exc_info=True)
        finally:
            wall_ms = (time.monotonic() - start) * 1000
            _record_local_run(
                session_id=session_id,
                model=seen_model,
                input_tokens=final_usage.get("input_tokens"),
                output_tokens=final_usage.get("output_tokens"),
                wall_ms=wall_ms,
            )
            await client.aclose()

    return StreamingResponse(event_gen(), media_type="text/event-stream")
