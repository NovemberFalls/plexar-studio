/**
 * Frontend tests for the V4 mailbox bridge.
 *
 * The theme running through these: `awaiting_human` is a LIVE state. Every
 * helper that previously asked "is state === 'active'?" now has to distinguish
 * three things — running, paused, over — and collapsing the first two into
 * "not over" or the last two into "not running" both produce wrong UI:
 *
 *   - treat paused as ended → the pane badge (which carries the only control
 *     that unpauses it) disappears, and "Bridge ended" is toasted for a bridge
 *     that is still going
 *   - treat paused as free  → the user can start a second bridge on sessions
 *     that are mid-conversation
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import {
  computeEndEvents,
  computePauseEvents,
  formatEndEventToast,
  buildBusyTerminalIds,
  isTerminalState,
  MAILBOX_KIND,
} from "../utils/bridgeEvents";
import MailboxOverlay from "../components/MailboxOverlay";

const mbx = (over = {}) => ({
  mailbox_id: "mb-1",
  state: "active",
  rounds_used: 3,
  max_rounds: 12,
  lead_id: "t-lead",
  worker_ids: ["t-w1"],
  participants: [
    { handle: "lead", terminal_id: "t-lead", name: "Alpha", role: "lead", done: false },
    { handle: "w1", terminal_id: "t-w1", name: "Beta", role: "worker", done: false },
  ],
  ...over,
});

// ---------------------------------------------------------------------------
// isTerminalState
// ---------------------------------------------------------------------------

describe("isTerminalState", () => {
  it("treats awaiting_human as live, not finished", () => {
    expect(isTerminalState("awaiting_human")).toBe(false);
    expect(isTerminalState("active")).toBe(false);
  });

  it("treats every real end state as finished", () => {
    for (const s of ["ended_agreed", "ended_user", "ended_capped", "errored"]) {
      expect(isTerminalState(s)).toBe(true);
    }
  });

  it("does not treat a missing state as finished", () => {
    expect(isTerminalState(undefined)).toBe(false);
    expect(isTerminalState("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// End events
// ---------------------------------------------------------------------------

describe("computeEndEvents with mailbox bridges", () => {
  it("does NOT fire an end event when a bridge merely pauses", () => {
    const prev = new Map();
    const seen = new Set();
    computeEndEvents(MAILBOX_KIND, [mbx()], prev, seen);
    const events = computeEndEvents(MAILBOX_KIND, [mbx({ state: "awaiting_human" })], prev, seen);
    expect(events).toEqual([]);
    expect(seen.size).toBe(0);
  });

  it("fires when a PAUSED bridge later ends", () => {
    const prev = new Map();
    const seen = new Set();
    computeEndEvents(MAILBOX_KIND, [mbx({ state: "awaiting_human" })], prev, seen);
    const events = computeEndEvents(MAILBOX_KIND, [mbx({ state: "ended_capped" })], prev, seen);
    expect(events).toHaveLength(1);
    expect(events[0].endState).toBe("ended_capped");
  });

  it("fires exactly once across active -> paused -> active -> ended", () => {
    const prev = new Map();
    const seen = new Set();
    const seq = ["active", "awaiting_human", "active", "ended_agreed", "ended_agreed"];
    const fired = seq.flatMap((state) =>
      computeEndEvents(MAILBOX_KIND, [mbx({ state })], prev, seen)
    );
    expect(fired).toHaveLength(1);
    expect(fired[0].endState).toBe("ended_agreed");
  });

  it("fires for a paused bridge that vanishes from the payload", () => {
    const prev = new Map();
    const seen = new Set();
    computeEndEvents(MAILBOX_KIND, [mbx({ state: "awaiting_human" })], prev, seen);
    const events = computeEndEvents(MAILBOX_KIND, [], prev, seen);
    expect(events).toHaveLength(1);
    expect(events[0].endState).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pause events
// ---------------------------------------------------------------------------

describe("computePauseEvents", () => {
  it("announces a pause once, not once per poll", () => {
    const seenPaused = new Set();
    const paused = mbx({ state: "awaiting_human" });
    expect(computePauseEvents([paused], seenPaused)).toHaveLength(1);
    expect(computePauseEvents([paused], seenPaused)).toHaveLength(0);
    expect(computePauseEvents([paused], seenPaused)).toHaveLength(0);
  });

  it("announces a SECOND pause after a resume", () => {
    const seenPaused = new Set();
    computePauseEvents([mbx({ state: "awaiting_human" })], seenPaused);
    computePauseEvents([mbx({ state: "active" })], seenPaused);
    expect(computePauseEvents([mbx({ state: "awaiting_human" })], seenPaused)).toHaveLength(1);
  });

  it("stays silent for running and ended bridges", () => {
    const seenPaused = new Set();
    expect(computePauseEvents([mbx()], seenPaused)).toEqual([]);
    expect(computePauseEvents([mbx({ state: "ended_agreed" })], seenPaused)).toEqual([]);
  });

  it("tolerates junk without throwing", () => {
    const seenPaused = new Set();
    expect(computePauseEvents(null, seenPaused)).toEqual([]);
    expect(computePauseEvents([null, 5, {}], seenPaused)).toEqual([]);
    expect(computePauseEvents([mbx()], undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Toast text
// ---------------------------------------------------------------------------

describe("formatEndEventToast for mailbox bridges", () => {
  it("distinguishes mutual agreement from the old one-sided sentinel", () => {
    const { message, type } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "ended_agreed",
      record: mbx({ state: "ended_agreed" }),
    });
    expect(message).toContain("Alpha + 1 worker");
    expect(message).toMatch(/all sides agreed/i);
    expect(type).toBe("info");
  });

  it("prefers the server's end_reason over generic turn-limit wording", () => {
    const { message } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "ended_capped",
      record: mbx({
        state: "ended_capped",
        end_reason: "Round cap reached and no one granted more rounds within 30 minutes.",
      }),
    });
    expect(message).toContain("no one granted more rounds");
  });

  it("surfaces the reason a bridge errored", () => {
    const { message, type } = formatEndEventToast({
      kind: MAILBOX_KIND,
      endState: "errored",
      record: mbx({ state: "errored", end_reason: 'Session "Beta" is no longer running.' }),
    });
    expect(message).toContain("Beta");
    expect(type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Busy map
// ---------------------------------------------------------------------------

describe("buildBusyTerminalIds with mailbox bridges", () => {
  it("marks every participant of a running bridge", () => {
    const busy = buildBusyTerminalIds([], [], [mbx()]);
    expect(busy.get("t-lead")).toBe(MAILBOX_KIND);
    expect(busy.get("t-w1")).toBe(MAILBOX_KIND);
  });

  it("keeps a PAUSED bridge's sessions busy", () => {
    const busy = buildBusyTerminalIds([], [], [mbx({ state: "awaiting_human" })]);
    expect(busy.has("t-lead")).toBe(true);
    expect(busy.has("t-w1")).toBe(true);
  });

  it("releases them once the bridge is over", () => {
    for (const state of ["ended_agreed", "ended_user", "ended_capped", "errored"]) {
      const busy = buildBusyTerminalIds([], [], [mbx({ state })]);
      expect(busy.size).toBe(0);
    }
  });

  it("still returns a Map (BridgeModal calls .get for the label)", () => {
    expect(buildBusyTerminalIds([], [], [mbx()])).toBeInstanceOf(Map);
  });

  it("is backwards compatible with two arguments", () => {
    expect(() => buildBusyTerminalIds([], [])).not.toThrow();
    expect(buildBusyTerminalIds([], []).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pane overlay
// ---------------------------------------------------------------------------

const info = (over = {}) => ({
  mailbox_id: "mb-1",
  state: "active",
  handle: "lead",
  isLead: true,
  rounds_used: 3,
  max_rounds: 12,
  ...over,
});

describe("MailboxOverlay", () => {
  it("renders nothing when the pane is not in a bridge", () => {
    const { container } = render(
      <MailboxOverlay info={null} onExtend={vi.fn()} onStop={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows role, handle and round count while running", () => {
    render(<MailboxOverlay info={info()} onExtend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByText(/BRIDGE LEAD/)).toBeInTheDocument();
    expect(screen.getByText(/round 3\/12/)).toBeInTheDocument();
  });

  it("labels a worker as a worker", () => {
    render(
      <MailboxOverlay info={info({ isLead: false, handle: "w1" })} onExtend={vi.fn()} onStop={vi.fn()} />
    );
    expect(screen.getByText(/BRIDGE WORKER/)).toBeInTheDocument();
  });

  it("offers NO grant control while the bridge is running", () => {
    render(<MailboxOverlay info={info()} onExtend={vi.fn()} onStop={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "+5" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /stop/i })).toBeInTheDocument();
  });

  it("asks for more rounds when paused, and grants the amount clicked", async () => {
    const onExtend = vi.fn().mockResolvedValue(undefined);
    render(
      <MailboxOverlay
        info={info({ state: "awaiting_human", rounds_used: 12 })}
        onExtend={onExtend}
        onStop={vi.fn()}
      />
    );
    expect(screen.getByText(/ROUND CAP REACHED/)).toBeInTheDocument();
    expect(screen.getByText(/grant more\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "+15" }));
    await waitFor(() => expect(onExtend).toHaveBeenCalledWith("mb-1", 15));
  });

  it("labels the stop button 'End' when paused", () => {
    render(
      <MailboxOverlay info={info({ state: "awaiting_human" })} onExtend={vi.fn()} onStop={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: /^end$/i })).toBeInTheDocument();
  });

  it("stops the bridge by id", () => {
    const onStop = vi.fn();
    render(<MailboxOverlay info={info()} onExtend={vi.fn()} onStop={onStop} />);
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(onStop).toHaveBeenCalledWith("mb-1");
  });

  it("does not fire a second grant while the first is in flight", async () => {
    let release;
    const onExtend = vi.fn(() => new Promise((r) => { release = r; }));
    render(
      <MailboxOverlay info={info({ state: "awaiting_human" })} onExtend={onExtend} onStop={vi.fn()} />
    );
    const plus5 = screen.getByRole("button", { name: "+5" });
    fireEvent.click(plus5);
    fireEvent.click(plus5);
    fireEvent.click(screen.getByRole("button", { name: "+15" }));
    expect(onExtend).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(onExtend).toHaveBeenCalledTimes(1));
  });
});
