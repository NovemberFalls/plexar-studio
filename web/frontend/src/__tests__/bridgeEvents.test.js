/**
 * Unit tests for web/frontend/src/utils/bridgeEvents.js — the pure helpers
 * that detect when a mailbox bridge run has ended, so App.jsx can toast the
 * reason instead of letting the pane badge vanish silently.
 *
 * What is tested:
 *   computeEndEvents      — active->terminal transition detection, seeding,
 *                            vanish-while-active, dedupe, malformed input
 *   formatEndEventToast   — human-readable copy + Toast type per endState
 */

import { describe, it, expect } from "vitest";
import {
  computeEndEvents,
  formatEndEventToast,
  MAILBOX_KIND,
} from "../utils/bridgeEvents";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function bridgeRecord(overrides = {}) {
  return {
    mailbox_id: "b1",
    lead_id: "term-a",
    worker_ids: ["term-b"],
    participants: [
      { handle: "lead", role: "lead", name: "Session 18", terminal_id: "term-a" },
      { handle: "w1", role: "worker", name: "Session 21", terminal_id: "term-b" },
    ],
    rounds_used: 2,
    max_rounds: 12,
    state: "active",
    ...overrides,
  };
}

// ===========================================================================
// computeEndEvents
// ===========================================================================

describe("computeEndEvents", () => {
  it("fires no event on the first poll while a record is active (seeding)", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const events = computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);

    expect(events).toEqual([]);
    expect(prevStates.get("b1").state).toBe("active");
    expect(seenIds.size).toBe(0);
  });

  it("fires exactly once when a previously-active id transitions to an ended state", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    // Poll 1: active — seeds prevStates, no event.
    computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);

    // Poll 2: same id now ended_capped — must fire.
    const events = computeEndEvents(
      MAILBOX_KIND,
      [bridgeRecord({ state: "ended_capped", turns_used: 4, max_turns: 4 })],
      prevStates,
      seenIds,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "b1", kind: MAILBOX_KIND, endState: "ended_capped" });
    expect(events[0].record.turns_used).toBe(4);
    expect(seenIds.has("b1")).toBe(true);
  });

  it("never fires for a record that is already ended on the very first poll it is observed", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    // App just loaded; backend's TTL window still has a recently-ended
    // record in the payload. No toast storm on reload.
    const events = computeEndEvents(
      MAILBOX_KIND,
      [bridgeRecord({ state: "ended_agreed" })],
      prevStates,
      seenIds,
    );

    expect(events).toEqual([]);
    expect(seenIds.size).toBe(0);
    // Still seeded so a later poll of the SAME id doesn't retroactively fire.
    expect(prevStates.get("b1").state).toBe("ended_agreed");
  });

  it("does not refire on subsequent polls that keep observing the same ended state (TTL window)", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);
    const firstEnd = computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "ended_user" })], prevStates, seenIds);
    expect(firstEnd).toHaveLength(1);

    // Backend keeps serving the ended record for the rest of its TTL.
    const secondPoll = computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "ended_user" })], prevStates, seenIds);
    const thirdPoll = computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "ended_user" })], prevStates, seenIds);

    expect(secondPoll).toEqual([]);
    expect(thirdPoll).toEqual([]);
  });

  it("fires a generic (endState: null) event when a previously-active id vanishes from the payload", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);

    // Next poll: the record is gone entirely (TTL race / backend restart).
    const events = computeEndEvents(MAILBOX_KIND, [], prevStates, seenIds);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: "b1", kind: MAILBOX_KIND, endState: null });
    expect(events[0].record.lead_id).toBe("term-a"); // last-known snapshot preserved
    expect(prevStates.has("b1")).toBe(false); // pruned — never reappears
  });

  it("does not fire a vanish event for a record that already ended before it vanished", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);
    const endedEvents = computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "errored" })], prevStates, seenIds);
    expect(endedEvents).toHaveLength(1); // fired once, as errored

    // Now it vanishes from the payload entirely (TTL prune). Must NOT fire
    // again — prevStates already reflects "errored", not "active", by the
    // time it vanishes.
    const vanishEvents = computeEndEvents(MAILBOX_KIND, [], prevStates, seenIds);
    expect(vanishEvents).toEqual([]);
  });

  it("dedupes across many repeated polls even if seenIds were somehow bypassed for prevStates", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "active" })], prevStates, seenIds);
    let totalEvents = 0;
    for (let i = 0; i < 5; i++) {
      const events = computeEndEvents(MAILBOX_KIND, [bridgeRecord({ state: "ended_capped" })], prevStates, seenIds);
      totalEvents += events.length;
    }
    expect(totalEvents).toBe(1);
  });

  it("handles multiple independent ids concurrently without cross-contamination", () => {
    const prevStates = new Map();
    const seenIds = new Set();

    computeEndEvents(
      MAILBOX_KIND,
      [bridgeRecord({ mailbox_id: "b1", state: "active" }), bridgeRecord({ mailbox_id: "b2", state: "active" })],
      prevStates,
      seenIds,
    );

    const events = computeEndEvents(
      MAILBOX_KIND,
      [
        bridgeRecord({ mailbox_id: "b1", state: "active" }), // still running
        bridgeRecord({ mailbox_id: "b2", state: "ended_capped" }), // ended
      ],
      prevStates,
      seenIds,
    );

    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("b2");
  });

  // -------------------------------------------------------------------------
  // Malformed input — must never throw, must be silently ignored.
  // -------------------------------------------------------------------------

  it("ignores non-array records without throwing", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    expect(() => computeEndEvents(MAILBOX_KIND, null, prevStates, seenIds)).not.toThrow();
    expect(() => computeEndEvents(MAILBOX_KIND, undefined, prevStates, seenIds)).not.toThrow();
    expect(() => computeEndEvents(MAILBOX_KIND, "not-an-array", prevStates, seenIds)).not.toThrow();
    expect(computeEndEvents(MAILBOX_KIND, null, prevStates, seenIds)).toEqual([]);
  });

  it("skips null/non-object entries inside the records array", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const events = computeEndEvents(
      MAILBOX_KIND,
      [null, undefined, 42, "oops", bridgeRecord({ state: "active" })],
      prevStates,
      seenIds,
    );
    expect(events).toEqual([]);
    expect(prevStates.size).toBe(1);
  });

  it("skips entries missing an id field", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const rec = bridgeRecord({ state: "active" });
    delete rec.mailbox_id;
    const events = computeEndEvents(MAILBOX_KIND, [rec], prevStates, seenIds);
    expect(events).toEqual([]);
    expect(prevStates.size).toBe(0);
  });

  it("skips entries missing or non-string state", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    const events = computeEndEvents(
      MAILBOX_KIND,
      [bridgeRecord({ state: undefined }), bridgeRecord({ mailbox_id: "b2", state: 123 })],
      prevStates,
      seenIds,
    );
    expect(events).toEqual([]);
    expect(prevStates.size).toBe(0);
  });

  it("returns an empty array for an unknown kind instead of throwing", () => {
    const prevStates = new Map();
    const seenIds = new Set();
    expect(computeEndEvents("bogus", [bridgeRecord()], prevStates, seenIds)).toEqual([]);
  });

  it("returns an empty array if prevStates/seenIds are not the expected collection types", () => {
    expect(computeEndEvents(MAILBOX_KIND, [bridgeRecord()], {}, new Set())).toEqual([]);
    expect(computeEndEvents(MAILBOX_KIND, [bridgeRecord()], new Map(), [])).toEqual([]);
  });
});

