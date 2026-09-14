import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import CodexTranscript from "../components/CodexTranscript";
import { clearTranscriptCache } from "../utils/codexTranscriptCache";

afterEach(() => { cleanup(); clearTranscriptCache(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const response = (body) => ({ ok: true, json: async () => body });
const page = (messages, more = false, before = null) => ({ available: true, messages, has_more: more, before });
const message = (index, text, role = "assistant") => ({ index, text, role });

describe("saved Codex conversation", () => {
  it("ordinary upward scrolling loads older messages only when the reader reaches the top", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(page([message(20, "Recent message")], true, 20)))
      .mockResolvedValueOnce(response(page([message(10, "Earlier message")], true, 10)));
    vi.stubGlobal("fetch", fetch);
    render(<CodexTranscript terminalId="term-1" presentation="scroll" onClose={vi.fn()} />);
    await screen.findByText("Recent message");
    const scroller = screen.getByTestId("transcript-scroll");
    expect(scroller).toHaveFocus();
    expect(screen.getByRole("button", { name: "Back to live terminal" })).toBeInTheDocument();
    fireEvent.scroll(scroller);
    expect(fetch).toHaveBeenCalledTimes(1);
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scroller.querySelectorAll("article").length * 200 });
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller, { deltaY: -40 });
    await screen.findByText("Earlier message");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTop).toBe(200);
    fireEvent.scroll(scroller);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns to the live terminal on downward wheel or PageDown at the newest edge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(page([message(1, "Saved message")]))));
    const close = vi.fn();
    render(<CodexTranscript terminalId="term-1" presentation="scroll" onClose={close} />);
    await screen.findByText("Saved message");
    const scroller = screen.getByTestId("transcript-scroll");
    scroller.scrollTop = 0;
    fireEvent.wheel(scroller, { deltaY: 40 });
    expect(close).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(scroller, { key: "PageDown" });
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("labels last-known history and avoids merging conversations after a native switch", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ ...page([message(20, "Chat A")], true, 20), session_id: "a", binding_status: "last_known" }))
      .mockResolvedValueOnce(response({ ...page([message(10, "Old offset in B")]), session_id: "b", binding_status: "verified" }))
      .mockResolvedValueOnce(response({ ...page([message(50, "Chat B")]), session_id: "b", binding_status: "verified" })));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText("Chat A");
    expect(screen.getByText(/Showing the last identified conversation/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("Chat B");
    expect(screen.queryByText("Chat A")).toBeNull();
    expect(screen.queryByText("Old offset in B")).toBeNull();
    expect(fetch.mock.calls[2][0]).toBe("/api/terminals/term-1/transcript?limit=100&detail=full");
    expect(screen.queryByText(/Showing the last identified conversation/)).toBeNull();
  });

  it("loads on open, renders message text safely, and refreshes explicitly", async () => {
    const fetch = vi.fn(async () => response(page([message(1, "<img src=x onerror=alert(1)>", "user")])));
    vi.stubGlobal("fetch", fetch);
    const { container } = render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/terminals/term-1/transcript?limit=100&detail=full");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it("prepends older pages in order without moving the reader's existing text", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response(page([message(20, "Newer answer")], true, 20)))
      .mockResolvedValueOnce(response(page([message(10, "Older question", "user")]))));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText("Newer answer");
    const scroller = screen.getByTestId("transcript-scroll");
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scroller.querySelectorAll("article").length * 200 });
    scroller.scrollTop = 60;
    fireEvent.click(screen.getByRole("button", { name: "Load older" }));
    await screen.findByText("Older question");
    expect(fetch.mock.calls[1][0]).toContain("before=20");
    expect(scroller.scrollTop).toBe(260);
    expect([...scroller.querySelectorAll("article")].map((node) => node.textContent)).toEqual(["YouOlder question", "CodexNewer answer"]);
  });

  it("distinguishes unavailable history from an empty saved conversation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...page([]), available: false })));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    await screen.findByText(/not available for this session yet/);
    expect(screen.queryByText("No saved user or assistant messages yet.")).toBeNull();
  });

  it("exposes a read failure without claiming no messages exist", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    render(<CodexTranscript terminalId="term-1" onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
    expect(screen.queryByText("No saved user or assistant messages yet.")).toBeNull();
  });

  it("dismisses on Escape and aborts an outstanding read on unmount", () => {
    const close = vi.fn();
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetch);
    const { unmount } = render(<CodexTranscript terminalId="term-1" onClose={close} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    unmount();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });
});


