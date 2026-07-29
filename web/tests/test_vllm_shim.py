"""Tests for the Anthropic -> OpenAI translation shim (web/vllm_shim.py),
mounted at /shim/vllm so `claude` can drive a local vLLM server.

No live vLLM is required or assumed -- the httpx call to the upstream is
monkeypatched (non-streaming: httpx.AsyncClient.post; streaming: a fake
async context manager standing in for httpx.AsyncClient.stream). This
mirrors the "recorded/mocked upstream" approach requested for this tier;
live end-to-end smoke against real vLLM is pending a GPU driver update and
is out of scope here.

The single most important test in this file is
``test_tool_call_round_trip_non_streaming`` -- it asserts that tool_call
arguments survive the OpenAI -> Anthropic translation as a *parsed dict*,
not a dropped or re-stringified blob. A prior middlebox (LiteLLM) silently
dropped tool-call arguments in translation; the vendored broker README
calls this out as disqualifying (web/lane_broker/README.md ~line 19).
"""

from __future__ import annotations

import json
import os
import sys

import httpx
import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app
import vllm_shim


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


# ---------------------------------------------------------------------------
# Request translation: Anthropic -> OpenAI
# ---------------------------------------------------------------------------


def test_request_translation_tools_and_tool_result_round_trip():
    anthropic_body = {
        "model": "qwen3-coder-30b-awq",
        "system": "You are a helpful assistant.",
        "max_tokens": 512,
        "temperature": 0.3,
        "stop_sequences": ["STOP"],
        "tools": [
            {
                "name": "get_weather",
                "description": "Get the weather for a city",
                "input_schema": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            }
        ],
        "tool_choice": {"type": "auto"},
        "messages": [
            {"role": "user", "content": "What's the weather in Paris?"},
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "Let me check."},
                    {
                        "type": "tool_use",
                        "id": "toolu_01",
                        "name": "get_weather",
                        "input": {"city": "Paris"},
                    },
                ],
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu_01",
                        "content": [{"type": "text", "text": "22C, sunny"}],
                    }
                ],
            },
        ],
    }

    openai_body = vllm_shim.anthropic_to_openai(anthropic_body)

    assert openai_body["model"] == "qwen3-coder-30b-awq"
    assert openai_body["max_tokens"] == 512
    assert openai_body["temperature"] == 0.3
    assert openai_body["stop"] == ["STOP"]
    assert openai_body["tool_choice"] == "auto"

    assert openai_body["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get the weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                },
            },
        }
    ]

    messages = openai_body["messages"]
    assert messages[0] == {"role": "system", "content": "You are a helpful assistant."}
    assert messages[1] == {"role": "user", "content": "What's the weather in Paris?"}

    assistant_msg = messages[2]
    assert assistant_msg["role"] == "assistant"
    assert assistant_msg["content"] == "Let me check."
    assert assistant_msg["tool_calls"] == [
        {
            "id": "toolu_01",
            "type": "function",
            "function": {"name": "get_weather", "arguments": json.dumps({"city": "Paris"})},
        }
    ]

    tool_msg = messages[3]
    assert tool_msg == {"role": "tool", "tool_call_id": "toolu_01", "content": "22C, sunny"}


def test_tool_choice_specific_and_any_translation():
    assert vllm_shim._translate_tool_choice({"type": "any"}) == "required"
    assert vllm_shim._translate_tool_choice({"type": "tool", "name": "get_weather"}) == {
        "type": "function",
        "function": {"name": "get_weather"},
    }
    assert vllm_shim._translate_tool_choice(None) is None


# ---------------------------------------------------------------------------
# Response translation: OpenAI -> Anthropic (non-streaming)
# ---------------------------------------------------------------------------


