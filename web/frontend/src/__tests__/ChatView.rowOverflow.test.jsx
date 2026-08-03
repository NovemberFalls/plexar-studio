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
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

/** The row element for a conversation, found from its title upward. */
function rowFor(title) {
  const label = screen.getByText(title);
  let el = label;
  while (el && el.style?.height !== "56px") el = el.parentElement;
  return el;
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
    // A fixed height with no overflow rule is the collapse-of-states shape in
    // layout: too-tall and correct render identically until content grows.
    expect(row.style.overflow).toBe("hidden");
  });

  it("PAIRWISE (R10): long and short rows are the SAME declared height", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Long model row")).toBeInTheDocument());

    const longRow = rowFor("Long model row");
    const shortRow = rowFor("Short model row");

    // DECLARED, not "similar" (R19). 56 is the design's number; asserting
    // equality alone would pass if BOTH rows grew.
    expect(longRow.style.height).toBe("56px");
    expect(shortRow.style.height).toBe("56px");
    expect(longRow.style.height).toBe(shortRow.style.height);

    // And the containment properties must not differ by content either — a
    // row that clips only when the text is short is not a row that clips.
    for (const prop of ["overflow", "height"]) {
      expect(longRow.style[prop]).toBe(shortRow.style[prop]);
    }
    // The model line's no-wrap contract holds for BOTH, not just the long one.
    for (const m of [LONG_MODEL, SHORT_MODEL]) {
      const line = screen.getByText(m);
      expect(line.style.whiteSpace).toBe("nowrap");
      expect(line.style.overflow).toBe("hidden");
    }
  });

  it("the group select can show its own label, not a prefix of it", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("Long model row")).toBeInTheDocument());

    const select = screen.getAllByLabelText(/^Move /)[0];
    // 62px cut this control's OWN label to "Ungroupe" — a control the user
    // cannot read. The assertion is on the regression, not on a magic number:
    // it must be wide enough for the longest option it can display.
    const max = parseInt(select.style.maxWidth, 10);
    expect(max).toBeGreaterThan(62);

    // The option text itself must be whole — this is the value the width
    // exists to show.
    const longest = [...select.options].reduce((a, o) => (o.text.length > a.length ? o.text : a), "");
    expect(longest).toBe("Ungrouped");
    expect(within(select).getByText("Ungrouped")).toBeInTheDocument();
  });
});
