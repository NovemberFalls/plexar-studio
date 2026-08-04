/**
 * reports/format.js — formatters and pure data helpers for the Reports section.
 *
 * REPORTING HONESTY (the rule this file exists to enforce):
 * every field in GET /api/usage/report may be `null`, meaning "not sourceable
 * from the data". A null must NEVER render as 0. A fabricated zero is a lie
 * about the user's spend, so the formatters below return "not reported" (KPIs,
 * where there is room to say it) or an em dash (table/bar cells, where there is
 * not) and never fall through to a numeric default. Reports is now the sole
 * owner of this rule — the LocalMetricsPanel / PerModelAgent treatments it was
 * originally mirrored from have both been deleted.
 *
 * `tool_calls` is NO LONGER one of those fields: the usage tracker now reads
 * `message.content` alongside `message.usage`, so both `kpis.tool_calls` and
 * `sessions[].tool_calls` are real integers and a 0 genuinely means zero. The
 * honesty question moved to COVERAGE — tool events only started being stored
 * recently, so a long range can span turns that predate the recording. That is
 * what `tool_events_since` and `toolCoverage()` below are for.
 */

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

/**
 * Reports' range ids -> Plexar's. Only "all" differs ("lifetime" there).
 *
 * Lives here rather than in the panel because a file that exports both a
 * component and a helper breaks fast refresh.
 */
export function toPlexarRange(range) {
  return range === "all" ? "lifetime" : range;
}

/** null / undefined / NaN / Infinity all mean "no value", never zero. */
export function isMissing(v) {
  if (v === null || v === undefined) return true;
  return typeof v === "number" && !Number.isFinite(v);
}

/** A number we can arithmetic on, or null. Never coerces a missing value to 0. */
export function num(v) {
  return isMissing(v) ? null : Number(v);
}

/**
 * Integer with thousands separators. Moved here verbatim from the deleted
 * localReporting/format.js (the Routing & Reporting view it served is gone);
 * `fmtCount` is its only caller, and the behavior — including the em-dash
 * return for a non-finite input — is unchanged.
 *
 * NOT shared with engine/ui.jsx's same-named helper, which deliberately
 * differs: that one renders `String(Math.round(n))` with no separators for
 * tight live-telemetry stats. Two names, two jobs, no accidental unification.
 */
export function fmtInt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toLocaleString();
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
  // A nonzero share that rounds to 0.0% is a FABRICATED ZERO -- the one thing
  // this file exists to forbid. Reports ▸ Tools showed six real tools, each
  // with calls that demonstrably happened, all reading "0.0%". Say the figure
  // is below the resolution shown; do not say it is nothing. A TRUE zero still
  // renders 0.0%, because that is a measurement.
  if (scaled !== 0 && Math.abs(scaled) < 0.05) return scaled > 0 ? "<0.1%" : ">-0.1%";
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Jul 30" — a short day label for the chart's x axis. */
export function dayLabel(iso) {
  const s = typeof iso === "string" ? iso : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s || DASH;
  const monthIdx = Number(m[2]) - 1;
  const month = MONTHS[monthIdx] || m[2];
  return `${month} ${Number(m[3])}`;
}

