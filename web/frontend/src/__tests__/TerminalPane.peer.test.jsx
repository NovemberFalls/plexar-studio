/**
 * A pane for a session on another machine (Studio peer): it attaches through
 * /ws/peer/{peer}/{session}, and none of the LOCAL terminal-id surfaces
 * (rename, the actions menu, file-drop upload) run for it.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = () => {};

vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), fit: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), clearDecorations: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: { bg: "#000", fg: "#fff" } }) }));
vi.mock("../components/StateIcon", () => ({ default: () => React.createElement("span", null) }));

let urls;

beforeEach(async () => {
  vi.resetModules();
  urls = [];
  const ws = { readyState: 1, send: vi.fn(), close: vi.fn() };
  const MockWebSocket = vi.fn().mockImplementation((url) => { urls.push(url); return ws; });
  MockWebSocket.OPEN = 1;
  globalThis.WebSocket = MockWebSocket;
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  const { Terminal } = await import("@xterm/xterm");
  Terminal.mockImplementation(() => ({
    loadAddon: vi.fn(), open: vi.fn(), paste: vi.fn(), write: vi.fn(), onData: vi.fn(),
    hasSelection: () => false, attachCustomKeyEventHandler: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
    options: {}, cols: 80, rows: 24, _core: {},
  }));
});

async function renderPane(session, props = {}) {
  const { default: TerminalPane } = await import("../components/TerminalPane.jsx");
  const { getPlatformInfo } = await import("../utils/platformInfo");
  await getPlatformInfo();
  let result;
  await act(async () => {
    result = render(React.createElement(TerminalPane, { session, onClose: vi.fn(), toast: vi.fn(), ...props }));
  });
  return result;
}

const PEER = {
  id: 7, name: "Remote one", terminalId: null, machine: "pc 2", machineLabel: "Desk PC",
  remoteId: "abc/1", model: "sonnet", status: "running", activityState: "idle",
};

describe("TerminalPane on another machine", () => {
  it("connects to /ws/peer with both ids quoted into one segment each", async () => {
    await renderPane(PEER);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/ws\/peer\/pc%202\/abc%2F1\?replay=1/);
    expect(urls[0]).not.toMatch(/\/ws\/terminal\//);
  });

  it("a local session still connects to /ws/terminal", async () => {
    await renderPane({ ...PEER, machine: undefined, remoteId: undefined, terminalId: "t-1" });
    expect(urls[0]).toMatch(/\/ws\/terminal\/t-1\?replay=1/);
  });

  it("waits for the remote id before connecting", async () => {
    await renderPane({ ...PEER, remoteId: null, status: "starting" });
    expect(urls).toHaveLength(0);
  });

  it("names the machine, hides the actions menu and does not rename", async () => {
    await renderPane(PEER, { onRenameSession: vi.fn() });
    expect(screen.getByTestId("pane-machine")).toHaveTextContent("Desk PC");
    expect(screen.queryByLabelText("More actions")).toBeNull();
    fireEvent.doubleClick(screen.getByText("Remote one"));
    expect(screen.queryByLabelText("Session name")).toBeNull();
    expect(screen.getByText("Remote one").getAttribute("title")).toMatch(/Not available for a session on another machine/);
  });

  it("a file drop is refused with the reason and never uploads", async () => {
    const toast = vi.fn();
    const { container } = await renderPane(PEER, { toast });
    const area = container.querySelector(".w-full.h-full").parentElement;
    const file = new File(["x"], "a.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.drop(area, { dataTransfer: { files: [file], types: ["Files"] } });
    });
    expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Not available for a session on another machine/), "info");
    expect(globalThis.fetch).not.toHaveBeenCalledWith("/api/upload", expect.anything());
  });
});
