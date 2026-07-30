/**
 * DepthWaitPanel — screen 4b, the depth ↔ wait translation table.
 *
 * WHY THIS EXISTS, and why it sits BESIDE the control rather than inside a
 * tooltip: a spill threshold is stored in SECONDS, but what an operator
 * actually watches is a queue — "one job ahead of me". "30 seconds" only means
 * something once you can see that, at this machine's measured median wall time,
 * 30 seconds is "one request ahead of you, and the second one spills". The
 * handoff is explicit that this table is what makes the number comprehensible,
 * so it is permanent on-screen furniture, not a hover reveal.
 *
 * Every number here comes from utils/laneMath — the same functions the Workspace
 * lane pressure meter uses — so the two cannot drift. In particular the verdict
 * uses `wouldSpill`, which encodes the broker's STRICTLY-GREATER comparison: a
 * predicted wait exactly equal to the threshold still runs locally.
 *
 * When p50 wall is unmeasured (a broker with no completed runs), this panel
 * refuses to guess: every row reads "unknown" and the prose says why. A
 * fabricated "≈0s" here would be the single most damaging lie on the screen.
 *
 * Props:
 *   laneClass         — "interactive" | "worker" | "batch" (labelling only)
 *   p50WallSeconds    — measured median run wall time, or null when unmeasured
 *   thresholdSeconds  — the class's spill trigger in seconds; null = spill off
 *   pending           — true when thresholdSeconds is an unapplied draft value
 */

import { predictedWaitSeconds, wouldSpill } from "../../utils/laneMath";

/** The positions an operator can actually picture. 0 = the lane is empty. */
const AHEAD_ROWS = [0, 1, 2, 4, 7];

const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

/** Seconds → compact duration. Null-safe: unknown renders "—", never "0s". */
function fmt(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function TableRow({ ahead, p50WallSeconds, thresholdSeconds, maxWait }) {
  const wait = predictedWaitSeconds(0, ahead, p50WallSeconds);
  const spills = wouldSpill(wait, thresholdSeconds);
  const unknown = wait === null || spills === null;

  // Bar is scaled against the widest row so the growth is legible; an unknown
  // wait gets no bar at all rather than a zero-width one that reads as "none".
  const pct = unknown || !maxWait ? 0 : Math.min(100, (wait / maxWait) * 100);
  const verdictToken = unknown ? "var(--cc-muted)" : spills ? "var(--cc-error)" : "var(--cc-idle)";
  const verdict = unknown ? "unknown" : spills ? "spills" : "local";

  return (
    <div
      data-testid={`xlate-row-${ahead}`}
      data-verdict={verdict}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        borderRadius: 6,
        // Rows past the trigger are tinted with the error token itself (no raw
        // rgba literals — the mock's rgba(224,105,138,.07) IS --cc-error at 7%).
        background: spills === true ? tint("var(--cc-error)", 7) : "transparent",
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 700, color: "var(--cc-fg)", width: 62, flexShrink: 0 }}>
        {ahead} ahead
      </span>
      <span
        data-testid={`xlate-wait-${ahead}`}
        style={{ fontSize: 11, color: "var(--cc-dim)", width: 52, flexShrink: 0, textAlign: "right" }}
      >
        {unknown ? "?" : fmt(wait)}
      </span>
      <div
        aria-hidden="true"
        style={{
          flex: 1,
          minWidth: 0,
          height: 6,
          borderRadius: 999,
          background: "var(--cc-elev)",
          overflow: "hidden",
        }}
      >
        <div style={{ width: `${pct}%`, height: "100%", background: verdictToken }} />
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: verdictToken,
          width: 46,
          flexShrink: 0,
          textAlign: "right",
        }}
      >
        {verdict}
      </span>
    </div>
  );
}

