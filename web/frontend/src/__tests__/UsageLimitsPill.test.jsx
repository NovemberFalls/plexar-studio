/**
 * Tests for the Claude subscription limits pill.
 *
 * The property that matters most: this surface must never imply a usage
 * figure it was not given. An unavailable reading and "0% used" render
 * identically as an empty bar, so the unavailable case must show its reason
 * instead of a bar.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import UsageLimitsPill from "../components/UsageLimitsPill.jsx";

const AVAILABLE = {
  available: true,
  reason: null,
  detail: null,
  limits: [
    {
      kind: "session",
      label: "Current session",
      group: "session",
      percent: 3,
      severity: "normal",
      resets_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
      is_active: true,
    },
    {
      kind: "weekly_all",
      label: "Current week (all models)",
      group: "weekly",
      percent: 62,
      severity: "normal",
      resets_at: new Date(Date.now() + 3 * 86400_000).toISOString(),
      is_active: false,
    },
  ],
  extra_usage: null,
};

function mockFetch(payload) {
  return vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(payload) })
  );
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UsageLimitsPill", () => {
  it("shows the tightest limit in the pill, not the first or the average", async () => {
    globalThis.fetch = mockFetch(AVAILABLE);
    render(<UsageLimitsPill open={false} onToggle={() => {}} onClose={() => {}} />);

    // 62 is the constraint that will actually stop work, not 3.
    await waitFor(() => expect(screen.getByText("62%")).toBeInTheDocument());
  });

  it("renders one bar per limit with its reset time when opened", async () => {
    globalThis.fetch = mockFetch(AVAILABLE);
    render(<UsageLimitsPill open onToggle={() => {}} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText("Current session")).toBeInTheDocument()
    );
    expect(screen.getByText("Current week (all models)")).toBeInTheDocument();

    const bars = screen.getAllByRole("progressbar");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute("aria-valuenow", "3");
    expect(bars[1]).toHaveAttribute("aria-valuenow", "62");
    expect(screen.getAllByText(/Resets/).length).toBe(2);
  });

  it("shows the reason instead of a bar when usage is unavailable", async () => {
    globalThis.fetch = mockFetch({
      available: false,
      reason: "expired",
      detail: "Claude login has expired. Run any `claude` command to refresh it.",
      limits: [],
    });
    render(<UsageLimitsPill open onToggle={() => {}} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/login has expired/i)).toBeInTheDocument()
    );
    // The critical assertion: no bar, because we have no figure to show.
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
  });

  it("shows no percentage in the pill when unavailable", async () => {
    globalThis.fetch = mockFetch({
      available: false,
      reason: "no_credentials",
      detail: "No Claude subscription login found on this machine.",
      limits: [],
    });
    render(<UsageLimitsPill open={false} onToggle={() => {}} onClose={() => {}} />);

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByText(/%$/)).not.toBeInTheDocument();
  });

  it("keeps the last known reading when a poll fails", async () => {
    let call = 0;
    globalThis.fetch = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(AVAILABLE) });
      }
      return Promise.reject(new Error("network down"));
    });

    const { rerender } = render(
      <UsageLimitsPill open={false} onToggle={() => {}} onClose={() => {}} />
    );
    await waitFor(() => expect(screen.getByText("62%")).toBeInTheDocument());

    // Opening forces a refresh, which fails — the reading must survive.
    rerender(<UsageLimitsPill open onToggle={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    // Now open, so "62%" appears in both the pill and the weekly bar.
    expect(screen.getAllByText("62%").length).toBeGreaterThan(0);
  });

  it("bypasses the server cache when the popover is opened", async () => {
    globalThis.fetch = mockFetch(AVAILABLE);
    const { rerender } = render(
      <UsageLimitsPill open={false} onToggle={() => {}} onClose={() => {}} />
    );
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(globalThis.fetch.mock.calls[0][0]).toBe("/api/anthropic/usage");

    rerender(<UsageLimitsPill open onToggle={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    expect(globalThis.fetch.mock.calls[1][0]).toBe("/api/anthropic/usage?refresh=true");
  });

  it("calls onToggle when the pill is clicked", async () => {
    globalThis.fetch = mockFetch(AVAILABLE);
    const onToggle = vi.fn();
    render(<UsageLimitsPill open={false} onToggle={onToggle} onClose={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /usage limits/i }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
