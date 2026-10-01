/**
 * Agent-spawned workers: adoption from /api/terminals (subsessions.js) and nesting
 * under the parent in the Sidebar.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import Sidebar from "../components/Sidebar.jsx";
import { reconcileWorkers, groupWorkers } from "../subsessions.js";

const parent = { id: 1, name: "Session 3", terminalId: "p1", workdir: "C:\\repo", status: "running" };
const term = (id, extra = {}) => ({ id, name: id, alive: true, model: "sonnet", working_dir: "C:\\repo", ...extra });

describe("reconcileWorkers", () => {
  it("adopts a live terminal whose parent is a known session", () => {
    let n = 10;
    const out = reconcileWorkers([parent], [term("p1"), term("c1", { name: "Session 3.1", parent_id: "p1" })], () => n++);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ id: 10, name: "Session 3.1", terminalId: "c1", parentTerminalId: "p1" });
  });

  it("ignores workers of an unknown parent and dead terminals", () => {
    const prev = [parent];
    const out = reconcileWorkers(prev, [term("p1"), term("c1", { parent_id: "zz" }), term("c2", { parent_id: "p1", alive: false })], () => 1);
    expect(out).toBe(prev);
  });

  it("returns the same array when nothing changed (lets React bail out)", () => {
    const prev = [parent, { id: 2, name: "w", terminalId: "c1", parentTerminalId: "p1" }];
    expect(reconcileWorkers(prev, [term("p1"), term("c1", { parent_id: "p1" })], () => 9)).toBe(prev);
  });

  it("drops a worker whose terminal is gone, but never a user session", () => {
    const user = { id: 3, name: "mine", terminalId: "u1" };
    const prev = [parent, user, { id: 2, name: "w", terminalId: "c1", parentTerminalId: "p1" }];
    const out = reconcileWorkers(prev, [term("p1")], () => 9);
    expect(out.map((s) => s.id)).toEqual([1, 3]);
  });

  it("does not adopt the same terminal twice", () => {
    let n = 10;
    const terms = [term("p1"), term("c1", { parent_id: "p1" })];
    const once = reconcileWorkers([parent], terms, () => n++);
    expect(reconcileWorkers(once, terms, () => n++)).toBe(once);
  });
});

describe("groupWorkers", () => {
  it("shows an orphaned worker top-level so it never vanishes", () => {
    const { top, workersOf } = groupWorkers([{ id: 2, terminalId: "c1", parentTerminalId: "gone" }]);
    expect(top).toHaveLength(1);
    expect(workersOf).toEqual({});
  });
});

describe("Sidebar nesting", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false }))));

  const sessions = [
    parent,
    { id: 2, name: "Session 3.1", terminalId: "c1", parentTerminalId: "p1", workdir: "C:\\repo", activityState: "busy" },
    { id: 3, name: "Session 3.2", terminalId: "c2", parentTerminalId: "p1", workdir: "C:\\repo", activityState: "waiting" },
  ];

  function renderIt(onSelect = vi.fn()) {
    return render(
      <Sidebar sessions={sessions} activeIds={[]} onSelect={onSelect} onNew={vi.fn()} onNewAt={vi.fn()}
        onDelete={vi.fn()} open savedLocations={[{ path: "C:\\repo" }]} onAddLocations={vi.fn()}
        onRemoveLocation={vi.fn()} onToggleLocationBypass={vi.fn()} />,
    );
  }

  it("nests workers under the parent, counts them in the folder as ONE session, and flags a waiting worker", () => {
    renderIt();
    const group = screen.getByTestId("session-with-workers");
    const list = within(group).getByTestId("worker-list");
    expect(within(list).getByText("Session 3.1")).toBeInTheDocument();
    expect(within(list).getByText("Session 3.2")).toBeInTheDocument();
    expect(within(group).getByText("1!2w")).toBeInTheDocument();
  });

  it("collapses and expands the workers, and a worker click selects it", () => {
    const onSelect = vi.fn();
    renderIt(onSelect);
    fireEvent.click(screen.getByText("Session 3.1"));
    expect(onSelect).toHaveBeenCalledWith(2);
    fireEvent.click(screen.getByLabelText("Collapse workers"));
    expect(screen.queryByTestId("worker-list")).toBeNull();
    expect(screen.getByText("1!2w")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Expand workers"));
    expect(screen.getByTestId("worker-list")).toBeInTheDocument();
  });
});

describe("Sidebar: Claude Code's in-process agents (read-only)", () => {
  const parent3 = { id: 1, name: "Session 6", terminalId: "p6", workdir: "C:\repo", status: "running" };
  const agents = {
    p6: [
      { id: "a1", agent_type: "general-purpose", description: "W1 N01 statusWord", model: "sonnet", status: "running" },
      { id: "a2", agent_type: "general-purpose", description: "W2 N02 README pass", model: "haiku", status: "done" },
    ],
  };

  function renderAgents(fetchImpl) {
    vi.stubGlobal("fetch", fetchImpl || vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ text: "STATUS: DONE" }) })));
    return render(
      <Sidebar sessions={[parent3]} subagentsByTerminal={agents} activeIds={[]} onSelect={vi.fn()} onNew={vi.fn()}
        onNewAt={vi.fn()} onDelete={vi.fn()} open savedLocations={[{ path: "C:\repo" }]} onAddLocations={vi.fn()}
        onRemoveLocation={vi.fn()} onToggleLocationBypass={vi.fn()} />,
    );
  }

  it("nests agent rows under a session that has no Studio workers, with a running/total count", () => {
    renderAgents();
    expect(screen.getAllByTestId("agent-row")).toHaveLength(2);
    expect(screen.getByText("W1 N01 statusWord")).toBeInTheDocument();
    expect(screen.getByText("1/2a")).toBeInTheDocument();
  });

  it("clicking an agent shows its latest text and never selects or opens a pane", async () => {
    const onSelect = vi.fn();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ text: "STATUS: DONE" }) })));
    render(
      <Sidebar sessions={[parent3]} subagentsByTerminal={agents} activeIds={[]} onSelect={onSelect} onNew={vi.fn()}
        onNewAt={vi.fn()} onDelete={vi.fn()} open savedLocations={[{ path: "C:\repo" }]} onAddLocations={vi.fn()}
        onRemoveLocation={vi.fn()} onToggleLocationBypass={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("W2 N02 README pass"));
    expect(await screen.findByText("STATUS: DONE")).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/terminals/p6/subagents/a2");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a session with neither workers nor agents renders as a plain row", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false })));
    render(
      <Sidebar sessions={[parent3]} subagentsByTerminal={{}} activeIds={[]} onSelect={vi.fn()} onNew={vi.fn()}
        onNewAt={vi.fn()} onDelete={vi.fn()} open savedLocations={[{ path: "C:\repo" }]} onAddLocations={vi.fn()}
        onRemoveLocation={vi.fn()} onToggleLocationBypass={vi.fn()} />,
    );
    expect(screen.queryByTestId("session-with-workers")).toBeNull();
  });
});
