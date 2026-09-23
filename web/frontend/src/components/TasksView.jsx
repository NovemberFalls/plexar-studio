/* eslint-disable react-refresh/only-export-components -- resolveBucket/normalizeBucketPath
 * are pure helpers the test suite exercises directly; splitting them into a
 * separate module for fast-refresh's sake would be pure ceremony here. */
/**
 * TasksView — the Plexar-Framework's own TASKS page (`{base}/app`) filling
 * Studio's content area, in a Tauri child webview exactly like Chat.
 *
 * Mechanics are a COPY of ChatView.jsx (webview creation, geometry
 * observers, overlay-hiding, close-on-unmount, tauri://error fallback) with
 * one addition ChatView does not have: **B7 — probe first.** The framework
 * has no keep-alive of its own visible to Studio, and a blank webview over a
 * process that never started reads as a Studio bug rather than "start the
 * daemon". `GET /api/framework/summary` is Studio's OWN backend route (see
 * server.py) proxying the framework's `/api/summary` + `/api/daemon` — the
 * framework sends no CORS headers, so a `fetch` straight at `:8430` from this
 * origin could not even read the response. **This view therefore never
 * fetches `:8430` directly, on purpose** (HANDOFF-studio-framework-pilot.md
 * §3.3).
 *
 * B9 — the deep link: the active Location's folder is matched against the
 * summary's `buckets[*].cwd` (normalised separators, case-insensitive,
 * longest-prefix wins) so `{base}/app?bucket=<name>` opens on the right
 * repo. No match opens `/app` with no bucket.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ListChecks, ExternalLink } from "lucide-react";

export const TASKS_WEBVIEW_LABEL = "plexar-tasks-embedded";

/** `.fixed.inset-0` is this codebase's overlay idiom — see ChatView.jsx. */
function anyOverlayOpen() {
  return document.querySelector(".fixed.inset-0") !== null;
}

/** Normalise a filesystem path the same way on both sides of a comparison:
 *  backslashes to forward slashes, no trailing slash, lowercase. Pinned by
 *  HANDOFF-studio-framework-pilot.md §3.2 B9. */
export function normalizeBucketPath(p) {
  if (typeof p !== "string" || !p) return "";
  let s = p.replace(/\\/g, "/").toLowerCase();
  while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Which framework bucket (if any) the active Location's folder belongs to:
 *  equal to the bucket's cwd, or nested inside it. Longest cwd wins ties. */
export function resolveBucket(activeLocationFolder, buckets) {
  const folder = normalizeBucketPath(activeLocationFolder);
  if (!folder || !buckets || typeof buckets !== "object") return null;
  let best = null;
  let bestLen = -1;
  for (const [name, info] of Object.entries(buckets)) {
    const cwd = normalizeBucketPath(info?.cwd);
    if (!cwd) continue;
    const matches = folder === cwd || folder.startsWith(`${cwd}/`);
    if (matches && cwd.length > bestLen) {
      best = name;
      bestLen = cwd.length;
    }
  }
  return best;
}

export default function TasksView({ activeLocationFolder = null, forcedBucket = null, onError }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const [isTauri] = useState(
    () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__),
  );
  const [failed, setFailed] = useState(null);
  // null while in flight, then {up:true, base, buckets} or {up:false, base, reason}.
  const [probe, setProbe] = useState(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // B7: probe THROUGH Studio's own backend before ever creating a webview.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/framework/summary");
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data || data.up !== true) {
          setProbe({ up: false, base: data?.base || null, reason: data?.reason || "unreachable" });
          return;
        }
        setProbe({ up: true, base: data.base, buckets: data.buckets || {} });
      } catch {
        if (!cancelled) setProbe({ up: false, base: null, reason: "unreachable" });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const bucket = probe?.up
    ? (forcedBucket && Object.prototype.hasOwnProperty.call(probe.buckets || {}, forcedBucket)
        ? forcedBucket
        : resolveBucket(activeLocationFolder, probe.buckets))
    : null;
  const url = probe?.up
    ? `${probe.base}/app${bucket ? `?bucket=${encodeURIComponent(bucket)}` : ""}`
    : null;

  /** Push the measured rect of our placeholder onto the webview. Identical
   *  to ChatView.jsx's `sync` — see there for why the DOM node is the single
   *  source of truth for geometry. */
  const sync = useCallback(async () => {
    const view = viewRef.current;
    const host = hostRef.current;
    if (!view || !host) return;
    const r = host.getBoundingClientRect();
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
        view = new Webview(getCurrentWindow(), TASKS_WEBVIEW_LABEL, {
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
      // CLOSE, never merely hide: B6 — no orphan renderer left behind.
      if (v) { try { v.close(); } catch { /* window already tearing down */ } }
    };
  }, [isTauri, url, sync]);

  // Geometry and overlay tracking — identical to ChatView.jsx.
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

  const notRunning = probe != null && probe.up === false;
  const showFallback = !isTauri || failed || notRunning;

  return (
    <div
      ref={hostRef}
      data-testid="tasks-view"
      style={{ flex: 1, minWidth: 0, minHeight: 0, background: "var(--cc-bg)", position: "relative" }}
    >
      {showFallback && (
        <div
          style={{
            position: "absolute", inset: 0, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center", gap: 10, padding: 24,
            textAlign: "center", color: "var(--cc-muted)",
          }}
        >
          <ListChecks size={28} style={{ opacity: 0.5 }} />
          <div style={{ fontSize: 13, color: "var(--cc-fg)" }}>
            {failed
              ? "Plexar Tasks could not be opened here"
              : !isTauri
                ? "Plexar Tasks opens in the desktop app"
                : "Plexar-Framework isn't running."}
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.6, maxWidth: 460 }}>
            {failed
              ? failed
              : !isTauri
                ? "Tasks is embedded with a native webview, which the browser dev server has no " +
                  "equivalent for."
                : notRunning
                  ? "Start it with `plexar up`."
                  : "Checking Plexar-Framework…"}
          </div>
          {notRunning && probe?.base && (
            <a
              href={`${probe.base}/app`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11, color: "var(--cc-accent)", display: "inline-flex",
                       alignItems: "center", gap: 5 }}
            >
              <ExternalLink size={12} /> Open in browser
            </a>
          )}
        </div>
      )}
    </div>
  );
}
