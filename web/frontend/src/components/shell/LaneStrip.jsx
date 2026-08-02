/* eslint-disable react-refresh/only-export-components -- formatDuration is
   re-exported here so it stays unit-testable in isolation (see CLAUDE.md
   conventions for pure helpers alongside components). */
import { ExternalLink, ChevronDown, Cpu } from "lucide-react";
import { pressureFraction } from "../../utils/laneMath";

/** Map a session's activity state/status to a --cc-* state color token.
 * Mirrors the STATE_COLOR semantics already established in Sidebar.jsx /
 * TopBar.jsx — do not recompute lane numbers here, they arrive as props. */
const STATE_COLOR = {
  busy: "var(--cc-working)",
  working: "var(--cc-working)",
  thinking: "var(--cc-thinking)",
  waiting: "var(--cc-waiting)",
  idle: "var(--cc-idle)",
  running: "var(--cc-idle)",
  error: "var(--cc-error)",
  starting: "var(--cc-muted)",
  history: "var(--cc-muted)",
};
function getStateColor(status) {
  return STATE_COLOR[status] || STATE_COLOR.idle;
}

/** Pure formatter: 130 -> "2m10s", 45 -> "45s", null/NaN -> "-". */
export function formatDuration(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

function SessionChip({ session, isFocused, paneSlot, isPoppedOut, onSelectSession, onChipDragStart }) {
  // Mirror App.jsx's pane-grid derivation so the strip and the panes cannot
  // disagree: session.status only ever holds running/starting/exited — real
  // activity (busy/thinking/waiting/idle) lives on session.activityState.
  const actState = session?.activityState || (session?.status === "running" ? "idle" : session?.status);
  const color = getStateColor(actState);
  const needsAttention = actState === "waiting";

  const style = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 26,
    borderRadius: 8,
    padding: "0 10px",
    fontSize: 11,
    whiteSpace: "nowrap",
    minWidth: 0,
    overflow: "hidden",
    flexShrink: 1,
    cursor: "pointer",
    background: "var(--cc-surface)",
    border: "1px solid var(--cc-border)",
    color: "var(--cc-fg)",
  };

  if (isFocused) {
    style.background = "color-mix(in srgb, var(--cc-accent) 12%, transparent)";
    style.border = "1px solid color-mix(in srgb, var(--cc-accent) 40%, transparent)";
  } else if (needsAttention) {
    style.background = "color-mix(in srgb, var(--cc-waiting) 12%, transparent)";
    style.border = "1px solid color-mix(in srgb, var(--cc-waiting) 40%, transparent)";
  }

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => onChipDragStart?.(e, session.id)}
      onClick={() => onSelectSession?.(session.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelectSession?.(session.id);
      }}
      className="hover-bg-elevated transition-colors"
      style={style}
      title={session?.name || session?.id}
      aria-label={`Select session ${session?.name || session?.id}`}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          flexShrink: 0,
          background: color,
          boxShadow: "0 0 6px currentColor",
          color,
        }}
      />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>
        {session?.name || session?.id}
      </span>
      {needsAttention && (
        <span
          style={{
            flexShrink: 0,
            fontSize: 9,
            fontWeight: 800,
            color: "var(--cc-waiting)",
            letterSpacing: ".06em",
          }}
        >
          NEEDS YOU
        </span>
      )}
      {isPoppedOut ? (
        <span
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 3,
            opacity: 0.6,
            fontSize: 9,
          }}
        >
          <ExternalLink size={9} />
          popped out
        </span>
      ) : (
        paneSlot != null && (
          <span
            style={{
              flexShrink: 0,
              fontSize: 9,
              minWidth: 13,
              height: 13,
              padding: "0 3px",
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--cc-elev)",
              color: "var(--cc-muted)",
            }}
          >
            {paneSlot}
          </span>
        )
      )}
    </div>
  );
}

