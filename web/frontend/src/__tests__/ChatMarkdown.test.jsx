/**
 * Assistant replies render as markdown. User messages stay verbatim.
 *
 * Len, on 1.27.0: *"I dont see why this file didnt render in color, and it
 * didnt respect markdown."* The screenshot showed a reply containing literal
 * `**Point me at a file**` and a twelve-row raw pipe table — **correct content
 * in source-code form, on the surface a user reads most.**
 *
 * MEASURED BEFORE BUILDING: there was no markdown renderer anywhere in this
 * repo. `segment()` handled fenced code and emitted everything else verbatim.
 * (The `Markdown.jsx` believed to exist here lives in the RIG's UI — a
 * different repository with a same-shaped `web/src`.)
 *
 * ── THE DEPENDENCY IS A SECURITY DECISION ────────────────────────────────
 * This renders MODEL OUTPUT inside a desktop app. `react-markdown` builds React
 * ELEMENTS and never sets raw HTML, so model text cannot become markup. A
 * hand-rolled renderer ends in string interpolation, and the first person who
 * needs a table reaches for `dangerouslySetInnerHTML` — at which point model
 * output is script execution in an Electron-class context. **The last test in
 * this file is the one that keeps that door shut**, because the value of
 * "builds elements, never sets HTML" is entirely in nobody adding an exception.
 *
 * ── AND THE SPLIT BETWEEN ROLES IS DELIBERATE ────────────────────────────
 * Markdown COLLAPSES indentation by design. Applying it to user messages broke
 * the existing, tested guarantee that a paste keeps its shape — which is the
 * reason anyone pastes a log or a stack trace into a chat. So the model's
 * output is formatted and the user's own words are reproduced exactly.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { describe, it, expect } from "vitest";
import { render, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatMessage from "../components/chat/ChatMessage.jsx";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

const msg = (role, content) => ({ id: "m1", role, content, seq: 1 });

describe("assistant replies render as markdown", () => {
  it("**bold** becomes a <strong>, not four literal asterisks", () => {
    const { container } = render(
      <ChatMessage message={msg("assistant", "**Point me at a file**")} />);
    // The rendered STRUCTURE, not "a component was called" (R26).
    const strong = container.querySelector("strong");
    expect(strong, "no <strong> — the asterisks are still literal").not.toBeNull();
    expect(strong).toHaveTextContent("Point me at a file");
    expect(container.textContent).not.toContain("**");
  });

  it("a GFM pipe table becomes a real <table> — the thing in the screenshot", () => {
    const md = [
      "| Month | Visits | Signups |",
      "| --- | --- | --- |",
      "| Jan | 42k | 18k |",
      "| Feb | 51k | 22k |",
    ].join("\n");
    const { container } = render(<ChatMessage message={msg("assistant", md)} />);

    const table = container.querySelector("table");
    expect(table, "no <table> — remark-gfm is not active").not.toBeNull();
    // Declared shape, not "a table exists": 3 columns, 2 body rows.
    expect(table.querySelectorAll("thead th")).toHaveLength(3);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(within(table).getByText("42k")).toBeInTheDocument();
    // And no pipes survive as text.
    expect(container.textContent).not.toContain("| Jan |");
  });

  it("headings and lists render as elements", () => {
    const { container } = render(
      <ChatMessage message={msg("assistant", "## Title\n\n- one\n- two\n")} />);
    expect(container.querySelector("h2")).toHaveTextContent("Title");
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("plain prose is unchanged — no stray markup for text with no markdown", () => {
    const { container } = render(
      <ChatMessage message={msg("assistant", "Just a sentence with no markup.")} />);
    expect(container.textContent).toContain("Just a sentence with no markup.");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("table")).toBeNull();
  });

  it("fenced code still goes through the EXISTING path, not the renderer", () => {
    // Do not regress a working thing to unify it: `segment()` owns fences and
    // already renders them with their own affordances.
    const { container } = render(
      <ChatMessage message={msg("assistant", "before\n```js\nconst x = 1;\n```\nafter")} />);
    expect(container.textContent).toContain("const x = 1;");
    expect(container.textContent).toContain("before");
    expect(container.textContent).toContain("after");
  });
});

describe("user messages stay verbatim", () => {
  it("a pasted block keeps its indentation — markdown would collapse it", () => {
    const pasted = "line one\n    indented\n\n\nafter blanks";
    const { container } = render(<ChatMessage message={msg("user", pasted)} />);
    expect(container.textContent).toContain("    indented");
  });

  it("PAIRWISE (R10): the same source renders DIFFERENTLY by role", () => {
    // The failure mode is the two collapsing — either the user's paste getting
    // reflowed, or the assistant's markdown going unrendered.
    const src = "**bold**";
    const asUser = render(<ChatMessage message={msg("user", src)} />).container;
    const asAssistant = render(<ChatMessage message={msg("assistant", src)} />).container;
    expect(asUser.querySelector("strong")).toBeNull();
    expect(asAssistant.querySelector("strong")).not.toBeNull();
    expect(asUser.innerHTML).not.toEqual(asAssistant.innerHTML);
  });
});

describe("the door that must stay shut", () => {
  it("NO raw-HTML plugin and NO dangerouslySetInnerHTML anywhere in src/", () => {
    const files = [];
    (function walk(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "node_modules") walk(p); }
        else if (/\.jsx?$/.test(e.name)) files.push(p);
      }
    })(SRC);
    // Sanity: a drifted walk would make this pass about an empty set.
    expect(files.length).toBeGreaterThan(20);

    const hits = [];
    for (const f of files) {
      if (f.includes("__tests__")) continue;
      const src = fs.readFileSync(f, "utf8");
      // USAGE, not mention. Comments legitimately NAME these APIs to explain
      // why they are banned -- the same trap S17's native-dialog gate hit, and
      // it fired here on this very file's own docstring. A ban that cannot
      // survive being explained is a ban nobody can document.
      const usages = [
        /\bdangerouslySetInnerHTML\s*[=:]/,      // the prop, actually applied
        /from\s+["']rehype-raw["']/,              // the plugin, actually imported
        /require\(\s*["']rehype-raw["']\s*\)/,
        /\ballowDangerousHtml\s*[=:]/,
        /rehypePlugins\s*=/,                    // ANY rehype plugin list is a review point
      ];
      for (const re of usages) {
        if (re.test(src)) hits.push(`${path.relative(SRC, f)} -> ${re}`);
      }
    }
    expect(hits, `raw-HTML escape hatches found:\n${hits.join("\n")}`).toEqual([]);
  });
});
