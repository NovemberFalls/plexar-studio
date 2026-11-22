/**
 * Regression tests for buildBusyTerminalIds (utils/bridgeEvents.js).
 *
 * WHY THIS FILE EXISTS: BridgeModal calls BOTH `.has()` and `.get()` on this
 * value — `.get()` supplies the reason string its BusyHint renders. App used to
 * hand it a Set, which satisfies `.has()` but has no `.get()`, so opening the
 * Bridge modal crashed the whole app with "x.get is not a function" as soon as
 * one session row rendered. That shipped from v1.4.0 through v1.7.1 while the
 * test suite stayed green, because BridgeModal's own tests construct a Map by
 * hand and never checked what App actually passes.
 *
 * So the load-bearing assertion here is `instanceof Map`. Do not relax it to a
 * duck-typed check — a Set would pass "has an entry for this id" style tests.
 */

import { describe, it, expect } from "vitest";
import { buildBusyTerminalIds, MAILBOX_KIND } from "../utils/bridgeEvents";

const live = { state: "active", lead_id: "term-lead", worker_ids: ["term-w1", "term-w2"] };

describe("buildBusyTerminalIds", () => {
  it("returns a Map, NOT a Set (BridgeModal calls .get() on it)", () => {
    const busy = buildBusyTerminalIds([live]);
    expect(busy).toBeInstanceOf(Map);
    // The exact call BridgeModal makes, which throws on a Set.
    expect(typeof busy.get).toBe("function");
    expect(() => busy.get("term-lead")).not.toThrow();
  });

  it("is a Map even when there is nothing active (the empty case is still .get()-able)", () => {
    expect(buildBusyTerminalIds([])).toBeInstanceOf(Map);
    expect(buildBusyTerminalIds(undefined)).toBeInstanceOf(Map);
    expect(buildBusyTerminalIds([]).size).toBe(0);
  });

  it("maps a bridge's lead AND every worker to the mailbox reason", () => {
    const busy = buildBusyTerminalIds([live]);
    expect(busy.get("term-lead")).toBe(MAILBOX_KIND);
    expect(busy.get("term-w1")).toBe(MAILBOX_KIND);
    expect(busy.get("term-w2")).toBe(MAILBOX_KIND);
    expect(busy.size).toBe(3);
  });

  it("a PAUSED bridge still owns its sessions", () => {
    const busy = buildBusyTerminalIds([{ ...live, state: "awaiting_human" }]);
    expect(busy.size).toBe(3);
  });

  it("ignores ended and state-less records", () => {
    const busy = buildBusyTerminalIds([
      { state: "ended_user", lead_id: "term-lead", worker_ids: ["term-w1"] },
      { lead_id: "term-x", worker_ids: [] },
    ]);
    expect(busy.size).toBe(0);
  });

  it("skips null/absent ids rather than storing a falsy key", () => {
    const busy = buildBusyTerminalIds([{ state: "active", lead_id: null, worker_ids: null }]);
    expect(busy.size).toBe(0);
    expect(busy.has(null)).toBe(false);
  });

  it("tolerates malformed input without throwing (polling data is best-effort)", () => {
    expect(() => buildBusyTerminalIds([null, undefined])).not.toThrow();
    expect(buildBusyTerminalIds([null]).size).toBe(0);
  });
});
