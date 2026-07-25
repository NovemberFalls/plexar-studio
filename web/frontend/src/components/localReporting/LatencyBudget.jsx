import { useMemo } from "react";
import { fmtNum, normalize, seriesColor } from "./format";

/**
 * LatencyBudget — "Latency budget" card, right panel of the #7 grid per the
 * design handoff. Answers "is local slow, or just queued?" via a stacked bar
 * per backend (queue wait / TTFT / decode) against a shared p95-scaled axis.
 */

function backendLabel(id) {
  if (!id) return "backend";
  return String(id);
}

function secondsFromMs(v) {
  return typeof v === "number" && isFinite(v) ? v / 1000 : 0;
}

export default function LatencyBudget({ data, view }) {
  const hiddenBackends = view?.hiddenBackends || {};

  const sourceRows = useMemo(() => {
    const byProvider = data?.metrics?.by_provider;
    if (Array.isArray(byProvider) && byProvider.length > 0) return byProvider;
    if (data?.metrics) {
      return [{ id: view?.lead || "local", ...data.metrics }];
    }
    return [];
  }, [data, view]);

  const visibleRows = sourceRows.filter((r) => !hiddenBackends[r.id]);

  const rows = useMemo(() => {
    return visibleRows.map((r, idx) => {
      const queueS = secondsFromMs(r?.queue_wait_ms?.p50);
      const ttftS = secondsFromMs(r?.ttft_ms?.p50);
      const runTotalS = secondsFromMs(r?.run_time_ms?.p50);
      const total = runTotalS > 0 ? runTotalS : queueS + ttftS;
      const decodeS = Math.max(0, total - queueS - ttftS);
      const p95S = secondsFromMs(r?.run_time_ms?.p95) || total;
      return {
        id: r.id,
        color: seriesColor(r.id, idx),
        queueS,
        ttftS,
        decodeS,
        total,
        p95S,
      };
    });
  }, [visibleRows]);

  const scaleMax = rows.reduce((m, r) => Math.max(m, r.p95S), 0);

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
          Latency budget
        </span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>p50 / p95 · seconds</span>
      </div>

      <div style={{ padding: "12px 16px 14px", display: "flex", flexDirection: "column", gap: 11 }}>
        {rows.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--cc-muted)" }}>No backend latency data yet.</div>
        ) : (
          rows.map((r) => {
            const p95Pct = normalize(r.p95S, scaleMax) * 100;
            const queuePct = normalize(r.queueS, scaleMax) * 100;
            const ttftPct = normalize(r.ttftS, scaleMax) * 100;
            const decodePct = normalize(r.decodeS, scaleMax) * 100;
            const ttftStart = queuePct;
            const decodeStart = queuePct + ttftPct;
            return (
              <div key={r.id}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    marginBottom: 5,
                  }}
                >
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 11.5,
                      color: "var(--cc-fg)",
                      fontWeight: 600,
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: 999, background: r.color }} />
                    {backendLabel(r.id)}
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      color: "var(--cc-dim)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    queue {fmtNum(r.queueS, 2)}s + ttft {fmtNum(r.ttftS, 2)}s + decode {fmtNum(r.decodeS, 2)}s = {fmtNum(r.total, 2)}s p50
                  </span>
                </div>
                <div
                  style={{
                    height: 16,
                    borderRadius: 4,
                    background: "color-mix(in srgb, var(--cc-fg) 5%, transparent)",
                    position: "relative",
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${p95Pct}%`,
                      background: "color-mix(in srgb, var(--cc-fg) 7%, transparent)",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: `${queuePct}%`,
                      background: "var(--cc-waiting)",
                      opacity: 0.75,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: `${ttftStart}%`,
                      width: `${ttftPct}%`,
                      background: r.color,
                      opacity: 0.55,
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: `${decodeStart}%`,
                      width: `${decodePct}%`,
                      background: r.color,
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
        <div style={{ display: "flex", gap: 14, fontSize: 9.5, color: "var(--cc-muted)", marginTop: 1 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--cc-waiting)" }} />
            queue wait
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: "color-mix(in srgb, var(--cc-accent) 55%, transparent)",
              }}
            />
            TTFT
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--cc-accent)" }} />
            decode
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: "color-mix(in srgb, var(--cc-fg) 10%, transparent)",
              }}
            />
            p95 tail
          </span>
        </div>
      </div>
    </div>
  );
}
