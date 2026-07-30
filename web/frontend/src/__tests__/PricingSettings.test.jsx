/**
 * Tests for Settings ▸ Pricing table.
 *
 * The rules under test are honesty rules, not layout rules:
 *   - a `null` rate renders as "unknown" and NEVER as $0 — and is visibly
 *     different from a genuine published 0 ("free")
 *   - a `default`-sourced row is flagged as a fallback
 *   - the snapshot semantics (history is never re-priced) are stated on the page
 *   - a failed refresh keeps the previous table; a failed initial fetch renders
 *     an alert and NO table at all
 *   - nothing polls
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import PricingSettings, {
  rateCell,
  relativeStamp,
  sortModels,
} from "../components/settings/PricingSettings.jsx";
import SettingsView from "../components/settings/SettingsView.jsx";

const SETTINGS_PATH = "C:\\Users\\x\\settings.json";

// Real timers throughout: fake timers deadlock @testing-library's waitFor here.
// Determinism instead comes from deriving every stamp from the current clock, so
// the relative-time assertions ("1 hour ago") hold whenever the suite runs.
const NOW = new Date().toISOString();
const HOUR_MS = 3600_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ahead = (ms) => new Date(Date.now() + ms).toISOString();

const PAYLOAD = {
  models: [
    {
      model: "claude-opus-5",
      provider: "anthropic",
      input_per_mtok: 15,
      output_per_mtok: 75,
      cache_read_per_mtok: 1.5,
      cache_write_per_mtok: 18.75,
      effective_from: "2026-06-01T00:00:00Z",
      source: "openrouter",
    },
    {
      // The null/zero pair that the whole page exists for: unknown cache rates
      // beside a genuinely free local model.
      model: "qwen3-coder-30b-awq",
      provider: "local",
      input_per_mtok: 0,
      output_per_mtok: 0,
      cache_read_per_mtok: null,
      cache_write_per_mtok: null,
      effective_from: "2026-07-01T00:00:00Z",
      source: "pricing_models.json",
    },
    {
      // Sorts FIRST (provider "aaa-vendor"), and is the fallback-priced row.
      model: "mystery-model",
      provider: "aaa-vendor",
      input_per_mtok: 1,
      output_per_mtok: 2,
      cache_read_per_mtok: 0.1,
      cache_write_per_mtok: 1.25,
      effective_from: "2026-05-15T00:00:00Z",
      source: "default",
    },
  ],
  last_refresh: { openrouter: ago(HOUR_MS), json: ago(24 * HOUR_MS) },
  next_refresh: ahead(11 * HOUR_MS),
  refresh_hours: 12,
};

function jsonRes(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

let intervalSpy;

beforeEach(() => {
  intervalSpy = vi.spyOn(globalThis, "setInterval");
  globalThis.fetch = vi.fn((url) => {
    if (url === "/api/pricing") return jsonRes(PAYLOAD);
    if (url === "/api/pricing/refresh") return jsonRes(PAYLOAD);
    return jsonRes({}, false, 404);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PricingSettings — the table", () => {
  it("renders one row per model with every price column, sorted by provider then model", async () => {
    render(<PricingSettings />);
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());

    const rows = screen.getAllByTestId(/^pricing-row-/);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "pricing-row-mystery-model",
      "pricing-row-claude-opus-5",
      "pricing-row-qwen3-coder-30b-awq",
    ]);

    // All four rate columns present for a real-money row.
    expect(screen.getByTestId("pricing-claude-opus-5-input_per_mtok")).toHaveTextContent("$15.00");
    expect(screen.getByTestId("pricing-claude-opus-5-output_per_mtok")).toHaveTextContent("$75.00");
    expect(screen.getByTestId("pricing-claude-opus-5-cache_read_per_mtok")).toHaveTextContent("$1.50");
    expect(screen.getByTestId("pricing-claude-opus-5-cache_write_per_mtok")).toHaveTextContent("$18.75");

    // Provider badge + effective date + source badge.
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("Jun 1, 2026")).toBeInTheDocument();
    expect(screen.getByTestId("pricing-source-claude-opus-5")).toHaveTextContent("openrouter");
    expect(screen.getByTestId("pricing-source-qwen3-coder-30b-awq")).toHaveTextContent("bundled");
  });

  it("renders null as unknown, never as $0, and distinguishes it from a genuine 0", async () => {
    render(<PricingSettings />);
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());

    const nullCell = screen.getByTestId("pricing-qwen3-coder-30b-awq-cache_read_per_mtok");
    const zeroCell = screen.getByTestId("pricing-qwen3-coder-30b-awq-input_per_mtok");

    expect(nullCell).toHaveTextContent("unknown");
    expect(nullCell.textContent).not.toMatch(/\$0/);
    expect(nullCell.textContent).not.toMatch(/free/);

    expect(zeroCell).toHaveTextContent("free");
    expect(zeroCell.textContent).not.toMatch(/unknown/);

    // Different text AND different colour token.
    expect(nullCell.textContent).not.toBe(zeroCell.textContent);
    expect(nullCell.style.color).not.toBe(zeroCell.style.color);

    // And the page explains the difference in prose.
    expect(screen.getByTestId("pricing-unknown-note")).toHaveTextContent(/not the same as/i);
  });

  it("flags a default-sourced row as a fallback and lists it in a --cc-waiting callout", async () => {
    render(<PricingSettings />);
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());

    expect(screen.getByTestId("pricing-row-mystery-model")).toHaveAttribute("data-fallback", "true");
    expect(screen.getByTestId("pricing-row-claude-opus-5")).toHaveAttribute("data-fallback", "false");
    expect(screen.getByTestId("pricing-source-mystery-model")).toHaveTextContent("fallback");

    const callout = screen.getByTestId("pricing-fallback-note");
    expect(callout).toHaveAttribute("role", "note");
    expect(callout).toHaveTextContent("mystery-model");
    expect(callout).toHaveTextContent(/approximate/);
    expect(callout.style.color).toBe("var(--cc-waiting)");
  });

  it("teaches the snapshot semantics", async () => {
    render(<PricingSettings />);
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());

    const note = screen.getByTestId("pricing-snapshot-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/date it took effect/i);
    expect(note).toHaveTextContent(/past reports keep the prices/i);
    expect(note).toHaveTextContent(/does not rewrite history/i);
  });

  it("shows the refresh cadence, last refresh and next refresh as relative times", async () => {
    render(<PricingSettings />);
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());

    expect(screen.getByTestId("pricing-last-openrouter")).toHaveTextContent("1 hour ago");
    expect(screen.getByTestId("pricing-last-json")).toHaveTextContent("1 day ago");
    expect(screen.getByTestId("pricing-next-refresh")).toHaveTextContent("in 11 hours");
    expect(screen.getByTestId("pricing-auto-note")).toHaveTextContent("every 12 hours");
  });

  it("renders no editable price inputs — the page is read-only apart from Refresh", async () => {
    render(<PricingSettings />);
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());

    expect(document.querySelectorAll("input")).toHaveLength(0);
    const buttons = Array.from(document.querySelectorAll("button"));
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute("aria-label", "Refresh pricing now");
  });

  it("does not poll", async () => {
    render(<PricingSettings />);
    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());

    // waitFor installs its own polling interval, so only intervals that are not
    // testing-library's own count as the component polling.
    const ours = intervalSpy.mock.calls.filter(
      ([fn]) => typeof fn !== "function" || fn.name !== "checkRealTimersCallback"
    );
    expect(ours).toHaveLength(0);
    expect(globalThis.fetch.mock.calls.filter((c) => c[0] === "/api/pricing")).toHaveLength(1);
  });
});

describe("PricingSettings — Refresh", () => {
  it("POSTs to /api/pricing/refresh and re-renders with the returned table", async () => {
    const REFRESHED = {
      ...PAYLOAD,
      models: [{ ...PAYLOAD.models[0], input_per_mtok: 20 }],
      last_refresh: { openrouter: NOW, json: PAYLOAD.last_refresh.json },
    };
    globalThis.fetch = vi.fn((url, opts) => {
      if (url === "/api/pricing") return jsonRes(PAYLOAD);
      if (url === "/api/pricing/refresh" && opts?.method === "POST") return jsonRes(REFRESHED);
      return jsonRes({}, false, 404);
    });

    render(<PricingSettings />);
    await waitFor(() => expect(screen.getAllByTestId(/^pricing-row-/)).toHaveLength(3));

    fireEvent.click(screen.getByLabelText("Refresh pricing now"));
    await waitFor(() => expect(screen.getAllByTestId(/^pricing-row-/)).toHaveLength(1));

    expect(globalThis.fetch).toHaveBeenCalledWith("/api/pricing/refresh", { method: "POST" });
    expect(screen.getByTestId("pricing-claude-opus-5-input_per_mtok")).toHaveTextContent("$20.00");
    expect(screen.getByTestId("pricing-last-openrouter")).toHaveTextContent("less than a minute ago");
    // Nothing broke: the fallback callout is gone because no fallback rows remain.
    expect(screen.queryByTestId("pricing-fallback-note")).not.toBeInTheDocument();
  });

  it("surfaces a failed refresh as an alert and KEEPS the previous table", async () => {
    globalThis.fetch = vi.fn((url, opts) => {
      if (url === "/api/pricing") return jsonRes(PAYLOAD);
      if (url === "/api/pricing/refresh" && opts?.method === "POST") {
        return jsonRes({ error: "OpenRouter unreachable" }, false, 502);
      }
      return jsonRes({}, false, 404);
    });

    render(<PricingSettings />);
    await waitFor(() => expect(screen.getAllByTestId(/^pricing-row-/)).toHaveLength(3));

    fireEvent.click(screen.getByLabelText("Refresh pricing now"));
    await waitFor(() =>
      expect(screen.getByTestId("pricing-refresh-error")).toHaveTextContent("OpenRouter unreachable")
    );
    expect(screen.getByTestId("pricing-refresh-error")).toHaveAttribute("role", "alert");
    // The table the user was already reading is untouched.
    expect(screen.getAllByTestId(/^pricing-row-/)).toHaveLength(3);
    expect(screen.getByTestId("pricing-claude-opus-5-input_per_mtok")).toHaveTextContent("$15.00");
  });
});

describe("PricingSettings — honest empty and offline states", () => {
  it("a fetch failure renders an alert and NO table", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("network down")));
    render(<PricingSettings />);

    await waitFor(() => expect(screen.getByTestId("pricing-fetch-error")).toBeInTheDocument());
    expect(screen.getByTestId("pricing-fetch-error")).toHaveAttribute("role", "alert");
    expect(screen.getByTestId("pricing-fetch-error")).toHaveTextContent("network down");
    expect(screen.queryByTestId("pricing-table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pricing-empty")).not.toBeInTheDocument();
  });

  it("a non-OK response also renders an alert and no table", async () => {
    globalThis.fetch = vi.fn(() => jsonRes({}, false, 500));
    render(<PricingSettings />);

    await waitFor(() => expect(screen.getByTestId("pricing-fetch-error")).toBeInTheDocument());
    expect(screen.queryByTestId("pricing-table")).not.toBeInTheDocument();
  });

  it("zero models says prices have not been fetched yet and offers Refresh", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/pricing") {
        return jsonRes({ models: [], last_refresh: {}, next_refresh: null, refresh_hours: 12 });
      }
      return jsonRes({}, false, 404);
    });
    render(<PricingSettings />);

    await waitFor(() => expect(screen.getByTestId("pricing-empty")).toBeInTheDocument());
    expect(screen.getByTestId("pricing-empty")).toHaveTextContent(/have not been fetched yet/i);
    expect(screen.getByLabelText("Refresh pricing now")).toBeEnabled();
    expect(screen.queryByTestId("pricing-table")).not.toBeInTheDocument();
    // Never-fetched stamps say "never", not a fabricated date.
    expect(screen.getByTestId("pricing-last-openrouter")).toHaveTextContent("never");
    expect(screen.getByTestId("pricing-next-refresh")).toHaveTextContent("not scheduled");
  });
});

describe("PricingSettings — pure helpers", () => {
  it("rateCell separates unknown, free and priced", () => {
    expect(rateCell(null).text).toBe("unknown");
    expect(rateCell(undefined).text).toBe("unknown");
    expect(rateCell(Number.NaN).text).toBe("unknown");
    expect(rateCell(0).text).toBe("free");
    expect(rateCell(3).text).toBe("$3.00");
    // A sub-cent rate must not round to $0.00 — that is the null lie in reverse.
    expect(rateCell(0.0004).text).toBe("$0.0004");
  });

  it("relativeStamp handles past, future and garbage", () => {
    // A FIXED reference instant, deliberately NOT the wall clock. This used to
    // read `Date.parse(NOW)` (the real current time) while asserting against
    // hardcoded absolute stamps, so it only passed during the one hour of the
    // day when "now" happened to sit near 12:00Z and reported "2 hours ago"
    // after that. relativeStamp takes `now` as a parameter precisely so its
    // arithmetic can be pinned; use that.
    const now = Date.parse("2026-07-30T12:00:00Z");
    expect(relativeStamp("2026-07-30T11:00:00Z", now)).toBe("1 hour ago");
    expect(relativeStamp("2026-07-30T14:00:00Z", now)).toBe("in 2 hours");
    expect(relativeStamp("2026-07-28T12:00:00Z", now)).toBe("2 days ago");
    // Boundary: 90 minutes rounds to 2 hours, and the singular/plural must follow.
    expect(relativeStamp("2026-07-30T10:30:00Z", now)).toBe("2 hours ago");
    expect(relativeStamp(null, now)).toBeNull();
    expect(relativeStamp("not a date", now)).toBeNull();
  });

  it("sortModels is provider-then-model and never mutates its input", () => {
    const input = [
      { provider: "b", model: "z" },
      { provider: "a", model: "y" },
      { provider: "a", model: "x" },
    ];
    const copy = JSON.parse(JSON.stringify(input));
    expect(sortModels(input).map((r) => `${r.provider}/${r.model}`)).toEqual([
      "a/x",
      "a/y",
      "b/z",
    ]);
    expect(input).toEqual(copy);
    expect(sortModels(undefined)).toEqual([]);
  });
});

describe("SettingsView — pricing routing", () => {
  it("routes the pricing section to the Pricing page", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/settings") return jsonRes({ path: SETTINGS_PATH, settings: {} });
      if (url === "/api/pricing") return jsonRes(PAYLOAD);
      return jsonRes({}, false, 404);
    });

    render(<SettingsView section="pricing" onSelectSection={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("pricing-table")).toBeInTheDocument());
    // The honest stub it replaced is gone.
    expect(screen.queryByText("Pricing table is not built yet")).not.toBeInTheDocument();
    expect(screen.getByTestId("pricing-snapshot-note")).toBeInTheDocument();
  });
});
