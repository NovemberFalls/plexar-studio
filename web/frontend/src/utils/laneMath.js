/**
 * Lane pressure math — the single implementation of every depth <-> wait
 * conversion in the app.
 *
 * WHY THIS FILE EXISTS: the same numbers are rendered in four places (the
 * Workspace lane pressure meter, the TopBar quick-glance pill, Engine > Live,
 * and Settings > Providers > Spill policy). The design handoff calls this out
 * explicitly — "Conversions to implement once and share" — because a spill
 * threshold only means something if the meter that shows your position and the
 * control that sets the trigger agree on the arithmetic. Two implementations
 * would drift and the operator would be reading a lie.
 *
 * THE KEY SEMANTIC, verified in lane_broker/broker.py: a spill threshold is
 * SECONDS OF PREDICTED WAIT for a lane class, NOT queue depth. `null` disables
 * spill for that class. Depth is only ever a derived, displayed convenience —
 * never the stored unit.
 *
 * Every function here is pure and total: polled broker data is best-effort and
 * routinely arrives null, unreachable, or missing fields, so these return null
 * rather than throwing or fabricating a zero. A `null` means "unknown" and must
 * render as "—" / "n/a" upstream — never as 0, which would read as "no wait".
 */

/** Queue depth = in-flight (0/1) + queued length. Field names pinned from
 * broker source (broker.py::_queue_state): in_flight (object|null), queued [].
 * Returns null when the broker is unreachable — distinct from a depth of 0. */
export function queueDepth(q) {
  if (!q || q.reachable === false) return null;
  return (q.in_flight ? 1 : 0) + (Array.isArray(q.queued) ? q.queued.length : 0);
}

/** Short human duration: 45 -> "45s", 130 -> "2m", 3900 -> "1h5m".
 *  Returns null for non-finite or non-positive input. */
export function fmtEta(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/**
 * Unified live lane readout: prefers the vLLM in-engine block (running/waiting/
 * decode + wall to estimate drain) and falls back to the broker queue snapshot.
 *
 * @returns {{running:number, queued:number, tps:number|null, etaSec:number|null,
 *   total:number, p50WallSeconds:number|null}|null} null when nothing is live.
 */
export function laneLive(localQueue, localMetrics) {
  const m = localMetrics && localMetrics.reachable !== false ? localMetrics : null;
  const wallMs = m?.run_time_ms?.p50;
  const p50WallSeconds = typeof wallMs === "number" && wallMs > 0 ? wallMs / 1000 : null;

  const eng = m?.engine;
  if (eng && (typeof eng.running === "number" || typeof eng.waiting === "number")) {
    const running = eng.running || 0;
    const queued = eng.waiting || 0;
    const tps = m.decode_tokens_per_sec?.avg ?? m.tokens_per_sec?.avg ?? null;
    // 1-deep continuous-batching lane: drain ~= (in-flight + waiting) x median wall.
    const etaSec = p50WallSeconds != null && running + queued > 0 ? (running + queued) * p50WallSeconds : null;
    return { running, queued, tps, etaSec, total: running + queued, p50WallSeconds };
  }

  const d = queueDepth(localQueue);
  if (d == null) return null;
  const running = localQueue?.in_flight ? 1 : 0;
  const queued = Array.isArray(localQueue?.queued) ? localQueue.queued.length : 0;
  const tps = m?.tokens_per_sec?.current ?? null;
  const etaSec =
    typeof localQueue?.estimated_clear_seconds === "number" ? localQueue.estimated_clear_seconds : null;
  return { running, queued, tps, etaSec, total: d, p50WallSeconds };
}

/**
 * How long a request submitted RIGHT NOW would wait before it starts decoding.
 *
 *   predictedWaitSeconds = (inFlight + aheadOfYou) * p50WallSeconds
 *
 * Returns null when p50 wall is unknown — with no measured run time there is no
 * honest estimate, and rendering 0 would claim "no wait".
 */
export function predictedWaitSeconds(inFlight, aheadOfYou, p50WallSeconds) {
  if (typeof p50WallSeconds !== "number" || !isFinite(p50WallSeconds) || p50WallSeconds <= 0) return null;
  const ahead = (toCount(inFlight) ?? 0) + (toCount(aheadOfYou) ?? 0);
  return ahead * p50WallSeconds;
}

/**
 * The queue depth that a seconds-based threshold corresponds to — i.e. how many
 * requests can be ahead of you before the threshold trips.
 *
 *   depthEquivalent = ceil(thresholdSeconds / p50WallSeconds)
 */
export function depthEquivalent(thresholdSeconds, p50WallSeconds) {
  if (typeof thresholdSeconds !== "number" || !isFinite(thresholdSeconds) || thresholdSeconds < 0) return null;
  if (typeof p50WallSeconds !== "number" || !isFinite(p50WallSeconds) || p50WallSeconds <= 0) return null;
  return Math.ceil(thresholdSeconds / p50WallSeconds);
}

/**
 * The predicted wait that a depth-based threshold corresponds to.
 *
 *   waitEquivalent = thresholdDepth * p50WallSeconds
 */
export function waitEquivalent(thresholdDepth, p50WallSeconds) {
  const depth = toCount(thresholdDepth);
  if (depth == null) return null;
  if (typeof p50WallSeconds !== "number" || !isFinite(p50WallSeconds) || p50WallSeconds <= 0) return null;
  return depth * p50WallSeconds;
}

/**
 * Fraction of the way to the spill trigger, clamped to 0..1 — the fill of the
 * lane pressure meter and of the per-class live bars.
 *
 * Returns null when either side is unknown, or when the threshold is null
 * (spill disabled for the class) — a disabled class has no "fraction of the way
 * there" and must not render a full or empty bar as if it did.
 */
export function pressureFraction(currentSeconds, thresholdSeconds) {
  if (typeof currentSeconds !== "number" || !isFinite(currentSeconds) || currentSeconds < 0) return null;
  if (typeof thresholdSeconds !== "number" || !isFinite(thresholdSeconds) || thresholdSeconds <= 0) return null;
  return Math.min(1, Math.max(0, currentSeconds / thresholdSeconds));
}

/** Non-negative integer count, or null. Rejects NaN/Infinity/negatives so a
 *  malformed broker payload cannot silently become a 0 in the arithmetic. */
function toCount(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return null;
  return Math.floor(n);
}
