/**
 * KpiRow — the six-card headline row of Reports ▸ Overview (spec §8, screen 1f).
 *
 * Total tokens · API-equivalent cost · Cache hit rate · Local share · Turns ·
 * Tool calls, straight off `kpis` in GET /api/usage/report.
 *
 * DELTAS: a card renders a delta ONLY when the caller supplies one. The report
 * endpoint takes a single `range` and exposes no prior-period or offset
 * parameter, so Cockpit cannot fetch a comparable previous window — and a
 * calendar-day slice of a longer range would not line up with an hour-based
 * window like 24h. Rather than render an always-neutral "0%" that looks
 * measured, ReportsView passes no deltas at all and says why in a note. The
 * delta slot stays implemented so it lights up the day a comparator lands.
 */

import { fmtCost, fmtCount, fmtPct, isMissing, NOT_REPORTED } from "./format.js";

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
  minWidth: 0,
};

const LABEL = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

/** Delta tone → token. `good` improves, `cost` is spend going up, `flat` neutral. */
const DELTA_TOKEN = {
  good: "var(--cc-ok)",
  cost: "var(--cc-waiting)",
  flat: "var(--cc-dim)",
};

function KpiCard({ id, label, value, missing, hint, delta }) {
  return (
    <div style={CARD} data-testid={`kpi-${id}`} data-missing={missing ? "true" : "false"}>
      <div style={LABEL}>{label}</div>
      <div
        className="tabular-nums"
        style={{
          fontSize: 21,
          fontWeight: 700,
          marginTop: 6,
          lineHeight: 1.2,
          color: missing ? "var(--cc-muted)" : "var(--cc-fg)",
          wordBreak: "break-word",
        }}
      >
        {value}
      </div>
      {delta ? (
        <div
          data-testid={`kpi-delta-${id}`}
          style={{ fontSize: 10, marginTop: 4, color: DELTA_TOKEN[delta.tone] || DELTA_TOKEN.flat }}
        >
          {delta.text}
        </div>
      ) : null}
      {hint ? (
        <div style={{ fontSize: 10, marginTop: 4, color: "var(--cc-muted)", lineHeight: 1.45 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export default function KpiRow({ kpis, deltas }) {
  const k = kpis && typeof kpis === "object" ? kpis : {};
  const d = deltas && typeof deltas === "object" ? deltas : {};

  const cards = [
    {
      id: "total-tokens",
      label: "Total tokens",
      raw: k.total_tokens,
      value: fmtCount(k.total_tokens),
    },
    {
      id: "cost",
      label: "API-equiv cost",
      raw: k.cost,
      value: fmtCost(k.cost),
      hint: "not your subscription bill",
    },
    {
      id: "cache-hit-rate",
      label: "Cache hit rate",
      raw: k.cache_hit_rate,
      value: fmtPct(k.cache_hit_rate),
    },
    {
      id: "local-share",
      label: "Local share",
      raw: k.local_share,
      value: fmtPct(k.local_share),
      hint: "tokens served by a local engine",
    },
    { id: "turns", label: "Turns", raw: k.turns, value: fmtCount(k.turns) },
    {
      // tool_calls is ALWAYS null today: the usage store keeps assistant turns
      // that carry a `usage` block and persists no tool_use events at all, so a
      // number here would be invented. The card stays — the spec asked for six,
      // and the sixth honestly having no source is the correct thing to show.
      // Swapping in a different metric to fill the row would hide that.
      id: "tool-calls",
      label: "Tool calls",
      raw: k.tool_calls,
      value: fmtCount(k.tool_calls, "not recorded"),
      hint: isMissing(k.tool_calls) ? "no source yet — see note below" : undefined,
    },
  ];

  return (
    <div
      data-testid="kpi-row"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
        gap: 10,
        minWidth: 0,
      }}
    >
      {cards.map((c) => (
        <KpiCard
          key={c.id}
          id={c.id}
          label={c.label}
          value={c.value}
          missing={c.value === NOT_REPORTED || isMissing(c.raw)}
          hint={c.hint}
          delta={d[c.id]}
        />
      ))}
    </div>
  );
}
