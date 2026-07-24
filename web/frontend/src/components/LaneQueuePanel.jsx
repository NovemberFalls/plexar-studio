/**
 * LaneQueuePanel — live view of the local-lane broker queue.
 *
 * Renders the broker's read-only /queue snapshot (proxied via
 * GET /api/local/queue): the in-flight job + class, queued jobs in order,
 * estimated seconds-to-clear, and spill count. Includes a spill-threshold
 * slider that is INERT for now — the broker contract is read-only, so the
 * write endpoint (POST /api/local/spill) currently returns 501. The slider
 * exists so it lights up the moment the broker ships a control endpoint.
 *
 * Props:
 *   queue        — object from GET /api/local/queue, or null when offline/loading
 *   onSpillChange — (value:number) => void, called on slider commit (currently inert)
 */

import { useState } from "react";

// Per-lane-class spill sliders. Spill = seconds of PREDICTED WAIT for that
// class at enqueue time (not queue depth). Ranges per broker guidance; batch
// is typically disabled (null).
const SPILL_CLASSES = [
  { key: "interactive", label: "Interactive", min: 5, max: 120 },
  { key: "worker", label: "Worker", min: 30, max: 1800 },
  { key: "batch", label: "Batch", min: 0, max: 3600 },
];

/** One class row: a seconds slider + an off/on toggle (null = spill disabled). */
function SpillRow({ cls, valueS, spilled, onCommit }) {
  const off = valueS == null;
  // dragVal is non-null only mid-drag; otherwise the committed prop is the
  // source of truth (no setState-in-effect needed to sync when the poll updates).
  const [dragVal, setDragVal] = useState(null);
  const shown = dragVal != null ? dragVal : off ? cls.min : valueS;
  const commit = (e) => {
    onCommit(cls.key, Number(e.target.value));
    setDragVal(null);
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
        <span style={{ fontSize: 11, color: "var(--text-primary)", fontWeight: 600 }}>
          {cls.label}
          {spilled > 0 && (
            <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {spilled} spilled</span>
          )}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {/* Seconds readout only when active — the toggle alone says off. */}
          {!off && (
            <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, minWidth: 34, textAlign: "right" }}>
              {shown}s
            </span>
          )}
          <button
            onClick={() => onCommit(cls.key, off ? cls.min : null)}
            className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
            style={{
              color: off ? "var(--text-muted)" : "var(--accent)",
              border: `1px solid ${off ? "var(--border-color)" : "var(--accent)"}`,
              background: "var(--bg-surface)",
            }}
            aria-pressed={!off}
            title={off ? "Enable spill for this class" : "Disable spill for this class"}
          >
            {off ? "off" : "on"}
          </button>
        </span>
      </div>
      <input
        type="range"
        min={cls.min}
        max={cls.max}
        value={shown}
        disabled={off}
        onChange={(e) => setDragVal(Number(e.target.value))}
        onMouseUp={commit}
        onKeyUp={commit}
        aria-label={`${cls.label} spill threshold (seconds)`}
        style={{ width: "100%", marginTop: 3, opacity: off ? 0.4 : 1 }}
      />
    </div>
  );
}

// /queue field names are PINNED from broker source (broker.py::_queue_state):
// {shadow, in_flight: {class, elapsed_s, predicted_remaining_s, model,
// client_id} | null, queued: [{class, position, predicted_wall_s, waiting_s,
// model, client_id}], estimated_clear_seconds}. No guessing, no aliases.
// Spill counters are NOT here — they live on /config/spill.

function fmtS(v) {
  return typeof v === "number" ? `${Math.round(v)}s` : "";
}

function Row({ dotColor, primary, secondary }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
      <span style={{ width: 7, height: 7, borderRadius: 999, background: dotColor, flexShrink: 0 }} />
      <span
        style={{
          fontSize: 12,
          color: "var(--text-primary)",
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {primary}
      </span>
      {secondary != null && (
        <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0 }}>
          {secondary}
        </span>
      )}
    </div>
  );
}

