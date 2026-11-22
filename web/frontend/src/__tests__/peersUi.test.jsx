/**
 * Studio peers in the sidebar and the New session dialog.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import Sidebar from "../components/Sidebar.jsx";
import NewSessionDialog from "../components/NewSessionDialog";
import FolderBrowser from "../components/FolderBrowser";
import { parsePeerDragData } from "../utils/peers";

const baseSidebar = {
  activeIds: [], onSelect: vi.fn(), onNew: vi.fn(), onNewAt: vi.fn(), onDelete: vi.fn(),
  open: true, savedLocations: [{ path: "C:\\repo" }], onAddLocations: vi.fn(),
  onRemoveLocation: vi.fn(), onToggleLocationBypass: vi.fn(),
};

describe("Sidebar: other machines", () => {
  it("lists a machine's sessions in its own group; click and drag place them", () => {
    const onSelectPeerSession = vi.fn();
    const peers = [{ id: "p1", label: "Desk PC", status: { reachable: true, authorized: true, reason: null },
      sessions: [{ id: "s1", name: "remote work", working_dir: "D:\\proj", alive: true, activity_state: "idle" }] }];
    // A local record of that peer session must NOT appear in this computer's folder tree.
    const sessions = [{ id: 9, name: "remote work", machine: "p1", remoteId: "s1", workdir: "C:\\repo", status: "running" }];
    render(<Sidebar {...baseSidebar} sessions={sessions} activeIds={[9]} peers={peers} onSelectPeerSession={onSelectPeerSession} />);
    const group = screen.getByTestId("peer-group-p1");
    expect(within(group).getByText("Desk PC")).toBeInTheDocument();
    const row = within(group).getByTestId("peer-session-row");
    fireEvent.click(row);
    expect(onSelectPeerSession).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "s1" }));
    const setData = vi.fn();
    fireEvent.dragStart(row, { dataTransfer: { setData, effectAllowed: "" } });
    expect(parsePeerDragData(setData.mock.calls[0][1])).toEqual({ peerId: "p1", remoteId: "s1" });
    expect(screen.getAllByText("remote work")).toHaveLength(1);
  });

  it("renders the reason, not an empty list, for an unreachable or unauthorized machine", () => {
    const peers = [
      { id: "a", label: "A", status: { reachable: false, authorized: null, reason: "unreachable" }, sessions: [{ id: "old" }] },
      { id: "b", label: "B", status: { reachable: true, authorized: false, reason: "unauthorized" }, sessions: null },
    ];
    render(<Sidebar {...baseSidebar} sessions={[]} peers={peers} onSelectPeerSession={vi.fn()} />);
    const reasons = screen.getAllByTestId("peer-group-reason");
    expect(reasons.map((r) => r.dataset.reason)).toEqual(["unreachable", "unauthorized"]);
    expect(reasons[0].textContent).not.toBe(reasons[1].textContent);
    expect(screen.queryByTestId("peer-session-row")).toBeNull();
  });

  it("shows no section when nothing is paired", () => {
    render(<Sidebar {...baseSidebar} sessions={[]} />);
    expect(screen.queryByText("Other machines")).toBeNull();
  });
});

describe("FolderBrowser injected fetcher", () => {
  it("lists through the fetcher and disables the native dialog with its reason", async () => {
    globalThis.fetch = vi.fn();
    const fetchListing = vi.fn(async () => ({ path: "D:\\", parent: null, entries: [{ path: "D:\\proj", name: "proj", git: false, branch: null, session_count: 0 }] }));
    render(<FolderBrowser path={"D:\\"} onPathChange={vi.fn()} selectedPath="" onSelectPath={vi.fn()} fetchListing={fetchListing} />);
    expect(await screen.findByText("proj")).toBeInTheDocument();
    expect(fetchListing).toHaveBeenCalledWith("D:\\");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const native = screen.getByLabelText("Open the native folder dialog");
    expect(native).toBeDisabled();
    expect(native.getAttribute("title")).toMatch(/not the other machine's/);
  });
});

function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("NewSessionDialog: Machine select", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (url) => {
      if (url.startsWith("/api/peers/p1/catalog")) {
        return res(200, {
          harnesses: [{ id: "claude-code", label: "Claude Code", models: [{ id: "peer-model", label: "Peer Model" }], default_model: "peer-model" }],
          permission_modes: [{ id: "default" }, { id: "plan" }, { id: "acceptEdits" }, { id: "bypassPermissions" }],
          efforts: ["low", "medium", "high", "xhigh"],
        });
      }
      if (url.startsWith("/api/peers/p1/workdirs")) return res(200, { workdirs: [{ path: "D:\\proj", source: "saved" }], roots: ["D:\\"] });
      if (url.startsWith("/api/peers/p1/browse")) return res(200, { path: "D:\\", parent: null, entries: [] });
      if (url.startsWith("/api/browse")) return res(200, { dirs: [], entries: [] });
      return res(404, {});
    });
  });

  it("is hidden when no machine is paired", () => {
    render(<NewSessionDialog onConfirm={vi.fn()} onCancel={vi.fn()} defaultModel="sonnet" />);
    expect(screen.queryByLabelText("Machine")).toBeNull();
  });

  it("creates on the peer with its catalog, and refuses what it does not offer", async () => {
    const onConfirm = vi.fn();
    render(<NewSessionDialog onConfirm={onConfirm} onCancel={vi.fn()} defaultModel="claude-sonnet-5" defaultEffort="max"
      machines={[{ id: "p1", label: "Desk PC" }]} />);
    fireEvent.click(screen.getByLabelText("Machine"));
    fireEvent.click(screen.getByRole("button", { name: "Desk PC" }));
    // The peer's default model replaces one it does not offer.
    await waitFor(() => expect(screen.getByLabelText("Model")).toHaveTextContent("Peer Model"));
    // Effort "max" is not offered there: refused with the reason, nothing sent.
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByTestId("peer-dialog-note")).toHaveTextContent(/effort/);
    fireEvent.click(screen.getByLabelText("Effort"));
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm).toHaveBeenCalledWith("", "D:\\proj", false, expect.objectContaining({
      machine: "p1", model: "peer-model", effort: "high", harness: "claude-code",
    }));
  });

  it("leaves `machine` out entirely for this computer", () => {
    const onConfirm = vi.fn();
    render(<NewSessionDialog onConfirm={onConfirm} onCancel={vi.fn()} defaultModel="sonnet" machines={[{ id: "p1", label: "Desk PC" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm.mock.calls[0][3]).not.toHaveProperty("machine");
  });
});
