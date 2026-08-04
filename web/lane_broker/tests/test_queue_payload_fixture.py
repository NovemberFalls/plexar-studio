"""S10/R26 — GENERATE the `/queue` payload the UI's wiring test consumes.

WHY THIS FILE EXISTS. Row S10 was marked ✅ over a chain with an untested link.
Two halves were genuinely proven and the seam between them was not:

  * `test_shadow_default_is_inert.py` drives a REAL broker subprocess and proves
    the `shadow` flag corresponds to real queueing behaviour;
  * `LaneStrip.shadowState.test.jsx` proves the strip tells the truth about a
    lane object -- but it BUILT that object by hand, `{..., shadow: true}`;
  * and `App.jsx`'s one-line mapping between them was exercised by neither.

That is L3's shape: a property proven directly, a store proven with hand-built
dicts, and the writer between them writing nothing. The fix is not another
hand-written fixture -- a fixture nobody has watched fail is still a fixture
nobody has tested, and a fixture the CONSUMER wrote agrees with the consumer by
construction. So the payload is GENERATED HERE, from the provider, by starting
the real broker in both modes and recording what it actually returns from
`GET /queue`.

This is L7's topology applied one layer down: provenance of the SHAPE is the
provider; the EXPECTATION about what the UI does with it is the consumer's, and
lives in `LaneStrip.wiring.test.jsx`. Neither half works alone.

There is deliberately NO `--update` flag and no hand-editing path. Run this file
and the artefact is rewritten from a live broker or not at all.
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_broker import (  # noqa: E402
    FakeUpstream,
    get_queue,
    start_broker,
)

# The artefact lands beside the JS suite that consumes it. `.generated.` is in
# the name so nobody edits it by hand and expects the edit to survive.
FIXTURE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "..", "frontend", "src", "__tests__", "fixtures",
    "queue-payloads.generated.json",
)

# Every key `_queue_state` is contracted to emit. Pinned as an EXACT SET, not a
# floor: a floor tolerates the payload shrinking one field at a time, which is
# the same failure arriving slowly (L7 hardening #2).
#
# THIS SET EARNED ITSELF ON ITS FIRST RUN, AND THE MISS WAS MINE (R25).
# I wrote it from the dict literal at `broker.py:1079` and got four keys. The
# real payload has FIVE: `predicted_wait_s_by_class` is attached later in the
# same function, at line 1105, and I never scrolled that far. The generated
# payload corrected a pin I had taken from a partial read of the provider's
# SOURCE rather than from its actual OUTPUT -- which is precisely R25's point,
# arriving inside the fix for R26. Had I written this as a floor (`>=`), the
# miss would have passed silently and the artefact would have under-pinned the
# payload forever.
# `predicted_wait_s_by_class` is NOT an unread field -- checked before claiming
# it: the queue payload carries it and `test_metrics_v2.py` pins it.
EXPECTED_QUEUE_KEYS = {
    "shadow",
    "in_flight",
    "queued",
    "estimated_clear_seconds",
    "predicted_wait_s_by_class",
}


def _capture(tmp_path, *, shadow: bool) -> dict:
    """Start a real broker in the given mode and return its real /queue body."""
    up = FakeUpstream(delay=0.05)
    up.start()
    log = str(tmp_path / f"jobs-{'shadow' if shadow else 'live'}.jsonl")
    args = ["--shadow"] if shadow else []
    proc, port = start_broker(up.port, log, args)
    try:
        return get_queue(port)
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        up.stop()


def test_generate_queue_payload_fixture(tmp_path):
    """Capture both modes from the real broker and write the artefact."""
    shadow = _capture(tmp_path, shadow=True)
    live = _capture(tmp_path, shadow=False)

    # 1. The payload has the shape the consumer maps. Exact set, both directions.
    for name, payload in (("shadow", shadow), ("live", live)):
        assert set(payload) == EXPECTED_QUEUE_KEYS, (
            f"{name} payload keys {sorted(payload)} != {sorted(EXPECTED_QUEUE_KEYS)}. "
            "The consumer's mapping is pinned to this shape; a rename here is a "
            "silent false in `shadow === true` and a live meter over a dead queue."
        )

    # 2. The field is a real JSON boolean, not a string and not a truthy stand-in.
    #    `App.jsx` compares with `=== true`, so a string "true" reads as FALSE --
    #    the exact silent-wrong-way failure this whole row is about.
    for name, payload in (("shadow", shadow), ("live", live)):
        assert isinstance(payload["shadow"], bool), (
            f"{name}: shadow is {type(payload['shadow']).__name__}, not bool"
        )

    # 3. R10 -- pairwise distinct, not individually correct. If both modes emit
    #    the same flag the field carries no information and every downstream
    #    assertion about it is decoration.
    assert shadow["shadow"] != live["shadow"], (
        "shadow and live brokers published the SAME flag; the field is inert"
    )
    # And the direction is pinned too, because "they differ" is satisfied by the
    # flag being backwards -- which would render the shadow note over a live
    # queue and the live meter over a shadow one. Distinctness is not enough.
    assert shadow["shadow"] is True and live["shadow"] is False

    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    with open(FIXTURE, "w", encoding="utf-8") as f:
        json.dump(
            {
                "_README": (
                    "GENERATED by lane_broker/tests/test_queue_payload_fixture.py "
                    "from a real broker subprocess. Do not hand-edit -- a "
                    "hand-written payload agrees with the consumer by "
                    "construction, which is the defect this artefact exists to "
                    "close. Regenerate by running that test."
                ),
                "shadow": shadow,
                "live": live,
            },
            f,
            indent=2,
            sort_keys=True,
        )
        f.write("\n")


def test_fixture_on_disk_matches_a_live_broker(tmp_path):
    """The committed artefact is not allowed to drift from the real payload.

    Without this, the generator could stop running and the JS suite would keep
    passing against a stale snapshot of a shape the broker no longer emits --
    a fixture that was once real, which reads exactly like one that still is.
    """
    if not os.path.exists(FIXTURE):
        pytest.skip("fixture not generated yet; run test_generate_queue_payload_fixture")
    with open(FIXTURE, encoding="utf-8") as f:
        on_disk = json.load(f)
    fresh = _capture(tmp_path, shadow=True)
    assert set(on_disk["shadow"]) == set(fresh), (
        "committed fixture's key set has drifted from the live broker's payload"
    )
    assert on_disk["shadow"]["shadow"] is True
