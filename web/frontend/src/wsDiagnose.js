/**
 * Tell "the origin guard refused us" apart from "the backend is down".
 *
 * A WebSocket refused by `origin_guard` is rejected at the HANDSHAKE — the server
 * closes before `accept()`, which uvicorn turns into an HTTP 403 and the upgrade
 * never completes. The browser reports that as `onerror` + `onclose(1006)`, the
 * exact same event a dead backend produces. The close code and reason the server
 * passed to `close()` are discarded and never reach us.
 *
 * That matters because the two have OPPOSITE remedies. A dead backend is fixed by
 * waiting — which is what the panes already do, reconnecting on a backoff forever.
 * A refused origin is never fixed by waiting: the page was served from somewhere
 * the server does not trust (a stale bundle after a port change, a dev server on an
 * unlisted origin), and the only fix is to reload or correct the origin. Retrying
 * that silently for the rest of the session, under a message that says "Backend
 * down — waiting for recovery", is a false statement about the machine's state.
 *
 * The probe is a plain same-path GET, so it travels the same route the page's other
 * calls do (including the Vite proxy in dev): if the origin is refused, this 403s
 * for the same reason the socket did.
 */

export const WS_REFUSED = "refused";
export const WS_BACKEND_DOWN = "down";
export const WS_UNKNOWN = "unknown";

/**
 * @returns {Promise<"refused"|"down"|"unknown">}
 *   `refused` — the server is UP and rejecting this origin. Retrying cannot help.
 *   `down`    — nothing answered. Retrying is exactly right.
 *   `unknown` — the server answered normally, so the socket failed for some other
 *               reason. Deliberately NOT reported as refused: claiming an origin
 *               problem we did not observe is the same class of lie as the message
 *               this module exists to remove.
 */
export async function diagnoseSocketFailure(fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!doFetch) return WS_UNKNOWN;
  try {
    const res = await doFetch("/api/version", { cache: "no-store" });
    return res.status === 403 ? WS_REFUSED : WS_UNKNOWN;
  } catch {
    // A network-level failure: nothing is listening, or it died mid-request.
    return WS_BACKEND_DOWN;
  }
}

/** The message both panes write. One string, so they cannot drift apart. */
export const REFUSED_MESSAGE =
  "\r\n\x1b[31m[Connection refused by the server — this page's origin is not " +
  "allowed. Reload the app.]\x1b[0m\r\n";
