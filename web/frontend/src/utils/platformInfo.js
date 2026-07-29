/**
 * Fetches and caches `GET /api/platform` for the lifetime of the app.
 *
 * The response tells the frontend which OS/PTY backend the backend server is
 * running on: `{ platform: "win32"|"linux"|"darwin", pty_backend:
 * "conpty"|"winpty"|"unix"|null, build_number: number|null }`. This cannot
 * change while the server process is alive, so a single fetch is cached and
 * shared by every terminal (TerminalPane.jsx + PopoutTerminal.jsx) that needs
 * it to decide whether to pass xterm's `windowsPty` construction option.
 *
 * Failure handling: the fetch is expected to fail gracefully — a stale
 * server, a network hiccup, or a short-lived race during startup must never
 * block or crash terminal creation. On any error (including a slow response
 * past FETCH_TIMEOUT_MS), the cached value resolves to `null`, and callers
 * must treat that identically to "platform info unavailable" — i.e. omit
 * `windowsPty` entirely rather than guessing.
 */

const FETCH_TIMEOUT_MS = 1500;

let cachedPromise = null;
// Sentinel-free "has it settled yet" tracking: `resolvedValue` only becomes
// meaningful once `hasResolved` flips true (the resolved value is itself a
// legitimate `null` on failure, so we can't use `resolvedValue == null` as
// the "not yet known" check).
let hasResolved = false;
let resolvedValue = null;

async function fetchPlatformInfo() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch("/api/platform", { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === "object" ? data : null;
  } catch {
    // Network error, timeout/abort, malformed JSON, or fetch unavailable
    // (e.g. some test environments) — treat identically to "unavailable".
    return null;
  }
}

/**
 * Returns a cached Promise that resolves to the platform info object, or
 * `null` if it could not be determined. Safe to call from multiple
 * components/mounts — the underlying fetch only happens once per page load.
 */
export function getPlatformInfo() {
  if (!cachedPromise) {
    cachedPromise = fetchPlatformInfo().then((v) => {
      resolvedValue = v;
      hasResolved = true;
      return v;
    });
  }
  return cachedPromise;
}

/**
 * Synchronous fast-path read: returns the already-resolved platform info (or
 * `null` if the fetch failed) WITHOUT awaiting anything, or the sentinel
 * `PLATFORM_INFO_PENDING` if the fetch hasn't settled yet. Lets a second (or
 * later) TerminalPane/PopoutTerminal mount — which is virtually always the
 * case once the app has been open a moment — construct xterm's `Terminal`
 * with `windowsPty` on the SAME synchronous tick as everything else,
 * matching pre-windowsPty behavior instead of paying the async-gate cost on
 * every single mount. Callers must still call `getPlatformInfo()` to
 * populate the cache in the first place (this never fetches on its own).
 */
export const PLATFORM_INFO_PENDING = Symbol("platform-info-pending");
export function getPlatformInfoSync() {
  return hasResolved ? resolvedValue : PLATFORM_INFO_PENDING;
}

/**
 * Resets the module-level cache. Test-only — production code never needs to
 * re-fetch, since the platform can't change while the server is running.
 */
export function __resetPlatformInfoCacheForTests() {
  cachedPromise = null;
  hasResolved = false;
  resolvedValue = null;
}

/**
 * Builds the `windowsPty` option for xterm's `Terminal` constructor from a
 * platform-info object, or `undefined` if the option should be omitted
 * entirely (non-Windows, unavailable info, unrecognized pty_backend, or a
 * missing/non-numeric build_number). Never returns a partial/guessed object —
 * xterm's typings require backend + buildNumber together.
 */
export function buildWindowsPtyOption(info) {
  if (!info || info.platform !== "win32") return undefined;
  if (info.pty_backend !== "conpty" && info.pty_backend !== "winpty") return undefined;
  if (typeof info.build_number !== "number") return undefined;
  return { backend: info.pty_backend, buildNumber: info.build_number };
}
