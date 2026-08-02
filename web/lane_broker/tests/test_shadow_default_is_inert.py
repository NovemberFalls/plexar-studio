"""S3 — measure what the VENDORED broker actually does under Cockpit's default.

Cockpit launches the broker with `shadow=True` unless `COCKPIT_BROKER_SHADOW=0`
(`server.py`, the managed-broker launcher). `broker.py` skips `_queued_forward`
when `shadow` is set, so under the shipped default the QUEUEING HALF OF THIS
COMPONENT NEVER RUNS.

That is the claim. These tests measure it against the real broker subprocess and
a real upstream rather than asserting it from a reading of the source, because
S3's row demands a decision ON MEASUREMENT.

R10 (assert states pairwise distinct, never individually correct) is the shape
here, and it cuts BOTH ways:

  * shadow vs no-shadow must DIFFER where the feature is real — otherwise
    "shadow" means nothing and the flag is decoration.
  * shadow vs "the queueing feature does not exist" must be INDISTINGUISHABLE —
    that is what "inert" means, and it is the finding: a user on the default
    build cannot tell the queue from its absence, while the UI offers controls
    for it.

WHAT THIS DOES NOT SAY. The broker is still LOAD-BEARING as a transport:
`lmstudio_proxy.py` posts every session's `/v1/messages` at the broker's own
address. Inert queueing is not an inert component, and these tests deliberately
prove the forwarding still happens (`test_shadow_still_forwards`) so nobody
reads "inert" as "removable".
"""
import json
import os
import threading

import pytest

# The harness (real subprocess, real upstream) lives in the sibling module.
# `tests/` is not a package, so it is imported by path rather than relatively --
# matching how the existing suite is run (`pytest lane_broker/tests`).
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_broker import (  # noqa: E402
    FakeUpstream,
    get_queue,
    post_chat,
    seed_history,
    start_broker,
)


def _spawn(tmp_path, *, shadow: bool, delay: float, extra=None):
    """Start a real broker against a real upstream. Returns (upstream, port, log)."""
    log = str(tmp_path / "jobs.jsonl")
    up = FakeUpstream(delay=delay)
    up.start()
    args = list(extra or [])
    if shadow:
        args.append("--shadow")
    proc, port = start_broker(up.port, log, args)
    return up, port, log, proc


def _fire(port, n, lane_class="worker", timeout=30.0):
    """n concurrent POSTs; returns the list of status codes."""
    out = [None] * n
    def one(i):
        out[i], _ = post_chat(port, lane_class=lane_class, req_id=f"r{i}", timeout=timeout)
    threads = [threading.Thread(target=one, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return out


# ── The feature is real when it is switched on ──────────────────────────────

def test_without_shadow_the_broker_actually_queues(tmp_path):
    """Control arm. If this fails, `shadow` is not why the queue is idle."""
    up, port, _log, proc = _spawn(tmp_path, shadow=False, delay=0.8)
    try:
        _fire(port, 2)
        # Serialised: the queue admitted one at a time.
        assert up.max_active == 1, f"expected serialisation, saw max_active={up.max_active}"
    finally:
        proc.terminate(); proc.wait(timeout=5); up.stop()


# ── Under Cockpit's shipped default it is not ───────────────────────────────

def test_shadow_does_not_queue(tmp_path):
    up, port, _log, proc = _spawn(tmp_path, shadow=True, delay=0.8)
    try:
        _fire(port, 2)
        # Straight through, both at once. No admission control happened.
        assert up.max_active == 2, f"expected pass-through, saw max_active={up.max_active}"
    finally:
        proc.terminate(); proc.wait(timeout=5); up.stop()


def test_shadow_never_spills_even_with_a_threshold_that_must_trigger(tmp_path):
    """Spill is recorded ONLY inside `_queued_forward`, which shadow skips.

    A zero threshold means "spill anything with a predicted wait above 0s", and
    seeded history guarantees a non-zero prediction. In shadow it STILL does not
    fire -- so the SpillPolicy card configures something that cannot happen on
    the default build.
    """
    log = str(tmp_path / "jobs.jsonl")
    seed_history(log, [5000, 5000, 5000])
    up = FakeUpstream(delay=0.1)
    up.start()
    proc, port = start_broker(up.port, log, ["--shadow", "--spill-worker", "0.0"])
    try:
        statuses = _fire(port, 2)
        assert all(s == 200 for s in statuses), f"shadow spilled: {statuses}"
        spills = tmp_path / "spills.jsonl"
        assert not spills.exists() or spills.read_text().strip() == "", \
            "shadow recorded a spill event"
    finally:
        proc.terminate(); proc.wait(timeout=5); up.stop()


def test_shadow_queue_depth_is_indistinguishable_from_no_queue(tmp_path):
    """The R10 half that matters: inert must look like absent.

    `/queue` is what LaneStrip renders. If a user cannot tell a queue that never
    admits anything from a build with no queue at all, the queue is not a
    capability they would miss.
    """
    up, port, _log, proc = _spawn(tmp_path, shadow=True, delay=0.5)
    try:
        _fire(port, 3)
        q = get_queue(port)
        depth = q.get("depth")
        if depth is None:
            running = q.get("running") or q.get("active") or []
            waiting = q.get("waiting") or q.get("queued") or []
            depth = len(running) + len(waiting)
        assert depth == 0, f"expected an always-empty queue in shadow, saw {q}"
    finally:
        proc.terminate(); proc.wait(timeout=5); up.stop()


# ── But it is NOT a removable component ─────────────────────────────────────

def test_shadow_still_forwards(tmp_path):
    """Inert queueing is not an inert component.

    `lmstudio_proxy` posts every session at the broker. If this passes and the
    ones above pass, the correct conclusion is "retire the QUEUE, keep the
    TRANSPORT" -- not "delete the broker".
    """
    up, port, _log, proc = _spawn(tmp_path, shadow=True, delay=0.0)
    try:
        status, body = post_chat(port, lane_class="worker", req_id="fwd")
        assert status == 200
        assert len(up.order) == 1, "the request never reached the upstream"
    finally:
        proc.terminate(); proc.wait(timeout=5); up.stop()


def test_shadow_still_records_a_trace(tmp_path):
    """The observe half DOES work, which is why traces/metrics are not dead.

    `_forward` is called with `log_class=` for queued paths even in shadow, so
    the jobs log keeps filling. This is the capability that would genuinely go
    missing, and it is the one §2.24 was right about.
    """
    up, port, log, proc = _spawn(tmp_path, shadow=True, delay=0.0)
    try:
        post_chat(port, lane_class="worker", req_id="t1")
        # The broker writes asynchronously; give it a moment to flush.
        for _ in range(50):
            if os.path.exists(log) and os.path.getsize(log) > 0:
                break
            threading.Event().wait(0.1)
        assert os.path.exists(log) and os.path.getsize(log) > 0, \
            "shadow recorded nothing -- then traces/metrics would be dead too"
        last = [json.loads(x) for x in open(log, encoding="utf-8") if x.strip()][-1]
        assert last.get("class") == "worker"
    finally:
        proc.terminate(); proc.wait(timeout=5); up.stop()
