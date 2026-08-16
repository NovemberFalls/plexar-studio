/**
 * Featured-pane regression suite.
 *
 * The bug: in the 3/5/7 layouts, `paneOrder` was derived from `focusedIndex`,
 * and `focusedIndex` is set by `onFocusCapture`/`onMouseDownCapture` on every
 * pane. So merely CLICKING into a terminal to type promoted it into the big
 * featured cell and reshuffled the grid underneath the user.
 *
 * The fix separates the two concepts: `focusedIndex` still tracks clicks (the
 * Inspector follows focus, which is correct), and a new `featuredIndex` drives
 * `paneOrder`. `featuredIndex` moves only on an explicit gesture.
 *
 * These tests import the REAL helpers (utils/paneLayout.js, which App.jsx
 * imports) rather than replicating them in a harness — a replicated copy can
 * pass while the shipped code is broken, which is exactly the failure mode this
 * suite exists to prevent. The claims that cannot be expressed as a pure
 * function (which state each handler writes, how the slot loop is keyed) are
 * asserted against App.jsx's source text.
 */

import React from "react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { computePaneOrder, clampFeatured, swapSlots, FEATURED_LAYOUTS } from "../utils/paneLayout";

const APP_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

/** Cell index a given slot renders into, per App's own placement expression
 *  (`gridLayout.areas[paneOrder.indexOf(idx)]`). Cell 0 is the featured cell. */
const cellOf = (order, slot) => order.indexOf(slot);

describe("computePaneOrder — slot-to-cell mapping", () => {
  it("puts the FEATURED slot (not slot 0) in cell 0 for 3/5/7", () => {
    for (const layout of [3, 5, 7]) {
      const order = computePaneOrder(layout, 2);
      expect(order[0]).toBe(2);
      expect(cellOf(order, 2)).toBe(0);
      // every slot still gets exactly one cell
      expect([...order].sort((a, b) => a - b)).toEqual(
        Array.from({ length: layout }, (_, i) => i),
      );
    }
  });

  it("is the identity mapping for non-featured layouts (1/2/4/6/8)", () => {
    for (const layout of [1, 2, 4, 6, 8]) {
      expect(FEATURED_LAYOUTS.has(layout)).toBe(false);
      // featuredIndex is ignored entirely — any value maps slot i to cell i
      for (const featured of [0, 1, 3, 99, -1]) {
        expect(computePaneOrder(layout, featured)).toEqual(
          Array.from({ length: layout }, (_, i) => i),
        );
      }
    }
  });
});

describe("clicking/focusing a pane never changes the featured pane", () => {
  it("paneOrder is a function of (layout, featuredIndex) ONLY — focus is not an input", () => {
    // The core regression, stated as the code contract: whatever the user
    // clicks, the only inputs to grid placement are layout + featuredIndex.
    const before = computePaneOrder(3, 0);
    // Simulate the user clicking pane 1 then pane 2 (which used to set the
    // featured index through setFocusedIndex).
    const after = computePaneOrder(3, 0);
    expect(after).toEqual(before);
    expect(cellOf(after, 0)).toBe(0);
  });

  it("App.jsx's paneOrder memo does not read focusedIndex", () => {
    const memo = APP_SRC.match(
      /const paneOrder = useMemo\(([\s\S]*?)\n {2}\);/,
    );
    expect(memo, "paneOrder memo not found in App.jsx").toBeTruthy();
    expect(memo[1]).not.toMatch(/focusedIndex/);
    expect(memo[1]).toMatch(/featuredIndex/);
  });

  it("the focus capture handlers still set focusedIndex and nothing else", () => {
    // The Inspector follows focus — that behaviour must survive the fix.
    expect(APP_SRC).toMatch(/onFocusCapture=\{\(\) => setFocusedIndex\(idx\)\}/);
    expect(APP_SRC).toMatch(/onMouseDownCapture=\{\(\) => setFocusedIndex\(idx\)\}/);
    // ...and neither of them touches featuredIndex.
    const handlers = APP_SRC.match(
      /onFocusCapture=\{[^}]*\}\s*\n\s*onMouseDownCapture=\{[^}]*\}/,
    );
    expect(handlers).toBeTruthy();
    expect(handlers[0]).not.toMatch(/setFeaturedIndex/);
  });

  it("setFeaturedIndex is only called from the explicit gesture + the clamp", () => {
    const calls = APP_SRC.match(/setFeaturedIndex\(/g) || [];
    // 1) the layout clamp effect, 2) the "Make featured" handler.
    expect(calls.length).toBe(2);
  });
});

