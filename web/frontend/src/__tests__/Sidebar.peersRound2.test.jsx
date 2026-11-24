/**
 * Peer groups, round 2: "+" to start, two-step End, workers nested under their
 * parent, and the host's Claude agents shown read-only.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Sidebar from "../components/Sidebar.jsx";

const base = {
  activeIds: [], onSelect: vi.fn(), onNew: vi.fn(), onNewAt: vi.fn(), onDelete: vi.fn(),
  open: true, savedLocations: [{ path: "C:\\repo" }], onAddLocations: vi.fn(),
  onRemoveLocation: vi.fn(), onToggleLocationBypass: vi.fn(), sessions: [],
};
const OK = { reachable: true, authorized: true, reason: null };
const row = (id, name, extra = {}) => ({ id, name, working_dir: `D:\\${name}`, alive: true, activity_state: "idle", ...extra });
const peer = (sessions, extra = {}) => ({ id: "p1", label: "Desk PC", status: OK, sessions, ...extra });
const local = [{ id: 1, name: "local one", terminalId: "t1", workdir: "C:\repo", status: "running" }];
const filterBox = () => screen.getByPlaceholderText(/filter|search/i);

beforeEach(() => {
  globalThis.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
});

describe("peer group: new session button", () => {
  it("calls onNewPeerSession and is absent for a failed machine", () => {
    const onNewPeerSession = vi.fn();
    const failed = { id: "p2", label: "Down", status: { reachable: false, authorized: null, reason: "unreachable" }, sessions: null };
    render(<Sidebar {...base} peers={[peer([]), failed]} onNewPeerSession={onNewPeerSession} />);
    const plus = screen.getByTestId("peer-new-session-p1");
    expect(plus).toHaveAttribute("title", "New session on Desk PC");
    fireEvent.click(plus);
    expect(onNewPeerSession).toHaveBeenCalledWith("p1");
    expect(screen.queryByTestId("peer-new-session-p2")).toBeNull();
  });
});

describe("peer session: End", () => {
  it("needs two clicks; Escape and leaving cancel", () => {
    const onEndPeerSession = vi.fn();
    render(<Sidebar {...base} peers={[peer([row("s1", "one")])]} onEndPeerSession={onEndPeerSession} />);
    fireEvent.click(screen.getByTestId("peer-session-end"));
    expect(onEndPeerSession).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("peer-session-end-confirm"), { key: "Escape" });
    expect(screen.queryByTestId("peer-session-end-confirm")).toBeNull();
    fireEvent.click(screen.getByTestId("peer-session-end"));
    fireEvent.mouseLeave(screen.getByTestId("peer-session-end-confirm").parentElement);
    expect(screen.queryByTestId("peer-session-end-confirm")).toBeNull();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    fireEvent.click(screen.getByTestId("peer-session-end"));
    // The second half of a double-click lands on the confirm: it must not end anything.
    fireEvent.click(screen.getByTestId("peer-session-end-confirm"));
    expect(onEndPeerSession).not.toHaveBeenCalled();
    now.mockReturnValue(1600);
    fireEvent.click(screen.getByTestId("peer-session-end-confirm"));
    now.mockRestore();
    expect(onEndPeerSession).toHaveBeenCalledTimes(1);
    expect(onEndPeerSession).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "s1" }));
  });

  it("does not select the session when End is clicked", () => {
    const onSelectPeerSession = vi.fn();
    render(<Sidebar {...base} peers={[peer([row("s1", "one")])]} onSelectPeerSession={onSelectPeerSession} onEndPeerSession={vi.fn()} />);
    fireEvent.click(screen.getByTestId("peer-session-end"));
    expect(onSelectPeerSession).not.toHaveBeenCalled();
  });
});

describe("peer workers", () => {
  const sessions = [row("s1", "boss"), row("w1", "helper", { parent_id: "s1" }), row("w2", "stray", { parent_id: "gone" })];

  it("nests a worker under its parent and shows an orphan at top level", () => {
    render(<Sidebar {...base} peers={[peer(sessions)]} />);
    expect(screen.getAllByTestId("peer-session-row")).toHaveLength(3);
    const list = screen.getByTestId("peer-worker-list");
    expect(within(list).getAllByTestId("peer-session-row")).toHaveLength(1);
    expect(list).toHaveTextContent("helper");
    expect(list).not.toHaveTextContent("stray");
    expect(screen.getAllByTestId("peer-session-row").some((e) => e.textContent.includes("stray"))).toBe(true);
  });

  it("a filter keeps a matching worker even when its parent is filtered out", () => {
    render(<Sidebar {...base} sessions={local} peers={[peer(sessions)]} />);
    fireEvent.change(filterBox(), { target: { value: "helper" } });
    expect(screen.queryByTestId("peer-worker-list")).toBeNull();
    expect(screen.getAllByTestId("peer-session-row").map((e) => e.textContent).join("|")).toContain("helper");
    expect(screen.getAllByTestId("peer-session-row").map((e) => e.textContent).join("|")).not.toContain("boss");
  });

  it("a filter matching both keeps the nesting", () => {
    render(<Sidebar {...base} sessions={local} peers={[peer(sessions)]} />);
    fireEvent.change(filterBox(), { target: { value: "D:" } });
    expect(screen.getByTestId("peer-worker-list")).toBeInTheDocument();
  });
});

describe("peer subagents", () => {
  const subagents = { s1: [{ id: "a1", description: "Scan the repo", agent_type: "Explore", model: "haiku", status: "running" }] };

  it("renders a session's agents and loads the report through the peer route", async () => {
    globalThis.fetch = vi.fn(async (url) => (url === "/api/peers/p1/sessions/s1/subagents/a1"
      ? { ok: true, status: 200, json: async () => ({ text: "all clear" }) }
      : { ok: false, status: 404, json: async () => ({}) }));
    render(<Sidebar {...base} peers={[peer([row("s1", "one")], { subagents })]} />);
    const a = screen.getByTestId("agent-row");
    expect(a).toHaveTextContent("Scan the repo");
    fireEvent.click(within(a).getByRole("button"));
    expect(await screen.findByText("all clear")).toBeInTheDocument();
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).startsWith("/api/terminals"))).toBe(false);
  });

  it("shows no agent rows when the machine reports none", () => {
    render(<Sidebar {...base} peers={[peer([row("s1", "one")], { subagents: {} })]} />);
    expect(screen.queryByTestId("agent-row")).toBeNull();
  });

  it("a report that cannot be read says so instead of hanging", async () => {
    render(<Sidebar {...base} peers={[peer([row("s1", "one")], { subagents })]} />);
    fireEvent.click(within(screen.getByTestId("agent-row")).getByRole("button"));
    await waitFor(() => expect(screen.getByText("(no text yet)")).toBeInTheDocument());
  });
});

describe("peer group: rename from the sidebar", () => {
  it("saves on Enter, keeps a refused name open with the reason, Escape cancels", async () => {
    const onRenamePeer = vi.fn(async (_id, label) => (label === "bad" ? "label must be 1 to 60 characters" : null));
    render(<Sidebar {...base} peers={[peer([])]} onRenamePeer={onRenamePeer} />);
    fireEvent.click(screen.getByTestId("peer-rename-start-p1"));
    const input = screen.getByTestId("peer-rename-inline-p1");
    expect(input).toHaveValue("Desk PC");
    fireEvent.change(input, { target: { value: "bad" } });
    fireEvent.submit(input.closest("form"));
    await waitFor(() => expect(screen.getByTestId("peer-rename-inline-error-p1")).toHaveTextContent("1 to 60"));
    fireEvent.change(screen.getByTestId("peer-rename-inline-p1"), { target: { value: "  Desktop  " } });
    fireEvent.submit(screen.getByTestId("peer-rename-inline-p1").closest("form"));
    await waitFor(() => expect(screen.queryByTestId("peer-rename-inline-p1")).toBeNull());
    expect(onRenamePeer).toHaveBeenLastCalledWith("p1", "Desktop");

    fireEvent.click(screen.getByTestId("peer-rename-start-p1"));
    fireEvent.keyDown(screen.getByTestId("peer-rename-inline-p1"), { key: "Escape" });
    expect(screen.queryByTestId("peer-rename-inline-p1")).toBeNull();
    expect(onRenamePeer).toHaveBeenCalledTimes(2);
  });

  it("is offered for a machine that is unreachable, and absent without a handler", () => {
    const failed = { id: "p2", label: "Down", status: { reachable: false, authorized: null, reason: "unreachable" }, sessions: null };
    const { unmount } = render(<Sidebar {...base} peers={[failed]} onRenamePeer={vi.fn()} />);
    expect(screen.getByTestId("peer-rename-start-p2")).toBeInTheDocument();
    unmount();
    render(<Sidebar {...base} peers={[failed]} />);
    expect(screen.queryByTestId("peer-rename-start-p2")).toBeNull();
  });
});
