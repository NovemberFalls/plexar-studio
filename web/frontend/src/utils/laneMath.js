/**
 * Lane math — the single implementation of the in-engine lane readout (how
 * many sequences are running, how many the engine has waiting, and how long
 * the lane should take to drain).
 *
 * WHY THIS FILE EXISTS: the same numbers are rendered in three places (the
 * Workspace lane strip, the TopBar quick-glance pill, and Engine > Live). Two
 * implementations would drift and the operator would be reading a lie.
 *
 * SPILL WAS REMOVED 2026-08-03 on the owner's ruling, and with it went the
 * three functions that existed only to measure distance to a spill trigger:
 * `wouldSpill`, `pressureFraction`, `depthEquivalent`/`waitEquivalent`. There
 * is no threshold left to be a fraction of the way towards, so nothing here
 * invents one. Depth and wait are now reported, never compared.
 *
 * Every function here is pure and total: polled provider data is best-effort and
 * routinely arrives null, unreachable, or missing fields, so these return null
 * rather than throwing or fabricating a zero. A `null` means "unknown" and must
 * render as "—" / "n/a" upstream — never as 0, which would read as "no wait".
 */

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
 * Live lane readout from the vLLM in-engine block (running/waiting/decode +
 * wall to estimate drain).
 *
 * THE BROKER-QUEUE FALLBACK IS GONE (T11). This used to take a `localQueue`
 * first argument and, when no engine block was present, derive the readout
 * from the lane broker's /queue snapshot. The broker is removed, so that
 * branch had no producer. A backend with no engine block now returns null --
 * "nothing live to report" -- rather than a zero, which is the same
 * distinction the rest of this module exists to preserve.
 *
 * @returns {{running:number, queued:number, tps:number|null, etaSec:number|null,
 *   total:number, p50WallSeconds:number|null}|null} null when nothing is live.
 */
export function laneLive(localMetrics) {
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

  return null;
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
 * THE SEAM: metrics payload -> the object LaneStrip renders.
 *
 * WHY THIS IS A NAMED, EXPORTED FUNCTION AND NOT AN INLINE `useMemo` (R26).
 * It used to be four lines inside App.jsx, and the R26 re-audit of row S10
 * found that both SIDES of it were proven and IT was not -- L3's shape exactly
 * (a property proven directly, a store proven with hand-built dicts, and the
 * mapping between them writing nothing). Extracting it makes the seam
 * importable so the wiring test can drive it and render the result, with no
 * hand-built lane object anywhere in the chain. That reasoning is unchanged
 * and is why this stays a named export.
 *
 * `shadow` IS GONE (T11), and with it the specific silent failure this note
 * used to describe (a renamed or stringified flag rendering the LIVE meter
 * over a shadow broker). It reported whether the lane broker's queue was
 * switched off; with no broker there is no queue to be on or off. The honest
 * move is to stop making the claim, not to hard-code `false`, which would
 * assert "queueing exists and is enabled".
 *
 * @returns {{inFlight:number, queued:number, predictedWaitSeconds:number|null,
 *   estimatedClearSeconds:number|null,
 *    }|null} null when nothing is live.
 */
export function laneStripFrom(localMetrics) {
  const live = laneLive(localMetrics);
  if (!live) return null;
  return {
    inFlight: live.running,
    queued: live.queued,
    predictedWaitSeconds: predictedWaitSeconds(live.running, live.queued, live.p50WallSeconds),
    estimatedClearSeconds: live.etaSec,
  };
}

/** The exact key set `laneStripFrom` produces. Exported so the wiring test can
 *  assert it against the keys LaneStrip actually reads, in BOTH directions --
 *  a key the mapper stops producing is never rendered, and a key LaneStrip
 *  starts reading that the mapper never produces is silently undefined. Kept as
 *  a SET comparison deliberately: a subset check would let keys be added or
 *  dropped without a word. */
export const LANE_STRIP_KEYS = Object.freeze([
  "inFlight",
  "queued",
  "predictedWaitSeconds",
  "estimatedClearSeconds",
]);

/** Non-negative integer count, or null. Rejects NaN/Infinity/negatives so a
 *  malformed broker payload cannot silently become a 0 in the arithmetic. */
function toCount(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return null;
  return Math.floor(n);
}
