"""Codex must be told the window the engine actually has.

THE DEFECT, MEASURED END TO END 2026-09-22.

Codex carries its own per-model metadata table. A served name like
"qwen3.8-27b" is not in it, so it warns --

    Model metadata for `qwen3.8-27b` not found. Defaulting to fallback
    metadata; this can degrade performance and cause issues.

-- substitutes a generic window, and RECORDS THAT NUMBER in its rollout as
`info.model_context_window`. Studio reads exactly that field (codex_usage.py)
to draw the pane's context ring. So a user saw:

    28%   72.6K / 258.4K

against an engine whose real `max_model_len` is 131072. Roughly TWICE the true
capacity, on turn one. The ring showed headroom that does not exist; past the
real limit vLLM starts refusing and it reads as "Codex broke" rather than
"context exhausted".

THE ROOT CAUSE WAS OURS, not Codex's. Plexar publishes `max_model_len` in its
`/v1/models` payload and `_normalize_plexar_raw_model` DROPPED IT -- the vLLM
sibling normalizer had always mapped it, this one never did. So the window was
available the whole time and never reached anything. Three consumers were
silently degraded by that one missing mapping:

  * Codex had no window to be told (this file),
  * `resolve_local_output_reservation` returned None, so the claude harness fell
    back to its flat 8000 instead of the derived quarter-window,
  * any local context ring had nothing to render.

VERIFIED AGAINST THE REAL CLI, not inferred from the flag being accepted --
reading back what codex-cli 0.153.4 wrote into its own rollout:

    no flag                        -> model_context_window = 258400   (the bug)
    -c model_context_window=100    -> model_context_window = 95
    -c model_context_window=131072 -> model_context_window = 124518

(Codex subtracts its output reservation, which is correct for a ring measuring
usable input.) That third line is the fix: Studio's ring now reads against the
truth.

ALSO MEASURED, AND THE REASON THIS FILE MAKES NO ENFORCEMENT CLAIM: the flag is
a metadata declaration, NOT a limit. With `model_context_window=100` codex still
sent 70,973 input tokens and completed. So this change corrects what is
DISPLAYED and RECORDED; it does not make codex refuse or compact, and nothing
here should be read as promising that.
"""

from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import context_window  # noqa: E402
import pty_manager  # noqa: E402
import server as server_module  # noqa: E402
from pty_manager import PtyManager  # noqa: E402

PID = "plexar-vllm"
MODEL = "qwen3.8-27b"
REAL_WINDOW = 131072


@pytest.fixture(autouse=True)
def clean_windows():
    context_window.clear_local_model_windows()
    yield
    context_window.clear_local_model_windows()


def _publish(window=REAL_WINDOW, provider=PID, model=MODEL):
    """Exactly what GET /api/local/{id}/models feeds the resolver."""
    context_window.set_local_model_windows(
        provider, [{"id": model, "max_context_length": window,
                    "loaded_context_length": window}])


# ── the mapping that was missing ──────────────────────────

def test_plexar_normalizer_carries_max_model_len():
    """The one-line gap that starved all three consumers."""
    out = server_module._normalize_plexar_raw_model(
        {"id": MODEL, "max_model_len": REAL_WINDOW,
         "plexar": {"state": "serving", "available": True}})
    assert out["max_context_length"] == REAL_WINDOW
    assert out["loaded_context_length"] == REAL_WINDOW


def test_normalizer_never_overwrites_a_genuine_value():
    """Same rule the vLLM sibling follows: max_model_len is a fallback, not an
    override. An engine that reports a real loaded window is authoritative."""
    out = server_module._normalize_plexar_raw_model(
        {"id": MODEL, "max_model_len": REAL_WINDOW,
         "max_context_length": 40000, "loaded_context_length": 12288,
         "plexar": {"state": "serving"}})
    assert out["max_context_length"] == 40000
    assert out["loaded_context_length"] == 12288


