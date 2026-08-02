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

// Local ids are "local:<providerId>:<modelId>" (modelCatalog.js). Parsed
// inline rather than importing modelCatalog.js, which pulls in React hooks
// this pure arithmetic module has no business depending on.
const LOCAL_ID_PREFIX = "local:";
function parseLocalModelId(id) {
  if (typeof id !== "string" || !id.startsWith(LOCAL_ID_PREFIX)) return null;
  const rest = id.slice(LOCAL_ID_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return null;
  const providerId = rest.slice(0, sep);
  const modelId = rest.slice(sep + 1);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

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

/**
 * Local-provider window, resolved from the SAME store `useLocalModels()`
 * already owns (`byProvider[providerId].models[].{max_context_length,
 * loaded_context_length}`) — there is exactly one app-wide poller of
 * /models (hooks/useLocalModels.js) and this must never add a second one.
 *
 * `loaded_context_length` wins when present — it is what the engine
 * actually has resident, where `max_context_length` is only what the
 * catalog entry declares (for an adopted external instance that may be a
 * publisher's declaration rather than a live observation). Either field
 * may be null independently of the other; a null in the preferred field
 * must not shadow a real number in the other one, so this is an
 * explicit `!= null` chain, not `||` (which would treat 0 as absent too).
 *
 * Returns null — never a guessed default — when the model isn't found or
 * the catalog omits both fields. A null stays null all the way to `meter`,
 * which is what suppresses the bar.
 */
function localContextLimit(modelId, localCatalog) {
  const parsed = parseLocalModelId(modelId);
  if (!parsed || !localCatalog) return null;
  const resp = localCatalog[parsed.providerId];
  const list = Array.isArray(resp?.models) ? resp.models : null;
  if (!list) return null;
  const entry = list.find((m) => m && m.id === parsed.modelId);
  if (!entry) return null;
  const { loaded_context_length: loaded, max_context_length: max } = entry;
  if (typeof loaded === "number") return loaded;
  if (typeof max === "number") return max;
  return null;
}

/**
 * @param modelId  Anthropic id, OpenRouter id, or "local:<providerId>:<id>".
 * @param localCatalog  optional `byProvider` map from `useLocalModels()` —
 *   `{ [providerId]: { reachable, models: [...] } }`. Omit it (e.g. for a
 *   non-local modelId, or a caller that has none handy) and a local id
 *   simply resolves to null, same as before this window became knowable.
 */
export function contextLimitFor(modelId, localCatalog) {
  if (!modelId) return null;
  if (Object.prototype.hasOwnProperty.call(CONTEXT_LIMITS, modelId)) {
    return CONTEXT_LIMITS[modelId];
  }
  // A [1m] suffix is Anthropic's own long-context marker and is safe to read
  // even on an id this table has not been updated for.
  if (modelId.endsWith("[1m]")) return 1_000_000;
  const local = localContextLimit(modelId, localCatalog);
  if (local != null) return local;
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
export function meter(messages, modelId, localCatalog) {
  const used = usedTokens(messages);
  const limit = contextLimitFor(modelId, localCatalog);
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
