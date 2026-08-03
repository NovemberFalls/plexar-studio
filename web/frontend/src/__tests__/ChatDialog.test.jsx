/**
 * No native browser dialogs, and the in-app replacement can do what they could not.
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
 * ── WHY THE STRUCTURAL TEST MATTERS MORE THAN THE BEHAVIOURAL ONES ────────
 * Fixing two call sites fixes today. The grep pins the ABSENCE across the whole
 * surface, so the third `window.confirm` someone reaches for next month is
 * caught at the commit rather than by the user. This is the S8 shape --
 * discover the set from source rather than asserting a remembered list.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatDialog from "../components/chat/ChatDialog";

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

afterEach(() => vi.restoreAllMocks());

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

describe("ChatDialog", () => {
  it("prompt: returns the typed value and refuses an empty one", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<ChatDialog mode="prompt" title="New group" onSubmit={onSubmit} onCancel={vi.fn()} />);

    // Empty is not submittable -- window.prompt let you return "" and every
    // caller had to re-check it.
    expect(screen.getByTestId("chat-dialog-confirm")).toBeDisabled();

    fireEvent.change(screen.getByTestId("chat-dialog-input"), { target: { value: "  Work  " } });
    fireEvent.click(screen.getByTestId("chat-dialog-confirm"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Work"));  // trimmed
  });

  it("confirm: has no input and submits a plain acceptance", async () => {
    const onSubmit = vi.fn(async () => {});
    render(<ChatDialog mode="confirm" title="Delete?" onSubmit={onSubmit} onCancel={vi.fn()} />);
    expect(screen.queryByTestId("chat-dialog-input")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-dialog-confirm"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(true));
  });

  it("THE THING window.prompt COULD NOT DO — a failure is shown and it stays open", async () => {
    // A native prompt is synchronous: it returns, the caller does the work, and
    // if that work throws the dialog is already gone and the user sees nothing.
    const onSubmit = vi.fn(async () => { throw new Error("That group already exists."); });
    render(<ChatDialog mode="prompt" title="New group" onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByTestId("chat-dialog-input"), { target: { value: "Work" } });
    fireEvent.click(screen.getByTestId("chat-dialog-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("chat-dialog-error")).toHaveTextContent("That group already exists."));
    expect(screen.getByTestId("chat-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("chat-dialog-confirm")).not.toBeDisabled();  // retryable
  });

  it("cancel and Escape both decline WITHOUT submitting", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ChatDialog mode="confirm" title="Delete?" onSubmit={onSubmit} onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId("chat-dialog-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<ChatDialog mode="confirm" title="Delete?" onSubmit={onSubmit} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByTestId("chat-dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    // The guarantee that matters for a destructive action.
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
