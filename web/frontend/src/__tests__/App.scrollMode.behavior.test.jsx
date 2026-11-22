import React, { forwardRef, useEffect, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

const lifecycle = vi.hoisted(() => ({ mounts: vi.fn(), unmounts: vi.fn() }));
vi.mock("../components/TerminalPane", () => ({
  default: forwardRef(function TerminalFixture({ session }, ref) {
    useImperativeHandle(ref, () => ({ focus: vi.fn(), fit: vi.fn() }), []);
    useEffect(() => {
      lifecycle.mounts(session.terminalId);
      return () => lifecycle.unmounts(session.terminalId);
    }, [session.terminalId]);
    return <div data-testid={`terminal-${session.terminalId}`}>Preserved terminal history</div>;
  }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: { accent: "#4ea1e8" } }) }));

import App from "../App.jsx";
import TerminalFixture from "../components/TerminalPane";

const sessions = [
  { name: "Alpha", workdir: "C:/Code/alpha/", model: "sonnet" },
  { name: "Beta", workdir: "C:/Code/beta", model: "sonnet" },
];
let scrollPosition;
let resizeCallbacks;
beforeEach(() => {
  lifecycle.mounts.mockClear(); lifecycle.unmounts.mockClear();
  localStorage.clear();
  localStorage.setItem("cockpit-onboarding-suppressed", "true");
  localStorage.setItem("cockpit-layout", "2");
  localStorage.setItem("cockpit-sessions", JSON.stringify(sessions));
  resizeCallbacks = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback) { resizeCallbacks.push(callback); }
    observe() {} disconnect() {} unobserve() {}
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; close() {} send() {} addEventListener() {} removeEventListener() {} });
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const body = url === "/api/terminals" ? { terminals: sessions.map((s, i) => ({ ...s, id: `term-${i}`, working_dir: s.workdir, alive: true })) }
      : { ok: true };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  scrollPosition = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.matches("main")) return { top: 0, bottom: 500, height: 500 };
    if (this.hasAttribute("data-folder-head")) return { top: 0, bottom: 24, height: 24 };
    const terminal = this.querySelector('[data-testid^="terminal-"]');
    const bottom = terminal?.dataset.testid === "terminal-term-0" ? 350 : 750;
    return { top: bottom - 300 - scrollPosition, bottom: bottom - scrollPosition, height: 300 };
  });
  HTMLElement.prototype.scrollIntoView = vi.fn(function () {
    scrollPosition = this.dataset.folderHead?.endsWith("beta") ? 400 : 0;
    fireEvent.scroll(this.closest("main"));
  });
  if (!CSS.escape) CSS.escape = (value) => value.replace(/\\/g, "\\\\");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

async function mountedApp() {
  const result = render(<App />);
  await screen.findByTestId("terminal-term-0");
  await screen.findByTestId("terminal-term-1");
  return result;
}

function assertPreserved(node, terminalId) {
  expect(screen.getByTestId(`terminal-${terminalId}`)).toBe(node);
  expect(lifecycle.unmounts).not.toHaveBeenCalled();
}

describe("real App scroll layout composition", () => {
  it("keeps terminal nodes and history mounted through both modes and folder selection", async () => {
    const { container } = await mountedApp();
    const first = screen.getByTestId("terminal-term-0");
    const second = screen.getByTestId("terminal-term-1");
    fireEvent.click(screen.getByRole("button", { name: "Scrolling layout, grouped by folder" }));
    const beta = screen.getByRole("button", { name: "beta" });
    fireEvent.click(beta);
    await waitFor(() => expect(beta).toHaveAttribute("aria-current", "location"));
    fireEvent.click(screen.getByRole("button", { name: "Grid layout" }));
    assertPreserved(first, "term-0");
    assertPreserved(second, "term-1");
    expect(first).toHaveTextContent("Preserved terminal history");
    expect(lifecycle.mounts).toHaveBeenCalledTimes(2);
    expect(lifecycle.unmounts).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-current="location"]')).toBeNull();
  });

  it("the preservation gate rejects a container that virtualizes off-screen panes", () => {
    // Deliberately broken, isolated container: this is the windowing pattern
    // prohibited in the production workspace. Exercise the same identity gate
    // used above without changing a live App source file to manufacture failure.
    const pane = <TerminalFixture session={{ terminalId: "bad" }} />;
    const { rerender } = render(<main>{pane}</main>);
    const before = screen.getByTestId("terminal-bad");
    rerender(<main>{null}</main>);
    rerender(<main>{pane}</main>);
    expect(() => assertPreserved(before, "bad")).toThrow();
    expect(lifecycle.unmounts).toHaveBeenCalledWith("bad");
  });

  it("updates the folder highlight on hand scrolling and after a resize", async () => {
    const { container } = await mountedApp();
    fireEvent.click(screen.getByRole("button", { name: "Scrolling layout, grouped by folder" }));
    const alpha = screen.getByRole("button", { name: "alpha" });
    const beta = screen.getByRole("button", { name: "beta" });
    await waitFor(() => expect(alpha).toHaveAttribute("aria-current", "location"));
    scrollPosition = 400;
    fireEvent.scroll(container.querySelector("main"));
    await waitFor(() => expect(beta).toHaveAttribute("aria-current", "location"));
    expect(alpha).not.toHaveAttribute("aria-current");
    scrollPosition = 0;
    act(() => resizeCallbacks.forEach((callback) => callback()));
    await waitFor(() => expect(alpha).toHaveAttribute("aria-current", "location"));
    expect(lifecycle.unmounts).not.toHaveBeenCalled();
  });
});
