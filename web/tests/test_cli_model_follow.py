"""A /model switch made inside the CLI becomes the session's model.

Owner, 2026-11-23: "when I change a model ... the CLI window doesnt update to the
right model. It holds the model it spawned with."
"""

import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from jsonl_watcher import latest_assistant_model  # noqa: E402
from pty_manager import PtyManager  # noqa: E402

SPAWNED = "2026-11-23T10:00:00.000000+00:00"


def _assistant(model, ts, **extra):
    return json.dumps({"type": "assistant", "timestamp": ts, "message": {"model": model}, **extra})


def _write(tmp_path, *lines):
    p = tmp_path / "t.jsonl"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(p)


class TestLatestAssistantModel:
    def test_last_turn_wins(self, tmp_path):
        p = _write(
            tmp_path,
            _assistant("claude-sonnet-5-5", "2026-11-23T10:01:00.000Z"),
            json.dumps({"type": "user", "timestamp": "2026-11-23T10:02:00.000Z"}),
            _assistant("claude-opus-5-5", "2026-11-23T10:03:00.000Z"),
        )
        assert latest_assistant_model(p) == "claude-opus-5-5"

    def test_synthetic_and_sidechain_turns_are_skipped(self, tmp_path):
        p = _write(
            tmp_path,
            _assistant("claude-opus-5-5", "2026-11-23T10:01:00.000Z"),
            _assistant("claude-haiku-5-5", "2026-11-23T10:02:00.000Z", isSidechain=True),
            _assistant("<synthetic>", "2026-11-23T10:03:00.000Z"),
        )
        assert latest_assistant_model(p) == "claude-opus-5-5"

    def test_turns_from_before_the_spawn_do_not_count(self, tmp_path):
        p = _write(tmp_path, _assistant("claude-sonnet-5-5", "2026-11-23T09:59:00.000Z"))
        assert latest_assistant_model(p, after=SPAWNED) is None
        assert latest_assistant_model(p) == "claude-sonnet-5-5"

    def test_missing_file_and_no_assistant_turn(self, tmp_path):
        assert latest_assistant_model(str(tmp_path / "nope.jsonl")) is None
        assert latest_assistant_model(_write(tmp_path, json.dumps({"type": "user"}))) is None


def _manager(path):
    m = PtyManager.__new__(PtyManager)
    m._get_jsonl_path = lambda session: path
    return m


def _session(model, provider="anthropic", harness="claude-code"):
    return SimpleNamespace(id="t1", model=model, live_model=None, provider=provider,
                           harness=harness, created_at=SPAWNED)


class TestRefreshCliModel:
    def test_a_switch_is_adopted(self, tmp_path):
        p = _write(tmp_path, _assistant("claude-opus-5-5", "2026-11-23T10:05:00.000Z"))
        s = _session("claude-sonnet-5-5")
        assert _manager(p)._refresh_cli_model(s) == "claude-opus-5-5"
        assert (s.model, s.live_model) == ("claude-opus-5-5", "claude-opus-5-5")
        assert _manager(p)._refresh_cli_model(s) is None  # unchanged: no second adoption

    def test_an_alias_or_suffix_for_the_same_model_is_kept(self, tmp_path):
        p = _write(tmp_path, _assistant("claude-opus-5-5", "2026-11-23T10:05:00.000Z"))
        for spawned in ("opus", "claude-opus-5-5[1m]"):
            s = _session(spawned)
            assert _manager(p)._refresh_cli_model(s) is None
            assert (s.model, s.live_model) == (spawned, None)

    def test_an_alias_for_a_different_model_is_replaced(self, tmp_path):
        p = _write(tmp_path, _assistant("claude-opus-5-5", "2026-11-23T10:05:00.000Z"))
        s = _session("sonnet")
        assert _manager(p)._refresh_cli_model(s) == "claude-opus-5-5"

    def test_other_providers_and_harnesses_are_left_alone(self, tmp_path):
        p = _write(tmp_path, _assistant("claude-opus-5-5", "2026-11-23T10:05:00.000Z"))
        for s in (_session("qwen3", provider="local"), _session("x/y", provider="openrouter"),
                  _session("gpt-5.5", harness="codex")):
            before = s.model
            assert _manager(p)._refresh_cli_model(s) is None
            assert (s.model, s.live_model) == (before, None)

    def test_a_resumed_transcripts_old_turns_are_not_a_switch(self, tmp_path):
        p = _write(tmp_path, _assistant("claude-sonnet-5-5", "2026-11-23T09:00:00.000Z"))
        s = _session("claude-opus-5-5")
        assert _manager(p)._refresh_cli_model(s) is None
        assert s.model == "claude-opus-5-5"
