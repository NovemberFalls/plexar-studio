/**
 * Shared PTY size (SPEC A): every xterm showing a PTY carries the PTY's
 * cols/rows. A pane that did not set the size follows a server resize frame
 * until the user acts on it. Harness copied from TerminalPane.resize.test.jsx.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// ResizeObserver mock — captures the constructor callback so tests can fire
// a synthetic "resize tick" directly.
// ---------------------------------------------------------------------------

let capturedResizeCallback = null;
globalThis.ResizeObserver = class ResizeObserver {
  constructor(cb) { capturedResizeCallback = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
};


// Synchronous rAF shim: the zoom effect's double-rAF resolves in the same
// tick, so tests don't need to juggle two async microtask hops on top of
// fake timers for the 120ms fallback.
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = () => {};

// ---------------------------------------------------------------------------
// xterm + addon mocks
// ---------------------------------------------------------------------------

const fitSpy = vi.fn();

vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(),
    fit: fitSpy,
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
    activate: vi.fn(), findNext: vi.fn(), findPrevious: vi.fn(), clearDecorations: vi.fn(), dispose: vi.fn(),
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
// WebSocket mock
// ---------------------------------------------------------------------------

let wsSendSpy;
let wsInstance;

function installWebSocketMock() {
  wsSendSpy = vi.fn();
  wsInstance = {
    readyState: 1, // OPEN
    send: wsSendSpy,
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  const MockWebSocket = vi.fn().mockImplementation(() => wsInstance);
  MockWebSocket.OPEN = 1;
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockWebSocket;
}

/** Extract the {cols, rows} payloads from every "resize" message sent over the WS mock. */
function sentResizes() {
  return wsSendSpy.mock.calls
    .map(([raw]) => JSON.parse(raw))
    .filter((msg) => msg.type === "resize");
}

// ---------------------------------------------------------------------------
// Terminal mock — mutable cols/rows so tests can simulate what a real
// FitAddon.fit() would have computed for the current font size/container.
// ---------------------------------------------------------------------------

let mockTerm;

async function setupTerminalMock() {
  const { Terminal } = await import("@xterm/xterm");
  Terminal.mockImplementation(() => {
    mockTerm = {
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
      cols: 136,
      rows: 26,
      _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
    };
    return mockTerm;
  });
}

// ---------------------------------------------------------------------------
// Fixtures + render helper
// ---------------------------------------------------------------------------

const BASE_SESSION = {
  id: "sess-1",
  name: "Alpha",
  terminalId: "term-1",
  model: "sonnet",
  status: "running",
  activityState: "idle",
};

// jsdom does not do real layout, so every element's clientWidth/clientHeight
// is 0 unless overridden. Patch the prototype so ALL elements — including the
// termRef div created during the very first synchronous mount-time fit —
// report a "visible, normally sized" box by default. Individual tests can
// still shadow this with an own-property override (e.g. to simulate a
// hidden/zero-size pane), since an own property always wins over an
// inherited accessor.
let restoreClientSizeProto;
function mockDefaultClientSize(width = 800, height = 400) {
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => height });
  restoreClientSizeProto = () => {
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, "clientWidth", widthDesc);
    if (heightDesc) Object.defineProperty(HTMLElement.prototype, "clientHeight", heightDesc);
  };
}


async function renderPane(extraProps = {}) {
  await setupTerminalMock();
  const { default: TerminalPane } = await import("../components/TerminalPane.jsx");
  // Pre-resolve and cache the platform-info fetch BEFORE mounting, so
  // TerminalPane's own `await getPlatformInfo()` inside its init effect
  // unwraps an already-settled promise (one microtask tick) instead of
  // chaining through fresh fetch()/res.json() hops that outlive act()'s
  // single-tick flush of the render callback.
  const { getPlatformInfo } = await import("../utils/platformInfo");
  await getPlatformInfo();

  let result;
  await act(async () => {
    result = render(
      React.createElement(TerminalPane, {
        session: BASE_SESSION,
        onClose: vi.fn(),
        paneIndex: 0,
        onSwap: vi.fn(),
        onDragSourceChange: vi.fn(),
        toast: vi.fn(),
        terminalZoom: 13,
        ...extraProps,
      }),
    );
  });
  return result;
}

beforeEach(async () => {
  vi.resetModules();
  capturedResizeCallback = null;
  installWebSocketMock();
  await setupTerminalMock();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ ok: true }),
  });
  mockDefaultClientSize(800, 400);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  restoreClientSizeProto?.();
  vi.clearAllMocks();
});


// ===========================================================================
// Shared PTY size: the server announces the PTY's cols/rows; a pane whose size
// differs follows it until the user acts on that pane.
// ===========================================================================

function frame(cols, rows) {
  return { data: JSON.stringify({ type: "resize", cols, rows }) };
}

function useRealisticTerm() {
  // term.resize changes xterm's dims; fit() restores the pane's own size.
  mockTerm.resize.mockImplementation((c, r) => { mockTerm.cols = c; mockTerm.rows = r; });
  fitSpy.mockImplementation(() => { mockTerm.cols = 136; mockTerm.rows = 26; });
}

