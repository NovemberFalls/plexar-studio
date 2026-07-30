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
import { buildBusyTerminalIds, BRIDGE_KIND, CHANNEL_KIND } from "../utils/bridgeEvents";

const activeBridge = { state: "active", from_id: "term-a", to_id: "term-b" };
const activeChannel = { state: "active", lead_id: "term-lead", worker_ids: ["term-w1", "term-w2"] };

describe("buildBusyTerminalIds", () => {
  it("returns a Map — NOT a Set (BridgeModal calls .get() on it)", () => {
    const busy = buildBusyTerminalIds([activeBridge], [activeChannel]);
    expect(busy).toBeInstanceOf(Map);
    // The exact call BridgeModal makes, which throws on a Set.
    expect(typeof busy.get).toBe("function");
    expect(() => busy.get("term-a")).not.toThrow();
  });

  it("is a Map even when there is nothing active (the empty case is still .get()-able)", () => {
    expect(buildBusyTerminalIds([], [])).toBeInstanceOf(Map);
    expect(buildBusyTerminalIds(undefined, undefined)).toBeInstanceOf(Map);
    expect(buildBusyTerminalIds([], []).size).toBe(0);
  });

  it("maps bridge participants to the reason BusyHint renders as 'in bridge'", () => {
    const busy = buildBusyTerminalIds([activeBridge], []);
    expect(busy.get("term-a")).toBe(BRIDGE_KIND);
    expect(busy.get("term-b")).toBe(BRIDGE_KIND);
    expect(busy.size).toBe(2);
  });

  it("maps a channel's lead AND every worker to 'channel'", () => {
    const busy = buildBusyTerminalIds([], [activeChannel]);
    expect(busy.get("term-lead")).toBe(CHANNEL_KIND);
    expect(busy.get("term-w1")).toBe(CHANNEL_KIND);
    expect(busy.get("term-w2")).toBe(CHANNEL_KIND);
    expect(busy.size).toBe(3);
  });

  it("ignores non-active records", () => {
    const busy = buildBusyTerminalIds(
      [{ state: "ended", from_id: "term-a", to_id: "term-b" }],
      [{ state: "ended", lead_id: "term-lead", worker_ids: ["term-w1"] }],
    );
    expect(busy.size).toBe(0);
  });

  it("first writer wins, so a session in both keeps a stable label", () => {
    const busy = buildBusyTerminalIds(
      [{ state: "active", from_id: "term-x", to_id: null }],
      [{ state: "active", lead_id: "term-x", worker_ids: [] }],
    );
    expect(busy.get("term-x")).toBe(BRIDGE_KIND);
  });

  it("skips null/absent ids rather than storing a falsy key", () => {
    const busy = buildBusyTerminalIds(
      [{ state: "active", from_id: "term-a", to_id: null }],
      [{ state: "active", lead_id: null, worker_ids: null }],
    );
    expect(busy.size).toBe(1);
    expect(busy.has(null)).toBe(false);
  });

  it("tolerates malformed input without throwing (polling data is best-effort)", () => {
    expect(() => buildBusyTerminalIds([null, undefined], [null])).not.toThrow();
    expect(buildBusyTerminalIds([null], [null]).size).toBe(0);
  });
});
