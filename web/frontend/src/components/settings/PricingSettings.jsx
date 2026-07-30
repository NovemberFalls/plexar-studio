/* eslint-disable react-refresh/only-export-components -- rateCell, relativeStamp
   and sortModels are pure display helpers for this one page, exported only so the
   test suite can pin the null-vs-zero-vs-fallback rules directly. Same precedent
   as SettingsView.jsx's middleEllipsize; a separate module would scatter three
   small functions away from their single call site. */
/**
 * PricingSettings — the Settings ▸ Pricing table page.
 *
 * READ-ONLY apart from Refresh. There is no price-editing endpoint, so this page
 * renders no editable price fields. The Settings nav description ("an editable
 * per-model price table") is aspirational; the page says out loud where prices
 * actually come from (OpenRouter + the bundled pricing_models.json) rather than
 * dressing up read-only data as an editor.
 *
 * Data (fetched ONCE on mount and again only on an explicit Refresh click —
 * Settings is intent, and this data changes daily at most, so there is no poll):
 *   GET  /api/pricing         → { models, last_refresh, next_refresh, refresh_hours }
 *   POST /api/pricing/refresh → same shape, after refreshing from OpenRouter
 *
 * THREE HONESTY RULES this page exists to enforce:
 *
 * 1. Prices are append-only SNAPSHOTS. `effective_from` is the moment a price
 *    took effect; history is never re-priced. A new price applies only to turns
 *    after it, so changing pricing here does NOT change last month's report.
 *    That is surprising enough that the page teaches it in prose, prominently.
 *
 * 2. `null` per-Mtok means UNKNOWN, not free. `0` genuinely means free. They are
 *    opposite errors if conflated (a null shown as $0.00 understates cost; a
 *    genuine 0 shown as "unknown" overstates it), so they render as visibly
 *    different text — "unknown" in --cc-muted vs "free" in --cc-idle — and a
 *    null NEVER falls through to a numeric default.
 *
 * 3. `source: "default"` is a FALLBACK — a built-in guess, not a published
 *    figure. Those rows are flagged in --cc-waiting and listed in a callout,
 *    because they are the set whose costs are approximate.
 *
 * Failure is stated, never smoothed over: a failed initial fetch renders an
 * alert and NO table (an empty table reads as "no models are priced", which is a
 * different and false claim), and a failed refresh keeps the table that is
 * already on screen while surfacing the error.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { fmtCost, fmtSinceDate, isMissing, DASH } from "../reports/format.js";

// ── tokens / shared style fragments (mirrors ProvidersSettings) ──
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const WARN = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

const LABEL = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

const TH = {
  ...LABEL,
  textAlign: "left",
  padding: "0 10px 8px",
  borderBottom: "1px solid var(--cc-line)",
  whiteSpace: "nowrap",
};

const TD = {
  fontSize: 12,
  padding: "7px 10px",
  borderBottom: "1px solid var(--cc-line)",
  color: "var(--cc-fg)",
  whiteSpace: "nowrap",
};

/** How the four rate columns are read off a row, in display order. */
const RATE_COLUMNS = [
  { key: "input_per_mtok", label: "Input / Mtok" },
  { key: "output_per_mtok", label: "Output / Mtok" },
  { key: "cache_read_per_mtok", label: "Cache read / Mtok" },
  { key: "cache_write_per_mtok", label: "Cache write / Mtok" },
];

/**
 * Source vocabulary. `default` is the fallback tier and the only one tinted as a
 * warning — the other two are published figures.
 */
const SOURCE_META = {
  openrouter: { label: "openrouter", token: "var(--cc-fn)", title: "Fetched from OpenRouter's published prices" },
  pricing_models: {
    label: "bundled",
    token: "var(--cc-type)",
    title: "From pricing_models.json, the table shipped with Cockpit",
  },
  default: {
    label: "fallback",
    token: WARN,
    title: "No published price for this model — Cockpit is using a built-in approximation",
  },
};

/** `pricing_models.json` arrives with its extension; the key does not. */
function sourceMeta(source) {
  const key = typeof source === "string" ? source.replace(/\.json$/, "") : "";
  return (
    SOURCE_META[key] || {
      label: source || "unknown",
      token: "var(--cc-dim)",
      title: "Cockpit does not recognise this price source",
    }
  );
}

