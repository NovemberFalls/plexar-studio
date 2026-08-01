/**
 * Context meter arithmetic (CHAT.md §7).
 *
 * Only two engine facts are allowed in Chat — context remaining and tok/s — so
 * this is deliberately the whole of it. No cost, no queue depth, no lane class.
 *
 * THE HONESTY RULE: a limit we do not know is `null`, and a null limit draws NO
 * BAR. A bar implies a proportion, and inventing a denominator to have
 * something to render would make the most reassuring state (a nearly empty
 * bar) the one shown when we understand the least.
 */

/**
 * Context windows by model id. Only ids Cockpit itself offers appear here;
 * anything else resolves to null rather than a guess, because a wrong
 * denominator is worse than an absent one.
 */
export const CONTEXT_LIMITS = {
  "claude-opus-5": 200_000,
  "claude-opus-5[1m]": 1_000_000,
  "claude-opus-4-8": 200_000,
  "claude-opus-4-8[1m]": 1_000_000,
  "claude-sonnet-5": 200_000,
  "claude-sonnet-5[1m]": 1_000_000,
  "claude-haiku-4-5-20251001": 200_000,
  "claude-fable-5": 200_000,
};

export function contextLimitFor(modelId) {
  if (!modelId) return null;
  if (Object.prototype.hasOwnProperty.call(CONTEXT_LIMITS, modelId)) {
    return CONTEXT_LIMITS[modelId];
  }
  // A [1m] suffix is Anthropic's own long-context marker and is safe to read
  // even on an id this table has not been updated for.
  if (modelId.endsWith("[1m]")) return 1_000_000;
  return null;
}

/** Context in flight = the tokens on the most recent turn that reported any. */
export function usedTokens(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i -= 1) {
    const t = messages[i]?.input_tokens;
    if (typeof t === "number" && t > 0) return t;
  }
  return null;
}

export function fmtTokens(n) {
  if (typeof n !== "number") return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * What the meter should render.
 *
 * `pct` is null unless BOTH numbers are known — that is what suppresses the
 * bar. `over` marks the case the meter exists for: a conversation past its
 * window, which is not a rounding error but a turn that will be refused.
 */
export function meter(messages, modelId) {
  const used = usedTokens(messages);
  const limit = contextLimitFor(modelId);
  const pct = used != null && limit ? Math.min(100, (used / limit) * 100) : null;
  return {
    used,
    limit,
    pct,
    over: used != null && limit ? used > limit : false,
    label:
      used == null
        ? "context —"
        : limit
          ? `context ${fmtTokens(used)} / ${fmtTokens(limit)}`
          : `context ${fmtTokens(used)}`,
  };
}