def test_tool_call_round_trip_non_streaming():
    """THE key fidelity test: arguments must survive as a parsed dict, not
    be dropped or left as an opaque string.
    """
    openai_resp = {
        "id": "chatcmpl-abc123",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": "Sure, let me look that up.",
                    "tool_calls": [
                        {
                            "id": "call_xyz",
                            "type": "function",
                            "function": {
                                "name": "get_weather",
                                "arguments": json.dumps({"city": "Paris", "units": "celsius"}),
                            },
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 120, "completion_tokens": 18},
    }

    anthropic_resp = vllm_shim.openai_to_anthropic(openai_resp, model="qwen3-coder-30b-awq")

    assert anthropic_resp["role"] == "assistant"
    assert anthropic_resp["model"] == "qwen3-coder-30b-awq"
    assert anthropic_resp["stop_reason"] == "tool_use"
    assert anthropic_resp["usage"] == {"input_tokens": 120, "output_tokens": 18}

    text_blocks = [b for b in anthropic_resp["content"] if b["type"] == "text"]
    tool_blocks = [b for b in anthropic_resp["content"] if b["type"] == "tool_use"]

    assert text_blocks[0]["text"] == "Sure, let me look that up."
    assert len(tool_blocks) == 1
    assert tool_blocks[0]["id"] == "call_xyz"
    assert tool_blocks[0]["name"] == "get_weather"
    # Fidelity assertion: input is a parsed dict with both keys intact, not
    # a stringified blob and not dropped.
    assert tool_blocks[0]["input"] == {"city": "Paris", "units": "celsius"}


def test_malformed_tool_arguments_do_not_crash_and_are_preserved():
    openai_resp = {
        "id": "chatcmpl-broken",
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": "call_bad",
                            "type": "function",
                            "function": {"name": "get_weather", "arguments": "{not valid json"},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 5},
    }

    anthropic_resp = vllm_shim.openai_to_anthropic(openai_resp, model="qwen3-coder-30b-awq")
    tool_blocks = [b for b in anthropic_resp["content"] if b["type"] == "tool_use"]
    assert len(tool_blocks) == 1
    # Must not crash, and the raw text must survive somewhere rather than
    # vanishing silently.
    assert tool_blocks[0]["input"] == {"_raw": "{not valid json"}


@pytest.mark.parametrize(
    "finish_reason,expected_stop_reason",
    [
        ("stop", "end_turn"),
        ("length", "max_tokens"),
        ("tool_calls", "tool_use"),
        ("content_filter", "end_turn"),
        (None, "end_turn"),
    ],
)
def test_finish_reason_mapping(finish_reason, expected_stop_reason):
    openai_resp = {
        "id": "chatcmpl-x",
        "choices": [{"message": {"role": "assistant", "content": "hi"}, "finish_reason": finish_reason}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1},
    }
    anthropic_resp = vllm_shim.openai_to_anthropic(openai_resp, model="m")
    assert anthropic_resp["stop_reason"] == expected_stop_reason


