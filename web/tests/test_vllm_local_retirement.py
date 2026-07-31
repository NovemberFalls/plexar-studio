"""Retiring `vllm-local` — the direct-to-vLLM provider.

Plexar owns vLLM lifecycle now and publishes its containers loopback-only on a
port it allocates itself, reachable ONLY through its gateway. So for a
Plexar-managed engine the direct path is not merely unused — it is
structurally impossible to recreate, and `vllm-local` is a provider row that
can only ever be red.

`vllm-local` and `plexar` were never two views of one engine (which would
argue for deduping them): one is the current architecture, the other is what it
replaced. Hence retire, not merge.

The retirement is DEREGISTRATION, not deletion. Everything behind it — the
managed container, the restart path, the Prometheus adapter — still works, and
anyone actually running a direct vLLM keeps it by saying so. These tests pin
both halves: it goes away by default, and it comes back on demand.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server  # noqa: E402


@pytest.fixture()
def registry(monkeypatch):
    """Drive the retirement, then put the registry back as it was.

    conftest re-registers `vllm-local` for the whole suite, so these tests must
    restore that state or they would silently disarm every direct-vLLM module
    that runs after them.
    """
    snapshot = dict(server._PROVIDERS)
    yield server._PROVIDERS
    server._PROVIDERS.clear()
    server._PROVIDERS.update(snapshot)


def _run(monkeypatch, *, direct="", intent=False):
    monkeypatch.setattr(server, "COCKPIT_VLLM_DIRECT", direct)
    monkeypatch.setattr(server, "_vllm_managed_intent", lambda live=False: intent)
    server._retire_vllm_local_if_unused()


def test_it_is_gone_by_default(monkeypatch, registry):
    _run(monkeypatch)
    assert "vllm-local" not in registry, (
        "a permanently unreachable provider row teaches people to ignore red rows"
    )


def test_plexar_is_untouched(monkeypatch, registry):
    """The retirement must not take the replacement with it."""
    _run(monkeypatch)
    assert "plexar" in registry
    assert "lmstudio-local" in registry, "the lane-broker path is unrelated"


def test_an_explicitly_declared_direct_vllm_keeps_it(monkeypatch, registry):
    _run(monkeypatch, direct="1")
    assert "vllm-local" in registry
    assert registry["vllm-local"]["capabilities"], "and keeps its capabilities"


def test_managed_intent_keeps_it_because_cockpit_launches_that_container(
    monkeypatch, registry
):
    """Cockpit starting the container itself and then not registering it would
    leave a running engine with no provider to reach it through."""
    _run(monkeypatch, intent=True)
    assert "vllm-local" in registry


def test_retirement_is_idempotent_and_reversible(monkeypatch, registry):
    _run(monkeypatch)
    _run(monkeypatch)
    assert "vllm-local" not in registry

    server._register_vllm_local()
    server._register_vllm_local()
    assert registry["vllm-local"] is server._VLLM_LOCAL_PROVIDER, (
        "deregistering must not destroy the definition — the machinery behind "
        "it is still supported"
    )


def test_the_definition_survives_deregistration(monkeypatch, registry):
    _run(monkeypatch)
    assert server._VLLM_LOCAL_PROVIDER["broker_url"], (
        "popping the entry out of the registry is not deleting the provider"
    )


def test_capability_refresh_tolerates_the_entry_being_absent(monkeypatch, registry):
    """_refresh_vllm_model_control runs at import and after the start attempt."""
    _run(monkeypatch)
    server._refresh_vllm_model_control()  # must not raise
