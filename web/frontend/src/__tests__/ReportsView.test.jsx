/**
 * Tests for Reports (Phase 7, screen 1f).
 *
 * The load-bearing assertions here are the honesty ones — a null must never
 * render as 0, an idle day must still be drawn, "we could not ask" must not
 * look like "nothing happened", and the spend caption must actually say the
 * figures are API-equivalent with local tokens at $0. Those are the failure
 * modes that turn this page into a lie about the user's spend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import ReportsView from "../components/reports/ReportsView.jsx";
import { SPEND_CAPTION } from "../components/reports/SpendByModel.jsx";
import {
  DELTA_RULES,
  DELTA_TOKEN,
  REPORTS_TABS,
  buildDeltas,
  buildSessionsCsv,
  costBasisSummary,
  proportionPhrase,
  fmtCost,
  fmtCount,
  fmtInt,
  fmtPct,
  sumColumn,
  toolCoverage,
  tokensUnreported,
} from "../components/reports/format.js";

// ── fixtures ──────────────────────────────────────────────

/**
 * tool_calls is a REAL integer everywhere now (the tracker reads
 * message.content alongside message.usage), so these fixtures carry numbers.
 *
 * The range is 7d off generated_at 2026-07-30T12:00Z, so the range starts
 * 2026-07-23T12:00Z. tool_events_since is INSIDE that window on purpose — the
 * partial-coverage direction. The full-coverage direction is exercised by
 * overriding tool_events_since to a date before the window starts.
 */
const REPORT = {
  range: "7d",
  generated_at: "2026-07-30T12:00:00Z",
  tool_events_since: "2026-07-28T09:00:00+00:00",
  kpis: {
    total_tokens: 1234567,
    cost: 12.3456,
    cache_hit_rate: 0.4213,
    local_share: 0.25,
    turns: 482,
    tool_calls: 12,
  },
  // Chosen to exercise every delta branch at once: percent change (tokens,
  // cost, turns), percentage points (cache hit rate), an exactly-unchanged
  // value (local share), and a previous ZERO that must not divide (tool calls).
  previous: {
    available: true,
    kpis: {
      total_tokens: 1000000,
      cost: 10,
      cache_hit_rate: 0.3,
      local_share: 0.25,
      turns: 400,
      tool_calls: 0,
    },
  },
  by_tool: [
    { tool_name: "Read", calls: 7, share: 0.5833 },
    { tool_name: "Edit", calls: 4, share: 0.3333 },
    { tool_name: "Bash", calls: 1, share: 0.0833 },
  ],
  by_day: [
    { day: "2026-07-28", input: 1000, output: 500, cache_read: 200, cache_write: 50, local: 0, total: 1750, cost: 0.42 },
    // A gap-filled idle day: must still render as a labelled, zero-height column.
    { day: "2026-07-29", input: 0, output: 0, cache_read: 0, cache_write: 0, local: 0, total: 0, cost: 0 },
    { day: "2026-07-30", input: 4000, output: 900, cache_read: 0, cache_write: 0, local: 3000, total: 7900, cost: 1.15 },
  ],
  by_model: [
    { model: "claude-opus-4", provider: "anthropic", tokens: 900000, cost: 11.2, share: 0.75, is_local: false },
    { model: "qwen3-coder-30b-awq", provider: "vllm-local", tokens: 334567, cost: 0, share: 0.25, is_local: true },
  ],
  sessions: [
    {
      terminal_id: "t-1",
      name: "api work",
      project: "claude-cockpit",
      model: "claude-opus-4",
      input: 1000,
      output: 500,
      cache_read: 200,
      cache_write: 50,
      local: 0,
      total: 1750,
      turns: 12,
      cost: 1.5,
      tool_calls: 3,
    },
    {
      // name null (session no longer live) → label falls back to terminal id.
      terminal_id: "t-2",
      name: null,
      project: "other-proj",
      model: "qwen3-coder-30b-awq",
      input: 4000,
      output: 900,
      cache_read: 0,
      cache_write: 0,
      local: 3000,
      total: 4900,
      turns: 30,
      cost: 0,
      tool_calls: 9,
    },
  ],
};

const EMPTY_REPORT = {
  range: "7d",
  generated_at: "2026-07-30T12:00:00Z",
  tool_events_since: null,
  kpis: {
    total_tokens: 0,
    cost: 0,
    cache_hit_rate: 0,
    local_share: 0,
    turns: 0,
    tool_calls: 0,
  },
  previous: { available: false, kpis: null },
  by_day: [],
  by_model: [],
  by_tool: [],
  sessions: [],
};