// ===========================================================================
// formatEndEventToast
// ===========================================================================

describe("formatEndEventToast", () => {
  it("formats ended_capped with its end_reason when the human gate expired", () => {
    const { message, type } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "ended_capped",
      record: bridgeRecord({ end_reason: "no answer at the round cap" }),
    });
    expect(message).toBe("Bridge Session 18 + 1 worker ended: no answer at the round cap");
    expect(type).toBe("info");
  });

  it("formats ended_capped without counts or reason as a generic limit", () => {
    const { message } = formatEndEventToast({ kind: MAILBOX_KIND, endState: "ended_capped", record: bridgeRecord() });
    expect(message).toBe("Bridge Session 18 + 1 worker ended: turn limit reached");
  });

  it("formats ended_agreed", () => {
    const { message, type } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "ended_agreed",
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 + 1 worker finished — all sides agreed");
    expect(type).toBe("info");
  });

  it("formats ended_user as a stop, not an 'ended:' phrase", () => {
    const { message, type } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "ended_user",
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 + 1 worker stopped");
    expect(type).toBe("info");
  });

  it("formats errored with error styling", () => {
    const { message, type } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "errored",
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 + 1 worker failed — a session died or a write failed");
    expect(type).toBe("error");
  });

  it("formats a generic (vanished) event with endState: null", () => {
    const { message, type } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: null,
      record: bridgeRecord(),
    });
    expect(message).toBe("Bridge Session 18 + 1 worker ended");
    expect(type).toBe("info");
  });

  it("omits names entirely when the record does not expose participants", () => {
    const { message } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "ended_user",
      record: { mailbox_id: "b1", state: "ended_user" },
    });
    expect(message).toBe("Bridge stopped");
  });

  it("uses the singular for a single worker and the plural for several", () => {
    const two = bridgeRecord({
      participants: [
        { role: "lead", name: "Session 5" },
        { role: "worker", name: "W1" },
        { role: "worker", name: "W2" },
      ],
    });
    expect(formatEndEventToast({ kind: MAILBOX_KIND, endState: "ended_user", record: two }).message)
      .toBe("Bridge Session 5 + 2 workers stopped");
    expect(formatEndEventToast({ kind: MAILBOX_KIND, endState: "ended_user", record: bridgeRecord() }).message)
      .toBe("Bridge Session 18 + 1 worker stopped");
  });

  it("falls back to the lead name alone when there are no workers", () => {
    const { message } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "ended_user",
      record: bridgeRecord({ participants: [{ role: "lead", name: "Session 5" }] }),
    });
    expect(message).toBe("Bridge Session 5 stopped");
  });

  it("never throws on a malformed event object", () => {
    expect(() => formatEndEventToast(null)).not.toThrow();
    expect(() => formatEndEventToast(undefined)).not.toThrow();
    expect(() => formatEndEventToast({})).not.toThrow();
    expect(formatEndEventToast({}).type).toBe("info");
    expect(() => formatEndEventToast({ kind: MAILBOX_KIND, endState: "errored", record: null })).not.toThrow();
  });
});
