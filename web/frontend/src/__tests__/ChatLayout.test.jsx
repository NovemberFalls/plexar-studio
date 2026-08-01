/**
 * Chat's SHELL placement — the part that is not visible in ChatView's own tests.
 *
 * ChatView rendered correctly in isolation and still looked wrong in the app:
 * its root is a flex container with `height: 100%` but no flex sizing, so
 * inside the content flex ROW it was sized by its content and drew as a narrow
 * column with dead space beside it. A component test cannot catch that,
 * because the bug lives in the parent.
 *
 * So these assert the CONTRACT the shell owes Chat, against App's source: the
 * growth classes are present, and the two pieces of Workspace chrome that
 * offer navigation Chat cannot honour are guarded.
 */

// Vite's `?raw` import: no node:fs, no process.cwd(), no URL scheme
// assumptions -- the bundler hands us the source as a string, which is exactly
// what this file needs and the only form that works in both the linter's env
// and the test runner's.
import { describe, it, expect } from "vitest";

import APP from "../App.jsx?raw";

describe("Chat shell placement", () => {
  it("wraps ChatView in a container that GROWS", () => {
    // Engine uses exactly these two classes for exactly this reason. Without
    // them Chat is content-sized inside the flex row.
    const m = APP.match(/activeSection === "chat" && \(\s*<div className="([^"]+)"/);
    expect(m, "ChatView must be wrapped, not rendered bare").not.toBeNull();
    expect(m[1]).toContain("flex-1");
    expect(m[1]).toContain("min-w-0");
  });

  it("does not render the Projects tree beside Chat", () => {
    // The tree files TERMINAL sessions into folders — a concept Chat has none
    // of — and it halves the usable width.
    expect(APP).toContain('{sidebarOpen && activeSection !== "chat" && (');
  });

  it("does not render the session tab strip in Chat", () => {
    // Those chips select terminal panes. In Chat they are navigation that
    // silently does nothing.
    expect(APP).toMatch(/\{activeSection !== "chat" && \(\s*<LaneStrip/);
  });

  it("titles the destination Chat rather than Workspace", () => {
    expect(APP).toMatch(/const SECTION_TITLES = \{\s*chat: "Chat",/);
  });

  it("leaves Chat when PROJECTS is chosen, instead of toggling a hidden drawer", () => {
    // A bare toggle there reads as a dead button.
    expect(APP).toMatch(/if \(activeSection === "chat"\) \{\s*setActiveSection\("work"\);\s*setSidebarOpen\(true\);/);
  });
});
