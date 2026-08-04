/**
 * Tests for Settings ▸ Keys & secrets.
 *
 * The rules under test are safety and honesty rules:
 *   - a configured key renders MASKED ONLY; no `sk-`-shaped string ever reaches
 *     the DOM, and there is no reveal control for the stored value
 *   - Save POSTs and the card re-renders from the server's echo
 *   - Remove DELETEs
 *   - `source: "env"` disables Remove and names the variable Plexar Studio cannot unset
 *   - the Anthropic "saved but not used yet" note is present, and is ABSENT on
 *     the OpenRouter card (that key genuinely is consumed)
 *   - a failed save surfaces the SERVER's message, not a generic one
 *   - a failed read renders an error, not a false "Not set"
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import KeysSettings from "../components/settings/KeysSettings.jsx";

const A = "/api/settings/anthropic";
const O = "/api/settings/openrouter";

const NOT_SET = { configured: false, source: null, masked: null };
const UI_SET = { configured: true, source: "ui", masked: "sk-a…9f2" };
const ENV_SET = { configured: true, source: "env", masked: "sk-e…4b1" };

/**
 * Route-aware fetch mock. `get` maps route → GET payload; `post`/`del` map
 * route → {status, body} for the write verbs.
 */
function mockFetch({ get = {}, post = {}, del = {}, getStatus = {} }) {
  return vi.fn(async (url, options) => {
    const route = String(url);
    const method = (options?.method || "GET").toUpperCase();
    const table = method === "POST" ? post : method === "DELETE" ? del : get;
    if (method === "GET") {
      const status = getStatus[route] ?? 200;
      return { ok: status === 200, status, json: async () => table[route] ?? NOT_SET };
    }
    const entry = table[route];
    if (!entry) return { ok: false, status: 500, json: async () => ({}) };
    return {
      ok: (entry.status ?? 200) === 200,
      status: entry.status ?? 200,
      json: async () => entry.body,
    };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KeysSettings — masked status line", () => {
  it("distinguishes not configured, saved-in-config.json, and environment sources", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: { [A]: UI_SET, [O]: ENV_SET } }));
    render(<KeysSettings />);

    await waitFor(() =>
      expect(screen.getByTestId("anthropic-masked")).toHaveTextContent(/config\.json/)
    );
    expect(screen.getByTestId("openrouter-masked")).toHaveTextContent(/Environment variable/);
  });

  it("still names the source when the server sends no masked value", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ get: { [A]: { configured: true, source: "ui", masked: null }, [O]: NOT_SET } })
    );
    render(<KeysSettings />);

    await waitFor(() =>
      expect(screen.getByTestId("anthropic-masked")).toHaveTextContent(/config\.json/)
    );
    expect(screen.getByTestId("openrouter-masked")).toHaveTextContent("Not configured");
  });
});

