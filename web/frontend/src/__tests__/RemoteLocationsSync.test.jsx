/**
 * SPEC §2 (Plexar Mobile Stage 1c) — the desktop publishes its saved folders
 * to the remote gateway so Plexar Mobile's folder picker can list them:
 * `PUT /api/remote/locations` with `{"locations": [{"path", "name"}]}`,
 * debounced 1s off the `savedLocations` state, fire-and-forget (errors are
 * `console.debug`'d, never toasted).
 *
 * Follows the render-App-with-mocked-fetch pattern already used by
 * App.codexRestore.test.jsx / App.usageLimitsFocus.test.jsx, plus fake timers
 * (App.bridgeEndToast.test.jsx) to control the debounce deterministically.
 */
import React, { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, act } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../components/TerminalPane", () => ({
  default: forwardRef(function TerminalFixture({ session }, ref) {
    useImperativeHandle(ref, () => ({ focus() {}, fit() {} }), []);
    return <div data-testid={`terminal-${session.terminalId}`}>{session.name}</div>;
  }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: { accent: "#4ea1e8" } }) }));
import App from "../App.jsx";

let puts;

beforeEach(() => {
  puts = [];
  localStorage.clear();
  localStorage.setItem("cockpit-onboarding-suppressed", "true");
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; close() {} send() {} addEventListener() {} removeEventListener() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    let body = { ok: true };
    if (url === "/api/terminals") body = { terminals: [] };
    else if (url === "/api/remote/locations" && options?.method === "PUT") {
      const parsed = JSON.parse(options.body);
      puts.push(parsed);
      body = { count: parsed.locations.length };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("PUTs saved locations to /api/remote/locations once, 1s after restore", async () => {
  localStorage.setItem(
    "cockpit-locations",
    JSON.stringify([{ path: "C:/Code/project", bypassPermissions: false }]),
  );

  await act(async () => {
    render(<App />);
  });
  // Nothing sent yet — still inside the debounce window.
  expect(puts).toHaveLength(0);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(puts).toHaveLength(1);
  expect(puts[0]).toEqual({ locations: [{ path: "C:/Code/project", name: null }] });
});

it("carries a location's name through when one is set", async () => {
  localStorage.setItem(
    "cockpit-locations",
    JSON.stringify([{ path: "C:/Code/project", name: "Project", bypassPermissions: true }]),
  );

  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(puts).toEqual([{ locations: [{ path: "C:/Code/project", name: "Project" }] }]);
});

it("does not double-PUT for a redundant re-render within the debounce window", async () => {
  localStorage.setItem(
    "cockpit-locations",
    JSON.stringify([{ path: "C:/Code/project", bypassPermissions: false }]),
  );

  let rerender;
  await act(async () => {
    ({ rerender } = render(<App />));
  });

  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  // A re-render with unchanged state must not reset or duplicate the timer.
  await act(async () => {
    rerender(<App />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600);
  });

  expect(puts).toHaveLength(1);

  // ...and no further PUTs fire later, since nothing else changed.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(puts).toHaveLength(1);
});

it("never PUTs when there are no saved locations and none were ever published", async () => {
  // No "cockpit-locations" key at all — a completely fresh install.
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });

  expect(puts).toHaveLength(0);
});
