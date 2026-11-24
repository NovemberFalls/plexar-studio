export { attachCodexHistoryScroll } from "./codexHistoryScroll";

// A fresh view requests the retained stream; a reconnect requests only data
// already accepted into neither xterm nor our pending write buffer.
export function createReplayCursor() { return { seq: null }; }

export function replayQuery(cursor) {
  return `?replay=1${cursor.seq === null ? "" : `&after=${cursor.seq}`}`;
}

// `begin`/`end` are optional and only observe the burst; they never touch the
// cursor. `full` is true when the burst rebuilds the whole view (a fresh pane or
// a replacement snapshot), false for the short delta of a reconnect.
// `resize` is optional: the server announces the PTY's size whenever it changes
// (including an echo of this pane's own resize). The frame is always handled,
// even malformed, so it can never be written into the terminal as text.
export function consumeReplayFrame(raw, cursor, { reset, enqueue, warning, begin, end, resize }) {
  if (typeof raw !== "string" || !raw.startsWith("{")) return false;
  let frame;
  try { frame = JSON.parse(raw); } catch { return false; }
  if (frame === null || typeof frame !== "object") return false;
  if (frame.type === "resize") {
    const { cols, rows } = frame;
    // Bounded: xterm allocates per cell, so an absurd size must never reach it.
    if (Number.isSafeInteger(cols) && Number.isSafeInteger(rows) && cols > 0 && rows > 0 && cols <= 1000 && rows <= 500) {
      resize?.(cols, rows);
    }
    return true;
  }
  if (frame.type === "replay_start") {
    const full = frame.reset === true || cursor.seq === null;
    if (frame.reset === true) { cursor.seq = null; reset(); }
    begin?.({ full });
    // A delta reconnect does not restore the older missing prefix. Keep its
    // notice until a replacement snapshot can establish complete history.
    if (frame.reset === true || frame.truncated === true) {
      warning(frame.truncated === true
        ? "Older terminal output is unavailable; showing the retained portion."
        : null);
    }
    return true;
  }
  if (frame.type === "replay_end") {
    if (Number.isSafeInteger(frame.seq) && frame.seq >= 0) cursor.seq = Math.max(cursor.seq ?? 0, frame.seq);
    end?.();
    return true;
  }
  if (frame.type !== "output" || !Number.isSafeInteger(frame.seq) || frame.seq < 0 || typeof frame.data !== "string") return false;
  if (cursor.seq !== null && frame.seq <= cursor.seq) return true;
  enqueue(frame.data);
  // The write buffer belongs to the pane, not the socket, and survives a
  // disconnect. Record acceptance now so a reconnect before the next animation
  // frame cannot duplicate output. Reset/unmount discards this cursor too.
  cursor.seq = frame.seq;
  return true;
}

// A full replay used to be written frame by frame, so a pane coming into view
// (a page change remounts it) visibly ran its whole history from the top down.
// While a hold is active the pane keeps buffering and stays hidden; release
// writes the buffer in ONE call, pins the view to the bottom, then shows it.
// The deadline is a fallback only: if replay_end never arrives the pane is shown
// and output streams as it always did, so a hold can never leave a pane blank.
export const REPLAY_HOLD_MAX_MS = 4000;

export function createReplayHold({ hide, show, takePending, write, scrollToBottom,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let held = false;
  let timer = null;
  const release = () => {
    if (!held) return;
    held = false;
    clearTimer(timer);
    timer = null;
    const data = takePending();
    const reveal = () => { scrollToBottom(); show(); };
    if (data) write(data, reveal); else reveal();
  };
  return {
    get active() { return held; },
    begin() {
      if (held) return;
      held = true;
      hide();
      timer = setTimer(release, REPLAY_HOLD_MAX_MS);
    },
    release,
    // The pane is going away or switching PTY: drop the hold without writing.
    cancel() {
      if (!held) return;
      held = false;
      clearTimer(timer);
      timer = null;
      show();
    },
  };
}

export function preserveCodexScrollback(terminal, enabled) {
  // Let xterm parse chunked escape sequences. Only ED3 (erase saved lines) is
  // intercepted; ED2 and cursor movement still repaint the CLI normally. An
  // explicit host reset for a different PTY/replay snapshot remains effective.
  return terminal.parser?.registerCsiHandler?.({ final: "J" }, (params) =>
    enabled() && params.length === 1 && params[0] === 3);
}
