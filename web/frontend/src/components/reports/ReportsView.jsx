/**
 * ReportsView — the Reports section frame and its Overview page (Phase 7,
 * spec §8 / screen 1f).
 *
 * Reports owns THE PAST: an A→Z account of where every token went. Settings
 * owns intent, Engine owns now, Reports owns history — so nothing live belongs
 * on this screen and nothing here polls. The report is fetched exactly once per
 * range change (plus on an explicit Retry), because a historical figure that
 * quietly moves under the reader is worse than a stale one.
 *
 * Data source (single call):
 *   GET /api/usage/report?range=24h|7d|30d|all
 *     → { range, generated_at, kpis, by_day[], by_model[], by_tool[],
 *         sessions[], tool_events_since, previous }
 *   `by_day` is gap-filled server-side: every day is present, zeros where idle.
 *
 * HONESTY CONTRACT — most fields may be null, meaning "not sourceable from the
 * data". Null renders as "not reported" in a KPI and an em dash in a table cell;
 * it is NEVER rendered as 0, because a fabricated zero is a lie about the user's
 * spend. See reports/format.js.
 *
 * TOOL CALLS are the exception now: `kpis.tool_calls`, `sessions[].tool_calls`
 * and `by_tool[]` are real, so 0 means zero and prints as 0. What remains
 * uncertain is COVERAGE — `tool_events_since` is the earliest tool event in the
 * whole store and is NOT range-scoped, so a range reaching back before it counts
 * fewer calls than actually happened. toolCoverage() decides that boundary and
 * this view renders one note for it, on Overview and on the Tools tab.
 *
 * DELTAS come from `previous`. When `previous.available` is false — `range=all`,
 * or a user with no prior window — no card renders a delta at all, because an
 * always-neutral 0% looks like a finding. Tone is per metric: see DELTA_RULES.
 *
 * What is deliberately NOT built, and why (each tab says this on screen):
 *   - Traces / Local engine tabs. There is no per-session trace endpoint, and
 *     live engine state belongs to Engine by design. Each renders an honest
 *     panel naming what will live there and where that information is today.
 *
 * Props:
 *   onOpenTrace(terminalId)   optional; a session row click hands the terminal
 *                             id back to the shell.
 *   statusByTerminalId        optional map terminal_id → session status, used
 *                             only for the row state dot. Absent = unknown,
 *                             drawn muted rather than guessed.
 *   initialRange / initialTab optional starting state (deep links, tests).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download } from "lucide-react";

import KpiRow from "./KpiRow.jsx";
import TokensByDayChart from "./TokensByDayChart.jsx";
import SpendByModel from "./SpendByModel.jsx";
import SessionsTable from "./SessionsTable.jsx";
import ToolsBreakdown from "./ToolsBreakdown.jsx";
import {
  DASH,
  DEFAULT_RANGE,
  RANGES,
  REPORTS_TABS,
  applyFilters,
  buildDeltas,
  buildSessionsCsv,
  csvFilename,
  filterOptions,
  fmtCost,
  fmtCount,
  fmtPct,
  fmtSinceDate,
  costBasisSummary,
  proportionPhrase,
  toolCoverage,
  tokensUnreported,
} from "./format.js";

/** Shared style for the page's explanatory notes. */
const NOTE = { fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.5 };

const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-surface foreground

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
  minWidth: 0,
};

/** Why a tab is not built, and where that information lives today. */
const NOT_BUILT = {
  traces: {
    will:
      "One row per prompt, expandable into the runs it fanned out into, with tokens and wall time per node.",
    today:
      "Engine ▸ Traces, which reads the lane broker's own trace tree. Those traces cover local-engine runs only; there is no per-session trace endpoint for Claude API turns yet.",
  },
  "local-engine": {
    will:
      "Historical local-engine accounting — decode throughput, spill, and queue depth over time, alongside the API spend it displaced.",
    today:
      "Engine ▸ Live, which is the live view by design. Reports owns the past, so this tab waits on a stored history of engine metrics rather than mirroring a live panel.",
  },
};

/**
 * The one thing Reports still has to say about tool calls, or null when the
 * range is fully covered and no caveat is warranted.
 *
 * "none" and "partial" are genuinely different claims and must not share
 * wording: "none" means nothing is stored anywhere (missing data), "partial"
 * means the figure shown is a real but incomplete count (a floor).
 */