/** "Jul 29, 2026" — a dated label for prose, read straight off the ISO string. */
export function fmtSinceDate(iso) {
  const s = typeof iso === "string" ? iso : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s || DASH;
  const month = MONTHS[Number(m[2]) - 1] || m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

// ── tool-call coverage ────────────────────────────────────

/** Window length of each bounded range, in ms. `all` is deliberately absent. */
const RANGE_MS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * When the selected range begins, in epoch ms, or null for "unbounded".
 *
 * Bounded ranges are measured back from the server's own `generated_at`, which
 * is the clock the range was cut with — using the browser's clock here would
 * drift the boundary. `all` has no length, so it falls back to the earliest day
 * the server actually reported (`by_day` is gap-filled, so that IS the start of
 * the data); with no days at all the range is unbounded and returns null.
 */
export function rangeStartMs(range, generatedAt, byDay) {
  const span = RANGE_MS[range];
  const now = Date.parse(typeof generatedAt === "string" ? generatedAt : "");
  if (span && Number.isFinite(now)) return now - span;
  let earliest = null;
  for (const d of Array.isArray(byDay) ? byDay : []) {
    const t = Date.parse(`${String(d?.day || "")}T00:00:00Z`);
    if (Number.isFinite(t) && (earliest === null || t < earliest)) earliest = t;
  }
  return earliest;
}

/**
 * How much of the selected range tool calls are actually recorded for.
 *
 * `tool_events_since` is the earliest tool event in the WHOLE store — it is not
 * range-scoped — so the comparison is against where the selected range starts:
 *
 *   - "none"    no tool events stored anywhere. Different from zero tool calls.
 *   - "partial" the range starts BEFORE recording began, so turns at the start
 *               of the range contributed calls that were never stored. The
 *               number shown is a floor.
 *   - "full"    the range starts at or after recording began: complete coverage,
 *               so no note is warranted and none is shown.
 *
 * An unbounded range (`all`, or an unparseable stamp) always resolves "partial"
 * when any `since` exists — it reaches back past the first stored event by
 * definition. Erring toward "partial" is the safe direction: the failure to
 * avoid is presenting an undercount as a total.
 */
export function toolCoverage({ range, generatedAt, byDay, toolEventsSince } = {}) {
  if (typeof toolEventsSince !== "string" || toolEventsSince.length === 0) {
    return { state: "none", since: null };
  }
  const since = Date.parse(toolEventsSince);
  if (!Number.isFinite(since)) return { state: "none", since: null };
  const start = rangeStartMs(range, generatedAt, byDay);
  if (start === null || since > start) return { state: "partial", since: toolEventsSince };
  return { state: "full", since: toolEventsSince };
}

// ── token honesty ─────────────────────────────────────────

/**
 * True when work demonstrably happened but tokens came back as zero.
 *
 * This is the CONTRADICTORY state, and it is the only one worth a hint: a
 * streaming client that omits `stream_options.include_usage` produces turns with
 * no usage block, so Cockpit records the turn and counts zero tokens for it. A
 * zero shown without that explanation reads as "a quiet range".
 *
 * Deliberately false when turns are zero too — that IS a quiet range, and a
 * configuration warning there would be a false alarm, which is worse than
 * silence. Also false when total_tokens is null: a null already renders as "not
 * reported" and needs no second explanation.
 */
export function tokensUnreported(kpis, sessions) {
  const tokens = num(kpis?.total_tokens);
  if (tokens === null || tokens !== 0) return false;
  const turns = num(kpis?.turns);
  const rows = Array.isArray(sessions) ? sessions.length : 0;
  return (turns !== null && turns > 0) || rows > 0;
}

// ── cost basis ────────────────────────────────────────────

/**
 * Reduce `cost_basis` to the case that needs saying, or null for silence.
 *
 * `exact` rows were priced at ingest with the rate in force at that moment and
 * are frozen. `backfilled` rows were priced after the fact, so they carry
 * TODAY's rates rather than the rates that actually applied — an approximation,
 * not a historical fact. `unpriced` rows have no rate on file and contribute $0
 * with their tokens retained, which is an unknown price rather than free work.
 *
 * Returns null when the window is entirely `exact`, when the counts are all
 * zero, and when the field is absent or malformed. A wholly-exact window has
 * nothing to qualify, and a disclaimer that never goes away is a disclaimer
 * users learn to skip — which would waste it for the ranges that need it. As
 * new turns are priced at ingest this note retires itself.
 */
export function costBasisSummary(basis) {
  if (!basis || typeof basis !== "object") return null;
  const exact = num(basis.exact);
  const backfilled = num(basis.backfilled);
  const unpriced = num(basis.unpriced);
  if (exact === null && backfilled === null && unpriced === null) return null;
  const e = Math.max(0, exact || 0);
  const b = Math.max(0, backfilled || 0);
  const u = Math.max(0, unpriced || 0);
  if (b === 0 && u === 0) return null;
  return { exact: e, backfilled: b, unpriced: u, total: e + b + u };
}

/**
 * "all 29,033" vs "29 of 4,000" — proportion, not a bare count.
 *
 * The difference matters more than the number: a handful of approximated events
 * in a large window is a footnote, whereas a whole history priced retroactively
 * changes what the headline figure means.
 */
export function proportionPhrase(count, total) {
  const c = num(count);
  const t = num(total);
  if (c === null) return DASH;
  if (t !== null && t > 0 && c >= t) return `all ${fmtCount(c)}`;
  if (t === null || t <= 0) return fmtCount(c);
  return `${fmtCount(c)} of ${fmtCount(t)}`;
}

// ── period-over-period deltas ─────────────────────────────

/**
 * Delta tone → theme token. `good` is an improvement, `cost` is a spend signal
 * worth noticing, `flat` is neutral. Lives here rather than in KpiRow so the
 * mapping is assertable without importing a component.
 */
export const DELTA_TOKEN = {
  good: "var(--cc-ok)",
  cost: "var(--cc-waiting)",
  flat: "var(--cc-dim)",
};

/**
 * Per-KPI comparison rules, keyed by KpiRow card id.
 *
 * `mode` decides the arithmetic: `count`/`cost` compare as a percentage of the
 * previous value, `points` (rates) compare as a difference in percentage points
 * — a rate's "percent change" is a confusing second derivative, and it also
 * removes a division.
 *
 * `up`/`down` decide the TONE, and they are deliberately not all "up is green":
 *   - total tokens, turns, tool calls: flat both ways. Doing more work is not a
 *     result; colouring it green would congratulate the user for spending.
 *   - cost: up warns (--cc-waiting), down is good. This is the one figure where
 *     an increase is something to notice.
 *   - cache hit rate: up is good, down warns — a cache miss is a token the user
 *     pays full price for, so a falling hit rate is a spend signal.
 *   - local share: up is good (it displaced API spend), down flat. A drop is
 *     usually just a deliberate model choice, not a regression to flag.
 */
export const DELTA_RULES = {
  "total-tokens": { key: "total_tokens", mode: "count", up: "flat", down: "flat" },
  cost: { key: "cost", mode: "cost", up: "cost", down: "good" },
  "cache-hit-rate": { key: "cache_hit_rate", mode: "points", up: "good", down: "cost" },
  "local-share": { key: "local_share", mode: "points", up: "good", down: "flat" },
  turns: { key: "turns", mode: "count", up: "flat", down: "flat" },
  "tool-calls": { key: "tool_calls", mode: "count", up: "flat", down: "flat" },
};

/** A rate as percentage points, using the same fraction-or-percent reading as fmtPct. */
function pctPoints(v) {
  const n = num(v);
  if (n === null) return null;
  return n > 1 ? n : n * 100;
}

const SIGN = (n) => (n > 0 ? "+" : "-");

/**
 * Build the KpiRow `deltas` map from `previous`.
 *
 * Returns `{}` — meaning no card renders a delta — when `previous.available` is
 * false. That covers `range=all` (nothing precedes everything) and a brand-new
 * user with no prior window, and it is why the slot is driven by data rather
 * than by a hardcoded note.
 *
 * A previous value of 0 never divides: the change is stated in absolute terms
 * with the prior figure spelled out, because "+∞%" and "NaN%" are worse than
 * verbose.
 */
export function buildDeltas(kpis, previous, range) {
  if (!previous || previous.available !== true) return {};
  const prev = previous.kpis && typeof previous.kpis === "object" ? previous.kpis : null;
  if (!prev) return {};
  const cur = kpis && typeof kpis === "object" ? kpis : {};
  const label = `previous ${RANGES.find((r) => r.id === range)?.label || range || "period"}`;

  const out = {};
  for (const [id, rule] of Object.entries(DELTA_RULES)) {
    const isPoints = rule.mode === "points";
    const now = isPoints ? pctPoints(cur[rule.key]) : num(cur[rule.key]);
    const was = isPoints ? pctPoints(prev[rule.key]) : num(prev[rule.key]);
    if (now === null || was === null) continue; // nothing comparable: no delta

    const diff = now - was;
    if (diff === 0) {
      out[id] = { tone: "flat", text: `no change vs ${label}` };
      continue;
    }
    const tone = diff > 0 ? rule.up : rule.down;
    const sign = SIGN(diff);
    const mag = Math.abs(diff);

    let text;
    if (isPoints) {
      text = `${sign}${mag.toFixed(1)} pts vs ${label}`;
    } else if (was === 0) {
      // No denominator. State the absolute move and name the prior zero.
      const amount = rule.mode === "cost" ? fmtCost(mag, DASH) : fmtCount(mag, DASH);
      text = `${sign}${amount} vs ${label} (was ${rule.mode === "cost" ? "$0.00" : "0"})`;
    } else {
      text = `${sign}${Math.abs((diff / was) * 100).toFixed(1)}% vs ${label}`;
    }
    out[id] = { tone, text };
  }
  return out;
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

/**
 * A refusal is not a crash.
 *
 * `detail` is contracted to be prose (`plexar_client.unavailable(detail: str)`)
 * and it was NOT: Plexar's refusals are OpenAI-shaped, so the field arrived as
 * `{message, type, param, code}`. React will not render an object, so putting
 * this straight into a `<p>` threw and blanked the whole tab -- the crash Len
 * hit on 1.29.0. The server now sends prose, and this is the second lock:
 * a provider changing its error shape must be able to make a message worse,
 * never to take the tab away.
 *
 * A dropped detail would be worse than a wrong one -- an empty reason reads as
 * "nothing was wrong" -- so an unparseable shape is stringified, not discarded.
 */
export function detailProse(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") return raw || null;
  if (typeof raw === "object") {
    for (const key of ["message", "detail", "error", "reason"]) {
      if (typeof raw[key] === "string" && raw[key]) return raw[key];
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}