describe("history loading continuity", () => {
  it("keeps the live surface exposed and focused while a request is delayed or rejected", async () => {
    let reject;
    vi.stubGlobal("fetch", vi.fn(() => new Promise((_, fail) => { reject = fail; })));
    const live = document.createElement("textarea"); document.body.append(live); live.focus();
    render(<CodexTranscript terminalId="pending" onClose={vi.fn()} />);
    expect(live).toHaveFocus();
    expect(screen.getByRole("dialog")).toHaveStyle({ pointerEvents: "none", background: "transparent" });
    expect(screen.getByTestId("transcript-scroll")).not.toBeVisible();
    await act(async () => reject(new Error("Network unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable");
    expect(live).toHaveFocus();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    live.remove();
  });
  it("times out a hung fetch, allows retry, and ignores its late response", async () => {
    vi.useFakeTimers();
    let finish;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(response({ ...page([message(2, "Retry worked")]), session_id: "a" }));
    vi.stubGlobal("fetch", fetch);
    render(<CodexTranscript terminalId="timeout" onClose={vi.fn()} />);
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(screen.getByRole("alert")).toHaveTextContent("timed out");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    expect(screen.getByText("Retry worked")).toBeVisible();
    await act(async () => finish(response(page([message(1, "Stale answer")]))));
    expect(screen.queryByText("Stale answer")).toBeNull();
  });
  it("reopens cached messages at the same position and replaces them on a native rebind", async () => {
    let finish;
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(response({ ...page([message(20, "Cached answer")]), session_id: "a" }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })));
    const first = render(<CodexTranscript terminalId="cached" onClose={vi.fn()} />);
    await screen.findByText("Cached answer");
    const scroller = screen.getByTestId("transcript-scroll");
    scroller.scrollTop = 73; fireEvent.scroll(scroller); first.unmount();
    render(<CodexTranscript terminalId="cached" onClose={vi.fn()} />);
    expect(screen.getByText("Cached answer")).toBeVisible();
    expect(screen.getByTestId("transcript-scroll").scrollTop).toBe(73);
    expect(screen.getByText(/current conversation has not been verified/)).toBeVisible();
    await act(async () => finish(response({ ...page([message(1, "Different conversation")]), session_id: "b" })));
    expect(screen.queryByText("Cached answer")).toBeNull();
    expect(screen.getByText("Different conversation")).toBeVisible();
  });
  it("does not expose the previous terminal on a terminal prop rebind", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ ...page([message(1, "First terminal")]), session_id: "a" }))
      .mockImplementationOnce(() => new Promise(() => {})));
    const view = render(<CodexTranscript terminalId="one" onClose={vi.fn()} />);
    await screen.findByText("First terminal");
    view.rerender(<CodexTranscript terminalId="two" onClose={vi.fn()} />);
    expect(screen.queryByText("First terminal")).toBeNull();
    expect(screen.getByRole("dialog")).toHaveStyle({ pointerEvents: "none" });
  });
});


it("retains older cached pages and scroll position during refresh without duplicate reads", async () => {
  let finish;
  const fetch = vi.fn()
    .mockResolvedValueOnce(response({ ...page([message(20, "New answer")], true, 20), session_id: "a" }))
    .mockResolvedValueOnce(response({ ...page([message(10, "Old answer")], true, 10), session_id: "a" }))
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  vi.stubGlobal("fetch", fetch);
  render(<CodexTranscript terminalId="pages" presentation="scroll" onClose={vi.fn()} />);
  await screen.findByText("New answer");
  fireEvent.click(screen.getByRole("button", { name: "Load older" }));
  await screen.findByText("Old answer");
  const scroller = screen.getByTestId("transcript-scroll");
  scroller.scrollTop = 40; fireEvent.scroll(scroller);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(screen.getByText("Old answer")).toBeVisible();
  expect(scroller.scrollTop).toBe(40);
  expect(fetch).toHaveBeenCalledTimes(3);
  await act(async () => finish(response({ ...page([message(20, "New answer"), message(30, "Latest answer")], true, 20), session_id: "a" })));
  expect(screen.getByText("Old answer")).toBeVisible();
  expect(scroller.scrollTop).toBe(40);
  expect(screen.getAllByRole("article")).toHaveLength(3);
});


