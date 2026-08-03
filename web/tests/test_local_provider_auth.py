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