function isFallback(source) {
  return sourceMeta(source).token === WARN;
}

/** Provider families get distinct tints so real-money rows read apart from free ones. */
const PROVIDER_TOKENS = {
  anthropic: "var(--cc-macro)",
  openrouter: "var(--cc-fn)",
  local: "var(--cc-idle)",
  lmstudio: "var(--cc-idle)",
  vllm: "var(--cc-idle)",
  ollama: "var(--cc-idle)",
};

function providerToken(provider) {
  const key = typeof provider === "string" ? provider.toLowerCase() : "";
  return PROVIDER_TOKENS[key] || "var(--cc-dim)";
}

// ── primitives ────────────────────────────────────────────

function Badge({ children, token = "var(--cc-dim)", title, testId }) {
  return (
    <span
      data-testid={testId}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 18,
        padding: "0 7px",
        borderRadius: 7,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 30)}`,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/** Inline callout. `role="note"` — advisory, not an error. */
function Callout({ token = "var(--cc-accent)", icon: Icon = TriangleAlert, children, testId }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      <Icon size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

function ErrorBox({ children, testId }) {
  return (
    <div
      role="alert"
      data-testid={testId}
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--cc-error)",
        background: tint("var(--cc-error)", 8),
        border: `1px solid ${tint("var(--cc-error)", 35)}`,
      }}
    >
      <TriangleAlert size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

function RefreshButton({ busy, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label="Refresh pricing now"
      title="Re-fetch prices from OpenRouter now"
      data-testid="pricing-refresh"
      className="rounded transition-colors hover-bg-elevated"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 11px",
        borderRadius: 7,
        fontSize: 11,
        fontWeight: 700,
        background: busy ? "var(--cc-elev)" : "var(--cc-accent)",
        color: busy ? "var(--cc-muted)" : ACCENT_FG,
        border: `1px solid ${busy ? "var(--cc-border)" : "transparent"}`,
        cursor: busy ? "not-allowed" : "pointer",
        fontFamily: "inherit",
      }}
    >
      <RefreshCw size={12} aria-hidden="true" />
      {busy ? "Refreshing…" : "Refresh now"}
    </button>
  );
}

// ── formatting ────────────────────────────────────────────

/**
 * One rate cell. Returns the display text plus the token it renders in, so the
 * three states are distinguishable by BOTH text and colour:
 *
 *   null/undefined/NaN → "unknown"  (--cc-muted) — never "$0.00"
 *   0                  → "free"     (--cc-idle)  — a real, published zero
 *   > 0                → "$3.00"    (--cc-fg)    via Reports' fmtCost
 *
 * Sub-cent rates get four decimals: fmtCost's two would render a genuine
 * $0.0004/Mtok as "$0.00", which is the same lie as showing a null as zero.
 */
export function rateCell(value) {
  if (isMissing(value)) {
    return {
      text: "unknown",
      token: "var(--cc-muted)",
      title: "No price published for this field — unknown, which is not the same as free.",
    };
  }
  const v = Number(value);
  if (v === 0) {
    return {
      text: "free",
      token: "var(--cc-idle)",
      title: "Published as $0.00 per million tokens — genuinely free, not unknown.",
    };
  }
  const text = Math.abs(v) < 0.005 ? `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(4)}` : fmtCost(v);
  return { text, token: "var(--cc-fg)", title: `${v} US dollars per million tokens` };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "4 minutes ago" / "in 2 hours" — a coarse relative stamp for the refresh line.
 * Unparseable or absent → null, so callers say "never" rather than "Invalid Date".
 */
export function relativeStamp(iso, now = Date.now()) {
  const t = Date.parse(typeof iso === "string" ? iso : "");
  if (!Number.isFinite(t)) return null;
  const diff = t - now;
  const mag = Math.abs(diff);
  const future = diff > 0;
  let amount;
  if (mag < MINUTE) amount = "less than a minute";
  else if (mag < HOUR) {
    const n = Math.round(mag / MINUTE);
    amount = `${n} minute${n === 1 ? "" : "s"}`;
  } else if (mag < DAY) {
    const n = Math.round(mag / HOUR);
    amount = `${n} hour${n === 1 ? "" : "s"}`;
  } else {
    const n = Math.round(mag / DAY);
    amount = `${n} day${n === 1 ? "" : "s"}`;
  }
  return future ? `in ${amount}` : `${amount} ago`;
}

/** Sort by provider, then model — both case-insensitively, both stable. */
export function sortModels(models) {
  const rows = Array.isArray(models) ? models.slice() : [];
  rows.sort((a, b) => {
    const p = String(a?.provider || "").localeCompare(String(b?.provider || ""));
    if (p !== 0) return p;
    return String(a?.model || "").localeCompare(String(b?.model || ""));
  });
  return rows;
}

// ── rows ──────────────────────────────────────────────────

function ModelRow({ row }) {
  const model = row?.model || "unnamed model";
  const fallback = isFallback(row?.source);
  const source = sourceMeta(row?.source);
  const pToken = providerToken(row?.provider);
  return (
    <tr data-testid={`pricing-row-${model}`} data-fallback={fallback ? "true" : "false"}>
      <td style={{ ...TD, fontFamily: "var(--font-mono, monospace)", color: fallback ? WARN : "var(--cc-fg)" }}>
        {model}
      </td>
      <td style={TD}>
        <Badge token={pToken} title={`Priced as a ${row?.provider || "unknown"} model`}>
          {row?.provider || "unknown"}
        </Badge>
      </td>
      {RATE_COLUMNS.map((col) => {
        const cell = rateCell(row?.[col.key]);
        return (
          <td
            key={col.key}
            data-testid={`pricing-${model}-${col.key}`}
            title={cell.title}
            style={{ ...TD, color: cell.token, fontWeight: cell.token === "var(--cc-fg)" ? 600 : 700 }}
          >
            {cell.text}
          </td>
        );
      })}
      <td style={{ ...TD, color: "var(--cc-dim)" }}>
        {row?.effective_from ? fmtSinceDate(row.effective_from) : DASH}
      </td>
      <td style={TD}>
        <Badge token={source.token} title={source.title} testId={`pricing-source-${model}`}>
          {source.label}
        </Badge>
      </td>
    </tr>
  );
}

// ── page ──────────────────────────────────────────────────

export default function PricingSettings() {
  const [data, setData] = useState(null); // null until the first read resolves
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(null); // blocks the table
  const [refreshError, setRefreshError] = useState(null); // keeps the table
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/pricing");
      if (!res.ok) {
        setFetchError(
          `Cockpit's server could not return the pricing table (HTTP ${res.status}). ` +
            "Nothing is shown below rather than an empty table, which would wrongly read as “no models are priced”."
        );
        return;
      }
      setData(await res.json());
      setFetchError(null);
    } catch (err) {
      setFetchError(`Could not reach Cockpit's server: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch once. No interval: prices change daily at most, and Settings is intent.
  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const res = await fetch("/api/pricing/refresh", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        // Never fake success — a failed refresh leaves the previous table in place.
        setRefreshError(
          (body && body.error) ||
            `The refresh failed (HTTP ${res.status}). The prices below are the ones Cockpit already had.`
        );
        return;
      }
      setData(body);
      setFetchError(null);
    } catch (err) {
      setRefreshError(
        `The refresh could not reach OpenRouter or Cockpit's server: ${err.message}. ` +
          "The prices below are unchanged."
      );
    } finally {
      setRefreshing(false);
    }
  }, [refreshing]);

  const models = sortModels(data?.models);
  const fallbackRows = models.filter((r) => isFallback(r?.source));
  const refreshHours = data?.refresh_hours;
  const lastOpenRouter = relativeStamp(data?.last_refresh?.openrouter);
  const lastJson = relativeStamp(data?.last_refresh?.json);
  const next = relativeStamp(data?.next_refresh);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      {/* ── Where prices come from + Refresh ─────────── */}
      <div style={CARD} data-testid="card-pricing-refresh">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>Price source</span>
          <span style={{ marginLeft: "auto" }} />
          <RefreshButton busy={refreshing} onClick={refresh} />
        </div>

        <div
          data-testid="pricing-refresh-state"
          style={{ fontSize: 11, lineHeight: 1.7, color: "var(--cc-dim)", paddingTop: 8 }}
        >
          <div>
            <span style={{ color: "var(--cc-muted)" }}>last fetched from OpenRouter: </span>
            <span data-testid="pricing-last-openrouter">{lastOpenRouter || "never"}</span>
          </div>
          <div>
            <span style={{ color: "var(--cc-muted)" }}>bundled table last read: </span>
            <span data-testid="pricing-last-json">{lastJson || "never"}</span>
          </div>
          <div>
            <span style={{ color: "var(--cc-muted)" }}>next automatic refresh: </span>
            <span data-testid="pricing-next-refresh">{next || "not scheduled"}</span>
          </div>
        </div>

        <Callout token="var(--cc-accent)" icon={RefreshCw} testId="pricing-auto-note">
          Prices refresh automatically
          {typeof refreshHours === "number" ? ` every ${refreshHours} hours` : " on a schedule"} from
          OpenRouter, and fall back to the price table bundled with Cockpit. This page is read-only:
          prices come from OpenRouter and the bundled table, so there is nothing to edit here.
        </Callout>

        {refreshError && <ErrorBox testId="pricing-refresh-error">{refreshError}</ErrorBox>}
      </div>

      {/* ── The snapshot rule ─────────────────────────── */}
      <div style={CARD} data-testid="card-pricing-snapshot">
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 6 }}>
          How prices apply to your reports
        </div>
        <div role="note" data-testid="pricing-snapshot-note" style={{ fontSize: 11, lineHeight: 1.7, color: "var(--cc-dim)" }}>
          Every price is recorded together with the date it took effect. A turn is costed using the
          price that was in force at the time it ran, so <strong>past reports keep the prices that
          were in force when the work happened</strong>. Updating pricing does not rewrite history:
          a new price applies only to turns that run after its effective date. That means a price
          correction here will <strong>not</strong> change last month&rsquo;s figures — the old cost
          stays exactly as it was reported.
        </div>
      </div>

      {/* ── The table ─────────────────────────────────── */}
      <div style={CARD} data-testid="card-pricing-table">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>Per-model rates</span>
          <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
            US dollars per million tokens · sorted by provider, then model
          </span>
        </div>

        {fetchError ? (
          <ErrorBox testId="pricing-fetch-error">{fetchError}</ErrorBox>
        ) : loading ? (
          <div style={{ fontSize: 11, color: "var(--cc-muted)" }}>Reading the pricing table…</div>
        ) : models.length === 0 ? (
          <div data-testid="pricing-empty" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)" }}>
            Prices have not been fetched yet, so no model has a rate recorded. Use{" "}
            <strong>Refresh now</strong> above to fetch them from OpenRouter.
          </div>
        ) : (
          <div style={{ overflowX: "auto", minWidth: 0 }}>
            <table
              data-testid="pricing-table"
              style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}
            >
              <thead>
                <tr>
                  <th scope="col" style={TH}>Model</th>
                  <th scope="col" style={TH}>Provider</th>
                  {RATE_COLUMNS.map((col) => (
                    <th key={col.key} scope="col" style={{ ...TH, textAlign: "right" }}>
                      {col.label}
                    </th>
                  ))}
                  <th scope="col" style={TH}>Effective from</th>
                  <th scope="col" style={TH}>Source</th>
                </tr>
              </thead>
              <tbody>
                {models.map((row) => (
                  <ModelRow key={`${row?.provider || "?"}/${row?.model || "?"}`} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!fetchError && models.length > 0 && (
          <div role="note" data-testid="pricing-unknown-note" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", paddingTop: 10 }}>
            <strong>unknown</strong> means no price was published for that field — it is not the same
            as <strong>free</strong>, which is a published rate of $0.00. Cockpit never treats an
            unknown rate as zero when costing a turn.
          </div>
        )}

        {!fetchError && fallbackRows.length > 0 && (
          <Callout token={WARN} testId="pricing-fallback-note">
            {fallbackRows.length === 1 ? "One model is" : `${fallbackRows.length} models are`} priced
            from Cockpit&rsquo;s built-in fallback rather than a published rate, so
            {fallbackRows.length === 1 ? " its" : " their"} costs are approximate:{" "}
            <strong>{fallbackRows.map((r) => r.model).join(", ")}</strong>. Refreshing may replace
            {fallbackRows.length === 1 ? " it" : " them"} with a real figure.
          </Callout>
        )}
      </div>
    </div>
  );
}
