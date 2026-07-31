"""Shared fixtures.

Deliberately minimal: no autouse fixtures, no sys.path manipulation (every test
module already inserts the parent dir itself), so adding this file cannot change
the behaviour of any existing test.
"""
from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# logging_config now installs a rotating FILE handler, and most test modules
# call logging_config.setup() at import time. Without this, running the suite
# writes test noise into the user's REAL ~/.claude-cockpit/logs/cockpit.log.
# Set at conftest import (before any test module is imported) rather than as an
# autouse fixture, so it is in force for import-time setup() calls too.
os.environ.setdefault(
    "COCKPIT_LOG_DIR", os.path.join(tempfile.gettempdir(), "cockpit-test-logs"),
)

import server as server_module

# `vllm-local` is DEREGISTERED at import unless a direct vLLM is declared
# (COCKPIT_VLLM_DIRECT=1, or managed intent on) — Plexar owns vLLM now, and a
# provider row pointing at a port nothing listens on is permanently red.
#
# The MACHINERY behind it is untouched and still supported, and the suites that
# cover it (managed lifecycle, model-control, the Prometheus adapter, models-dir)
# are testing real, reachable behaviour. So the entry is put back here for the
# whole suite. The retirement itself is covered directly by
# test_vllm_local_retirement.py, which drives _retire_vllm_local_if_unused and
# restores the registry afterwards.
server_module._register_vllm_local()


@pytest.fixture()
def vllm_ownership(monkeypatch):
    """Set vLLM ownership (COCKPIT_MANAGED_VLLM + the external verdict) and
    re-sync the "model-control" capability, restoring everything afterwards.

    COCKPIT_MANAGED_VLLM is read from the env ONCE at import into a module
    global, so a test cannot use monkeypatch.setenv — the switch is that global
    plus server._refresh_vllm_model_control(), which is exactly the pair the
    startup path uses. Setting the global to "0"/"1" is an EXPLICIT env value,
    which wins over settings.json's providers.vllm.managed (see
    server._vllm_managed_intent), so these tests never depend on the developer's
    own settings file. Tests that want the settings side are in
    test_vllm_ownership.py. The capability list is mutable module state, so it is
    snapshotted and restored rather than left as the test found it (a developer
    running with COCKPIT_MANAGED_VLLM=1 in their own env would otherwise see
    cross-test pollution).

    Usage: `vllm_ownership("1")` for managed, `vllm_ownership("0")` for
    external-by-config, `vllm_ownership("1", external=True)` for
    opted-in-but-something-else-already-serving.
    """
    caps = server_module._PROVIDERS["vllm-local"]["capabilities"]
    caps_snapshot = list(caps)
    external_snapshot = server_module._MANAGED_VLLM.get("external", False)

    def apply(value: str, external: bool = False):
        monkeypatch.setattr(server_module, "COCKPIT_MANAGED_VLLM", value)
        server_module._MANAGED_VLLM["external"] = external
        server_module._refresh_vllm_model_control()

    yield apply

    caps[:] = caps_snapshot
    server_module._MANAGED_VLLM["external"] = external_snapshot
