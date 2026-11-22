/**
 * Orchestrators list + run dock: pure row matching, the list, the dock's embed
 * messaging, and the structural guarantees (iframe lives in RunDock, dock sits
 * beside the grid and never inside the slot loop).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "node:fs";
import { orchestratorRows, runForSession, stageLabel, embedUrl, runningWorkerCount } from "../utils/orchRuns.js";
import OrchestratorsList from "../components/OrchestratorsList.jsx";
import RunDock from "../components/RunDock.jsx";

const run = (id, over = {}) => ({
  run_id: id, state: "FROZEN", stage: "workers", task: `task ${id}`, cwd: "C:\\Code\\Personal\\proj",
  orchestrator_session_id: null, updated_at: "2026-11-22T06:00:00-05:00", workers: [], ...over,
});
const sessions = [
  { id: 1, name: "Session 1", terminalId: "t1" },
  { id: 2, name: "Session 2", terminalId: "t2" },
];

describe("orchRuns helpers", () => {
  it("matches sessions by terminalId, orders newest update first, keeps outside-Studio runs", () => {
    const rows = orchestratorRows([
      run("a", { orchestrator_session_id: "t1", updated_at: "2026-11-22T06:00:00-05:00" }),
      run("b", { orchestrator_session_id: "zz", updated_at: "2026-11-22T07:00:00-05:00" }),
      run("c", { orchestrator_session_id: "t2", updated_at: "2026-11-22T06:30:00-05:00" }),
    ], sessions);
    expect(rows.map((r) => r.run.run_id)).toEqual(["b", "c", "a"]);
    expect(rows[0].session).toBeNull();
    expect(rows[1].session.id).toBe(2);
  });

  it("runForSession finds the run a terminal orchestrates", () => {
    const runs = [run("a", { orchestrator_session_id: "t1" })];
    expect(runForSession(runs, "t1").run_id).toBe("a");
    expect(runForSession(runs, "t2")).toBeNull();
    expect(runForSession(runs, null)).toBeNull();
  });

  it("stageLabel labels known stages and renders unknown ones verbatim", () => {
    expect(stageLabel("workers")).toBe("Workers");
    expect(stageLabel("ship")).toBe("Ship");
    expect(stageLabel("toString")).toBe("toString");
    expect(stageLabel("mystery")).toBe("mystery");
  });

  it("builds the frame URL on /embed, never /app", () => {
    expect(embedUrl("http://127.0.0.1:8430/", "orch-1")).toBe("http://127.0.0.1:8430/embed?run=orch-1");
    expect(embedUrl("http://x", "a b")).not.toContain("/app");
  });

  it("counts workers still running", () => {
    expect(runningWorkerCount(run("a", { workers: [{ status: "DONE" }, { status: "DISPATCHED" }] }))).toBe(1);
  });
});

describe("OrchestratorsList", () => {
  it("renders nothing without runs", () => {
    const { container } = render(<OrchestratorsList rows={[]} selectedRunId={null} onPick={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("a click hands the row to onPick; the selected row is marked; outside rows say so", () => {
    const rows = orchestratorRows([
      run("a", { orchestrator_session_id: "t1" }),
      run("b", { cwd: "C:\\Code\\elsewhere", updated_at: "2026-11-22T05:00:00-05:00" }),
    ], sessions);
    const onPick = vi.fn();
    render(<OrchestratorsList rows={rows} selectedRunId="a" onPick={onPick} />);
    expect(screen.getByText("Session 1")).toBeInTheDocument();
    expect(screen.getByText("elsewhere")).toBeInTheDocument();
    expect(screen.getByText("outside Studio")).toBeInTheDocument();
    const [first, second] = screen.getAllByRole("button");
    expect(first).toHaveAttribute("aria-current", "true");
    expect(second).not.toHaveAttribute("aria-current");
    fireEvent.click(first);
    expect(onPick).toHaveBeenCalledWith(rows[0].run, rows[0].session);
    fireEvent.click(second);
    expect(onPick).toHaveBeenLastCalledWith(rows[1].run, null);
  });
});

describe("RunDock", () => {
  const BASE = "http://127.0.0.1:8430";
  let posted;
  const frameWin = () => screen.getByTitle("Orchestration run").contentWindow;
  const send = (data, { origin = BASE, source } = {}) =>
    act(() => {
      window.dispatchEvent(new MessageEvent("message", { data, origin, source: source ?? frameWin() }));
    });

  beforeEach(() => {
    posted = [];
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  function mount(props) {
    const utils = render(<RunDock base={BASE} runId="r1" run={run("r1")} onClose={() => {}} {...props} />);
    posted.length = 0;
    vi.spyOn(frameWin(), "postMessage").mockImplementation((...a) => { posted.push(a); });
    return utils;
  }

  it("sandboxes and titles the frame, pointing it at /embed", () => {
    render(<RunDock base={BASE} runId="r1" run={run("r1")} onClose={() => {}} />);
    const f = screen.getByTitle("Orchestration run");
    expect(f).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
    expect(f.getAttribute("src")).toBe(`${BASE}/embed?run=r1`);
  });

  it("posts plexar-run on a run change instead of reloading the frame", () => {
    const { rerender } = mount();
    send({ type: "plexar-embed-ready" });
    expect(posted.at(-1)).toEqual([{ type: "plexar-run", run: "r1" }, BASE]);
    const before = screen.getByTitle("Orchestration run");
    rerender(<RunDock base={BASE} runId="r2" run={run("r2")} onClose={() => {}} />);
    const after = screen.getByTitle("Orchestration run");
    expect(after).toBe(before);
    expect(after.getAttribute("src")).toBe(`${BASE}/embed?run=r1`);
    expect(posted.at(-1)).toEqual([{ type: "plexar-run", run: "r2" }, BASE]);
  });

  it("falls back to the load event when embed-ready never arrives", () => {
    mount();
    fireEvent.load(screen.getByTitle("Orchestration run"));
    expect(posted.at(-1)).toEqual([{ type: "plexar-run", run: "r1" }, BASE]);
  });

  it("applies an embed-stage message from the right origin and frame", () => {
    mount();
    send({ type: "plexar-embed-stage", run: "r1", stage: "gate" });
    expect(screen.getByText("Gate")).toBeInTheDocument();
  });

  it("ignores messages from a wrong origin or a wrong source", () => {
    mount();
    send({ type: "plexar-embed-stage", run: "r1", stage: "gate" }, { origin: "http://evil.example" });
    send({ type: "plexar-embed-stage", run: "r1", stage: "gate" }, { source: window });
    send({ type: "plexar-embed-ready" }, { origin: "http://evil.example" });
    send({ type: "plexar-embed-ready" }, { source: window });
    expect(screen.queryByText("Gate")).toBeNull();
    expect(screen.getByText("Workers")).toBeInTheDocument();
    expect(posted).toEqual([]);
  });

  it("an embed-stage for a different run does not relabel the header", () => {
    mount();
    send({ type: "plexar-embed-stage", run: "other", stage: "ship" });
    expect(screen.queryByText("Ship")).toBeNull();
  });

  it("shows Run closed with the last stage and keeps the frame", () => {
    const { rerender } = mount();
    rerender(<RunDock base={BASE} runId="r1" run={null} onClose={() => {}} />);
    expect(screen.getByText("Run closed at Workers")).toBeInTheDocument();
    expect(screen.getByTitle("Orchestration run")).toBeInTheDocument();
    expect(screen.getByText("task r1")).toBeInTheDocument();
  });

  it("reloads only when base changes", () => {
    const { rerender } = mount();
    rerender(<RunDock base="http://127.0.0.1:9999" runId="r2" run={run("r2")} onClose={() => {}} />);
    expect(screen.getByTitle("Orchestration run").getAttribute("src")).toBe("http://127.0.0.1:9999/embed?run=r2");
  });
});

describe("structure", () => {
  const src = (p) => fs.readFileSync(`src/${p}`, "utf8");

  it("App.jsx has no iframe; the dock is outside the slot loop and paneOrder stays single-use", () => {
    const app = src("App.jsx");
    expect(app.toLowerCase().includes("<iframe")).toBe(false);
    expect(src("components/RunDock.jsx")).toContain("<iframe");
    const dockAt = app.indexOf("<RunDock");
    expect(dockAt).toBeGreaterThan(app.indexOf("</main>"));
    expect(app.match(/paneOrder\.indexOf\(/g)).toHaveLength(1);
    expect(app).not.toMatch(/paneOrder[^\n]*orch|orch[^\n]*paneOrder/);
  });

  it("toggling the dock does not touch session keys or the pane component", () => {
    // The dock is a sibling AFTER <main>, rendered only by its own condition, so the
    // grid's children (keyed by session.id in renderSlot) are not part of that branch.
    const app = src("App.jsx");
    const slot = app.slice(app.indexOf("const renderSlot"), app.indexOf("return (", app.indexOf("const renderSlot")));
    expect(slot).not.toMatch(/dockOpen|dockRunId|RunDock/);
  });
});