def test_a_catalog_with_no_window_stays_null():
    """Absent must stay absent -- the caller emits no flag rather than a guess.

    `.get` rather than `[...]`: the normalizer returns a PARTIAL dict and the
    route fills the rest of _MODEL_FIELDS with None afterwards. Both spellings
    of absence mean the same thing to every consumer, and asserting the key
    exists would be pinning an implementation detail of a different function.
    """
    out = server_module._normalize_plexar_raw_model(
        {"id": MODEL, "plexar": {"state": "serving"}})
    assert out.get("max_context_length") is None
    assert out.get("loaded_context_length") is None


# ── the resolver ──────────────────────────────────────────

def test_resolver_returns_the_published_window():
    _publish()
    assert server_module.resolve_local_context_window(PID, MODEL) == REAL_WINDOW


def test_resolver_returns_None_when_nothing_was_published():
    assert server_module.resolve_local_context_window(PID, MODEL) is None


def test_the_claude_path_reservation_now_derives_instead_of_falling_back():
    """The second consumer this mapping was starving. A quarter of 131072 is
    32768, capped at 8000 -- but before the fix the window was None and the
    caller used its flat 8000 fallback, which only LOOKED the same. Prove the
    derivation is live by using a window where the two answers differ."""
    _publish(window=12288)
    assert server_module.resolve_local_output_reservation(PID, MODEL) == 3072


# ── the spawned command ───────────────────────────────────

def _spawn(**kw):
    captured = {}
    backend = MagicMock()
    backend.__name__ = "MockBackend"
    proc = MagicMock()
    proc.isalive.return_value = True
    proc.pid = 4242

    def rec(cmd, **kwargs):
        captured["cmd"] = cmd
        return proc

    backend.spawn.side_effect = rec
    with patch("pty_backend.get_backend", return_value=backend), \
         patch.object(pty_manager, "resolve_codex_cli", side_effect=lambda p: ("codex", p)), \
         patch.object(pty_manager, "resolve_claude_cli", side_effect=lambda p: ("claude", p)), \
         patch.object(server_module, "provider_speaks_responses", lambda pid: True):
        PtyManager().create_terminal(name="t", workdir="C:\\Code", **kw)
    return captured["cmd"]


def test_codex_is_told_the_real_window():
    _publish()
    cmd = _spawn(harness="codex", provider="local", provider_model=f"{PID}::{MODEL}")
    assert f"-c model_context_window={REAL_WINDOW}" in cmd
    assert "-c model_max_output_tokens=8000" in cmd


def test_NO_flag_when_the_engine_published_no_window():
    """A guess would be WORSE than codex's own fallback, because ours arrives
    looking authoritative. Absent data means absent flag."""
    cmd = _spawn(harness="codex", provider="local", provider_model=f"{PID}::{MODEL}")
    assert "model_context_window" not in cmd
    assert "model_max_output_tokens" not in cmd
    # ...and the session still spawns, on the provider config that does not
    # depend on the window.
    assert "wire_api=responses" in cmd


def test_the_window_follows_the_engine_not_a_constant():
    """A hardcoded 131072 would pass the first test forever."""
    _publish(window=49152)
    cmd = _spawn(harness="codex", provider="local", provider_model=f"{PID}::{MODEL}")
    assert "-c model_context_window=49152" in cmd
    assert "-c model_max_output_tokens=8000" in cmd  # 49152//4 = 12288, capped


def test_a_small_window_shrinks_the_output_reservation_too():
    """prompt + output must not exceed the window and earn a refusal."""
    _publish(window=12288)
    cmd = _spawn(harness="codex", provider="local", provider_model=f"{PID}::{MODEL}")
    assert "-c model_context_window=12288" in cmd
    assert "-c model_max_output_tokens=3072" in cmd


def test_codex_on_a_NON_local_provider_gets_no_window_flag():
    """These flags describe a local engine. A codex session on its own backend
    has real published metadata and must not be overridden by ours."""
    _publish()
    cmd = _spawn(harness="codex", model="gpt-5.6-terra")
    assert "model_context_window" not in cmd


def test_the_claude_harness_command_is_untouched():
    """The claude CLI takes the window through env, not argv. A stray -c here
    would be passed to `claude` as an unknown flag."""
    _publish()
    cmd = _spawn(harness="claude-code", provider="local",
                 provider_model=f"{PID}::{MODEL}")
    assert "model_context_window" not in cmd
    assert "-c " not in cmd
