/**
 * HistoryPanel — in-app time-series history, Prometheus-backed (replaces Grafana
 * for the at-a-glance view). Queries Cockpit's server-side proxy (/api/tsdb/*),
 * which owns the PromQL; this component only picks a curated metric key + window.
 * Renders themed multi-series SVG line charts (one line per provider), matching
 * the hand-rolled SVG idiom used elsewhere in localReporting.
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

function useTsdbStatus(enabled) {
  const [ok, setOk] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/tsdb/status");
        const d = r.ok ? await r.json() : { reachable: false };
        if (!cancelled) setOk(d.reachable === true);
      } catch (_) { if (!cancelled) setOk(false); }
    };
    tick();
    const id = setInterval(tick, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled]);
  return ok;
}

/** Parse Prometheus matrix -> [{label, kind, points:[[t,v]]}]. */
function parseMatrix(json) {
  const result = json?.data?.result;
  if (!Array.isArray(result)) return [];
  return result.map((s) => ({
    label: s.metric?.provider ?? "series",
    kind: s.metric?.kind ?? "",
    points: (s.values || [])
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
        const r = await fetch(`/api/tsdb/query_range?metric=${metric}&provider=all&window=${encodeURIComponent(window)}`);
        const d = r.ok ? await r.json() : null;
        if (!cancelled) setSeries(d ? parseMatrix(d) : []);
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
  const ready = useTsdbStatus(enabled);

  return (
    <div style={{ border: "1px solid var(--cc-border)", borderRadius: 12, background: "var(--cc-surface)", overflow: "hidden" }}>
      <div style={{ padding: "11px 16px 9px", borderBottom: "1px solid var(--cc-border)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)", textTransform: "uppercase" }}>History</span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>Prometheus-backed · all backends</span>
      </div>
      {ready === false ? (
        <div style={{ fontSize: 12, color: "var(--cc-muted)", padding: "16px", lineHeight: 1.5 }}>
          History store offline. Start it with <code style={{ color: "var(--cc-fg)" }}>docker compose up -d</code> in
          <code style={{ color: "var(--cc-fg)" }}> aim-observability</code>, then history appears here automatically.
        </div>
      ) : ready == null ? (
        <div style={{ fontSize: 12, color: "var(--cc-muted)", padding: "16px" }}>Checking history store…</div>
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
