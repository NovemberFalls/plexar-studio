/**
 * The composition test that was missing. See buildBusyTerminalIds.test.js's
 * header for the lesson: every individual component (Rail, CommandBar,
 * LaneStrip, Inspector, StatusStrip, BridgeModal, ...) has its own unit
 * tests and none of them prove that App.jsx actually wires them together
 * correctly, or that App.jsx itself renders without throwing. The
 * Set-vs-Map bridge crash shipped for three minor versions specifically
 * because nothing rendered the real composition root.
 *
 * This file renders the REAL `App` component (not a stand-in), with `fetch`
 * and `WebSocket` stubbed, and asserts:
 *   1. it gets past the "Connecting..." splash (backendReady is driven by
 *      GET /api/me resolving ok — see App.jsx's health-check useEffect).
 *   2. the five shell regions mount (rail nav items, command palette
 *      trigger, status strip).
 *   3. no "rules of hooks" / "more hooks than during the previous render"
 *      console.error fires across the not-ready -> ready transition (this is
 *      exactly the class of bug the coordinator's own useMemo/useCallback
 *      relocation fix was guarding against).
 *   4. the terminals-never-unmount invariant: the pane-grid <main> node is
 *      the SAME node (identity-compared) after navigating to Fleet and
 *      Engine and back — only display:none, never removed/remounted. A
 *      remount here would silently kill every live xterm instance and its
 *      WebSocket without any visible error.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// jsdom polyfills (same set TerminalPane.actions.test.jsx uses)
// ---------------------------------------------------------------------------

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}
if (typeof globalThis.cancelAnimationFrame === "undefined") {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.matchMedia === "undefined") {
  globalThis.matchMedia = () => ({
    matches: false,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

// ---------------------------------------------------------------------------
// xterm + addon mocks — identical shape to TerminalPane.actions.test.jsx /
// TerminalPane.paste.test.jsx, reused rather than reinvented per the brief.
// ---------------------------------------------------------------------------

vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    fit: vi.fn(),
    proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    dispose: vi.fn(),
  })),
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    dispose: vi.fn(),
  })),
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({
    theme: {
      bg: "#1a1b26", fg: "#a9b1d6", accent: "#7aa2f7",
      bgSurface: "#16161e", bgElevated: "#1a1b26", bgHighlight: "#292e42",
      fgDim: "#565f89", fgMuted: "#3b4261", red: "#f7768e",
      green: "#9ece6a", yellow: "#e0af68", purple: "#bb9af7",
      cyan: "#7dcfff", border: "#292e42", hexBase: "#7aa2f7",
      hexGlow: "#7aa2f7", hexGlowIntensity: 0.4,
      fontFamily: "monospace", scanlines: false,
    },
  }),
}));

vi.mock("../components/StateIcon", () => ({
  default: () => React.createElement("span", null),
}));

// ---------------------------------------------------------------------------
// WebSocket mock — App/TerminalPane open one per pane.
// ---------------------------------------------------------------------------

class MockWebSocket {
  constructor() {
    this.readyState = 1;
    this.send = vi.fn();
    this.close = vi.fn();
    this.addEventListener = vi.fn();
    this.removeEventListener = vi.fn();
  }
}
MockWebSocket.OPEN = 1;
MockWebSocket.CONNECTING = 0;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;

async function setupTerminalMock() {
  const { Terminal } = await import("@xterm/xterm");
  Terminal.mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    paste: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    onData: vi.fn(),
    onKey: vi.fn(),
    hasSelection: vi.fn().mockReturnValue(false),
    getSelection: vi.fn().mockReturnValue(""),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    scrollToBottom: vi.fn(),
    resize: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(),
    dispose: vi.fn(),
    options: { theme: {}, fontSize: 13 },
    _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
  }));
}

// ---------------------------------------------------------------------------
// fetch stub — route-aware, defaults to a harmless {ok:true} for anything
// not explicitly listed so unrecognized polling calls don't throw.
// ---------------------------------------------------------------------------

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function makeFetchStub() {
  return vi.fn((url) => {
    const u = String(url);
    if (u === "/api/me") return jsonResponse({ name: "Test User" });
    if (u === "/api/terminals") return jsonResponse({ terminals: [] });
    if (u === "/api/system") return jsonResponse({ cpu: 10, ramUsed: 4, ramTotal: 32 });
    if (u === "/api/bridge") return jsonResponse({ bridges: [] });
    if (u === "/api/bridge/channel") return jsonResponse({ channels: [] });
    if (u === "/api/usage/daily") return jsonResponse({});
    if (u.startsWith("/api/local/")) return jsonResponse({ reachable: false });
    // Generic fallback for anything else polled during mount.
    return jsonResponse({ ok: true });
  });
}

// ---------------------------------------------------------------------------

let consoleErrorSpy;

beforeEach(async () => {
  vi.resetModules();
  await setupTerminalMock();
  globalThis.fetch = makeFetchStub();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.clearAllMocks();
});

async function renderApp() {
  const { default: App } = await import("../App.jsx");
  let result;
  await act(async () => {
    result = render(React.createElement(App));
  });
  return result;
}

describe("AppShell — App.jsx composition root", () => {
  it("1. mounts without throwing and gets past the Connecting... splash once /api/me resolves", async () => {
    await renderApp();

    // Splash text present immediately (before /api/me resolves).
    // (Not asserted directly — act() above already flushes the effect that
    // resolves it — instead we assert the splash is GONE and the shell is up.)
    await waitFor(() => {
      expect(screen.queryByText("Connecting...")).not.toBeInTheDocument();
    });
    // Shell chrome landmark — command palette trigger only exists once past
    // the splash (splash renders nothing else).
    expect(screen.getByLabelText("Open command palette")).toBeInTheDocument();
  });

  it("2. renders the five shell regions: rail nav, command palette trigger, status strip", async () => {
    await renderApp();
    await waitFor(() => screen.getByLabelText("Open command palette"));

    // Rail — six items total (five sections + settings), queried by
    // accessible name, not CSS class.
    for (const name of ["WORK", "PROJECTS", "FLEET", "ENGINE", "REPORTS", "SETTINGS"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }

    // Command bar trigger.
    expect(screen.getByLabelText("Open command palette")).toBeInTheDocument();

    // Status strip — zoom controls are unique, stable accessible names it
    // always renders.
    expect(screen.getByLabelText("Zoom in")).toBeInTheDocument();
    expect(screen.getByLabelText("Zoom out")).toBeInTheDocument();
  });

  it("3. no 'rules of hooks' violation across the not-ready -> ready transition", async () => {
    await renderApp();
    await waitFor(() => screen.getByLabelText("Open command palette"));

    const hooksViolation = consoleErrorSpy.mock.calls.some(([msg]) =>
      typeof msg === "string" &&
      (/Rendered more hooks/i.test(msg) || /rules of hooks/i.test(msg) || /Rendered fewer hooks/i.test(msg))
    );
    expect(hooksViolation).toBe(false);
  });

  it("4. the pane-grid <main> node survives Fleet/Engine navigation by identity — hidden, not remounted", async () => {
    const { container } = await renderApp();
    await waitFor(() => screen.getByLabelText("Open command palette"));

    const mainBefore = container.querySelector("main");
    expect(mainBefore).not.toBeNull();
    expect(mainBefore.style.display).not.toBe("none");

    // Navigate to Fleet.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "FLEET" }));
    });
    const mainDuringFleet = container.querySelector("main");
    expect(mainDuringFleet).toBe(mainBefore); // identity, not just deep-equal
    expect(mainDuringFleet.style.display).toBe("none");

    // Navigate to Engine.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ENGINE" }));
    });
    const mainDuringEngine = container.querySelector("main");
    expect(mainDuringEngine).toBe(mainBefore);
    expect(mainDuringEngine.style.display).toBe("none");

    // Back to Work.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "WORK" }));
    });
    const mainAfter = container.querySelector("main");
    expect(mainAfter).toBe(mainBefore);
    expect(mainAfter.style.display).not.toBe("none");
  });
});
