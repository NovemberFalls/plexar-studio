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
 * Would a request submitted at this predicted wait be spilled to the API?
 *
 * The comparison is STRICTLY GREATER, pinned from broker source
 * (broker.py::_queued_forward): `if threshold is not None and predicted >
 * threshold`. A predicted wait exactly equal to the threshold runs LOCALLY.
 * Getting this off by one boundary would make the translation panel disagree
 * with the broker on precisely the row the operator is squinting at.
 *
 * @returns {boolean|null} null when the answer is unknowable — either the wait
 *   is unmeasured (no p50) or the threshold is null (spill disabled for the
 *   class, so nothing ever spills, which is `false` not `null`). Only the
 *   unmeasured case is null.
 */
export function wouldSpill(predictedWait, thresholdSeconds) {
  if (thresholdSeconds === null || thresholdSeconds === undefined) return false; // spill disabled
  if (typeof thresholdSeconds !== "number" || !isFinite(thresholdSeconds) || thresholdSeconds < 0) return null;
  if (typeof predictedWait !== "number" || !isFinite(predictedWait) || predictedWait < 0) return null;
  return predictedWait > thresholdSeconds;
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

/**
 * THE SEAM: broker payload -> the object LaneStrip renders.
 *
 * WHY THIS IS A NAMED, EXPORTED FUNCTION AND NOT AN INLINE `useMemo` (R26).
 * It used to be four lines inside App.jsx, and the R26 re-audit of row S10
 * found that both SIDES of it were proven and IT was not:
 *
 *   * `lane_broker/tests/test_shadow_default_is_inert.py` drives a REAL broker
 *     subprocess and proves the `shadow` flag corresponds to real queueing
 *     behaviour;
 *   * `LaneStrip.shadowState.test.jsx` proves the UI tells the truth about a
 *     lane object -- but it BUILT that object by hand;
 *   * and the one line carrying the flag from the payload into that object was
 *     exercised by neither.
 *
 * That is L3's shape exactly (a record property proven directly, a store proven
 * with hand-built dicts, and `to_row()` between them writing nothing). The
 * failure is silent and it wears a friendly face: if `shadow` is ever renamed,
 * dropped, or arrives as the STRING "true", `=== true` yields false and the
 * strip renders the LIVE METER over a shadow broker -- claiming an idle lane,
 * which is the first of the two opposite lies LaneStrip exists to refuse.
 *
 * Extracting it makes the seam importable, so `LaneStrip.wiring.test.jsx` can
 * drive it with a payload GENERATED FROM THE REAL BROKER and render the result,
 * with no hand-built lane object anywhere in the chain.
 *
 * FIELD NAME PINNED FROM PROVIDER SOURCE, not from an inventory (R25):
 * `broker.py::_queue_state` line 1079 emits `{"shadow": b.shadow, ...}` as a
 * real bool, and `server.py` passes the body through untouched.
 *
 * @returns {{inFlight:number, queued:number, predictedWaitSeconds:number|null,
 *   thresholdSeconds:number|null, estimatedClearSeconds:number|null,
 *   shadow:boolean}|null} null when nothing is live.
 */
export function laneStripFrom(localQueue, localMetrics, thresholdSeconds) {
  const live = laneLive(localQueue, localMetrics);
  if (!live) return null;
  return {
    inFlight: live.running,
    queued: live.queued,
    predictedWaitSeconds: predictedWaitSeconds(live.running, live.queued, live.p50WallSeconds),
    thresholdSeconds,
    estimatedClearSeconds: live.etaSec,
    // Read the field. Do not restate the condition as prose, and do not infer
    // it from a depth of zero -- that is also what a genuinely idle queue looks
    // like, which is the collapse S10 closed.
    shadow: localQueue?.shadow === true,
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
  "thresholdSeconds",
  "estimatedClearSeconds",
  "shadow",
]);

/** Non-negative integer count, or null. Rejects NaN/Infinity/negatives so a
 *  malformed broker payload cannot silently become a 0 in the arithmetic. */
function toCount(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return null;
  return Math.floor(n);
}
