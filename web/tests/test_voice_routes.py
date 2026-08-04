"""Voice REST surface — two always-200 reads.

Voice is an OPTIONAL capability whose ML dependencies are deliberately not
bundled. "Not installed" is therefore a NORMAL state to report, not an HTTP
error: a 503 would blank an inline panel instead of explaining itself.

The rule these tests exist to protect is that the four `reason` values imply
four DIFFERENT user actions, and the route must not flatten them.
"""

from __future__ import annotations

import os
import sys

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server as server_module  # noqa: E402
from server import app  # noqa: E402


@pytest.fixture()
def client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://127.0.0.1:8420")


@pytest.mark.asyncio
async def test_status_is_200_even_when_voice_is_absent(client):
    """The common case on a fresh install — and it must still render."""
    res = await client.get("/api/voice/status")
    assert res.status_code == 200
    body = res.json()
    assert body["available"] is False
    assert body["reason"], "an unavailable voice must say WHY"


@pytest.mark.asyncio
async def test_the_reason_survives_the_route_verbatim(client, monkeypatch):
    """not_installed / model_missing / unsupported / check_failed are four
    different remedies. Flattening them sends people to fix the wrong thing."""
    for reason in ("not_installed", "model_missing", "unsupported", "check_failed"):
        monkeypatch.setattr(
            server_module.voice_service, "availability",
            lambda r=reason: {"available": False, "reason": r, "detail": "d",
                              "components": {}},
        )
        body = (await client.get("/api/voice/status")).json()
        assert body["reason"] == reason


@pytest.mark.asyncio
async def test_an_empty_voice_list_still_carries_its_reason(client):
    """An unexplained empty picker reads as 'this model has no voices', which
    is a different claim from 'the pack is not downloaded'."""
    res = await client.get("/api/voice/voices")
    assert res.status_code == 200
    body = res.json()
    assert body["voices"] == []
    assert body["reason"], "empty without a reason is a lie by omission"


@pytest.mark.asyncio
async def test_voices_pass_through_when_present(client, monkeypatch):
    monkeypatch.setattr(
        server_module.voice_service, "list_voices",
        lambda: {"voices": ["af_heart", "am_michael"], "reason": None,
                 "detail": None, "source": "voicepack"},
    )
    body = (await client.get("/api/voice/voices")).json()
    assert body["voices"] == ["af_heart", "am_michael"]


def test_importing_the_server_does_not_pull_in_ml_dependencies():
    """server.py imports voice_service at module scope, which is only safe
    because every ML import inside it is lazy. torch is installed in this
    environment, so this assertion is meaningful rather than vacuous."""
    assert "torch" not in sys.modules
    assert "faster_whisper" not in sys.modules
    assert "onnxruntime" not in sys.modules


def test_voice_defaults_are_off_and_unguessed():
    """Cross-check the settings contract the UI reads alongside these routes."""
    import settings_store
    v = settings_store.DEFAULT_SETTINGS["voice"]
    assert v["enabled"] is False
    assert v["voice_id"] == ""
    assert v["barge_in"] is True
    assert v["silence_continue_seconds"] == 5.0