function coverageNoteText(coverage) {
  if (coverage?.state === "none") {
    return (
      "Tool calls have not been recorded yet — no tool events are stored for any session. " +
      "That is missing data, not a measurement of zero tool calls."
    );
  }
  if (coverage?.state === "partial") {
    return (
      `Tool calls have only been recorded since ${fmtSinceDate(coverage.since)}, and this range ` +
      "starts before that. Calls made in the earlier turns of this range were never stored, so " +
      "the figure is a floor rather than a total."
    );
  }
  return null;
}

/**
 * How the cost figures on this screen were arrived at — rendered only when some
 * of them were NOT priced at the time the work happened.
 *
 * Two clauses, because they are two different problems. Retroactive pricing
 * makes a figure an estimate: the rate that actually applied is not in the
 * database, so today's rate stands in for it. Unpriced events make the total an
 * UNDERSTATEMENT: they are $0 because no rate is known, not because the work was
 * free. That is the same null-versus-zero distinction this page enforces for
 * token totals and tool calls, and it is the trap this note exists to close.
 *
 * `basis` is the already-reduced costBasisSummary(); a null caller-side means
 * the window is wholly exact and nothing is rendered.
 */
/** Tone by PROPORTION, not by presence. When retroactive pricing covers the whole
 *  window the headline figure IS an estimate — that is a material qualification of
 *  the number, not a footnote on it, so it carries --cc-waiting weight. When it is
 *  a small slice, a muted note is honest and proportionate; shouting at every range
 *  teaches the reader to skip the warning that matters. */
function costBasisTone(basis) {
  if (!basis) return false;
  const affected = (basis.backfilled || 0) + (basis.unpriced || 0);
  const total = basis.total || 0;
  return total > 0 && affected >= total; // the entire window is qualified
}

function CostBasisNote({ basis, style }) {
  if (!basis) return null;
  const { backfilled, unpriced, total } = basis;
  const material = costBasisTone(basis);
  const toned = material
    ? {
        ...(style || NOTE),
        color: "var(--cc-waiting)",
        border: "1px solid color-mix(in srgb, var(--cc-waiting) 35%, transparent)",
        background: "color-mix(in srgb, var(--cc-waiting) 8%, transparent)",
        borderRadius: 9,
        padding: 10,
      }
    : style || NOTE;
  return (
    <div
      role="note"
      data-testid="cost-basis-note"
      data-material={material ? "true" : "false"}
      style={toned}
    >
      {backfilled > 0 ? (
        <>
          {proportionPhrase(backfilled, total)}{" "}
          {backfilled === 1 ? "API event" : "API events"} in this range{" "}
          {backfilled === 1 ? "was" : "were"} priced <strong>retroactively</strong>. The rate in
          force at the time is not recorded, so {backfilled === 1 ? "it is" : "they are"} costed at
          today&rsquo;s rates — a best available estimate, not the amount that would have been
          billed then.{" "}
        </>
      ) : null}
      {unpriced > 0 ? (
        <>
          {proportionPhrase(unpriced, total)} {unpriced === 1 ? "event has" : "events have"} no price
          on file for their model. Their tokens are counted but they contribute{" "}
          <strong>$0 because the price is unknown, not because the work was free</strong>, so the
          cost shown is understated by whatever they actually cost.
        </>
      ) : null}
    </div>
  );
}

// ── header primitives ─────────────────────────────────────

function TabButton({ tab, active, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(tab.id)}
      aria-label={`${tab.label} report`}
      aria-current={active ? "page" : undefined}
      className="transition-colors hover-bg-surface"
      style={{
        height: 43,
        padding: "0 10px",
        background: "none",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--cc-accent)" : "transparent"}`,
        color: active ? "var(--cc-fg)" : "var(--cc-muted)",
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: active ? 700 : 600,
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {tab.label}
    </button>
  );
}

