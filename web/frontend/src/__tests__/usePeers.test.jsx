import React, { useEffect } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import usePeers, { usePeersPoller, __resetPeersStore, PEER_POLL_MS, PEER_RECHECK_MS } from "../hooks/usePeers";

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const seen = {};
function Probe() {
  usePeersPoller(true);
  const s = usePeers();
  useEffect(() => { seen.snap = s; });
  return null;
}

let sessionsAnswer;
beforeEach(() => {
  __resetPeersStore();
  vi.useFakeTimers();
  sessionsAnswer = res(200, { sessions: [{ id: "s1", name: "one" }] });
  globalThis.fetch = vi.fn(async (url) => {
    if (url === "/api/peers") return res(200, { peers: [{ id: "p1", label: "Desk" }] });
    if (url === "/api/peers/p1/status") return res(200, { reachable: true, authorized: true, reason: null });
    if (url === "/api/peers/p1/sessions") return sessionsAnswer;
    return res(404, {});
  });
});
afterEach(() => vi.useRealTimers());

const calls = (u) => globalThis.fetch.mock.calls.filter(([x]) => x === u).length;
const flush = () => act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); });

describe("usePeersPoller", () => {
  it("polls a reachable peer every 5 s and stops the list poll on unauthorized", async () => {
    render(<Probe />);
    await flush();
    await flush();
    expect(seen.snap.live.p1.sessions).toEqual([{ id: "s1", name: "one" }]);
    expect(calls("/api/peers/p1/sessions")).toBe(1);

    await act(async () => { vi.advanceTimersByTime(PEER_POLL_MS); });
    await flush();
    expect(calls("/api/peers/p1/sessions")).toBe(2);

    sessionsAnswer = res(401, { reason: "unauthorized" });
    await act(async () => { vi.advanceTimersByTime(PEER_POLL_MS); });
    await flush();
    expect(seen.snap.live.p1.status.reason).toBe("unauthorized");
    const before = calls("/api/peers/p1/sessions");
    await act(async () => { vi.advanceTimersByTime(PEER_POLL_MS * 3); });
    await flush();
    expect(calls("/api/peers/p1/sessions")).toBe(before);

    // Only /status rechecks, on the slow cadence.
    await act(async () => { vi.advanceTimersByTime(PEER_RECHECK_MS); });
    await flush();
    expect(calls("/api/peers/p1/status")).toBeGreaterThanOrEqual(2);
  });
});
