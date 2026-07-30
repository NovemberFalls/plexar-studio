"""Tests for the Anthropic subscription usage-limits reader.

The load-bearing property here is honesty: this surface must report real,
server-provided utilization or explicitly report that it has none. It must
never emit a fabricated percentage, and it must never refresh the CLI's OAuth
token (doing so rotates the refresh token and logs the user out of their own
terminal).
"""

from __future__ import annotations

import json
import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import anthropic_usage  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_cache():
    anthropic_usage.reset_cache()
    yield
    anthropic_usage.reset_cache()


@pytest.fixture()
def creds(tmp_path, monkeypatch):
    """Write a credentials file and point the module at it."""
    path = tmp_path / ".credentials.json"
    path.write_text(
        json.dumps({"claudeAiOauth": {"accessToken": "sk-ant-oat01-TESTTOKEN"}}),
        encoding="utf-8",
    )
    monkeypatch.setenv(anthropic_usage._CREDENTIALS_ENV, str(path))
    return path


def _mock_transport(monkeypatch, handler):
    """Route the module's httpx client through *handler*."""
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(anthropic_usage.httpx, "AsyncClient", factory)


_LIVE_SHAPE = {
    "five_hour": {"utilization": 3.0, "resets_at": "2026-07-30T23:49:59+00:00"},
    "limits": [
        {"kind": "session", "group": "session", "percent": 3,
         "severity": "normal", "resets_at": "2026-07-30T23:49:59+00:00",
         "is_active": True},
        {"kind": "weekly_all", "group": "weekly", "percent": 0,
         "severity": "normal", "resets_at": "2026-08-04T01:59:59+00:00",
         "is_active": False},
    ],
    "extra_usage": {"is_enabled": False},
}


# ---------------------------------------------------------------------------
# Credential reading
# ---------------------------------------------------------------------------

def test_missing_credentials_file_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv(anthropic_usage._CREDENTIALS_ENV, str(tmp_path / "nope.json"))
    assert anthropic_usage.read_access_token() is None


def test_malformed_credentials_file_returns_none(tmp_path, monkeypatch):
    path = tmp_path / "bad.json"
    path.write_text("{not json", encoding="utf-8")
    monkeypatch.setenv(anthropic_usage._CREDENTIALS_ENV, str(path))
    assert anthropic_usage.read_access_token() is None


def test_api_key_only_credentials_have_no_oauth_token(tmp_path, monkeypatch):
    """A file with only MCP OAuth entries must not yield a Claude token."""
    path = tmp_path / "c.json"
    path.write_text(json.dumps({"mcpOAuth": {"x": {"accessToken": "bvo_zzz"}}}), encoding="utf-8")
    monkeypatch.setenv(anthropic_usage._CREDENTIALS_ENV, str(path))
    assert anthropic_usage.read_access_token() is None


@pytest.mark.asyncio
async def test_no_credentials_reports_reason_not_zero(tmp_path, monkeypatch):
    """The critical honesty case: no login must NOT render as 0% used."""
    monkeypatch.setenv(anthropic_usage._CREDENTIALS_ENV, str(tmp_path / "nope.json"))
    result = await anthropic_usage.fetch_usage()
    assert result["available"] is False
    assert result["reason"] == "no_credentials"
    assert result["limits"] == []


# ---------------------------------------------------------------------------
# Fetch + normalization
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_fetch_normalizes_live_shape(creds, monkeypatch):
    def handler(request):
        assert request.headers["Authorization"] == "Bearer sk-ant-oat01-TESTTOKEN"
        assert request.headers["anthropic-beta"] == anthropic_usage._OAUTH_BETA
        return httpx.Response(200, json=_LIVE_SHAPE)

    _mock_transport(monkeypatch, handler)
    result = await anthropic_usage.fetch_usage()

    assert result["available"] is True
    kinds = [limit["kind"] for limit in result["limits"]]
    assert kinds == ["session", "weekly_all"], "session must sort before weekly"
    session = result["limits"][0]
    assert session["percent"] == 3.0
    assert session["label"] == "Current session"
    assert session["resets_at"] == "2026-07-30T23:49:59+00:00"


