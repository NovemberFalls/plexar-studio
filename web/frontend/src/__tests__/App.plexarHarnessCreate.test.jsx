/**
 * Plexar Harness is a PTY harness like codex: createSession must POST
 * /api/terminals with harness "plexar-harness", the TopBar harness-model pill's
 * value as `model` and the harness effort pill's value as `effort` -- never the
 * removed /api/harness/sessions route -- and the pane is a TerminalPane.
 */
import React, { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../components/TerminalPane", () => ({
  default: forwardRef(function TerminalFixture({ session }, ref) {
    useImperativeHandle(ref, () => ({ focus() {}, fit() {} }), []);
    return <div data-testid={`terminal-${session.terminalId}`}>{session.harness}</div>;
  }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: { accent: "#4ea1e8" } }) }));
import App from "../App.jsx";

const HARNESS_MODEL = '["plexar","qwen3.8-27b"]';
let posts;
let calls;
beforeEach(() => {
  posts = []; calls = [];
  localStorage.clear();
  localStorage.setItem("cockpit-onboarding-suppressed", "true");
  localStorage.setItem("cockpit-harness", JSON.stringify("plexar-harness"));
  localStorage.setItem("cockpit-model", JSON.stringify("claude-opus-5"));
  localStorage.setItem("cockpit-effort", JSON.stringify("xhigh"));
  localStorage.setItem("cockpit-harness-model", HARNESS_MODEL);
  localStorage.setItem("cockpit-harness-effort", "off");
  localStorage.setItem("cockpit-locations", JSON.stringify([{ path: "C:\\Code\\hproj", name: "hproj" }]));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; close() {} send() {} addEventListener() {} removeEventListener() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    calls.push(String(url));
    let body = { ok: true };
    if (url === "/api/terminals") {
      if (options?.method === "POST") {
        posts.push(JSON.parse(options.body));
        body = { id: "harness-pty" };
      } else body = { terminals: [] };
    } else if (url === "/api/bridge") body = { bridges: [] };
    else if (url === "/api/bridge/channel") body = { channels: [] };
    else if (url === "/api/harness/models") body = { source: "cache", models: [{ id: HARNESS_MODEL, label: "Plexar Qwen", efforts: ["", "off", "high"] }] };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("sends harness plexar-harness to /api/terminals with the harness pills' model and effort", async () => {
  render(<App />);
  const folder = await screen.findByText("hproj");
  fireEvent.doubleClick(folder);
  await screen.findByTestId("terminal-harness-pty");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ harness: "plexar-harness", model: HARNESS_MODEL, effort: "off", fast: false });
  expect(posts[0]).not.toHaveProperty("provider");
  expect(posts[0]).not.toHaveProperty("providerModel");
  expect(calls.some((u) => u.startsWith("/api/harness/sessions"))).toBe(false);
  expect(screen.getByTestId("terminal-harness-pty")).toHaveTextContent("plexar-harness");
});
