/* eslint-disable react-refresh/only-export-components -- formatDuration is
   re-exported here so it stays unit-testable in isolation (see CLAUDE.md
   conventions for pure helpers alongside components). */
import { ExternalLink, ChevronDown, Cpu } from "lucide-react";

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

/* THE SHADOW NOTE IS GONE (T11, 2026-08-04).
 *
 * It rendered "queueing off · shadow" instead of the live meter, because a
 * shadow broker reports 0 in flight / 0 queued and that is indistinguishable
 * from a healthy idle lane. S10's ruling was that BOTH states must be visible
 * and must not look alike -- showing the meter was one lie ("nothing is
 * waiting"), and omitting the strip entirely was the other ("this build has no
 * queueing").
 *
 * That ruling is not overturned; its premise is. There is no broker and no
 * queue, so "queueing exists and is switched off" is no longer a state this
 * build can be in -- the honest reading of the strip's absence of a shadow
 * note is now simply TRUE. What remains is the in-engine readout, which counts
 * vLLM's own running/waiting sequences and was never a broker fact.
 */

/** The live lane readout.
 *
 *  SPILL WAS REMOVED 2026-08-03 and this component lost three controls with
 *  it: the fill bar (it was the fraction of the way to a spill trigger), the
 *  spill on/off switch, and the "spill 30s" label. There is no threshold left,
 *  so there is nothing to be a fraction of -- a bar drawn against no trigger
 *  would be decoration pretending to be a measurement, and this strip exists
 *  to refuse exactly that.
 *
 *  What remains is what was always measured rather than compared: how many
 *  requests are in flight, how many are queued behind them, and how long the
 *  lane is expected to take to drain. */
function LaneMeter({ lane, onOpenLaneDetails }) {
  if (!lane) return null;

  const inFlight = Number.isFinite(lane.inFlight) ? lane.inFlight : 0;
  const queued = Number.isFinite(lane.queued) ? lane.queued : 0;
  const predictedWait = Number.isFinite(lane.predictedWaitSeconds) ? lane.predictedWaitSeconds : null;
  const clear = Number.isFinite(lane.estimatedClearSeconds) ? lane.estimatedClearSeconds : null;

  const sentence = `${inFlight} in flight, ${queued} queued. Predicted wait ${formatDuration(
    predictedWait
  )}. Estimated clear in ${formatDuration(clear)}.`;

  return (
    <div
      data-testid="lane-meter"
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
      <span style={{ fontSize: 10, whiteSpace: "nowrap", color: "var(--cc-dim)" }}>
        ~{formatDuration(clear)}
      </span>
      <button
        onClick={onOpenLaneDetails}
        className="hover-bg-elevated transition-colors"
        style={{ display: "flex", flexShrink: 0, color: "var(--cc-muted)", background: "transparent", border: "none", padding: 2 }}
        title="Open the lane in Engine"
        aria-label="Open the lane in Engine"
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
  onOpenLaneDetails,
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
      <LaneMeter lane={lane} onOpenLaneDetails={onOpenLaneDetails} />
    </div>
  );
}
