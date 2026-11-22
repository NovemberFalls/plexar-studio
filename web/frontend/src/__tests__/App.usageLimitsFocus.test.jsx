import React, { forwardRef, useImperativeHandle, useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../components/TerminalPane", () => ({
  default: forwardRef(function TerminalFixture({ session }, ref) {
    const input = useRef(null);
    useImperativeHandle(ref, () => ({ focus() { input.current?.focus(); }, fit() {} }), []);
    return <textarea ref={input} aria-label={`Type in ${session.terminalId}`} />;
  }),
}));
vi.mock("../components/TopBar", async (importOriginal) => ({ ...await importOriginal(), default: ({ setHarness }) => <>
  <button onClick={() => setHarness("claude-code")}>Choose Claude default</button>
  <button onClick={() => setHarness("codex")}>Choose Codex default</button>
</> }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: { accent: "#4ea1e8" } }) }));
import App from "../App.jsx";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("cockpit-onboarding-suppressed", "true");
  localStorage.setItem("cockpit-layout", "2");
  const sessions = [
    { name: "Codex pane", terminalId: "codex-one", harness: "codex", codex_session_id: "exact-id", model: "gpt-6-astra", workdir: "C:/project" },
    { name: "Claude pane", terminalId: "claude-one", harness: "claude-code", model: "sonnet", workdir: "C:/project" },
  ];
  localStorage.setItem("cockpit-sessions", JSON.stringify(sessions));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; close() {} send() {} addEventListener() {} removeEventListener() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    let body = { ok: true };
    if (url === "/api/terminals") body = { terminals: sessions.map((session) => ({ ...session, id: session.terminalId, working_dir: session.workdir, alive: true })) };
    else if (url.startsWith("/api/anthropic/usage")) body = { available: true, limits: [{ kind: "week", label: "Claude week", percent: 72 }] };
    else if (url === "/api/terminals/codex-one/usage") body = { subscription_limits: { available: true, limits: [{ kind: "codex:primary", label: "Codex week", percent: 28 }] } };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("routes subscription limits from the typing pane through the real App and CommandBar", async () => {
  render(<App />);
  const codex = await screen.findByRole("textbox", { name: "Type in codex-one" });
  const claude = await screen.findByRole("textbox", { name: "Type in claude-one" });
  fireEvent.focus(codex);
  await screen.findByRole("button", { name: "Codex subscription usage limits" });
  fireEvent.click(screen.getByRole("button", { name: "Choose Claude default" }));
  expect(screen.getByRole("button", { name: "Codex subscription usage limits" })).toHaveTextContent("28%");
  fireEvent.focus(claude);
  await waitFor(() => expect(screen.getByRole("button", { name: "Claude subscription usage limits" })).toHaveTextContent("72%"));
  fireEvent.click(screen.getByRole("button", { name: "Choose Codex default" }));
  expect(screen.getByRole("button", { name: "Claude subscription usage limits" })).toHaveTextContent("72%");
  fireEvent.focus(codex);
  await waitFor(() => expect(screen.getByRole("button", { name: "Codex subscription usage limits" })).toHaveTextContent("28%"));
});
