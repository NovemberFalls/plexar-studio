/**
 * Right-click and drag: organising conversations into groups.
 *
 * Len, on 1.26.0: *"I cannot drag chats into the folders, I have no right click
 * context menu in app (studio)."* Measured before building: **zero
 * `onContextMenu` handlers and zero `draggable` attributes** anywhere in
 * `components/chat/`. Group creation existed only as a toolbar button — the
 * capability was real and no interaction reached it.
 *
 * ── THE SEAM THIS SUITE EXISTS FOR (R26) ──────────────────────────────────
 * **A row that APPEARS to move and a row that IS reassigned are the same
 * picture.** Drag-and-drop hides that better than any other interaction,
 * because the visual result is produced by the browser before any code runs.
 * So every assertion below is on **the PATCH that was issued** — the stored
 * assignment — and never on where a row appears to sit.
 *
 * ── AND THE NO-OP MUST NOT LOOK LIKE A MOVE (R10/R19) ─────────────────────
 * Three outcomes, declared and mutually distinguishable:
 *   drop onto a DIFFERENT group -> exactly one PATCH, with the new group_id
 *   drop onto the SAME group    -> ZERO PATCHes
 *   drop with nothing dragged   -> ZERO PATCHes
 * A build that PATCHed on every drop would satisfy "the row ends up in the
 * right place" while writing on a gesture that changed nothing.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatView from "../components/chat/ChatView.jsx";

const GROUPS = { groups: [{ id: "grp_1", name: "Work" }] };
const CONVS = {
  conversations: [
    { id: "cnv_root", title: "Loose chat", group_id: null, message_count: 1, model: "opus" },
    { id: "cnv_work", title: "Filed chat", group_id: "grp_1", message_count: 1, model: "opus" },
  ],
};
const ok = (b) => Promise.resolve({ ok: true, json: async () => b });

function mount() {
  const calls = [];
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method || "GET", body: opts.body });
    if (u.includes("/root/default")) return ok({ path: "C:\\ws" });
    if (u.includes("/groups")) return ok(GROUPS);
    if (u.includes("/conversations/")) return ok({ conversation: CONVS.conversations[0], messages: [], attachments: [] });
    if (u.includes("/conversations")) return ok(CONVS);
    return ok({});
  });
  render(<ChatView />);
  return calls;
}
const patches = (calls) => calls.filter((c) => c.method === "PATCH");

/** A drag payload jsdom will carry between handlers. */
const dt = () => {
  const store = {};
  return { effectAllowed: "", setData: (k, v) => { store[k] = v; }, getData: (k) => store[k] || "", types: [] };
};

afterEach(() => vi.restoreAllMocks());

describe("right-click context menu", () => {
  it("opens on a conversation row — there were ZERO onContextMenu handlers before", async () => {
    mount();
    const row = await screen.findByTestId("conv-row-cnv_root");
    fireEvent.contextMenu(row);
    expect(await screen.findByTestId("chat-context-menu")).toBeInTheDocument();
    // The item Len went looking for.
    expect(screen.getByTestId("ctx-new-group")).toBeInTheDocument();
  });

  it("offers only the groups the conversation is NOT already in", async () => {
    mount();
    fireEvent.contextMenu(await screen.findByTestId("conv-row-cnv_work"));
    await screen.findByTestId("chat-context-menu");
    // cnv_work is in "Work", so moving it to "Work" must not be offered: an
    // action that cannot change anything is a control that lies about itself.
    expect(screen.queryByTestId("ctx-move-to-work")).toBeNull();
    expect(screen.getByTestId("ctx-move-to-ungrouped")).toBeInTheDocument();
  });

  it("'New group' goes through ChatDialog, never a native prompt", async () => {
    // S17 banned native dialogs with a repo-wide gate; this pins the new call
    // site behaviourally as well.
    const promptSpy = vi.spyOn(window, "prompt");
    mount();
    fireEvent.contextMenu(await screen.findByTestId("conv-row-cnv_root"));
    fireEvent.click(await screen.findByTestId("ctx-new-group"));
    expect(await screen.findByTestId("chat-dialog")).toBeInTheDocument();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it("a menu item MOVES via the API, and the stored assignment is what is asserted", async () => {
    const calls = mount();
    fireEvent.contextMenu(await screen.findByTestId("conv-row-cnv_root"));
    fireEvent.click(await screen.findByTestId("ctx-move-to-work"));
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(patches(calls)[0].url).toContain("/conversations/cnv_root");
    expect(JSON.parse(patches(calls)[0].body)).toEqual({ group_id: "grp_1" });
  });
});

describe("drag a conversation onto a group", () => {
  it("DECLARED OUTCOMES (R19), pairwise distinct (R10) — asserted on the PATCH", async () => {
    const calls = mount();
    const row = await screen.findByTestId("conv-row-cnv_root");
    const work = screen.getByTestId("group-block-grp_1");
    // ROOT.id is "root" (ChatView.jsx:67). Written out rather than guessed with
    // a `||` fallback -- getByTestId THROWS rather than returning null, so the
    // fallback never runs and the "safety" was decoration.
    const root = screen.getByTestId("group-block-root");

    // 1. DIFFERENT group -> exactly one PATCH carrying the new group_id.
    fireEvent.dragStart(row, { dataTransfer: dt() });
    fireEvent.dragOver(work, { dataTransfer: dt() });
    fireEvent.drop(work, { dataTransfer: dt() });
    await waitFor(() => expect(patches(calls)).toHaveLength(1));
    expect(JSON.parse(patches(calls)[0].body)).toEqual({ group_id: "grp_1" });

    // 2. SAME group -> ZERO further PATCHes. The no-op must not write.
    const before = patches(calls).length;
    fireEvent.dragStart(row, { dataTransfer: dt() });
    fireEvent.drop(root, { dataTransfer: dt() });
    await new Promise((r) => setTimeout(r, 30));
    expect(patches(calls).length, "dropping onto the current group issued a write").toBe(before);

    // 3. NO drag in progress -> ZERO further PATCHes.
    fireEvent.drop(work, { dataTransfer: dt() });
    await new Promise((r) => setTimeout(r, 30));
    expect(patches(calls).length, "a stray drop issued a write").toBe(before);
  });

  it("the drop target LIGHTS UP while a conversation is over it (S20's lesson)", async () => {
    mount();
    const row = await screen.findByTestId("conv-row-cnv_root");
    const work = screen.getByTestId("group-block-grp_1");

    const idle = work.style.outline;
    fireEvent.dragStart(row, { dataTransfer: dt() });
    fireEvent.dragOver(work, { dataTransfer: dt() });
    // A drop target the user cannot see is a feature they cannot find --
    // shipping one into the surface just made legible would undo S20.
    expect(work.style.outline).not.toBe(idle);
    fireEvent.dragLeave(work, { dataTransfer: dt() });
  });

  it("rows are draggable at all — there were ZERO draggable attributes before", async () => {
    mount();
    const row = await screen.findByTestId("conv-row-cnv_root");
    expect(row).toHaveAttribute("draggable");
  });
});
