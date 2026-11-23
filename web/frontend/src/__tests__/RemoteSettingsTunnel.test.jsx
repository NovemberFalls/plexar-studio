/**
 * Tests for the Settings ▸ Remote "Tunnel connector" card.
 *
 * Covers: Start and Stop call the routes; the disabled reasons (no token /
 * not installed); the token is a password input, is PUT and then leaves the
 * component entirely; a token value is never rendered anywhere; the
 * foreign_running case renders a note rather than an error.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import RemoteSettings from "../components/settings/RemoteSettings.jsx";

const TOKEN = "eyJhIjoiFAKE-TOKEN-VALUE";

const TUNNEL_STOPPED = {
  installed: true,
  binary: "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
  token_set: true,
  enabled: true,
  autostart: true,
  state: "stopped",
  pid: null,
  started_at: null,
  restarts: 0,
  connections: 0,
  last_error: null,
  foreign_running: false,
  log_tail: [],
};

const TUNNEL_RUNNING = {
  ...TUNNEL_STOPPED,
  state: "running",
  pid: 4242,
  started_at: "2026-09-08T12:00:00Z",
  connections: 2,
  log_tail: ["INF Registered tunnel connection connIndex=0"],
};

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

function makeFetchMock({ tunnel = TUNNEL_STOPPED, tokenOk = true } = {}) {
  const calls = [];
  const fn = vi.fn((url, opts = {}) => {
    const method = opts.method || "GET";
    calls.push(`${method} ${url}`);
    if (url === "/api/remote/tunnel" && method === "GET") return jsonResponse(tunnel);
    if (url === "/api/remote/tunnel/start") return jsonResponse(TUNNEL_RUNNING);
    if (url === "/api/remote/tunnel/stop") return jsonResponse(TUNNEL_STOPPED);
    if (url === "/api/remote/tunnel/token") {
      return tokenOk
        ? jsonResponse(null, true, 204)
        : jsonResponse({ error: "token must not be empty" }, false, 400);
    }
    if (url === "/api/remote/status") {
      return jsonResponse({ enabled: true, hostname: "", protocol: 1, devices: [] });
    }
    if (url === "/api/remote/cloudflared") {
      return jsonResponse({ installed: true, path: "cloudflared", version: null, running: false });
    }
    if (url === "/api/settings" && method === "PUT") {
      return jsonResponse({ path: "settings.json", settings: {} });
    }
    return jsonResponse({});
  });
  fn.calls = calls;
  return fn;
}

function makeSettingsProps(draft = { remote: { enabled: true, hostname: "", tunnel: { enabled: true, autostart: true } } }) {
  return {
    get: (path, fallback) => {
      const parts = path.split(".");
      let cur = draft;
      for (const p of parts) {
        if (cur == null || typeof cur !== "object" || !(p in cur)) return fallback;
        cur = cur[p];
      }
      return cur === undefined ? fallback : cur;
    },
    setField: vi.fn(),
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RemoteSettings — tunnel connector", () => {
  it("Start posts to the start route", async () => {
    const fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock;
    render(<RemoteSettings {...makeSettingsProps()} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-start")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("tunnel-start"));

    await waitFor(() =>
      expect(fetchMock.calls).toContain("POST /api/remote/tunnel/start")
    );
    await waitFor(() => expect(screen.getByTestId("tunnel-stop")).toBeInTheDocument());
  });

  it("Stop posts to the stop route when running", async () => {
    const fetchMock = makeFetchMock({ tunnel: TUNNEL_RUNNING });
    globalThis.fetch = fetchMock;
    render(<RemoteSettings {...makeSettingsProps()} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-stop")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tunnel-stop"));
    await waitFor(() => expect(fetchMock.calls).toContain("POST /api/remote/tunnel/stop"));
  });

  it("toggling 'Run when Studio starts' saves immediately and re-polls status", async () => {
    const fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock;
    const props = makeSettingsProps({
      remote: { enabled: true, hostname: "", tunnel: { enabled: false, autostart: true } },
    });
    render(<RemoteSettings {...props} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-autostart-toggle")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tunnel-autostart-toggle"));

    await waitFor(() => expect(fetchMock.calls).toContain("PUT /api/settings"));
    // The toggle saves itself, not through the page's draft-only setField —
    // but the draft still gets updated so the page's own Save stays in sync.
    expect(props.setField).toHaveBeenCalledWith("remote.tunnel.autostart", true);
    expect(props.setField).toHaveBeenCalledWith("remote.tunnel.enabled", true);
    // Re-polls the tunnel status right away rather than waiting for the next tick.
    const getCallsAfterToggle = fetchMock.calls.filter((c) => c === "GET /api/remote/tunnel").length;
    expect(getCallsAfterToggle).toBeGreaterThanOrEqual(2);
  });

  it("disables Start with a reason when no token is set", async () => {
    globalThis.fetch = makeFetchMock({ tunnel: { ...TUNNEL_STOPPED, token_set: false } });
    render(<RemoteSettings {...makeSettingsProps()} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-start")).toBeDisabled());
    expect(screen.getByTestId("tunnel-disabled-reason")).toHaveTextContent(
      /Paste a connector token first/i
    );
  });

  it("disables Start with the install line when cloudflared is missing", async () => {
    globalThis.fetch = makeFetchMock({
      tunnel: { ...TUNNEL_STOPPED, installed: false, binary: null },
    });
    render(<RemoteSettings {...makeSettingsProps()} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-start")).toBeDisabled());
    expect(screen.getByTestId("tunnel-disabled-reason")).toHaveTextContent(/not installed/i);
    expect(screen.getByTestId("tunnel-not-installed")).toHaveTextContent(
      "winget install --id Cloudflare.cloudflared"
    );
  });

  it("shows 'Token set' with Replace/Remove and never renders a token value", async () => {
    globalThis.fetch = makeFetchMock({ tunnel: TUNNEL_RUNNING });
    const { container } = render(<RemoteSettings {...makeSettingsProps()} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-token-set")).toBeInTheDocument());
    expect(screen.getByTestId("tunnel-token-replace")).toBeInTheDocument();
    expect(screen.getByTestId("tunnel-token-remove")).toBeInTheDocument();
    expect(container.querySelector('input[type="text"][value*="eyJ"]')).toBeNull();
    expect(container.textContent).not.toContain(TOKEN);
  });

  it("the token field is a password input, is PUT, and leaves state after submit", async () => {
    const fetchMock = makeFetchMock({ tunnel: { ...TUNNEL_STOPPED, token_set: false } });
    globalThis.fetch = fetchMock;
    const { container } = render(<RemoteSettings {...makeSettingsProps()} />);

    const input = await screen.findByTestId("tunnel-token-input");
    expect(input).toHaveAttribute("type", "password");

    fireEvent.change(input, { target: { value: TOKEN } });
    fireEvent.click(screen.getByTestId("tunnel-token-save"));

    await waitFor(() => expect(fetchMock.calls).toContain("PUT /api/remote/tunnel/token"));
    const body = JSON.parse(
      fetchMock.mock.calls.find(([u, o]) => u === "/api/remote/tunnel/token" && o?.method === "PUT")[1].body
    );
    expect(body).toEqual({ token: TOKEN });

    await waitFor(() => expect(screen.getByTestId("tunnel-token-input")).toHaveValue(""));
    expect(container.textContent).not.toContain(TOKEN);
  });

  it("Remove deletes the token", async () => {
    const fetchMock = makeFetchMock({ tunnel: TUNNEL_STOPPED });
    globalThis.fetch = fetchMock;
    render(<RemoteSettings {...makeSettingsProps()} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-token-remove")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("tunnel-token-remove"));
    await waitFor(() => expect(fetchMock.calls).toContain("DELETE /api/remote/tunnel/token"));
  });

  it("renders foreign_running as a note, not an error", async () => {
    globalThis.fetch = makeFetchMock({
      tunnel: { ...TUNNEL_STOPPED, foreign_running: true },
    });
    render(<RemoteSettings {...makeSettingsProps()} />);

    const note = await screen.findByTestId("tunnel-foreign-note");
    expect(note).toHaveAttribute("role", "note");
    expect(screen.queryByTestId("tunnel-error")).toBeNull();
    expect(note).toHaveTextContent("stop it first or leave this off");
  });

  it("does not tell a healthy connector to stop because another cloudflared exists", async () => {
    globalThis.fetch = makeFetchMock({
      tunnel: { ...TUNNEL_RUNNING, foreign_running: true },
    });
    render(<RemoteSettings {...makeSettingsProps()} />);

    const note = await screen.findByTestId("tunnel-foreign-note");
    expect(note).toHaveTextContent("That is fine if it serves a different tunnel");
    expect(note).not.toHaveTextContent("Stop it first");
  });

  it("shows the log tail only when expanded", async () => {
    globalThis.fetch = makeFetchMock({ tunnel: TUNNEL_RUNNING });
    render(<RemoteSettings {...makeSettingsProps()} />);

    await waitFor(() => expect(screen.getByTestId("tunnel-log-toggle")).toBeInTheDocument());
    expect(screen.queryByTestId("tunnel-log")).toBeNull();
    fireEvent.click(screen.getByTestId("tunnel-log-toggle"));
    expect(screen.getByTestId("tunnel-log")).toHaveTextContent("Registered tunnel connection");
  });
});
