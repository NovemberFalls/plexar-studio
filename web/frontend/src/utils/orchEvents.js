// Toasts for the Plexar-Framework's orch run feed (GET /api/framework/orch-events).
// The backend has already dropped ordinary transitions, so every event here has a
// `kind`. `detail` is shown as plain text: it can carry words that came from a
// worker, and React escapes a string child, so it is never treated as markup.

const DETAIL_MAX = 160;

// kind -> [toast type, lead-in]. `gate_pass` is deliberately absent: a passing
// gate is followed by `run_closed`, and two toasts for one good outcome is noise.
const KINDS = {
  refusal: ["warning", "Move refused"],
  gate_fail: ["error", "Gate failed"],
  halted_for_decision: ["warning", "Waiting on your decision"],
  run_closed: ["success", "Run closed"],
};

function clip(text) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s;
}

/** `{type, message}` for an orch event worth a toast, or null for one that is not. */
export function orchEventToast(ev) {
  const spec = ev && typeof ev === "object" && Object.hasOwn(KINDS, ev.kind) ? KINDS[ev.kind] : null;
  if (!spec) return null;
  const bits = [spec[1]];
  if (ev.worker) bits.push(String(ev.worker));
  if (ev.rule) bits.push(`[${ev.rule}]`);
  if (ev.detail) bits.push(clip(ev.detail));
  // A run can close HALTED or ABANDONED too; only a completed one earns the green.
  // `close_status` is the framework's own field; events stored before it existed
  // carry the status only as a word in `detail`.
  const completed = ev.close_status
    ? ev.close_status === "COMPLETED"
    : String(ev.detail || "").split(" ").includes("COMPLETED");
  const type = ev.kind === "run_closed" && !completed ? "info" : spec[0];
  return { type, message: bits.join(" · ") };
}

/** The cursor to poll from next: never moves backwards, never becomes a non-integer. */
export function nextOrchCursor(current, reply) {
  const c = reply?.cursor;
  if (!Number.isSafeInteger(c) || c < 0) return current;
  return current === null ? c : Math.max(current, c);
}
