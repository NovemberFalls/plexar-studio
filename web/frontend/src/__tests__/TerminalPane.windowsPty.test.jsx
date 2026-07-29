/**
 * Tests for the windowsPty wiring added to TerminalPane.jsx's Terminal
 * construction: xterm.js needs `windowsPty: {backend, buildNumber}` at
 * construction time to disable its own reflow assumptions when reading a
 * ConPTY/winpty stream (root cause A of the duplicated-table-row bug — see
 * task brief). The option must be:
 *   - present with the right shape on win32 + conpty/winpty + numeric build
 *   - OMITTED entirely on linux/darwin, when build_number is null, and when
 *     the underlying /api/platform fetch fails
 *   - never block/hang terminal construction, even on a slow/failed fetch
 *
 * xterm is mocked (mirrors TerminalPane.resize.test.jsx); ../utils/platformInfo
 * is mocked directly so each test controls what getPlatformInfo() resolves to
 * without touching global fetch/timers.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import "@testing-library/jest-dom";

globalThis.ResizeObserver = class ResizeObserver {
  constructor() {}
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = () => {};

const TerminalCtor = vi.fn();
vi.mock("@xterm/xterm", () => ({ Terminal: TerminalCtor }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(), fit: vi.fn(),
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

// Controlled per-test via getPlatformInfoMock.mockResolvedValue/mockRejectedValue
const getPlatformInfoMock = vi.fn();
const PLATFORM_INFO_PENDING = Symbol("platform-info-pending");
vi.mock("../utils/platformInfo", () => ({
  getPlatformInfo: (...args) => getPlatformInfoMock(...args),
  // Always report "pending" for the sync fast-path so every test in this
  // file exercises the async-await branch (matching how a brand-new app
  // session's very first pane behaves, before any platform info is cached).
  getPlatformInfoSync: () => PLATFORM_INFO_PENDING,
  PLATFORM_INFO_PENDING,
  buildWindowsPtyOption: (info) => {
    if (!info || info.platform !== "win32") return undefined;
    if (info.pty_backend !== "conpty" && info.pty_backend !== "winpty") return undefined;
    if (typeof info.build_number !== "number") return undefined;
    return { backend: info.pty_backend, buildNumber: info.build_number };
  },
}));

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

function setupTerminalMock() {
  TerminalCtor.mockImplementation(() => ({
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
    cols: 120,
    rows: 30,
    _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
  }));
}

const BASE_SESSION = {
  id: "sess-1",
  name: "Alpha",
  terminalId: "term-1",
  model: "sonnet",
  status: "running",
  activityState: "idle",
};

async function renderPane() {
  setupTerminalMock();
  const { default: TerminalPane } = await import("../components/TerminalPane.jsx");
  await act(async () => {
    render(
      React.createElement(TerminalPane, {
        session: BASE_SESSION,
        onClose: vi.fn(),
        paneIndex: 0,
        onSwap: vi.fn(),
        onDragSourceChange: vi.fn(),
        toast: vi.fn(),
        terminalZoom: 13,
      }),
    );
  });
}

beforeEach(() => {
  vi.resetModules();
  getPlatformInfoMock.mockReset();
  TerminalCtor.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("TerminalPane — windowsPty construction option", () => {
  it("passes windowsPty when platform info says win32 + conpty + build number", async () => {
    getPlatformInfoMock.mockResolvedValue({ platform: "win32", pty_backend: "conpty", build_number: 19045 });
    await renderPane();

    expect(TerminalCtor).toHaveBeenCalledTimes(1);
    const opts = TerminalCtor.mock.calls[0][0];
    expect(opts.windowsPty).toEqual({ backend: "conpty", buildNumber: 19045 });
    // Every other option must be preserved unchanged.
    expect(opts.cursorBlink).toBe(true);
    expect(opts.scrollback).toBe(10000);
  });

  it("passes windowsPty for winpty too", async () => {
    getPlatformInfoMock.mockResolvedValue({ platform: "win32", pty_backend: "winpty", build_number: 17763 });
    await renderPane();

    const opts = TerminalCtor.mock.calls[0][0];
    expect(opts.windowsPty).toEqual({ backend: "winpty", buildNumber: 17763 });
  });

  it("omits windowsPty on linux", async () => {
    getPlatformInfoMock.mockResolvedValue({ platform: "linux", pty_backend: "unix", build_number: null });
    await renderPane();

    const opts = TerminalCtor.mock.calls[0][0];
    expect(opts.windowsPty).toBeUndefined();
  });

  it("omits windowsPty on darwin", async () => {
    getPlatformInfoMock.mockResolvedValue({ platform: "darwin", pty_backend: "unix", build_number: null });
    await renderPane();

    const opts = TerminalCtor.mock.calls[0][0];
    expect(opts.windowsPty).toBeUndefined();
  });

  it("omits windowsPty when build_number is null even on win32/conpty", async () => {
    getPlatformInfoMock.mockResolvedValue({ platform: "win32", pty_backend: "conpty", build_number: null });
    await renderPane();

    const opts = TerminalCtor.mock.calls[0][0];
    expect(opts.windowsPty).toBeUndefined();
  });

  it("still constructs the terminal (no crash, no hang) when the platform fetch fails", async () => {
    getPlatformInfoMock.mockResolvedValue(null); // getPlatformInfo() itself never rejects — it swallows errors
    await renderPane();

    expect(TerminalCtor).toHaveBeenCalledTimes(1);
    const opts = TerminalCtor.mock.calls[0][0];
    expect(opts.windowsPty).toBeUndefined();
  });
});