def test_usage_mapping():
    openai_resp = {
        "id": "chatcmpl-u",
        "choices": [{"message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 42, "completion_tokens": 7},
    }
    anthropic_resp = vllm_shim.openai_to_anthropic(openai_resp, model="m")
    assert anthropic_resp["usage"] == {"input_tokens": 42, "output_tokens": 7}


# ---------------------------------------------------------------------------
# Streaming translation
# ---------------------------------------------------------------------------


def _sse_lines(*chunks: dict) -> list[str]:
    lines = []
    for c in chunks:
        lines.append(f"data: {json.dumps(c)}")
        lines.append("")
    lines.append("data: [DONE]")
    return lines


async def _alist(async_iter):
    return [x async for x in async_iter]


async def _async_line_iter(lines: list[str]):
    for line in lines:
        yield line + "\n"


@pytest.mark.asyncio
async def test_streaming_tool_call_fragments_reassemble():
    """Feed a sequence of OpenAI SSE chunks including a streamed tool_call
    whose arguments arrive in fragments; assert the emitted Anthropic event
    sequence reassembles the full arguments via input_json_delta parts and
    ends with message_stop.
    """
    chunks = [
        {"choices": [{"delta": {"role": "assistant"}, "finish_reason": None}]},
        {"choices": [{"delta": {"content": "Checking weather"}, "finish_reason": None}]},
        {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {"index": 0, "id": "call_1", "function": {"name": "get_weather", "arguments": ""}}
                        ]
                    },
                    "finish_reason": None,
                }
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '{"city": "'}}]}, "finish_reason": None}
            ]
        },
        {
            "choices": [
                {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'Paris"}'}}]}, "finish_reason": None}
            ]
        },
        {"choices": [{"delta": {}, "finish_reason": "tool_calls"}]},
        {"choices": [], "usage": {"prompt_tokens": 30, "completion_tokens": 12}},
    ]

    events_raw = await _alist(
        vllm_shim._translate_openai_stream(_async_line_iter(_sse_lines(*chunks)), model="qwen3-coder-30b-awq")
    )

    events = []
    for raw in events_raw:
        # each event is "event: X\ndata: {...}\n\n"
        data_line = [l for l in raw.split("\n") if l.startswith("data:")][0]
        events.append(json.loads(data_line[len("data:"):].strip()))

    types = [e["type"] for e in events]
    assert types[0] == "message_start"
    assert "content_block_start" in types
    assert types[-1] == "message_stop"
    assert types[-2] == "message_delta"

    # Reassemble tool_use input_json_delta fragments in order.
    input_json_parts = [
        e["delta"]["partial_json"]
        for e in events
        if e["type"] == "content_block_delta" and e["delta"].get("type") == "input_json_delta"
    ]
    assembled = "".join(input_json_parts)
    assert json.loads(assembled) == {"city": "Paris"}

    # The tool_use content block was opened with the correct id/name.
    tool_start = next(
        e for e in events if e["type"] == "content_block_start" and e["content_block"]["type"] == "tool_use"
    )
    assert tool_start["content_block"]["id"] == "call_1"
    assert tool_start["content_block"]["name"] == "get_weather"

    # Text content also streamed correctly.
    text_deltas = [
        e["delta"]["text"]
        for e in events
        if e["type"] == "content_block_delta" and e["delta"].get("type") == "text_delta"
    ]
    assert "".join(text_deltas) == "Checking weather"

    message_delta = events[-2]
    assert message_delta["delta"]["stop_reason"] == "tool_use"
    assert message_delta["usage"] == {"input_tokens": 30, "output_tokens": 12}


@pytest.mark.asyncio
async def test_streaming_empty_upstream_still_well_formed():
    """An upstream stream that carries no data chunk at all (empty, or only
    a [DONE] sentinel) must still yield a well-formed minimal Anthropic
    sequence: message_start -> message_delta(end_turn) -> message_stop.
    Previously the tail unconditionally emitted message_delta/message_stop
    without a preceding message_start when no chunk ever triggered it --
    a protocol violation for a client parsing the SSE stream.
    """
    events_raw = await _alist(
        vllm_shim._translate_openai_stream(_async_line_iter(_sse_lines()), model="qwen3-coder-30b-awq")
    )

    events = []
    for raw in events_raw:
        data_line = [l for l in raw.split("\n") if l.startswith("data:")][0]
        events.append(json.loads(data_line[len("data:"):].strip()))

    types = [e["type"] for e in events]
    assert types == ["message_start", "message_delta", "message_stop"]
    assert events[1]["delta"]["stop_reason"] == "end_turn"
    assert events[1]["usage"] == {"input_tokens": 0, "output_tokens": 0}


