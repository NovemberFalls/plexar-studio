"""Tests for UsageTracker.model_report() and GET /api/reporting/models --
the merge point between the Anthropic/OpenRouter usage_events pipeline and
the local_runs pipeline, with per-repo attribution."""

from __future__ import annotations

import json
import os
import sys

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

from usage_tracker import UsageTracker, _row_cost

import server as server_module
from server import app


@pytest.fixture()
def tracker(tmp_path):
    db_path = tmp_path / "usage.sqlite3"
    t = UsageTracker(db_path=db_path)
    yield t
    t.close()


def _assistant_line(uuid, model="claude-opus-4", input_tokens=100, output_tokens=50,
                     cache_creation=0, cache_read=0, ts="2026-07-19T10:00:00Z"):
    return json.dumps({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
        "message": {
            "model": model,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_creation_input_tokens": cache_creation,
                "cache_read_input_tokens": cache_read,
            },
        },
    })


def test_model_report_merges_anthropic_and_local(tracker, tmp_path):
    jsonl_path = tmp_path / "s1.jsonl"
    lines = [
        _assistant_line("u1", model="claude-opus-4", input_tokens=1000, output_tokens=500),
        _assistant_line("u2", model="claude-sonnet-5", input_tokens=200, output_tokens=100),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-1", str(jsonl_path), workdir=r"C:\Code\claude-cockpit")
    tracker.ingest_jsonl("term-2", str(jsonl_path), workdir="/home/x/other-repo")

    # local runs: two distinct local models on one provider
    tracker.record_local_run(
        terminal_id="term-3", provider_id="vllm-local", model="qwen3-coder-30b",
        input_tokens=500, output_tokens=300, wall_ms=1200.0, workdir=r"C:\Code\claude-cockpit",
    )
    tracker.record_local_run(
        terminal_id="term-4", provider_id="vllm-local", model="qwen3-30b-instruct",
        input_tokens=50, output_tokens=20, wall_ms=800.0, workdir="/home/x/bar",
    )

    report = tracker.model_report("lifetime")
    assert report["window"] == "lifetime"
    by_model = {(m["provider"], m["model"]): m for m in report["models"]}

    opus = by_model[("anthropic", "claude-opus-4")]
    assert opus["family"] == "Opus"
    assert opus["runs"] == 1
    assert opus["tokens"] == 1500
    assert opus["cost_usd"] == pytest.approx(round(_row_cost("claude-opus-4", 1000, 500, 0, 0), 4))

    sonnet = by_model[("anthropic", "claude-sonnet-5")]
    assert sonnet["family"] == "Sonnet"

    qwen_coder = by_model[("local", "qwen3-coder-30b")]
    assert qwen_coder["provider_id"] == "vllm-local"
    assert qwen_coder["family"] == "qwen3-coder-30b"
    assert qwen_coder["tokens"] == 800
    assert qwen_coder["cost_usd"] is None

    qwen_instruct = by_model[("local", "qwen3-30b-instruct")]
    assert qwen_instruct["family"] == "qwen3-30b-instruct"
    assert qwen_instruct is not qwen_coder

    # per-repo attribution: basename of workdir, Windows and POSIX both handled
    opus_repos = {r["repo"]: r for r in opus["by_repo"]}
    assert "claude-cockpit" in opus_repos
    coder_repos = {r["repo"]: r for r in qwen_coder["by_repo"]}
    assert "claude-cockpit" in coder_repos
    instruct_repos = {r["repo"]: r for r in qwen_instruct["by_repo"]}
    assert "bar" in instruct_repos

    assert report["totals"]["runs"] == 4
    assert report["totals"]["tokens"] == opus["tokens"] + sonnet["tokens"] + qwen_coder["tokens"] + qwen_instruct["tokens"]
    assert report["totals"]["cost_usd"] == pytest.approx(opus["cost_usd"] + sonnet["cost_usd"])


def test_model_report_openrouter_classification(tracker, tmp_path):
    jsonl_path = tmp_path / "s2.jsonl"
    jsonl_path.write_text(
        _assistant_line("u1", model="deepseek/deepseek-v4-pro", input_tokens=10, output_tokens=5) + "\n",
        encoding="utf-8",
    )
    tracker.ingest_jsonl("term-1", str(jsonl_path))

    report = tracker.model_report("lifetime")
    assert len(report["models"]) == 1
    m = report["models"][0]
    assert m["provider"] == "openrouter"
    assert m["model"] == "deepseek/deepseek-v4-pro"


def test_model_report_local_null_tokens_not_zero(tracker):
    tracker.record_local_run(
        terminal_id="term-1", provider_id="lmstudio-local", model="some-model",
        input_tokens=None, output_tokens=None, wall_ms=100.0, workdir=None,
    )
    tracker.record_local_run(
        terminal_id="term-2", provider_id="lmstudio-local", model="some-model",
        input_tokens=0, output_tokens=0, wall_ms=100.0, workdir=None,
    )

    report = tracker.model_report("lifetime")
    assert len(report["models"]) == 1
    m = report["models"][0]
    assert m["runs"] == 2
    assert m["tokens"] is None
    assert m["input_tokens"] is None
    assert m["output_tokens"] is None
    assert m["cost_usd"] is None
    # null/empty workdir -> "unknown"
    assert m["by_repo"] == [{"repo": "unknown", "runs": 2, "tokens": 0}]
    assert report["totals"]["tokens"] is None


def test_model_report_sort_order_tokens_first_nulls_last(tracker, tmp_path):
    jsonl_path = tmp_path / "s3.jsonl"
    lines = [
        _assistant_line("u1", model="claude-opus-4", input_tokens=100, output_tokens=50),
        _assistant_line("u2", model="claude-sonnet-5", input_tokens=10000, output_tokens=5000),
    ]
    jsonl_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    tracker.ingest_jsonl("term-1", str(jsonl_path))
    tracker.record_local_run(
        terminal_id="term-2", provider_id="vllm-local", model="untracked-model",
        input_tokens=None, output_tokens=None, wall_ms=100.0,
    )

    report = tracker.model_report("lifetime")
    models = report["models"]
    assert models[0]["model"] == "claude-sonnet-5"
    assert models[1]["model"] == "claude-opus-4"
    assert models[-1]["tokens"] is None


def test_model_report_invalid_window_raises(tracker):
    with pytest.raises(ValueError):
        tracker.model_report("bogus-window")


def test_model_report_empty_store(tracker):
    report = tracker.model_report("lifetime")
    assert report["models"] == []
    assert report["totals"] == {"runs": 0, "tokens": None, "cost_usd": None}


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.mark.asyncio
async def test_reporting_models_route_shape(client, monkeypatch):
    payload = {
        "window": "lifetime",
        "models": [
            {"model": "claude-opus-4", "provider": "anthropic", "provider_id": None,
             "family": "Opus", "runs": 1, "input_tokens": 100, "output_tokens": 50,
             "tokens": 150, "cost_usd": 0.01, "by_repo": []},
        ],
        "totals": {"runs": 1, "tokens": 150, "cost_usd": 0.01},
    }

    def fake_model_report(window):
        assert window == "lifetime"
        return payload

    monkeypatch.setattr(server_module.usage_tracker, "model_report", fake_model_report)
    res = await client.get("/api/reporting/models")
    assert res.status_code == 200
    assert res.json() == payload


@pytest.mark.asyncio
async def test_reporting_models_route_invalid_window_400(client):
    res = await client.get("/api/reporting/models?window=bogus")
    assert res.status_code == 400
