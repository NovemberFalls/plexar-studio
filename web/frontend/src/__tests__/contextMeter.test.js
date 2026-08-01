/**
 * Context meter (CHAT.md §7).
 *
 * The rule these pin: a limit we do not know is null, and a null limit draws
 * NO BAR. Inventing a denominator to have something to render would make the
 * most reassuring state — a nearly empty bar — the one shown when we
 * understand the least.
 */

import { describe, it, expect } from "vitest";

import { meter, contextLimitFor, usedTokens, fmtTokens } from "../components/chat/contextMeter.js";

const turn = (input_tokens) => ({ role: "assistant", input_tokens });

describe("contextLimitFor", () => {
  it("knows the windows for models Cockpit offers", () => {
    expect(contextLimitFor("claude-opus-5")).toBe(200_000);
    expect(contextLimitFor("claude-opus-5[1m]")).toBe(1_000_000);
  });

  it("reads the [1m] marker even on an id the table has not caught up with", () => {
    expect(contextLimitFor("claude-future-9[1m]")).toBe(1_000_000);
  });

  it("returns null for an unknown model rather than guessing", () => {
    // A wrong denominator is worse than an absent one.
    expect(contextLimitFor("some-local-model")).toBeNull();
    expect(contextLimitFor(null)).toBeNull();
  });
});

describe("usedTokens", () => {
  it("takes the most recent turn that reported a count", () => {
    expect(usedTokens([turn(100), turn(20_000)])).toBe(20_000);
  });

  it("skips turns that reported nothing rather than treating them as zero", () => {
    expect(usedTokens([turn(20_000), turn(null), turn(undefined)])).toBe(20_000);
  });

  it("is null when nothing has ever reported", () => {
    expect(usedTokens([])).toBeNull();
    expect(usedTokens([turn(null)])).toBeNull();
  });
});

describe("meter", () => {
  it("draws no bar when the limit is unknown, but still shows what was used", () => {
    const m = meter([turn(20_000)], "some-local-model");
    expect(m.pct).toBeNull();
    expect(m.label).toBe("context 20.0k");
  });

  it("draws no bar and no figure before anything has been measured", () => {
    const m = meter([], "claude-opus-5");
    expect(m.pct).toBeNull();
    expect(m.label).toBe("context —");
  });

  it("reports a proportion when both numbers are known", () => {
    const m = meter([turn(20_000)], "claude-opus-5");
    expect(m.pct).toBeCloseTo(10);
    expect(m.label).toBe("context 20.0k / 200.0k");
    expect(m.over).toBe(false);
  });

  it("flags a conversation past its window", () => {
    // Not a rounding error — the next turn will be refused.
    const m = meter([turn(260_000)], "claude-opus-5");
    expect(m.over).toBe(true);
    expect(m.pct).toBe(100, "the bar clamps rather than overflowing its track");
  });

  it("scales a 1M window without pretending it is full", () => {
    const m = meter([turn(20_000)], "claude-opus-5[1m]");
    expect(m.pct).toBeCloseTo(2);
  });
});

describe("fmtTokens", () => {
  it("abbreviates without losing the magnitude", () => {
    expect(fmtTokens(950)).toBe("950");
    expect(fmtTokens(20_592)).toBe("20.6k");
    expect(fmtTokens(1_200_000)).toBe("1.2M");
  });

  it("returns null for a non-number rather than NaN", () => {
    expect(fmtTokens(null)).toBeNull();
    expect(fmtTokens(undefined)).toBeNull();
  });
});
