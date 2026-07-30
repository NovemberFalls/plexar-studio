/**
 * Tests for Settings ▸ Updates.
 *
 * The rules under test are honesty rules:
 *   - the headline version comes from VITE_APP_VERSION (the build constant), not
 *     from /api/version, whose `app` can be null in the packaged sidecar
 *   - outside Tauri the check button is DISABLED and says why
 *   - a failed check renders role="alert" and NEVER claims "up to date"
 *   - an absent updater plugin degrades to a note, not a false verdict
 *   - "update available" names the version
 *   - no channel selector and no check-on-launch toggle exist (nothing persists
 *     them, so a control would be a lie)
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import UpdatesSettings, {
  platformLabel,
  runUpdateCheck,
} from "../components/settings/UpdatesSettings.jsx";

// The updater plugin is mocked at module level; `check` is re-pointed per test.
const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args) => check(...args),
}));

const VERSION_PAYLOAD = {
  app: null, // the packaged-sidecar case: server does not know its own version
  cli: "2.1.9",
  python: "3.11.9",
  platform: "win32",
};

function mockFetch(payload = VERSION_PAYLOAD, ok = true) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok, json: () => Promise.resolve(payload) })
  );
}

beforeEach(() => {
  check.mockReset();
  vi.stubEnv("VITE_APP_VERSION", "1.10.1");
  mockFetch();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__TAURI__;
  delete window.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

const enterTauri = () => {
  window.__TAURI_INTERNALS__ = {};
};

describe("UpdatesSettings — version facts", () => {
  it("shows the build-time version as the headline", async () => {
    render(<UpdatesSettings />);
    expect(await screen.findByTestId("app-version")).toHaveTextContent("v1.10.1");
  });

  it("does not fall back to the server's null app version", async () => {
    render(<UpdatesSettings />);
    await waitFor(() => expect(screen.getByTestId("fact-cli")).toHaveTextContent("2.1.9"));
    expect(screen.getByTestId("app-version")).not.toHaveTextContent("unknown");
    expect(screen.queryByTestId("fact-server-app")).not.toBeInTheDocument();
  });

  it("surfaces cli / python / platform from /api/version", async () => {
    render(<UpdatesSettings />);
    await waitFor(() => expect(screen.getByTestId("fact-cli")).toHaveTextContent("2.1.9"));
    expect(screen.getByTestId("fact-python")).toHaveTextContent("3.11.9");
    expect(screen.getByTestId("fact-platform")).toHaveTextContent("Windows (win32)");
  });

  it("reports a disagreeing server version separately", async () => {
    mockFetch({ ...VERSION_PAYLOAD, app: "1.9.0" });
    render(<UpdatesSettings />);
    expect(await screen.findByTestId("fact-server-app")).toHaveTextContent("v1.9.0");
    expect(screen.getByTestId("app-version")).toHaveTextContent("v1.10.1");
  });

  it("keeps the headline version when the server is unreachable", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("down")));
    render(<UpdatesSettings />);
    expect(await screen.findByTestId("version-unreachable")).toBeInTheDocument();
    expect(screen.getByTestId("app-version")).toHaveTextContent("v1.10.1");
  });

  it("platformLabel names known platforms and passes others through", () => {
    expect(platformLabel("win32")).toBe("Windows (win32)");
    expect(platformLabel("darwin")).toBe("macOS (darwin)");
    expect(platformLabel("linux")).toBe("Linux (linux)");
    expect(platformLabel("haiku")).toBe("haiku");
    expect(platformLabel(null)).toBeNull();
  });
});

describe("UpdatesSettings — outside Tauri", () => {
  it("disables the check button and states the reason", async () => {
    render(<UpdatesSettings />);
    const btn = await screen.findByTestId("check-updates");
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/desktop app/i);
    expect(screen.getByTestId("updates-browser-only")).toBeInTheDocument();
  });

  it("renders no verdict at all before a check runs", async () => {
    render(<UpdatesSettings />);
    expect(await screen.findByTestId("check-idle")).toBeInTheDocument();
    expect(screen.queryByTestId("update-uptodate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-available")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-failed")).not.toBeInTheDocument();
  });

  it("never calls the updater plugin", async () => {
    render(<UpdatesSettings />);
    fireEvent.click(await screen.findByTestId("check-updates"));
    expect(check).not.toHaveBeenCalled();
  });
});

describe("UpdatesSettings — check outcomes inside Tauri", () => {
  beforeEach(enterTauri);

  it("reports up to date when the plugin returns nothing", async () => {
    check.mockResolvedValue(null);
    render(<UpdatesSettings />);
    const btn = await screen.findByTestId("check-updates");
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(await screen.findByTestId("update-uptodate")).toBeInTheDocument();
    expect(screen.queryByTestId("update-failed")).not.toBeInTheDocument();
  });

  it("names the version when an update is available", async () => {
    check.mockResolvedValue({ version: "1.11.0" });
    render(<UpdatesSettings />);
    fireEvent.click(await screen.findByTestId("check-updates"));
    const box = await screen.findByTestId("update-available");
    expect(box).toBeInTheDocument();
    expect(screen.getByTestId("update-available-version")).toHaveTextContent("v1.11.0");
    expect(screen.queryByTestId("update-uptodate")).not.toBeInTheDocument();
  });

  it("a failed check alerts and does NOT claim up to date", async () => {
    check.mockRejectedValue(new Error("network unreachable"));
    render(<UpdatesSettings />);
    fireEvent.click(await screen.findByTestId("check-updates"));
    const alert = await screen.findByTestId("update-failed");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("network unreachable");
    expect(screen.queryByTestId("update-uptodate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-available")).not.toBeInTheDocument();
  });

  it("runUpdateCheck reports 'unavailable' — never 'up to date' — with no updater", async () => {
    // No Tauri runtime at all: the check could not run, which is a different
    // fact from "there is no newer release".
    delete window.__TAURI_INTERNALS__;
    const outside = await runUpdateCheck();
    expect(outside.kind).toBe("unavailable");
    expect(outside.kind).not.toBe("up-to-date");
    expect(outside.reason).toMatch(/desktop app/i);
    expect(check).not.toHaveBeenCalled();
  });

  it("runUpdateCheck distinguishes a thrown check from a missing one", async () => {
    check.mockRejectedValue(new Error("boom"));
    const failed = await runUpdateCheck();
    expect(failed).toEqual({ kind: "failed", error: "boom" });
  });
});

describe("UpdatesSettings — no controls that persist nothing", () => {
  it("renders no release-channel selector and no launch-check toggle", async () => {
    enterTauri();
    render(<UpdatesSettings />);
    await screen.findByTestId("check-updates");

    // The only button on the page is the check itself.
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("data-testid", "check-updates");

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/channel/i)).not.toBeInTheDocument();
  });

  it("states the real launch-check behaviour instead", async () => {
    render(<UpdatesSettings />);
    const note = await screen.findByTestId("updates-behaviour-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/GitHub Releases automatically every time it launches/i);
    expect(note).toHaveTextContent(/no release-channel setting/i);
  });
});
