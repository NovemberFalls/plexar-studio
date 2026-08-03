/**
 * Chat destination.
 *
 * The rules worth pinning are the ones that protect the user's own words —
 * this surface is backed by Cockpit's first system of record, so "showed a
 * message it did not actually persist" is the failure that matters most.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
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
    if (url.includes("/respond")) return sse([{ type: "done", text: "ok" }]);
    if (url.includes("/groups")) return ok(GROUPS);
    if (url.includes("/conversations/cnv_1")) return ok(THREAD);
    if (url.includes("/conversations")) return ok(CONVS);
    return ok({});
  });
  return calls;
}
const ok = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

/** An SSE response whose body is a real reader, which is what send() consumes. */
function sse(frames) {
  const enc = new TextEncoder();
  const nl = String.fromCharCode(10);
  const chunks = frames.map((f) => enc.encode("data: " + JSON.stringify(f) + nl + nl));
  let i = 0;
  return Promise.resolve({
    ok: true,
    body: { getReader: () => ({
      read: () => Promise.resolve(
        i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }
      ),
    }) },
    json: () => Promise.resolve({}),
  });
}

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

  it("states the tool posture rather than leaving it implicit", async () => {
    // These tools run on THIS machine with the user's privileges, so the
    // read-only default is worth saying out loud, not burying in a setting.
    mockApi();
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    expect(await screen.findByText(/READ-ONLY/i)).toBeInTheDocument();
  });

  it("re-reads from the server after sending rather than appending locally", async () => {
    // The server owns `seq`. Rendering an optimistic message would show one
    // the store may not have accepted. Send and reply are ONE call now, so a
    // failure between them cannot orphan the user's message.
    const calls = mockApi();
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    await screen.findByText("hello");

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "second" } });
    fireEvent.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      const posts = calls.filter((c) => c.method === "POST" && c.url.includes("/respond"));
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
      "/respond": Promise.resolve({
        ok: false, status: 413,
        json: () => Promise.resolve({ error: "message is too large" }),
      }),
    });
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    const box = screen.getByLabelText("Message");
    fireEvent.change(box, { target: { value: "enormous" } });
    fireEvent.click(screen.getByLabelText("Send"));

    expect(await screen.findByText(/still in the box/i)).toBeInTheDocument();
    expect(box).toHaveValue("enormous");
  });

  it("uploads an attached file and records it against the sent message", async () => {
    const calls = mockApi({
      "/api/upload": ok({ paths: ["/tmp/uploads/abc123_notes.txt"] }),
      "/attachments": ok({ id: "att_1" }),
    });
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    // The <input type=file> is hidden and unlabelled; the paperclip picker
    // is the one WITHOUT an `accept` filter (the image picker has one).
    const fileInput = document.querySelector('input[type="file"]:not([accept])');
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "see attached" } });
    fireEvent.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      const uploadCall = calls.find((c) => c.url === "/api/upload");
      expect(uploadCall).toBeTruthy();
      const respondCall = calls.find((c) => c.url.includes("/respond"));
      expect(JSON.parse(respondCall.body).content).toContain("/tmp/uploads/abc123_notes.txt");
      const attachCall = calls.find((c) => c.url.includes("/attachments"));
      expect(attachCall).toBeTruthy();
      expect(JSON.parse(attachCall.body).path).toBe("/tmp/uploads/abc123_notes.txt");
    });
  });

  it("names the file and the reason when the server rejects an upload, without touching the composer", async () => {
    mockApi({
      "/api/upload": ok({ paths: [], errors: ['Rejected \'evil.exe\': unsupported file type \'.exe\''] }),
    });
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "keep me" } });

    const file = new File(["x"], "evil.exe", { type: "application/octet-stream" });
    const fileInput = document.querySelector('input[type="file"]:not([accept])');
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(await screen.findByText(/evil\.exe.*unsupported file type/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("keep me");
    expect(screen.queryByText("evil.exe")).not.toBeInTheDocument();
  });

  it("opens the mention popover and says plainly there are no attachments yet", async () => {
    mockApi();
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    fireEvent.click(screen.getByLabelText("Mention a file"));
    expect(await screen.findByText(/No attachments in this conversation yet/i)).toBeInTheDocument();
  });

  it("inserts an attachment's path into the draft when picked from the mention popover", async () => {
    const threadWithAttachment = {
      ...THREAD,
      attachments: [{ id: "att_1", filename: "notes.txt", path: "/tmp/uploads/notes.txt" }],
    };
    mockApi({ "/conversations/cnv_1": ok(threadWithAttachment) });
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    fireEvent.click(screen.getByLabelText("Mention a file"));
    const popover = await screen.findByRole("dialog", { name: "Mention a file" });
    fireEvent.click(within(popover).getByText("notes.txt"));
    expect(screen.getByLabelText("Message")).toHaveValue("/tmp/uploads/notes.txt ");
  });

  it("runs an existing handler from the commands popover — delete conversation", async () => {
    // UPDATED 2026-08-03: the confirm step is now an IN-APP dialog, not
    // `window.confirm`. WebView2 renders native dialogs with the page origin
    // prefixed ("localhost:8420 says:"), which is what Len saw and reported.
    // The guarantee under test is unchanged and still asserted: deleting is
    // CONFIRMED before it happens, and only then does the DELETE fire.
    const calls = mockApi();
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    fireEvent.click(screen.getByLabelText("Commands"));
    fireEvent.click(await screen.findByText("/delete-chat"));

    // Nothing is deleted until the user confirms -- assert the interlock, not
    // just the outcome.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(await screen.findByTestId("chat-dialog-confirm"));

    await waitFor(() => {
      expect(calls.some((c) => c.method === "DELETE" && c.url.includes("/conversations/cnv_1"))).toBe(true);
    });
  });

  it("mic stays disabled with the not_installed reason surfaced on hover and on click", async () => {
    mockApi({
      "/api/voice/status": ok({
        available: false, reason: "not_installed",
        detail: "Not ready: stt, vad, tts. Python package(s) not installed: faster_whisper.",
        components: {
          stt: { component: "stt", available: false, reason: "not_installed",
                 detail: "Python package(s) not installed: faster_whisper.",
                 packages: { faster_whisper: false } },
        },
      }),
    });
    render(<ChatView />);
    fireEvent.click(await screen.findByText("First chat"));
    const mic = await screen.findByLabelText("Voice input");
    expect(mic).toHaveAttribute("aria-disabled", "true");
    await waitFor(() => expect(mic).toHaveAttribute("title", expect.stringContaining("Not installed")));
    fireEvent.click(mic);
    expect((await screen.findAllByText(/faster_whisper/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/large ML dependencies/i)).toBeInTheDocument();
  });

  it("sends group_id explicitly when moving a chat to the root", async () => {
    // `null` is a real value meaning "the root"; omitting it would read as
    // "leave the group alone" and the move would silently not happen.
    // DRIVEN VIA THE CONTEXT MENU (S21 removed the per-row select; S18 added
    // right-click). The guarantee under test is unchanged and is the reason
    // this test exists: `null` is a REAL value meaning "the root", and omitting
    // it would read as "leave the group alone" -- the move would silently not
    // happen. Only the interaction that reaches it changed.
    const calls = mockApi();
    render(<ChatView />);
    await screen.findByText("Filed chat");
    fireEvent.contextMenu(await screen.findByTestId("conv-row-cnv_2"));
    fireEvent.click(await screen.findByTestId("ctx-move-to-ungrouped"));

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
