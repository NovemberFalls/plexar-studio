/**
 * Tests for the resize/refit-notify path in TerminalPane.jsx (safeFit +
 * debounced ResizeObserver + zoom refit + visibilitychange refit + dedupe),
 * added as part of the cols/rows-desync investigation (garbled TUI redraws
 * caused by the backend PTY size drifting from the actual rendered terminal
 * size after zoom/layout/visibility changes were never notified).
 *
 * xterm.js is mocked (as in TerminalPane.actions.test.jsx); the returned
 * Terminal mock exposes mutable `cols`/`rows` so tests can simulate what a
 * real FitAddon.fit() call would have computed, without needing real canvas
 * font measurement (unavailable in jsdom).
 *
 * ResizeObserver is mocked to capture its callback so tests can invoke a
 * "resize tick" directly. requestAnimationFrame is shimmed to run
 * synchronously so the zoom effect's double-rAF resolves deterministically;
 * setTimeout/clearTimeout are faked via vi.useFakeTimers() to control the
 * ResizeObserver debounce (150ms) and the zoom fallback fit (120ms).
 *
 * What is tested:
 *   1. resize_sends_dims_on_first_fit           — a resize tick sends {cols, rows} once
 *   2. resize_debounce_collapses_burst          — many rapid ticks -> one send
 *   3. resize_dedupe_suppresses_unchanged_dims  — a second tick with identical
 *                                                  dims sends nothing more
 *   4. resize_sends_again_when_dims_differ      — a tick with new dims sends again
 *   5. hidden_container_skips_fit_and_send      — clientWidth/Height < 10 -> no-op
 *   6. zoom_change_triggers_refit_with_new_dims — terminalZoom prop change refits
 *      and sends the new dims once font size changed cols/rows
 *   7. zoom_fallback_timer_is_deduped_not_duplicated — the 120ms fallback fit
 *      after a zoom change does not double-send when dims are unchanged
 *   8. visibilitychange_hidden_is_a_noop        — document.hidden=true -> no send
 *   9. visibilitychange_visible_refits          — document.hidden=false -> send
 *      when the container's dims changed while occluded
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

/** Shadow a specific element's clientWidth/clientHeight with an own property
 *  (e.g. to simulate a hidden/zero-size pane for one test). */
function overrideElementClientSize(container, { width, height }) {
  const el = container.querySelector(".w-full.h-full");
  Object.defineProperty(el, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  return el;
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
// Resize observer: debounce + dedupe
// ===========================================================================

describe("TerminalPane — resize observer (debounce + dedupe)", () => {
  it("sends {cols, rows} once a resize tick settles", async () => {
    await renderPane();
    wsSendSpy.mockClear(); // ignore the initial mount fit's send

    expect(capturedResizeCallback).toBeTypeOf("function");
    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);
  });

  it("collapses a rapid burst of ticks into a single send", async () => {
    await renderPane();
    wsSendSpy.mockClear();

    await act(async () => {
      for (let i = 0; i < 20; i++) {
        capturedResizeCallback();
        await vi.advanceTimersByTimeAsync(10); // always within the 150ms debounce window
      }
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(sentResizes()).toHaveLength(1);
  });

  it("does not resend when a later tick settles on the same dims", async () => {
    await renderPane();
    wsSendSpy.mockClear();

    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(sentResizes()).toHaveLength(1);

    // A second, independent resize tick (e.g. window resized back to the same
    // size) computes identical cols/rows — should be suppressed by dedupe.
    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(sentResizes()).toHaveLength(1);
  });

  it("resends when a later tick settles on different dims", async () => {
    await renderPane();
    wsSendSpy.mockClear();

    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);

    mockTerm.cols = 180;
    mockTerm.rows = 30;
    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });
    expect(sentResizes()).toEqual([
      { type: "resize", cols: 136, rows: 26 },
      { type: "resize", cols: 180, rows: 30 },
    ]);
  });

  it("skips fit() and the WS send entirely while the container is hidden/zero-sized", async () => {
    const { container } = await renderPane();
    // Explicitly collapse the container (simulates display:none / mid-transition)
    overrideElementClientSize(container, { width: 0, height: 0 });
    wsSendSpy.mockClear();
    fitSpy.mockClear();

    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(fitSpy).not.toHaveBeenCalled();
    expect(sentResizes()).toHaveLength(0);
  });
});

// ===========================================================================
// Zoom refit — the ResizeObserver alone cannot catch a font-size-only change
// ===========================================================================