function NewChip({ onNew }) {
  return (
    <button
      onClick={onNew}
      className="hover-bg-elevated transition-colors"
      style={{
        display: "flex",
        alignItems: "center",
        height: 26,
        borderRadius: 8,
        padding: "0 10px",
        fontSize: 11,
        flexShrink: 0,
        background: "transparent",
        border: "1px dashed var(--cc-border)",
        color: "var(--cc-dim)",
      }}
      title="Start a new session"
      aria-label="Start a new session"
    >
      + New
    </button>
  );
}

/** The broker is running in SHADOW: it forwards and logs, and never queues.
 *
 *  Rendering the live meter here would be a lie in the most expensive
 *  direction -- "0 in flight, 0 queued" is indistinguishable from a healthy
 *  idle lane, so the user reads "nothing is waiting" when the truth is
 *  "nothing is ever queued on this build". Measured in
 *  `lane_broker/tests/test_shadow_default_is_inert.py`: with a spill threshold
 *  of 0.0 seconds and seeded history, shadow still produced zero spills.
 *
 *  Omitting the meter would be the OTHER lie, and it is the one S9 spent a
 *  whole unit removing from the model picker: absence reads as "this build has
 *  no queueing", which is a different claim from "queueing exists and is
 *  switched off". Both states must be visible and must not look alike. */
function LaneShadowNote({ onOpenSpillDetails }) {
  const sentence =
    "Queueing is not active: the lane broker is running in shadow mode, so requests are " +
    "forwarded and logged but never queued, and spill thresholds cannot trigger. " +
    "Set COCKPIT_BROKER_SHADOW=0 and restart to enable queueing.";
  return (
    <div
      data-testid="lane-shadow-note"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        borderRadius: 8,
        padding: "0 8px",
        flexShrink: 0,
        border: "1px dashed var(--cc-border)",
        background: "transparent",
      }}
      title={sentence}
      aria-label={sentence}
    >
      <Cpu size={12} style={{ color: "var(--cc-muted)", flexShrink: 0 }} />
      <span style={{ fontSize: 10, whiteSpace: "nowrap", color: "var(--cc-muted)" }}>
        queueing off · shadow
      </span>
      <button
        onClick={onOpenSpillDetails}
        className="hover-bg-elevated transition-colors"
        style={{ display: "flex", flexShrink: 0, color: "var(--cc-muted)", background: "transparent", border: "none", padding: 2 }}
        title="Why queueing is not active"
        aria-label="Why queueing is not active"
      >
        <ChevronDown size={12} />
      </button>
    </div>
  );
}

