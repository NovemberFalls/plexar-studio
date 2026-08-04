/**
 * Tests for Settings ▸ Claude CLI.
 *
 * These are honesty tests, not layout tests. The page reports which binary
 * Plexar Studio will spawn, and each assertion pins a claim it must not get wrong:
 *   - the resolved path AND the reason it was chosen, for both `env` and `search`
 *   - `not_found` is an alert with instructions, because in that state Plexar Studio
 *     cannot start a single session
 *   - `version: null` renders an em dash and never a fabricated version string
 *   - `name_matches: false` warns, naming the resolved file
 *   - there is NO editable path input — the override is an environment variable,
 *     and `settings.json`'s `claude_cli.binary_path` is read by nothing
 *   - Re-check refetches; a failed fetch is an error, not an empty state
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import ClaudeCliSettings from "../components/settings/ClaudeCliSettings.jsx";

/**
 * The source explanation is asserted through the rendered DOM rather than by
 * importing the helper: the page must export only components (eslint's
 * react-refresh rule), and the user-visible sentence is the thing under test
 * anyway.
 */

const CLI_ENV = {
  path: "C:\\Users\\x\\bin\\claude.exe",
  source: "env",
  version: "1.10.1",
  expected_name: "claude",
  name_matches: true,
  override_env: "CLAUDE_CLI_PATH",
  override_set: true,
};

const CLI_SEARCH = {
  path: "C:\\Program Files\\nodejs\\claude.cmd",
  source: "search",
  version: "1.9.0",
  expected_name: "claude",
  name_matches: true,
  override_env: "CLAUDE_CLI_PATH",
  override_set: false,
};

const CLI_NOT_FOUND = {
  path: null,
  source: "not_found",
  version: null,
  expected_name: "claude",
  name_matches: false,
  override_env: "CLAUDE_CLI_PATH",
  override_set: false,
};

const VERSION = { app: "1.10.1", cli: "1.10.1", python: "3.11.9", platform: "win32" };

/** Route every fetch by URL so the page's two parallel reads stay independent. */
function mockFetch({ cli, version = VERSION, cliStatus = 200, cliThrows = false }) {
  return vi.fn(async (url) => {
    if (String(url).includes("/api/cli")) {
      if (cliThrows) throw new Error("network down");
      return { ok: cliStatus === 200, status: cliStatus, json: async () => cli };
    }
    if (String(url).includes("/api/version")) {
      if (!version) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => version };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClaudeCliSettings — source explanation", () => {
  it("explains a set-but-unresolved override fell back to a PATH search", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: { ...CLI_SEARCH, override_set: true } }));
    render(<ClaudeCliSettings />);

    await waitFor(() =>
      expect(screen.getByTestId("cli-source")).toHaveTextContent(/did not resolve/i)
    );
    expect(screen.getByTestId("cli-source")).toHaveTextContent(/CLAUDE_CLI_PATH/);
    expect(screen.getByTestId("cli-source")).toHaveTextContent(/PATH/);
  });

  it("says how it was found even for an unrecognised source value", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: { ...CLI_SEARCH, source: "something-new" } }));
    render(<ClaudeCliSettings />);

    // An unknown source must not silently render as a PATH search — that would
    // be a claim the server never made.
    await waitFor(() =>
      expect(screen.getByTestId("cli-source")).toHaveTextContent(/did not report how/i)
    );
  });
});

