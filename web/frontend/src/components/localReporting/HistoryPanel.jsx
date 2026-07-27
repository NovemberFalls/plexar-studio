/**
 * HistoryPanel — in-app time-series history, derived from Cockpit's OWN store
 * (/api/history/*). No Prometheus/Grafana dependency: Cockpit samples every
 * provider to a local JSONL and serves curated series from it. This component
 * picks a metric key + window and renders themed multi-series SVG line charts
 * (one line per provider), matching the hand-rolled SVG idiom used elsewhere.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { seriesColor, fmtNum } from "./format";

const CHARTS = [
  { metric: "throughput_tps", title: "Throughput", unit: "tok/s", digits: 0 },
  { metric: "decode_tps", title: "Decode speed", unit: "tok/s", digits: 0 },
  { metric: "queue_depth", title: "Queue depth", unit: "reqs", digits: 0 },
  { metric: "ttft_p95_seconds", title: "TTFT p95", unit: "s", digits: 2 },
  { metric: "prompt_tokens_p95", title: "Context in (prompt p95)", unit: "tok", digits: 0 },
  { metric: "completion_tokens_p95", title: "Context out (completion p95)", unit: "tok", digits: 0 },
];

function useHistoryStatus(enabled) {
  const [status, setStatus] = useState(null); // { samples } once known
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/history/status");
        const d = r.ok ? await r.json() : { reachable: false, samples: 0 };
        if (!cancelled) setStatus(d);
      } catch (_) { if (!cancelled) setStatus({ reachable: false, samples: 0 }); }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);
  return status;
}

/** Parse the fleet-history shape -> [{label, kind, points:[[t,v]]}]. */
function parseSeries(json) {
  const result = json?.series;
  if (!Array.isArray(result)) return [];
  return result.map((s) => ({
    label: s.provider ?? "series",
    kind: s.kind ?? "",
    points: (s.points || [])
      .map(([t, v]) => [Number(t), Number(v)])
      .filter(([, v]) => Number.isFinite(v)),
  })).filter((s) => s.points.length);
}

function TsdbChart({ metric, title, unit, digits, window }) {
  const [series, setSeries] = useState(null);
  const inFlight = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const r = await fetch(`/api/history/query?metric=${metric}&provider=all&window=${encodeURIComponent(window)}`);
        const d = r.ok ? await r.json() : null;
        if (!cancelled) setSeries(d ? parseSeries(d) : []);
      } catch (_) {
        if (!cancelled) setSeries([]);
      } finally { inFlight.current = false; }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [metric, window]);

  const geom = useMemo(() => {
    if (!series || !series.length) return null;
    const allT = series.flatMap((s) => s.points.map((p) => p[0]));
    const allV = series.flatMap((s) => s.points.map((p) => p[1]));
    const t0 = Math.min(...allT), t1 = Math.max(...allT);
    const vmax = Math.max(...allV, 1e-9);
    const W = 300, H = 90;
    const x = (t) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * W : 0);
    const y = (v) => H - (v / vmax) * H;
    return {
      W, H, vmax,
      lines: series.map((s, i) => ({
        label: s.label,
        color: seriesColor(s.label, i),
        last: s.points[s.points.length - 1][1],
        d: s.points.map((p, k) => `${k ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(" "),
      })),
    };
  }, [series]);

  return (
    <div style={{ border: "1px solid var(--cc-border)", borderRadius: 10, background: "var(--cc-surface)", padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".06em", color: "var(--cc-dim)", textTransform: "uppercase" }}>{title}</span>
        <span style={{ fontSize: 9.5, color: "var(--cc-muted)" }}>{unit}</span>
      </div>
      {geom == null ? (
        <div style={{ fontSize: 11, color: "var(--cc-muted)", padding: "18px 0", textAlign: "center" }}>
          {series == null ? "loading…" : "no data in this window"}
        </div>
      ) : (
        <>
          <svg viewBox={`0 0 ${geom.W} ${geom.H}`} preserveAspectRatio="none" style={{ width: "100%", height: 70, display: "block" }}>
            {geom.lines.map((l) => (
              <path key={l.label} d={l.d} fill="none" stroke={l.color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" opacity=".9" />
            ))}
          </svg>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 6 }}>
            {geom.lines.map((l) => (
              <span key={l.label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--cc-muted)" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: l.color }} />
                {l.label} <span style={{ color: "var(--cc-fg)", fontWeight: 700 }}>{fmtNum(l.last, digits)}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function HistoryPanel({ window, enabled = true }) {
  const status = useHistoryStatus(enabled);
  const warming = status != null && (status.samples || 0) < 3;

  return (
    <div style={{ border: "1px solid var(--cc-border)", borderRadius: 12, background: "var(--cc-surface)", overflow: "hidden" }}>
      <div style={{ padding: "11px 16px 9px", borderBottom: "1px solid var(--cc-border)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)", textTransform: "uppercase" }}>History</span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>Cockpit time-series · all backends</span>
      </div>
      {status == null ? (
        <div style={{ fontSize: 12, color: "var(--cc-muted)", padding: "16px" }}>Loading history…</div>
      ) : warming ? (
        <div style={{ fontSize: 12, color: "var(--cc-muted)", padding: "16px", lineHeight: 1.5 }}>
          Building history — Cockpit samples every minute. Charts appear here once a few
          data points have accrued; nothing else to set up.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10, padding: 12 }}>
          {CHARTS.map((c) => (
            <TsdbChart key={c.metric} {...c} window={window} />
          ))}
        </div>
      )}
    </div>
  );
}
