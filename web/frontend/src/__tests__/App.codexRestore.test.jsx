import React, { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

vi.mock("../components/TerminalPane", () => ({
  default: forwardRef(function TerminalFixture({ session }, ref) {
    useImperativeHandle(ref, () => ({ focus() {}, fit() {} }), []);
    return <div data-testid={`terminal-${session.terminalId}`}>{session.name}:{session.status}</div>;
  }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: { accent: "#4ea1e8" } }) }));
import App from "../App.jsx";

const saved = { name: "Same name", workdir: "C:/Code/project", model: "gpt-6-astra",
  harness: "codex", terminalId: "old-pty", codex_session_id: "exact-chat",
  permissionMode: "default", effort: "high", bypassPermissions: false };
let terminals;
let posts;
let spawnError;
beforeEach(() => {
  terminals = []; posts = []; spawnError = null;
  localStorage.clear();
  localStorage.setItem("cockpit-onboarding-suppressed", "true");
  localStorage.setItem("cockpit-sessions", JSON.stringify([saved]));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal("WebSocket", class { static OPEN = 1; readyState = 1; close() {} send() {} addEventListener() {} removeEventListener() {} });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (url, options) => {
    let body = { ok: true };
    if (url === "/api/terminals") {
      if (options?.method === "POST") {
        posts.push(JSON.parse(options.body));
        body = spawnError ? { error: spawnError } : { id: "new-pty", codex_session_id: "exact-chat" };
      } else body = { terminals };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

it("resumes the exact saved Codex chat after backend restart and persists its new PTY ID", async () => {
  render(<App />);
  await screen.findByTestId("terminal-new-pty");
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ harness: "codex", resume_session_id: "exact-chat", model: "gpt-6-astra", effort: "high", permissionMode: "default" });
  expect(posts[0]).not.toHaveProperty("continue");
  await waitFor(() => expect(JSON.parse(localStorage.getItem("cockpit-sessions"))[0]).toMatchObject({ terminalId: "new-pty", codex_session_id: "exact-chat", harness: "codex" }));
});

it("reattaches by exact identity despite concurrent identical names and folders, then survives reload", async () => {
  terminals = [
    { ...saved, id: "wrong", working_dir: saved.workdir, alive: true, codex_session_id: "other-chat" },
    { ...saved, id: "old-pty", working_dir: saved.workdir, alive: true },
  ];
  const app = render(<App />);
  await screen.findByTestId("terminal-old-pty");
  expect(screen.queryByTestId("terminal-wrong")).toBeNull();
  app.unmount();
  render(<App />);
  await screen.findByTestId("terminal-old-pty");
  expect(posts).toEqual([]);
});

it("preserves an unknown Codex chat visibly without resuming an arbitrary latest chat", async () => {
  localStorage.setItem("cockpit-sessions", JSON.stringify([{ ...saved, codex_session_id: null }]));
  terminals = [{ ...saved, id: "different", working_dir: saved.workdir, alive: true }];
  render(<App />);
  await screen.findByText(/its Codex session ID was not recorded/);
  expect(posts).toEqual([]);
  expect(JSON.parse(localStorage.getItem("cockpit-sessions"))[0].name).toBe(saved.name);
});

it("shows stale exact-resume errors and retains the identity without creating a fresh chat", async () => {
  spawnError = "Codex session no longer exists";
  render(<App />);
  await screen.findByText(spawnError);
  await waitFor(() => expect(JSON.parse(localStorage.getItem("cockpit-sessions"))[0].codex_session_id).toBe("exact-chat"));
  expect(posts).toHaveLength(1);
  expect(posts[0].resume_session_id).toBe("exact-chat");
});

it("persists a Codex identity discovered by polling without a session-count change", async () => {
  localStorage.setItem("cockpit-sessions", JSON.stringify([{ ...saved, codex_session_id: null }]));
  terminals = [{ ...saved, id: "old-pty", codex_session_id: null, working_dir: saved.workdir, alive: true }];
  render(<App />);
  await screen.findByTestId("terminal-old-pty");
  terminals[0].codex_session_id = "newly-discovered-chat";
  await waitFor(() => expect(JSON.parse(localStorage.getItem("cockpit-sessions"))[0].codex_session_id).toBe("newly-discovered-chat"), { timeout: 4000 });
  expect(posts).toEqual([]);
});

it("does not choose between ambiguous legacy sessions with identical names and directories", async () => {
  localStorage.setItem("cockpit-sessions", JSON.stringify([{ name: saved.name, model: saved.model, workdir: saved.workdir }]));
  terminals = ["one", "two"].map((id) => ({ ...saved, id, working_dir: saved.workdir, alive: true }));
  render(<App />);
  await screen.findByText(/its Codex session ID was not recorded/);
  expect(screen.queryByTestId("terminal-one")).toBeNull();
  expect(screen.queryByTestId("terminal-two")).toBeNull();
  expect(posts).toEqual([]);
});