/** The prose restatement. Says "unknown" out loud when it is unknown. */
function prose(laneClass, p50WallSeconds, thresholdSeconds) {
  if (thresholdSeconds == null) {
    return `Spill is off for ${laneClass}, so nothing in this lane is ever sent to the API — every request waits its turn locally, however long the queue gets.`;
  }
  if (p50WallSeconds == null) {
    return `This broker has not finished a run yet, so there is no measured median wall time and no honest way to say how many requests ${fmt(
      thresholdSeconds
    )} corresponds to. The threshold is still enforced in seconds; the queue-depth equivalence appears once runs complete.`;
  }
  // Largest whole count that still runs locally: ahead * p50 <= threshold.
  const lastLocal = Math.floor(thresholdSeconds / p50WallSeconds);
  const firstSpill = lastLocal + 1;
  return `At a measured median of ${fmt(p50WallSeconds)} per run, a ${fmt(
    thresholdSeconds
  )} trigger means ${laneClass} requests still run locally with up to ${lastLocal} ${
    lastLocal === 1 ? "request" : "requests"
  } ahead of them (${fmt(lastLocal * p50WallSeconds)} of predicted wait). The ${firstSpill}${
    firstSpill === 1 ? "st" : firstSpill === 2 ? "nd" : firstSpill === 3 ? "rd" : "th"
  } spills to the API instead.`;
}

export default function DepthWaitPanel({ laneClass = "interactive", p50WallSeconds, thresholdSeconds, pending }) {
  const p50 = typeof p50WallSeconds === "number" && p50WallSeconds > 0 ? p50WallSeconds : null;
  const threshold =
    typeof thresholdSeconds === "number" && isFinite(thresholdSeconds) && thresholdSeconds >= 0
      ? thresholdSeconds
      : null;
  const maxWait = predictedWaitSeconds(0, AHEAD_ROWS[AHEAD_ROWS.length - 1], p50);

  return (
    <div
      data-testid="depth-wait-panel"
      style={{
        width: 452,
        flexShrink: 0,
        borderRadius: 12,
        background: "var(--cc-surface)",
        border: "1px solid var(--cc-border)",
        padding: 16,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>
          What that threshold means
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--cc-muted)" }}>
          {laneClass}
        </span>
        {pending && (
          <span
            data-testid="xlate-pending"
            title="Showing your unapplied draft value, not the threshold the broker is enforcing."
            style={{
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              padding: "1px 6px",
              borderRadius: 999,
              color: "var(--cc-waiting)",
              background: tint("var(--cc-waiting)", 8),
              border: `1px solid ${tint("var(--cc-waiting)", 35)}`,
            }}
          >
            draft
          </span>
        )}
      </div>

      <div style={{ fontSize: 11, color: "var(--cc-dim)", padding: "6px 0 8px", lineHeight: 1.5 }}>
        Predicted wait is <code>requests ahead × measured median wall</code>
        {p50 == null ? " — median wall is not measured yet." : ` — currently ${fmt(p50)} per run.`}
      </div>

      <div
        role="table"
        aria-label={`Queue depth to predicted wait translation for the ${laneClass} lane`}
        style={{ display: "flex", flexDirection: "column", gap: 2 }}
      >
        {AHEAD_ROWS.map((ahead) => (
          <TableRow
            key={ahead}
            ahead={ahead}
            p50WallSeconds={p50}
            thresholdSeconds={threshold}
            maxWait={maxWait}
          />
        ))}
      </div>

      <div
        data-testid="xlate-prose"
        role="note"
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid var(--cc-line)",
          fontSize: 11,
          lineHeight: 1.5,
          color: "var(--cc-fg)",
        }}
      >
        {prose(laneClass, p50, threshold)}
      </div>

      <div style={{ marginTop: 8, fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.5 }}>
        A wait exactly equal to the trigger still runs locally — the broker spills only when the
        prediction goes over. The lane meter in the Workspace header runs this identical
        calculation, so the two always agree.
      </div>
    </div>
  );
}
