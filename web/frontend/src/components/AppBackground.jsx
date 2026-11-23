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
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../hooks/useTheme";
import { advance, frameDurationMs, coverRect } from "../utils/backgroundFrames";
import { setBackgroundInfo } from "../hooks/backgroundInfo";

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
    speed: num(b.speed, 0, 4, 1),
  };
}

const ANIMATED_TYPES = ["image/gif", "image/webp"];
const MAX_CANVAS_SIDE = 2560;

// Plays an animated image on a canvas so its speed can be changed (a browser
// cannot retime a GIF shown through CSS). Reports whether the image animates;
// when it does not, or decoding fails, the parent keeps the CSS background.
function AnimatedCanvas({ src, type, speed, blur, onResult }) {
  const canvasRef = useRef(null);
  const decoderRef = useRef(null);
  const speedRef = useRef(speed);
  const [animated, setAnimated] = useState(false);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(src);
        if (!res.ok || !res.body) throw new Error("fetch failed");
        const decoder = new ImageDecoder({ data: res.body, type });
        decoderRef.current = decoder;
        await decoder.tracks.ready;
        if (decoder.completed) await decoder.completed;
        const count = decoder.tracks.selectedTrack?.frameCount ?? 1;
        if (cancelled) return;
        if (count <= 1) {
          decoder.close();
          decoderRef.current = null;
          onResult(false);
          return;
        }
        setAnimated(true);
        onResult(true);
      } catch (err) {
        if (!cancelled) {
          console.warn("Animated background unavailable, using the still image", err);
          onResult(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      try { decoderRef.current?.close(); } catch { /* already closed */ }
      decoderRef.current = null;
    };
  }, [src, type]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const decoder = decoderRef.current;
    const canvas = canvasRef.current;
    if (!animated || !decoder || !canvas) return undefined;
    const ctx = canvas.getContext("2d");
    if (!ctx) { onResult(false); return undefined; }
    let cancelled = false;
    const count = decoder.tracks.selectedTrack.frameCount;
    const durations = new Array(count).fill(100);   // ms, learned as frames decode
    let shown = -1;        // frame on the canvas
    let target = 0;        // frame that should be showing now
    let held = null;       // { index, image }: decoded ahead, not yet drawn
    let inflight = false;  // at most one decode at a time

    const size = () => {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      const scale = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_SIDE / Math.max(w, h));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
    };
    const paint = (image) => {
      const r = coverRect(image.displayWidth, image.displayHeight, canvas.width, canvas.height);
      ctx.drawImage(image, r.dx, r.dy, r.dw, r.dh);
    };
    const fail = (err) => {
      if (cancelled) return;
      cancelled = true;
      console.warn("Animated background stopped, using the still image", err);
      onResult(false);
    };
    // Draw the held frame if it is the target, then decode whatever is needed
    // next: the target if it is missing, else the frame after it.
    const pump = () => {
      if (cancelled) return;
      if (held && held.index === target) {
        try { paint(held.image); } finally { held.image.close(); }
        shown = target;
        held = null;
      } else if (held && held.index !== (target + 1) % count) {
        held.image.close();
        held = null;
      }
      if (inflight) return;
      const want = shown !== target ? target : (target + 1) % count;
      if (held && held.index === want) return;
      inflight = true;
      decoder.decode({ frameIndex: want }).then(({ image }) => {
        inflight = false;
        durations[want] = frameDurationMs(image.duration);
        if (cancelled) { image.close(); return; }
        if (held) held.image.close();
        held = { index: want, image };
        pump();
      }).catch((err) => { inflight = false; fail(err); });
    };
    const redraw = () => {
      size();
      if (shown < 0) return;
      decoder.decode({ frameIndex: shown }).then(({ image }) => {
        try { if (!cancelled) paint(image); } finally { image.close(); }
      }).catch(() => {});
    };

    size();
    pump();

    let progressMs = 0;
    let lastTick = null;
    let timer = null;
    const hasRaf = typeof requestAnimationFrame === "function";
    const schedule = () => {
      timer = hasRaf ? requestAnimationFrame(tick) : setTimeout(() => tick(performance.now()), 16);
    };
    function tick(now) {
      if (cancelled) return;
      if (document.hidden || lastTick === null) {
        lastTick = document.hidden ? null : now;
      } else {
        let r = advance({ progressMs, dtMs: now - lastTick, speed: speedRef.current, durationMs: durations[target] });
        lastTick = now;
        // Carry the remainder frame to frame; jump straight to the frame due.
        while (r.steps > 0) {
          target = (target + r.steps) % count;
          r = advance({ progressMs: r.progressMs, dtMs: 0, speed: 1, durationMs: durations[target] });
        }
        progressMs = r.progressMs;
        if (shown !== target) pump();
      }
      schedule();
    }
    schedule();

    const onVisible = () => { lastTick = null; };
    window.addEventListener("resize", redraw);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (hasRaf) cancelAnimationFrame(timer); else clearTimeout(timer);
      window.removeEventListener("resize", redraw);
      document.removeEventListener("visibilitychange", onVisible);
      if (held) { held.image.close(); held = null; }
    };
  }, [animated]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!animated) return null;
  return (
    <canvas
      ref={canvasRef}
      data-testid="app-background-canvas"
      style={{
        position: "absolute",
        // Same overscan as the CSS layer, so blurred edges do not fade out.
        left: -(blur * 2),
        top: -(blur * 2),
        width: `calc(100% + ${blur * 4}px)`,
        height: `calc(100% + ${blur * 4}px)`,
        filter: blur ? `blur(${blur}px)` : undefined,
      }}
    />
  );
}

