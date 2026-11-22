/**
 * AppBackground: one user-chosen image behind the whole window.
 *
 * Mounted ONCE in App. It owns the image metadata (GET /api/background) and
 * adopts the saved appearance.background settings into the theme context; the
 * translucent surface tokens themselves are written only by applyThemeToDOM.
 * Popout windows never mount this, so they stay solid.
 *
 * Rendered only when the setting is enabled AND the server says an image is set.
 * The Settings card announces uploads and removals with BACKGROUND_EVENT so this
 * layer refetches without a poller.
 */
import { useEffect, useState } from "react";
import { useTheme } from "../hooks/useTheme";

// Same string ThemeSettings dispatches (a shared export would break fast refresh).
const noop = () => {};
const BACKGROUND_EVENT = "plexar-background-changed";

function normalizeBackground(raw) {
  const b = raw && typeof raw === "object" ? raw : {};
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && v !== null && v !== ""
    ? Math.max(lo, Math.min(hi, Number(v))) : d);
  return {
    enabled: b.enabled === true,
    dim: num(b.dim, 0, 0.95, 0.55),
    blur: Math.round(num(b.blur, 0, 40, 0)),
    paneOpacity: num(b.pane_opacity ?? b.paneOpacity, 0.3, 1, 0.85),
  };
}

export default function AppBackground() {
  const theme = useTheme() || {};
  const { backgroundConfig } = theme;
  // Tolerate a context without the background API (tests mock useTheme narrowly).
  const setBackgroundConfig = theme.setBackgroundConfig || noop;
  const setBackgroundImageSet = theme.setBackgroundImageSet || noop;
  const [meta, setMeta] = useState({ set: false, version: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setBackgroundConfig(normalizeBackground(data?.settings?.appearance?.background));
      } catch { /* defaults stand: background stays off */ }
    })();
    return () => { cancelled = true; };
  }, [setBackgroundConfig]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/background");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setMeta({ set: data?.set === true, version: data?.version ?? null });
      } catch { /* no image shown */ }
    };
    load();
    window.addEventListener(BACKGROUND_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(BACKGROUND_EVENT, load); };
  }, []);

  const show = Boolean(backgroundConfig?.enabled && meta.set);
  useEffect(() => {
    setBackgroundImageSet(show);
    return () => setBackgroundImageSet(false);
  }, [show, setBackgroundImageSet]);

  if (!show) return null;
  const blur = backgroundConfig.blur || 0;
  return (
    <div
      aria-hidden="true"
      data-testid="app-background"
      style={{ position: "fixed", inset: 0, zIndex: -1, pointerEvents: "none", overflow: "hidden" }}
    >
      <div
        data-testid="app-background-image"
        style={{
          position: "absolute",
          // Overscan by the blur radius so blurred edges do not fade to transparent.
          inset: -(blur * 2),
          backgroundImage: `url("/api/background/image?v=${encodeURIComponent(meta.version ?? "")}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: blur ? `blur(${blur}px)` : undefined,
        }}
      />
      <div
        data-testid="app-background-dim"
        style={{ position: "absolute", inset: 0, background: "#000", opacity: backgroundConfig.dim }}
      />
    </div>
  );
}
