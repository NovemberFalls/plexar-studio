import { describe, it, expect } from "vitest";
import {
  pageCount,
  pageOfSlot,
  firstEmptySlot,
  pullFamily,
  spliceFamilyAfter,
} from "../utils/paneLayout";

const ids = (n) => Array.from({ length: n }, (_, i) => `s${i}`);

describe("pageCount", () => {
  it("is at least 1, even with nothing placed", () => {
    expect(pageCount([], 4)).toBe(1);
    expect(pageCount([null, null], 4)).toBe(1);
  });
  it("17 ids at layout 8 -> 3 pages", () => {
    expect(pageCount(ids(17), 8)).toBe(3);
  });
  it("an exact multiple does not add a page", () => {
    expect(pageCount(ids(16), 8)).toBe(2);
  });
  it("is driven by the LAST non-null slot, not the count", () => {
    const a = [...ids(1), null, null, null, null, null, null, null, "x"]; // slot 8
    expect(pageCount(a, 8)).toBe(2);
    // trailing nulls never add a page
    expect(pageCount([...ids(3), null, null, null, null, null, null], 4)).toBe(1);
  });
});

describe("pageOfSlot", () => {
  it("floors slot / layout", () => {
    expect(pageOfSlot(0, 4)).toBe(0);
    expect(pageOfSlot(3, 4)).toBe(0);
    expect(pageOfSlot(4, 4)).toBe(1);
    expect(pageOfSlot(17, 8)).toBe(2);
  });
});

describe("firstEmptySlot", () => {
  it("finds a null at or after `from`", () => {
    expect(firstEmptySlot(["a", null, "b", null], 0)).toBe(1);
    expect(firstEmptySlot(["a", null, "b", null], 2)).toBe(3);
  });
  it("never returns -1: past the end is empty", () => {
    expect(firstEmptySlot(["a", "b"], 0)).toBe(2);
    expect(firstEmptySlot([], 0)).toBe(0);
    expect(firstEmptySlot(["a"], 8)).toBe(8);
  });
  it("treats an absent (undefined) entry as empty", () => {
    expect(firstEmptySlot(["a", undefined, "c"], 0)).toBe(1);
  });
});

describe("pullFamily", () => {
  it("fills the next empty slots from the anchor's page start, flowing on", () => {
    // layout 2: page 1 = slots 2,3; slot 2 holds the parent, anchor = 2
    const out = pullFamily(["a", "b", "P", null], ["w1", "w2", "w3"], 2, 2);
    expect(out).toEqual(["a", "b", "P", "w1", "w2", "w3"]);
  });
  it("never overwrites or shifts an occupied slot", () => {
    const before = ["a", null, "c", null, "e"];
    const out = pullFamily(before, ["w1", "w2"], 0, 4);
    expect(out).toEqual(["a", "w1", "c", "w2", "e"]);
  });
  it("a worker placed elsewhere MOVES; its old slot becomes null, no compaction", () => {
    const out = pullFamily(["a", "b", "c", "d", "w1", "f"], ["w1"], 0, 2);
    // page 0 is full (a,b); first empty at/after slot 0 is the vacated slot 4
    expect(out).toEqual(["a", "b", "c", "d", "w1", "f"]);
    const out2 = pullFamily(["a", null, "c", "d", "w1", "f"], ["w1"], 0, 4);
    expect(out2).toEqual(["a", "w1", "c", "d", null, "f"]);
    expect(out2).toHaveLength(6);
  });
  it("never moves or drops a non-family id", () => {
    const before = ["a", "w1", null, "b", "w2", "c", null];
    const out = pullFamily(before, ["w1", "w2"], 0, 4);
    const others = (l) => l.filter((x) => x != null && !x.startsWith("w"));
    expect(others(out)).toEqual(others(before));
    // each non-family id kept its exact slot
    before.forEach((id, i) => {
      if (id != null && !id.startsWith("w")) expect(out[i]).toBe(id);
    });
    expect(out).toContain("w1");
    expect(out).toContain("w2");
  });
  it("does not mutate its input", () => {
    const before = ["a", null];
    pullFamily(before, ["w"], 0, 2);
    expect(before).toEqual(["a", null]);
  });
  it("places each worker once even if listed twice", () => {
    const out = pullFamily([], ["w", "w"], 0, 4);
    expect(out.filter((x) => x === "w")).toHaveLength(1);
  });
});

describe("spliceFamilyAfter (scroll mode)", () => {
  it("splices not-yet-placed workers directly after the parent", () => {
    expect(spliceFamilyAfter(["a", "P", "b"], ["w1", "w2"], "P")).toEqual(["a", "P", "w1", "w2", "b"]);
  });
  it("skips workers already placed and leaves the list alone when none are new", () => {
    expect(spliceFamilyAfter(["P", "w1"], ["w1", "w2"], "P")).toEqual(["P", "w2", "w1"]);
    const same = ["P", "w1"];
    expect(spliceFamilyAfter(same, ["w1"], "P")).toBe(same);
  });
  it("is a no-op when the parent is not placed", () => {
    const same = ["a"];
    expect(spliceFamilyAfter(same, ["w"], "P")).toBe(same);
  });
});