export default function AppBackground() {
  const theme = useTheme() || {};
  const { backgroundConfig } = theme;
  // Tolerate a context without the background API (tests mock useTheme narrowly).
  const setBackgroundConfig = theme.setBackgroundConfig || noop;
  const setBackgroundImageSet = theme.setBackgroundImageSet || noop;
  const [meta, setMeta] = useState({ set: false, version: null, type: null });
  // The decode verdict belongs to one image in one shown state; a new image or a
  // hidden layer makes it stale without any reset.
  const [verdict, setVerdict] = useState({ key: null, ok: null });

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
        if (!cancelled) setMeta({ set: data?.set === true, version: data?.version ?? null, type: data?.type ?? null });
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

  useEffect(() => { setBackgroundInfo({ type: meta.set ? meta.type : null }); }, [meta]);

  const src = `/api/background/image?v=${encodeURIComponent(meta.version ?? "")}`;
  const verdictKey = `${src}|${show}`;
  const stillOnly = verdict.key === verdictKey && verdict.ok === false;
  const animatedOk = verdict.key === verdictKey && verdict.ok === true;
  useEffect(() => { setBackgroundInfo({ animated: null }); }, [verdictKey]);
  const canAnimate = show && !stillOnly && ANIMATED_TYPES.includes(meta.type)
    && typeof ImageDecoder !== "undefined";
  const onResult = (ok) => {
    setVerdict({ key: verdictKey, ok });
    setBackgroundInfo({ animated: ok });
  };

  if (!show) return null;
  const blur = backgroundConfig.blur || 0;
  return (
    <div
      aria-hidden="true"
      data-testid="app-background"
      style={{ position: "fixed", inset: 0, zIndex: -1, pointerEvents: "none", overflow: "hidden" }}
    >
      {canAnimate && (
        <AnimatedCanvas
          key={src}
          src={src}
          type={meta.type}
          speed={backgroundConfig.speed ?? 1}
          blur={blur}
          onResult={onResult}
        />
      )}
      {!animatedOk && <div
        data-testid="app-background-image"
        style={{
          position: "absolute",
          // Overscan by the blur radius so blurred edges do not fade to transparent.
          inset: -(blur * 2),
          backgroundImage: `url("${src}")`,
          backgroundSize: "cover",
          backgroundPosition: "center",
          filter: blur ? `blur(${blur}px)` : undefined,
        }}
      />}
      <div
        data-testid="app-background-dim"
        style={{ position: "absolute", inset: 0, background: "#000", opacity: backgroundConfig.dim }}
      />
    </div>
  );
}
