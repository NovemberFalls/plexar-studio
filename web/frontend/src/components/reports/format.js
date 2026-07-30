/**
 * reports/format.js — formatters and pure data helpers for the Reports section.
 *
 * REPORTING HONESTY (the rule this file exists to enforce):
 * every field in GET /api/usage/report may be `null`, meaning "not sourceable
 * from the data" — `tool_calls` in particular routinely is. A null must NEVER
 * render as 0. A fabricated zero is a lie about the user's spend, so the
 * formatters below return "not reported" (KPIs, where there is room to say it)
 * or an em dash (table/bar cells, where there is not) and never fall through to
 * a numeric default. This mirrors LocalMetricsPanel's existing treatment and
 * localReporting/PerModelAgent.jsx's fmtTokensReport/fmtCostReport.
 *
 * Integer formatting is delegated to localReporting/format.js so Reports and
 * the Engine reporting panels render the same number the same way.
 */

import { fmtInt } from "../localReporting/format.js";

export const NOT_REPORTED = "not reported";
export const DASH = "—";

/** The range values GET /api/usage/report accepts, in display order. */
export const RANGES = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "all", label: "All" },
];

export const DEFAULT_RANGE = "7d";

/** The Reports tab strip, in display order. Ids are the routing values. */
export const REPORTS_TABS = [
  { id: "overview", label: "Overview" },
  { id: "sessions", label: "Sessions" },
  { id: "models", label: "Models" },
  { id: "tools", label: "Tools" },
  { id: "traces", label: "Traces" },
  { id: "local-engine", label: "Local engine" },
];

/**
 * The stacked-column series for "Tokens per day, by class". Keys are the
 * by_day field names; colors are the spec's assigned tokens (never hexes).
 */
export const DAY_SERIES = [
  { key: "input", label: "input", color: "var(--cc-working)" },
  { key: "output", label: "output", color: "var(--cc-fn)" },
  { key: "cache_read", label: "cache read", color: "var(--cc-type)" },
  { key: "cache_write", label: "cache write", color: "var(--cc-macro)" },
  { key: "local", label: "local", color: "var(--cc-idle)" },
];

/** null / undefined / NaN / Infinity all mean "no value", never zero. */
export function isMissing(v) {
  if (v === null || v === undefined) return true;
  return typeof v === "number" && !Number.isFinite(v);
}

/** A number we can arithmetic on, or null. Never coerces a missing value to 0. */
export function num(v) {
  return isMissing(v) ? null : Number(v);
}

/** Missing-safe integer with thousands separators. */
export function fmtCount(n, missing = NOT_REPORTED) {
  return isMissing(n) ? missing : fmtInt(Number(n));
}

/** Cost, always two decimals per the spec. Missing is not $0.00. */
export function fmtCost(n, missing = NOT_REPORTED) {
  if (isMissing(n)) return missing;
  const v = Number(n);
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

/**
 * Percentage to one decimal. The contract writes rates as `0.0`, which is
 * ambiguous between a fraction and an already-scaled percent, so values in
 * 0..1 are read as fractions and anything above 1 is taken as already being a
 * percent. Either way we never invent a number for a null.
 */
export function fmtPct(n, missing = NOT_REPORTED) {
  if (isMissing(n)) return missing;
  const v = Number(n);
  const scaled = v > 1 ? v : v * 100;
  return `${scaled.toFixed(1)}%`;
}

/** 0..1 fraction for bar widths, from the same ambiguous share encoding. */
export function shareFraction(n) {
  if (isMissing(n)) return 0;
  const v = Number(n);
  const f = v > 1 ? v / 100 : v;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

/** "Jul 30" — a short day label for the chart's x axis. */
export function dayLabel(iso) {
  const s = typeof iso === "string" ? iso : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s || DASH;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const monthIdx = Number(m[2]) - 1;
  const month = MONTHS[monthIdx] || m[2];
  return `${month} ${Number(m[3])}`;
}

/**
 * Sum one column of session rows.
 *
 * Returns `{ value, missing, counted }`: `value` is null when EVERY row is
 * missing that field (so the footer shows an em dash rather than 0), otherwise
 * the sum of the rows that do report it. `missing` counts the rows excluded so
 * the footer can say the total is partial instead of silently understating it.
 */
export function sumColumn(rows, key) {
  const list = Array.isArray(rows) ? rows : [];
  let total = 0;
  let counted = 0;
  let missing = 0;
  for (const r of list) {
    const v = num(r?.[key]);
    if (v === null) missing += 1;
    else {
      total += v;
      counted += 1;
    }
  }
  return { value: counted === 0 ? null : total, missing, counted };
}

/**
 * A display label for a session row. `sessions[].name` is null for any session
 * that is no longer live — the usage DB has no name column — so fall back to
 * the terminal id, then the project, rather than leaving a blank gap.
 */
export function sessionLabel(row) {
  return row?.name || row?.terminal_id || row?.project || "unnamed session";
}

/** Total tokens for one by_day row, preferring the server's own `total`. */
export function dayTotal(day) {
  const given = num(day?.total);
  if (given !== null) return given;
  let sum = 0;
  let any = false;
  for (const s of DAY_SERIES) {
    const v = num(day?.[s.key]);
    if (v !== null) {
      sum += v;
      any = true;
    }
  }
  return any ? sum : null;
}

/** Distinct non-empty values of `key` across rows, sorted, for the filter pills. */
export function filterOptions(rows, key) {
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = r?.[key];
    if (typeof v === "string" && v.length > 0) seen.add(v);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

/** Apply the active project/model filter pills to the session rows. */
export function applyFilters(rows, { project, model } = {}) {
  let out = Array.isArray(rows) ? rows : [];
  if (project) out = out.filter((r) => r?.project === project);
  if (model) out = out.filter((r) => r?.model === model);
  return out;
}

// ── CSV export ────────────────────────────────────────────

/** Columns of the sessions table, in display order. Header row of the CSV. */
export const CSV_COLUMNS = [
  ["session", (r) => r?.name || r?.terminal_id || ""],
  ["project", (r) => r?.project || ""],
  ["model", (r) => r?.model || ""],
  ["input", (r) => r?.input],
  ["output", (r) => r?.output],
  ["cache_read", (r) => r?.cache_read],
  ["cache_write", (r) => r?.cache_write],
  ["total", (r) => r?.total],
  ["turns", (r) => r?.turns],
  ["cost_usd", (r) => r?.cost],
  ["tool_calls", (r) => r?.tool_calls],
];

/** RFC4180-ish escaping: quote when the value contains a comma, quote or newline. */
function csvCell(value) {
  if (isMissing(value)) return ""; // an empty cell, NOT a zero
  const s = String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build the sessions CSV exactly as the table is displayed — the caller passes
 * the already-filtered rows, so the export honours the active range and the
 * project/model pills. Missing values are empty cells, never 0.
 */
export function buildSessionsCsv(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const lines = [CSV_COLUMNS.map(([name]) => name).join(",")];
  for (const r of list) {
    lines.push(CSV_COLUMNS.map(([, read]) => csvCell(read(r))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** `cockpit-usage-7d-2026-07-30.csv` */
export function csvFilename(range, generatedAt) {
  const iso = typeof generatedAt === "string" ? generatedAt.slice(0, 10) : "";
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : new Date().toISOString().slice(0, 10);
  return `cockpit-usage-${range || "all"}-${stamp}.csv`;
}