function RangeControl({ range, onSelect }) {
  return (
    <div
      role="radiogroup"
      aria-label="Report range"
      style={{
        display: "inline-flex",
        overflow: "hidden",
        borderRadius: 8,
        background: "var(--cc-elev)",
        border: "1px solid var(--cc-border)",
        flexShrink: 0,
      }}
    >
      {RANGES.map((r) => {
        const active = r.id === range;
        return (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`Range: ${r.label}`}
            onClick={() => onSelect(r.id)}
            className="transition-colors hover-bg-surface"
            style={{
              height: 24,
              padding: "0 10px",
              border: "none",
              background: active ? "var(--cc-accent)" : "transparent",
              color: active ? ACCENT_FG : "var(--cc-dim)",
              fontFamily: "inherit",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Filter pill. A native select keeps the control real and keyboard-accessible;
 * the pill styling is the only thing borrowed from the mock.
 */
function FilterPill({ label, value, options, onChange }) {
  const active = Boolean(value);
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 24,
        padding: "0 4px 0 9px",
        borderRadius: 999,
        background: active ? "color-mix(in srgb, var(--cc-accent) 8%, transparent)" : "var(--cc-surface)",
        border: `1px solid ${active ? "color-mix(in srgb, var(--cc-accent) 35%, transparent)" : "var(--cc-border)"}`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: active ? "var(--cc-accent)" : "var(--cc-muted)",
        }}
      >
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Filter by ${label.toLowerCase()}`}
        style={{
          height: 20,
          maxWidth: 150,
          background: "none",
          border: "none",
          outline: "none",
          color: active ? "var(--cc-accent)" : "var(--cc-dim)",
          fontFamily: "inherit",
          fontSize: 10,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── panels ────────────────────────────────────────────────

function NotBuiltPanel({ tabId }) {
  const meta = NOT_BUILT[tabId];
  const label = REPORTS_TABS.find((t) => t.id === tabId)?.label || tabId;
  return (
    <div
      data-testid={`not-built-${tabId}`}
      style={{
        borderRadius: 12,
        border: "1px dashed var(--cc-border)",
        background: "color-mix(in srgb, var(--cc-surface) 40%, transparent)",
        padding: 18,
        maxWidth: 640,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
        {label} is not built yet
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", margin: 0 }}>{meta?.will}</p>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: "8px 0 0" }}>
        Today this lives in {meta?.today}
      </p>
    </div>
  );
}

function EmptyStatePanel({ range }) {
  return (
    <div
      data-testid="reports-empty"
      style={{
        borderRadius: 12,
        border: "1px dashed var(--cc-border)",
        background: "color-mix(in srgb, var(--cc-surface) 40%, transparent)",
        padding: 18,
        maxWidth: 620,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
        No usage recorded yet
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", margin: 0 }}>
        Cockpit has no usage rows for this range
        {range === "all" ? "" : " — try a wider range, or"}
        {range === "all" ? "." : " start a session."}{" "}
        Token and cost accounting begins the first time a session produces a turn.
      </p>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: "8px 0 0" }}>
        This is an absence of data, not a measurement of zero — nothing on this page is being
        rounded down to nothing.
      </p>
    </div>
  );
}

function ErrorPanel({ message, onRetry }) {
  return (
    <div
      role="alert"
      data-testid="reports-error"
      style={{
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--cc-error) 35%, transparent)",
        background: "color-mix(in srgb, var(--cc-error) 8%, transparent)",
        padding: 18,
        maxWidth: 620,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-error)", marginBottom: 8 }}>
        Could not load the usage report
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", margin: 0 }}>
        {message} Nothing is shown rather than an empty report, because an empty report would read
        as &ldquo;you used nothing&rdquo;.
      </p>
      <button
        type="button"
        onClick={onRetry}
        aria-label="Retry loading the usage report"
        className="hover-bg-elevated"
        style={{
          marginTop: 12,
          height: 26,
          padding: "0 12px",
          borderRadius: 8,
          background: "var(--cc-surface)",
          border: "1px solid var(--cc-border)",
          color: "var(--cc-fg)",
          fontFamily: "inherit",
          fontSize: 11,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );
}

/**
 * The Models tab: a fuller table of the same by_model rows the bar card uses.
 *
 * This is the one other tab that carries the cost-basis note, because its Cost
 * column is the same money the note qualifies. The remaining tabs do not repeat
 * it — restating a caveat everywhere is how it stops being read.
 */
function ModelsPanel({ byModel, basis }) {
  const rows = Array.isArray(byModel) ? byModel : [];
  const TH = {
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: ".08em",
    textTransform: "uppercase",
    color: "var(--cc-muted)",
    padding: "0 10px",
    height: 28,
    textAlign: "right",
    whiteSpace: "nowrap",
  };
  const TD = {
    fontSize: 11,
    color: "var(--cc-fg)",
    padding: "0 10px",
    height: 34,
    textAlign: "right",
    whiteSpace: "nowrap",
    borderTop: "1px solid var(--cc-line)",
  };
  return (
    <div style={{ ...CARD, padding: 0, overflow: "hidden" }} data-testid="models-table">
      <div
        style={{
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "var(--cc-dim)",
        }}
      >
        Models in this range
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: 16, fontSize: 11, color: "var(--cc-muted)" }}>
          No model activity in this range.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: "left" }}>Model</th>
              <th style={{ ...TH, textAlign: "left" }}>Provider</th>
              <th style={{ ...TH, textAlign: "left" }}>Scope</th>
              <th style={TH}>Tokens</th>
              <th style={TH}>Cost</th>
              <th style={TH}>Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r?.model || i} data-testid={`model-row-${r?.model || i}`}>
                <td style={{ ...TD, textAlign: "left", fontWeight: 600 }}>{r?.model || DASH}</td>
                <td style={{ ...TD, textAlign: "left", color: "var(--cc-dim)" }}>
                  {r?.provider || DASH}
                </td>
                <td
                  style={{
                    ...TD,
                    textAlign: "left",
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: ".08em",
                    textTransform: "uppercase",
                    color: r?.is_local ? "var(--cc-idle)" : "var(--cc-muted)",
                  }}
                >
                  {r?.is_local === true ? "local" : r?.is_local === false ? "remote" : DASH}
                </td>
                <td className="tabular-nums" style={TD}>
                  {fmtCount(r?.tokens, DASH)}
                </td>
                <td className="tabular-nums" style={TD}>
                  {fmtCost(r?.cost, DASH)}
                </td>
                <td className="tabular-nums" style={{ ...TD, color: "var(--cc-dim)" }}>
                  {fmtPct(r?.share, DASH)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div
        role="note"
        style={{
          padding: "9px 16px",
          borderTop: "1px solid var(--cc-line)",
          fontSize: 10,
          lineHeight: 1.5,
          color: "var(--cc-muted)",
        }}
      >
        Costs are API-equivalent, priced from pricing_models.json — not your subscription bill.
        Local tokens are costed at $0 and counted separately.
      </div>
      <CostBasisNote
        basis={basis}
        style={{
          padding: "9px 16px",
          borderTop: "1px solid var(--cc-line)",
          fontSize: 10,
          lineHeight: 1.5,
          color: "var(--cc-muted)",
        }}
      />
    </div>
  );
}

/** Said once, on every filtered view: what the pills do and do not reach. */
function FilterScopeNote() {
  return (
    <div
      role="note"
      data-testid="filter-scope-note"
      style={{
        borderRadius: 9,
        padding: "8px 10px",
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--cc-waiting)",
        background: "color-mix(in srgb, var(--cc-waiting) 8%, transparent)",
        border: "1px solid color-mix(in srgb, var(--cc-waiting) 35%, transparent)",
      }}
    >
      A filter is active. The sessions table, the spend bars, and the CSV export honour it. The KPI
      row, the per-day chart and the per-tool breakdown still cover the whole range — the report has
      no per-project or per-model breakdown of daily totals or of <code>by_tool</code> to filter them
      by, and re-deriving those figures from session totals would produce numbers the server never
      reported.
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function ReportsView({
  onOpenTrace,
  statusByTerminalId,
  initialRange = DEFAULT_RANGE,
  initialTab = "overview",
}) {
  const [range, setRange] = useState(initialRange);
  const [tab, setTab] = useState(initialTab);
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  // Fetched once per range (and per explicit Retry). Reports is historical:
  // there is nothing here worth polling for.
  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/usage/report?range=${encodeURIComponent(range)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          // A tracker failure answers 503 {"reachable": false}. That is "we
          // could not ask", which must never be presented like a successful
          // empty result on a fresh install ("nothing has happened yet").
          const detail = await res.json().catch(() => null);
          throw new Error(
            detail && detail.reachable === false
              ? "Cockpit could not reach the usage tracker, so this range could not be measured."
              : `The server returned ${res.status}.`
          );
        }
        const body = await res.json();
        if (!live) return;
        setData(body);
        setError(null);
      } catch (err) {
        if (!live || err?.name === "AbortError") return;
        setData(null);
        setError(err?.message ? `${err.message}` : "The request failed.");
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [range, reloadKey]);

  const selectRange = useCallback((next) => {
    setLoading(true);
    setRange(next);
  }, []);

  const retry = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  // Memoized so the identity is stable across renders — these feed the filter
  // and option memos below, which would otherwise recompute on every render.
  const sessions = useMemo(
    () => (Array.isArray(data?.sessions) ? data.sessions : []),
    [data]
  );
  const byModel = useMemo(() => (Array.isArray(data?.by_model) ? data.by_model : []), [data]);
  const byDay = useMemo(() => (Array.isArray(data?.by_day) ? data.by_day : []), [data]);
  const byTool = useMemo(() => (Array.isArray(data?.by_tool) ? data.by_tool : []), [data]);

  // The range the SERVER says it cut, not the button that was clicked — they
  // differ for the frame between selecting a range and its report arriving, and
  // the coverage boundary must be judged against the data in hand.
  const reportRange = data?.range || range;

  const coverage = useMemo(
    () =>
      toolCoverage({
        range: reportRange,
        generatedAt: data?.generated_at,
        byDay,
        toolEventsSince: data?.tool_events_since,
      }),
    [reportRange, data, byDay]
  );
  const coverageNote = coverageNoteText(coverage);

  const deltas = useMemo(
    () => buildDeltas(data?.kpis, data?.previous, reportRange),
    [data, reportRange]
  );

  // null when every event in the window was priced at ingest — see
  // costBasisSummary(). Also null when the field is absent or malformed, so an
  // older server simply renders the page as it did before.
  const costBasis = useMemo(() => costBasisSummary(data?.cost_basis), [data]);

  const projects = useMemo(() => filterOptions(sessions, "project"), [sessions]);
  const models = useMemo(() => filterOptions(sessions, "model"), [sessions]);

  // A filter value that no longer exists in the payload would silently hide
  // everything, so treat it as inactive.
  const activeProject = projects.includes(project) ? project : "";
  const activeModel = models.includes(model) ? model : "";
  const filtered = useMemo(
    () => applyFilters(sessions, { project: activeProject, model: activeModel }),
    [sessions, activeProject, activeModel]
  );
  const filteredModels = useMemo(
    () => (activeModel ? byModel.filter((r) => r?.model === activeModel) : byModel),
    [byModel, activeModel]
  );
  const filtersActive = Boolean(activeProject || activeModel);

  const exportCsv = useCallback(() => {
    const csv = buildSessionsCsv(filtered);
    const name = csvFilename(range, data?.generated_at);
    try {
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // A blocked download is not worth a crash; the button simply does nothing
      // visible, and the data is still on screen.
    }
  }, [filtered, range, data]);

  const isEmpty = !loading && !error && data && sessions.length === 0 && byModel.length === 0;
  const dataTabs =
    tab === "overview" || tab === "sessions" || tab === "models" || tab === "tools";

  let body;
  if (loading) {
    body = (
      <div data-testid="reports-loading" style={{ fontSize: 11, color: "var(--cc-muted)", padding: 4 }}>
        Loading usage report…
      </div>
    );
  } else if (error) {
    body = <ErrorPanel message={error} onRetry={retry} />;
  } else if (!dataTabs) {
    body = <NotBuiltPanel tabId={tab} />;
  } else if (isEmpty) {
    body = <EmptyStatePanel range={range} />;
  } else if (tab === "tools") {
    // by_tool is range-wide, not per session, so the project/model pills cannot
    // reach it — say so rather than letting an active pill imply it applied.
    body = (
      <>
        {filtersActive && <FilterScopeNote />}
        <ToolsBreakdown byTool={byTool} note={coverageNote} />
      </>
    );
  } else if (tab === "models") {
    body = (
      <>
        {filtersActive && <FilterScopeNote />}
        <ModelsPanel byModel={filteredModels} basis={costBasis} />
      </>
    );
  } else if (tab === "sessions") {
    body = (
      <>
        {filtersActive && <FilterScopeNote />}
        <SessionsTable
          rows={filtered}
          statusByTerminalId={statusByTerminalId}
          onOpenTrace={onOpenTrace}
          title="Every session in this range"
          showLocal
        />
      </>
    );
  } else {
    body = (
      <>
        <KpiRow kpis={data?.kpis} deltas={deltas} />
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {data?.previous?.available === true ? null : (
            <div role="note" data-testid="delta-note" style={NOTE}>
              No period-over-period change is shown:{" "}
              {reportRange === "all"
                ? "the range covers all recorded history, so there is no earlier window to compare it against."
                : "the report has no comparable previous window for this range yet — Cockpit needs history reaching back a further period before a change means anything."}{" "}
              A neutral zero would look like a finding.
            </div>
          )}
          {coverageNote ? (
            <div role="note" data-testid="tool-coverage-note" style={NOTE}>
              {coverageNote}
            </div>
          ) : null}
          <CostBasisNote basis={costBasis} />
          {tokensUnreported(data?.kpis, sessions) ? (
            <div role="note" data-testid="tokens-unreported-note" style={NOTE}>
              Turns were recorded in this range but the token totals came back as zero, so these
              tokens were <strong>not reported</strong> rather than not used. A streaming client has
              to send <code>stream_options.include_usage</code> for the usage block to arrive with
              the response; without it Cockpit sees the turn, counts no tokens for it, and the cost
              below is understated for the same reason.
            </div>
          ) : null}
        </div>
        {filtersActive && <FilterScopeNote />}
        <TokensByDayChart
          byDay={byDay}
          note="Every day in the range is drawn, including idle ones — a zero column means nothing ran that day, not that the day is missing."
        />
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 340px) minmax(0, 1fr)",
            gap: 16,
            minWidth: 0,
            alignItems: "start",
          }}
        >
          <SpendByModel byModel={filteredModels} />
          <SessionsTable
            rows={filtered}
            statusByTerminalId={statusByTerminalId}
            onOpenTrace={onOpenTrace}
            title="Sessions in this range"
          />
        </div>
      </>
    );
  }

  return (
    <div
      data-testid="reports-view"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--cc-bg)",
        overflow: "hidden",
      }}
    >
      {/* ---- 44px header: title · tabs · range · filters · export ---- */}
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderBottom: "1px solid var(--cc-border)",
          overflow: "hidden",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--cc-fg)", flexShrink: 0 }}>
          Reports
        </span>

        <div role="tablist" aria-label="Report views" style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
          {REPORTS_TABS.map((t) => (
            <TabButton key={t.id} tab={t} active={t.id === tab} onSelect={setTab} />
          ))}
        </div>

        <div style={{ flex: 1, minWidth: 0 }} />

        <RangeControl range={range} onSelect={selectRange} />
        <FilterPill label="Project" value={activeProject} options={projects} onChange={setProject} />
        <FilterPill label="Model" value={activeModel} options={models} onChange={setModel} />

        <button
          type="button"
          onClick={exportCsv}
          disabled={filtered.length === 0}
          aria-label="Export sessions as CSV"
          title={
            filtered.length === 0
              ? "Nothing to export — no sessions match the current range and filters"
              : "Download the sessions table as shown, with the active range and filters applied"
          }
          className="hover-bg-elevated"
          style={{
            flexShrink: 0,
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "0 10px",
            borderRadius: 8,
            background: "var(--cc-surface)",
            border: "1px solid var(--cc-border)",
            color: filtered.length === 0 ? "var(--cc-muted)" : "var(--cc-fg)",
            fontFamily: "inherit",
            fontSize: 10,
            fontWeight: 700,
            cursor: filtered.length === 0 ? "not-allowed" : "pointer",
            opacity: filtered.length === 0 ? 0.6 : 1,
          }}
        >
          <Download size={11} />
          Export CSV
        </button>
      </div>

      {/* ---- body ---- */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "18px 22px",
        }}
      >
        {body}

        {!loading && !error && data?.generated_at ? (
          <div style={{ fontSize: 9, color: "var(--cc-muted)", letterSpacing: ".06em" }}>
            Generated {data.generated_at} · range {data.range || range} · fetched once, not polled
          </div>
        ) : null}
      </div>
    </div>
  );
}
