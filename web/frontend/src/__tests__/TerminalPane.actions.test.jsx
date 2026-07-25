/**
 * Tests for the per-session CLI action controls added to TerminalPane's header
 * (web/frontend/src/components/TerminalPane.jsx) and the "More actions" popover
 * (web/frontend/src/components/PaneActionsMenu.jsx).
 *
 * Contract under test (see task brief):
 *   1. PATCH /api/terminals/{id}            {name, sync_claude} -> {ok, terminal, claude_synced}
 *   2. POST  /api/terminals/{id}/interrupt  (no body)           -> {ok: true}
 *   3. POST  /api/terminals/{id}/command    {command}           -> {ok:true} | 409 {ok:false, error}
 *   4. GET   /api/terminals/{id}/export     -> text/markdown attachment (anchor download)
 *
 * xterm.js is mocked entirely (as in TerminalPane.paste.test.jsx / popout.test.jsx)
 * so we can render the real TerminalPane header without touching canvas/WebGL.
 *
 * What is tested:
 *   Suite A — Stop (interrupt) button
 *     1. hidden when activityState is idle
 *     2. visible when activityState is busy
 *     3. clicking POSTs /interrupt
 *     4. a failed interrupt response surfaces a Toast
 *   Suite B — "More actions" kebab menu
 *     5. opens on click and lists all action rows
 *     6. Escape closes the popover
 *     7. backdrop (outside) click closes the popover
 *     8. Compact sends {"command": "/compact"}
 *     9. Compact is disabled while busy
 *     10. Clear requires a two-step confirm before sending /clear
 *     11. Export row is an anchor pointed at the export endpoint with download
 *     12. Model list rendered matches TopBar's shared MODEL_GROUPS constant
 *     13. selecting a model sends "/model <id>"
 *     14. Fast mode is disabled for non-Opus models
 *     15. Fast mode sends "/fast" for an Opus model
 *     16. a 409 from /command surfaces the "Session is busy" Toast
 *   Suite C — inline rename
 *     17. double-click opens an inline input pre-filled with the current name
 *     18. Enter commits via onRenameSession(name, syncClaude=true by default)
 *     19. unchecking "sync" then Enter commits with syncClaude=false
 *     20. Escape cancels without calling onRenameSession
 *     21. the kebab's "Rename…" row opens the same inline input
 *     22. committing an unchanged name is a no-op
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
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
// xterm + addon mocks (identical shape to TerminalPane.paste.test.jsx)
// ---------------------------------------------------------------------------

vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
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
// Terminal mock factory
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
    _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
  }));
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

async function renderPane(extraProps = {}) {
  await setupTerminalMock();
  const { default: TerminalPane } = await import("../components/TerminalPane.jsx");

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
        ...extraProps,
      }),
    );
  });
  return result;
}

beforeEach(async () => {
  vi.resetModules();
  await setupTerminalMock();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ ok: true }),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// Suite A — Stop (interrupt) button
// ===========================================================================

describe("TerminalPane — Stop/Interrupt button", () => {
  it("is hidden when the session is idle", async () => {
    const { unmount } = await renderPane({
      session: { ...BASE_SESSION, activityState: "idle" },
    });
    expect(screen.queryByRole("button", { name: "Interrupt session" })).not.toBeInTheDocument();
    unmount();
  });

  it("is visible when the session is busy", async () => {
    const { unmount } = await renderPane({
      session: { ...BASE_SESSION, activityState: "busy" },
    });
    expect(screen.getByRole("button", { name: "Interrupt session" })).toBeInTheDocument();
    unmount();
  });

  it("clicking POSTs /interrupt for the session's terminalId", async () => {
    const { unmount } = await renderPane({
      session: { ...BASE_SESSION, activityState: "busy" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Interrupt session" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals/term-1/interrupt",
        expect.objectContaining({ method: "POST" }),
      );
    });

    unmount();
  });

  it("surfaces a Toast when the interrupt request fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: vi.fn().mockResolvedValue({ error: "Failed to send interrupt" }),
    });
    const toastSpy = vi.fn();
    const { unmount } = await renderPane({
      session: { ...BASE_SESSION, activityState: "busy" },
      toast: toastSpy,
    });

    fireEvent.click(screen.getByRole("button", { name: "Interrupt session" }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith("Failed to send interrupt", "error");
    });

    unmount();
  });
});

// ===========================================================================
// Suite B — "More actions" kebab menu
// ===========================================================================

describe("TerminalPane — More actions kebab menu", () => {
  async function openMenu(extraProps = {}) {
    const result = await renderPane(extraProps);
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    return result;
  }

  it("opens on click and lists all action rows", async () => {
    const { unmount } = await openMenu();

    const menu = screen.getByRole("menu", { name: "Session actions" });
    expect(within(menu).getByText("Rename…")).toBeInTheDocument();
    expect(within(menu).getByText("Compact context")).toBeInTheDocument();
    expect(within(menu).getByText("Clear conversation…")).toBeInTheDocument();
    expect(within(menu).getByText("Export transcript")).toBeInTheDocument();
    expect(within(menu).getByText(/^Model:/)).toBeInTheDocument();
    expect(within(menu).getByText("Fast mode")).toBeInTheDocument();

    unmount();
  });

  it("closes on Escape", async () => {
    const { unmount } = await openMenu();
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Session actions" })).not.toBeInTheDocument();
    });
    unmount();
  });

  it("closes on outside (backdrop) click", async () => {
    const { unmount, container } = await openMenu();
    expect(screen.getByRole("menu", { name: "Session actions" })).toBeInTheDocument();

    const backdrop = container.querySelector(".fixed.inset-0.z-40");
    expect(backdrop).toBeTruthy();
    fireEvent.click(backdrop);

    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "Session actions" })).not.toBeInTheDocument();
    });
    unmount();
  });

  it("Compact sends {command: '/compact'}", async () => {
    const { unmount } = await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /Compact context/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals/term-1/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ command: "/compact" }),
        }),
      );
    });
    unmount();
  });

  it("Compact is disabled while the session is busy", async () => {
    const { unmount } = await openMenu({ session: { ...BASE_SESSION, activityState: "busy" } });

    const compactBtn = screen.getByRole("menuitem", { name: /Compact context/ });
    expect(compactBtn).toBeDisabled();

    fireEvent.click(compactBtn);
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/terminals/term-1/command",
      expect.anything(),
    );
    unmount();
  });

  it("Clear requires a two-step confirm before sending /clear", async () => {
    const { unmount } = await openMenu();

    // First click reveals the confirm row, does NOT send yet
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear conversation/ }));
    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/terminals/term-1/command",
      expect.anything(),
    );
    const confirmBtn = screen.getByText("Confirm");
    expect(confirmBtn).toBeInTheDocument();

    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals/term-1/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ command: "/clear" }),
        }),
      );
    });
    unmount();
  });

  it("Clear Cancel aborts without sending /clear", async () => {
    const { unmount } = await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /Clear conversation/ }));
    fireEvent.click(screen.getByText("Cancel"));

    expect(globalThis.fetch).not.toHaveBeenCalledWith(
      "/api/terminals/term-1/command",
      expect.anything(),
    );
    // Menu row reverts back to the plain "Clear conversation…" trigger
    expect(screen.getByRole("menuitem", { name: /Clear conversation/ })).toBeInTheDocument();
    unmount();
  });

  it("Export transcript is an anchor pointed at the export endpoint with download", async () => {
    const { unmount } = await openMenu();

    const link = screen.getByRole("menuitem", { name: /Export transcript/ });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "/api/terminals/term-1/export");
    expect(link).toHaveAttribute("download");
    unmount();
  });

  it("Model list matches TopBar's shared MODEL_GROUPS constant, excluding OpenRouter", async () => {
    const { MODEL_GROUPS } = await import("../components/TopBar.jsx");
    const { unmount } = await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /Model:/ }));

    // PaneActionsMenu filters out OpenRouter groups — in-session /model
    // switching cannot change provider (see PaneActionsMenu.jsx comment).
    const switchableModels = MODEL_GROUPS.filter((g) => g.provider !== "openrouter").flatMap(
      (g) => g.models
    );
    for (const m of switchableModels) {
      expect(screen.getByRole("menuitemradio", { name: m.label })).toBeInTheDocument();
    }

    const openRouterModels = MODEL_GROUPS.filter((g) => g.provider === "openrouter").flatMap(
      (g) => g.models
    );
    for (const m of openRouterModels) {
      expect(screen.queryByRole("menuitemradio", { name: m.label })).not.toBeInTheDocument();
    }
    unmount();
  });

  it("selecting a model sends '/model <id>'", async () => {
    const { unmount } = await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: /Model:/ }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Opus 4.8" }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals/term-1/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ command: "/model claude-opus-4-8" }),
        }),
      );
    });
    unmount();
  });

  it("Fast mode is disabled for a non-Opus model", async () => {
    const { unmount } = await openMenu({ session: { ...BASE_SESSION, model: "sonnet" } });

    const fastBtn = screen.getByRole("menuitem", { name: /Fast mode/ });
    expect(fastBtn).toBeDisabled();
    expect(fastBtn).toHaveAttribute("title", "Fast mode is only available for Opus models");
    unmount();
  });

  it("Fast mode sends '/fast' for an Opus model", async () => {
    const { unmount } = await openMenu({ session: { ...BASE_SESSION, model: "opus" } });

    fireEvent.click(screen.getByRole("menuitem", { name: /Fast mode/ }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/terminals/term-1/command",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ command: "/fast" }),
        }),
      );
    });
    unmount();
  });

  it("a 409 from /command surfaces the busy Toast", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: vi.fn().mockResolvedValue({ ok: false, error: "Session is busy" }),
    });
    const toastSpy = vi.fn();
    const { unmount } = await openMenu({ toast: toastSpy });

    fireEvent.click(screen.getByRole("menuitem", { name: /Compact context/ }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith("Session is busy — try again when it's idle.", "error");
    });
    unmount();
  });
});

// ===========================================================================
// Suite C — inline rename
// ===========================================================================

describe("TerminalPane — inline rename", () => {
  it("double-click opens an inline input pre-filled with the current name", async () => {
    const { unmount } = await renderPane();

    fireEvent.doubleClick(screen.getByText("Alpha"));

    const input = screen.getByRole("textbox", { name: "Session name" });
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("Alpha");
    // sync checkbox defaults to checked
    expect(screen.getByRole("checkbox", { name: "Also rename in Claude session" })).toBeChecked();

    unmount();
  });

  it("Enter commits via onRenameSession(name, syncClaude=true by default)", async () => {
    const onRenameSession = vi.fn().mockResolvedValue(undefined);
    const { unmount } = await renderPane({ onRenameSession });

    fireEvent.doubleClick(screen.getByText("Alpha"));
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "Bravo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onRenameSession).toHaveBeenCalledWith("Bravo", true);
    });
    unmount();
  });

  it("unchecking sync then Enter commits with syncClaude=false", async () => {
    const onRenameSession = vi.fn().mockResolvedValue(undefined);
    const { unmount } = await renderPane({ onRenameSession });

    fireEvent.doubleClick(screen.getByText("Alpha"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Also rename in Claude session" }));
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "Bravo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(onRenameSession).toHaveBeenCalledWith("Bravo", false);
    });
    unmount();
  });

  it("Escape cancels without calling onRenameSession", async () => {
    const onRenameSession = vi.fn();
    const { unmount } = await renderPane({ onRenameSession });

    fireEvent.doubleClick(screen.getByText("Alpha"));
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "Bravo" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Session name" })).not.toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(onRenameSession).not.toHaveBeenCalled();

    unmount();
  });

  it("the kebab's Rename… row opens the same inline input", async () => {
    const { unmount } = await renderPane();

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));

    expect(screen.getByRole("textbox", { name: "Session name" })).toBeInTheDocument();
    // menu closes when Rename… is selected
    expect(screen.queryByRole("menu", { name: "Session actions" })).not.toBeInTheDocument();

    unmount();
  });

  it("committing an unchanged name is a no-op", async () => {
    const onRenameSession = vi.fn();
    const { unmount } = await renderPane({ onRenameSession });

    fireEvent.doubleClick(screen.getByText("Alpha"));
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRenameSession).not.toHaveBeenCalled();
    unmount();
  });
});
