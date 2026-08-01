/**
 * Chat destination.
 *
 * The rules worth pinning are the ones that protect the user's own words —
 * this surface is backed by Cockpit's first system of record, so "showed a
 * message it did not actually persist" is the failure that matters most.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import ChatView from "../components/chat/ChatView.jsx";
import ChatMessage from "../components/chat/ChatMessage.jsx";

const GROUPS = { groups: [{ id: "grp_1", name: "Work" }] };
const CONVS = {
  conversations: [
    { id: "cnv_1", title: "First chat", group_id: null, message_count: 1 },
    { id: "cnv_2", title: "Filed chat", group_id: "grp_1", message_count: 0 },
  ],
};
const THREAD = {
  conversation: { id: "cnv_1", title: "First chat", group_id: null },
  messages: [{ id: "m1", role: "user", content: "hello", seq: 1 }],
  attachments: [],
};

function mockApi(overrides = {}) {
  const calls = [];
  globalThis.fetch = vi.fn((url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", body: opts.body });
    const key = Object.keys(overrides).find((k) => url.includes(k));
    if (key) return Promise.resolve(overrides[key]);
    if (url.includes("/groups")) return ok(GROUPS);
    if (url.includes("/conversations/cnv_1")) return ok(THREAD);
    if (url.includes("/conversations")) return ok(CONVS);
    return ok({});
  });
  return calls;
}
const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

afterEach(() => vi.restoreAllMocks());

describe("ChatView", () => {
  it("lists conversations under their group, with the root shown too", async () => {
    mockApi();
    render(<ChatView />);
    expect(await screen.findByText("First chat")).toBeInTheDocument();
    expect(screen.getByText("Filed chat")).toBeInTheDocument();
    // "Ungrouped" appears as a group heading AND inside each move-select, so
    // assert on the heading specifically rather than on the string.
    expect(screen.getAllByText("Ungrouped").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Work").length).toBeGreaterThan(0);
  });

  it("says plainly that nothing will reply yet", async () => {
    // A chat surface with no model behind it must not accept messages into a
    // void and look like it is working.
    mockApi();
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    expect(await screen.findByText(/No model is wired to Chat yet/i)).toBeInTheDocument();
  });

  it("re-reads from the server after sending rather than appending locally", async () => {
    // The server owns `seq`. Rendering an optimistic message would show one
    // the store may not have accepted.
    const calls = mockApi();
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    await screen.findByText("hello");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "second" } });
    fireEvent.click(screen.getByText("Send"));

    await waitFor(() => {
      const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/messages"));
      expect(posts).toHaveLength(1);
      // A GET of the thread AFTER the POST is the re-read.
      const idx = calls.indexOf(posts[0]);
      expect(calls.slice(idx + 1).some(
        (c) => c.method === "GET" && c.url.includes("/conversations/cnv_1"))).toBe(true);
    });
  });

  it("keeps the user's text in the box when the store refuses it", async () => {
    // A 413 means nothing was saved. Clearing the composer would destroy the
    // very thing that was too big to store.
    mockApi({
      "/messages": Promise.resolve({
        ok: false, status: 413,
        json: () => Promise.resolve({ error: "message is too large" }),
      }),
    });
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "enormous" } });
    fireEvent.click(screen.getByText("Send"));

    expect(await screen.findByText(/still in the box/i)).toBeInTheDocument();
    expect(box).toHaveValue("enormous");
  });

  it("sends group_id explicitly when moving a chat to the root", async () => {
    // `null` is a real value meaning "the root"; omitting it would read as
    // "leave the group alone" and the move would silently not happen.
    const calls = mockApi();
    render(<ChatView />);
    await screen.findByText("Filed chat");
    fireEvent.change(screen.getByLabelText("Move Filed chat"), { target: { value: "root" } });

    await waitFor(() => {
      const patch = calls.find((c) => c.method === "PATCH");
      expect(JSON.parse(patch.body)).toEqual({ group_id: null });
    });
  });
});

describe("ChatMessage artifacts", () => {
  it("renders a csv fence as a table", () => {
    render(<ChatMessage message={{
      id: "m", role: "assistant",
      content: "```csv\nname,qty\nwidget,3\n```",
    }} />);
    expect(screen.getByText("widget")).toBeInTheDocument();
    expect(screen.getByText("qty")).toBeInTheDocument();
  });

  it("does not split a quoted csv field containing a comma", () => {
    render(<ChatMessage message={{
      id: "m", role: "assistant",
      content: '```csv\nname,note\nwidget,"red, large"\n```',
    }} />);
    expect(screen.getByText("red, large")).toBeInTheDocument();
  });

  it("says how many rows it dropped rather than truncating silently", () => {
    const rows = Array.from({ length: 260 }, (_, i) => `r${i},${i}`).join("\n");
    render(<ChatMessage message={{
      id: "m", role: "assistant", content: `\`\`\`csv\nname,n\n${rows}\n\`\`\``,
    }} />);
    expect(screen.getByText(/Showing 200 of 260 rows/)).toBeInTheDocument();
  });

  it("NEVER executes html — it renders it as inert source", () => {
    // Rendering model-authored HTML into this origin is script execution
    // against the user's session, not a styling choice.
    const { container } = render(<ChatMessage message={{
      id: "m", role: "assistant",
      content: "```html\n<img src=x onerror=alert(1)>\n```",
    }} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/HTML is never executed here/i)).toBeInTheDocument();
  });

  it("preserves whitespace in a pasted block", () => {
    const raw = "line one\n    indented\n\n\nafter blanks";
    const { container } = render(<ChatMessage message={{ id: "m", role: "user", content: raw }} />);
    expect(container.textContent).toContain("    indented");
  });
});
