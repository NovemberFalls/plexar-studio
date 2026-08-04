import { describe, it, expect, vi } from "vitest";
import {
  diagnoseSocketFailure,
  WS_REFUSED,
  WS_BACKEND_DOWN,
  WS_UNKNOWN,
  REFUSED_MESSAGE,
} from "../wsDiagnose";

describe("diagnoseSocketFailure", () => {
  it("reports REFUSED when the server answers 403", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 403 });
    expect(await diagnoseSocketFailure(fetchImpl)).toBe(WS_REFUSED);
  });

  it("reports DOWN when nothing answers", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await diagnoseSocketFailure(fetchImpl)).toBe(WS_BACKEND_DOWN);
  });

  it("reports UNKNOWN when the server answers normally", async () => {
    // The socket failed for some other reason. Claiming an origin problem we did
    // not observe is the same class of false statement this module removes.
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    expect(await diagnoseSocketFailure(fetchImpl)).toBe(WS_UNKNOWN);
  });

  it("does not report REFUSED for other error statuses", async () => {
    for (const status of [401, 404, 500, 502]) {
      const fetchImpl = vi.fn().mockResolvedValue({ status });
      expect(await diagnoseSocketFailure(fetchImpl)).toBe(WS_UNKNOWN);
    }
  });

  it("probes the same relative path the page's other calls use", async () => {
    // Relative, so it travels the Vite proxy in dev and the app origin in prod —
    // if the origin is refused, this 403s for the same reason the socket did.
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200 });
    await diagnoseSocketFailure(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("/api/version", { cache: "no-store" });
  });

  it("says reload, and does not say the backend is down", () => {
    expect(REFUSED_MESSAGE).toMatch(/reload/i);
    expect(REFUSED_MESSAGE).not.toMatch(/backend down|waiting for recovery/i);
  });
});
