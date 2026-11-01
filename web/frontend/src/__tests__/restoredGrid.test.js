import { describe, it, expect } from "vitest";
import { restoredGrid } from "../subsessions.js";

describe("restoredGrid (reload must not flood the grid)", () => {
  it("restores exactly the panes that were on screen", () => {
    const s = [
      { id: 1, inGrid: true },
      { id: 2, inGrid: false },
      { id: 3, inGrid: false, parentTerminalId: "p" },
      { id: 4, inGrid: true, parentTerminalId: "p" },
    ];
    expect(restoredGrid(s)).toEqual([1, 4]);
  });

  it("a record saved before inGrid existed restores top-level sessions, never workers", () => {
    expect(restoredGrid([{ id: 1 }, { id: 2, parentTerminalId: "p" }, { id: 3 }])).toEqual([1, 3]);
  });
});
