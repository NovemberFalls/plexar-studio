/**
 * Reports ▸ Tools — THE FOURTH DEFECT ON THIS PANEL, and the one that survived
 * the other three.
 *
 * The owner reported it twice, the second time with the detail that names the
 * mechanism: *"MCP_Branchive_repo_file is the bottom most and its collided with
 * 'ool calls have only been recorded'"* — the LAST row of the list painting on
 * top of the footer coverage note, whose leading "To" is what the row is
 * covering.
 *
 * THE MECHANISM, and why the three earlier fixes could not have caught it:
 * `ReportsView`'s body is `display:flex; flex-direction:column; overflow-y:auto`.
 * A flex item defaults to `flex-shrink: 1`, so the tools CARD is compressed to
 * the container's height instead of overflowing it and scrolling. The card is
 * itself a column flex box: header and footer note are `flexShrink: 0`, and the
 * rows region carried `minHeight: 0` — which is precisely the instruction
 * "you may collapse below your content". It does, its 30 rows overflow their
 * box, and because the note is a LATER sibling in the same stacking context the
 * note paints on top of the overflowing last row. The collision.
 *
 * THE BAR-WIDTH CLAMP, THE FABRICATED 0.0% AND THE 30 REPEATED CAPTIONS WERE
 * ALL DEFECTS OF A ROW. THIS IS A DEFECT OF THE BOX, so nothing that fixed a
 * row could touch it, and it is invisible to a short fixture: five rows fit,
 * so the card is never compressed and nothing overflows. That is why the
 * fixture here is 30 rows long and carries a name at least as long as
 * `MCP_Branchive_repo_file`.
 *
 * jsdom does no layout, so this gate cannot measure the overlap in pixels. It
 * pins the two structural properties whose ABSENCE is the overlap: the card may
 * not be shrunk by its parent, and the rows region may not collapse below its
 * content. Both are inline styles, both are readable, and both were wrong.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import ToolsBreakdown from "../components/reports/ToolsBreakdown";

/** His real list shape: MCP names are far longer than `glob` or `read`. */
const LONGEST = "MCP_Branchive_repo_file";
const BY_TOOL = [
  { tool_name: "Bash", calls: 3679, share: 0.41 },
  { tool_name: "Read", calls: 2140, share: 0.24 },
  { tool_name: "Edit", calls: 981, share: 0.11 },
  ...Array.from({ length: 26 }, (_, i) => ({
    tool_name: `MCP_Branchive_tool_${i}`,
    calls: 40 - i,
    share: 0.001,
  })),
  { tool_name: LONGEST, calls: 1, share: 0.0001 },
];

const NOTE =
  "Tool calls have only been recorded since Jul 30, 2026, and this range starts before that.";

describe("Reports ▸ Tools — the list cannot collide with the coverage note", () => {
  it("renders the long fixture: 30 rows, the longest name last, and the note", () => {
    render(<ToolsBreakdown byTool={BY_TOOL} note={NOTE} />);
    expect(BY_TOOL).toHaveLength(30);
    expect(screen.getByTestId(`tool-row-${LONGEST}`)).toBeInTheDocument();
    expect(screen.getByTestId("tools-coverage-note")).toHaveTextContent(
      /only been recorded since/
    );
    // The fixture must actually be able to produce the bug, or the gate is
    // vacuous: a name shorter than the one he reported proves nothing.
    expect(LONGEST.length).toBeGreaterThanOrEqual("MCP_Branchive_repo_file".length);
  });

  it("the card refuses to be compressed by its scrolling parent", () => {
    render(<ToolsBreakdown byTool={BY_TOOL} note={NOTE} />);
    // flex-shrink: 1 (the default) is the whole defect. The parent scrolls; the
    // card must overflow it and be scrolled to, never squeezed into it.
    expect(screen.getByTestId("tools-breakdown")).toHaveStyle({ flexShrink: "0" });
  });

  it("the rows region refuses to collapse below its own content", () => {
    render(<ToolsBreakdown byTool={BY_TOOL} note={NOTE} />);
    const rows = screen.getByTestId("tools-rows");
    // `minHeight: 0` here is the instruction that lets 30 rows overflow an
    // 8-row box and paint into the footer. It must not come back.
    expect(rows).toHaveStyle({ flexShrink: "0" });
    expect(rows.style.minHeight).not.toBe("0px");
  });
});
