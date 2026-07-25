import { useMemo, useState } from "react";
import { seriesColor } from "./format";

/**
 * ThroughputChart — "Decode throughput & TTFT · 24h" card. Left panel of the
 * #7 grid per the design handoff. One polyline per visible backend (decode
 * tok/s, 0-100 axis, adaptive) plus a dashed TTFT p50 overlay (0-2.0s axis,
 * adaptive). Renders an empty-state note when fewer than 3 buckets exist.
 */

const VB_W = 700;
const VB_H = 190;
const GRID_YS = [0, 47.5, 95, 142.5];
const TPS_AXIS_DEFAULT = 100;
const TTFT_AXIS_DEFAULT = 2.0;

function backendLabel(id) {
  if (!id) return "backend";
  return String(id);
}

export default function ThroughputChart({ data, view }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const buckets = Array.isArray(data?.timeseries?.buckets) ? data.timeseries.buckets : [];
  const hiddenBackends = view?.hiddenBackends || {};

  // Discover the set of backend ids present across buckets, preserving
  // first-seen order so color assignment (accent, type, ...) is stable.
  const backendIds = useMemo(() => {
    const seen = [];
    for (const b of buckets) {
      const byProvider = b?.by_provider || {};
      for (const id of Object.keys(byProvider)) {
        if (!seen.includes(id)) seen.push(id);
      }
    }
    return seen;
  }, [buckets]);

  const visibleIds = backendIds.filter((id) => !hiddenBackends[id]);

  const hasEnoughData = buckets.length >= 3;

  const { tpsAxisMax, ttftAxisMax, series, ttftSeries } = useMemo(() => {
    let tpsMax = TPS_AXIS_DEFAULT;
    let ttftMax = TTFT_AXIS_DEFAULT;

    const n = buckets.length;
    const seriesMap = {};
    for (const id of visibleIds) seriesMap[id] = [];
    const ttftVals = [];

    buckets.forEach((b) => {
      const byProvider = b?.by_provider || {};
      let bucketTtftSum = 0;
      let bucketTtftCount = 0;
      visibleIds.forEach((id) => {
        const entry = byProvider[id] || {};
        const tps = typeof entry.decode_tps_p50 === "number" && isFinite(entry.decode_tps_p50) ? entry.decode_tps_p50 : 0;
        seriesMap[id].push(tps);
        if (tps > tpsMax) tpsMax = tps;
      });
      Object.values(byProvider).forEach((entry) => {
        const t = entry?.ttft_ms_p50;
        if (typeof t === "number" && isFinite(t)) {
          bucketTtftSum += t;
          bucketTtftCount += 1;
        }
      });
      const avgTtftS = bucketTtftCount > 0 ? bucketTtftSum / bucketTtftCount / 1000 : null;
      ttftVals.push(avgTtftS);
      if (avgTtftS !== null && avgTtftS > ttftMax) ttftMax = avgTtftS;
    });

    // Round adaptive maxima up to a friendly step so labels aren't jagged.
    if (tpsMax > TPS_AXIS_DEFAULT) tpsMax = Math.ceil(tpsMax / 10) * 10;
    if (ttftMax > TTFT_AXIS_DEFAULT) ttftMax = Math.ceil(ttftMax * 10) / 10;

    const toPoints = (vals, max) => {
      if (n <= 1) return "";
      return vals
        .map((v, i) => {
          const x = (i / (n - 1)) * VB_W;
          const frac = max > 0 ? Math.min(1, Math.max(0, v / max)) : 0;
          const y = VB_H - frac * VB_H;
          return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" ");
    };

    const built = visibleIds.map((id, idx) => ({
      id,
      color: seriesColor(id, idx),
      points: toPoints(seriesMap[id], tpsMax),
      values: seriesMap[id],
    }));

    const ttftPoints = n > 1
      ? ttftVals
          .map((v, i) => {
            const x = (i / (n - 1)) * VB_W;
            const val = v === null ? 0 : v;
            const frac = ttftMax > 0 ? Math.min(1, Math.max(0, val / ttftMax)) : 0;
            const y = VB_H - frac * VB_H;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")
      : "";

    return { tpsAxisMax: tpsMax, ttftAxisMax: ttftMax, series: built, ttftSeries: { points: ttftPoints, values: ttftVals } };
  }, [buckets, visibleIds]);

  const legend = visibleIds.map((id, idx) => ({ id, color: seriesColor(id, idx) }));

  const ariaLabel = hasEnoughData
    ? `Decode throughput and TTFT over the last 24 hours for ${visibleIds.map(backendLabel).join(", ") || "no visible backends"}.`
    : "Decode throughput and TTFT chart — not enough data yet.";

  const n = buckets.length;

  function handleMove(e) {
    if (!hasEnoughData || n === 0) return;
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const idx = Math.max(0, Math.min(n - 1, Math.round(relX * (n - 1))));
    setHoverIdx(idx);
  }

  return (
    <div
      style={{
        border: "1px solid var(--cc-border)",
        borderRadius: 12,
        background: "var(--cc-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".1em",
            textTransform: "uppercase",
            color: "var(--cc-dim)",
          }}
        >
          Decode throughput &amp; TTFT · 24h
        </span>
        <div style={{ display: "flex", gap: 12, fontSize: 10, color: "var(--cc-muted)" }}>
          {legend.map((l) => (
            <span key={l.id} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 12, height: 2, background: l.color }} />
              {backendLabel(l.id)}
            </span>
          ))}
        </div>
      </div>

      <div style={{ padding: "12px 16px 8px" }}>
        {!hasEnoughData ? (
          <div
            style={{
              height: VB_H,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "var(--cc-muted)",
            }}
          >
            Not enough data yet — need at least 3 time buckets.
          </div>
        ) : (
          <>
            <svg
              viewBox={`0 0 ${VB_W} ${VB_H}`}
              preserveAspectRatio="none"
              style={{ width: "100%", height: VB_H, display: "block", overflow: "visible", cursor: "crosshair" }}
              role="img"
              aria-label={ariaLabel}
              onMouseMove={handleMove}
              onMouseLeave={() => setHoverIdx(null)}
            >
              {GRID_YS.map((y) => (
                <line
                  key={y}
                  x1="0"
                  y1={y}
                  x2={VB_W}
                  y2={y}
                  stroke="var(--cc-line)"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {series.map((s) => (
                <polyline
                  key={s.id}
                  points={s.points}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="1.9"
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
              ))}
              <polyline
                points={ttftSeries.points}
                fill="none"
                stroke="var(--cc-waiting)"
                strokeWidth="1.3"
                strokeDasharray="4 3"
                vectorEffect="non-scaling-stroke"
              />
              {hoverIdx !== null && n > 1 && (
                <line
                  x1={(hoverIdx / (n - 1)) * VB_W}
                  y1="0"
                  x2={(hoverIdx / (n - 1)) * VB_W}
                  y2={VB_H}
                  stroke="var(--cc-fg)"
                  strokeOpacity="0.25"
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              {n > 0 && (
                <rect
                  x="0"
                  y="0"
                  width={VB_W}
                  height={VB_H}
                  fill="transparent"
                  pointerEvents="all"
                />
              )}
            </svg>
            {hoverIdx !== null && buckets[hoverIdx] && (
              <div
                style={{
                  marginTop: 4,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "var(--cc-elev)",
                  border: "1px solid var(--cc-border)",
                  fontSize: 10,
                  color: "var(--cc-dim)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <span style={{ color: "var(--cc-muted)" }}>{buckets[hoverIdx].ts || `bucket ${hoverIdx}`}</span>
                {series.map((s) => (
                  <span key={s.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: s.color }} />
                    {backendLabel(s.id)}: {typeof s.values[hoverIdx] === "number" ? s.values[hoverIdx].toFixed(1) : "—"} tok/s
                  </span>
                ))}
                <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--cc-waiting)" }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--cc-waiting)" }} />
                  TTFT p50: {typeof ttftSeries.values[hoverIdx] === "number" ? ttftSeries.values[hoverIdx].toFixed(2) : "—"}s
                </span>
              </div>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 6,
                fontSize: 9.5,
                color: "var(--cc-muted)",
              }}
            >
              <span>0 tok/s</span>
              <span style={{ color: "var(--cc-waiting)" }}>
                — — TTFT p50 (right axis, 0–{ttftAxisMax.toFixed(1)}s)
              </span>
              <span>{tpsAxisMax} tok/s</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
