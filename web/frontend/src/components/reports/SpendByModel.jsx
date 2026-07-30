/**
 * SpendByModel — "Where the spend goes" (spec §8, card 3). One labelled bar per
 * `by_model` row, with its cost and its share of the range.
 *
 * The caption is a SPEC REQUIREMENT, not decoration: without it a user reads
 * this card as an invoice. It must state that the figures are API-equivalent
 * from pricing_models.json rather than the subscription bill, and that local
 * tokens are costed at $0 and counted separately.
 */

import { fmtCost, fmtCount, fmtPct } from "./format.js";

const CARD = {
  height: 300,
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  minWidth: 0,
};

export const SPEND_CAPTION =
  "Costs are API-equivalent — token counts priced with pricing_models.json, not your " +
  "subscription bill. Local tokens are costed at $0 and counted separately, so a local-heavy " +
  "range shows a small figure here without having been cheap to run.";

function ModelBar({ row, maxCost }) {
  const cost = typeof row?.cost === "number" && Number.isFinite(row.cost) ? row.cost : null;
  const width = maxCost > 0 && cost !== null ? Math.max(1, (cost / maxCost) * 100) : 0;
  const isLocal = row?.is_local === true;
  const token = isLocal ? "var(--cc-idle)" : "var(--cc-accent)";
  const name = row?.model || "unknown model";

  return (
    <div data-testid={`spend-row-${name}`} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--cc-fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            minWidth: 0,
          }}
          title={row?.provider ? `${name} · ${row.provider}` : name}
        >
          {name}
        </span>
        {isLocal ? (
          <span
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: "var(--cc-idle)",
              flexShrink: 0,
            }}
          >
            local
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        <span
          className="tabular-nums"
          style={{ fontSize: 11, fontWeight: 700, color: "var(--cc-fg)", flexShrink: 0 }}
        >
          {isLocal && cost === 0 ? "$0.00" : fmtCost(cost, "—")}
        </span>
        <span
          className="tabular-nums"
          style={{ fontSize: 10, color: "var(--cc-muted)", flexShrink: 0, minWidth: 42, textAlign: "right" }}
        >
          {fmtPct(row?.share, "—")}
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 5,
          background: "color-mix(in srgb, var(--cc-fg) 6%, transparent)",
          overflow: "hidden",
        }}
      >
        <div
          data-testid={`spend-bar-${name}`}
          style={{ width: `${width}%`, height: "100%", background: token, borderRadius: 5 }}
        />
      </div>
      <div style={{ fontSize: 9, color: "var(--cc-muted)" }}>
        {fmtCount(row?.tokens, "tokens not reported")} tokens
        {row?.provider ? ` · ${row.provider}` : ""}
      </div>
    </div>
  );
}

export default function SpendByModel({ byModel }) {
  const rows = Array.isArray(byModel) ? byModel : [];
  const maxCost = rows.reduce(
    (acc, r) => (typeof r?.cost === "number" && Number.isFinite(r.cost) ? Math.max(acc, r.cost) : acc),
    0
  );

  return (
    <div style={CARD} data-testid="spend-by-model">
      <div
        style={{
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".1em",
          textTransform: "uppercase",
          color: "var(--cc-dim)",
          flexShrink: 0,
        }}
      >
        Where the spend goes
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
        {rows.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--cc-muted)" }}>
            No model activity in this range.
          </div>
        ) : (
          rows.map((r, i) => <ModelBar key={r?.model || i} row={r} maxCost={maxCost} />)
        )}
      </div>

      <div
        role="note"
        data-testid="spend-caption"
        style={{
          flexShrink: 0,
          padding: "9px 16px",
          borderTop: "1px solid var(--cc-line)",
          fontSize: 10,
          lineHeight: 1.5,
          color: "var(--cc-muted)",
        }}
      >
        {SPEND_CAPTION}
      </div>
    </div>
  );
}