# ---------------------------------------------------------------------------
# End-to-end route tests (httpx upstream call monkeypatched)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_route_non_streaming_end_to_end(client, monkeypatch):
    # Patching httpx.AsyncClient.post globally would also intercept the test
    # client's own ASGI-transport calls (it's the same class). Only stand in
    # for calls hitting the vLLM upstream; delegate everything else to the
    # real implementation so the ASGI app dispatch still works.
    original_post = httpx.AsyncClient.post

    async def fake_post(self, url, json=None, **kwargs):
        if "/v1/chat/completions" not in str(url):
            return await original_post(self, url, json=json, **kwargs)
        request = httpx.Request("POST", url)
        return httpx.Response(
            200,
            request=request,
            json={
                "id": "chatcmpl-1",
                "choices": [
                    {
                        "message": {"role": "assistant", "content": "hello there"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 2},
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    resp = await client.post(
        "/shim/vllm/v1/messages",
        json={
            "model": "qwen3-coder-30b-awq",
            "max_tokens": 100,
            "stream": False,
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["role"] == "assistant"
    assert body["content"][0]["text"] == "hello there"
    assert body["stop_reason"] == "end_turn"


@pytest.mark.asyncio
async def test_route_upstream_unreachable_returns_clean_error(client, monkeypatch):
    original_post = httpx.AsyncClient.post

    async def fake_post(self, url, json=None, **kwargs):
        if "/v1/chat/completions" not in str(url):
            return await original_post(self, url, json=json, **kwargs)
        raise httpx.ConnectError("connection refused", request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    resp = await client.post(
        "/shim/vllm/v1/messages",
        json={
            "model": "qwen3-coder-30b-awq",
            "max_tokens": 100,
            "stream": False,
            "messages": [{"role": "user", "content": "hi"}],
        },
    )
    assert resp.status_code == 503
    body = resp.json()
    assert body["type"] == "error"


@pytest.mark.asyncio
async def test_route_streaming_end_to_end(client, monkeypatch):
    """Exercises _proxy_stream via the real /shim/vllm/v1/messages route with
    stream:true, mocking httpx.AsyncClient.stream (an async context manager,
    not a coroutine like .post) to hand back a fake OpenAI SSE response.
    """
    sse_chunks = [
        {"choices": [{"delta": {"content": "Hi there"}, "finish_reason": None}]},
        {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        {"choices": [], "usage": {"prompt_tokens": 4, "completion_tokens": 2}},
    ]
    sse_lines = _sse_lines(*sse_chunks)

    class _FakeStreamResponse:
        def raise_for_status(self):
            pass

        async def aiter_lines(self):
            for line in sse_lines:
                yield line + "\n"

    class _FakeStreamCtx:
        def __init__(self, url):
            self.url = url

        async def __aenter__(self):
            assert "/v1/chat/completions" in self.url
            return _FakeStreamResponse()

        async def __aexit__(self, *exc):
            return False

    original_stream = httpx.AsyncClient.stream

    def fake_stream(self, method, url, json=None, **kwargs):
        if "/v1/chat/completions" not in str(url):
            return original_stream(self, method, url, json=json, **kwargs)
        assert method == "POST"
        return _FakeStreamCtx(str(url))

    monkeypatch.setattr(httpx.AsyncClient, "stream", fake_stream)

    async with client.stream(
        "POST",
        "/shim/vllm/v1/messages",
        json={
            "model": "qwen3-coder-30b-awq",
            "max_tokens": 100,
            "stream": True,
            "messages": [{"role": "user", "content": "hi"}],
        },
    ) as resp:
        assert resp.status_code == 200
        body_text = "".join([chunk async for chunk in resp.aiter_text()])

    events = []
    for block in body_text.split("\n\n"):
        block = block.strip()
        if not block:
            continue
        data_line = [l for l in block.split("\n") if l.startswith("data:")][0]
        events.append(json.loads(data_line[len("data:"):].strip()))

    types = [e["type"] for e in events]
    assert types[0] == "message_start"
    assert types[-1] == "message_stop"
    text_deltas = [
        e["delta"]["text"]
        for e in events
        if e["type"] == "content_block_delta" and e["delta"].get("type") == "text_delta"
    ]
    assert "".join(text_deltas) == "Hi there"
    message_delta = next(e for e in events if e["type"] == "message_delta")
    assert message_delta["delta"]["stop_reason"] == "end_turn"
    assert message_delta["usage"] == {"input_tokens": 4, "output_tokens": 2}


@pytest.mark.asyncio
async def test_count_tokens_returns_estimate(client):
    resp = await client.post(
        "/shim/vllm/v1/messages/count_tokens",
        json={"model": "m", "messages": [{"role": "user", "content": "hello world"}]},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["input_tokens"] >= 1
