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
export const MAILBOX_KIND = "mailbox";

const ID_FIELD = {
  [BRIDGE_KIND]: "bridge_id",
  [CHANNEL_KIND]: "channel_id",
  [MAILBOX_KIND]: "mailbox_id",
};

/** States in which a run is still LIVE — it holds its sessions and must not
 *  fire an end event.
 *
 *  `awaiting_human` is the V4 mailbox bridge paused at its round cap. It is
 *  emphatically NOT an end: the sessions are still enrolled, their watchers are
 *  still armed, and granting more rounds resumes the same conversation. Testing
 *  `state !== "active"` — which is what this module did while V2/V3 were the
 *  only producers — would toast "Bridge ended" at every pause and then again
 *  for real later, and the `seenIds` guard means the SECOND one (the true end)
 *  would be the one suppressed.
 *
 *  V2/V3 never emit `awaiting_human`, so widening this is a no-op for them. */
const LIVE_STATES = new Set(["active", "awaiting_human"]);

/** True if *state* means the run is over. */
export function isTerminalState(state) {
  return typeof state === "string" && !!state && !LIVE_STATES.has(state);
}

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
    if (isTerminalState(state) && prev && LIVE_STATES.has(prev.state) && !seenIds.has(id)) {
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
    if (LIVE_STATES.has(prev.state) && !seenIds.has(id)) {
      events.push({ id, kind, endState: null, record: prev });
      seenIds.add(id);
    }
    prevStates.delete(id);
  }

  return events;
}

/**
 * Detect mailbox bridges that have just entered `awaiting_human`.
 *
 * This is the counterpart to computeEndEvents and it exists because a pause is
 * the one state that REQUIRES the user to act: the bridge has stopped, every
 * session is standing by with its watcher armed, and nothing resumes until a
 * human grants more rounds or stops it. A silent pause looks exactly like a
 * bridge that quietly died — the ambiguity this whole redesign is trying to
 * remove.
 *
 * `seenPausedIds` is mutated in place and guarantees one announcement per
 * pause, not one per 3-second poll. An id is REMOVED from it when the bridge
 * goes live again, so a second pause after an extend announces itself too.
 *
 * @returns {Array<object>} the records that just paused.
 */
export function computePauseEvents(records, seenPausedIds) {
  if (!(seenPausedIds instanceof Set)) return [];
  const events = [];
  for (const rec of Array.isArray(records) ? records : []) {
    if (!rec || typeof rec !== "object") continue;
    const id = rec.mailbox_id;
    if (typeof id !== "string" || !id) continue;
    if (rec.state === "awaiting_human") {
      if (!seenPausedIds.has(id)) {
        seenPausedIds.add(id);
        events.push(rec);
      }
    } else {
      seenPausedIds.delete(id);
    }
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
    case "ended_agreed":
      // V4 only. Distinct from V2/V3's `ended_sentinel` on purpose: that fired
      // when ONE side said BRIDGE-DONE, this one means every participant agreed
      // and nothing was left unanswered.
      return { message: `${prefix} finished — all sides agreed`, type: "info" };
    case "ended_capped": {
      // V4 reaches this only when a pause went unanswered until the human gate
      // expired, so `end_reason` carries the real explanation and is preferred
      // over the generic turn-limit wording.
      if (typeof record.end_reason === "string" && record.end_reason) {
        return { message: `${prefix} ended: ${record.end_reason}`, type: "info" };
      }
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
    case "errored": {
      if (typeof record.end_reason === "string" && record.end_reason) {
        return { message: `${prefix} failed: ${record.end_reason}`, type: "error" };
      }
      return { message: `${prefix} failed — a session died or a write failed`, type: "error" };
    }
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
export function buildBusyTerminalIds(activeBridges, channels, mailboxes) {
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
  // A PAUSED mailbox bridge still owns its sessions — see LIVE_STATES. Testing
  // `=== "active"` here would let the user start a second bridge on a session
  // that is mid-conversation and merely waiting for them to grant rounds.
  for (const mbx of Array.isArray(mailboxes) ? mailboxes : []) {
    if (isTerminalState(mbx?.state)) continue;
    if (!mbx?.state) continue;
    mark(mbx.lead_id, MAILBOX_KIND);
    if (Array.isArray(mbx.worker_ids)) for (const w of mbx.worker_ids) mark(w, MAILBOX_KIND);
  }
  return busy;
}

/** Build the "Session A ↔ Session B" (bridge) or "Lead + N workers" (channel)
 *  name fragment for a toast, or "" if the record doesn't expose names. */
function describeNames(kind, record) {
  if (kind === MAILBOX_KIND) {
    const participants = Array.isArray(record.participants) ? record.participants : [];
    const lead = participants.find((p) => p?.role === "lead");
    const workers = participants.filter((p) => p?.role === "worker");
    if (!lead?.name) return "";
    return workers.length
      ? `${lead.name} + ${workers.length} worker${workers.length === 1 ? "" : "s"}`
      : lead.name;
  }
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
