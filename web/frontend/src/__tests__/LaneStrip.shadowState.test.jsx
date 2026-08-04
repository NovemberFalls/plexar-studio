/**
 * S10 — the lane strip must say WHICH state it is in and WHY.
 *
 * Measured in `lane_broker/tests/test_shadow_default_is_inert.py`: under
 * Plexar Studio's shipped default the broker forwards and logs but NEVER queues, and
 * a spill threshold of 0.0 seconds with seeded history still produces zero
 * spills. So the live meter's "0 in flight, 0 queued" is not a measurement —
 * it is a structural constant.
 *
 * THREE STATES, and the two failure modes are opposite lies:
 *   live    — queueing on, the numbers mean something.
 *   shadow  — queueing exists and is SWITCHED OFF. Rendering the live meter
 *             here claims an idle lane; that is the first lie.
 *   absent  — no lane data at all. Rendering nothing for `shadow` would make
 *             "switched off" identical to "no such feature"; that is the
 *             second lie, and it is exactly what S9 removed from the model
 *             picker (an omitted provider and a refused one looked alike).
 *
 * ── LIMITATION, STATED RATHER THAN IMPLIED ─────────────────────────────────
 * These assertions compare RENDERED OUTPUT FOR TWO STATE OBJECTS. They do not
 * compare two real builds — this suite cannot start a broker with
 * COCKPIT_BROKER_SHADOW=0 and drive the UI against it. That the `shadow` flag
 * corresponds to real queueing behaviour is established separately, against a
 * real broker subprocess, in `test_shadow_default_is_inert.py`. Read the two
 * together: that suite proves the flag means what it says, this one proves the
 * UI tells the truth about the flag. Neither claim covers the other.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import LaneStrip from "../components/shell/LaneStrip";

const sessions = [{ id: "s1", name: "Session One", status: "idle" }];

const LIVE_LANE = {
  inFlight: 2,
  queued: 3,
  predictedWaitSeconds: 40,
  thresholdSeconds: 30,
  estimatedClearSeconds: 60,
  shadow: false,
};

const SHADOW_LANE = {
  // Deliberately the SAME numbers a shadow broker actually reports: all zero.
  inFlight: 0,
  queued: 0,
  predictedWaitSeconds: null,
  thresholdSeconds: 30,
  estimatedClearSeconds: null,
  shadow: true,
};

function renderStrip(lane) {
  return render(
    <LaneStrip sessions={sessions} lane={lane} spillEnabled={true} />
  );
}

describe("LaneStrip: queueing-off must be visible, and must not look like idle or like absent", () => {
  it("SHADOW — says queueing is off, names shadow as the reason, and names the fix", () => {
    const { getByTestId } = renderStrip(SHADOW_LANE);
    const note = getByTestId("lane-shadow-note");
    const described = `${note.getAttribute("title")} ${note.getAttribute("aria-label")}`;

    // WHICH state.
    expect(described).toMatch(/not active/i);
    // WHY.
    expect(described).toMatch(/shadow/i);
    // WHAT WOULD CHANGE IT -- a state note that only diagnoses is half a note.
    expect(described).toMatch(/COCKPIT_BROKER_SHADOW=0/);
  });

  it("SHADOW — does NOT render the live pressure numbers", () => {
    const { queryByTestId, container } = renderStrip(SHADOW_LANE);
    expect(queryByTestId("lane-shadow-note")).not.toBeNull();
    // The live meter's sentence is the thing that would be false here.
    expect(container.textContent).not.toMatch(/in flight/i);
  });

  it("LIVE — renders the meter and NOT the shadow note", () => {
    const { queryByTestId, container } = renderStrip(LIVE_LANE);
    expect(queryByTestId("lane-shadow-note")).toBeNull();
    const meter = container.querySelector('[aria-label*="in flight"]');
    expect(meter).not.toBeNull();
    expect(meter.getAttribute("aria-label")).toMatch(/2 in flight, 3 queued/);
  });

  it("ABSENT — no lane data renders neither, which is a THIRD thing", () => {
    const { queryByTestId, container } = renderStrip(null);
    expect(queryByTestId("lane-shadow-note")).toBeNull();
    expect(container.querySelector('[aria-label*="in flight"]')).toBeNull();
  });

  it("the three states are pairwise distinct (the regression guard)", () => {
    // Per-state assertions pass straight through two states becoming EQUAL,
    // which is the failure mode of every collapse bug in this repo. Compare
    // the states to each other.
    const shape = (lane) => {
      const { container } = renderStrip(lane);
      return JSON.stringify([
        container.querySelector('[data-testid="lane-shadow-note"]') != null,
        container.querySelector('[aria-label*="in flight"]') != null,
      ]);
    };
    const live = shape(LIVE_LANE);
    const shadow = shape(SHADOW_LANE);
    const absent = shape(null);

    expect(live).not.toBe(shadow);
    expect(live).not.toBe(absent);
    // The one that mattered: switched-off must not look like not-a-feature.
    expect(shadow).not.toBe(absent);
  });

  it("a shadow lane and an IDLE live lane are distinguishable", () => {
    // The sharpest case. A genuinely idle queueing broker reports 0/0 too, so
    // the numbers alone cannot tell these apart -- only the flag can. If this
    // ever fails, the strip is back to inferring state from a depth of zero.
    // IDENTICAL in every field except the flag. An earlier version of this
    // test also varied the numbers, and it passed with the fix reverted --
    // it was distinguishing "0s" from an em dash, not shadow from idle. A
    // guard that passes without the code it guards is worse than no guard.
    const idleLive = { ...SHADOW_LANE, shadow: false };
    const a = renderStrip(SHADOW_LANE).container.textContent;
    const b = renderStrip(idleLive).container.textContent;
    expect(a).not.toBe(b);
  });
});
