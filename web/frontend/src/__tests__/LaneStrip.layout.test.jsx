/**
 * LaneStrip layout-invariant tests.
 *
 * The design handoff requires `scrollWidth <= clientWidth` for the strip (no
 * horizontal scrollbar ever). jsdom does not perform real layout — every
 * element reports 0 for both scrollWidth and clientWidth — so an assertion
 * like `expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth)` would
 * pass vacuously (0 <= 0) regardless of whether the CSS is correct. That is
 * not a test; it is a false sense of security.
 *
 * Instead these tests assert the structural CSS properties that are what
 * actually PRODUCE the no-overflow behavior in a real browser: the fixed
 * elements (lane meter, + New chip) refuse to shrink so they never lose
 * their controls, and the variable elements (session chips) are allowed to
 * shrink and truncate so the fixed elements always have room, while the
 * container itself never masks overflow via `overflow: hidden` (which would
 * silently clip live chips rather than truncating them individually).
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import LaneStrip, { formatDuration } from "../components/shell/LaneStrip";

const sessions = [
  { id: "s1", name: "Session One", status: "idle" },
  { id: "s2", name: "Session Two", status: "busy" },
];

describe("LaneStrip layout invariants (structural, not a fake scrollWidth check)", () => {
  it("does not set overflow:hidden on the strip container itself", () => {
    const { container } = render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );
    const strip = container.firstChild;
    expect(strip.style.overflow).not.toBe("hidden");
  });

  it("session chips carry minWidth:0 and flexShrink:1 so they are the elements that give up space first", () => {
    const { getByLabelText } = render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );
    const chip = getByLabelText("Select session Session One");
    expect(chip.style.minWidth).toBe("0");
    expect(chip.style.flexShrink).toBe("1");
  });

  it("the + New chip refuses to shrink (flexShrink:0) — it must never lose its label to truncation", () => {
    const { getByLabelText } = render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
      />
    );
    const newChip = getByLabelText("Start a new session");
    expect(newChip.style.flexShrink).toBe("0");
  });

  it("the lane meter refuses to shrink (flexShrink:0) — the readout must stay fully visible", () => {
    const lane = {
      inFlight: 1,
      queued: 2,
      predictedWaitSeconds: 10,
      estimatedClearSeconds: 15,
    };
    const { getByTestId } = render(
      <LaneStrip
        sessions={sessions}
        paneSlotById={new Map()}
        focusedSessionId={null}
        poppedOutIds={new Set()}
        onSelectSession={() => {}}
        onNew={() => {}}
        lane={lane}
      />
    );
    const meter = getByTestId("lane-meter");
    expect(meter.style.flexShrink).toBe("0");
  });
});

describe("formatDuration (exported from LaneStrip.jsx)", () => {
  it("130 -> 2m10s", () => {
    expect(formatDuration(130)).toBe("2m10s");
  });

  it("60 -> 1m (no trailing 0s)", () => {
    expect(formatDuration(60)).toBe("1m");
  });

  it("45 -> 45s", () => {
    expect(formatDuration(45)).toBe("45s");
  });

  it("null -> —", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("NaN -> —", () => {
    expect(formatDuration(NaN)).toBe("—");
  });

  it("negative -> —", () => {
    expect(formatDuration(-5)).toBe("—");
  });
});