export default function LaneQueuePanel({ queue, spillConfig, onSpillChange }) {
  const offline = !queue || queue.reachable === false;

  if (offline) {
    return (
      <div style={{ padding: "10px 12px" }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
          Lane Queue
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Broker offline — no queue data. (Expecting broker at <code>127.0.0.1:1235</code>.)
        </div>
      </div>
    );
  }

  const inFlight = queue.in_flight || null;
  const queued = Array.isArray(queue.queued) ? queue.queued : [];
  const spilledTotal = spillConfig && spillConfig.reachable !== false ? spillConfig.spilled_total ?? 0 : null;
  const clearSec = queue.estimated_clear_seconds;

  return (
    <div style={{ padding: "10px 12px" }}>
      <div
        className="text-[10px] uppercase tracking-wider"
        style={{ color: "var(--text-muted)", marginBottom: 6, display: "flex", justifyContent: "space-between" }}
      >
        <span>Lane Queue</span>
        {typeof clearSec === "number" && (
          <span style={{ color: "var(--text-secondary)" }}>clears ~{Math.round(clearSec)}s</span>
        )}
      </div>

      {inFlight ? (
        <Row
          dotColor="var(--accent)"
          primary={`▶ ${inFlight.class || "—"}${inFlight.model ? ` · ${inFlight.model}` : ""}`}
          secondary={
            typeof inFlight.predicted_remaining_s === "number"
              ? `${fmtS(inFlight.elapsed_s)} in · ~${fmtS(inFlight.predicted_remaining_s)} left`
              : fmtS(inFlight.elapsed_s)
          }
        />
      ) : (
        <Row dotColor="var(--text-muted)" primary="idle — no job in flight" />
      )}

      {queued.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)", padding: "4px 0 2px 15px" }}>
          nothing queued
        </div>
      ) : (
        queued.map((job) => (
          <Row
            key={`${job.position}-${job.client_id || ""}`}
            dotColor="var(--text-secondary)"
            primary={`${(job.position ?? 0) + 1}. ${job.class || "—"}${job.model ? ` · ${job.model}` : ""}`}
            secondary={
              typeof job.predicted_wall_s === "number"
                ? `waiting ${fmtS(job.waiting_s)} · ~${fmtS(job.predicted_wall_s)} wall`
                : fmtS(job.waiting_s)
            }
          />
        ))
      )}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 8,
          paddingTop: 8,
          borderTop: "1px solid var(--border-color)",
          fontSize: 11,
          color: "var(--text-secondary)",
        }}
      >
        <span>queued: {queued.length}{queue.shadow ? " · shadow mode" : ""}</span>
        {spilledTotal != null && <span>spilled: {spilledTotal}</span>}
      </div>

      {/* Spill thresholds — per lane class, in SECONDS of predicted wait.
          spillConfig is null (not just offline) when the caller has decided
          the spill capability doesn't apply here (missing cap, or a remote
          provider — spill controls require scope=="local"); in that case the
          whole section is omitted rather than shown as "offline". */}
      {spillConfig != null && (
        <div style={{ marginTop: 10 }}>
          <div
            className="text-[10px] uppercase tracking-wider"
            style={{ color: "var(--text-muted)" }}
            title="Spill = seconds of predicted wait for that class at enqueue time. null/off disables spill. Session-only on the broker (resets on restart)."
          >
            Spill thresholds · predicted wait (s)
          </div>
          {(() => {
            const offline = spillConfig.reachable === false;
            if (offline) {
              return (
                <div className="text-xs" style={{ color: "var(--text-muted)", marginTop: 4 }}>
                  Broker offline — spill controls unavailable.
                </div>
              );
            }
            const thresholds = spillConfig.spill_thresholds_s || {};
            const spilledBy = spillConfig.spilled_by_class || {};
            return SPILL_CLASSES.map((cls) => (
              <SpillRow
                key={cls.key}
                cls={cls}
                valueS={cls.key in thresholds ? thresholds[cls.key] : null}
                spilled={spilledBy[cls.key] || 0}
                onCommit={(k, v) => onSpillChange?.(k, v)}
              />
            ));
          })()}
          {spillConfig.reachable !== false && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 6 }}>
              Session-only — resets to CLI defaults on broker restart.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
