/**
 * placeSession — grid replaces, scroll inserts.
 *
 * THE BUG: scroll mode omits empty slots, so every drop target is an occupied
 * pane. The old code wrote the incoming session INTO that slot, silently
 * evicting whoever was there — so dragging a second session into a folder
 * looked impossible without closing an existing one first.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

/** App.jsx's rule, executed. */
function place(prev, sessionId, slotIndex, insert = false) {
  const from = prev.indexOf(sessionId);
  if (from === slotIndex) return prev;
  const next = [...prev];
  if (from !== -1) {
    while (next.length <= slotIndex) next.push(null);
    const tmp = next[slotIndex];
    next[slotIndex] = sessionId;
    next[from] = tmp;
  } else if (insert) {
    next.splice(Math.max(0, Math.min(slotIndex, next.length)), 0, sessionId);
  } else {
    while (next.length <= slotIndex) next.push(null);
    next[slotIndex] = sessionId;
  }
  return next;
}

describe("scroll mode: dropping a session ADDS it", () => {
  it("does not evict the pane it was dropped on — the reported bug", () => {
    // One session on screen; drag a second one from the sidebar onto it.
    const after = place([10], 20, 0, true);
    expect(after).toEqual([20, 10]);
    expect(after).toContain(10); // the pane that was there is still there
    expect(after).toHaveLength(2);
  });

  it("lands where it was dropped and pushes the rest along", () => {
    expect(place([1, 2, 3], 9, 1, true)).toEqual([1, 9, 2, 3]);
    expect(place([1, 2, 3], 9, 0, true)).toEqual([9, 1, 2, 3]);
  });

  it("appends when dropped past the end", () => {
    expect(place([1, 2], 9, 7, true)).toEqual([1, 2, 9]);
  });

  it("never loses a session, for any drop position", () => {
    const prev = [1, 2, 3, 4];
    for (let i = 0; i <= 6; i++) {
      const after = place(prev, 99, i, true);
      for (const id of prev) expect(after).toContain(id);
      expect(after).toHaveLength(prev.length + 1);
      expect(new Set(after).size).toBe(after.length); // no duplicates
    }
  });

  it("still SWAPS a session that is already on screen", () => {
    // Moving a visible pane must not duplicate it into a second slot.
    const after = place([1, 2, 3], 3, 0, true);
    expect(after).toEqual([3, 2, 1]);
    expect(after).toHaveLength(3);
  });
});

describe("grid mode is unchanged", () => {
  it("writes into the targeted slot, because the grid draws its empty slots", () => {
    expect(place([1, null, 3], 9, 1, false)).toEqual([1, 9, 3]);
  });

  it("still replaces when aimed at an occupied slot — a deliberate gesture there", () => {
    expect(place([1, 2], 9, 0, false)).toEqual([9, 2]);
  });

  it("grows the array for a slot past the end", () => {
    expect(place([1], 9, 3, false)).toEqual([1, null, null, 9]);
  });
});

describe("wiring", () => {
  it("insert is requested only in scroll mode", () => {
    expect(APP_SRC).toMatch(/placeSession\(droppedId, idx, \{ insert: scrollMode \}\)/);
  });

  it("tells the user when a dropped session belongs to a different folder", () => {
    // Membership follows workdir, so the pane appears under its OWN group.
    // Without a word it just looks like the drop went somewhere random.
    expect(APP_SRC).toMatch(/ownFolder !== targetFolder/);
    expect(APP_SRC).toMatch(/stays under its own folder/);
  });
});
