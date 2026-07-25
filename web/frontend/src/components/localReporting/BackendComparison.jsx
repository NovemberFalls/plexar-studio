/**
 * BackendComparison — "Backend comparison" card (SPEC #6).
 *
 * Grid `216px repeat(N, minmax(0,1fr))` for N visible backends: local
 * providers from data.metrics.by_provider plus the API row from
 * data.apiUsage, filtered by view.hiddenBackends. Degrades gracefully with
 * 0-2 columns (today's reality: one local backend + the API row).
 */
import { Fragment } from "react";
import { fmtInt, fmtTokens, fmtMs, fmtNum, fmtUsd, seriesColor, normalize } from "./format";

function CardHeader({ title, right }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        padding: "11px 16px 9px",
        borderBottom: "1px solid var(--cc-border)",
      }}
    >
      <div
        className="text-[11px] uppercase"
        style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)" }}
      >
        {title}
      </div>
      {right != null && (
        <div style={{ fontSize: 10, color: "var(--cc-muted)" }}>{right}</div>
      )}
    </div>
  );
}

const ROW_DIVIDER = "color-mix(in srgb, var(--cc-fg) 4.5%, transparent)";

function buildProviders(data, hidden) {
  const localRows = Array.isArray(data?.metrics?.by_provider) ? data.metrics.by_provider : [];
  const providers = localRows
    .filter((p) => p && !hidden?.[p.id ?? p.key])
    .map((p, i) => ({
      id: p.id ?? p.key ?? `local-${i}`,
      label: p.label ?? p.id ?? p.key ?? `Backend ${i + 1}`,
      kind: "local",
      color: seriesColor(p.id ?? p.key, i),
      sub: [
        p.lane_class,
        p.model,
        p.context_length ? `${p.context_length} ctx` : null,
        // vLLM live in-engine depth (continuous batching), when present.
        p.engine ? `${p.engine.running || 0} running · ${p.engine.waiting || 0} queued` : null,
        p.engine && typeof p.engine.kv_cache_pct === "number" ? `KV ${p.engine.kv_cache_pct}%` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      requests: p.runs_total,
      requestsTotal: null,
      tokens: (p.tokens_total?.prompt || 0) + (p.tokens_total?.completion || 0),
      ttft_p50: p.ttft_ms?.p50,
      ttft_p95: p.ttft_ms?.p95,
      decode_tps: p.decode_tokens_per_sec?.avg ?? p.decode_tokens_per_sec?.current ?? null,
      queue_wait_p50: p.queue_wait_ms?.p50,
      wall_p50: p.run_time_ms?.p50,
      wall_p95: p.run_time_ms?.p95,
      errors_total: p.errors_total,
      attempts_total: p.attempts_total,
      spilled_out: p.spilled_out,
      cost_avoided: null, // computed below once we know ref pricing (not owned by this worker's props)
      hasQueue: true,
    }));

  const apiUsage = data?.apiUsage;
  if (apiUsage && apiUsage.reachable !== false && !hidden?.api) {
    providers.push({
      id: "api",
      label: "Anthropic API",
      kind: "api",
      color: seriesColor("api"),
      sub: apiUsage.model ? `spill target · ${apiUsage.model}` : "spill target",
      requests: apiUsage.runs,
      requestsTotal: null,
      tokens: (apiUsage.tokens?.prompt || 0) + (apiUsage.tokens?.completion || 0),
      ttft_p50: apiUsage.ttft_ms?.p50,
      ttft_p95: apiUsage.ttft_ms?.p95,
      decode_tps: null,
      queue_wait_p50: null,
      wall_p50: apiUsage.wall_ms?.p50,
      wall_p95: apiUsage.wall_ms?.p95,
      errors_total: apiUsage.errors_total,
      attempts_total: null,
      spilled_in: apiUsage.spilled_runs,
      cost_usd: apiUsage.cost_usd,
      hasQueue: false,
    });
  }

  const requestsTotal = providers.reduce((sum, p) => sum + (p.requests || 0), 0);
  for (const p of providers) p.requestsTotal = requestsTotal;

  return providers;
}

// Row definitions: id, label, unit qualifier, best direction ("min" | "max" | null),
// value(provider) -> {display, sub, raw} where raw is the numeric compare value (or null).
const ROWS = [
  {
    id: "requests",
    label: "Requests",
    unit: "runs",
    best: null,
    value: (p) => {
      const share = p.requestsTotal > 0 ? Math.round((p.requests / p.requestsTotal) * 100) : null;
      return {
        display: typeof p.requests === "number" ? fmtInt(p.requests) : "—",
        sub: share != null ? `${share}%` : null,
        raw: typeof p.requests === "number" ? p.requests : null,
      };
    },
  },
  {
    id: "tokens",
    label: "Tokens processed",
    unit: "p+c",
    best: null,
    value: (p) => ({
      display: typeof p.tokens === "number" ? fmtTokens(p.tokens) : "—",
      sub: null,
      raw: typeof p.tokens === "number" ? p.tokens : null,
    }),
  },
  {
    id: "ttft",
    label: "Time to first token",
    unit: "p50",
    best: "min",
    value: (p) => ({
      display: typeof p.ttft_p50 === "number" ? fmtMs(p.ttft_p50) : "—",
      sub: typeof p.ttft_p95 === "number" ? `p95 ${fmtMs(p.ttft_p95)}` : "not measured",
      raw: typeof p.ttft_p50 === "number" ? p.ttft_p50 : null,
    }),
  },
  {
    id: "decode",
    label: "Decode speed",
    unit: "tok/s",
    best: "max",
    value: (p) => ({
      display: typeof p.decode_tps === "number" ? fmtNum(p.decode_tps, 1) : "—",
      sub: p.kind === "api" ? "not applicable" : typeof p.decode_tps !== "number" ? "not measured" : null,
      raw: typeof p.decode_tps === "number" ? p.decode_tps : null,
    }),
  },
  {
    id: "queue_wait",
    label: "Queue wait",
    unit: "p50",
    best: "min",
    value: (p) => {
      if (!p.hasQueue) return { display: "—", sub: "no queue", raw: null };
      return {
        display: typeof p.queue_wait_p50 === "number" ? fmtMs(p.queue_wait_p50) : "—",
        sub: typeof p.queue_wait_p50 !== "number" ? "not measured" : null,
        raw: typeof p.queue_wait_p50 === "number" ? p.queue_wait_p50 : null,
      };
    },
  },
  {
    id: "wall",
    label: "Wall time",
    unit: "p50",
    best: "min",
    value: (p) => ({
      display: typeof p.wall_p50 === "number" ? fmtMs(p.wall_p50) : "—",
      sub: typeof p.wall_p95 === "number" ? `p95 ${fmtMs(p.wall_p95)}` : null,
      raw: typeof p.wall_p50 === "number" ? p.wall_p50 : null,
    }),
  },
  {
    id: "failure_rate",
    label: "Failure rate",
    unit: "errors",
    best: "min",
    value: (p) => {
      const errs = p.errors_total;
      const attempts = p.attempts_total;
      if (typeof errs !== "number") return { display: "—", sub: "not measured", raw: null };
      const rate = typeof attempts === "number" && attempts > 0 ? (errs / attempts) * 100 : null;
      return {
        display: rate != null ? `${fmtNum(rate, 1)}%` : fmtInt(errs),
        sub: typeof attempts === "number" ? `${fmtInt(errs)} of ${fmtInt(attempts)}` : null,
        raw: rate != null ? rate : errs,
      };
    },
  },
  {
    id: "spill",
    label: "Spill / escalation",
    unit: "",
    best: null,
    value: (p) => {
      if (p.kind === "api") {
        return {
          display: typeof p.spilled_in === "number" ? fmtInt(p.spilled_in) : "—",
          sub: typeof p.spilled_in === "number" ? "in" : null,
          raw: null,
        };
      }
      return {
        display: typeof p.spilled_out === "number" ? fmtInt(p.spilled_out) : "—",
        sub: typeof p.spilled_out === "number" ? "out" : null,
        raw: null,
      };
    },
  },
  {
    id: "cost",
    label: "Cost impact",
    unit: "",
    best: null,
    value: (p) => {
      if (p.kind === "api") {
        return {
          display: typeof p.cost_usd === "number" ? `−${fmtUsd(p.cost_usd)}` : "—",
          sub: "spent",
          raw: null,
        };
      }
      return { display: "—", sub: "avoided (needs ref pricing)", raw: null };
    },
  },
];

export default function BackendComparison({ data, view, actions }) {
  void actions;
  const hidden = view?.hiddenBackends || {};
  const providers = buildProviders(data, hidden);

  const offline = !data?.metrics && !data?.apiUsage;

  return (
    <div
      style={{
        border: "1px solid var(--cc-border)",
        borderRadius: 12,
        background: "var(--cc-surface)",
        overflow: "hidden",
      }}
    >
      <CardHeader
        title="Backend comparison"
        right="best value per row highlighted · TTFT/decode measured at each backend"
      />

      {offline ? (
        <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "14px 16px" }}>
          Broker offline — no comparison data for this window.
        </div>
      ) : providers.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "14px 16px" }}>
          No backends to compare yet.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: `216px repeat(${providers.length}, minmax(0,1fr))`,
              minWidth: 216 + providers.length * 90,
            }}
          >
            {/* Column headers */}
            <div style={{ borderBottom: "1px solid var(--cc-border)" }} />
            {providers.map((p) => (
              <div
                key={p.id}
                style={{
                  padding: "10px 16px",
                  borderBottom: "1px solid var(--cc-border)",
                  borderLeft: "1px solid var(--cc-line)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: p.color,
                      display: "inline-block",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{ fontSize: 12.5, fontWeight: 700, color: "var(--cc-fg)" }}
                    title={p.label}
                  >
                    {p.label}
                  </span>
                </div>
                {p.sub && (
                  <div style={{ fontSize: 10.5, color: "var(--cc-muted)", marginTop: 3 }} title={p.sub}>
                    {p.sub}
                  </div>
                )}
              </div>
            ))}

            {/* Rows */}
            {ROWS.map((row) => {
              const cells = providers.map((p) => row.value(p));
              const numeric = cells.map((c) => c.raw).filter((v) => typeof v === "number" && isFinite(v));
              let winnerIdx = -1;
              if (row.best && providers.length >= 2 && numeric.length >= 2) {
                const target = row.best === "min" ? Math.min(...numeric) : Math.max(...numeric);
                const winners = cells.reduce((acc, c, i) => {
                  if (typeof c.raw === "number" && c.raw === target) acc.push(i);
                  return acc;
                }, []);
                if (winners.length === 1) winnerIdx = winners[0];
              }
              const maxAbs = Math.max(1e-9, ...cells.map((c) => (typeof c.raw === "number" ? Math.abs(c.raw) : 0)));

              return (
                <Fragment key={row.id}>
                  <div
                    key={`${row.id}-label`}
                    style={{
                      padding: "8px 16px",
                      borderBottom: `1px solid ${ROW_DIVIDER}`,
                      fontSize: 11.5,
                      color: "var(--cc-dim)",
                    }}
                  >
                    {row.label}
                    {row.unit && (
                      <span style={{ fontSize: 9.5, color: "var(--cc-muted)", opacity: 0.6, marginLeft: 4 }}>
                        {row.unit}
                      </span>
                    )}
                  </div>
                  {providers.map((p, i) => {
                    const c = cells[i];
                    const isWinner = i === winnerIdx;
                    const barPct = normalize(typeof c.raw === "number" ? Math.abs(c.raw) : 0, maxAbs) * 100;
                    return (
                      <div
                        key={`${row.id}-${p.id}`}
                        style={{
                          padding: "8px 16px",
                          borderBottom: `1px solid ${ROW_DIVIDER}`,
                          borderLeft: "1px solid var(--cc-line)",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
                          <span
                            className="tabular-nums"
                            style={{
                              fontSize: 13,
                              fontWeight: 700,
                              color: isWinner ? "var(--cc-ok)" : "var(--cc-fg)",
                            }}
                          >
                            {c.display}
                          </span>
                          {c.sub && (
                            <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>{c.sub}</span>
                          )}
                          {isWinner && <span className="sr-only">(best)</span>}
                        </div>
                        {typeof c.raw === "number" && (
                          <div
                            style={{
                              height: 3,
                              borderRadius: 2,
                              background: "rgba(255,255,255,.06)",
                              marginTop: 5,
                            }}
                          >
                            <div
                              style={{
                                height: "100%",
                                width: `${barPct}%`,
                                borderRadius: 2,
                                background: isWinner ? "var(--cc-ok)" : p.color,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </Fragment>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
