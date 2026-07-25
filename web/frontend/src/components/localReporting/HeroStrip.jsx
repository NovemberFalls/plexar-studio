/**
 * HeroStrip — the four-cell headline row (design handoff §4, `order: 1`,
 * always pinned above the reorderable sections).
 *
 * Cell set depends on `view.lead` ("routing" | "performance" | "ledger") per
 * the handoff's §4 table — this is a view preference, not a filter, so it
 * never refetches, only reshuffles which four numbers are shown.
 *
 * Deltas need a prior-window figure this component is never handed (the
 * props contract carries only the current window), so per the handoff's
 * "render nothing when there is no prior window rather than +0" rule, no
 * cell ever shows a delta here — that's a compliant, honest empty state,
 * not a shortcut.
 */
import { fmtInt, fmtTokens, fmtMs, fmtNum, fmtUsd, normalize } from "./format";

function sparklinePoints(buckets, pick) {
  if (!Array.isArray(buckets) || buckets.length < 3) return null;
  const raw = buckets.map((b) => {
    const providers = Object.values(b?.by_provider || {});
    const vals = providers.map(pick).filter((v) => typeof v === "number" && isFinite(v));
    if (!vals.length) return null;
    return vals.reduce((a, c) => a + c, 0) / vals.length;
  });
  const clean = raw.filter((v) => typeof v === "number" && isFinite(v));
  if (clean.length < 3) return null;
  const max = Math.max(...clean, 0.0001);
  const step = raw.length > 1 ? 200 / (raw.length - 1) : 0;
  return raw
    .map((v, i) => {
      const x = i * step;
      const n = typeof v === "number" && isFinite(v) ? normalize(v, max) : 0;
      const y = 34 - n * 34;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function HeroCell({ label, value, sub, color, points }) {
  return (
    <div
      style={{
        border: "1px solid var(--cc-border)",
        borderRadius: 12,
        background: "var(--cc-surface)",
        padding: "13px 15px 11px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <span
          className="text-[10px] uppercase tracking-wider"
          style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-muted)" }}
        >
          {label}
        </span>
      </div>
      <div
        style={{
          fontSize: 34,
          fontWeight: 800,
          lineHeight: 1.06,
          marginTop: 6,
          color,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: "var(--cc-dim)", marginTop: 3 }}>{sub}</div>
      {points && (
        <svg
          viewBox="0 0 200 34"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${label} trend`}
          style={{ width: "100%", height: 26, marginTop: 9, display: "block" }}
        >
          <polyline
            fill="none"
            stroke={color}
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
            opacity=".85"
            points={points}
          />
        </svg>
      )}
    </div>
  );
}

export default function HeroStrip({ data, view, actions }) {
  void actions; // props contract is byte-exact across all sections; unused here
  const metrics = data?.metrics;
  const apiUsage = data?.apiUsage;
  const spillConfig = data?.spillConfig;
  const pricing = Array.isArray(data?.pricing) ? data.pricing : [];
  const buckets = Array.isArray(data?.timeseries?.buckets) ? data.timeseries.buckets : null;

  const metricsOk = metrics && metrics.reachable !== false;
  const apiOk = apiUsage && apiUsage.reachable !== false;

  const localRuns = metricsOk && typeof metrics.runs_total === "number" ? metrics.runs_total : null;
  const apiRuns = apiOk && typeof apiUsage.runs === "number" ? apiUsage.runs : null;
  const totalRuns = localRuns != null || apiRuns != null ? (localRuns || 0) + (apiRuns || 0) : null;
  const localShare = totalRuns ? ((localRuns || 0) / totalRuns) * 100 : null;

  const spilledTotal =
    spillConfig && spillConfig.reachable !== false && typeof spillConfig.spilled_total === "number"
      ? spillConfig.spilled_total
      : null;

  const queueWaitP50 =
    metricsOk && metrics.queue_wait_ms && typeof metrics.queue_wait_ms.p50 === "number"
      ? metrics.queue_wait_ms.p50
      : null;

  const attempts = metricsOk && typeof metrics.attempts_total === "number" ? metrics.attempts_total : null;
  const errors = metricsOk && typeof metrics.errors_total === "number" ? metrics.errors_total : null;
  const failureRate = attempts ? (errors || 0) / attempts * 100 : null;
  const errorKinds =
    metricsOk && metrics.errors_by_kind && typeof metrics.errors_by_kind === "object"
      ? Object.entries(metrics.errors_by_kind)
          .filter(([, n]) => n)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ")
      : "";

  const ttftP50 = metricsOk && metrics.ttft_ms && typeof metrics.ttft_ms.p50 === "number" ? metrics.ttft_ms.p50 : null;
  const decodeTps =
    metricsOk && metrics.decode_tokens_per_sec && typeof metrics.decode_tokens_per_sec.avg === "number"
      ? metrics.decode_tokens_per_sec.avg
      : null;
  const wallP95 =
    metricsOk && metrics.run_time_ms && typeof metrics.run_time_ms.p95 === "number" ? metrics.run_time_ms.p95 : null;
  const wallP50 =
    metricsOk && metrics.run_time_ms && typeof metrics.run_time_ms.p50 === "number" ? metrics.run_time_ms.p50 : null;
  const tokensProcessed =
    metricsOk && metrics.tokens_total
      ? (metrics.tokens_total.prompt || 0) + (metrics.tokens_total.completion || 0)
      : null;

  const refModel = pricing.find((m) => m.id === view?.refModel) || pricing[0] || null;
  const localCompletionTokens = metricsOk && metrics.tokens_total ? metrics.tokens_total.completion || 0 : 0;
  const localPromptTokens = metricsOk && metrics.tokens_total ? metrics.tokens_total.prompt || 0 : 0;
  const avoided =
    refModel && metricsOk
      ? (localPromptTokens / 1_000_000) * (refModel.input_per_mtok || 0) +
        (localCompletionTokens / 1_000_000) * (refModel.output_per_mtok || 0)
      : null;
  const apiSpend = apiOk && typeof apiUsage.cost_usd === "number" ? apiUsage.cost_usd : null;
  const netPosition = avoided != null && apiSpend != null ? avoided - apiSpend : null;
  const apiTokens =
    apiOk && apiUsage.tokens
      ? (apiUsage.tokens.prompt || 0) + (apiUsage.tokens.completion || 0)
      : null;
  const effectivePerMtok = apiSpend != null && apiTokens ? (apiSpend / apiTokens) * 1_000_000 : null;

  let cells;
  if (view?.lead === "performance") {
    cells = [
      {
        label: "TTFT p50",
        value: ttftP50 != null ? fmtMs(ttftP50) : "—",
        sub: metrics?.ttft_ms?.p95 != null ? `p95 ${fmtMs(metrics.ttft_ms.p95)}` : "time to first token",
        color: "var(--cc-accent)",
        points: sparklinePoints(buckets, (p) => p.ttft_ms_p50),
      },
      {
        label: "Decode tok/s",
        value: decodeTps != null ? fmtNum(decodeTps, 1) : "—",
        sub: "true decode, not wall-clock",
        color: "var(--cc-thinking)",
        points: sparklinePoints(buckets, (p) => p.decode_tps_p50),
      },
      {
        label: "Wall p95",
        value: wallP95 != null ? fmtMs(wallP95) : "—",
        sub: wallP50 != null ? `p50 ${fmtMs(wallP50)} · tail is queue, not decode` : "—",
        color: "var(--cc-waiting)",
        points: null,
      },
      {
        label: "Tokens processed",
        value: tokensProcessed != null ? fmtTokens(tokensProcessed) : "—",
        sub: "prompt + completion",
        color: "var(--cc-ok)",
        points: sparklinePoints(buckets, (p) => p.tokens),
      },
    ];
  } else if (view?.lead === "ledger") {
    const refLabel = refModel?.label || refModel?.id || "reference model";
    cells = [
      {
        label: "Avoided",
        value: avoided != null ? fmtUsd(avoided) : "—",
        sub: `vs ${refLabel}`,
        color: "var(--cc-ok)",
        points: null,
      },
      {
        label: "API spend",
        value: apiSpend != null ? fmtUsd(apiSpend) : "—",
        sub: "direct + spilled runs",
        color: "var(--cc-macro)",
        points: null,
      },
      {
        label: "Net position",
        value: netPosition != null ? fmtUsd(netPosition) : "—",
        sub: "what the local rig earned this window",
        color: "var(--cc-ok)",
        points: null,
      },
      {
        label: "Effective $/1M",
        value: effectivePerMtok != null ? fmtUsd(effectivePerMtok) : "—",
        sub: "API spend per million tokens",
        color: "var(--cc-thinking)",
        points: null,
      },
    ];
  } else {
    // ROUTING (default)
    cells = [
      {
        label: "Local share",
        value: localShare != null ? `${fmtNum(localShare, 0)}%` : "—",
        sub:
          totalRuns != null
            ? `${fmtInt(localRuns || 0)} of ${fmtInt(totalRuns)} runs stayed local`
            : "—",
        color: "var(--cc-accent)",
        points: sparklinePoints(buckets, (p) => p.runs),
      },
      {
        label: "Offloaded on spill",
        value: spilledTotal != null ? fmtInt(spilledTotal) : "—",
        sub: "requests escalated to API",
        color: "var(--cc-waiting)",
        points: sparklinePoints(buckets, (p) => p.spilled),
      },
      {
        label: "Queue wait p50",
        value: queueWaitP50 != null ? fmtMs(queueWaitP50) : "—",
        sub: metrics?.queue_wait_ms?.p95 != null ? `p95 ${fmtMs(metrics.queue_wait_ms.p95)}` : "—",
        color: "var(--cc-thinking)",
        points: sparklinePoints(buckets, (p) => p.queue_wait_ms_p50),
      },
      {
        label: "Failure rate",
        value: failureRate != null ? `${fmtNum(failureRate, 1)}%` : "—",
        sub: errors != null ? `${fmtInt(errors)} errors${errorKinds ? ` · ${errorKinds}` : ""}` : "—",
        color: "var(--cc-ok)",
        points: sparklinePoints(buckets, (p) => p.errors),
      },
    ];
  }

  return (
    <div
      style={{
        order: 1,
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 10,
      }}
    >
      {cells.map((cell) => (
        <HeroCell key={cell.label} {...cell} />
      ))}
    </div>
  );
}
