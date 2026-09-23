/**
 * TasksView — HANDOFF-studio-framework-pilot.md §3.2 (B1-B9).
 *
 * The contracts under test:
 *   - resolveBucket: exact / nested / no-match / longest-prefix-wins, and the
 *     normalisation rule (backslash -> forward slash, trailing slash, case)
 *   - probes via `/api/framework/summary` only — NEVER a direct fetch at
 *     `:8430` (the "no fetch to :8430 from the frontend" trap)
 *   - `up:false` renders the exact fallback copy plus an Open-in-browser link
 *   - outside Tauri (this test environment) it always renders SOME fallback,
 *     never a blank pane
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import TasksView, { resolveBucket, normalizeBucketPath } from "../components/TasksView";

describe("normalizeBucketPath", () => {
  it("lowercases, flips separators, and strips a trailing slash", () => {
    expect(normalizeBucketPath("C:\\Code\\Personal\\Plexar-Studio\\")).toBe(
      "c:/code/personal/plexar-studio",
    );
  });
  it("is empty for non-strings", () => {
    expect(normalizeBucketPath(null)).toBe("");
    expect(normalizeBucketPath(undefined)).toBe("");
  });
});

describe("resolveBucket", () => {
  const buckets = {
    studio: { cwd: "C:\\Code\\Personal\\plexar-studio" },
    "studio-web": { cwd: "C:\\Code\\Personal\\plexar-studio\\web" },
    coord: { cwd: "C:\\Code\\Personal\\plexar-coord" },
  };

  it("matches an exact folder", () => {
    expect(resolveBucket("C:\\Code\\Personal\\plexar-coord", buckets)).toBe("coord");
  });

  it("matches a nested folder", () => {
    expect(resolveBucket("C:\\Code\\Personal\\plexar-studio\\web\\frontend", buckets)).toBe(
      "studio-web",
    );
  });

  it("picks the LONGEST cwd when more than one matches", () => {
    // "studio" and "studio-web" both prefix-match; studio-web's cwd is longer.
    expect(resolveBucket("C:\\Code\\Personal\\plexar-studio\\web\\src", buckets)).toBe(
      "studio-web",
    );
  });

  it("returns null on no match", () => {
    expect(resolveBucket("C:\\Code\\Personal\\some-other-repo", buckets)).toBeNull();
  });

  it("returns null with no folder or no buckets", () => {
    expect(resolveBucket(null, buckets)).toBeNull();
    expect(resolveBucket("C:\\Code\\Personal\\plexar-studio", null)).toBeNull();
  });

  it("does not treat a sibling with a shared prefix as nested", () => {
    // "plexar-studio2" must not match the "plexar-studio" bucket.
    const b = { studio: { cwd: "C:\\Code\\Personal\\plexar-studio" } };
    expect(resolveBucket("C:\\Code\\Personal\\plexar-studio2", b)).toBeNull();
  });
});

describe("TasksView", () => {
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("probes ONLY Studio's own /api/framework/summary route, never :8430 directly", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ up: false, base: "http://127.0.0.1:8430", reason: "unreachable" }),
    });
    render(<TasksView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    for (const call of fetchMock.mock.calls) {
      const target = String(call[0]);
      expect(target).toBe("/api/framework/summary");
      expect(target).not.toContain("8430");
    }
  });

  it("shows the exact down fallback copy and an Open-in-browser link when up:false", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ up: false, base: "http://127.0.0.1:8430", reason: "unreachable" }),
    });
    // Simulate running inside the Tauri webview so the notRunning-specific
    // branch (rather than the "opens in the desktop app" one) is reachable.
    // (No `@tauri-apps/api/webview` mock is installed, so the actual webview
    // creation attempt below the fallback will fail and be swallowed — this
    // test only cares about the fallback the probe itself drives.)
    window.__TAURI_INTERNALS__ = {};
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    try {
      render(<TasksView />);
      await waitFor(() =>
        expect(
          screen.getByText((t) => t.includes("Plexar-Framework isn't running.")),
        ).toBeInTheDocument(),
      );
      expect(screen.getByText((t) => t.includes("plexar up"))).toBeInTheDocument();
      const link = screen.getByRole("link", { name: /open in browser/i });
      expect(link).toHaveAttribute("href", "http://127.0.0.1:8430/app");
    } finally {
      delete window.__TAURI_INTERNALS__;
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it("never renders a blank pane outside Tauri, even while the framework is up", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ up: true, base: "http://127.0.0.1:8430", buckets: {} }),
    });
    render(<TasksView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByTestId("tasks-view")).toBeInTheDocument();
    // Outside Tauri there is no window.__TAURI_INTERNALS__, so the "opens in
    // the desktop app" branch renders regardless of probe outcome.
    expect(screen.getByText(/opens in the desktop app/i)).toBeInTheDocument();
  });

  it("calls onError only via the webview error path, never for a mere down probe", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ up: false, base: null, reason: "unreachable" }),
    });
    const onError = vi.fn();
    render(<TasksView onError={onError} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(onError).not.toHaveBeenCalled();
  });
});
