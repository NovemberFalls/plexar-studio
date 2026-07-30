/**
 * KpiRow — the six-card headline row of Reports ▸ Overview (spec §8, screen 1f).
 *
 * Total tokens · API-equivalent cost · Cache hit rate · Local share · Turns ·
 * Tool calls, straight off `kpis` in GET /api/usage/report.
 *
 * DELTAS: a card renders a delta ONLY when the caller supplies one. The report
 * now returns a `previous` block, so ReportsView builds the map with
 * buildDeltas() — but `previous.available` is false for `range=all` and for a
 * user with no prior window, and in that case nothing is passed and no card
 * renders a delta. An always-neutral "0%" would look measured; silence does not.
 * Tone is per metric (see DELTA_RULES): not every increase is green.
 */

import { DELTA_TOKEN, fmtCost, fmtCount, fmtPct, isMissing, NOT_REPORTED } from "./format.js";

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
          // The tone is exposed because it is a claim about the number, not
          // styling: "cost went up" must stay assertable without reading colour.
          data-tone={DELTA_TOKEN[delta.tone] ? delta.tone : "flat"}
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
      // tool_calls is a real integer now that the tracker reads message.content
      // as well as message.usage, so 0 means zero and is printed as "0". What
      // can still be partial is COVERAGE of a long range — ReportsView renders
      // that as a note from `tool_events_since`, not as a value substitution.
      id: "tool-calls",
      label: "Tool calls",
      raw: k.tool_calls,
      value: fmtCount(k.tool_calls),
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
