/**
 * Ledger — "Ledger · what local bought us" (design handoff §10). Five-cell
 * grid: Avoided / API spend / Net / Cost of spill / Break-even. Break-even is
 * dropped per the handoff's explicit honesty requirement — there is no rig
 * cost input anywhere in the props contract, and the spec says to drop the
 * cell rather than invent a denominator (add it as a settings value later).
 * Net is deliberately NOT presented as profit; the footer wording below is
 * kept verbatim from the spec.
 */
import { fmtInt, fmtUsd, rowTokens } from "./format";

function refRate(pricing, refModel) {
  const list = Array.isArray(pricing) ? pricing : [];
  return list.find((m) => m.id === refModel) || list[0] || null;
}

function Cell({ label, value, sub, color, last }) {
  return (
    <div style={{ padding: "14px 16px 16px", borderLeft: last ? undefined : "1px solid var(--cc-line)" }}>
      <div
        className="text-[10px] uppercase"
        style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-muted)" }}
      >
        {label}
      </div>
      <div className="tabular-nums" style={{ fontSize: 24, fontWeight: 800, marginTop: 6, color }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 10.5, color: "var(--cc-dim)", lineHeight: 1.45, marginTop: 3 }}>{sub}</div>
      )}
    </div>
  );
}

export default function Ledger({ data, view, actions }) {
  const pricing = Array.isArray(data?.pricing) ? data.pricing : [];
  const rate = refRate(pricing, view?.refModel);
  const localTokens = rowTokens(data?.metrics);
  const avoidedRatePerMtok = rate ? (rate.input_per_mtok + rate.output_per_mtok) / 2 : null;
  const avoided = avoidedRatePerMtok != null ? (localTokens / 1_000_000) * avoidedRatePerMtok : null;

  const apiUsage = data?.apiUsage;
  const apiOffline = !apiUsage || apiUsage.reachable === false;
  const spend = apiOffline ? null : apiUsage.cost_usd;
  const apiRuns = apiOffline ? null : apiUsage.runs;

  // "Direct" vs "spilled" split of API runs isn't carried by GET
  // /api/usage/summary (it has no lane-spill concept — the broker owns
  // spill, usage_tracker only sees completed API calls). We can only say
  // how many of those runs the broker reports as spilled-out, from the
  // broker's own lifetime spill counters, and can't attribute $ to just the
  // spilled subset without a per-run cost breakdown — so "cost of spill" is
  // an estimate (avg cost/run x spilled count), never a real ledger figure.
  const spilledCount = data?.spillConfig && data.spillConfig.reachable !== false
    ? data.spillConfig.spilled_total ?? null
    : null;
  const avgCostPerRun = !apiOffline && apiRuns > 0 && typeof spend === "number" ? spend / apiRuns : null;
  const costOfSpill = avgCostPerRun != null && spilledCount != null ? avgCostPerRun * spilledCount : null;

  const net = avoided != null && typeof spend === "number" ? avoided - spend : null;

  return (
    <div style={{ border: "1px solid var(--cc-border)", borderRadius: 12, background: "var(--cc-surface)", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
        }}
      >
        <span className="text-[11px] uppercase" style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)" }}>
          Ledger · what local bought us
        </span>
        <span style={{ display: "flex", gap: 6 }}>
          {pricing.map((m) => {
            const selected = m.id === (view?.refModel ?? pricing[0]?.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => actions?.setRefModel?.(m.id)}
                aria-pressed={selected}
                style={{
                  fontSize: 10,
                  padding: "2px 9px",
                  borderRadius: 999,
                  background: "var(--cc-elev)",
                  border: `1px solid ${selected ? "var(--cc-accent)" : "var(--cc-border)"}`,
                  color: selected ? "var(--cc-accent)" : "var(--cc-muted)",
                  fontWeight: selected ? 600 : 400,
                }}
                title={m.fetched_at ? `priced ${m.fetched_at}` : undefined}
              >
                {m.label || m.id}
              </button>
            );
          })}
        </span>
      </div>

      <div className="ledger-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))" }}>
        <Cell
          label="Avoided"
          value={avoided != null ? fmtUsd(avoided) : "—"}
          sub={rate ? `${fmtInt(localTokens)} local tokens at ${rate.label || rate.id} rates` : "no reference rate selected"}
          color="var(--cc-ok)"
        />
        <Cell
          label="API spend"
          value={apiOffline ? "—" : fmtUsd(spend)}
          sub={
            apiOffline
              ? "API usage unavailable for this window"
              : `${fmtInt(apiRuns)} api runs${spilledCount != null ? ` · ${fmtInt(spilledCount)} spilled (lifetime)` : ""}`
          }
          color="var(--cc-macro)"
        />
        <Cell
          label="Net"
          value={net != null ? fmtUsd(net) : "—"}
          sub="what the local rig earned this window"
          color="var(--cc-ok)"
        />
        <Cell
          label="Cost of spill"
          value={costOfSpill != null ? fmtUsd(costOfSpill) : "—"}
          sub={
            costOfSpill != null
              ? `~${fmtInt(spilledCount)} escalated requests, billed at avg $/run (estimate)`
              : "no spilled-run cost data"
          }
          color="var(--cc-waiting)"
          last
        />
      </div>

      <div
        style={{
          padding: "10px 16px",
          fontSize: 10.5,
          color: "var(--cc-muted)",
          lineHeight: 1.5,
          borderTop: "1px solid var(--cc-line)",
        }}
      >
        Local tokens are priced at zero; "avoided" values the same token counts at the reference
        model's published API rate. Spilled requests are billed at real API rates and counted against
        the saving.
      </div>
    </div>
  );
}
