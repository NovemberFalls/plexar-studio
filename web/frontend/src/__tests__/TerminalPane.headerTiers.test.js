/**
 * Pane-header legibility (owner, 2026-10-06: "the top bars are clobbered
 * together and not legible" at 7-8 columns).
 *
 * The header sheds items by priority through CSS container queries. jsdom does
 * not evaluate container queries, so this pins the CONTRACT between the markup
 * and the stylesheet rather than the rendered result: every tier class the JSX
 * uses must have a rule, and the items that must never disappear must not carry
 * a tier class at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(HERE, "../components/TerminalPane.jsx"), "utf8");
const CSS = readFileSync(resolve(HERE, "../index.css"), "utf8");
const head = SRC.slice(SRC.indexOf("{/* Pane header */}"), SRC.indexOf("ref={setTranscriptStatusHost}"));

describe("pane header sheds items instead of overlapping", () => {
  it("the header is a size container and its left cluster clips", () => {
    expect(head).toMatch(/className="pane-head flex /);
    expect(head).toMatch(/className="pane-head-left flex /);
    expect(CSS).toMatch(/\.pane-head \{\s*container-type: inline-size;/);
    expect(CSS).toMatch(/\.pane-head-left \{\s*flex: 1 1 auto;\s*overflow: hidden;/);
  });

  it("each tier class used in the markup has a container rule, widest first", () => {
    const widths = ["t1", "t2", "t3"].map((t) => {
      expect(head).toContain(`ph-${t} `);
      const m = CSS.match(
        new RegExp(`@container pane-head \\(max-width: (\\d+)px\\) \\{\\s*\\.ph-${t} \\{ display: none !important; \\}`),
      );
      expect(m, `no container rule for ph-${t}`).toBeTruthy();
      return Number(m[1]);
    });
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
  });

  it("the session name truncates and is never tiered away", () => {
    expect(head).toMatch(/className="truncate min-w-0"/);
    expect(head).not.toMatch(/className="ph-t\d[^"]*truncate/);
  });

  it("BYPASS degrades to a dot, it is never hidden outright", () => {
    expect(head).toMatch(/className="ph-bypass text-/);
    expect(head).not.toMatch(/className="ph-t\d[^"]*ph-bypass/);
    expect(CSS).not.toMatch(/\.ph-bypass \{[^}]*display: none/);
  });

  it("interrupt, more-actions, hide and end carry no tier class", () => {
    for (const label of ["Interrupt session", "More actions", "Hide pane, keep session running", "Close session"]) {
      const at = head.indexOf(`aria-label="${label}"`);
      expect(at, label).toBeGreaterThan(-1);
      const btn = head.slice(head.lastIndexOf("<button", at), at);
      expect(btn, label).not.toMatch(/ph-t\d/);
    }
  });
});
