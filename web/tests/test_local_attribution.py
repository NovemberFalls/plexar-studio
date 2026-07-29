"""Tests for session-scoped local-model attribution:

  - server.resolve_local_base_url(provider_id, terminal_id=...) — session-
    scoped /s/{terminal_id} URLs for both lmstudio-local and vllm-local, with
    and without terminal_id, and a bad terminal_id falling back un-scoped.
  - web/vllm_shim.py reachable at both /shim/vllm/v1/messages and
    /shim/vllm/s/{id}/v1/messages.
  - web/lmstudio_proxy.py: forwards byte-verbatim to the broker, ADDS
    X-Lane-Class/X-Client-Id/X-Agent-Id headers (absent when no session id),
    and streaming passthrough works.
  - usage_tracker.UsageTracker.record_local_run(): inserts a row, unknown
    usage stores null tokens, and a failure never raises into the caller.
  - Schema migration: a DB created without local_runs/usage_events.workdir
    gets them added on init, with existing rows surviving untouched.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys

import httpx
import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app
import lmstudio_proxy
from usage_tracker import UsageTracker


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


# ---------------------------------------------------------------------------
# resolve_local_base_url
# ---------------------------------------------------------------------------


class TestResolveLocalBaseUrl:
    def test_lmstudio_unscoped(self, monkeypatch):
        monkeypatch.setenv("PORT", "8420")
        url = server_module.resolve_local_base_url("lmstudio-local")
        assert url == "http://127.0.0.1:8420/shim/lmstudio"

    def test_lmstudio_scoped(self, monkeypatch):
        monkeypatch.setenv("PORT", "8420")
        url = server_module.resolve_local_base_url("lmstudio-local", "term123")
        assert url == "http://127.0.0.1:8420/shim/lmstudio/s/term123"

    def test_vllm_unscoped(self, monkeypatch):
        monkeypatch.setenv("PORT", "8420")
        url = server_module.resolve_local_base_url("vllm-local")
        assert url == "http://127.0.0.1:8420/shim/vllm"

    def test_vllm_scoped(self, monkeypatch):
        monkeypatch.setenv("PORT", "8420")
        url = server_module.resolve_local_base_url("vllm-local", "term123")
        assert url == "http://127.0.0.1:8420/shim/vllm/s/term123"

    def test_bad_terminal_id_falls_back_unscoped(self, monkeypatch):
        monkeypatch.setenv("PORT", "8420")
        for bad in ["../etc/passwd", "has spaces", "has/slash", "x" * 65, ""]:
            url = server_module.resolve_local_base_url("lmstudio-local", bad)
            assert url == "http://127.0.0.1:8420/shim/lmstudio", bad

    def test_unknown_provider_returns_none(self):
        assert server_module.resolve_local_base_url("nonexistent-provider", "term1") is None


# ---------------------------------------------------------------------------
# vLLM shim: scoped route form
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_vllm_shim_reachable_at_unscoped_route(client, monkeypatch):
    original_post = httpx.AsyncClient.post

    async def fake_post(self, url, json=None, **kwargs):
        if "/v1/chat/completions" not in str(url):
            return await original_post(self, url, json=json, **kwargs)
        request = httpx.Request("POST", url)
        return httpx.Response(
            200, request=request,
            json={
                "id": "chatcmpl-1",
                "choices": [{"message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1},
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    resp = await client.post(
        "/shim/vllm/v1/messages",
        json={"model": "m", "max_tokens": 10, "stream": False, "messages": [{"role": "user", "content": "hi"}]},
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_vllm_shim_reachable_at_scoped_route(client, monkeypatch):
    original_post = httpx.AsyncClient.post

    async def fake_post(self, url, json=None, **kwargs):
        if "/v1/chat/completions" not in str(url):
            return await original_post(self, url, json=json, **kwargs)
        request = httpx.Request("POST", url)
        return httpx.Response(
            200, request=request,
            json={
                "id": "chatcmpl-1",
                "choices": [{"message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1},
            },
        )

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    resp = await client.post(
        "/shim/vllm/s/term123/v1/messages",
        json={"model": "m", "max_tokens": 10, "stream": False, "messages": [{"role": "user", "content": "hi"}]},
    )
    assert resp.status_code == 200


# ---------------------------------------------------------------------------
# LM Studio tagging proxy
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_lmstudio_proxy_forwards_and_tags_headers_with_session(client, monkeypatch):
    incoming_body = {"model": "qwen3-coder-30b", "max_tokens": 50, "messages": [{"role": "user", "content": "hi"}]}
    raw_incoming = json.dumps(incoming_body).encode()

    captured = {}
    original_post = httpx.AsyncClient.post

    async def fake_post(self, url, content=None, headers=None, **kwargs):
        if "127.0.0.1:1235" not in str(url):
            return await original_post(self, url, content=content, headers=headers, **kwargs)
        captured["url"] = str(url)
        captured["content"] = content
        captured["headers"] = headers
        request = httpx.Request("POST", url)
        resp_body = {
            "id": "msg_1", "type": "message", "role": "assistant", "model": "qwen3-coder-30b",
            "content": [{"type": "text", "text": "hello"}], "stop_reason": "end_turn",
            "usage": {"input_tokens": 7, "output_tokens": 3},
        }
        return httpx.Response(200, request=request, content=json.dumps(resp_body).encode(),
                               headers={"content-type": "application/json"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    resp = await client.post(
        "/shim/lmstudio/s/term-abc/v1/messages",
        content=raw_incoming,
        headers={"Content-Type": "application/json"},
    )

    assert resp.status_code == 200
    # Byte-verbatim forwarding: outgoing body equals incoming body exactly.
    assert captured["content"] == raw_incoming
    assert captured["url"].endswith("/v1/messages")
    assert captured["headers"]["X-Lane-Class"] == "interactive"
    assert captured["headers"]["X-Client-Id"] == "term-abc"
    assert captured["headers"]["X-Agent-Id"] == "term-abc"
    # Response body relayed byte-verbatim too.
    assert resp.content == json.dumps({
        "id": "msg_1", "type": "message", "role": "assistant", "model": "qwen3-coder-30b",
        "content": [{"type": "text", "text": "hello"}], "stop_reason": "end_turn",
        "usage": {"input_tokens": 7, "output_tokens": 3},
    }).encode()


@pytest.mark.asyncio
async def test_lmstudio_proxy_no_session_omits_client_and_agent_headers(client, monkeypatch):
    captured = {}
    original_post = httpx.AsyncClient.post

    async def fake_post(self, url, content=None, headers=None, **kwargs):
        if "127.0.0.1:1235" not in str(url):
            return await original_post(self, url, content=content, headers=headers, **kwargs)
        captured["headers"] = headers
        request = httpx.Request("POST", url)
        return httpx.Response(200, request=request, content=b"{}", headers={"content-type": "application/json"})

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)

    resp = await client.post(
        "/shim/lmstudio/v1/messages",
        content=b'{"model":"m","messages":[]}',
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 200
    assert captured["headers"]["X-Lane-Class"] == "interactive"
    assert "X-Client-Id" not in captured["headers"]
    assert "X-Agent-Id" not in captured["headers"]


@pytest.mark.asyncio
async def test_lmstudio_proxy_streaming_passthrough(client, monkeypatch):
    sse_body = (
        b'event: message_start\ndata: {"type":"message_start","message":{"model":"m"}}\n\n'
        b'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n'
        b'event: message_delta\ndata: {"usage":{"input_tokens":2,"output_tokens":1}}\n\n'
    )

    class _FakeStreamResponse:
        async def aiter_bytes(self):
            # Split into a couple of chunks to exercise buffering.
            yield sse_body[:40]
            yield sse_body[40:]

    class _FakeStreamCtx:
        def __init__(self, url):
            self.url = url

        async def __aenter__(self):
            assert "127.0.0.1:1235" in self.url
            return _FakeStreamResponse()

        async def __aexit__(self, *exc):
            return False

    original_stream = httpx.AsyncClient.stream

    def fake_stream(self, method, url, content=None, headers=None, **kwargs):
        if "127.0.0.1:1235" not in str(url):
            return original_stream(self, method, url, content=content, headers=headers, **kwargs)
        assert method == "POST"
        return _FakeStreamCtx(str(url))

    monkeypatch.setattr(httpx.AsyncClient, "stream", fake_stream)

    async with client.stream(
        "POST", "/shim/lmstudio/s/term-x/v1/messages",
        content=b'{"model":"m","stream":true,"messages":[]}',
        headers={"Content-Type": "application/json"},
    ) as resp:
        assert resp.status_code == 200
        body = b"".join([chunk async for chunk in resp.aiter_bytes()])

    assert body == sse_body


# ---------------------------------------------------------------------------
# usage_tracker.record_local_run
# ---------------------------------------------------------------------------


class TestRecordLocalRun:
    def test_inserts_a_row(self, tmp_path):
        t = UsageTracker(db_path=tmp_path / "usage.sqlite3")
        try:
            t.record_local_run(
                terminal_id="term1", provider_id="vllm-local", model="qwen3",
                input_tokens=10, output_tokens=5, wall_ms=123.4, workdir="C:\\repo",
            )
            rows = t._conn.execute("SELECT * FROM local_runs").fetchall()
            assert len(rows) == 1
            row = rows[0]
            assert row["terminal_id"] == "term1"
            assert row["provider_id"] == "vllm-local"
            assert row["model"] == "qwen3"
            assert row["input_tokens"] == 10
            assert row["output_tokens"] == 5
            assert row["workdir"] == "C:\\repo"
        finally:
            t.close()

    def test_unknown_usage_stores_null_tokens(self, tmp_path):
        t = UsageTracker(db_path=tmp_path / "usage.sqlite3")
        try:
            t.record_local_run(
                terminal_id="term1", provider_id="lmstudio-local", model="qwen3",
                input_tokens=None, output_tokens=None, wall_ms=50.0,
            )
            row = t._conn.execute("SELECT * FROM local_runs").fetchone()
            assert row["input_tokens"] is None
            assert row["output_tokens"] is None
        finally:
            t.close()

    def test_failure_does_not_raise(self, tmp_path, monkeypatch):
        t = UsageTracker(db_path=tmp_path / "usage.sqlite3")
        try:
            def boom(*a, **kw):
                raise sqlite3.OperationalError("simulated failure")
            monkeypatch.setattr(t, "_conn", type("FakeConn", (), {"execute": boom, "close": lambda self: None})())
            # Must not raise.
            t.record_local_run(
                terminal_id="term1", provider_id="vllm-local", model="qwen3",
                input_tokens=1, output_tokens=1, wall_ms=1.0,
            )
        finally:
            t.close()


# ---------------------------------------------------------------------------
# Schema migration
# ---------------------------------------------------------------------------


class TestSchemaMigration:
    def test_local_runs_table_and_workdir_column_added_to_existing_db(self, tmp_path):
        db_path = tmp_path / "legacy.sqlite3"
        # Simulate a pre-migration DB: usage_events without `workdir`, no local_runs table.
        conn = sqlite3.connect(str(db_path))
        conn.executescript(
            """
            CREATE TABLE usage_events (
              id INTEGER PRIMARY KEY,
              terminal_id TEXT NOT NULL,
              jsonl_path TEXT NOT NULL,
              message_uuid TEXT NOT NULL,
              ts TEXT NOT NULL,
              model TEXT NOT NULL,
              input_tokens INTEGER NOT NULL DEFAULT 0,
              output_tokens INTEGER NOT NULL DEFAULT 0,
              cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
              cache_read_tokens INTEGER NOT NULL DEFAULT 0,
              UNIQUE(jsonl_path, message_uuid)
            );
            """
        )
        conn.execute(
            "INSERT INTO usage_events (terminal_id, jsonl_path, message_uuid, ts, model, input_tokens, output_tokens) "
            "VALUES ('t1', '/tmp/a.jsonl', 'uuid-1', '2026-01-01T00:00:00Z', 'claude-opus', 100, 50)"
        )
        conn.commit()
        conn.close()

        t = UsageTracker(db_path=db_path)
        try:
            cols = {row[1] for row in t._conn.execute("PRAGMA table_info(usage_events)").fetchall()}
            assert "workdir" in cols

            tables = {row[0] for row in t._conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
            assert "local_runs" in tables

            # Existing row survived untouched.
            row = t._conn.execute("SELECT * FROM usage_events WHERE message_uuid = 'uuid-1'").fetchone()
            assert row is not None
            assert row["input_tokens"] == 100
            assert row["output_tokens"] == 50
        finally:
            t.close()

    def test_reopening_migrated_db_is_idempotent(self, tmp_path):
        db_path = tmp_path / "usage.sqlite3"
        t1 = UsageTracker(db_path=db_path)
        t1.record_local_run(terminal_id="t1", provider_id="vllm-local", model="m",
                             input_tokens=1, output_tokens=1, wall_ms=1.0)
        t1.close()

        t2 = UsageTracker(db_path=db_path)
        try:
            rows = t2._conn.execute("SELECT * FROM local_runs").fetchall()
            assert len(rows) == 1
        finally:
            t2.close()
