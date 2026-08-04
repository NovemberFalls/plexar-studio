/**
 * Reports ▸ Tools — the long tail, which is where the card fell apart.
 *
 * MEASURED against this machine's real 7d report on 2026-08-03: 30 tools,
 * 3679 calls for Bash down to 1 call for PushNotification. A 3679:1 dynamic
 * range breaks three separate things at the BOTTOM of the card, which is
 * exactly the region the owner called garbled:
 *
 *   1. every row from Grep (37 calls) down was clamped to the same 1% bar
 *      stub, so 23 rows drew as identical -- a false claim of equality about
 *      figures that differ 37-fold. The file's own header comment claimed the
 *      max-scaled bar kept "a long tail still visible"; at this range it does
 *      the opposite.
 *   2. shares below 0.05% rendered "0.0%" -- a FABRICATED ZERO for a real
 *      measured call, which is the one thing format.js exists to forbid.
 *   3. every row carried a 9px sentence reading "N calls of the tool calls in
 *      this range" -- ungrammatical, restating the two numbers already on the
 *      row, and repeated 30 times. That repetition IS the visual noise.
 *
 * `Glob` (5 calls) sits precisely where the bars die and the shares hit zero,
 * which is why it was the row named.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import ToolsBreakdown from "../components/reports/ToolsBreakdown.jsx";
import { fmtPct } from "../components/reports/format.js";

/** The real shape of the tail, taken from the live report. */
const BY_TOOL = [
  { tool_name: "Bash", calls: 3679, share: 0.634201 },
  { tool_name: "Grep", calls: 37, share: 0.006378 },
  { tool_name: "Glob", calls: 5, share: 0.000862 },
  { tool_name: "PushNotification", calls: 1, share: 0.000172 },
];

const widthOf = (name) =>
  screen.getByTestId(`tool-bar-${name}`).style.width;

describe("ToolsBreakdown — the long tail", () => {
  /* NOTE, and it cost a prediction: the first version of this asserted
     Grep !== PushNotification and PASSED against the broken code, because the
     old formula gave Grep 1.0059...% and PushNotification a clamped 1%. Two
     different STRINGS, one indistinguishable pixel. The clamp is the defect,
     so the assertion has to be about the clamp: everything under the floor
     collapsed onto exactly the same width. */
  it("does not draw 5 calls and 1 call as the identical clamped bar", () => {
    render(<ToolsBreakdown byTool={BY_TOOL} />);
    expect(widthOf("Glob")).not.toBe(widthOf("PushNotification"));
  });

  it("keeps a sub-pixel row visible without overstating it", () => {
    render(<ToolsBreakdown byTool={BY_TOOL} />);
    // 1 call in 3679 must not be drawn as 1% of the leader -- that overstates
    // it 36-fold, which is how 23 rows came to look equal.
    const pct = parseFloat(widthOf("PushNotification"));
    expect(pct).toBeLessThan(1);
    expect(pct).toBeGreaterThan(0);
  });

  it("never restates the row's own numbers under every row", () => {
    render(<ToolsBreakdown byTool={BY_TOOL} />);
    expect(screen.queryAllByText(/of the tool calls in this range/i)).toHaveLength(0);
  });
});

describe("fmtPct — a measured call is never a zero", () => {
  it("does not round a real share down to 0.0%", () => {
    // 1 call in 5801. Small, but it HAPPENED.
    expect(fmtPct(0.000172)).not.toBe("0.0%");
  });

  it("still reports a true zero as zero", () => {
    expect(fmtPct(0)).toBe("0.0%");
  });
});
