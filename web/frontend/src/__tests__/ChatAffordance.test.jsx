/**
 * Every clickable control on the chat surface must show it is clickable.
 *
 * Len, on 1.26.0: *"on the onhover effects, the user is getting no visual
 * feedback, so its a bit bland for them and difficult to understand if they can
 * press an action to action it."*
 *
 * THIS IS A CORRECTNESS ROW, NOT POLISH. **A control that gives no feedback is
 * indistinguishable from a control that is broken** — which is the defect class
 * this codebase has spent a day on in other layers: the copy button that did
 * not turn green, the form that printed a rule and accepted its violation, the
 * setting that stored a value nothing read. This is that family in the
 * interaction layer.
 *
 * MEASURED BEFORE FIXING: **24 clickable buttons in components/chat/, 24 with
 * no hover affordance.** Not "some" — all of them. The idiom already existed
 * (`.hover-bg-surface`, `.hover-bg-elevated`, `.hover-color-red` in index.css,
 * used 6x in FolderBrowser and 6x in PaneActionsMenu), and the chat surface was
 * simply built without it — the same way its conversation rows were built
 * without overflow rules. **Two of the offenders were dialogs I shipped hours
 * earlier**, so this is not a criticism of older code.
 *
 * ── WHY THE SCANNER IS BRACE-AWARE, AND IT IS NOT PEDANTRY ────────────────
 * My first pass used `<button\b[^>]*?>`. **A JSX arrow handler contains `>`**
 * (`onClick={() => f()}`), so that pattern ends the tag early — which made the
 * injector add a `className` to a tag that already had one, and made the
 * duplicate-DETECTOR report zero while a duplicate sat two lines below in plain
 * sight. React keeps the LAST duplicate, so the added class was silently
 * dropped: a hover affordance that does not hover, which is the exact defect
 * this row exists to remove. The scanner below tracks brace depth.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHAT = path.join(HERE, "..", "components", "chat");
const CSS = path.join(HERE, "..", "index.css");

/** Opening tags of `name`, brace-aware so `>` inside a handler does not end one. */
function tagSpans(src, name) {
  const out = [];
  let i = 0;
  for (;;) {
    i = src.indexOf(`<${name}`, i);
    if (i < 0) return out;
    let depth = 0;
    let j = i;
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) { out.push(src.slice(i, j + 1)); break; }
    }
    i = j + 1;
  }
}

const files = fs.readdirSync(CHAT).filter((f) => f.endsWith(".jsx"))
  .map((f) => [f, fs.readFileSync(path.join(CHAT, f), "utf8")]);

describe("chat surface affordances", () => {
  it("the hover classes it relies on actually RESOLVE", () => {
    // A class referencing an undefined custom property is a hover that does
    // nothing — indistinguishable from no class at all, which is the whole
    // defect. Checked rather than assumed.
    const css = fs.readFileSync(CSS, "utf8");
    for (const cls of ["hover-bg-surface", "hover-bg-elevated", "hover-color-red"]) {
      expect(css, `.${cls} is not defined`).toContain(`.${cls}:hover`);
    }
    for (const v of ["--bg-surface:", "--bg-elevated:", "--red:"]) {
      expect(css, `${v} is not defined; the hover class would be inert`).toContain(v);
    }
  });

  it("EVERY clickable <button> in components/chat carries a hover class", () => {
    // Sanity: a drifted path would make the assertion below vacuously true
    // about an empty set. The floor-vs-total lesson, applied to the walk.
    expect(files.length).toBeGreaterThan(5);

    const bare = [];
    let total = 0;
    for (const [name, src] of files) {
      for (const tag of tagSpans(src, "button")) {
        if (!tag.includes("onClick")) continue;
        total += 1;
        if (!tag.includes("hover-")) bare.push(`${name}: ${tag.slice(0, 70).replace(/\s+/g, " ")}…`);
      }
    }
    // DECLARED (R19): a floor would let this decay one control at a time.
    expect(total).toBeGreaterThan(20);
    expect(bare, `clickable buttons with no hover affordance:\n${bare.join("\n")}`).toEqual([]);
  });

  it("no tag carries a DUPLICATE className — React keeps the last and drops the rest", () => {
    // The bug my own first pass introduced. A duplicate is not a style nit: it
    // silently discards the affordance while the source looks correct.
    const dupes = [];
    for (const [name, src] of files) {
      for (const el of ["button", "div", "span", "li", "a"]) {
        for (const tag of tagSpans(src, el)) {
          const n = (tag.match(/className/g) || []).length;
          if (n > 1) dupes.push(`${name}: <${el}> has ${n} className attributes`);
        }
      }
    }
    expect(dupes, dupes.join("\n")).toEqual([]);
  });
});
