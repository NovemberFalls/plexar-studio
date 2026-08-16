/**
 * Scroll mode's fill-width packing.
 *
 * Every pane is a direct child of ONE grid (re-parenting remounts terminals),
 * so a single column template must serve every folder at once. Fill-width
 * solves that with an LCM track count and a per-group span. The arithmetic is
 * re-implemented here exactly as App.jsx states it, so the properties that
 * matter are executed rather than asserted against source text.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
const lcm = (a, b) => (a * b) / gcd(a, b);
const MAX_FILL_TRACKS = 120;

function computeFillTracks(layout, groupSizes) {
  const cols = groupSizes.map((n) => Math.min(Math.max(1, n), layout));
  let tracks = layout;
  for (const c of cols) {
    tracks = lcm(tracks, c);
    if (tracks > MAX_FILL_TRACKS) return { tracks: layout, exact: false };
  }
  return { tracks, exact: true };
}

/** Fraction of the row each pane of a group occupies. */
function widths(layout, groupSizes, fillWidth = true) {
  const { tracks, exact } = fillWidth
    ? computeFillTracks(layout, groupSizes)
    : { tracks: layout, exact: true };
  return groupSizes.map((n) => {
    const cols = Math.min(Math.max(1, n), layout);
    const span = fillWidth && exact ? tracks / cols : tracks / layout;
    return { span: Math.max(1, Math.round(span)), tracks, cols };
  });
}

describe("fill width", () => {
  it("gives a lone session in a folder the WHOLE row", () => {
    // The reported case: one folder with 1 session, another with 2, at layout 2.
    const [solo, pair] = widths(2, [1, 2]);
    expect(solo.span / solo.tracks).toBe(1);          // 100% of the row
    expect(pair.span / pair.tracks).toBe(1 / 2);      // two panes, half each
  });

  it("keeps a full folder at the layout count", () => {
    const [four] = widths(4, [4]);
    expect(four.span / four.tracks).toBe(1 / 4);
  });

  it("never gives a group more columns than the 1-8 control allows", () => {
    // 6 sessions at layout 4 wraps to a second row; it does not squeeze to 6.
    const [big] = widths(4, [6]);
    expect(big.cols).toBe(4);
    expect(big.span / big.tracks).toBe(1 / 4);
  });

  it("makes panes within a group EXACTLY equal, even when the size does not divide the layout", () => {
    // 3 sessions in a 4-wide layout. A fixed `layout` track base would render
    // 50/25/25 -- visibly uneven, and the reason the base is an LCM.
    const [three] = widths(4, [3]);
    expect(three.tracks % three.cols).toBe(0);
    expect(three.span / three.tracks).toBeCloseTo(1 / 3, 10);
  });

  it("fills the row exactly for every group — no rounding drift", () => {
    for (const layout of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const size of [1, 2, 3, 4, 5, 6, 7, 8]) {
        const [g] = widths(layout, [size]);
        const perRow = Math.min(size, layout);
        expect(g.span * perRow).toBe(g.tracks);
      }
    }
  });

  it("falls back to the plain layout rhythm rather than demanding hundreds of tracks", () => {
    // 5 and 7 and 8 together want lcm(8,5,7) = 280 tracks. Not worth it.
    const { tracks, exact } = computeFillTracks(8, [5, 7, 8]);
    expect(exact).toBe(false);
    expect(tracks).toBe(8);
    expect(MAX_FILL_TRACKS).toBeLessThan(280);
  });

  it("off restores one shared rhythm across folders", () => {
    const [solo, pair] = widths(4, [1, 4], false);
    expect(solo.span / solo.tracks).toBe(1 / 4);
    expect(pair.span / pair.tracks).toBe(1 / 4);
  });
});

describe("wiring", () => {
  it("is a toggle, persisted beside the other layout decisions", () => {
    expect(APP_SRC).toMatch(/const FILL_WIDTH_KEY = "cockpit-scroll-fill";/);
    expect(APP_SRC).toMatch(/lsSave\(FILL_WIDTH_KEY, fillWidth\)/);
  });

  it("spans columns instead of re-parenting panes into per-group wrappers", () => {
    // The no-remount rule: a group cannot become its own grid container.
    expect(APP_SRC).toMatch(/gridColumn: `span \$\{spanBySlot\.get\(idx\) \|\| 1\}`/);
    expect(APP_SRC).toMatch(/repeat\(\$\{Math\.max\(1, gridTracks\)\}, minmax\(0, 1fr\)\)/);
  });
});
