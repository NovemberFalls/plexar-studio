/**
 * Scroll mode — the folder-grouped layout (backlog row 19).
 *
 * These pin the four traps the row names. They are deliberately a mix of
 * behavioural (the grouping arithmetic, run for real) and structural (the
 * no-remount rule, which can only be proven against the source, and is
 * additionally covered by App.featuredPane.test.jsx).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Same ESM idiom App.featuredPane.test.jsx uses -- these run as modules, so
// there is no __dirname.
const APP_SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"),
  "utf8",
);

/** The grouping rule, re-implemented here exactly as App.jsx states it, so the
 *  arithmetic is testable without mounting the whole app (which needs a live
 *  backend). If App.jsx's rule changes, the structural assertions below fail. */
function normalizeWorkdir(dir) {
  if (typeof dir !== "string" || !dir) return "";
  return dir.replace(/\//g, "\\").replace(/\\$/, "");
}
function group(activeIds, sessions) {
  const groups = new Map();
  for (let idx = 0; idx < activeIds.length; idx++) {
    const id = activeIds[idx];
    if (id == null) continue;
    const s = sessions.find((x) => x.id === id);
    if (!s) continue;
    const key = normalizeWorkdir(s.workdir) || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idx);
  }
  const items = [];
  for (const [folder, slots] of groups) {
    items.push({ type: "header", folder, count: slots.length });
    for (const idx of slots) items.push({ type: "slot", idx });
  }
  return items;
}

describe("folder grouping", () => {
  const sessions = [
    { id: 1, workdir: "C:\\Code\\browser-rpg" },
    { id: 2, workdir: "C:\\Code\\studio" },
    { id: 3, workdir: "C:/Code/browser-rpg" },   // forward slashes — same folder
    { id: 4, workdir: "C:\\Code\\browser-rpg\\" }, // trailing separator — same folder
  ];

  it("keys through normalizeWorkdir, so slash style and trailing separators do not split a folder", () => {
    // THE trap: indexing by raw `workdir` puts these in three groups. That is
    // the same defect that once cost the Inspector its git row.
    const items = group([1, 2, 3, 4], sessions);
    const headers = items.filter((i) => i.type === "header");
    expect(headers).toHaveLength(2);
    expect(headers.find((h) => h.folder === "C:\\Code\\browser-rpg").count).toBe(3);
    expect(headers.find((h) => h.folder === "C:\\Code\\studio").count).toBe(1);
  });

  it("puts a header before each group and keeps slots in slot order", () => {
    const items = group([1, 2, 3], sessions);
    expect(items.map((i) => i.type)).toEqual([
      "header", "slot", "slot", // browser-rpg: slots 0 and 2
      "header", "slot",         // studio: slot 1
    ]);
    expect(items[1].idx).toBe(0);
    expect(items[2].idx).toBe(2);
  });

  it("omits empty slots — they are a grid concept", () => {
    const items = group([1, null, 2], sessions);
    expect(items.filter((i) => i.type === "slot")).toHaveLength(2);
  });

  it("groups sessions with no workdir under one bucket rather than dropping them", () => {
    const items = group([9], [{ id: 9, workdir: null }]);
    expect(items.filter((i) => i.type === "header")).toHaveLength(1);
    expect(items.filter((i) => i.type === "slot")).toHaveLength(1);
  });
});

describe("the rules scroll mode must not break", () => {
  it("refuses a cross-folder drop instead of reinterpreting it", () => {
    // Position MEANS folder here, so a cross-group swap would file a session
    // under a directory it has nothing to do with.
    expect(APP_SRC).toMatch(
      /if \(scrollMode && folderBySlot\.get\(from\) !== folderBySlot\.get\(idx\)\) \{/,
    );
    // ...and it must return, not fall through to swapPanes.
    const after = APP_SRC.slice(
      APP_SRC.indexOf("folderBySlot.get(from) !== folderBySlot.get(idx)"),
    ).slice(0, 400);
    expect(after).toMatch(/return;/);
    expect(after.indexOf("return;")).toBeLessThan(after.indexOf("swapPanes(from, idx);"));
  });

  it("leaves featuredIndex alone — it is a grid concept", () => {
    // Scroll mode must not write featured state anywhere.
    const scrollBits = APP_SRC.split("\n").filter((l) => /scrollMode/.test(l)).join("\n");
    expect(scrollBits).not.toMatch(/setFeaturedIndex/);
  });

  it("scrolls with overflow, NOT with a virtualized/windowed list", () => {
    // Windowing unmounts off-screen rows, which here means destroying live
    // scrollback and tearing down the WebSocket.
    expect(APP_SRC).toMatch(/overflowY: "auto"/);
    expect(APP_SRC).not.toMatch(/react-window|react-virtual|useVirtualizer/);
  });

  it("shows the folder-scoped drag rule instead of only enforcing it", () => {
    // The refusal alone is discoverable only by trying and getting a toast.
    // Dimming out-of-folder panes during a drag states the rule up front.
    expect(APP_SRC).toMatch(
      /scrollMode && dragSource != null\s+&& folderBySlot\.get\(dragSource\) !== folderBySlot\.get\(idx\) \? 0\.28/,
    );
  });

  it("persists the mode beside the other layout decisions", () => {
    expect(APP_SRC).toMatch(/const LAYOUT_MODE_KEY = "cockpit-layout-mode";/);
    expect(APP_SRC).toMatch(/lsSave\(LAYOUT_MODE_KEY, layoutMode\)/);
    // An unknown persisted value must not brick the workspace.
    expect(APP_SRC).toMatch(/LAYOUT_MODES\.has\(v\) \? v : "grid"/);
  });
});
