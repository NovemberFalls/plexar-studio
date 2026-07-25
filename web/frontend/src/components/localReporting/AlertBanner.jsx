/**
 * AlertBanner — the offload alert banner (design handoff §3, `order: 0`).
 *
 * Renders ONLY when at least one lane's live predicted wait
 * (`data.queue.predicted_wait_s_by_class[lane]`) exceeds that lane's
 * configured spill threshold (`data.spillConfig.spill_thresholds_s[lane]`,
 * non-null). When several lanes are over, the highest-priority one wins
 * (interactive > worker > batch) and the rest are summarised as
 * "+N more lanes". Pulses via the existing `[data-glowable][data-state=
 * "waiting"]` glow system in index.css — no new animation, and the global
 * `[data-glow="off"]` / prefers-reduced-motion off-switches are inherited
 * for free.
 */
import { TriangleAlert } from "lucide-react";
import { queueDepth } from "./format";

const LANE_PRIORITY = ["interactive", "worker", "batch"];
const LANE_LABEL = { interactive: "Interactive", worker: "Worker", batch: "Batch" };

const FIVE_MIN_MS = 5 * 60 * 1000;

// "Raise threshold" bumps the lane above the current predicted wait, rounded
// up to the next 5s — per the handoff, strictly above (a tie at a multiple
// of 5 still needs a bump, or the lane would immediately re-arm the alert).
function raiseValue(predictedS) {
  let v = Math.ceil(predictedS / 5) * 5;
  if (v <= predictedS) v += 5;
  return v;
}

function fmtClock(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** True if `isoTs` is within the last 5 minutes. Isolated so the impure
 * Date.now() read doesn't sit directly in component render bodies. */
function withinLastFiveMin(isoTs) {
  const t = Date.parse(isoTs);
  return isFinite(t) && Date.now() - t <= FIVE_MIN_MS;
}

export default function AlertBanner({ data, view, actions }) {
  void view; // props contract is byte-exact across all sections; unused here
  const queue = data?.queue;
  const spillConfig = data?.spillConfig;

  if (!queue || queue.reachable === false) return null;
  if (!spillConfig || spillConfig.reachable === false) return null;

  const waitByClass = queue.predicted_wait_s_by_class || {};
  const thresholds = spillConfig.spill_thresholds_s || {};

  const overLanes = LANE_PRIORITY.filter((lane) => {
    const threshold = thresholds[lane];
    const wait = waitByClass[lane];
    return threshold != null && typeof wait === "number" && isFinite(wait) && wait > threshold;
  });

  if (overLanes.length === 0) return null;

  const lane = overLanes[0];
  const moreCount = overLanes.length - 1;
  const predicted = waitByClass[lane];
  const threshold = thresholds[lane];

  // Spill events in the last 5 minutes for this lane, from GET /spills
  // ({spills:[{ts, lane_class, predicted_wait_s, threshold_s, ...}], count}).
  const spillEvents = Array.isArray(data?.spills?.spills) ? data.spills.spills : [];
  const laneRecent = spillEvents.filter((e) => e?.lane_class === lane && withinLastFiveMin(e.ts));
  const recentCount = laneRecent.length;

  // "since" = earliest event in the recent-5min window for this lane — an
  // approximation of the streak start (the broker doesn't expose streak
  // boundaries directly).
  const sinceTs = laneRecent.length
    ? laneRecent.reduce((min, e) => (Date.parse(e.ts) < Date.parse(min.ts) ? e : min)).ts
    : null;
  const sinceLabel = sinceTs ? fmtClock(sinceTs) : null;

  const depth = queueDepth(queue);
  const raiseTo = raiseValue(predicted);

  const handleRaise = () => {
    actions?.onSpillChange?.(lane, raiseTo);
    actions?.onToast?.(`${LANE_LABEL[lane]} spill threshold → ${raiseTo}s`, "success");
  };
  const handleHold = () => {
    actions?.onSpillChange?.(lane, null);
    actions?.onToast?.(`spill disabled for ${LANE_LABEL[lane]} — requests will queue`, "info");
  };

  return (
    <div
      data-glowable
      data-state="waiting"
      role="status"
      aria-live="polite"
      style={{
        order: 0,
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "11px 16px",
        borderRadius: 10,
        background: "color-mix(in srgb, var(--cc-waiting) 12%, var(--cc-surface))",
        border: "1px solid color-mix(in srgb, var(--cc-waiting) 35%, transparent)",
      }}
    >
      <TriangleAlert size={17} color="var(--cc-waiting)" style={{ flexShrink: 0 }} />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--cc-waiting)" }}>
          {LANE_LABEL[lane]} lane over threshold — offloading to API
          {moreCount > 0 ? ` · +${moreCount} more lanes` : ""}
        </div>
        <div style={{ fontSize: 11, color: "var(--cc-dim)", marginTop: 2 }}>
          Predicted wait {Math.round(predicted)}s &gt; {Math.round(threshold)}s threshold
          {" · "}
          {recentCount} request{recentCount === 1 ? "" : "s"} spilled in the last 5 min
          {" · "}
          queue {depth} deep
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, flexShrink: 0 }}>
        {sinceLabel && (
          <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>since {sinceLabel}</span>
        )}
        <button
          type="button"
          onClick={handleRaise}
          title={`${lane} → ${raiseTo}s`}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "4px 12px",
            borderRadius: 999,
            background: "var(--cc-surface)",
            color: "var(--cc-waiting)",
            border: "1px solid var(--cc-waiting)",
          }}
        >
          Raise threshold
        </button>
        <button
          type="button"
          onClick={handleHold}
          title={`${lane} → off`}
          style={{
            fontSize: 11,
            fontWeight: 600,
            padding: "4px 12px",
            borderRadius: 999,
            background: "var(--cc-surface)",
            color: "var(--cc-dim)",
            border: "1px solid var(--cc-border)",
          }}
        >
          Hold local
        </button>
      </div>
    </div>
  );
}
