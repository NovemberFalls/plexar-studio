/**
 * Tests for the paste handler logic in TerminalPane.
 * (web/frontend/src/components/TerminalPane.jsx, lines ~231–400)
 *
 * Strategy:
 *   xterm.js is mocked entirely (vi.mock) so we can exercise the pasteHandler
 *   closure without needing a real DOM canvas / WebGL context.  The tests
 *   extract the pasteHandler by capturing the 'paste' event listener that
 *   TerminalPane registers on its termRef element during mount.
 *
 * What is tested:
 *   1. text_paste_calls_xterm_paste_once       — text paste uses xterm.paste(), not wsRef.send
 *   2. image_paste_uploads_and_sends_path       — image paste POSTs to /api/upload, sends path via WS
 *   3. image_paste_sends_quoted_path_when_spaces — path with spaces is quoted before WS send
 *   4. paste_event_calls_preventDefault_and_stopPropagation
 *   5. ctrl_v_keydown_returns_false             — customKeyEventHandler blocks Ctrl+V
 *   6. alt_v_with_image_uploads_and_sends_path — Alt+V reads clipboard image, uploads, sends path
 *   7. alt_v_with_text_only_calls_xterm_paste  — Alt+V with no image falls back to xterm.paste()
 *   8. alt_v_clipboard_unavailable_shows_toast — Alt+V when clipboard API throws shows error toast
 *
 * Note on test 5–8: the customKeyEventHandler is registered via
 * term.attachCustomKeyEventHandler().  We capture the registered function
 * and invoke it directly.
 *
 * Dependencies already present in package.json:
 *   @testing-library/react ^16, vitest ^3, jsdom ^25
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

// ---------------------------------------------------------------------------
// jsdom polyfills required by TerminalPane
// ---------------------------------------------------------------------------

// ResizeObserver is not in jsdom — mock it globally before any imports
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(cb) { this._cb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// requestAnimationFrame stub (jsdom has a basic one but let's be safe)
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}

// WebSocket stub — created fresh per test via global injection
let _wsSendSpy = vi.fn();
let _wsInstance = null;

// ---------------------------------------------------------------------------
// Tracking variables for captured handlers (reset per test)
// ---------------------------------------------------------------------------

let capturedPasteHandler = null;
let capturedKeyHandler = null;
let mockTermPaste = null;

// ---------------------------------------------------------------------------
// Mock xterm and addons BEFORE importing the component.
// vi.mock is hoisted by vitest, so these run before any test imports.
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

// Mock theme hook
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
// Intercept addEventListener to capture the paste and capture keyhandler
// ---------------------------------------------------------------------------

const _origAddEventListener = EventTarget.prototype.addEventListener;

function patchListeners() {
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type === "paste") {
      capturedPasteHandler = listener;
    }
    return _origAddEventListener.call(this, type, listener, options);
  };
}

function unpatchListeners() {
  EventTarget.prototype.addEventListener = _origAddEventListener;
}

// ---------------------------------------------------------------------------
// Build the Terminal mock fresh for each test so clearAllMocks doesn't
// break the implementation.
// ---------------------------------------------------------------------------

async function setupTerminalMock() {
  const { Terminal } = await import("@xterm/xterm");
  capturedKeyHandler = null;
  mockTermPaste = vi.fn();

  Terminal.mockImplementation(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    paste: mockTermPaste,
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
    attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => {
      capturedKeyHandler = fn;
    }),
    dispose: vi.fn(),
    options: { theme: {}, fontSize: 13 },
    // _core.linkifier must be truthy so the CanvasAddon guard passes (happy path).
    // When linkifier is absent, Canvas is intentionally skipped — tested separately.
    _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
  }));
}

// ---------------------------------------------------------------------------
// Minimal session fixture
// ---------------------------------------------------------------------------

const SESSION = {
  id: "sess-1",
  name: "Test",
  terminalId: "term-1",
  model: "sonnet",
  status: "running",
  activityState: "idle",
};

// ---------------------------------------------------------------------------
// renderPane — render TerminalPane with a mock WebSocket
// ---------------------------------------------------------------------------

async function renderPane({ toastSpy } = {}) {
  _wsSendSpy = vi.fn();
  _wsInstance = {
    readyState: 1, // WebSocket.OPEN
    send: _wsSendSpy,
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  // Intercept WebSocket constructor with static OPEN constant
  const MockWebSocket = vi.fn().mockImplementation(() => _wsInstance);
  MockWebSocket.OPEN = 1;
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  globalThis.WebSocket = MockWebSocket;

  const { default: TerminalPane } = await import("../components/TerminalPane.jsx");

  let unmount;
  let container;
  await act(async () => {
    const result = render(
      React.createElement(TerminalPane, {
        session: SESSION,
        onClose: vi.fn(),
        paneIndex: 0,
        onSwap: vi.fn(),
        onDragSourceChange: vi.fn(),
        toast: toastSpy,
      }),
    );
    unmount = result.unmount;
    container = result.container;
  });

  return { wsSendSpy: _wsSendSpy, unmount, container };
}

// ---------------------------------------------------------------------------
// Helpers — build fake clipboard events
// ---------------------------------------------------------------------------

function makeTextPasteEvent(text = "hello world") {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clipboardData: {
      getData: vi.fn().mockReturnValue(text),
      items: [],
    },
  };
}

function makeImagePasteEvent({ type = "image/png" } = {}) {
  const blob = new Blob(["fake-image-bytes"], { type });
  const item = {
    kind: "file",
    type,
    getAsFile: vi.fn().mockReturnValue(blob),
  };
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    clipboardData: {
      getData: vi.fn().mockReturnValue(""),
      items: [item],
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers — build fake navigator.clipboard objects for Alt+V tests
// ---------------------------------------------------------------------------

function makeClipboardWithImage({ type = "image/png", path = "C:\\uploads\\altv.png" } = {}) {
  const blob = new Blob(["fake-image-bytes"], { type });
  const clipboardItem = {
    types: [type],
    getType: vi.fn().mockResolvedValue(blob),
  };
  return {
    items: [clipboardItem],
    read: vi.fn().mockResolvedValue([clipboardItem]),
    readText: vi.fn().mockResolvedValue(""),
    _expectedPath: path,
  };
}

function makeClipboardTextOnly(text = "alt-v text") {
  return {
    items: [],
    read: vi.fn().mockResolvedValue([]),  // no image items
    readText: vi.fn().mockResolvedValue(text),
  };
}

function makeClipboardUnavailable(errorMessage = "Permission denied") {
  return {
    read: vi.fn().mockRejectedValue(new Error(errorMessage)),
    readText: vi.fn().mockRejectedValue(new Error(errorMessage)),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("TerminalPane paste handler", () => {
  beforeEach(async () => {
    capturedPasteHandler = null;
    capturedKeyHandler = null;
    await setupTerminalMock();
    patchListeners();
    // Reset module cache so each test gets a fresh TerminalPane import
    vi.resetModules();
    await setupTerminalMock();
  });

  afterEach(() => {
    unpatchListeners();
    vi.clearAllMocks();
  });

  // 1
  it("text_paste_calls_xterm_paste_once", async () => {
    const { unmount } = await renderPane();

    expect(capturedPasteHandler).not.toBeNull();

    const ev = makeTextPasteEvent("my pasted text");
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    expect(mockTermPaste).toHaveBeenCalledTimes(1);
    expect(mockTermPaste).toHaveBeenCalledWith("my pasted text");
    // wsRef.send should NOT be called directly for text — xterm's onData handles it
    expect(_wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 2
  it("image_paste_uploads_and_sends_path", async () => {
    const { wsSendSpy, unmount } = await renderPane();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ paths: ["C:\\uploads\\paste.png"] }),
    });

    const ev = makeImagePasteEvent({ type: "image/png" });
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/upload", expect.objectContaining({ method: "POST" }));
    });

    // Image path is now injected via xterm.paste() (bracketed-paste-aware), NOT ws.send
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalled();
    });

    const sent = mockTermPaste.mock.calls[0][0];
    // Path has no spaces — should not be quoted
    expect(sent).toBe("C:\\uploads\\paste.png");
    // ws.send must NOT be called directly — xterm's onData handler forwards it
    expect(wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 3
  it("image_paste_sends_quoted_path_when_spaces", async () => {
    const { wsSendSpy, unmount } = await renderPane();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ paths: ["C:\\my uploads\\paste.png"] }),
    });

    const ev = makeImagePasteEvent({ type: "image/png" });
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    // Image path is now injected via xterm.paste() (bracketed-paste-aware), NOT ws.send
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalled();
    });

    const sent = mockTermPaste.mock.calls[0][0];
    // Path contains a space → must be wrapped in double quotes
    expect(sent).toBe('"C:\\my uploads\\paste.png"');
    // ws.send must NOT be called directly
    expect(wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 4
  it("paste_event_calls_preventDefault_and_stopPropagation", async () => {
    const { unmount } = await renderPane();

    const ev = makeTextPasteEvent("test");
    await act(async () => {
      await capturedPasteHandler(ev);
    });

    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();

    unmount();
  });

  // 5
  it("ctrl_v_keydown_returns_false", async () => {
    const { unmount } = await renderPane();

    // Wait for the customKeyEventHandler to be registered
    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const ctrlVEvent = {
      type: "keydown",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    const result = capturedKeyHandler(ctrlVEvent);
    // Handler must return false for Ctrl+V so xterm doesn't send raw \x16
    expect(result).toBe(false);

    unmount();
  });

  // 6 — Alt+V with image on clipboard: uploads image and sends path via xterm.paste()
  it("alt_v_with_image_uploads_and_sends_path", async () => {
    const toastSpy = vi.fn();
    const { wsSendSpy, unmount } = await renderPane({ toastSpy });

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const clipboard = makeClipboardWithImage({ path: "C:\\uploads\\altv.png" });
    globalThis.navigator = {
      ...globalThis.navigator,
      clipboard,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ paths: ["C:\\uploads\\altv.png"] }),
    });

    const altVEvent = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    // The handler fires handleAltVPaste() asynchronously then returns false
    const result = capturedKeyHandler(altVEvent);
    expect(result).toBe(false);

    // Wait for the async upload to complete
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/upload",
        expect.objectContaining({ method: "POST" })
      );
    });

    // Image path is now injected via xterm.paste() (bracketed-paste-aware), NOT ws.send
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalled();
    });

    const sent = mockTermPaste.mock.calls[0][0];
    // Path has no spaces — unquoted
    expect(sent).toBe("C:\\uploads\\altv.png");
    // ws.send must NOT be called directly
    expect(wsSendSpy).not.toHaveBeenCalled();

    // Success toast should have been shown
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith("Image pasted", "success");
    });

    unmount();
  });

  // 7 — Alt+V with text-only clipboard: falls back to xterm.paste()
  it("alt_v_with_text_only_calls_xterm_paste", async () => {
    const { unmount } = await renderPane();

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const clipboard = makeClipboardTextOnly("hello from alt-v");
    globalThis.navigator = {
      ...globalThis.navigator,
      clipboard,
    };

    const altVEvent = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    const result = capturedKeyHandler(altVEvent);
    expect(result).toBe(false);

    // xterm.paste() should be called with the clipboard text
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalledWith("hello from alt-v");
    });

    // WS send should NOT be called directly — xterm's onData handler does it
    expect(_wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 9 — Canvas renderer regression guard
  // Asserts that CanvasAddon is instantiated on mount.
  // If a future change reverts to a different renderer and removes CanvasAddon,
  // this test turns RED in CI.
  it("canvas_renderer_loaded_on_mount", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");
    const { unmount } = await renderPane();

    // CanvasAddon constructor must have been called during terminal setup.
    // This is the primary regression signal: removing the CanvasAddon load
    // drops this call count to zero and CI fails.
    expect(CanvasAddon).toHaveBeenCalled();

    // Additionally verify that loadAddon was called the expected number of times
    // (FitAddon + WebLinksAddon + CanvasAddon + SearchAddon = 4 calls).
    // A regression that removes the canvas loadAddon call would reduce this count.
    const termInstance = Terminal.mock.results[Terminal.mock.results.length - 1].value;
    const loadAddonCallCount = termInstance.loadAddon.mock.calls.length;
    // At least 3 addons are always loaded (fit + web-links + canvas).
    // SearchAddon may also be loaded — we accept 3 or more.
    expect(loadAddonCallCount).toBeGreaterThanOrEqual(3);

    unmount();
  });

  // 8 — Alt+V when clipboard API is unavailable: shows error toast
  it("alt_v_clipboard_unavailable_shows_toast", async () => {
    const toastSpy = vi.fn();
    const { unmount } = await renderPane({ toastSpy });

    await waitFor(() => {
      expect(capturedKeyHandler).not.toBeNull();
    });

    const clipboard = makeClipboardUnavailable("NotAllowedError: Permission denied");
    globalThis.navigator = {
      ...globalThis.navigator,
      clipboard,
    };

    const altVEvent = {
      type: "keydown",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      key: "v",
    };

    const result = capturedKeyHandler(altVEvent);
    expect(result).toBe(false);

    // Error toast should be shown — the handler catches and surfaces the error
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining("Paste failed"),
        "error"
      );
    });

    // Neither upload nor WS send should have occurred
    expect(_wsSendSpy).not.toHaveBeenCalled();

    unmount();
  });

  // 10 — Canvas guard: CanvasAddon IS loaded when core.linkifier is present (normal case)
  it("canvas_loaded_when_linkifier_present", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    // Ensure the mock exposes a truthy linkifier (default in setupTerminalMock)
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
      attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => { capturedKeyHandler = fn; }),
      dispose: vi.fn(),
      options: { theme: {}, fontSize: 13 },
      _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
    }));

    const { unmount } = await renderPane();

    // CanvasAddon must be constructed (guard passed with linkifier present)
    expect(CanvasAddon).toHaveBeenCalled();

    // loadAddon called >= 3 times: FitAddon + WebLinksAddon + CanvasAddon (+ SearchAddon)
    const termInstance = Terminal.mock.results[Terminal.mock.results.length - 1].value;
    expect(termInstance.loadAddon.mock.calls.length).toBeGreaterThanOrEqual(3);

    unmount();
  });

  // 12 — Dispose-time safety: unmounting does NOT throw even when CanvasAddon.dispose() throws.
  //       Simulates the xterm teardown race: CanvasAddon._createRenderer() runs after the
  //       linkifier MutableDisposable is cleared → TypeError in the real xterm code. The
  //       component wraps both canvasAddon.dispose() and term.dispose() in try/catch so the
  //       error is swallowed instead of escaping to the ErrorBoundary.
  it("unmount_does_not_throw_when_canvasAddon_dispose_throws", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    // Make CanvasAddon.dispose() simulate the linkifier teardown race crash
    CanvasAddon.mockImplementation(() => ({
      activate: vi.fn(),
      dispose: vi.fn(() => { throw new Error("onShowLinkUnderline"); }),
    }));

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
      attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => { capturedKeyHandler = fn; }),
      dispose: vi.fn(),
      options: { theme: {}, fontSize: 13 },
      _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
    }));

    let threw = false;
    try {
      const { unmount } = await renderPane();
      // Unmount triggers the effect cleanup — CanvasAddon.dispose() throws, but it
      // must be caught before reaching React, so unmount() itself must not throw.
      await act(async () => {
        unmount();
      });
    } catch {
      threw = true;
    }

    // The throw from CanvasAddon.dispose() must have been swallowed — no propagation
    expect(threw).toBe(false);
  });

  // 11 — Canvas guard: CanvasAddon is NOT loaded when core.linkifier is absent (popout timing window)
  //       No throw must escape to the ErrorBoundary.
  it("canvas_skipped_when_linkifier_absent_no_throw", async () => {
    const { CanvasAddon } = await import("@xterm/addon-canvas");
    const { Terminal } = await import("@xterm/xterm");

    // Override the mock to simulate the degenerate state: element present, linkifier undefined
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
      attachCustomKeyEventHandler: vi.fn().mockImplementation((fn) => { capturedKeyHandler = fn; }),
      dispose: vi.fn(),
      options: { theme: {}, fontSize: 13 },
      element: document.createElement("div"), // element IS set
      _core: {}, // linkifier is undefined — the crash window
    }));

    let threw = false;
    try {
      const { unmount } = await renderPane();
      unmount();
    } catch {
      threw = true;
    }

    // Must not throw — guard skips CanvasAddon and falls back to DOM renderer
    expect(threw).toBe(false);

    // CanvasAddon constructor must NOT have been called (guard prevented it)
    expect(CanvasAddon).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// File-drop error reporting
//
// The bug: the drop handler checked `data.error` (singular), a key the server
// never returns -- rejections come back as `errors`, an array, because one file
// in a multi-file drop can be refused while its siblings succeed. A wholly
// rejected drop therefore fell through every branch and reported NOTHING: no
// path pasted, no toast, indistinguishable from a drop that never registered.
// ---------------------------------------------------------------------------

describe("TerminalPane file drop — server rejections", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    capturedPasteHandler = null;
    capturedKeyHandler = null;
    // Rebuild the Terminal mock so mockTermPaste is a fresh spy bound to the
    // implementation this test's render will use. Without this the variable
    // points at a previous test's spy and never records the call.
    await setupTerminalMock();
  });

  function dropFiles(container, files) {
    // The file-drop handlers live on the terminal-area div, which is the
    // deepest element the pane renders. Dispatch there so React's synthetic
    // onDrop fires with our dataTransfer.
    // The onDrop/onDragOver pair sits on the flex-1 wrapper around the xterm
    // mount point (TerminalPane.jsx ~1140). Dispatch on the xterm div inside
    // it so the event bubbles through the real handler.
    const target = container.querySelector(".flex-1.min-h-0 > div")
      || container.querySelector(".flex-1.min-h-0");
    if (!target) throw new Error("drop target not found in rendered pane");
    const ev = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "dataTransfer", {
      value: { files, types: ["Files"] },
    });
    target.dispatchEvent(ev);
  }

  it("drop_rejected_by_server_shows_the_server_reason", async () => {
    const toastSpy = vi.fn();
    const { container, unmount } = await renderPane({ toastSpy });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        paths: [],
        errors: ["Rejected 'big.png': exceeds 50MB limit"],
      }),
    });

    const file = new File([new Uint8Array(4)], "big.png", { type: "image/png" });
    await act(async () => {
      dropFiles(container, [file]);
    });

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining("exceeds 50MB limit"),
        "error",
      );
    });

    unmount();
  });

  it("drop_partially_rejected_still_pastes_the_files_that_landed", async () => {
    const toastSpy = vi.fn();
    const { container, unmount } = await renderPane({ toastSpy });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        paths: ["C:\\uploads\\ok.png"],
        errors: ["Rejected 'evil.exe': unsupported file type '.exe'"],
      }),
    });

    const good = new File([new Uint8Array(2)], "ok.png", { type: "image/png" });
    const bad = new File([new Uint8Array(2)], "evil.exe", { type: "application/octet-stream" });
    await act(async () => {
      dropFiles(container, [good, bad]);
    });

    // The error is reported...
    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.stringContaining("unsupported file type"),
        "error",
      );
    });
    // ...and the accepted file's path is still pasted. Reporting the failure
    // must not discard the sibling that succeeded.
    await waitFor(() => {
      expect(mockTermPaste).toHaveBeenCalledWith("C:\\uploads\\ok.png");
    });

    unmount();
  });
});