@pytest.mark.asyncio
async def test_null_percent_is_dropped_not_coerced_to_zero(creds, monkeypatch):
    """'Not reported' and 'zero used' are different claims.

    Rendering a null as an empty 0% bar would assert something the API never
    told us.
    """
    payload = {"limits": [
        {"kind": "session", "group": "session", "percent": None, "is_active": True},
        {"kind": "weekly_all", "group": "weekly", "percent": 0, "is_active": True},
    ]}
    _mock_transport(monkeypatch, lambda r: httpx.Response(200, json=payload))
    result = await anthropic_usage.fetch_usage()

    kinds = [limit["kind"] for limit in result["limits"]]
    assert kinds == ["weekly_all"], "null-percent limit must be omitted entirely"
    assert result["limits"][0]["percent"] == 0.0, "a real 0 is kept"


@pytest.mark.asyncio
async def test_unknown_limit_kind_is_passed_through(creds, monkeypatch):
    """A new upstream limit class must appear, not silently vanish."""
    payload = {"limits": [
        {"kind": "weekly_newmodel", "group": "weekly", "percent": 12, "is_active": True},
    ]}
    _mock_transport(monkeypatch, lambda r: httpx.Response(200, json=payload))
    result = await anthropic_usage.fetch_usage()

    assert len(result["limits"]) == 1
    assert result["limits"][0]["label"] == "Current week (Newmodel)"


@pytest.mark.asyncio
async def test_disabled_extra_usage_is_none(creds, monkeypatch):
    _mock_transport(monkeypatch, lambda r: httpx.Response(200, json=_LIVE_SHAPE))
    result = await anthropic_usage.fetch_usage()
    assert result["extra_usage"] is None


# ---------------------------------------------------------------------------
# Failure modes
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_401_reports_expired_and_does_not_refresh(creds, monkeypatch):
    """A 401 must NOT trigger a token refresh.

    The refresh token belongs to the CLI; rotating it would invalidate the
    copy the CLI holds and log the user out of their own terminal.
    """
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(401, json={"error": "unauthorized"})

    _mock_transport(monkeypatch, handler)
    result = await anthropic_usage.fetch_usage()

    assert result["available"] is False
    assert result["reason"] == "expired"
    assert calls == [anthropic_usage._USAGE_URL], "must not call any refresh endpoint"


@pytest.mark.asyncio
async def test_network_error_reports_unreachable(creds, monkeypatch):
    def handler(request):
        raise httpx.ConnectError("boom")

    _mock_transport(monkeypatch, handler)
    result = await anthropic_usage.fetch_usage()
    assert result["available"] is False
    assert result["reason"] == "unreachable"


@pytest.mark.asyncio
async def test_non_usage_shaped_200_is_rejected(creds, monkeypatch):
    """A 200 carrying the wrong body must not be trusted.

    Mirrors the service-identity stance used for the local broker.
    """
    _mock_transport(monkeypatch, lambda r: httpx.Response(200, json={"hello": "world"}))
    result = await anthropic_usage.fetch_usage()
    assert result["available"] is False
    assert result["reason"] == "bad_response"


# ---------------------------------------------------------------------------
# Caching
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_successful_result_is_cached(creds, monkeypatch):
    calls = []

    def handler(request):
        calls.append(1)
        return httpx.Response(200, json=_LIVE_SHAPE)

    _mock_transport(monkeypatch, handler)
    await anthropic_usage.fetch_usage()
    await anthropic_usage.fetch_usage()
    assert len(calls) == 1, "second call within TTL must be served from cache"

    await anthropic_usage.fetch_usage(force=True)
    assert len(calls) == 2, "force=True must bypass the cache"


@pytest.mark.asyncio
async def test_failures_are_not_cached(creds, monkeypatch):
    """A transient failure must not pin the panel to 'unavailable' for a minute."""
    calls = []

    def handler(request):
        calls.append(1)
        raise httpx.ConnectError("down")

    _mock_transport(monkeypatch, handler)
    await anthropic_usage.fetch_usage()
    await anthropic_usage.fetch_usage()
    assert len(calls) == 2
