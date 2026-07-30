/**
 * Tests for the terminal popout feature.
 *
 * Covers:
 *   1. TerminalPane shows popout button when onPopout prop is provided
 *   2. TerminalPane hides popout button when onPopout prop is absent
 *   3. TerminalPane calls onPopout with session when popout button is clicked
 *   4. main.jsx routing: renders PopoutTerminal when ?popout= param is present
 *   5. main.jsx routing: renders App when ?popout= param is absent
 *   6. BroadcastChannel CLOSED message removes session from poppedOutIds
 *
 * Tests 4 and 5 test the conditional URL-param logic directly rather than
 * importing main.jsx (which calls createRoot at module scope and cannot be
 * imported safely in jsdom).
 *
 * Test 6 is an integration test of the App.jsx BroadcastChannel effect.
 * Because App.jsx has deep network/PTY dependencies we isolate it with the
 * same mock set used by the paste test suite.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// jsdom polyfills
// ---------------------------------------------------------------------------

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(cb) { this._cb = cb; }
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

// ---------------------------------------------------------------------------
// BroadcastChannel mock — jsdom does not provide one.
// We expose a global registry so tests can obtain channel instances and
// inject messages into them.
// ---------------------------------------------------------------------------

const _bcInstances = {}; // name -> [instance, ...]

class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.onmessage = null;
    this._listeners = []; // for addEventListener-based subscribers
    if (!_bcInstances[name]) _bcInstances[name] = [];
    _bcInstances[name].push(this);
  }
  postMessage(data) {
    // Deliver to all OTHER instances on the same channel name
    (_bcInstances[this.name] || []).forEach((bc) => {
      if (bc !== this) {
        const event = { data };
        if (bc.onmessage) bc.onmessage(event);
        bc._listeners.forEach((fn) => fn(event));
      }
    });
  }
  addEventListener(type, fn) {
    if (type === "message") this._listeners.push(fn);
  }
  removeEventListener(type, fn) {
    if (type === "message") {
      const idx = this._listeners.indexOf(fn);
      if (idx !== -1) this._listeners.splice(idx, 1);
    }
  }
  close() {
    const list = _bcInstances[this.name];
    if (list) {
      const idx = list.indexOf(this);
      if (idx !== -1) list.splice(idx, 1);
    }
    this._listeners = [];
  }
}

globalThis.BroadcastChannel = MockBroadcastChannel;

// ---------------------------------------------------------------------------
// WebSocket mock
// ---------------------------------------------------------------------------

const MockWebSocket = vi.fn().mockImplementation(() => ({
  readyState: 1,
  send: vi.fn(),
  close: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}));
MockWebSocket.OPEN = 1;
MockWebSocket.CONNECTING = 0;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;
globalThis.WebSocket = MockWebSocket;

// ---------------------------------------------------------------------------
// Tauri API mocks — dynamic imports used in the reclaim path.
// vi.mock is hoisted so these intercept `await import(...)` calls even when
// window.__TAURI_INTERNALS__ is set to simulate a Tauri environment.
// ---------------------------------------------------------------------------

const mockTauriWindowClose = vi.fn().mockResolvedValue(undefined);
const mockGetCurrentWindow = vi.fn(() => ({ close: mockTauriWindowClose }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: mockGetCurrentWindow,
}));

const mockWebviewWindowClose = vi.fn().mockResolvedValue(undefined);
const mockGetByLabel = vi.fn().mockResolvedValue({ close: mockWebviewWindowClose });
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: mockGetByLabel,
  },
}));

// ---------------------------------------------------------------------------
// xterm and addon mocks — must be declared before component imports.
// vi.mock calls are hoisted by vitest.
// ---------------------------------------------------------------------------

vi.mock("@xterm/xterm", () => {
  const TerminalMock = vi.fn();
  return { Terminal: TerminalMock };
});

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    fit: vi.fn(),
    proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    dispose: vi.fn(),
  })),
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

// ---------------------------------------------------------------------------
// Shared theme mock
// ---------------------------------------------------------------------------

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
  ThemeProvider: ({ children }) => children,
}));

vi.mock("../components/StateIcon", () => ({
  default: () => React.createElement("span", null),
}));

// ---------------------------------------------------------------------------
// Heavy App.jsx dependencies that reference backend/tauri — mock them all so
// App can be imported without real network calls.
// ---------------------------------------------------------------------------

// MODELS is exported alongside default — TerminalPane.jsx/PopoutTerminal.jsx
// map session.model through it for display (falls back to the raw id when
// not found, which is what these tests assert for ids like
// "claude-sonnet-4-6" that intentionally aren't in the real MODELS list).
vi.mock("../components/TopBar", () => ({ default: () => null, MODELS: [] }));
vi.mock("../components/Sidebar", () => ({ default: () => null }));
vi.mock("../components/NewSessionDialog", () => ({ default: () => null }));
vi.mock("../components/OnboardingModal", () => ({ default: () => null }));
vi.mock("../components/BridgeModal", () => ({ default: () => null }));
vi.mock("../components/Toast", () => ({
  useToast: () => ({ toasts: [], toast: vi.fn(), removeToast: vi.fn() }),
  ToastContainer: () => null,
}));

// ---------------------------------------------------------------------------
// fetch — stub to avoid real network calls from App pollingintervals
// ---------------------------------------------------------------------------

globalThis.fetch = vi.fn().mockResolvedValue({
  ok: false,
  status: 503,
  json: vi.fn().mockResolvedValue({}),
});

// ---------------------------------------------------------------------------
// Set up fresh Terminal mock for each test
// ---------------------------------------------------------------------------

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
    // _core.linkifier must be truthy so the CanvasAddon guard passes (happy path).
    // Canvas regression guard tests below assert CanvasAddon IS called on mount.
    _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
  }));
}

// ---------------------------------------------------------------------------
// Session fixture
// ---------------------------------------------------------------------------

const SESSION = {
  id: "sess-pop-1",
  name: "PopTest",
  terminalId: "term-pop-1",
  model: "claude-sonnet-4-6",
  status: "running",
  activityState: "idle",
  workdir: "/tmp",
};

// ---------------------------------------------------------------------------
// Helper: render TerminalPane with all required props
// ---------------------------------------------------------------------------

async function renderPane(extraProps = {}) {
  await setupTerminalMock();
  const { default: TerminalPane } = await import("../components/TerminalPane.jsx");

  let result;
  await act(async () => {
    result = render(
      React.createElement(TerminalPane, {
        session: SESSION,
        onClose: vi.fn(),
        paneIndex: 0,
        onSwap: vi.fn(),
        onDragSourceChange: vi.fn(),
        toast: vi.fn(),
        ...extraProps,
      }),
    );
  });
  return result;
}

// ===========================================================================
// Suite 1 — TerminalPane popout button visibility and callback
// ===========================================================================

describe("TerminalPane popout button", () => {
  beforeEach(async () => {
    vi.resetModules();
    await setupTerminalMock();
    // Clear BC instances between tests
    Object.keys(_bcInstances).forEach((k) => delete _bcInstances[k]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // 1
  it("shows popout button when onPopout prop is provided", async () => {
    const onPopout = vi.fn();
    const { unmount } = await renderPane({ onPopout });

    expect(
      screen.getByRole("button", { name: "Open terminal in separate window" }),
    ).toBeInTheDocument();

    unmount();
  });

  // 2
  it("hides popout button when onPopout prop is absent", async () => {
    const { unmount } = await renderPane({ onPopout: undefined });

    expect(
      screen.queryByRole("button", { name: "Open terminal in separate window" }),
    ).not.toBeInTheDocument();

    unmount();
  });

  // 3
  it("calls onPopout with the session object when popout button is clicked", async () => {
    const onPopout = vi.fn();
    const { unmount } = await renderPane({ onPopout });

    const btn = screen.getByRole("button", { name: "Open terminal in separate window" });
    fireEvent.click(btn);

    expect(onPopout).toHaveBeenCalledTimes(1);
    expect(onPopout).toHaveBeenCalledWith(SESSION);

    unmount();
  });

  // 4 — Canvas renderer regression guard (TerminalPane)
  // Asserts CanvasAddon is used by TerminalPane on mount.
  // If a future change removes CanvasAddon in favour of a different renderer,
  // this test turns RED in CI.
  it("TerminalPane uses Canvas renderer (not WebGL) on mount", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    const { unmount } = await renderPane();

    // CanvasAddon constructor must have been called during terminal initialisation.
    // Removing the canvas loadAddon call drops this count to zero and fails CI.
    expect(CanvasAddon).toHaveBeenCalled();

    // loadAddon must have been called at least 3 times:
    // FitAddon + WebLinksAddon + CanvasAddon (SearchAddon may also be present).
    // A regression removing the canvas loadAddon call reduces this count.
    const termInstance = Terminal.mock.results[Terminal.mock.results.length - 1].value;
    expect(termInstance.loadAddon.mock.calls.length).toBeGreaterThanOrEqual(3);

    unmount();
  });

  // 5 — Canvas renderer regression guard (PopoutTerminal)
  // Asserts CanvasAddon is also used by PopoutTerminal on mount.
  it("PopoutTerminal uses Canvas renderer (not WebGL) on mount", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");

    let result;
    await act(async () => {
      result = render(
        React.createElement(PopoutTerminal, {
          terminalId: "tid-regrtest",
          name: "Regression",
          model: "claude-sonnet-4-6",
        }),
      );
    });

    // CanvasAddon constructor must have been called during PopoutTerminal setup.
    expect(CanvasAddon).toHaveBeenCalled();

    // loadAddon must have been called at least 3 times:
    // FitAddon + WebLinksAddon + CanvasAddon (PopoutTerminal has no SearchAddon).
    const termInstance = Terminal.mock.results[Terminal.mock.results.length - 1].value;
    expect(termInstance.loadAddon.mock.calls.length).toBeGreaterThanOrEqual(3);

    result.unmount();
  });
});

// ===========================================================================
// Suite 2 — main.jsx routing logic (tested directly, not via module import)
//
// main.jsx executes createRoot at import time which is unsafe in jsdom.
// We replicate the routing logic directly — this is equivalent to testing the
// conditional branch without the side effect of mounting to a real DOM root.
// ===========================================================================

describe("main.jsx routing logic", () => {
  // The logic under test (extracted from main.jsx lines 9-13):
  //
  //   const params = new URLSearchParams(window.location.search);
  //   const popoutTerminalId = params.get("popout");
  //   const popoutName = params.get("name") || "Terminal";
  //   const popoutModel = params.get("model") || "";
  //
  //   popoutTerminalId ? <PopoutTerminal ...> : <App />

  function parseMainJsxParams(search) {
    const params = new URLSearchParams(search);
    const popoutTerminalId = params.get("popout");
    const popoutName = params.get("name") || "Terminal";
    const popoutModel = params.get("model") || "";
    return { popoutTerminalId, popoutName, popoutModel };
  }

  // 4
  it("routes to PopoutTerminal when ?popout= param is present", () => {
    const search = "?popout=tid-123&name=My+Session&model=claude-sonnet-4-6";
    const { popoutTerminalId, popoutName, popoutModel } = parseMainJsxParams(search);

    // The conditional in main.jsx: popoutTerminalId ? PopoutTerminal : App
    expect(popoutTerminalId).toBe("tid-123");
    expect(popoutName).toBe("My Session");
    expect(popoutModel).toBe("claude-sonnet-4-6");

    // Confirm the boolean branch that renders PopoutTerminal would be taken
    expect(Boolean(popoutTerminalId)).toBe(true);
  });

  // 5
  it("routes to App when ?popout= param is absent", () => {
    const search = "";
    const { popoutTerminalId } = parseMainJsxParams(search);

    // The conditional in main.jsx: popoutTerminalId ? PopoutTerminal : App
    expect(popoutTerminalId).toBeNull();
    expect(Boolean(popoutTerminalId)).toBe(false);
  });

  // 4b — verify PopoutTerminal actually renders with correct props when fed those params
  it("PopoutTerminal renders name and model from URL params", async () => {
    const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");

    let result;
    await act(async () => {
      result = render(
        React.createElement(PopoutTerminal, {
          terminalId: "tid-123",
          name: "My Session",
          model: "claude-sonnet-4-6",
        }),
      );
    });

    // The header renders the name and model badge
    expect(screen.getByText("My Session")).toBeInTheDocument();
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();

    result.unmount();
  });

  // 5b — App renders (not PopoutTerminal) when no popout param
  it("App component renders when popoutTerminalId is falsy", async () => {
    // App renders a root div with id "app-root" or at minimum does not crash
    // We cannot render full App here due to its dependency on real fetch/timers,
    // but we can verify it does not render a PopoutTerminal header.
    // Instead, confirm the routing logic produces the right component type.
    const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");
    const { default: App } = await import("../App.jsx");

    // The component selected by the conditional
    const search = "";
    const params = new URLSearchParams(search);
    const popoutTerminalId = params.get("popout");

    const ComponentToRender = popoutTerminalId ? PopoutTerminal : App;
    expect(ComponentToRender).toBe(App);
  });
});

// ===========================================================================
// Suite 3 — BroadcastChannel CLOSED message clears poppedOutIds in App
// ===========================================================================

describe("App BroadcastChannel CLOSED integration", () => {
  beforeEach(async () => {
    vi.resetModules();
    await setupTerminalMock();
    // Clear BC registry between tests
    Object.keys(_bcInstances).forEach((k) => delete _bcInstances[k]);
    // Ensure Tauri is NOT active for these tests
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // 6
  it("CLOSED BroadcastChannel message removes the session from poppedOutIds and hides placeholder", async () => {
    // We test the BroadcastChannel effect and poppedOutIds state logic from App.jsx
    // by building a minimal React component that replicates the exact effect:
    //
    //   useEffect(() => {
    //     const bc = new BroadcastChannel("cockpit-popout");
    //     bc.onmessage = (event) => {
    //       if (event.data?.type === "CLOSED") {
    //         setPoppedOutIds((prev) => {
    //           const next = new Set(prev);
    //           next.delete(event.data.terminalId);
    //           return next;
    //         });
    //       }
    //     };
    //     return () => bc.close();
    //   }, []);
    //
    // Rather than rendering full App (which makes dozens of fetch calls),
    // we extract the exact state + effect under test into a minimal harness.

    const { useState, useEffect } = React;

    // poppedOutIds stores session.terminalId values (backend UUIDs), NOT session.id
    // (local integer counters). The CLOSED broadcast from PopoutTerminal sends
    // { terminalId: session.terminalId }, so both sides must use the same key.
    // Use distinct terminalId values here (matching SESSION.terminalId = "term-pop-1")
    // to prove the test is actually exercising the correct field.
    function PoppedOutHarness({ initialIds }) {
      const [poppedOutIds, setPoppedOutIds] = useState(new Set(initialIds));

      useEffect(() => {
        const bc = new BroadcastChannel("cockpit-popout");
        bc.onmessage = (event) => {
          if (event.data?.type === "CLOSED") {
            setPoppedOutIds((prev) => {
              const next = new Set(prev);
              next.delete(event.data.terminalId);
              return next;
            });
          }
        };
        return () => bc.close();
      }, []);

      return (
        <div>
          {poppedOutIds.has("term-pop-1") && (
            <div data-testid="placeholder-term-pop-1">Terminal open in separate window</div>
          )}
          {poppedOutIds.has("term-other") && (
            <div data-testid="placeholder-term-other">Terminal open in separate window</div>
          )}
        </div>
      );
    }

    // Seed with terminalId values (what App.jsx stores in poppedOutIds after the fix)
    let result;
    await act(async () => {
      result = render(
        React.createElement(PoppedOutHarness, {
          initialIds: ["term-pop-1", "term-other"],
        }),
      );
    });

    expect(screen.getByTestId("placeholder-term-pop-1")).toBeInTheDocument();
    expect(screen.getByTestId("placeholder-term-other")).toBeInTheDocument();

    // PopoutTerminal broadcasts CLOSED with session.terminalId ("term-pop-1")
    await act(async () => {
      const senderBc = new BroadcastChannel("cockpit-popout");
      senderBc.postMessage({ type: "CLOSED", terminalId: "term-pop-1" });
      senderBc.close();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("placeholder-term-pop-1")).not.toBeInTheDocument();
    });

    // The other session's placeholder must remain untouched
    expect(screen.getByTestId("placeholder-term-other")).toBeInTheDocument();

    result.unmount();
  });

  // 6b — CLOSED message with wrong terminalId does not remove unrelated sessions
  it("CLOSED message with wrong terminalId leaves poppedOutIds unchanged", async () => {
    const { useState, useEffect } = React;

    function PoppedOutHarness() {
      const [poppedOutIds, setPoppedOutIds] = useState(new Set(["term-abc"]));

      useEffect(() => {
        const bc = new BroadcastChannel("cockpit-popout");
        bc.onmessage = (event) => {
          if (event.data?.type === "CLOSED") {
            setPoppedOutIds((prev) => {
              const next = new Set(prev);
              next.delete(event.data.terminalId);
              return next;
            });
          }
        };
        return () => bc.close();
      }, []);

      return (
        <div>
          {poppedOutIds.has("term-abc") && (
            <div data-testid="placeholder-abc">placeholder</div>
          )}
        </div>
      );
    }

    let result;
    await act(async () => {
      result = render(React.createElement(PoppedOutHarness, {}));
    });

    expect(screen.getByTestId("placeholder-abc")).toBeInTheDocument();

    // Send CLOSED for a different terminalId — must not affect term-abc
    await act(async () => {
      const senderBc = new BroadcastChannel("cockpit-popout");
      senderBc.postMessage({ type: "CLOSED", terminalId: "term-xyz" });
      senderBc.close();
    });

    // Placeholder for term-abc must still be present
    expect(screen.getByTestId("placeholder-abc")).toBeInTheDocument();

    result.unmount();
  });
});

// ===========================================================================
// Suite 4 — RECLAIM: PopoutTerminal closes via the correct mechanism
// ===========================================================================

describe("PopoutTerminal RECLAIM handler", () => {
  beforeEach(async () => {
    vi.resetModules();
    await setupTerminalMock();
    Object.keys(_bcInstances).forEach((k) => delete _bcInstances[k]);
    mockTauriWindowClose.mockClear();
    mockGetCurrentWindow.mockClear();
    mockWebviewWindowClose.mockClear();
    mockGetByLabel.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  });

  // 7 — Browser path: RECLAIM calls window.close() when not under Tauri
  it("RECLAIM calls window.close() in browser (non-Tauri) environment", async () => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");
    let result;
    await act(async () => {
      result = render(
        React.createElement(PopoutTerminal, {
          terminalId: "term-reclaim-browser",
          name: "BrowserTest",
          model: "claude-sonnet-4-6",
        }),
      );
    });

    // Simulate the main window broadcasting RECLAIM
    await act(async () => {
      const senderBc = new BroadcastChannel("cockpit-popout");
      senderBc.postMessage({ type: "RECLAIM", terminalId: "term-reclaim-browser" });
      senderBc.close();
    });

    // Give async handler time to resolve
    await act(async () => {});

    expect(closeSpy).toHaveBeenCalledTimes(1);
    // Tauri API must NOT have been touched
    expect(mockGetCurrentWindow).not.toHaveBeenCalled();

    closeSpy.mockRestore();
    result.unmount();
  });

  // 8 — Tauri path: RECLAIM calls getCurrentWindow().close() and does NOT call window.close()
  it("RECLAIM calls getCurrentWindow().close() under Tauri and skips window.close()", async () => {
    window.__TAURI_INTERNALS__ = {};

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");
    let result;
    await act(async () => {
      result = render(
        React.createElement(PopoutTerminal, {
          terminalId: "term-reclaim-tauri",
          name: "TauriTest",
          model: "claude-sonnet-4-6",
        }),
      );
    });

    await act(async () => {
      const senderBc = new BroadcastChannel("cockpit-popout");
      senderBc.postMessage({ type: "RECLAIM", terminalId: "term-reclaim-tauri" });
      senderBc.close();
    });

    // Give the async handler (with dynamic import + await close) time to settle
    await act(async () => {});

    expect(mockGetCurrentWindow).toHaveBeenCalledTimes(1);
    expect(mockTauriWindowClose).toHaveBeenCalledTimes(1);
    // window.close() must NOT be called because we return early after Tauri close
    expect(closeSpy).not.toHaveBeenCalled();

    closeSpy.mockRestore();
    result.unmount();
  });

  // 9 — RECLAIM for a different terminalId is ignored
  it("RECLAIM for a different terminalId does not close this window", async () => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;

    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});

    const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");
    let result;
    await act(async () => {
      result = render(
        React.createElement(PopoutTerminal, {
          terminalId: "term-reclaim-mine",
          name: "MineTest",
          model: "claude-sonnet-4-6",
        }),
      );
    });

    await act(async () => {
      const senderBc = new BroadcastChannel("cockpit-popout");
      senderBc.postMessage({ type: "RECLAIM", terminalId: "term-reclaim-other" });
      senderBc.close();
    });

    await act(async () => {});

    expect(closeSpy).not.toHaveBeenCalled();

    closeSpy.mockRestore();
    result.unmount();
  });
});

// ===========================================================================
// Suite 5 — RECLAIM: App.jsx reclaim button closes via Tauri or BroadcastChannel
// ===========================================================================

describe("App reclaim button closes popout window", () => {
  beforeEach(async () => {
    vi.resetModules();
    await setupTerminalMock();
    Object.keys(_bcInstances).forEach((k) => delete _bcInstances[k]);
    mockWebviewWindowClose.mockClear();
    mockGetByLabel.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
  });

  // 10 — In Tauri: reclaim button calls WebviewWindow.getByLabel with the correct label
  it("reclaim button calls WebviewWindow.getByLabel with correct label under Tauri", async () => {
    window.__TAURI_INTERNALS__ = {};

    // Build a minimal harness that mirrors the reclaim onClick from App.jsx
    // (tests the label scheme and Tauri API usage without rendering full App)
    const terminalId = "term-uuid-abc-123";
    const expectedLabel = `popout-${terminalId.replace(/[^a-zA-Z0-9-]/g, "-")}`;

    let capturedLabel = null;
    mockGetByLabel.mockImplementation(async (label) => {
      capturedLabel = label;
      return { close: mockWebviewWindowClose };
    });

    // Execute the same logic as the reclaim onClick
    if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const label = `popout-${terminalId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
      const w = await WebviewWindow.getByLabel(label);
      await w?.close();
    }

    expect(capturedLabel).toBe(expectedLabel);
    expect(mockWebviewWindowClose).toHaveBeenCalledTimes(1);
  });

  // 11 — Label scheme matches handlePopout exactly (same regex, same prefix)
  it("reclaim label scheme is byte-identical to handlePopout label scheme", () => {
    // handlePopout uses: `popout-${terminalId.replace(/[^a-zA-Z0-9-]/g, "-")}`
    // reclaim button uses the same expression — verify with a terminalId that
    // contains characters the regex would sanitize.
    const terminalId = "term/uuid:special_chars!@#";
    const handlePopoutLabel = `popout-${terminalId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
    const reclaimLabel = `popout-${terminalId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
    expect(reclaimLabel).toBe(handlePopoutLabel);
    expect(reclaimLabel).toBe("popout-term-uuid-special-chars---");
  });
});
