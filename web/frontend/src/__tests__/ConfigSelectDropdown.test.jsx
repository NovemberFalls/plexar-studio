/**
 * ConfigSelect (NewSessionDialog) — the dropdown whose options could not be
 * selected.
 *
 * THE BUG: the panel rendered with `bottom: 100%` (always upward), no
 * max-height and no scrolling, inside a confirm block that sets
 * `overflowY: auto`. The Effort select sits near the bottom of the modal, so
 * its first two options -- `Auto` and `Low` -- were pushed above the clipping
 * ancestor's top edge with no way to scroll to them. The owner could not pick
 * `Low` at all.
 *
 * What is asserted here:
 *   - EVERY option, first and last included, is present and clickable
 *   - picking `Low` (the unreachable one) calls onChange("low")
 *   - the panel carries a bounded height and scrolls for a long list
 *   - direction is computed from the trigger's real rect, both ways
 *   - Escape closes (and does NOT bubble out to cancel the dialog)
 *   - arrow keys reach the first option
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ConfigSelect } from "../components/NewSessionDialog";
import { computeSelectPlacement } from "../components/selectPlacement";
import { EFFORT_OPTIONS } from "../sessionVocabulary";

const rect = (over = {}) => ({
  top: 0, bottom: 0, left: 0, right: 0, width: 160, height: 34, x: 0, y: 0, toJSON() {},
  ...over,
});

/** Render an Effort select and pin the trigger's rect so placement is testable. */
function renderEffort(triggerRect = rect({ top: 700, bottom: 734 })) {
  const onChange = vi.fn();
  render(<ConfigSelect label="Effort" value="" options={EFFORT_OPTIONS} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Effort" });
  trigger.getBoundingClientRect = () => triggerRect;
  return { onChange, trigger };
}

describe("ConfigSelect — every option is reachable", () => {
  it("renders every effort option, including the first and last, when open", () => {
    const { trigger } = renderEffort();
    fireEvent.click(trigger);
    for (const o of EFFORT_OPTIONS) {
      expect(screen.getByRole("button", { name: o.label })).toBeInTheDocument();
    }
    // Named explicitly: these are the two the owner could not reach.
    expect(screen.getByRole("button", { name: EFFORT_OPTIONS[0].label })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Low" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: EFFORT_OPTIONS[EFFORT_OPTIONS.length - 1].label })
    ).toBeInTheDocument();
  });

  it("selecting Low — the option that was cut off — calls onChange('low')", () => {
    const { onChange, trigger } = renderEffort();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Low" }));
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("escapes the modal's clipping ancestor by portalling to document.body", () => {
    const { trigger } = renderEffort();
    fireEvent.click(trigger);
    const panel = screen.getByTestId("config-select-panel-effort");
    // Not a descendant of the trigger's own subtree/container -> nothing in the
    // dialog's overflow chain can clip it.
    expect(panel.closest("[data-testid]")).toBe(panel);
    expect(document.body.contains(panel)).toBe(true);
    expect(trigger.parentElement.contains(panel)).toBe(false);
  });

  it("bounds the panel height and scrolls when the option list is long", () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, label: `Model ${i}` }));
    render(<ConfigSelect label="Model" value="m0" options={long} onChange={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Model" });
    trigger.getBoundingClientRect = () => rect({ top: 300, bottom: 334 });
    fireEvent.click(trigger);
    const panel = screen.getByTestId("config-select-panel-model");
    expect(panel.style.overflowY).toBe("auto");
    const maxHeight = parseInt(panel.style.maxHeight, 10);
    expect(maxHeight).toBeGreaterThan(0);
    expect(maxHeight).toBeLessThanOrEqual(280);
    // First AND last of a 60-long list are both rendered and clickable.
    expect(screen.getByRole("button", { name: "Model 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model 59" })).toBeInTheDocument();
  });
});

describe("ConfigSelect — direction follows available space", () => {
  it("opens downward when there is room below", () => {
    const { trigger } = renderEffort(rect({ top: 40, bottom: 74 }));
    fireEvent.click(trigger);
    expect(screen.getByTestId("config-select-panel-effort").dataset.placement).toBe("down");
  });

  it("flips upward when the trigger is pinned to the bottom of the viewport", () => {
    const h = window.innerHeight;
    const { trigger } = renderEffort(rect({ top: h - 44, bottom: h - 10 }));
    fireEvent.click(trigger);
    expect(screen.getByTestId("config-select-panel-effort").dataset.placement).toBe("up");
  });

  it("computeSelectPlacement picks the roomier side when neither fits fully", () => {
    // 400px viewport: 100 above, ~250 below -> down wins, height clamped to fit.
    const down = computeSelectPlacement(rect({ top: 110, bottom: 144 }), 400);
    expect(down.placement).toBe("down");
    expect(down.style.maxHeight).toBeLessThan(280);
    // Same viewport, trigger low: 250 above, ~100 below -> up wins.
    const up = computeSelectPlacement(rect({ top: 260, bottom: 294 }), 400);
    expect(up.placement).toBe("up");
    expect(up.style.bottom).toBeGreaterThan(0);
  });
});

describe("ConfigSelect — keyboard", () => {
  it("Escape closes the panel", () => {
    const { trigger } = renderEffort();
    fireEvent.click(trigger);
    expect(screen.getByTestId("config-select-panel-effort")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement || trigger, { key: "Escape" });
    expect(screen.queryByTestId("config-select-panel-effort")).not.toBeInTheDocument();
  });

  it("ArrowDown from the closed trigger opens and focuses the FIRST option", () => {
    const { trigger } = renderEffort();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.getByTestId("config-select-panel-effort")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: EFFORT_OPTIONS[0].label }));
  });

  it("ArrowDown walks to the next option and Enter-equivalent click selects it", () => {
    const { onChange, trigger } = renderEffort();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: EFFORT_OPTIONS[1].label }));
    fireEvent.click(document.activeElement);
    expect(onChange).toHaveBeenCalledWith(EFFORT_OPTIONS[1].id);
  });

  it("Escape inside the panel does not bubble out to the dialog's cancel handler", () => {
    const onCancel = vi.fn();
    render(
      <div onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
        <ConfigSelect label="Effort" value="" options={EFFORT_OPTIONS} onChange={vi.fn()} />
      </div>
    );
    const trigger = screen.getByRole("button", { name: "Effort" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(screen.queryByTestId("config-select-panel-effort")).not.toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
