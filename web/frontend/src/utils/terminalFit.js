/**
 * Shared helpers for the xterm.js FitAddon "measure the container, resize the
 * terminal, notify the backend PTY" flow used by both TerminalPane.jsx and
 * PopoutTerminal.jsx.
 *
 * Extracted so the dedupe/visibility-guard logic can be unit-tested without
 * needing a real xterm.js instance (which requires canvas/DOM measurement
 * that jsdom can't provide).
 */

/** Minimum container dimension (px) below which fit()/measurement is unreliable
 *  — the pane is hidden (display:none), mid CSS-transition, or not laid out yet. */
export const MIN_MEASURABLE_SIZE = 10;

/**
 * True when a container element has enough size to safely fit()/measure a
 * terminal into. Guards against measuring a hidden or zero-size box, which
 * would send garbage (or zero) dimensions to the backend.
 */
export function isContainerMeasurable(el) {
  return !!el && el.clientWidth >= MIN_MEASURABLE_SIZE && el.clientHeight >= MIN_MEASURABLE_SIZE;
}

/**
 * True when `next` differs from the last {cols, rows} successfully sent to
 * the backend. Used to dedupe redundant WS "resize" messages — e.g. several
 * debounced fits in a row that all settle on the same size, or a fit() that
 * runs after a no-op event.
 */
export function dimsChanged(prev, next) {
  if (!prev || !next) return true;
  return prev.cols !== next.cols || prev.rows !== next.rows;
}

/**
 * Trailing-edge debounce. Returns a wrapped function that invokes `fn` only
 * after `wait` ms of quiet since the last call. Exposes `.cancel()` so
 * callers can clear a pending invocation (e.g. on component unmount) without
 * needing to track the timer id themselves.
 */
export function debounce(fn, wait) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

// ---------------------------------------------------------------------------
// Terminal zoom persistence — shared between App.jsx (the source of truth
// while a pane is docked in the main window) and PopoutTerminal.jsx (a
// separate window/document with no React state link to App.jsx, so it must
// read + watch the persisted value directly via localStorage).
// ---------------------------------------------------------------------------

export const ZOOM_STORAGE_KEY = "cockpit-terminal-zoom";
export const DEFAULT_ZOOM = 13;
export const MIN_ZOOM = 8;
export const MAX_ZOOM = 28;

// ---------------------------------------------------------------------------
// PTY spawn-time fallback dimensions
// ---------------------------------------------------------------------------

/**
 * Pre-mount default cols/rows sent to POST /api/terminals when creating a
 * brand-new session. At createSession() time in App.jsx, the new session's
 * pane hasn't rendered yet (it's added to `sessions`/`activeIds` React state
 * in the same tick as the fetch, before the DOM commits), so there is no
 * mounted TerminalPane/termRef to measure a real size from — this is NOT an
 * arbitrary magic number, it is the necessary placeholder until the pane
 * mounts. TerminalPane's post-mount `safeFit()` (double-rAF after `term.open()`)
 * immediately measures the ACTUAL pane box and sends a corrective "resize" over
 * the WebSocket, so this value only matters for the few frames between spawn
 * and first paint.
 */
export const DEFAULT_SPAWN_COLS = 120;
export const DEFAULT_SPAWN_ROWS = 30;

/**
 * Read the persisted terminal zoom level (xterm font size in px) from
 * localStorage, clamped to [MIN_ZOOM, MAX_ZOOM]. Falls back to DEFAULT_ZOOM
 * on any error (quota/security exceptions, corrupt JSON, out-of-range value).
 */
export function loadPersistedZoom() {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    const value = raw != null ? JSON.parse(raw) : DEFAULT_ZOOM;
    return (value >= MIN_ZOOM && value <= MAX_ZOOM) ? value : DEFAULT_ZOOM;
  } catch {
    return DEFAULT_ZOOM;
  }
}
