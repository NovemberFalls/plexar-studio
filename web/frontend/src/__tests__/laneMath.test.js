/**
 * Regression tests for utils/laneMath.js.
 *
 * The file's own doc comment states the standing rule: unknown must render as
 * "—"/"n/a", never as 0. These tests exist to pin the boundary between
 * "unknown" (null) and "known and zero" for every function, since a future
 * edit that swaps `?? 0` for a real fallback would silently start lying.
 */
import { describe, it, expect } from "vitest";
import {
  fmtEta,
  laneLive,
  predictedWaitSeconds,
} from "../utils/laneMath";

describe("fmtEta boundaries", () => {
  it("returns null for non-finite input", () => {
    expect(fmtEta(NaN)).toBeNull();
    expect(fmtEta(Infinity)).toBeNull();
    expect(fmtEta(-Infinity)).toBeNull();
  });

  it("returns null for zero and negative input (non-positive)", () => {
    expect(fmtEta(0)).toBeNull();
    expect(fmtEta(-5)).toBeNull();
  });

  it("returns null for non-number input", () => {
    expect(fmtEta("60")).toBeNull();
    expect(fmtEta(null)).toBeNull();
    expect(fmtEta(undefined)).toBeNull();
  });

  it("59s stays in seconds form", () => {
    expect(fmtEta(59)).toBe("59s");
  });

  it("60s crosses into minutes form", () => {
    expect(fmtEta(60)).toBe("1m");
  });

  it("61s rounds to 1m (still under the 2m rounding boundary)", () => {
    expect(fmtEta(61)).toBe("1m");
  });

  it("3599s rounds its minute count up to 60 and THEN crosses into hour form — a boundary quirk of round-then-branch", () => {
    // Math.round(3599/60) = 60, and the code checks `m < 60` AFTER rounding,
    // so this does not stay at "59m" as a naive reading might expect.
    expect(fmtEta(3599)).toBe("1h0m");
  });

  it("3600s crosses into hours form", () => {
    expect(fmtEta(3600)).toBe("1h0m");
  });
});

describe("laneLive", () => {
  it("returns null when there is no engine block and the broker queue is unreachable", () => {
    expect(laneLive(null)).toBeNull();
    expect(laneLive({ reachable: false })).toBeNull();
  });

  it("prefers the engine-block path when metrics carry an engine object", () => {
    const metrics = {
      reachable: true,
      engine: { running: 1, waiting: 2 },
      run_time_ms: { p50: 2000 },
      decode_tokens_per_sec: { avg: 15 },
    };
    const live = laneLive(metrics);
    expect(live).toEqual({
      running: 1,
      queued: 2,
      tps: 15,
      etaSec: 6, // (1+2) * 2s
      total: 3,
      p50WallSeconds: 2,
    });
  });

  it("engine-block path tolerates missing p50 wall (etaSec null, not 0)", () => {
    const metrics = { reachable: true, engine: { running: 1, waiting: 0 } };
    const live = laneLive(metrics);
    expect(live.etaSec).toBeNull();
    expect(live.p50WallSeconds).toBeNull();
  });

  it("returns null when queue is unreachable and metrics have no usable engine block", () => {
    expect(laneLive({ reachable: true })).toBeNull();
  });
});

describe("predictedWaitSeconds", () => {
  it("returns null when p50WallSeconds is unknown/non-positive", () => {
    expect(predictedWaitSeconds(1, 2, null)).toBeNull();
    expect(predictedWaitSeconds(1, 2, 0)).toBeNull();
    expect(predictedWaitSeconds(1, 2, -1)).toBeNull();
    expect(predictedWaitSeconds(1, 2, NaN)).toBeNull();
  });

  it("multiplies (inFlight + aheadOfYou) by the wall time", () => {
    expect(predictedWaitSeconds(1, 2, 3)).toBe(9);
  });

  it("treats malformed counts as 0 rather than propagating null/NaN", () => {
    expect(predictedWaitSeconds(null, 2, 3)).toBe(6);
    expect(predictedWaitSeconds(NaN, 2, 3)).toBe(6);
    expect(predictedWaitSeconds(-1, 2, 3)).toBe(6);
  });
});

