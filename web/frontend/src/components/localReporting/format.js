/**
 * localReporting/format.js — shared formatters + small numeric helpers for the
 * Routing & Reporting view. `fmtInt`..`queueDepth` are lifted verbatim (same
 * behavior) from LocalMetricsPanel.jsx per the design handoff so both panels
 * render numbers identically. `pct`, `normalize`, and `seriesColor` are new,
 * spec'd by the handoff's "Design Tokens" section.
 */

export function fmtInt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toLocaleString();
}

export function fmtTokens(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function fmtMs(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  return Math.round(n) + "ms";
}

export function fmtNum(n, digits = 1) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function fmtUsd(n) {
  if (typeof n !== "number" || !isFinite(n)) return "$0.00";
  if (n >= 1000) return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}

export function fmtEta(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) return "clear";
  if (seconds >= 60) return `~${Math.round(seconds / 60)}m to clear`;
  return `~${Math.round(seconds)}s to clear`;
}

export const rowTokens = (r) => {
  const t = r?.tokens_total || {};
  return (t.prompt || 0) + (t.completion || 0);
};

/** Live queue depth = in-flight (0/1) + queued length (pinned broker fields). */
export function queueDepth(q) {
  if (!q || q.reachable === false) return 0;
  return (q.in_flight ? 1 : 0) + (Array.isArray(q.queued) ? q.queued.length : 0);
}

/**
 * Percentile of a numeric array (0..100, linear-interpolated, nearest-rank
 * fallback for small arrays). Non-finite/nullish entries are filtered out
 * first. Returns null for an empty/absent input — never 0, so callers can
 * distinguish "no data" from "the value is zero".
 */
export function pct(values, p) {
  const clean = (Array.isArray(values) ? values : [])
    .filter((v) => typeof v === "number" && isFinite(v))
    .sort((a, b) => a - b);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0];
  const rank = (p / 100) * (clean.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return clean[lo];
  const frac = rank - lo;
  return clean[lo] + (clean[hi] - clean[lo]) * frac;
}

/** Normalize v into 0..1 against max, guarding max<=0 (avoid NaN/Infinity). */
export function normalize(v, max) {
  if (typeof v !== "number" || !isFinite(v) || !max || max <= 0) return 0;
  const n = v / max;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

// Reserved roles per the handoff's Design Tokens table — checked before the
// cycling fallback so "spill" and "api" are always the same color regardless
// of ordering.
const RESERVED_SERIES_COLORS = {
  spill: "var(--cc-waiting)",
  spilled: "var(--cc-waiting)",
  api: "var(--cc-macro)",
  anthropic: "var(--cc-macro)",
  "anthropic-api": "var(--cc-macro)",
};

// Cycle for local backends beyond the first two (accent, type are assigned
// by position for the primary/secondary local backend).
const SERIES_CYCLE = [
  "var(--cc-accent)",
  "var(--cc-type)",
  "var(--cc-thinking)",
  "var(--cc-fn)",
  "var(--cc-num)",
];

/**
 * Series color for a chart/legend entry. `key` is checked against the
 * reserved role names first (spill, api); otherwise the color cycles by
 * `index` starting with accent (primary local backend), then --cc-type
 * (second local backend), then --cc-thinking/--cc-fn/--cc-num. Always
 * returns a var(--cc-*) token string — never a hex.
 */
export function seriesColor(key, index = 0) {
  const k = String(key || "").trim().toLowerCase();
  if (RESERVED_SERIES_COLORS[k]) return RESERVED_SERIES_COLORS[k];
  const i = typeof index === "number" && isFinite(index) && index >= 0 ? index : 0;
  return SERIES_CYCLE[i % SERIES_CYCLE.length];
}
