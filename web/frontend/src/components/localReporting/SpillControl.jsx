/**
 * SpillControl — "Spill control · predicted wait per lane" (design handoff
 * §8). Per-lane-class card showing the live predicted wait against its
 * ceiling, replacing LaneQueuePanel's bare slider block. Drag/commit
 * semantics for the range input are lifted verbatim from LaneQueuePanel.jsx's
 * SpillRow: a local `dragVal` while the user is dragging, committed on
 * mouseUp/keyUp, and the `committed` value (spillConfig) is the sole source
 * of truth otherwise so a mid-drag poll can never yank the handle.
 */
import { useState } from "react";

// Ranges pinned from the broker README (also used by LaneQueuePanel.jsx).
const LANES = [
  { key: "interactive", label: "Interactive", min: 5, max: 120 },
  { key: "worker", label: "Worker", min: 30, max: 1800 },
  { key: "batch", label: "Batch", min: 0, max: 3600 },
];

function fmtWait(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds)) return "—";
  if (seconds >= 60) return `${(seconds / 60).toFixed(1)}m`;
  return `${Math.round(seconds)}s`;
}

function laneState(wait, threshold) {
  if (threshold == null) return { key: "off", label: "spill off", color: "var(--cc-muted)" };
  if (typeof wait === "number" && wait > threshold) {
    return { key: "spilling", label: "spilling", color: "var(--cc-waiting)" };
  }
  return { key: "armed", label: "armed", color: "var(--cc-ok)" };
}

function LaneCard({ lane, wait, threshold, spilledCount, laneTotal, onCommit, onToast }) {
  // dragVal is non-null only mid-drag; the committed threshold prop is the
  // source of truth otherwise (no setState-in-effect needed to resync when
  // the poll updates it out from under us).
  const [dragVal, setDragVal] = useState(null);
  const off = threshold == null;
  const shown = dragVal != null ? dragVal : off ? lane.min : threshold;
  const state = laneState(wait, threshold);

  const commitValue = async (value) => {
    try {
      await onCommit(lane.key, value);
    } catch (_err) {
      onToast?.(`Couldn't update ${lane.label} spill threshold — reverted.`, "error");
    } finally {
      // Revert to the last committed value (spillConfig, driving `threshold`)
      // regardless of success — spillConfig is the source of truth; clearing
      // dragVal lets the next render read straight from the prop.
      setDragVal(null);
    }
  };

  const commit = (e) => commitValue(Number(e.target.value));

  const scale = Math.max(typeof wait === "number" ? wait : 0, threshold ?? 0, 1) * 1.25;
  const fillPct = Math.max(0, Math.min(100, ((typeof wait === "number" ? wait : 0) / scale) * 100));
  const tickPct = threshold != null ? Math.max(0, Math.min(100, (threshold / scale) * 100)) : null;

  const spilled = spilledCount || 0;
  const rate = laneTotal > 0 ? (spilled / laneTotal) * 100 : 0;

  return (
    <div style={{ padding: "13px 16px 15px", borderLeft: "1px solid var(--cc-line)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--cc-fg)" }}>{lane.label}</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: ".06em",
            textTransform: "uppercase",
            padding: "2px 7px",
            borderRadius: 4,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: state.color,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: 999, background: state.color }} />
          {state.label}
        </span>
      </div>

      <div style={{ marginTop: 9, display: "flex", alignItems: "baseline", gap: 8 }}>
        <span
          className="tabular-nums"
          style={{ fontSize: 26, fontWeight: 800, color: off ? "var(--cc-dim)" : state.color }}
        >
          {fmtWait(wait)}
        </span>
        <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>
          predicted wait ·{" "}
          {off ? "no ceiling" : typeof wait === "number" && wait > threshold ? "over ceiling" : "under ceiling"}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          height: 8,
          borderRadius: 4,
          background: "color-mix(in srgb, var(--cc-fg) 5%, transparent)",
          marginTop: 9,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: `${fillPct}%`,
            borderRadius: 4,
            background: state.color,
          }}
        />
        {tickPct != null && (
          <div
            style={{
              position: "absolute",
              top: -2,
              bottom: -2,
              left: `${tickPct}%`,
              width: 2,
              background: "var(--cc-fg)",
            }}
            title={`threshold ${threshold}s`}
          />
        )}
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
        <span style={{ fontSize: 10.5, color: "var(--cc-dim)" }}>threshold</span>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className="tabular-nums"
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: "var(--cc-accent)",
              minWidth: 38,
              textAlign: "right",
            }}
          >
            {off ? "off" : `${shown}s`}
          </span>
          <button
            type="button"
            onClick={() => commitValue(off ? lane.min : null)}
            aria-pressed={!off}
            style={{
              fontSize: 10,
              padding: "1px 9px",
              borderRadius: 999,
              background: "var(--cc-elev)",
              border: `1px solid ${off ? "rgba(255,255,255,.20)" : "var(--cc-accent)"}`,
              color: off ? "rgba(255,255,255,.6)" : "var(--cc-accent)",
            }}
          >
            {off ? "off" : "on"}
          </button>
        </span>
      </div>

      <input
        type="range"
        min={lane.min}
        max={lane.max}
        value={shown}
        disabled={off}
        onChange={(e) => setDragVal(Number(e.target.value))}
        onMouseUp={commit}
        onKeyUp={commit}
        aria-label={`${lane.label} spill threshold (seconds)`}
        style={{ width: "100%", marginTop: 5, opacity: off ? 0.4 : 1 }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 9,
          paddingTop: 9,
          borderTop: "1px solid var(--cc-line)",
          fontSize: 10.5,
        }}
      >
        <span style={{ color: "var(--cc-dim)" }}>{spilled} spilled</span>
        <span style={{ color: spilled > 5 ? "var(--cc-waiting)" : "var(--cc-dim)" }}>
          {laneTotal > 0 ? `${rate.toFixed(0)}% of lane` : "—"}
        </span>
      </div>
    </div>
  );
}

