/**
 * Pure helpers for detecting when a peer bridge (V2) or channel (V3) run has
 * ended, so App.jsx can surface a Toast with the reason instead of letting
 * the pulsing pane glow simply vanish with no explanation.
 *
 * Backend contract (see bridge_manager.py — `_BridgeRecord.to_dict()` /
 * `_ChannelRecord.to_dict()`):
 *   - Records carry `state`:
 *       "active" | "ended_user" | "ended_sentinel" | "ended_capped" | "errored"
 *   - Recently-ended records REMAIN in the GET /api/bridge (or
 *     /api/bridge/channel) response for a TTL (~60s, `_RECORD_TTL`) before
 *     the backend prunes them. So the moment a record transitions from
 *     "active" to a terminal state between two polls is a reliable "end"
 *     signal. If a record's TTL expires between two polls (or the backend
 *     restarts), it simply vanishes from the payload with no final state
 *     visible to the frontend — that is treated as a generic "ended" event
 *     (`endState: null`) since the exact reason is lost.
 *
 * These helpers hold no React state of their own. Callers (App.jsx) own two
 * pieces of state across polls, stored in refs so they survive re-renders
 * without themselves triggering one:
 *   - prevStates: Map<id, lastSeenRecord> — seeded (silently) on the first
 *     poll a given id is observed, then updated every poll so the NEXT poll
 *     can detect an active -> terminal transition.
 *   - seenIds: Set<id> — ids that have already fired an end event, ever.
 *     Guarantees each id fires at most once no matter how many more polls
 *     observe it in a terminal state, or how it eventually vanishes.
 *
 * computeEndEvents() MUTATES both prevStates and seenIds in place (the same
 * shape as a memoization cache) so the call site in App.jsx stays a
 * one-liner per poll instead of juggling three separate pieces of returned
 * state across renders.
 */

export const BRIDGE_KIND = "bridge";
export const CHANNEL_KIND = "channel";

const ID_FIELD = {
  [BRIDGE_KIND]: "bridge_id",
  [CHANNEL_KIND]: "channel_id",
};

/**
 * Compute the "end events" for one poll cycle.
 *
 * @param {"bridge"|"channel"} kind
 * @param {Array<object>} records - the fresh array from GET /api/bridge
 *   ("bridges") or GET /api/bridge/channel ("channels"). Tolerates
 *   non-arrays, null/non-object entries, and entries missing id/state — all
 *   are silently skipped rather than throwing.
 * @param {Map<string, object>} prevStates - last-seen record per id, from
 *   the previous call. Mutated in place to reflect this poll's records.
 * @param {Set<string>} seenIds - ids that have already fired an end event.
 *   Mutated in place: ids that fire during this call are added.
 * @returns {Array<{id: string, kind: string, endState: string|null, record: object}>}
 *   `endState` is null for the "vanished from payload" case (generic ended,
 *   reason unknown). Never throws.
 */
export function computeEndEvents(kind, records, prevStates, seenIds) {
  const idField = ID_FIELD[kind];
  if (!idField || !(prevStates instanceof Map) || !(seenIds instanceof Set)) {
    return [];
  }

  const list = Array.isArray(records) ? records : [];
  const events = [];
  const currentIds = new Set();

  for (const rec of list) {
    if (!rec || typeof rec !== "object") continue;
    const id = rec[idField];
    if (typeof id !== "string" || !id) continue;
    const state = rec.state;
    if (typeof state !== "string" || !state) continue;

    currentIds.add(id);
    const prev = prevStates.get(id);

    // Fire only on a genuine active -> terminal transition, and only once
    // ever per id (seenIds guard). A record observed already-ended on the
    // very first poll we ever see it (prev === undefined) is seeded
    // silently — no toast storm on app reload while a recently-ended record
    // is still inside the backend's TTL window.
    if (state !== "active" && prev && prev.state === "active" && !seenIds.has(id)) {
      events.push({ id, kind, endState: state, record: rec });
      seenIds.add(id);
    }

    prevStates.set(id, rec);
  }

  // Vanished: tracked as active on a previous poll, absent from this poll's
  // payload entirely (TTL-prune race, or backend restart). Fire a generic
  // "ended" event using the last known snapshot, then drop it from
  // prevStates — bridge/channel ids are server-generated UUIDs that never
  // recur, so there is nothing to keep watching for.
  for (const [id, prev] of prevStates) {
    if (currentIds.has(id)) continue;
    if (prev.state === "active" && !seenIds.has(id)) {
      events.push({ id, kind, endState: null, record: prev });
      seenIds.add(id);
    }
    prevStates.delete(id);
  }

  return events;
}

