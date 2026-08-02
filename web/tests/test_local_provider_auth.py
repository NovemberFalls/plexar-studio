"""A local provider that AUTHENTICATES, and a window small enough to matter.

Both rules here were written for a world with exactly one shape of local
provider: unauthenticated, with a roomy context window. Plexar is neither.

  * ``ANTHROPIC_AUTH_TOKEN`` was the hard-coded string "local" -- a dummy that
    exists only because the CLI refuses an empty value. Plexar gates ``/v1/*``,
    so that dummy is a 401 and every turn of a session launched on it fails.
  * ``CLAUDE_CODE_MAX_OUTPUT_TOKENS`` was a flat 8000, sized for a 49152-token
    card. Against the 12288-token window Plexar is currently serving, that
    leaves roughly 4k of usable input -- and the harness preamble alone
    measures 29,273 (on a turn that completed), so that window cannot carry a
    turn at all, whatever the reservation.

The distinction these pin hardest: ``None`` from the token resolver means "this
provider needs no credential", NOT "we could not find one". Collapsing the two
would start sending an empty Authorization header to LM Studio and the broker.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import context_window  # noqa: E402
import server as server_module  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_windows():
    context_window.clear_local_model_windows()
    yield
    context_window.clear_local_model_windows()


# ---------------------------------------------------------------------------
# The credential
# ---------------------------------------------------------------------------

def test_an_unauthenticated_provider_reports_none_not_a_blank(monkeypatch):
    """LM Studio and the lane broker have no credential. None here means "none
    needed" -- the caller keeps the dummy rather than sending an empty one."""
    assert server_module.resolve_local_auth_token("lmstudio-local") is None


def test_plexar_supplies_its_bearer(monkeypatch):
    monkeypatch.setattr(
        server_module, "_plexar_config",
        lambda: ("http://127.0.0.1:8760", {"bearer": "plx_live", "type": "bearer"}),
    )
    assert server_module.resolve_local_auth_token("plexar-vllm") == "plx_live"


def test_an_unknown_provider_yields_no_credential():
    """Never invent one for an id the registry does not know."""
    assert server_module.resolve_local_auth_token("nope") is None


# ---------------------------------------------------------------------------
# The output reservation
# ---------------------------------------------------------------------------

def test_the_reservation_is_derived_from_the_published_window():
    context_window.set_local_model_windows(
        "plexar-vllm",
        [{"id": "qwen3-coder-30b-awq", "loaded_context_length": 12288,
          "max_context_length": 12288}],
    )
    got = server_module.resolve_local_output_reservation(
        "plexar-vllm", "qwen3-coder-30b-awq"
    )
    # A quarter of the window: enough for a real reply, and it leaves the
    # majority of a small window for input.
    assert got == 3072


def test_a_roomy_window_still_caps_at_the_old_constant():
    """The cap is the point: an unbounded quarter of a 200k window would hand
    the CLI a 50k output reservation nobody asked for."""
    context_window.set_local_model_windows(
        "plexar-vllm", [{"id": "big", "loaded_context_length": 131072}],
    )
    assert server_module.resolve_local_output_reservation("plexar-vllm", "big") == 8000


def test_an_unknown_window_returns_none_rather_than_a_guess():
    """We do not invent a window in order to divide it. The caller falls back
    to the documented constant, which is a stated default rather than a
    fabricated measurement."""
    assert server_module.resolve_local_output_reservation("plexar-vllm", "never-seen") is None


# ---------------------------------------------------------------------------
# Chat's model routing
# ---------------------------------------------------------------------------

def test_an_anthropic_model_is_passed_through_untouched():
    model, overlay, err = server_module.resolve_chat_model_env("claude-opus-5")
    assert (model, overlay, err) == ("claude-opus-5", None, None)


def test_no_model_is_not_an_error():
    assert server_module.resolve_chat_model_env(None) == (None, None, None)


def test_a_local_pick_is_unwrapped_and_routed(monkeypatch):
    """THE bug: the picker's namespaced id reached the CLI verbatim as
    "local:plexar-vllm:qwen3-coder-30b-awq", which is not a model any endpoint
    knows."""
    monkeypatch.setattr(
        server_module, "_plexar_config",
        lambda: ("http://127.0.0.1:8760", {"bearer": "plx_live", "type": "bearer"}),
    )
    model, overlay, err = server_module.resolve_chat_model_env(
        "local:plexar-vllm:qwen3-coder-30b-awq"
    )
    assert err is None
    assert model == "qwen3-coder-30b-awq"
    assert overlay["ANTHROPIC_MODEL"] == "qwen3-coder-30b-awq"
    assert overlay["ANTHROPIC_AUTH_TOKEN"] == "plx_live"
    # None REMOVES the variable. A present-but-empty value reads to the CLI as
    # "an auth source is set", and it says so.
    assert overlay["ANTHROPIC_API_KEY"] is None
    assert overlay["ANTHROPIC_BASE_URL"]


# ---------------------------------------------------------------------------
# The window a turn cannot fit in
# ---------------------------------------------------------------------------

def test_a_window_too_small_for_the_harness_is_refused_with_the_number():
    """MEASURED on a turn that COMPLETED: 29,273 tokens of harness preamble
    before the user's message, most of it built-in tool schemas. A 32k window
    therefore cannot hold a single turn either -- which is why this case uses
    32768 rather than the 12288 it was first written against. An earlier,
    failure-derived preamble figure would have ADMITTED this model.

    Refusing names the number and the fix. Letting it through produces a
    server error a minute later that reads as the model being broken."""
    context_window.set_local_model_windows(
        "plexar-vllm", [{"id": "small", "loaded_context_length": 32768}],
    )
    model, overlay, err = server_module.resolve_chat_model_env("local:plexar-vllm:small")
    assert model is None and overlay is None
    assert err and "32,768" in err and "max-model-len" in err


def test_a_window_large_enough_is_not_refused():
    context_window.set_local_model_windows(
        "plexar-vllm", [{"id": "roomy", "loaded_context_length": 131072}],
    )
    model, _overlay, err = server_module.resolve_chat_model_env("local:plexar-vllm:roomy")
    assert err is None and model == "roomy"


def test_an_unknown_window_is_not_treated_as_too_small():
    """We have not measured it, so we do not refuse on it. Blocking a model
    because we failed to learn its window would make an absent fact behave
    exactly like a disqualifying one."""
    model, _overlay, err = server_module.resolve_chat_model_env(
        "local:plexar-vllm:window-never-published"
    )
    assert err is None and model == "window-never-published"


def test_a_model_id_containing_a_colon_survives_the_split():
    """Quantization tags carry colons. Splitting on the last one would truncate
    the model name and route to something that does not exist."""
    model, _overlay, err = server_module.resolve_chat_model_env(
        "local:lmstudio-local:qwen3-coder:q4_k_m"
    )
    assert err is None and model == "qwen3-coder:q4_k_m"


def test_an_unroutable_local_provider_is_refused_not_silently_downgraded():
    """Falling back to Anthropic would answer convincingly from a model the
    user did not choose, and attribute it to an engine that never saw it."""
    model, overlay, err = server_module.resolve_chat_model_env("local:ghost:some-model")
    assert model is None and overlay is None
    assert err and "ghost" in err