function writtenText() {
  return mockTerm.write.mock.calls.map(([d]) => d).join("");
}

describe("TerminalPane — shared PTY size", () => {
  afterEach(() => { fitSpy.mockReset(); });

  it("a frame equal to the current size is a no-op", async () => {
    const { queryByTestId } = await renderPane();
    useRealisticTerm();
    wsSendSpy.mockClear();
    await act(async () => { wsInstance.onmessage(frame(136, 26)); });
    expect(mockTerm.resize).not.toHaveBeenCalled();
    expect(queryByTestId("pane-foreign-size")).toBeNull();
    expect(sentResizes()).toHaveLength(0);
  });

  it("a differing frame resizes xterm, shows the chip and sends nothing", async () => {
    const { getByTestId } = await renderPane();
    useRealisticTerm();
    wsSendSpy.mockClear();
    await act(async () => { wsInstance.onmessage(frame(100, 30)); });
    expect(mockTerm.resize).toHaveBeenCalledWith(100, 30);
    expect(getByTestId("pane-foreign-size").textContent).toBe("Sized for another screen. Click to fit here.");
    expect(sentResizes()).toHaveLength(0);
    expect(writtenText()).not.toContain("resize");
  });

  it("a ResizeObserver fit while following neither fits nor sends", async () => {
    await renderPane();
    useRealisticTerm();
    await act(async () => { wsInstance.onmessage(frame(100, 30)); });
    wsSendSpy.mockClear();
    fitSpy.mockClear();
    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(fitSpy).not.toHaveBeenCalled();
    expect(sentResizes()).toHaveLength(0);
    expect(mockTerm.cols).toBe(100);
  });

  it("clicking the chip fits, sends one resize and removes the chip", async () => {
    const { getByTestId, queryByTestId } = await renderPane();
    useRealisticTerm();
    await act(async () => { wsInstance.onmessage(frame(100, 30)); });
    wsSendSpy.mockClear();
    await act(async () => { getByTestId("pane-foreign-size").click(); });
    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);
    expect(queryByTestId("pane-foreign-size")).toBeNull();
  });

  it("the late echo of this pane's own claim ends following", async () => {
    const { getByTestId, queryByTestId } = await renderPane();
    useRealisticTerm();
    await act(async () => { wsInstance.onmessage(frame(100, 30)); });
    await act(async () => { getByTestId("pane-foreign-size").click(); });
    // An older foreign size the server sent before it applied our claim...
    await act(async () => { wsInstance.onmessage(frame(100, 30)); });
    expect(queryByTestId("pane-foreign-size")).not.toBeNull();
    // ...then the echo of our own size: ours again, no chip, fits resume.
    await act(async () => { wsInstance.onmessage(frame(136, 26)); });
    expect(queryByTestId("pane-foreign-size")).toBeNull();
    expect(mockTerm.cols).toBe(136);
  });

  it("a mousedown in the terminal claims the size", async () => {
    const { container, queryByTestId } = await renderPane();
    useRealisticTerm();
    await act(async () => { wsInstance.onmessage(frame(100, 30)); });
    wsSendSpy.mockClear();
    const termEl = container.querySelector(".w-full.h-full");
    await act(async () => {
      termEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);
    expect(queryByTestId("pane-foreign-size")).toBeNull();
  });

  it("never writes a resize frame (even malformed) into the terminal", async () => {
    await renderPane();
    useRealisticTerm();
    await act(async () => {
      wsInstance.onmessage(frame(100, 30));
      wsInstance.onmessage({ data: '{"type":"resize","cols":"x","rows":-1}' });
      wsInstance.onmessage({ data: '{"type":"resize"}' });
    });
    expect(writtenText()).not.toContain("resize");
  });
});

describe("consumeReplayFrame — resize frames", () => {
  const handlers = () => ({ reset: vi.fn(), enqueue: vi.fn(), warning: vi.fn(), resize: vi.fn() });

  it("calls resize with valid dims and reports handled", async () => {
    const { consumeReplayFrame, createReplayCursor } = await import("../utils/terminalReplay");
    const h = handlers();
    expect(consumeReplayFrame('{"type":"resize","cols":90,"rows":20}', createReplayCursor(), h)).toBe(true);
    expect(h.resize).toHaveBeenCalledWith(90, 20);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("is handled without a resize handler", async () => {
    const { consumeReplayFrame, createReplayCursor } = await import("../utils/terminalReplay");
    expect(consumeReplayFrame('{"type":"resize","cols":90,"rows":20}', createReplayCursor(),
      { reset: vi.fn(), enqueue: vi.fn(), warning: vi.fn() })).toBe(true);
  });

  it.each([
    '{"type":"resize"}',
    '{"type":"resize","cols":0,"rows":20}',
    '{"type":"resize","cols":90,"rows":-1}',
    '{"type":"resize","cols":"90","rows":20}',
    '{"type":"resize","cols":90.5,"rows":20}',
  ])("swallows malformed %s without calling resize", async (raw) => {
    const { consumeReplayFrame, createReplayCursor } = await import("../utils/terminalReplay");
    const h = handlers();
    expect(consumeReplayFrame(raw, createReplayCursor(), h)).toBe(true);
    expect(h.resize).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