describe("KeysSettings", () => {
  it("renders masked values only — no key-shaped string reaches the DOM", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: { [A]: UI_SET, [O]: ENV_SET } }));
    render(<KeysSettings />);

    await waitFor(() => expect(screen.getByTestId("anthropic-masked")).toHaveTextContent("sk-a…9f2"));
    expect(screen.getByTestId("openrouter-masked")).toHaveTextContent("sk-e…4b1");
    expect(screen.getByTestId("anthropic-pill")).toHaveTextContent(/key set/i);

    // The only sk- strings present are the server's ellipsised masks and the
    // placeholder hints. Nothing that looks like a real key body.
    const text = document.body.textContent;
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{12,}/);

    // No input holds a value, and neither password field can be revealed.
    document.querySelectorAll("input").forEach((el) => {
      expect(el.value).toBe("");
      expect(el.type).toBe("password");
    });
    expect(screen.queryByLabelText(/show typed key/i)).not.toBeInTheDocument();
  });

  it("says where keys are stored and that this page bypasses Save changes", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: { [A]: NOT_SET, [O]: NOT_SET } }));
    render(<KeysSettings />);

    const note = screen.getByTestId("keys-storage-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/config\.json/);
    expect(note).toHaveTextContent(/settings\.json/);
    expect(note).toHaveTextContent(/do not use/i);
    await waitFor(() => expect(screen.getByTestId("anthropic-pill")).toHaveTextContent(/not set/i));
  });

  it("carries the not-yet-consumed note on Anthropic and NOT on OpenRouter", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: { [A]: UI_SET, [O]: UI_SET } }));
    render(<KeysSettings />);

    const note = await screen.findByTestId("anthropic-not-consumed");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/does not use it yet/i);
    expect(note).toHaveTextContent(/ANTHROPIC_API_KEY/);
    expect(screen.queryByTestId("openrouter-not-consumed")).not.toBeInTheDocument();
  });

  it("POSTs a pasted key and re-renders from the server's echo", async () => {
    const fetchMock = mockFetch({
      get: { [A]: NOT_SET, [O]: NOT_SET },
      post: {
        [A]: { status: 200, body: { ok: true, configured: true, source: "ui", masked: "sk-n…777" } },
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<KeysSettings />);

    await waitFor(() => expect(screen.getByTestId("anthropic-masked")).toHaveTextContent("Not configured"));

    const input = screen.getByTestId("anthropic-input");
    fireEvent.change(input, { target: { value: "sk-ant-secretvalue-1234567890" } });
    fireEvent.click(screen.getByTestId("anthropic-save"));

    await waitFor(() => expect(screen.getByTestId("anthropic-masked")).toHaveTextContent("sk-n…777"));

    const post = fetchMock.mock.calls.find(
      (c) => String(c[0]) === A && c[1]?.method === "POST"
    );
    expect(post).toBeTruthy();
    expect(JSON.parse(post[1].body)).toEqual({ key: "sk-ant-secretvalue-1234567890" });

    // The pasted key is cleared from the field, so it no longer exists anywhere
    // in the page's state or DOM.
    expect(input.value).toBe("");
    expect(document.body.textContent).not.toMatch(/secretvalue/);
    expect(screen.getByTestId("anthropic-ok")).toHaveTextContent(/applies now/i);
  });

  it("refuses an empty or whitespace key without calling the server", async () => {
    const fetchMock = mockFetch({ get: { [A]: NOT_SET, [O]: NOT_SET } });
    vi.stubGlobal("fetch", fetchMock);
    render(<KeysSettings />);

    await waitFor(() => expect(screen.getByTestId("anthropic-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("anthropic-input"), { target: { value: "has space" } });
    fireEvent.click(screen.getByTestId("anthropic-save"));

    expect(await screen.findByTestId("anthropic-notice")).toHaveTextContent(/whitespace/i);
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === "POST")).toBe(false);
  });

  it("surfaces the server's own message when a save is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: { [A]: NOT_SET, [O]: NOT_SET },
        post: { [O]: { status: 400, body: { ok: false, error: "OpenRouter rejected this key: 401" } } },
      })
    );
    render(<KeysSettings />);

    await waitFor(() => expect(screen.getByTestId("openrouter-input")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("openrouter-input"), { target: { value: "sk-or-v1-bad" } });
    fireEvent.click(screen.getByTestId("openrouter-save"));

    const notice = await screen.findByTestId("openrouter-notice");
    expect(notice).toHaveAttribute("role", "alert");
    expect(notice).toHaveTextContent("OpenRouter rejected this key: 401");
  });

  it("DELETEs on Remove and clears the card", async () => {
    const fetchMock = mockFetch({
      get: { [A]: UI_SET, [O]: NOT_SET },
      del: { [A]: { status: 200, body: { ok: true, configured: false, source: null, masked: null } } },
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<KeysSettings />);

    await waitFor(() => expect(screen.getByTestId("anthropic-masked")).toHaveTextContent("sk-a…9f2"));
    fireEvent.click(screen.getByTestId("anthropic-remove"));

    await waitFor(() =>
      expect(screen.getByTestId("anthropic-masked")).toHaveTextContent("Not configured")
    );
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]) === A && c[1]?.method === "DELETE")
    ).toBe(true);
    expect(screen.getByTestId("anthropic-pill")).toHaveTextContent(/not set/i);
  });

  it("disables Remove for an env-sourced key and names the variable", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: { [A]: ENV_SET, [O]: ENV_SET } }));
    render(<KeysSettings />);

    await waitFor(() => expect(screen.getByTestId("anthropic-remove")).toBeDisabled());
    expect(screen.getByTestId("anthropic-remove")).toHaveAttribute("title", expect.stringContaining("ANTHROPIC_API_KEY"));

    const envNote = screen.getByTestId("anthropic-env-note");
    expect(envNote).toHaveTextContent("ANTHROPIC_API_KEY");
    expect(envNote).toHaveTextContent(/cannot remove it here/i);

    expect(screen.getByTestId("openrouter-remove")).toBeDisabled();
    expect(screen.getByTestId("openrouter-env-note")).toHaveTextContent("OPENROUTER_API_KEY");
  });

  it("disables Remove when nothing is stored", async () => {
    vi.stubGlobal("fetch", mockFetch({ get: { [A]: NOT_SET, [O]: NOT_SET } }));
    render(<KeysSettings />);
    await waitFor(() => expect(screen.getByTestId("anthropic-remove")).toBeDisabled());
  });

  it("renders a read failure as an error, not a false 'Not set'", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ get: { [A]: NOT_SET, [O]: NOT_SET }, getStatus: { [A]: 503 } })
    );
    render(<KeysSettings />);

    const alert = await screen.findByTestId("anthropic-read-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(/503/);
    expect(alert).toHaveTextContent(/not.*the same as there being none/i);
    expect(screen.getByTestId("anthropic-masked")).toHaveTextContent("unknown");
    // The healthy card is unaffected.
    expect(screen.queryByTestId("openrouter-read-error")).not.toBeInTheDocument();
  });

  it("does not poll", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetch({ get: { [A]: UI_SET, [O]: UI_SET } });
      vi.stubGlobal("fetch", fetchMock);
      await act(async () => {
        render(<KeysSettings />);
        await vi.runOnlyPendingTimersAsync();
      });
      const calls = fetchMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchMock.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });
});