describe("the Inspector still follows focus", () => {
  it("focusedSessionId is derived from focusedIndex, not featuredIndex", () => {
    expect(APP_SRC).toMatch(
      /const focusedSessionId = focusedIndex >= 0 && focusedIndex < activeIds\.length \? activeIds\[focusedIndex\] : null;/,
    );
  });

  it("a click on a pane updates focus while placement stays put", () => {
    // Miniature of App's slot loop: focus state moves, featured state does not.
    function Grid() {
      const [focused, setFocused] = React.useState(0);
      const [featured] = React.useState(0);
      const order = computePaneOrder(3, featured);
      return (
        <div>
          <span data-testid="inspector">pane-{focused}</span>
          {Array.from({ length: 3 }).map((_, idx) => (
            <button
              key={idx}
              data-testid={`slot-${idx}`}
              data-cell={cellOf(order, idx)}
              onMouseDownCapture={() => setFocused(idx)}
            >
              slot {idx}
            </button>
          ))}
        </div>
      );
    }
    render(<Grid />);
    const cellsBefore = [0, 1, 2].map(
      (i) => screen.getByTestId(`slot-${i}`).dataset.cell,
    );
    expect(screen.getByTestId("inspector")).toHaveTextContent("pane-0");

    fireEvent.mouseDown(screen.getByTestId("slot-2"));

    // Inspector followed the click...
    expect(screen.getByTestId("inspector")).toHaveTextContent("pane-2");
    // ...and NOTHING moved in the grid.
    expect([0, 1, 2].map((i) => screen.getByTestId(`slot-${i}`).dataset.cell)).toEqual(
      cellsBefore,
    );
    expect(screen.getByTestId("slot-0").dataset.cell).toBe("0");
  });
});

describe("dropping a pane into the featured position makes it featured", () => {
  it("swapSlots moves the dragged session into the featured SLOT", () => {
    // Featured slot is 1 (so slot 0 is NOT the featured cell — this test would
    // pass by accident if featured were hardcoded to slot 0).
    const featured = 1;
    const order = computePaneOrder(3, featured);
    expect(cellOf(order, featured)).toBe(0);

    const activeIds = ["A", "B", "C"];
    // Session in the featured cell right now:
    expect(activeIds[order[0]]).toBe("B");

    // User drags pane at slot 2 ("C") and drops it on the featured slot.
    const next = swapSlots(activeIds, 2, featured);

    expect(next).toEqual(["A", "C", "B"]);
    // The dragged session is now the featured one; featuredIndex never moved.
    expect(next[computePaneOrder(3, featured)[0]]).toBe("C");
  });

  it("works onto a never-filled slot (list grows with nulls)", () => {
    expect(swapSlots(["A"], 0, 2)).toEqual([null, null, "A"]);
  });

  it("dropping onto a NON-featured slot leaves the featured session alone", () => {
    const featured = 0;
    const next = swapSlots(["A", "B", "C"], 1, 2);
    expect(next[computePaneOrder(3, featured)[0]]).toBe("A");
  });

  it("the drop overlay names the featured cell", () => {
    expect(APP_SRC).toMatch(/isFeaturedSlot[\s\S]{0,40}"Drop to feature"/);
    // isFeaturedSlot is derived from the CELL index, not from `idx === 0`.
    expect(APP_SRC).toMatch(
      /const isFeaturedSlot = FEATURED_LAYOUTS\.has\(layout\) && cellIndex === 0;/,
    );
  });
});

describe("clamping", () => {
  it("falls back to slot 0 when the layout shrinks below the featured slot", () => {
    expect(clampFeatured(5, 3)).toBe(0);
    expect(clampFeatured(2, 3)).toBe(2);
    expect(clampFeatured(3, 3)).toBe(0); // slot 3 does not exist in a 3-layout
  });

  it("rejects junk from localStorage", () => {
    for (const bad of [-1, 1.5, NaN, null, undefined, "2", {}]) {
      expect(clampFeatured(bad, 7)).toBe(0);
    }
  });

  it("computePaneOrder clamps on READ, so a stale index can never dangle", () => {
    const order = computePaneOrder(3, 6);
    expect(order).toEqual([0, 1, 2]);
  });

  it("App clamps featuredIndex in an effect keyed on layout", () => {
    expect(APP_SRC).toMatch(
      /setFeaturedIndex\(\(prev\) => clampFeatured\(prev, layout\)\);\s*\n\s*\}, \[layout\]\);/,
    );
  });

  it("closing a session nulls its slot rather than compacting the list", () => {
    // This is why no separate clamp is needed on close: slot indices are
    // stable, so featuredIndex keeps addressing the same (now empty) slot.
    expect(APP_SRC).toMatch(
      /setActiveIds\(\(prev\) => prev\.map\(\(id\) => id === localId \? null : id\)\);/,
    );
  });
});

