/**
 * Hide must never end a session. App.jsx is too large to render here, so this pins
 * the shape structurally: hideSession only nulls the slot -- no fetch, no DELETE,
 * no setSessions -- and the pane is wired to it beside (not instead of) removeSession.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "App.jsx"), "utf-8");

describe("App hideSession", () => {
  const start = src.indexOf("const hideSession = useCallback(");
  const body = src.slice(start, src.indexOf("}, []);", start));

  it("exists and only edits activeIds", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("setActiveIds");
    expect(body).not.toMatch(/fetch|DELETE|setSessions|removeSession/);
  });

  it("the pane gets both onHide and onClose", () => {
    expect(src).toContain("onHide={() => hideSession(session.id)}");
    expect(src).toContain("onClose={() => removeSession(session.id)}");
  });
});