function jsonRes(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

function mockReport(body = REPORT) {
  globalThis.fetch = vi.fn(() => jsonRes(body));
}

/** URL of the most recent /api/usage/report call. */
function lastReportUrl() {
  const calls = globalThis.fetch.mock.calls.filter((c) => String(c[0]).startsWith("/api/usage/report"));
  return calls.length ? String(calls[calls.length - 1][0]) : null;
}

beforeEach(() => {
  mockReport();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ready = () => waitFor(() => expect(screen.getByTestId("kpi-row")).toBeInTheDocument());

// ── tabs ──────────────────────────────────────────────────

describe("ReportsView — tabs", () => {
  it("lists exactly the seven tabs, in order, after the S26 consolidation", async () => {
    render(<ReportsView />);
    await ready();
    expect(REPORTS_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Sessions",
      "Models",
      "Tools",
      "Traces",
      "Logs",
      "Local engine",
    ]);
    for (const t of REPORTS_TABS) {
      expect(screen.getByLabelText(`${t.label} report`)).toBeInTheDocument();
    }
  });

  it("switches between every tab, rendering built views and honest stubs", async () => {
    render(<ReportsView />);
    await ready();
    expect(screen.getByLabelText("Overview report")).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByLabelText("Sessions report"));
    expect(screen.getByTestId("sessions-table")).toBeInTheDocument();
    expect(screen.queryByTestId("kpi-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Models report"));
    expect(screen.getByTestId("models-table")).toBeInTheDocument();

    // Tools is BUILT now (by_tool landed), so it must not fall through to a stub.
    fireEvent.click(screen.getByLabelText("Tools report"));
    expect(screen.getByTestId("tools-breakdown")).toBeInTheDocument();
    expect(screen.queryByTestId("not-built-tools")).not.toBeInTheDocument();

    // Traces and Logs are BUILT now — S26 moved both here from Engine.
    fireEvent.click(screen.getByLabelText("Traces report"));
    /* S26 (2026-08-03): Traces is no longer a stub. The real renderer moved here
       from Engine ▸ Requests, so the assertion changed from "names a destination
       that exists" to "renders the panel AND still admits the recorder is off".
       That second half is owned by ReportsView.consolidation.test.jsx, which
       replaced ReportsView.tracesPointer.test.jsx. */
    await waitFor(() => expect(screen.queryByTestId("not-built-traces")).not.toBeInTheDocument());

    fireEvent.click(screen.getByLabelText("Logs report"));
    await waitFor(() => expect(screen.getByTestId("engine-logs-empty")).toBeInTheDocument());

    // Local engine is BUILT now, sourced from Plexar rather than from
    // /api/usage/report. With no Plexar answering (the fetch mock returns the
    // usage report only), it must render its honest unavailable state — NOT a
    // stub, and NOT an empty table implying zero engine activity.
    fireEvent.click(screen.getByLabelText("Local engine report"));
    await waitFor(() =>
      expect(screen.queryByTestId("not-built-local-engine")).not.toBeInTheDocument()
    );
    expect(await screen.findByText(/No local engine history/i)).toBeInTheDocument();
  });
});

// ── range control ─────────────────────────────────────────

describe("ReportsView — range control", () => {
  it("fetches 7d by default and refetches with the right query param", async () => {
    render(<ReportsView />);
    await ready();
    expect(lastReportUrl()).toBe("/api/usage/report?range=7d");

    fireEvent.click(screen.getByLabelText("Range: 30d"));
    await waitFor(() => expect(lastReportUrl()).toBe("/api/usage/report?range=30d"));

    fireEvent.click(screen.getByLabelText("Range: All"));
    await waitFor(() => expect(lastReportUrl()).toBe("/api/usage/report?range=all"));

    fireEvent.click(screen.getByLabelText("Range: 24h"));
    await waitFor(() => expect(lastReportUrl()).toBe("/api/usage/report?range=24h"));
    expect(screen.getByLabelText("Range: 24h")).toHaveAttribute("aria-checked", "true");
  });

  it("does not poll — one fetch per range", async () => {
    vi.useFakeTimers();
    try {
      render(<ReportsView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20000);
      });
      const calls = globalThis.fetch.mock.calls.filter((c) =>
        String(c[0]).startsWith("/api/usage/report")
      );
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── KPIs ──────────────────────────────────────────────────

describe("ReportsView — KPI row", () => {
  it("renders all six KPIs with formatted values", async () => {
    render(<ReportsView />);
    await ready();
    expect(screen.getByTestId("kpi-total-tokens")).toHaveTextContent("1,234,567");
    expect(screen.getByTestId("kpi-cost")).toHaveTextContent("$12.35");
    expect(screen.getByTestId("kpi-cache-hit-rate")).toHaveTextContent("42.1%");
    expect(screen.getByTestId("kpi-local-share")).toHaveTextContent("25.0%");
    expect(screen.getByTestId("kpi-turns")).toHaveTextContent("482");
    expect(screen.getByTestId("kpi-row").children).toHaveLength(6);
  });

  it("renders tool calls as a real number, not 'not recorded'", async () => {
    render(<ReportsView />);
    await ready();
    const card = screen.getByTestId("kpi-tool-calls");
    expect(card).toHaveTextContent("12");
    expect(card).toHaveAttribute("data-missing", "false");
    expect(card).not.toHaveTextContent(/not recorded/i);
    expect(card).not.toHaveTextContent(/no source/i);
  });

  it("renders a genuine zero tool calls as 0, NOT as 'not recorded'", async () => {
    mockReport({ ...REPORT, kpis: { ...REPORT.kpis, tool_calls: 0 } });
    render(<ReportsView />);
    await ready();
    const card = screen.getByTestId("kpi-tool-calls");
    expect(card).toHaveTextContent("0");
    expect(card).not.toHaveTextContent(/not recorded/i);
    expect(card).toHaveAttribute("data-missing", "false");
  });

  it("still refuses to invent a number if tool_calls ever goes null again", async () => {
    mockReport({ ...REPORT, kpis: { ...REPORT.kpis, tool_calls: null } });
    render(<ReportsView />);
    await ready();
    const card = screen.getByTestId("kpi-tool-calls");
    expect(card).toHaveAttribute("data-missing", "true");
    expect(card).toHaveTextContent("not reported");
  });
});

// ── cost basis ────────────────────────────────────────────

describe("ReportsView — cost basis", () => {
  const withBasis = (cost_basis) => mockReport({ ...REPORT, cost_basis });

  it("says how many events were priced retroactively, as a proportion", async () => {
    withBasis({ exact: 0, backfilled: 29033, unpriced: 0 });
    render(<ReportsView />);
    await ready();
    const note = screen.getByTestId("cost-basis-note");
    expect(note).toHaveAttribute("role", "note");
    // The owner's real shape: the WHOLE history is retroactive, and "all" says
    // something a bare count does not.
    expect(note).toHaveTextContent("all 29,033 API events in this range were priced retroactively");
    expect(note).toHaveTextContent(/rate in force at the time is not recorded/i);
    expect(note).toHaveTextContent(/best available estimate/i);
  });

  it("says 'N of M' when only part of the window is retroactive", async () => {
    withBasis({ exact: 3988, backfilled: 12, unpriced: 0 });
    render(<ReportsView />);
    await ready();
    const note = screen.getByTestId("cost-basis-note");
    expect(note).toHaveTextContent("12 of 4,000 API events");
    expect(note).not.toHaveTextContent(/^all /);
  });

  it("gives unpriced events their own clause: $0 for want of a price, not free work", async () => {
    withBasis({ exact: 100, backfilled: 0, unpriced: 21 });
    render(<ReportsView />);
    await ready();
    const note = screen.getByTestId("cost-basis-note");
    expect(note).toHaveTextContent("21 of 121 events have no price on file");
    expect(note).toHaveTextContent("$0 because the price is unknown, not because the work was free");
    expect(note).toHaveTextContent(/understated/i);
    // With nothing backfilled, the retroactive clause is not asserted.
    expect(note).not.toHaveTextContent(/retroactively/i);
  });

  it("carries both clauses when both apply, matching the payload counts", async () => {
    withBasis({ exact: 3, backfilled: 29033, unpriced: 21 });
    render(<ReportsView />);
    await ready();
    const note = screen.getByTestId("cost-basis-note");
    expect(note).toHaveTextContent("29,033 of 29,057 API events");
    expect(note).toHaveTextContent("21 of 29,057 events have no price on file");
  });

  it("renders NOTHING when the whole window was priced at ingest", async () => {
    withBasis({ exact: 4000, backfilled: 0, unpriced: 0 });
    render(<ReportsView />);
    await ready();
    // A disclaimer that never retires is a disclaimer nobody reads, so an
    // all-exact window must be silent.
    expect(screen.queryByTestId("cost-basis-note")).not.toBeInTheDocument();
  });

  it("renders nothing, and does not break, when cost_basis is absent or empty", async () => {
    for (const basis of [undefined, null, {}, { exact: 0, backfilled: 0, unpriced: 0 }, "nonsense"]) {
      withBasis(basis);
      const { unmount } = render(<ReportsView />);
      await ready();
      expect(screen.queryByTestId("cost-basis-note")).not.toBeInTheDocument();
      expect(screen.getByTestId("kpi-row")).toBeInTheDocument();
      unmount();
    }
  });

  it("repeats the note on Models, whose Cost column is the same money", async () => {
    withBasis({ exact: 0, backfilled: 29033, unpriced: 21 });
    render(<ReportsView initialTab="models" />);
    await waitFor(() => expect(screen.getByTestId("models-table")).toBeInTheDocument());
    expect(screen.getByTestId("cost-basis-note")).toHaveTextContent(/priced retroactively/i);
  });

  it("does not repeat the note on tabs it does not qualify", async () => {
    withBasis({ exact: 0, backfilled: 29033, unpriced: 21 });
    render(<ReportsView initialTab="tools" />);
    await waitFor(() => expect(screen.getByTestId("tools-breakdown")).toBeInTheDocument());
    expect(screen.queryByTestId("cost-basis-note")).not.toBeInTheDocument();
  });

  it("costBasisSummary reduces to the case worth saying", () => {
    expect(costBasisSummary({ exact: 5, backfilled: 0, unpriced: 0 })).toBeNull();
    expect(costBasisSummary(null)).toBeNull();
    expect(costBasisSummary({})).toBeNull();
    expect(costBasisSummary({ exact: 1, backfilled: 2, unpriced: 3 })).toEqual({
      exact: 1,
      backfilled: 2,
      unpriced: 3,
      total: 6,
    });
    // A missing sibling counts as zero rather than poisoning the total.
    expect(costBasisSummary({ backfilled: 4 })).toEqual({
      exact: 0,
      backfilled: 4,
      unpriced: 0,
      total: 4,
    });
  });

  it("proportionPhrase picks 'all' only when the count covers the total", () => {
    expect(proportionPhrase(29033, 29033)).toBe("all 29,033");
    expect(proportionPhrase(12, 4000)).toBe("12 of 4,000");
    expect(proportionPhrase(5, 0)).toBe("5");
    expect(proportionPhrase(null, 10)).toBe("—");
  });
});

// ── token honesty ─────────────────────────────────────────

describe("ReportsView — zero tokens with turns recorded is a client misconfiguration", () => {
  it("names stream_options.include_usage when work happened but tokens came back zero", async () => {
    mockReport({ ...REPORT, kpis: { ...REPORT.kpis, total_tokens: 0, turns: 482 } });
    render(<ReportsView />);
    await ready();
    const note = screen.getByTestId("tokens-unreported-note");
    expect(note).toHaveAttribute("role", "note");
    // The actionable string itself, not a paraphrase of it.
    expect(note).toHaveTextContent("stream_options.include_usage");
    expect(note).toHaveTextContent(/not reported/i);
    expect(note).toHaveTextContent(/rather than not used/i);
  });

  it("stays SILENT on a genuinely quiet range — zero turns AND zero tokens", async () => {
    mockReport({
      ...REPORT,
      kpis: { ...REPORT.kpis, total_tokens: 0, turns: 0 },
      sessions: [],
    });
    render(<ReportsView />);
    await ready();
    // A configuration warning here would be a false alarm, which is worse than
    // silence: nothing ran, so nothing failed to be counted.
    expect(screen.queryByTestId("tokens-unreported-note")).not.toBeInTheDocument();
  });

  it("stays silent when tokens are actually present", async () => {
    render(<ReportsView />);
    await ready();
    expect(screen.queryByTestId("tokens-unreported-note")).not.toBeInTheDocument();
  });

  it("stays silent when total_tokens is null — that already reads 'not reported'", async () => {
    mockReport({ ...REPORT, kpis: { ...REPORT.kpis, total_tokens: null } });
    render(<ReportsView />);
    await ready();
    expect(screen.getByTestId("kpi-total-tokens")).toHaveTextContent("not reported");
    expect(screen.queryByTestId("tokens-unreported-note")).not.toBeInTheDocument();
  });

  it("fires off session rows alone, even when turns are not reported", () => {
    expect(tokensUnreported({ total_tokens: 0, turns: null }, [{ terminal_id: "t-1" }])).toBe(true);
    expect(tokensUnreported({ total_tokens: 0, turns: null }, [])).toBe(false);
    expect(tokensUnreported({ total_tokens: 5, turns: 3 }, [{}])).toBe(false);
  });
});

// ── tool-call coverage (the honesty guard) ────────────────

describe("ReportsView — tool_events_since coverage note", () => {
  it("warns when recording began INSIDE the range, naming the date", async () => {
    // 7d off 2026-07-30T12:00Z starts 2026-07-23; recording began 2026-07-28.
    render(<ReportsView />);
    await ready();
    const note = screen.getByTestId("tool-coverage-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/only been recorded since Jul 28, 2026/);
    expect(note).toHaveTextContent(/floor rather than a total/i);
  });

  it("shows NO note when the range starts after recording began", async () => {
    mockReport({ ...REPORT, tool_events_since: "2026-07-01T00:00:00+00:00" });
    render(<ReportsView />);
    await ready();
    expect(screen.queryByTestId("tool-coverage-note")).not.toBeInTheDocument();
  });

  it("distinguishes 'never recorded' from 'zero calls' when tool_events_since is null", async () => {
    mockReport({ ...REPORT, tool_events_since: null });
    render(<ReportsView />);
    await ready();
    const note = screen.getByTestId("tool-coverage-note");
    expect(note).toHaveTextContent(/have not been recorded yet/i);
    expect(note).toHaveTextContent(/not a measurement of zero tool calls/i);
    expect(note).not.toHaveTextContent(/only been recorded since/);
  });

  it("treats range=all as partial coverage — nothing precedes the first stored event", () => {
    expect(
      toolCoverage({
        range: "all",
        generatedAt: "2026-07-30T12:00:00Z",
        byDay: REPORT.by_day,
        toolEventsSince: "2026-07-28T09:00:00+00:00",
      }).state
    ).toBe("partial");
    // The same `since` is FULL coverage for a range that starts after it.
    expect(
      toolCoverage({
        range: "24h",
        generatedAt: "2026-07-30T12:00:00Z",
        byDay: REPORT.by_day,
        toolEventsSince: "2026-07-28T09:00:00+00:00",
      }).state
    ).toBe("full");
  });
});

// ── deltas ────────────────────────────────────────────────

describe("ReportsView — period-over-period deltas", () => {
  it("renders a delta on every card when previous is available, and drops the note", async () => {
    render(<ReportsView />);
    await ready();
    for (const id of Object.keys(DELTA_RULES)) {
      expect(screen.getByTestId(`kpi-delta-${id}`)).toBeInTheDocument();
    }
    expect(screen.queryByTestId("delta-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("kpi-delta-total-tokens")).toHaveTextContent("+23.5% vs previous 7d");
    expect(screen.getByTestId("kpi-delta-cache-hit-rate")).toHaveTextContent(
      "+12.1 pts vs previous 7d"
    );
    // An exactly-unchanged value says so rather than showing "+0.0%".
    expect(screen.getByTestId("kpi-delta-local-share")).toHaveTextContent("no change vs previous 7d");
  });

  it("renders NO delta anywhere when previous.available is false, and says why", async () => {
    mockReport({ ...REPORT, previous: { available: false, kpis: null } });
    render(<ReportsView />);
    await ready();
    for (const id of Object.keys(DELTA_RULES)) {
      expect(screen.queryByTestId(`kpi-delta-${id}`)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId("delta-note")).toHaveTextContent(/no comparable previous window/i);
  });

  it("explains range=all specifically when there is nothing before it", async () => {
    mockReport({ ...REPORT, range: "all", previous: { available: false, kpis: null } });
    render(<ReportsView />);
    await ready();
    expect(screen.getByTestId("delta-note")).toHaveTextContent(/no earlier window to compare/i);
  });

  it("never renders Infinity or NaN when a previous KPI is 0", async () => {
    render(<ReportsView />);
    await ready();
    // previous.tool_calls is 0 in the fixture: the absolute move is shown.
    const delta = screen.getByTestId("kpi-delta-tool-calls");
    expect(delta).toHaveTextContent("+12 vs previous 7d (was 0)");
    expect(screen.getByTestId("reports-view").textContent).not.toMatch(/Infinity|NaN/);
  });

  it("tones per metric: cost UP warns, cache-hit-rate UP is good, tokens stay neutral", async () => {
    render(<ReportsView />);
    await ready();
    expect(screen.getByTestId("kpi-delta-cost")).toHaveAttribute("data-tone", "cost");
    expect(screen.getByTestId("kpi-delta-cache-hit-rate")).toHaveAttribute("data-tone", "good");
    expect(screen.getByTestId("kpi-delta-total-tokens")).toHaveAttribute("data-tone", "flat");
    expect(screen.getByTestId("kpi-delta-turns")).toHaveAttribute("data-tone", "flat");
    // The tone→token mapping is pinned so "warning" cannot quietly become green.
    expect(DELTA_TOKEN.cost).toBe("var(--cc-waiting)");
    expect(DELTA_TOKEN.good).toBe("var(--cc-ok)");
    expect(DELTA_TOKEN.flat).toBe("var(--cc-dim)");
  });

  it("flips tone with direction: cost DOWN is good, cache-hit-rate DOWN warns", () => {
    const down = buildDeltas(
      { cost: 5, cache_hit_rate: 0.2, total_tokens: 10, local_share: 0.1, turns: 1, tool_calls: 1 },
      { available: true, kpis: REPORT.previous.kpis },
      "7d"
    );
    expect(down.cost.tone).toBe("good");
    expect(down["cache-hit-rate"].tone).toBe("cost");
    expect(down["total-tokens"].tone).toBe("flat");
    // Local share falling is a model choice, not a regression to flag.
    expect(down["local-share"].tone).toBe("flat");
  });

  it("skips a card whose value is missing on either side", () => {
    const d = buildDeltas(
      { total_tokens: 100, cost: null },
      { available: true, kpis: { total_tokens: 50, cost: 1 } },
      "7d"
    );
    expect(d["total-tokens"]).toBeTruthy();
    expect(d.cost).toBeUndefined();
    expect(d.turns).toBeUndefined();
  });
});

// ── tools tab ─────────────────────────────────────────────

describe("ReportsView — Tools tab", () => {
  it("renders one row per by_tool entry with its calls and share", async () => {
    render(<ReportsView initialTab="tools" />);
    await waitFor(() => expect(screen.getByTestId("tools-breakdown")).toBeInTheDocument());
    for (const t of REPORT.by_tool) {
      const row = screen.getByTestId(`tool-row-${t.tool_name}`);
      expect(row).toHaveTextContent(String(t.calls));
      expect(row).toHaveTextContent(fmtPct(t.share));
      expect(screen.getByTestId(`tool-bar-${t.tool_name}`)).toBeInTheDocument();
    }
    // Server order (calls desc) is preserved, not re-sorted client-side.
    const names = Array.from(
      screen.getByTestId("tools-breakdown").querySelectorAll("[data-testid^='tool-row-']")
    ).map((el) => el.getAttribute("data-testid"));
    expect(names).toEqual(["tool-row-Read", "tool-row-Edit", "tool-row-Bash"]);
    expect(screen.getByTestId("tools-breakdown")).toHaveTextContent("3 tools · 12 calls");
  });

  it("carries the same coverage note as Overview", async () => {
    render(<ReportsView initialTab="tools" />);
    await waitFor(() => expect(screen.getByTestId("tools-breakdown")).toBeInTheDocument());
    expect(screen.getByTestId("tools-coverage-note")).toHaveTextContent(
      /only been recorded since Jul 28, 2026/
    );
  });

  it("renders an honest empty state when by_tool is []", async () => {
    mockReport({ ...REPORT, by_tool: [] });
    render(<ReportsView initialTab="tools" />);
    await waitFor(() => expect(screen.getByTestId("tools-breakdown")).toBeInTheDocument());
    expect(screen.getByTestId("tools-empty")).toHaveTextContent(/No tool calls in this range/i);
    // The caveat is still there, so "none" is not read as a clean zero.
    expect(screen.getByTestId("tools-coverage-note")).toBeInTheDocument();
    expect(screen.queryByTestId("tool-row-Read")).not.toBeInTheDocument();
  });
});

// ── stacked chart ─────────────────────────────────────────

describe("ReportsView — tokens per day chart", () => {
  it("renders one column per by_day entry, including the all-zero day", async () => {
    render(<ReportsView />);
    await ready();
    const chart = screen.getByTestId("tokens-by-day");
    for (const d of REPORT.by_day) {
      expect(screen.getByTestId(`day-col-${d.day}`)).toBeInTheDocument();
    }
    // The idle day is present, labelled, and marked as zero — not dropped.
    const idle = screen.getByTestId("day-col-2026-07-29");
    expect(idle).toHaveAttribute("data-zero", "true");
    expect(idle).toHaveTextContent("Jul 29");
    // ...and draws no segments.
    expect(screen.queryByTestId("seg-2026-07-29-input")).not.toBeInTheDocument();
    // A busy day does draw them.
    expect(screen.getByTestId("seg-2026-07-28-input")).toBeInTheDocument();
    expect(screen.getByTestId("seg-2026-07-30-local")).toBeInTheDocument();
    // All five classes are in the legend.
    for (const key of ["input", "output", "cache_read", "cache_write", "local"]) {
      expect(within(chart).getByTestId(`legend-${key}`)).toBeInTheDocument();
    }
  });

  it("survives a single-day range", async () => {
    mockReport({ ...REPORT, by_day: [REPORT.by_day[2]] });
    render(<ReportsView />);
    await ready();
    expect(screen.getByTestId("day-col-2026-07-30")).toBeInTheDocument();
    expect(screen.queryByTestId("day-col-2026-07-28")).not.toBeInTheDocument();
  });

  it("survives a single all-zero day (no divide-by-zero, column still drawn)", async () => {
    mockReport({ ...REPORT, by_day: [REPORT.by_day[1]] });
    render(<ReportsView />);
    await ready();
    expect(screen.getByTestId("day-col-2026-07-29")).toHaveAttribute("data-zero", "true");
  });
});

// ── spend card ────────────────────────────────────────────

describe("ReportsView — where the spend goes", () => {
  it("states that costs are API-equivalent and local tokens are $0, counted separately", async () => {
    render(<ReportsView />);
    await ready();
    const caption = screen.getByTestId("spend-caption");
    expect(caption).toHaveTextContent(/API-equivalent/i);
    expect(caption).toHaveTextContent(/pricing_models\.json/);
    expect(caption).toHaveTextContent(/not your subscription bill/i);
    expect(caption).toHaveTextContent(/Local tokens are costed at \$0 and counted separately/i);
    // The caption text is pinned so it cannot be quietly softened.
    expect(SPEND_CAPTION).toMatch(/API-equivalent/);
    expect(SPEND_CAPTION).toMatch(/counted separately/);
  });

  /**
   * Ported from the deleted localReporting/PerModelAgent.test.jsx, whose
   * "not reported for null tokens, never 0" / "n/a for null cost, never $0.00"
   * assertions were the only coverage of per-model null honesty. The Models tab
   * is the new owner. The SENTINEL differs by design — reports/format.js states
   * the rule as "not reported" in a KPI (where there is room to say it) and an
   * em dash in a table cell (where there is not) — so these assert the em dash.
   * The load-bearing half is unchanged and unweakened: never 0, never $0.00.
   */
  it("renders an em dash — never 0 — for a model that reports no tokens", async () => {
    mockReport({
      ...REPORT,
      by_model: [{ model: "qwen3-coder-30b-awq", provider: "vllm-local", tokens: null, cost: null, share: null, is_local: true }],
    });
    render(<ReportsView />);
    await ready();
    fireEvent.click(screen.getByLabelText("Models report"));
    const row = screen.getByTestId("model-row-qwen3-coder-30b-awq");
    expect(row).toHaveTextContent("—");
    // The failure mode: a null fabricated into a zero, or a free model priced.
    expect(row).not.toHaveTextContent(/\b0\b/);
    expect(row).not.toHaveTextContent("$0.00");
  });

  it("keeps a GENUINE zero cost as $0.00 — a local model is free, not unreported", async () => {
    render(<ReportsView />);
    await ready();
    fireEvent.click(screen.getByLabelText("Models report"));
    // cost: 0 in the fixture. Distinguishing this from null is the whole point.
    expect(screen.getByTestId("model-row-qwen3-coder-30b-awq")).toHaveTextContent("$0.00");
  });

  /**
   * by_model empty while the range HAS activity — a real state (usage recorded
   * with no model attribution), and distinct from the brand-new-install empty
   * state, which replaces the whole view before a tab is ever reachable.
   */
  it("renders an honest empty state in the Models tab, not a header over nothing", async () => {
    mockReport({ ...REPORT, by_model: [] });
    render(<ReportsView />);
    await ready();
    fireEvent.click(screen.getByLabelText("Models report"));
    expect(screen.getByTestId("models-table")).toHaveTextContent("No model activity in this range.");
  });

  it("labels each model with its provider and marks local models", async () => {
    render(<ReportsView />);
    await ready();
    const local = screen.getByTestId("spend-row-qwen3-coder-30b-awq");
    expect(local).toHaveTextContent("vllm-local");
    expect(local).toHaveTextContent("local");
    expect(local).toHaveTextContent("$0.00");
    expect(screen.getByTestId("spend-row-claude-opus-4")).toHaveTextContent("anthropic");
  });
});

// ── sessions table ────────────────────────────────────────

describe("ReportsView — sessions table", () => {
  it("sums each column to match the rows", async () => {
    render(<ReportsView />);
    await ready();
    const rows = REPORT.sessions;
    expect(screen.getByTestId("sum-input")).toHaveTextContent(
      fmtCount(sumColumn(rows, "input").value)
    );
    expect(screen.getByTestId("sum-input")).toHaveTextContent("5,000");
    expect(screen.getByTestId("sum-output")).toHaveTextContent("1,400");
    expect(screen.getByTestId("sum-total")).toHaveTextContent("6,650");
    expect(screen.getByTestId("sum-turns")).toHaveTextContent("42");
    expect(screen.getByTestId("sum-cost")).toHaveTextContent("$1.50");
    expect(screen.getByTestId("sum-cache")).toHaveTextContent("200 / 50");
  });

  it("shows real per-session tool counts and sums them, with no unsourced footnote", async () => {
    render(<ReportsView />);
    await ready();
    // The Tools cell is the last column, asserted positionally so a digit
    // elsewhere in the row cannot make this pass by accident.
    const toolsCell = (tid) => {
      const cells = screen.getByTestId(tid).querySelectorAll("td");
      return cells[cells.length - 1].textContent;
    };
    expect(toolsCell("session-row-t-1")).toBe("3");
    expect(toolsCell("session-row-t-2")).toBe("9");
    expect(screen.getByTestId("sum-tools")).toHaveTextContent("12");
    // The em-dash/unsourced note is gone: the column has a source now.
    expect(screen.queryByTestId("tools-unsourced-note")).not.toBeInTheDocument();
    expect(screen.getByTestId("sum-tools").textContent).not.toContain("—");
  });

  it("still shows an em dash — never 0 — for a column no row reports", async () => {
    mockReport({
      ...REPORT,
      sessions: REPORT.sessions.map((s) => ({ ...s, tool_calls: null })),
    });
    render(<ReportsView />);
    await ready();
    const toolsSum = screen.getByTestId("sum-tools");
    expect(toolsSum).toHaveTextContent("—");
    expect(toolsSum.textContent).not.toMatch(/\d/);
  });

  it("falls back to the terminal id when name is null", async () => {
    render(<ReportsView />);
    await ready();
    expect(screen.getByTestId("session-row-t-2")).toHaveTextContent("t-2");
  });

  it("calls onOpenTrace with the terminal id on a row click and on Enter", async () => {
    const onOpenTrace = vi.fn();
    render(<ReportsView onOpenTrace={onOpenTrace} />);
    await ready();

    fireEvent.click(screen.getByTestId("session-row-t-1"));
    expect(onOpenTrace).toHaveBeenCalledWith("t-1");

    fireEvent.keyDown(screen.getByTestId("session-row-t-2"), { key: "Enter" });
    expect(onOpenTrace).toHaveBeenCalledWith("t-2");
    expect(onOpenTrace).toHaveBeenCalledTimes(2);
  });
});

// ── filters + CSV ─────────────────────────────────────────

describe("ReportsView — filters and CSV export", () => {
  it("filters the sessions table by project and says what the filter does not reach", async () => {
    render(<ReportsView />);
    await ready();
    expect(screen.queryByTestId("filter-scope-note")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter by project"), {
      target: { value: "other-proj" },
    });
    expect(screen.getByTestId("session-row-t-2")).toBeInTheDocument();
    expect(screen.queryByTestId("session-row-t-1")).not.toBeInTheDocument();
    // The note must enumerate everything the pills do NOT scope, by_tool included.
    const scope = screen.getByTestId("filter-scope-note");
    expect(scope).toHaveTextContent(/KPI row, the per-day chart and the per-tool breakdown/i);
    expect(scope).toHaveTextContent("by_tool");
    // Sums follow the filtered rows.
    expect(screen.getByTestId("sum-input")).toHaveTextContent("4,000");
  });

  it("builds a CSV with a header row plus one line per session", () => {
    const csv = buildSessionsCsv(REPORT.sessions);
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(1 + REPORT.sessions.length);
    expect(lines[0]).toBe(
      "session,project,model,input,output,cache_read,cache_write,total,turns,cost_usd,tool_calls"
    );
    // The now-real tool_calls is exported as a number in the final column.
    expect(lines[0].endsWith(",tool_calls")).toBe(true);
    expect(lines[1]).toBe("api work,claude-cockpit,claude-opus-4,1000,500,200,50,1750,12,1.5,3");
    expect(lines[2]).toContain("t-2");
    expect(lines[2].endsWith(",9")).toBe(true);
  });

  it("still exports a null tool_calls as an empty cell, never a 0", () => {
    const csv = buildSessionsCsv([{ ...REPORT.sessions[0], tool_calls: null }]);
    const line = csv.trim().split("\n")[1];
    expect(line.endsWith(",")).toBe(true);
    expect(line.endsWith(",0")).toBe(false);
  });

  it("quotes cells containing commas", () => {
    const csv = buildSessionsCsv([{ terminal_id: "x", name: "a,b", project: 'q"p' }]);
    expect(csv.split("\n")[1]).toContain('"a,b"');
    expect(csv.split("\n")[1]).toContain('"q""p"');
  });

  it("Export CSV downloads the rows as displayed, honouring the active filter", async () => {
    // jsdom's Blob has no .text(), so record the parts the component passes in.
    const parts = [];
    const RealBlob = globalThis.Blob;
    class RecordingBlob extends RealBlob {
      constructor(bits, options) {
        super(bits, options);
        parts.push(String(bits?.[0] ?? ""));
      }
    }
    globalThis.Blob = RecordingBlob;
    const createObjectURL = vi.fn(() => "blob:usage");
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();
    const clicks = [];
    const realClick = globalThis.HTMLAnchorElement.prototype.click;
    globalThis.HTMLAnchorElement.prototype.click = function patched() {
      clicks.push({ href: this.href, download: this.download });
    };

    try {
      render(<ReportsView />);
      await ready();

      fireEvent.change(screen.getByLabelText("Filter by model"), {
        target: { value: "qwen3-coder-30b-awq" },
      });
      fireEvent.click(screen.getByLabelText("Export sessions as CSV"));

      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(clicks[0].download).toBe("cockpit-usage-7d-2026-07-30.csv");
      const text = parts[0];
      const lines = text.trim().split("\n");
      // Header + only the filtered session.
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain("qwen3-coder-30b-awq");
      expect(text).not.toContain("claude-opus-4");
    } finally {
      globalThis.HTMLAnchorElement.prototype.click = realClick;
      globalThis.Blob = RealBlob;
    }
  });

  it("disables Export CSV when there is nothing to export", async () => {
    mockReport(EMPTY_REPORT);
    render(<ReportsView />);
    await waitFor(() => expect(screen.getByTestId("reports-empty")).toBeInTheDocument());
    expect(screen.getByLabelText("Export sessions as CSV")).toBeDisabled();
  });
});

// ── failure vs emptiness ──────────────────────────────────

describe("ReportsView — offline and empty states are not the same thing", () => {
  it("renders an error state on a fetch failure, not an empty success", async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("network down")));
    render(<ReportsView />);
    await waitFor(() => expect(screen.getByTestId("reports-error")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/Could not load the usage report/i);
    expect(screen.getByTestId("reports-error")).toHaveTextContent("network down");
    // Crucially: no zeroed report, and NOT the fresh-install empty state.
    expect(screen.queryByTestId("kpi-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("reports-empty")).not.toBeInTheDocument();
  });

  it("names a tracker 503 as 'could not ask', distinct from 'nothing happened'", async () => {
    globalThis.fetch = vi.fn(() => jsonRes({ reachable: false }, false, 503));
    render(<ReportsView />);
    await waitFor(() => expect(screen.getByTestId("reports-error")).toBeInTheDocument());
    expect(screen.getByTestId("reports-error")).toHaveTextContent(
      /could not reach the usage tracker/i
    );
  });

  it("Retry refetches", async () => {
    let fail = true;
    globalThis.fetch = vi.fn(() =>
      fail ? Promise.reject(new Error("network down")) : jsonRes(REPORT)
    );
    render(<ReportsView />);
    await waitFor(() => expect(screen.getByTestId("reports-error")).toBeInTheDocument());
    fail = false;
    fireEvent.click(screen.getByLabelText("Retry loading the usage report"));
    await ready();
    expect(screen.queryByTestId("reports-error")).not.toBeInTheDocument();
  });

  it("renders a clean empty state on a brand-new install, not a grid of zeros", async () => {
    mockReport(EMPTY_REPORT);
    render(<ReportsView />);
    await waitFor(() => expect(screen.getByTestId("reports-empty")).toBeInTheDocument());
    expect(screen.getByTestId("reports-empty")).toHaveTextContent(/No usage recorded yet/i);
    expect(screen.getByTestId("reports-empty")).toHaveTextContent(
      /absence of data, not a measurement of zero/i
    );
    // No KPI grid, no chart, no table full of zeros.
    expect(screen.queryByTestId("kpi-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("tokens-by-day")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sessions-table")).not.toBeInTheDocument();
    // The empty state holds on the data tabs too.
    fireEvent.click(screen.getByLabelText("Models report"));
    expect(screen.getByTestId("reports-empty")).toBeInTheDocument();
  });
});

// ── formatters ────────────────────────────────────────────

describe("reports/format — the honesty primitives", () => {
  it("never turns a missing value into a number", () => {
    for (const missing of [null, undefined, NaN, Infinity]) {
      expect(fmtCount(missing)).toBe("not reported");
      expect(fmtCost(missing)).toBe("not reported");
      expect(fmtPct(missing)).toBe("not reported");
      expect(fmtCount(missing, "—")).toBe("—");
    }
    // ...but a real zero still prints as zero.
    expect(fmtCount(0)).toBe("0");
    expect(fmtCost(0)).toBe("$0.00");
    expect(fmtPct(0)).toBe("0.0%");
  });

  it("formats consistently: separators, 2dp cost, 1dp percent", () => {
    expect(fmtCount(1234567)).toBe("1,234,567");
    expect(fmtCost(12.3456)).toBe("$12.35");
    expect(fmtCost(0.004)).toBe("$0.00");
    expect(fmtPct(0.4213)).toBe("42.1%");
    // Shares written as an already-scaled percent are not multiplied twice.
    expect(fmtPct(42.13)).toBe("42.1%");
  });

  /**
   * fmtInt moved INTO this module when localReporting/ was deleted. It was
   * previously only covered transitively through fmtCount, so a silent drift in
   * the move (losing the separators, or returning "0" for a non-finite input)
   * would not have failed anything. Pinned directly now.
   */
  it("fmtInt survived the move byte-identical: separators, em dash for non-finite", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(0)).toBe("0");
    for (const bad of [null, undefined, NaN, Infinity, "12"]) {
      expect(fmtInt(bad)).toBe("—");
    }
  });

  it("sumColumn returns null when nothing reports the column, and flags partials", () => {
    expect(sumColumn([{ a: null }, { a: null }], "a")).toEqual({
      value: null,
      missing: 2,
      counted: 0,
    });
    expect(sumColumn([{ a: 2 }, { a: null }, { a: 3 }], "a")).toEqual({
      value: 5,
      missing: 1,
      counted: 2,
    });
    expect(sumColumn([], "a").value).toBe(null);
  });
});