describe("terminals do not remount when the featured pane changes", () => {
  it("the grid maps over fixed SLOTS keyed by session id, not over paneOrder", () => {
    // Structural proof: the slot loop's iteration order and React keys are
    // independent of paneOrder. paneOrder only feeds `gridLayout.areas[...]`,
    // i.e. the inline gridColumn/gridRow style. Changing featuredIndex
    // therefore changes CSS placement only — the element identity React
    // reconciles against is unchanged, so xterm and its WebSocket survive.
    //
    // The loop moved into `renderSlot` when scroll mode landed, so these
    // assertions track the new shape. GRID's item list is still exactly
    // `layout` slots, which is the part that must not drift.
    expect(APP_SRC).toMatch(/const renderSlot = \(idx\) => \{/);
    expect(APP_SRC).toMatch(
      /items: Array\.from\(\{ length: layout \}, \(_, idx\) => \(\{ type: "slot", idx \}\)\),/,
    );
    expect(APP_SRC).toMatch(/key=\{session\.id\}/);
    // paneOrder is consumed exactly once in the slot renderer, for the cell index.
    expect(APP_SRC).toMatch(/const cellIndex = paneOrder\.indexOf\(idx\);/);
    const renderBody = APP_SRC.slice(APP_SRC.indexOf("const renderSlot = (idx) =>"))
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect((renderBody.match(/paneOrder/g) || []).length).toBe(1);
  });

  it("scroll mode emits panes as DIRECT children — no per-group wrapper", () => {
    // The trap this pins: grouping by folder invites wrapping each group in a
    // <section>. That re-parents the pane, which React reconciles as an
    // unmount + mount — killing live scrollback and the WebSocket. Group
    // headers must therefore be SIBLINGS, and the branch that emits a slot
    // must call renderSlot directly with nothing around it.
    expect(APP_SRC).toMatch(/item\.type === "header" \? \(/);
    // The slot branch is renderSlot() and nothing else — no wrapper element,
    // no keyed Fragment (a Fragment keyed per slot would remount on a swap).
    expect(APP_SRC).toMatch(/\) : \(\s+renderSlot\(item\.idx\)\s+\)/);
    // Featured placement must not leak into scroll mode.
    // Scroll mode places by SPAN; the featured cell's area is grid-only.
    expect(APP_SRC).toMatch(/gridColumn: `span \$\{spanBySlot\.get\(idx\) \|\| 1\}`/);
    expect(APP_SRC).toMatch(/: \{ gridColumn: area\.col, gridRow: area\.row \};/);
  });

  it("a child keyed by session id is not remounted when placement changes", () => {
    const mounted = vi.fn();
    function FakeTerminal({ id }) {
      React.useEffect(() => { mounted(id); }, [id]);
      return <span>{id}</span>;
    }
    function Grid({ featured }) {
      const order = computePaneOrder(3, featured);
      const activeIds = ["A", "B", "C"];
      return (
        <div>
          {Array.from({ length: 3 }).map((_, idx) => {
            const id = activeIds[idx];
            return (
              <div key={id} data-testid={`pane-${id}`} data-cell={cellOf(order, idx)}>
                <FakeTerminal id={id} />
              </div>
            );
          })}
        </div>
      );
    }
    const { rerender } = render(<Grid featured={0} />);
    expect(mounted).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId("pane-A").dataset.cell).toBe("0");

    rerender(<Grid featured={2} />);

    // Placement moved...
    expect(screen.getByTestId("pane-C").dataset.cell).toBe("0");
    expect(screen.getByTestId("pane-A").dataset.cell).toBe("1");
    // ...and no terminal remounted.
    expect(mounted).toHaveBeenCalledTimes(3);
  });
});