function LanePressureMeter({ lane, spillEnabled, onToggleSpill, onOpenSpillDetails }) {
  if (!lane) return null;
  // Checked BEFORE any number is read: in shadow every one of them is a
  // structural zero, not a measurement.
  if (lane.shadow) return <LaneShadowNote onOpenSpillDetails={onOpenSpillDetails} />;

  const inFlight = Number.isFinite(lane.inFlight) ? lane.inFlight : 0;
  const queued = Number.isFinite(lane.queued) ? lane.queued : 0;
  const predictedWait = Number.isFinite(lane.predictedWaitSeconds) ? lane.predictedWaitSeconds : null;
  const threshold = Number.isFinite(lane.thresholdSeconds) ? lane.thresholdSeconds : null;
  const clear = Number.isFinite(lane.estimatedClearSeconds) ? lane.estimatedClearSeconds : null;

  const fraction = pressureFraction(predictedWait, threshold);
  const spillOff = fraction == null;
  const pct = spillOff ? 0 : fraction * 100;

  const sentence = `${inFlight} in flight, ${queued} queued. Predicted wait ${formatDuration(
    predictedWait
  )}${threshold != null ? ` against a ${formatDuration(threshold)} spill threshold` : ""}. Estimated clear in ${formatDuration(
    clear
  )}. Spill is ${spillOff ? "off — no threshold set for this class" : spillEnabled ? "on" : "off"}.`;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        borderRadius: 8,
        padding: "0 8px",
        flexShrink: 0,
        border: "1px solid color-mix(in srgb, var(--cc-waiting) 45%, transparent)",
        background: "color-mix(in srgb, var(--cc-waiting) 8%, transparent)",
      }}
      title={sentence}
      aria-label={sentence}
    >
      <Cpu size={12} style={{ color: "var(--cc-waiting)", flexShrink: 0 }} />
      <span style={{ fontSize: 11, fontWeight: 700, whiteSpace: "nowrap", color: "var(--cc-fg)" }}>
        {inFlight}
        <span style={{ color: "var(--cc-muted)" }}>{"▸"}</span>
        {queued}
      </span>
      <div
        style={{
          width: 50,
          height: 5,
          borderRadius: 999,
          background: "var(--cc-elev)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {spillOff ? (
          <div
            style={{
              width: "100%",
              height: "100%",
              background:
                "repeating-linear-gradient(45deg, color-mix(in srgb, var(--cc-muted) 35%, transparent) 0 3px, transparent 3px 6px)",
            }}
          />
        ) : (
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              background: "var(--cc-waiting)",
            }}
          />
        )}
      </div>
      <span style={{ fontSize: 10, whiteSpace: "nowrap", color: "var(--cc-dim)" }}>
        ~{formatDuration(clear)}
      </span>
      <span style={{ fontSize: 10, whiteSpace: "nowrap", color: "var(--cc-muted)" }}>
        {spillOff ? "spill off" : `spill ${formatDuration(threshold)}`}
      </span>
      <button
        role="switch"
        aria-checked={spillEnabled}
        aria-label="Toggle spill"
        title={spillEnabled ? "Spill enabled — click to disable" : "Spill disabled — click to enable"}
        onClick={() => onToggleSpill?.(!spillEnabled)}
        style={{
          width: 26,
          height: 14,
          borderRadius: 999,
          flexShrink: 0,
          border: "1px solid var(--cc-border)",
          background: spillEnabled ? "var(--cc-waiting)" : "var(--cc-elev)",
          position: "relative",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 1,
            left: spillEnabled ? 13 : 1,
            width: 10,
            height: 10,
            borderRadius: 999,
            background: "var(--cc-bg)",
            transition: "left .15s ease",
          }}
        />
      </button>
      <button
        onClick={onOpenSpillDetails}
        className="hover-bg-elevated transition-colors"
        style={{ display: "flex", flexShrink: 0, color: "var(--cc-muted)", background: "transparent", border: "none", padding: 2 }}
        title="Open per-class spill thresholds"
        aria-label="Open per-class spill thresholds"
      >
        <ChevronDown size={12} />
      </button>
    </div>
  );
}

export default function LaneStrip({
  sessions,
  paneSlotById,
  focusedSessionId,
  poppedOutIds,
  onSelectSession,
  onNew,
  onChipDragStart,
  lane,
  spillEnabled,
  onToggleSpill,
  onOpenSpillDetails,
}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const hasSlot = paneSlotById && typeof paneSlotById.get === "function";
  const hasPoppedOut = poppedOutIds && typeof poppedOutIds.has === "function";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 40,
        padding: "0 10px",
        gap: 7,
      }}
    >
      {/* Scroll wrapper: sized by the outer strip (flex:1, minWidth:0) but
          scrolls its own content horizontally rather than shrinking chips
          into illegibility. The inner row is width:max-content so it sizes
          to the chips' natural widths — flexShrink on the chips only ever
          matters if a chip itself needs to truncate a long name, never as a
          side effect of the row running out of room. */}
      <div style={{ flex: 1, minWidth: 0, overflowX: "auto", overflowY: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, width: "max-content" }}>
          {list.map((session) => (
            <SessionChip
              key={session.id}
              session={session}
              isFocused={session.id === focusedSessionId}
              paneSlot={hasSlot ? paneSlotById.get(session.id) : null}
              isPoppedOut={hasPoppedOut ? poppedOutIds.has(session.terminalId) : false}
              onSelectSession={onSelectSession}
              onChipDragStart={onChipDragStart}
            />
          ))}
          <NewChip onNew={onNew} />
        </div>
      </div>
      <LanePressureMeter
        lane={lane}
        spillEnabled={spillEnabled}
        onToggleSpill={onToggleSpill}
        onOpenSpillDetails={onOpenSpillDetails}
      />
    </div>
  );
}