describe("TerminalPane — zoom-triggered refit", () => {
  it("updates xterm's fontSize and sends the new dims when zoom changes", async () => {
    const { rerender } = await renderPane({ terminalZoom: 13 });
    wsSendSpy.mockClear();

    // Simulate FitAddon computing a wider terminal at the smaller font size
    mockTerm.cols = 160;
    mockTerm.rows = 30;

    const { default: TerminalPane } = await import("../components/TerminalPane.jsx");
    await act(async () => {
      rerender(
        React.createElement(TerminalPane, {
          session: BASE_SESSION,
          onClose: vi.fn(),
          paneIndex: 0,
          onSwap: vi.fn(),
          onDragSourceChange: vi.fn(),
          toast: vi.fn(),
          terminalZoom: 10,
        }),
      );
      await vi.advanceTimersByTimeAsync(120);
    });

    expect(mockTerm.options.fontSize).toBe(10);
    expect(sentResizes()).toEqual([{ type: "resize", cols: 160, rows: 30 }]);
  });

  it("does not double-send from the 120ms fallback fit when dims are unchanged", async () => {
    const { rerender } = await renderPane({ terminalZoom: 13 });
    wsSendSpy.mockClear();
    mockTerm.cols = 160;
    mockTerm.rows = 30;

    const { default: TerminalPane } = await import("../components/TerminalPane.jsx");
    await act(async () => {
      rerender(
        React.createElement(TerminalPane, {
          session: BASE_SESSION,
          onClose: vi.fn(),
          paneIndex: 0,
          onSwap: vi.fn(),
          onDragSourceChange: vi.fn(),
          toast: vi.fn(),
          terminalZoom: 10,
        }),
      );
      // Advance well past both the synchronous double-rAF fit AND the 120ms
      // fallback fit — dims never change again, so dedupe must suppress the
      // fallback's would-be duplicate send.
      await vi.advanceTimersByTimeAsync(200);
    });

    expect(sentResizes()).toHaveLength(1);
  });
});

// ===========================================================================
// visibilitychange — catches minimize/restore, which no DOM resize fires for
// ===========================================================================

describe("TerminalPane — visibilitychange refit", () => {
  function setDocumentHidden(hidden) {
    Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
  }

  afterEach(() => {
    setDocumentHidden(false);
  });

  it("does nothing while the document is hidden", async () => {
    await renderPane();
    wsSendSpy.mockClear();
    mockTerm.cols = 200;
    mockTerm.rows = 40;

    setDocumentHidden(true);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(sentResizes()).toHaveLength(0);
  });

  it("refits once the document becomes visible again", async () => {
    await renderPane();
    wsSendSpy.mockClear();
    mockTerm.cols = 200;
    mockTerm.rows = 40;

    setDocumentHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(sentResizes()).toEqual([{ type: "resize", cols: 200, rows: 40 }]);
  });
});

// ===========================================================================
// terminalId change — a new backend PTY invalidates the dedupe cache
// ===========================================================================

describe("TerminalPane — terminalId change resets the dedupe cache", () => {
  it("resends the current dims to a newly-connected terminal even if unchanged locally", async () => {
    const { rerender } = await renderPane({
      session: { ...BASE_SESSION, terminalId: "term-1" },
    });

    // Mount already sent {136, 26} to term-1.
    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);

    const { default: TerminalPane } = await import("../components/TerminalPane.jsx");
    await act(async () => {
      rerender(
        React.createElement(TerminalPane, {
          session: { ...BASE_SESSION, terminalId: "term-2" },
          onClose: vi.fn(),
          paneIndex: 0,
          onSwap: vi.fn(),
          onDragSourceChange: vi.fn(),
          toast: vi.fn(),
          terminalZoom: 13,
        }),
      );
      // The mock WebSocket never auto-fires onopen (unlike a real socket) —
      // simulate the reconnect completing, which is what actually triggers
      // safeFit() again in production (see connectWs's ws.onopen handler).
      wsInstance.onopen?.();
    });

    // Reconnecting to a different terminalId triggers ws.onopen -> safeFit(),
    // which must send fresh dims to term-2 even though cols/rows (136/26)
    // are identical to what was last sent to term-1 — term-2 has no
    // knowledge of that value.
    const resizesAfterReconnect = sentResizes();
    expect(resizesAfterReconnect.length).toBeGreaterThanOrEqual(2);
    expect(resizesAfterReconnect[resizesAfterReconnect.length - 1]).toEqual({
      type: "resize", cols: 136, rows: 26,
    });
  });
});

// ===========================================================================
// resize_failed — backend couldn't apply the last resize; must clear the
// dedupe cache so the NEXT safeFit() re-sends instead of assuming the
// backend already has the current dims (silent permanent divergence bug).
// ===========================================================================

describe("TerminalPane — resize_failed clears the dedupe cache", () => {
  it("re-sends unchanged dims on the next fit after a resize_failed message", async () => {
    await renderPane();
    // Mount already sent {136, 26}.
    expect(sentResizes()).toEqual([{ type: "resize", cols: 136, rows: 26 }]);

    await act(async () => {
      wsInstance.onmessage?.({ data: '{"type":"resize_failed"}' });
    });

    // Without the cache-clear, a same-dims tick would be suppressed by
    // dedupe. cols/rows haven't changed, but the fix must still re-send.
    await act(async () => {
      capturedResizeCallback();
      await vi.advanceTimersByTimeAsync(150);
    });

    expect(sentResizes()).toEqual([
      { type: "resize", cols: 136, rows: 26 },
      { type: "resize", cols: 136, rows: 26 },
    ]);
  });
});
