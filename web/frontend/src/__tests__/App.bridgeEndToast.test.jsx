/**
 * Light integration test for the bridge "end toast" wiring in
 * App.jsx's /api/bridge/mb poll effect.
 *
 * App.jsx is a large root component with heavy backend/localStorage/timer
 * dependencies, so — following the same isolation strategy already used by
 * App.renameSession.test.jsx and the "App BroadcastChannel CLOSED
 * integration" suite in popout.test.jsx — we replicate the EXACT poll
 * effect body (App.jsx, "Poll /api/bridge/mb every 3s..." block) inside a
 * minimal harness component. This exercises the real contract (fetch ->
 * computeEndEvents -> toast) without booting the full App component tree.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { computeEndEvents, formatEndEventToast, MAILBOX_KIND } from "../utils/bridgeEvents";

const { useState, useEffect, useRef } = React;

// ---------------------------------------------------------------------------
// Harness — mirrors the bridge poll effect in App.jsx verbatim.
// ---------------------------------------------------------------------------

function BridgePollHarness({ toast }) {
  const [activeBridges, setActiveBridges] = useState([]);
  const prevBridgeStatesRef = useRef(new Map());
  const seenBridgeIdsRef = useRef(new Set());

  useEffect(() => {
    const fetchBridges = async () => {
      try {
        const res = await fetch("/api/bridge/mb");
        if (!res.ok) return;
        const data = await res.json();
        const bridges = data.bridges || [];
        setActiveBridges(bridges);
        const events = computeEndEvents(MAILBOX_KIND, bridges, prevBridgeStatesRef.current, seenBridgeIdsRef.current);
        events.forEach((evt) => {
          const { message, type } = formatEndEventToast(evt);
          toast(message, type);
        });
      } catch (_) {
        // soft-fail — stale bridge state is not critical
      }
    };
    fetchBridges();
    const id = setInterval(fetchBridges, 3000);
    return () => clearInterval(id);
  }, [toast]);

  return <div data-testid="bridge-count">{activeBridges.length}</div>;
}

// ---------------------------------------------------------------------------
// Fixtures + fetch sequencer
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
    state: "active",
    ...overrides,
  };
}

/** Installs a fetch mock that returns `responses[i]` on the i-th call,
 *  clamped to the last entry once exhausted (so a later poll keeps returning
 *  the final state, mirroring a steady-state backend). */
function mockFetchSequence(responses) {
  let call = 0;
  globalThis.fetch = vi.fn().mockImplementation(() => {
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

// ===========================================================================
// Bridge polling
// ===========================================================================

describe("App bridge poll — end-of-bridge toast", () => {
  it("toasts once, with the end reason, when an active bridge transitions to ended_capped", async () => {
    const toast = vi.fn();
    mockFetchSequence([
      { bridges: [bridgeRecord({ state: "active" })] },
      { bridges: [bridgeRecord({ state: "ended_capped", end_reason: "no answer at the round cap" })] },
      { bridges: [] }, // vanishes after — must NOT double-toast
    ]);

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {}); // flush the initial (immediate) fetchBridges() call

    expect(toast).not.toHaveBeenCalled(); // first poll only sees "active"

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Bridge Session 18 + 1 worker ended: no answer at the round cap",
      "info",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // Record already ended last poll, then vanished — no second toast.
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("uses error styling when a bridge ends in the errored state", async () => {
    const toast = vi.fn();
    mockFetchSequence([
      { bridges: [bridgeRecord({ state: "active" })] },
      { bridges: [bridgeRecord({ state: "errored" })] },
    ]);

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });

    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      "Bridge Session 18 + 1 worker failed — a session died or a write failed",
      "error",
    );
  });

  it("does not toast for a bridge that is already ended on the very first poll (reload mid-TTL)", async () => {
    const toast = vi.fn();
    mockFetchSequence([{ bridges: [bridgeRecord({ state: "ended_agreed" })] }]);

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {});

    expect(toast).not.toHaveBeenCalled();
  });

  it("stays silent when the poll fetch fails (soft-fail, matches existing polling behavior)", async () => {
    const toast = vi.fn();
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));

    await act(async () => {
      render(<BridgePollHarness toast={toast} />);
    });
    await act(async () => {});

    expect(toast).not.toHaveBeenCalled();
  });
});