it("does not redirect typing or cover the live terminal when delayed history arrives", async () => {
  let finish;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
  const live = document.createElement("textarea"); document.body.append(live); live.focus();
  render(<CodexTranscript terminalId="typing" presentation="scroll" onClose={vi.fn()} />);
  fireEvent.keyDown(live, { key: "a" });
  await act(async () => finish(response({ ...page([message(1, "Ready history")]), session_id: "a" })));
  expect(live).toHaveFocus();
  expect(screen.getByRole("region")).toHaveStyle({ pointerEvents: "none" });
  expect(screen.getByText("Ready history")).not.toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Show saved messages" }));
  expect(screen.getByText("Ready history")).toBeVisible();
  expect(screen.getByTestId("transcript-scroll")).toHaveFocus();
  live.remove();
});

it("retains the unverified cache warning after a failed verification", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(response({ ...page([message(1, "Saved A")]), session_id: "a" }))
    .mockRejectedValueOnce(new Error("Offline")));
  const first = render(<CodexTranscript terminalId="offline-cache" onClose={vi.fn()} />);
  await screen.findByText("Saved A"); first.unmount();
  render(<CodexTranscript terminalId="offline-cache" onClose={vi.fn()} />);
  await screen.findByText("Offline");
  expect(screen.getByText(/current conversation has not been verified/)).toBeVisible();
  expect(screen.getByText("Saved A")).toBeVisible();
});


it("places pending controls in the pane layout host and removes them when readable history opens", async () => {
  let finish;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((resolve) => { finish = resolve; })));
  const host = document.createElement("div"); document.body.append(host);
  const view = render(<CodexTranscript terminalId="portal" statusHost={host} onClose={vi.fn()} />);
  expect(host).toContainElement(screen.getByTestId("history-status-panel"));
  expect(screen.getByRole("dialog")).not.toContainElement(screen.getByTestId("history-status-panel"));
  await act(async () => finish(response({ ...page([message(1, "Ready in overlay")]), session_id: "a" })));
  expect(host).toBeEmptyDOMElement();
  expect(screen.getByRole("dialog")).toContainElement(screen.getByText("Ready in overlay"));
  view.unmount(); host.remove();
});

it("shows what Codex ran, with its output folded into the same block", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response(page([
    { index: 1, role: "user", text: "Fix the build", timestamp: "2026-09-13T19:49:05.794Z" },
    { index: 2, role: "assistant", phase: "commentary", text: "Checking the diff." },
    { index: 3, role: "tool", kind: "call", name: "exec", call_id: "c1", text: "git diff --check" },
    { index: 4, role: "tool", kind: "output", call_id: "c1", text: "warning: CRLF" },
    { index: 5, role: "tool", kind: "output", call_id: "older-page", text: "orphan output" },
    { index: 6, role: "assistant", text: "Done." },
  ]))));
  render(<CodexTranscript terminalId="term-1" presentation="scroll" onClose={vi.fn()} />);
  await screen.findByText("Done.");
  expect(screen.getByText("Ran")).toBeInTheDocument();
  expect(screen.getAllByText("git diff --check").length).toBeGreaterThan(0);
  const outputs = screen.getAllByTestId("tool-output");
  expect(outputs.map((node) => node.textContent)).toEqual(["warning: CRLF", "orphan output"]);
  expect(screen.getByText(/progress/)).toBeInTheDocument();
  expect(screen.queryByText("2026-09-13T19:49:05.794Z")).toBeNull();
});
