/**
 * No native browser dialogs anywhere in the app.
 *
 * ── THE REPORT THAT PRODUCED THIS ─────────────────────────────────────────
 * Len, on the installed build: *"it said its creating the folder on local host
 * something something I think 8420."* Hedged, vague, prefaced with "I think" —
 * and **exactly accurate**. WebView2 prefixes native dialogs with the page
 * origin, so "New group" put this on screen:
 *
 *     localhost:8420 says:
 *     Group name
 *
 * A user described their screen precisely and it was received as approximate.
 * The lesson outlives the fix.
 *
 * ── WHY THIS SURVIVED THE CHAT TEARDOWN ───────────────────────────────────
 * This test was born beside `ChatDialog`, the in-app replacement, and lived in
 * `ChatDialog.test.jsx`. Chat is gone; the RULE is not chat's. It pins the
 * ABSENCE of native dialogs across the WHOLE surface, so the `window.confirm`
 * someone reaches for next month is caught at the commit rather than by the
 * user — a claim about every source file, which no longer has any reason to be
 * filed under one deleted component. This is the S8 shape: discover the set
 * from source rather than asserting a remembered list.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

/** Every .jsx/.js under src/, excluding tests. */
function sourceFiles(dir = SRC, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      sourceFiles(p, out);
    } else if (/\.jsx?$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

describe("no native browser dialogs anywhere in the app", () => {
  it("STRUCTURAL — window.prompt / confirm / alert appear in no source file", () => {
    const files = sourceFiles();
    // Sanity: if this ever reads zero the walk has drifted and the assertion
    // below passes vacuously about an empty set. The floor-versus-total lesson
    // from S8 -- a guard against vacuity has to itself be checked.
    expect(files.length).toBeGreaterThan(20);

    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // Comments legitimately NAME these APIs to explain why they are gone,
      // so match a CALL (`window.prompt(`) rather than a mention.
      for (const m of src.matchAll(/window\.(prompt|confirm|alert)\s*\(/g)) {
        offenders.push(`${path.relative(SRC, f)} -> window.${m[1]}()`);
      }
    }
    expect(offenders, `native dialogs found:\n${offenders.join("\n")}`).toEqual([]);
  });
});
