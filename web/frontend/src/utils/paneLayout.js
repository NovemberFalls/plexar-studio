/**
 * Pane-grid geometry helpers.
 *
 * These live outside App.jsx so they can be imported by tests (and by anything
 * else that needs to reason about grid placement) without tripping
 * react-refresh's "only export components" rule on the root component file.
 *
 * The central distinction here: a SLOT is a position in `activeIds`, a CELL is
 * a position in the layout engine's `areas` list. FEATURED is a slot; the big
 * cell is always cell 0. They are not the same number.
 */

/** Layouts with a distinct featured cell that flip supports. */
export const FEATURED_LAYOUTS = new Set([3, 5, 7]);

/**
 * Clamp a featured SLOT index into the current layout.
 *
 * Shrinking the layout (7 -> 3) can leave `featuredIndex` pointing at a slot
 * that is no longer rendered, so every read goes through this. Anything out of
 * range, non-integer or negative falls back to slot 0 — the top-left slot
 * always exists for layout >= 1.
 */
export function clampFeatured(featuredIndex, layout) {
  if (!Number.isInteger(featuredIndex)) return 0;
  if (featuredIndex < 0 || featuredIndex >= layout) return 0;
  return featuredIndex;
}

/**
 * Slot render order for the pane grid.
 *
 * The grid is rendered slot-by-slot (`Array.from({length: layout})`), but the
 * layout engine hands back an ordered list of grid CELLS where `areas[0]` is
 * the big featured cell in 3/5/7. `paneOrder` is the bridge: it lists slot
 * indices in CELL order, so a slot's cell is `areas[paneOrder.indexOf(slot)]`.
 *
 * Therefore `paneOrder[0]` is by definition the slot that occupies the featured
 * cell — i.e. `featuredIndex` IS the featured slot, and "slot 0" is only the
 * featured slot when `featuredIndex === 0`.
 *
 * Non-featured layouts (1/2/4/6/8) are the identity mapping and ignore
 * `featuredIndex` entirely.
 *
 * NOTE: focus is deliberately NOT an input. Focus moves on every click (the
 * Inspector follows it); if it also drove this, typing into a pane would
 * reshuffle the grid under the user — the bug this split fixes.
 */
export function computePaneOrder(layout, featuredIndex) {
  const order = [];
  if (FEATURED_LAYOUTS.has(layout)) {
    const f = clampFeatured(featuredIndex, layout);
    order.push(f);
    for (let i = 0; i < layout; i++) if (i !== f) order.push(i);
  } else {
    for (let i = 0; i < layout; i++) order.push(i);
  }
  return order;
}

/**
 * Pure body of App's `swapPanes` — swap two slots in the activeIds list,
 * growing it with nulls so a swap onto a never-filled slot still works.
 * Extracted so "drop into the featured cell promotes the dragged pane" can be
 * asserted against the real implementation instead of a copy.
 */
export function swapSlots(ids, fromIdx, toIdx) {
  const next = [...ids];
  while (next.length <= Math.max(fromIdx, toIdx)) next.push(null);
  const tmp = next[fromIdx];
  next[fromIdx] = next[toIdx];
  next[toIdx] = tmp;
  return next;
}
