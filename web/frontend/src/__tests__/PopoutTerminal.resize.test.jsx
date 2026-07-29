/**
 * Tests for the resize/zoom-sync path added to PopoutTerminal.jsx as part of
 * the cols/rows-desync investigation.
 *
 * PopoutTerminal runs in a separate browser/Tauri window/document — it has
 * no React prop link to App.jsx's `terminalZoom` state, so it must read the
 * persisted zoom level from localStorage on mount and stay in sync via the
 * `storage` event (which fires on OTHER windows of the same origin whenever
 * the main window's zoom controls write a new value).
 *
 * What is tested:
 *   1. mounts_at_persisted_zoom_not_hardcoded_default — reads
 *      cockpit-terminal-zoom from localStorage instead of hardcoding 13
 *   2. mounts_at_default_zoom_when_nothing_persisted   — falls back cleanly
 *   3. storage_event_updates_font_size_and_refits       — a same-origin
 *      localStorage write from the main window updates fontSize + resends dims
 *   4. storage_event_for_unrelated_key_is_ignored       — only the zoom key matters
 *   5. resize_dedupe_suppresses_unchanged_dims          — parity with TerminalPane
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ZOOM_STORAGE_KEY } from "../utils/terminalFit";

// ---------------------------------------------------------------------------
// jsdom polyfills
// ---------------------------------------------------------------------------

let capturedResizeCallback = null;
globalThis.ResizeObserver = class ResizeObserver {
  constructor(cb) { capturedResizeCallback = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
};

globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = () => {};

if (typeof globalThis.BroadcastChannel === "undefined") {
  globalThis.BroadcastChannel = class BroadcastChannel {
    constructor() {}
    postMessage() {}
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };
}

// jsdom does not do real layout — patch the prototype so every element
// reports a "visible, normally sized" box, including the termRef div created
// during the very first synchronous mount-time fit.
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

// ---------------------------------------------------------------------------
// xterm + addon mocks
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

function sentResizes() {
  return wsSendSpy.mock.calls
    .map(([raw]) => JSON.parse(raw))
    .filter((msg) => msg.type === "resize");
}

// ---------------------------------------------------------------------------
// Terminal mock — mutable cols/rows/options.fontSize
// ---------------------------------------------------------------------------

let mockTerm;

async function setupTerminalMock() {
  const { Terminal } = await import("@xterm/xterm");
  Terminal.mockImplementation((opts) => {
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
      options: { theme: {}, fontSize: opts?.fontSize },
      cols: 136,
      rows: 26,
      _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
    };
    return mockTerm;
  });
}

async function renderPopout() {
  const { default: PopoutTerminal } = await import("../components/PopoutTerminal.jsx");
  // Pre-resolve and cache the platform-info fetch BEFORE mounting — see the
  // matching comment in TerminalPane.resize.test.jsx's renderPane().
  const { getPlatformInfo } = await import("../utils/platformInfo");
  await getPlatformInfo();

  let result;
  await act(async () => {
    result = render(
      React.createElement(PopoutTerminal, {
        terminalId: "term-popout-1",
        name: "PopoutTest",
        model: "claude-sonnet-4-6",
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
  mockDefaultClientSize(800, 400);
  localStorage.clear();
});

afterEach(() => {
  restoreClientSizeProto?.();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("PopoutTerminal — zoom sync via localStorage", () => {
  it("mounts at the persisted zoom level instead of a hardcoded default", async () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(20));
    await renderPopout();
    expect(mockTerm.options.fontSize).toBe(20);
  });

  it("falls back to the default zoom when nothing is persisted", async () => {
    await renderPopout();
    expect(mockTerm.options.fontSize).toBe(13); // DEFAULT_ZOOM
  });

  it("updates fontSize and resends dims when the main window changes zoom", async () => {
    await renderPopout();
    wsSendSpy.mockClear();

    // Simulate the main window's applyZoom() persisting a new value, then
    // the `storage` event that fires on THIS (other) window as a result.
    // A different font size implies different cols/rows once FitAddon
    // re-measures — simulate that too.
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(18));
    mockTerm.cols = 100;
    mockTerm.rows = 20;

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: ZOOM_STORAGE_KEY, newValue: "18" }));
    });

    expect(mockTerm.options.fontSize).toBe(18);
    expect(sentResizes()).toEqual([{ type: "resize", cols: 100, rows: 20 }]);
  });

  it("ignores storage events for unrelated keys", async () => {
    await renderPopout();
    wsSendSpy.mockClear();
    const fontSizeBefore = mockTerm.options.fontSize;

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "cockpit-sidebar-width", newValue: "300" }));
    });

    expect(mockTerm.options.fontSize).toBe(fontSizeBefore);
    expect(sentResizes()).toHaveLength(0);
  });

  it("does not refit when the persisted value did not actually change", async () => {
    localStorage.setItem(ZOOM_STORAGE_KEY, JSON.stringify(13));
    await renderPopout();
    wsSendSpy.mockClear();
    mockTerm.cols = 999; // would prove a refit happened, if one did

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: ZOOM_STORAGE_KEY, newValue: "13" }));
    });

    expect(sentResizes()).toHaveLength(0);
  });
});

describe("PopoutTerminal — resize dedupe (parity with TerminalPane)", () => {
  it("does not resend a resize tick that settles on unchanged dims", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderPopout();
    wsSendSpy.mockClear();

    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);

    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(sentResizes()).toHaveLength(1);
    vi.useRealTimers();
  });

  it("re-sends unchanged dims on the next fit after a resize_failed message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await renderPopout();

    // Establish a known baseline send (mirrors the dedupe test above, which
    // doesn't rely on PopoutTerminal's mount-time send mechanics either).
    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);

    await act(async () => {
      wsInstance.onmessage?.({ data: '{"type":"resize_failed"}' });
    });

    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });

    // Without the cache-clear, the second tick (same dims) would be
    // suppressed by dedupe. The fix must still re-send.
    expect(sentResizes()).toEqual([
      { type: "resize", cols: 136, rows: 26 },
      { type: "resize", cols: 136, rows: 26 },
    ]);
    vi.useRealTimers();
  });
});