/**
 * Turn a computeEndEvents() event into `{ message, type }` for the Toast
 * system (`useToast().toast(message, type)`). `type` mirrors the existing
 * Toast call sites in App.jsx — only `errored` gets error styling; every
 * other terminal state is informational.
 */
export function formatEndEventToast(event) {
  if (!event || typeof event !== "object") {
    return { message: "Bridge ended", type: "info" };
  }
  const kindLabel = event.kind === CHANNEL_KIND ? "Channel" : "Bridge";
  const record = event.record && typeof event.record === "object" ? event.record : {};
  const namesPart = describeNames(event.kind, record);
  const prefix = namesPart ? `${kindLabel} ${namesPart}` : kindLabel;

  switch (event.endState) {
    case "ended_capped": {
      const turnsUsed = record.turns_used;
      const maxTurns = record.max_turns;
      const hasCounts = Number.isFinite(turnsUsed) && Number.isFinite(maxTurns);
      const reason = hasCounts
        ? `turn limit reached (${turnsUsed}/${maxTurns})`
        : "turn limit reached";
      return { message: `${prefix} ended: ${reason}`, type: "info" };
    }
    case "ended_sentinel":
      return { message: `${prefix} ended: task completed (BRIDGE-DONE)`, type: "info" };
    case "ended_user":
      return { message: `${prefix} stopped`, type: "info" };
    case "errored":
      return { message: `${prefix} failed — a session died or a write failed`, type: "error" };
    default:
      // null (vanished / TTL race) or an unrecognised future state string —
      // still tell the user *something* ended rather than staying silent.
      return { message: `${prefix} ended`, type: "info" };
  }
}

/** Map of terminalId -> BRIDGE_KIND | CHANNEL_KIND for every session taking part
 *  in an active bridge or channel.
 *
 *  This MUST return a Map, not a Set: BridgeModal calls `.has()` AND `.get()`
 *  on it, because the value is the reason string its BusyHint renders as
 *  "BUSY · in bridge" / "in channel". A Set satisfies `.has()` but has no
 *  `.get()`, so handing one over crashes the modal with "x.get is not a
 *  function" as soon as a session row renders. That regressed in v1.4.0 (the
 *  modal gained the reason label while its producer stayed a Set) and survived
 *  a green test suite because the modal's own tests passed a hand-built Map —
 *  which is why this lives here, shared by App and its test, instead of being
 *  reimplemented in either.
 *
 *  First writer wins, so a session somehow in both keeps a stable label (the
 *  backend's 409 conflict guard should make that combination impossible). */
export function buildBusyTerminalIds(activeBridges, channels) {
  const busy = new Map();
  const mark = (id, reason) => {
    if (id && !busy.has(id)) busy.set(id, reason);
  };
  for (const b of Array.isArray(activeBridges) ? activeBridges : []) {
    if (b?.state !== "active") continue;
    mark(b.from_id, BRIDGE_KIND);
    mark(b.to_id, BRIDGE_KIND);
  }
  for (const ch of Array.isArray(channels) ? channels : []) {
    if (ch?.state !== "active") continue;
    mark(ch.lead_id, CHANNEL_KIND);
    if (Array.isArray(ch.worker_ids)) for (const w of ch.worker_ids) mark(w, CHANNEL_KIND);
  }
  return busy;
}

/** Build the "Session A ↔ Session B" (bridge) or "Lead + N workers" (channel)
 *  name fragment for a toast, or "" if the record doesn't expose names. */
function describeNames(kind, record) {
  if (kind === CHANNEL_KIND) {
    const leadName = typeof record.lead_name === "string" && record.lead_name ? record.lead_name : null;
    if (!leadName) return "";
    const workerNames = record.worker_names && typeof record.worker_names === "object"
      ? Object.values(record.worker_names)
      : [];
    const count = workerNames.length;
    return count > 0 ? `${leadName} + ${count} worker${count === 1 ? "" : "s"}` : leadName;
  }
  const fromName = typeof record.from_name === "string" && record.from_name ? record.from_name : null;
  const toName = typeof record.to_name === "string" && record.to_name ? record.to_name : null;
  if (fromName && toName) return `${fromName} ↔ ${toName}`;
  return fromName || toName || "";
}
