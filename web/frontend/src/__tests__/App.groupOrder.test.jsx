/**
 * Reordering the folder groups in scroll mode.
 *
 * The move arithmetic is executed here (it is pure); the wiring that keeps
 * group drags and pane drags from swallowing each other is asserted against
 * App.jsx, since it lives in JSX handlers.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

/** App.jsx's ordering rule: known keys by stored rank, unknown keys last in
 *  first-appearance order. Stable sort. */
function order(groupKeysInSlotOrder, groupOrder) {
  const rank = new Map(groupOrder.map((k, i) => [k, i]));
  return [...groupKeysInSlotOrder].sort(
    (a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** App.jsx's move: the dragged folder takes the target's position. */
function move(keys, fromKey, toKey) {
  const next = [...keys];
  const fi = next.indexOf(fromKey);
  const ti = next.indexOf(toKey);
  if (fi < 0 || ti < 0 || fromKey === toKey) return keys;
  next.splice(ti, 0, next.splice(fi, 1)[0]);
  return next;
}

describe("group order", () => {
  it("moves a folder to the target's position — the reported case", () => {
    // claude-cockpit above l2j-dev; drag l2j-dev onto claude-cockpit.
    expect(move(["claude-cockpit", "l2j-dev"], "l2j-dev", "claude-cockpit"))
      .toEqual(["l2j-dev", "claude-cockpit"]);
  });

  it("moves DOWN as well as up, without an off-by-one", () => {
    // Dragging A onto C puts A where C was, and C keeps its neighbours' order.
    expect(move(["A", "B", "C"], "A", "C")).toEqual(["B", "C", "A"]);
    expect(move(["A", "B", "C"], "C", "A")).toEqual(["C", "A", "B"]);
    expect(move(["A", "B", "C", "D"], "B", "C")).toEqual(["A", "C", "B", "D"]);
  });

  it("is a no-op on itself or on an unknown key", () => {
    expect(move(["A", "B"], "A", "A")).toEqual(["A", "B"]);
    expect(move(["A", "B"], "A", "Z")).toEqual(["A", "B"]);
  });

  it("never loses or duplicates a folder", () => {
    const keys = ["A", "B", "C", "D", "E"];
    for (const from of keys) {
      for (const to of keys) {
        const out = move(keys, from, to);
        expect([...out].sort()).toEqual([...keys].sort());
      }
    }
  });

  it("sorts unknown folders LAST, in first-appearance order", () => {
    // A new folder must appear at the bottom, not jump into the middle.
    expect(order(["new", "b", "a"], ["a", "b"])).toEqual(["a", "b", "new"]);
    expect(order(["z", "y"], [])).toEqual(["z", "y"]);
  });

  it("keeps a remembered position for a folder whose sessions all closed", () => {
    // "b" is stored second but absent right now; when it returns it is second
    // again rather than appended.
    expect(order(["c", "a"], ["a", "b", "c"])).toEqual(["a", "c"]);
    expect(order(["c", "a", "b"], ["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("group drag does not collide with pane drag", () => {
  it("uses a distinct payload prefix", () => {
    expect(APP_SRC).toMatch(/setData\("text\/plain", `group:\$\{item\.folder\}`\)/);
    // The slot drop handler only acts on the other two prefixes.
    expect(APP_SRC).toMatch(/data\.startsWith\("session:"\)/);
    expect(APP_SRC).toMatch(/data\.startsWith\("pane:"\)/);
  });

  it("a header ignores drags that are not group drags", () => {
    // Without this the header lights up while a PANE is dragged past it and
    // promises a drop it will not perform.
    const header = APP_SRC.slice(
      APP_SRC.indexOf('data-folder-head={item.folder}'),
      APP_SRC.indexOf('title="Drag to reorder this folder"'),
    );
    expect(header).toMatch(/onDragOver=\{\(e\) => \{\s*\n\s*\/\/[\s\S]*?if \(!dragGroup\) return;/);
    expect(header).toMatch(/onDrop=\{\(e\) => \{\s*\n\s*if \(!dragGroup\) return;/);
    // ...and it stops the event reaching the pane-swap handlers behind it.
    expect(header).toMatch(/e\.stopPropagation\(\);/);
  });

  it("membership stays DERIVED — only the order is stored", () => {
    // Storing which folder a session belongs to would be a second source of
    // truth against its workdir. Order has no such rival.
    expect(APP_SRC).toMatch(/const GROUP_ORDER_KEY = "cockpit-group-order";/);
    expect(APP_SRC).toMatch(/lsSave\(GROUP_ORDER_KEY, groupOrder\)/);
    expect(APP_SRC).toMatch(/const key = normalizeWorkdir\(session\.workdir\) \|\| "";/);
  });

  it("survives a corrupted stored value instead of bricking the workspace", () => {
    expect(APP_SRC).toMatch(/Array\.isArray\(v\) \? v\.filter\(\(k\) => typeof k === "string"\) : \[\]/);
  });
});
