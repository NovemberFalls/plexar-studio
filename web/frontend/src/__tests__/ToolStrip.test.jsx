/**
 * Tool-call strip (CHAT.md §6).
 *
 * The spec's own sentence is the acceptance criterion: "Reads as a quiet log,
 * never as a set of coloured cards." This is the surface most likely to drift
 * back toward 5a, because a tool call feels like it wants a status colour.
 *
 * The other rule is a leak guard: a tool INPUT can carry an entire file, so the
 * strip shows the verb and what it touched and nothing else.
 */

import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ToolStrip from "../components/chat/ToolStrip.jsx";

const CALLS = [
  { id: "t1", verb: "Read", targets: ["lane_broker/queue.py"] },
  { id: "t2", verb: "Grep", targets: ["_inflight"], is_error: true },
];

describe("ToolStrip", () => {
  it("renders nothing when a turn used no tools", () => {
    const { container } = render(<ToolStrip calls={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("is collapsed by default so a dozen reads cannot bury the answer", () => {
    render(<ToolStrip calls={CALLS} />);
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
    expect(screen.queryByText("lane_broker/queue.py")).toBeNull();
  });

  it("expands to the verb and what it touched", () => {
    render(<ToolStrip calls={CALLS} />);
    fireEvent.click(screen.getByLabelText("2 tool calls"));
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("lane_broker/queue.py")).toBeInTheDocument();
  });

  it("surfaces a failure count while still collapsed", () => {
    // The one thing worth knowing without expanding.
    render(<ToolStrip calls={CALLS} />);
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });

  it("uses NO hue — state is carried by brightness only", () => {
    // 6a's rule, and this is the component most likely to break it.
    const { container } = render(<ToolStrip calls={CALLS} />);
    fireEvent.click(screen.getByLabelText("2 tool calls"));
    const html = container.innerHTML;
    for (const hue of ["red", "green", "orange", "#f", "rgb("]) {
      expect(html.toLowerCase()).not.toContain(hue);
    }
    // And it does use the neutral ramp.
    expect(html).toContain("--cc-dim");
  });

  it("shows only what it was given, never raw arguments", () => {
    // The runner truncates to targets; the strip must not undo that by
    // rendering whatever it is handed.
    render(<ToolStrip calls={[
      { id: "t1", verb: "Write", targets: ["a.py"], input: { content: "SECRET" } },
    ]} />);
    fireEvent.click(screen.getByLabelText("1 tool call"));
    expect(screen.queryByText(/SECRET/)).toBeNull();
  });

  it("singularises a single call", () => {
    render(<ToolStrip calls={[CALLS[0]]} />);
    expect(screen.getByText("1 tool call")).toBeInTheDocument();
  });
});
