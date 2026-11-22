import { describe, it, expect, vi } from "vitest";
import { consumeReplayFrame, createReplayCursor, createReplayHold, REPLAY_HOLD_MAX_MS } from "../utils/terminalReplay";

// Owner, 2026-11-22: changing pages made every terminal run its history from the
// top down. A full replay is now buffered out of sight and shown at the bottom.

const frame = (o) => JSON.stringify(o);

function rig() {
  const log = [];
  let pending = "";
  let timerFn = null;
  const hold = createReplayHold({
    hide: () => log.push("hide"),
    show: () => log.push("show"),
    takePending: () => { const d = pending; pending = ""; return d; },
    write: (data, done) => { log.push(`write:${data}`); done(); },
    scrollToBottom: () => log.push("bottom"),
    setTimer: (fn, ms) => { timerFn = fn; log.push(`timer:${ms}`); return 1; },
    clearTimer: () => { timerFn = null; },
  });
  return { hold, log, add: (d) => { pending += d; }, fire: () => timerFn?.() };
}

describe("consumeReplayFrame begin/end", () => {
  it("reports a fresh view and a replacement snapshot as full, a reconnect delta as not", () => {
    const seen = [];
    const h = { reset: vi.fn(), enqueue: vi.fn(), warning: vi.fn(), begin: (b) => seen.push(b.full), end: () => seen.push("end") };
    const fresh = createReplayCursor();
    consumeReplayFrame(frame({ type: "replay_start", reset: false }), fresh, h);
    consumeReplayFrame(frame({ type: "replay_end", seq: 5 }), fresh, h);
    consumeReplayFrame(frame({ type: "replay_start", reset: false }), fresh, h); // reconnect, cursor at 5
    consumeReplayFrame(frame({ type: "replay_start", reset: true }), fresh, h);
    expect(seen).toEqual([true, "end", false, true]);
  });

  it("still works for a caller that passes neither callback", () => {
    const c = createReplayCursor();
    const h = { reset: vi.fn(), enqueue: vi.fn(), warning: vi.fn() };
    expect(consumeReplayFrame(frame({ type: "replay_start", reset: false }), c, h)).toBe(true);
    expect(consumeReplayFrame(frame({ type: "replay_end", seq: 3 }), c, h)).toBe(true);
    expect(c.seq).toBe(3);
  });
});

describe("createReplayHold", () => {
  it("hides, then writes the whole buffer once, pins to the bottom, then shows", () => {
    const { hold, log, add } = rig();
    hold.begin();
    add("a"); add("b");
    expect(hold.active).toBe(true);
    hold.release();
    expect(log).toEqual(["hide", `timer:${REPLAY_HOLD_MAX_MS}`, "write:ab", "bottom", "show"]);
    expect(hold.active).toBe(false);
  });

  it("shows an empty session too, and a second release does nothing", () => {
    const { hold, log } = rig();
    hold.begin();
    hold.release();
    hold.release();
    expect(log.filter((x) => x === "show")).toHaveLength(1);
    expect(log.some((x) => x.startsWith("write"))).toBe(false);
  });

  it("the deadline releases a replay whose end never arrives", () => {
    const { hold, log, add, fire } = rig();
    hold.begin();
    add("partial");
    fire();
    expect(hold.active).toBe(false);
    expect(log.slice(-3)).toEqual(["write:partial", "bottom", "show"]);
  });

  it("cancel shows the pane without writing, and release without begin is inert", () => {
    const { hold, log, add } = rig();
    hold.release();
    expect(log).toEqual([]);
    hold.begin();
    add("x");
    hold.cancel();
    expect(log.some((x) => x.startsWith("write"))).toBe(false);
    expect(log.at(-1)).toBe("show");
  });
});
