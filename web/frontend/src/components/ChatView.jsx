/**
 * ChatView — Plexar Chat filling Studio's content area, like Settings does.
 *
 * ┌─ WHY THIS IS A TAURI CHILD WEBVIEW AND NOT AN <iframe> ────────────────────┐
 * │ Measured 2026-09-22 against the live deployments:                          │
 * │                                                                            │
 * │   Chat:   content-security-policy: … frame-ancestors 'none'                │
 * │   Studio: csp: "default-src 'self'; …"   (no frame-src)                    │
 * │                                                                            │
 * │ TWO INDEPENDENT REFUSALS. An iframe needs both relaxed, and relaxing        │
 * │ Chat's would spend a public product's clickjacking defence so one desktop  │
 * │ client can embed it — and since Studio's origin is http://localhost:8420,  │
 * │ it would let ANY page served from localhost on a user's machine frame      │
 * │ Chat. A child webview is a TOP-LEVEL browsing context, so neither header   │
 * │ is in play and neither has to move.                                        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * THE PROPERTY YOU CANNOT ENGINEER AWAY: a child webview is an OS-level surface
 * painted ABOVE the DOM. Anything Studio floats over the content area is behind
 * it. Ten components use the house `.fixed.inset-0` overlay idiom, so ONE
 * MutationObserver on that selector hides the webview whenever any of them is up
 * — chosen over `aria-modal`, which only 4 of the 10 set and would therefore be
 * a partial guard that looks complete.
 *
 * TOASTS ARE STILL OCCLUDED. The toast container is `fixed; bottom; right`, not
 * `.fixed.inset-0`, and it sits inside the region the webview covers. This is
 * stated rather than papered over: a background toast raised while Chat is open
 * will not be seen.
 *
 * The webview is CLOSED on unmount rather than parked off-screen — a live
 * webview holds a renderer process, and Chat is not a thing you leave running
 * invisibly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { MessageSquare, ExternalLink } from "lucide-react";

export const CHAT_WEBVIEW_LABEL = "plexar-chat-embedded";

/** True when an overlay is currently painted over the content area.
 *  `.fixed.inset-0` is this codebase's overlay idiom — every modal, popover
 *  backdrop and dialog uses it, which is what makes one selector sufficient. */
function anyOverlayOpen() {
  return document.querySelector(".fixed.inset-0") !== null;
}

export default function ChatView({ url, onError }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  // Tauri detection is a render-time fact for the fallback, so it is state
  // rather than a ref: the fallback must render on the first paint.
  const [isTauri] = useState(
    () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__),
  );
  const [failed, setFailed] = useState(null);
  // onError lives in a REF, never in an effect's deps. App passes an inline
  // arrow, so its identity changes every render; as a dep it re-ran the create
  // effect on every render, each failed attempt toasted, the toast re-rendered
  // App, and the loop stacked dozens of identical toasts (2.1.33 trial build).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  /** Push the measured rect of our placeholder onto the webview. The DOM node
   *  is the single source of truth for geometry — the webview is positioned
   *  FROM the layout rather than the layout being guessed at, so the drawer
   *  opening, the window resizing and the inspector toggling all just work. */
  const sync = useCallback(async () => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (!view || !host) return;
    const r = host.getBoundingClientRect();
    // A zero rect means we are laid out but not visible (a hidden ancestor).
    // Moving a webview to 0×0 is not the same as hiding it on every platform,
    // so hide explicitly.
    if (r.width < 1 || r.height < 1) {
      try { await view.hide(); } catch { /* the window may be closing */ }
      return;
    }
    try {
      const { LogicalPosition, LogicalSize } = await import("@tauri-apps/api/dpi");
      await view.setPosition(new LogicalPosition(Math.round(r.left), Math.round(r.top)));
      await view.setSize(new LogicalSize(Math.round(r.width), Math.round(r.height)));
      if (anyOverlayOpen()) await view.hide();
      else await view.show();
    } catch {
      /* a teardown race; the next sync fixes it */
    }
  }, []);

  useEffect(() => {
    if (!isTauri || !url) return undefined;
    let cancelled = false;
    let view = null;

    (async () => {
      try {
        const [{ Webview }, { getCurrentWindow }] = await Promise.all([
          import("@tauri-apps/api/webview"),
          import("@tauri-apps/api/window"),
        ]);
        if (cancelled) return;
        const host = hostRef.current;
        const r = host ? host.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
        view = new Webview(getCurrentWindow(), CHAT_WEBVIEW_LABEL, {
          url,
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.max(1, Math.round(r.width)),
          height: Math.max(1, Math.round(r.height)),
        });
        view.once("tauri://error", (e) => {
          const msg = typeof e?.payload === "string" ? e.payload : "the window manager refused it";
          setFailed(msg);
          onErrorRef.current?.(msg);
        });
        if (cancelled) { try { view.close(); } catch { /* already gone */ } return; }
        viewRef.current = view;
        sync();
      } catch (err) {
        if (!cancelled) { setFailed(err.message); onErrorRef.current?.(err.message); }
      }
    })();

    return () => {
      cancelled = true;
      const v = viewRef.current || view;
      viewRef.current = null;
      // CLOSE, never merely hide: a parked webview keeps a renderer process
      // alive for a section the user has left.
      if (v) { try { v.close(); } catch { /* window already tearing down */ } }
    };
  }, [isTauri, url, sync]);

  // Geometry and overlay tracking. ResizeObserver catches layout changes the
  // window-resize event does not (the drawer, the inspector); the
  // MutationObserver catches an overlay appearing over us.
  useEffect(() => {
    if (!isTauri) return undefined;
    const host = hostRef.current;
    const ro = new ResizeObserver(() => sync());
    if (host) ro.observe(host);
    const mo = new MutationObserver(() => sync());
    mo.observe(document.body, { childList: true, subtree: true, attributes: true,
                                attributeFilter: ["class", "style"] });
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [isTauri, sync]);

  // The placeholder. In Tauri it is a measuring surface the webview covers; its
  // background matches the app so a resize never flashes white.
  return (
    <div
      ref={hostRef}
      data-testid="chat-view"
      style={{ flex: 1, minWidth: 0, minHeight: 0, background: "var(--cc-bg)", position: "relative" }}
    >
      {(!isTauri || failed) && (
        <div
          style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 10, padding: 24,
            textAlign: "center", color: "var(--cc-muted)",
          }}
        >
          <MessageSquare size={28} style={{ opacity: 0.5 }} />
          <div style={{ fontSize: 13, color: "var(--cc-fg)" }}>
            {failed ? "Plexar Chat could not be opened here" : "Plexar Chat opens in the desktop app"}
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.6, maxWidth: 460 }}>
            {failed
              ? failed
              : "Chat is embedded with a native webview, which the browser dev server has no " +
                "equivalent for. It does not render in an iframe: Chat sends " +
                "frame-ancestors 'none', so a frame here would be blank rather than useful."}
          </div>
          {url && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11, color: "var(--cc-accent)", display: "inline-flex",
                       alignItems: "center", gap: 5 }}
            >
              <ExternalLink size={12} /> Open {url} in a browser
            </a>
          )}
        </div>
      )}
    </div>
  );
}