export default function SpillControl({ data, actions }) {
  const { queue, spillConfig, metrics } = data || {};
  const offline = !spillConfig || spillConfig.reachable === false;

  const waitByClass = (queue && queue.predicted_wait_s_by_class) || {};
  const thresholds = (spillConfig && spillConfig.spill_thresholds_s) || {};
  const spilledBy = (spillConfig && spillConfig.spilled_by_class) || {};
  // Lane totals for the "% of lane" footer come from metrics.by_lane_class
  // (attempts_total, the completed+errored+cancelled denominator) — spillConfig
  // only carries the lifetime spill counters, not a per-lane attempt count.
  const laneTotals = {};
  if (metrics && Array.isArray(metrics.by_lane_class)) {
    for (const row of metrics.by_lane_class) {
      laneTotals[row.key] = row.attempts_total ?? row.runs_total ?? 0;
    }
  }

  // actions.onSpillChange owns the PUT /api/local/spill call, the 400 toast,
  // and treating spillConfig (poll-driven) as the post-commit source of
  // truth. It is expected to reject/throw on a broker 400 so LaneCard's
  // dragVal is cleared and the slider snaps back to the last committed
  // threshold rather than the value the user released on.
  const handleCommit = async (laneKey, value) => {
    await actions?.onSpillChange?.(laneKey, value);
  };

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
        <span
          className="text-[11px] uppercase"
          style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)" }}
        >
          Spill control · predicted wait per lane
        </span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
          session-only — resets to CLI defaults on broker restart
        </span>
      </div>

      {offline ? (
        <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "12px 16px" }}>
          Broker offline — no spill data for this window.
        </div>
      ) : (
        <div className="spill-control-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))" }}>
          {LANES.map((lane) => (
            <LaneCard
              key={lane.key}
              lane={lane}
              wait={waitByClass[lane.key]}
              threshold={lane.key in thresholds ? thresholds[lane.key] : null}
              spilledCount={spilledBy[lane.key] || 0}
              laneTotal={laneTotals[lane.key] || 0}
              onCommit={handleCommit}
              onToast={actions?.onToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}
