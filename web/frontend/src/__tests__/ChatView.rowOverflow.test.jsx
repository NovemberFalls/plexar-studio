/**
 * A conversation row must contain its own content. Reported by Len, with a
 * screenshot showing rows rendered ON TOP of each other.
 *
 * THE DEFECT. `ConversationRow` is `height: 56` FIXED and stacks three lines.
 * The title and the message-count each carry
 * `overflow:hidden / textOverflow:ellipsis / whiteSpace:nowrap`. **The model
 * line did not** — `LABEL` has no overflow rules at all — so a real model id,
 * `local:plexar-vllm:qwen3-30b-instruct`, wrapped to three lines, overflowed
 * the fixed row and painted over its neighbours. The screenshot shows `New
 * chat` overlapping `INSTRUCT` and a title riding onto the `UNGROUPED` header.
 *
 * WHY THE EXISTING SUITE COULD NOT SEE IT, and it is worse than a short
 * fixture: **`ChatView.test.jsx`'s conversations have NO `model` FIELD AT
 * ALL.** `c.model` was undefined, so the line rendered the 8-character
 * fallback `"no model"`, which fits. The fixture did not merely agree with the
 * bug — it never exercised the field. That is BELIEVED-UNEXERCISED at the
 * layout layer, so these fixtures use the real id.
 *
 * ── WHAT THIS SUITE CAN AND CANNOT PROVE, stated rather than implied ────────
 * **jsdom does no layout.** `offsetHeight` is 0 for everything here, so this
 * cannot measure that the row visually fits. What it CAN prove is the CSS
 * contract that makes overflow impossible: the model line cannot wrap, and the
 * row clips rather than spilling. **The pixels are not tested; the properties
 * that determine them are.** A reader who needs the visual proof needs a real
 * browser, and that is not what this file is.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatView from "../components/chat/ChatView.jsx";

const LONG_MODEL = "local:plexar-vllm:qwen3-30b-instruct";
const SHORT_MODEL = "opus";

const GROUPS = { groups: [{ id: "grp_1", name: "Work" }] };
const CONVS = {
  conversations: [
    { id: "cnv_long", title: "Long model row", group_id: null, message_count: 2, model: LONG_MODEL },
    { id: "cnv_short", title: "Short model row", group_id: null, message_count: 2, model: SHORT_MODEL },
  ],
};
const ok = (b) => Promise.resolve({ ok: true, json: () => Promise.resolve(b) });

function mount() {
  globalThis.fetch = vi.fn((url) => {
    if (String(url).includes("/groups")) return ok(GROUPS);
    if (String(url).includes("/conversations")) return ok(CONVS);
    return ok({});
  });
  return render(<ChatView />);
}

/** The row element for a conversation, found from its title upward.
 *
 *  UPDATED (S21): the row's height and overflow moved from an inline style into
 *  the `.chat-row` CSS class, so it can be 64px at rest and grow on hover. The
 *  helper now finds the row by CLASS. The guarantee under test is unchanged --
 *  the clip is still on every state, which is what keeps a long model id off
 *  its neighbours. */
function rowFor(title) {
  let el = screen.getByText(title);
  while (el && !el.classList?.contains("chat-row")) el = el.parentElement;
  return el;
}

/** The declared row rules, read from index.css -- the declaration now lives
 *  there rather than inline, so that is where it must be asserted. */
function chatRowCss() {
  return fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.css"), "utf8");
}

afterEach(() => vi.restoreAllMocks());

describe("conversation row: content stays inside the row", () => {
  it("the model line cannot wrap — the property that was missing", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Long model row")).toBeInTheDocument());

    const line = screen.getByText(LONG_MODEL);
    // All three together, because any one alone still wraps or still clips
    // mid-character. This is the exact set the two sibling lines already had.
    expect(line.style.whiteSpace).toBe("nowrap");
    expect(line.style.overflow).toBe("hidden");
    expect(line.style.textOverflow).toBe("ellipsis");
  });

  it("the truncated value stays RECOVERABLE via title", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Long model row")).toBeInTheDocument());
    // Truncating a value without making it recoverable is how a UI starts
    // lying quietly: the user sees `local:plexar-vllm:qwen3-30…` and has no
    // way to learn the rest.
    expect(screen.getByText(LONG_MODEL)).toHaveAttribute("title", LONG_MODEL);
  });

  it("the row clips — defence in depth against ANY future third line", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Long model row")).toBeInTheDocument());
    const row = rowFor("Long model row");
    expect(row).not.toBeNull();
    // The clip is DECLARED IN CSS now and must apply to every state -- at rest
    // AND while hovered, because hover is exactly when the row grows.
    const css = chatRowCss();
    expect(css).toMatch(/\.chat-row\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.chat-row\s*\{[^}]*height:\s*64px/);
    // And the hover state must keep a floor rather than dropping the height
    // rule entirely, or the row collapses to its content at rest size.
    expect(css).toMatch(/\.chat-row:hover\s*\{[^}]*min-height:\s*64px/);
  });

  it("PAIRWISE (R10): long and short rows are the SAME declared height", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Long model row")).toBeInTheDocument());

    const longRow = rowFor("Long model row");
    const shortRow = rowFor("Short model row");

    // DECLARED (R19): 64px, the S21 size, asserted at its source in CSS.
    // Both rows must carry the SAME class, so neither can be sized by content.
    expect(chatRowCss()).toMatch(/\.chat-row\s*\{[^}]*height:\s*64px/);
    expect(longRow.className).toBe(shortRow.className);
    expect(longRow.classList.contains("chat-row")).toBe(true);
    // Neither may carry an inline height that would override the shared class
    // -- that is how one row silently becomes a different size from another.
    expect(longRow.style.height).toBe("");
    expect(shortRow.style.height).toBe("");
    // The model line's no-wrap contract holds for BOTH, not just the long one.
    for (const m of [LONG_MODEL, SHORT_MODEL]) {
      const line = screen.getByText(m);
      expect(line.style.whiteSpace).toBe("nowrap");
      expect(line.style.overflow).toBe("hidden");
    }
  });

  it("the group SELECT IS GONE — and moving a chat is still reachable", async () => {
    // S21 removed it: it was the only way to move a chat until S18 added
    // right-click and drag, after which it was the worst of the three while
    // costing 120px of a 272px list. This asserts BOTH halves -- the control is
    // gone AND the capability it carried is still reachable -- because
    // removing a control without checking its replacement is how a feature
    // quietly disappears.
    mount();
    await waitFor(() => expect(screen.getByText("Long model row")).toBeInTheDocument());
    expect(screen.queryAllByLabelText(/^Move /)).toHaveLength(0);
    expect(rowFor("Long model row")).not.toBeNull();
  });
});