describe("ClaudeCliSettings", () => {
  it("renders the path and an env explanation for source=env", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: CLI_ENV }));
    render(<ClaudeCliSettings />);

    await waitFor(() =>
      expect(screen.getByTestId("cli-path")).toHaveTextContent("C:\\Users\\x\\bin\\claude.exe")
    );
    expect(screen.getByTestId("cli-source")).toHaveTextContent(/CLAUDE_CLI_PATH/);
    expect(screen.getByTestId("cli-version")).toHaveTextContent("1.10.1");
    expect(screen.getByTestId("cli-status")).toHaveTextContent(/resolved/i);
    // The override note must state it IS set in this fixture.
    expect(screen.getByTestId("cli-override-note")).toHaveTextContent(/currently set/i);
    expect(screen.queryByTestId("cli-not-found")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cli-name-mismatch")).not.toBeInTheDocument();
  });

  it("renders the path and a PATH-search explanation for source=search", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: CLI_SEARCH }));
    render(<ClaudeCliSettings />);

    await waitFor(() =>
      expect(screen.getByTestId("cli-path")).toHaveTextContent("claude.cmd")
    );
    expect(screen.getByTestId("cli-source")).toHaveTextContent(/searching your PATH/i);
    expect(screen.getByTestId("cli-override-note")).toHaveTextContent(/currently not set/i);
    // An npm shim matches on the stem, so no warning.
    expect(screen.queryByTestId("cli-name-mismatch")).not.toBeInTheDocument();
  });

  it("shows supporting python and platform facts from /api/version", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: CLI_ENV }));
    render(<ClaudeCliSettings />);

    await waitFor(() => expect(screen.getByTestId("env-python")).toHaveTextContent("3.11.9"));
    expect(screen.getByTestId("env-platform")).toHaveTextContent("win32");
  });

  it("treats not_found as an alert with actionable guidance", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: CLI_NOT_FOUND }));
    render(<ClaudeCliSettings />);

    const alert = await screen.findByTestId("cli-not-found");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(/cannot start any session/i);
    // Both remedies must be named.
    expect(alert).toHaveTextContent(/claude-code/);
    expect(alert).toHaveTextContent(/CLAUDE_CLI_PATH/);
    expect(screen.getByTestId("cli-status")).toHaveTextContent(/not found/i);
    // And it must NOT read as a blank field.
    expect(screen.getByTestId("cli-path")).toHaveTextContent(/no executable resolved/i);
  });

  it("renders an em dash for a null version and invents nothing", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: { ...CLI_ENV, version: null } }));
    render(<ClaudeCliSettings />);

    await waitFor(() => expect(screen.getByTestId("cli-version")).toHaveTextContent("—"));
    expect(screen.getByTestId("cli-version-unknown")).toHaveTextContent(/not reported/i);
    // No version-shaped string anywhere in the CLI card — scoped to the card so
    // the (unrelated) Python/app versions in the Environment card cannot make
    // this pass or fail for the wrong reason.
    expect(screen.getByTestId("card-claude-cli").textContent).not.toMatch(/\d+\.\d+\.\d+/);
  });

  it("warns when name_matches is false, naming the resolved file", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        cli: {
          ...CLI_SEARCH,
          path: "C:\\tools\\claude-wrapper\\clod.exe",
          name_matches: false,
        },
      })
    );
    render(<ClaudeCliSettings />);

    const warn = await screen.findByTestId("cli-name-mismatch");
    expect(warn).toHaveTextContent("clod.exe");
    expect(warn).toHaveTextContent(/may not be the Claude CLI/i);
    expect(screen.getByTestId("cli-status")).toHaveTextContent(/check path/i);
  });

  it("offers NO editable path input — the override is an env var", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: CLI_ENV }));
    render(<ClaudeCliSettings />);

    await waitFor(() => expect(screen.getByTestId("cli-path")).toBeInTheDocument());
    // Nothing writable at all: no textbox, and specifically not the dead
    // claude_cli.binary_path field that nothing on the server reads.
    expect(screen.queryAllByRole("textbox")).toHaveLength(0);
    expect(document.querySelectorAll("input")).toHaveLength(0);
    expect(screen.queryByTestId("field-claude_cli.binary_path")).not.toBeInTheDocument();
    expect(screen.getByTestId("cli-override-note")).toHaveTextContent(/not editable here/i);
  });

  it("refetches on Re-check and reflects the new answer", async () => {
    let payload = CLI_NOT_FOUND;
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes("/api/cli")) {
        return { ok: true, status: 200, json: async () => payload };
      }
      return { ok: true, status: 200, json: async () => VERSION };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ClaudeCliSettings />);

    await screen.findByTestId("cli-not-found");
    const before = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/cli")).length;

    payload = CLI_ENV;
    fireEvent.click(screen.getByTestId("cli-recheck"));

    await waitFor(() =>
      expect(screen.getByTestId("cli-path")).toHaveTextContent("claude.exe")
    );
    expect(screen.queryByTestId("cli-not-found")).not.toBeInTheDocument();
    const after = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/api/cli")).length;
    expect(after).toBeGreaterThan(before);
  });

  it("renders an error, not an empty state, when /api/cli cannot be read", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: null, cliThrows: true }));
    render(<ClaudeCliSettings />);

    const alert = await screen.findByTestId("cli-fetch-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(/network down/);
    // Must NOT claim the CLI is missing — that is a different fact.
    expect(screen.queryByTestId("cli-not-found")).not.toBeInTheDocument();
    expect(screen.queryByTestId("cli-path")).not.toBeInTheDocument();
    expect(alert).toHaveTextContent(/not.*the same as no CLI being installed/i);
    expect(screen.getByTestId("cli-status")).toHaveTextContent(/unknown/i);
  });

  it("surfaces a non-200 from /api/cli as an error with the status code", async () => {
    vi.stubGlobal("fetch", mockFetch({ cli: null, cliStatus: 500 }));
    render(<ClaudeCliSettings />);

    expect(await screen.findByTestId("cli-fetch-error")).toHaveTextContent(/500/);
  });

  it("does not poll", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = mockFetch({ cli: CLI_ENV });
      vi.stubGlobal("fetch", fetchMock);
      await act(async () => {
        render(<ClaudeCliSettings />);
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
