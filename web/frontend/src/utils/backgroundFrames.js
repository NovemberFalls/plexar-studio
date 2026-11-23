// Native duration of a frame in ms. ImageDecoder reports microseconds; missing
// or zero means 100 ms.
export function frameDurationMs(durationMicros) {
  return durationMicros > 0 ? durationMicros / 1000 : 100;
}

// Accumulated-progress playback. progressMs is playback time already spent inside
// the current frame; dtMs is real time since the last tick (capped at 250 ms so a
// stall or hidden tab does not fast-forward); durationMs is the frame's native
// duration. Returns the new progress, remainder carried, and how many frames to
// advance. Speed 0 (or less) never advances.
export const MAX_DT_MS = 250;
export function advance({ progressMs, dtMs, speed, durationMs }) {
  const dur = durationMs > 0 ? durationMs : 100;
  let p = progressMs + Math.min(Math.max(dtMs, 0), MAX_DT_MS) * Math.max(speed, 0);
  const steps = Math.floor(p / dur);
  p -= steps * dur;
  return { progressMs: p, steps };
}

// Source rectangle placement for "cover": scale to fill, centred, overflow cropped.
export function coverRect(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  return { dx: (dstW - dw) / 2, dy: (dstH - dh) / 2, dw, dh };
}
