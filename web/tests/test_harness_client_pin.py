"""Pin the vendored Plexar Harness client (contract v3).

`plexar_harness_client.py` is copied BYTE-FOR-BYTE from the private harness repo
(packages/bundle/plexar/studio/). Its drift gate, `check_api_drift.py`, lives in
that private repo, so Studio CI cannot run it. This test is Studio's half: when
the harness re-pins, re-vendor the file unchanged and update VENDORED_SHA256
(and CONTRACT_VERSION if the contract moved) in the same change.
"""
from __future__ import annotations

import hashlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import plexar_harness_client  # noqa: E402

VENDORED_SHA256 = "f88b8a84cf22812adccd4c645f902f2af608f32285e3d433dc0157d0098e181a"


def test_contract_version_is_3():
    assert plexar_harness_client.CONTRACT_VERSION == "3"


def test_vendored_file_is_byte_identical_to_the_pin():
    with open(plexar_harness_client.__file__, "rb") as fh:
        assert hashlib.sha256(fh.read()).hexdigest() == VENDORED_SHA256
