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
  REPORTS_TABS,
  buildSessionsCsv,
  fmtCost,
  fmtCount,
  fmtPct,
  sumColumn,
} from "../components/reports/format.js";

// ── fixtures ──────────────────────────────────────────────

/** tool_calls is null on purpose — the backend never populates it. */
const REPORT = {
  range: "7d",
  generated_at: "2026-07-30T12:00:00Z",
  kpis: {
    total_tokens: 1234567,
    cost: 12.3456,
    cache_hit_rate: 0.4213,
    local_share: 0.25,
    turns: 482,
    tool_calls: null,
  },
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
      tool_calls: null,
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
      tool_calls: null,
    },
  ],
};

const EMPTY_REPORT = {
  range: "7d",
  generated_at: "2026-07-30T12:00:00Z",
  kpis: {
    total_tokens: 0,
    cost: 0,
    cache_hit_rate: 0,
    local_share: 0,
    turns: 0,
    tool_calls: null,
  },
  by_day: [],
  by_model: [],
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
  it("lists exactly the six specified tabs", async () => {
    render(<ReportsView />);
    await ready();
    expect(REPORTS_TABS.map((t) => t.label)).toEqual([
      "Overview",
      "Sessions",
      "Models",
      "Tools",
      "Traces",
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

    // The three unbuilt tabs name what will live there AND where it is today.
    // Asserted inside the loop: only the active tab's panel is mounted.
    const POINTS_AT = {
      tools: /Workflow panel/,
      traces: /Engine ▸ Traces/,
      "local-engine": /Engine ▸ Live/,
    };
    for (const id of ["tools", "traces", "local-engine"]) {
      const label = REPORTS_TABS.find((t) => t.id === id).label;
      fireEvent.click(screen.getByLabelText(`${label} report`));
      const panel = screen.getByTestId(`not-built-${id}`);
      expect(panel).toHaveTextContent(`${label} is not built yet`);
      expect(panel).toHaveTextContent(/Today this lives in/);
      expect(panel).toHaveTextContent(POINTS_AT[id]);
    }
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

  it("renders a null KPI as not-recorded and NEVER as 0", async () => {
    render(<ReportsView />);
    await ready();
    const card = screen.getByTestId("kpi-tool-calls");
    expect(card).toHaveTextContent("not recorded");
    expect(card).toHaveAttribute("data-missing", "true");
    // The exact failure being guarded: a fabricated zero.
    expect(card.textContent).not.toMatch(/\b0\b/);
    // And it says WHY, so an empty card doesn't read as a bug.
    expect(screen.getByTestId("tool-calls-note")).toHaveTextContent(/not a measurement of zero/);
  });

  it("renders no delta at all, and says why", async () => {
    render(<ReportsView />);
    await ready();
    for (const id of ["total-tokens", "cost", "cache-hit-rate", "local-share", "turns", "tool-calls"]) {
      expect(screen.queryByTestId(`kpi-delta-${id}`)).not.toBeInTheDocument();
    }
    expect(screen.getByTestId("delta-note")).toHaveTextContent(/no comparable previous window/i);
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

  it("shows an em dash — never 0 — for a column no row reports, and explains it", async () => {
    render(<ReportsView />);
    await ready();
    const toolsSum = screen.getByTestId("sum-tools");
    expect(toolsSum).toHaveTextContent("—");
    expect(toolsSum.textContent).not.toMatch(/\d/);
    expect(screen.getByTestId("tools-unsourced-note")).toHaveTextContent(
      /not a count of zero/i
    );
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
    expect(screen.getByTestId("filter-scope-note")).toHaveTextContent(/KPI row and the per-day chart/i);
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
    expect(lines[1]).toBe("api work,claude-cockpit,claude-opus-4,1000,500,200,50,1750,12,1.5,");
    // A null tool_calls is an empty cell, never a 0.
    expect(lines[1].endsWith(",")).toBe(true);
    expect(lines[2]).toContain("t-2");
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
