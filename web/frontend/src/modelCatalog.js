/* Model catalog — single source of truth for the model picker.
 *
 * The picker is driven by the LIVE Anthropic /v1/models list (served by the
 * backend GET /api/models, which reads the session OAuth token and asks
 * Anthropic directly). This is what keeps the picker true to what the account
 * can actually run — no more hardcoded lists that drift every time a model
 * ships (Opus 5 caught us out). The two things Anthropic's list does NOT carry
 * are synthesized here: the (1M) long-context variants and the OpenRouter group.
 *
 * When the live fetch fails (offline / token rotated), consumers fall back to
 * FALLBACK_MODEL_GROUPS so the picker is never empty. FALLBACK_MODEL_GROUPS is
 * ALSO what tests that render a component without <ModelCatalogProvider> see, so
 * it is kept as a complete, self-consistent group list.
 */
import { createContext, createElement, useContext, useEffect, useState } from "react";

const POLL_MS = 10 * 60 * 1000; // models change on the order of weeks; 10 min is plenty
const LOCAL_POLL_MS = 20 * 1000; // local models load/unload far more often than the Anthropic catalog changes

// Same localStorage flag App.jsx uses to gate all local-broker polling
// (see App.jsx "cockpit-local-enabled") — read directly rather than via
// props so this provider can sit above App without a prop-drilling dance.
const LOCAL_ENABLED_KEY = "cockpit-local-enabled";
function readLocalEnabled() {
  try {
    return localStorage.getItem(LOCAL_ENABLED_KEY) === "true";
  } catch (_) {
    return false;
  }
}

// OpenRouter models are a different provider and never appear in Anthropic's
// /v1/models — this group is ALWAYS static and appended after the live groups.
export const OPENROUTER_GROUP = {
  label: "OpenRouter",
  provider: "openrouter",
  models: [
    { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "openrouter" },
    { id: "qwen/qwen3-coder-next", label: "Qwen3 Coder Next", provider: "openrouter" },
  ],
};

// Complete static list — served when the live fetch is unavailable, and the
// default catalog for components rendered without a provider (tests).
// Grouped BY FAMILY (Opus / Sonnet / Haiku / Fable), newest-first within
// each family, mirroring the shape buildModelGroups() produces from live data.
export const FALLBACK_MODEL_GROUPS = [
  {
    label: "Opus",
    models: [
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-opus-5[1m]", label: "Opus 5 (1M)" },
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
    ],
  },
  {
    label: "Sonnet",
    models: [
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-sonnet-5[1m]", label: "Sonnet 5 (1M)" },
    ],
  },
  {
    label: "Haiku",
    models: [{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }],
  },
  {
    label: "Fable",
    models: [{ id: "claude-fable-5", label: "Fable 5" }],
  },
  OPENROUTER_GROUP,
];

const OPENROUTER_IDS = new Set(OPENROUTER_GROUP.models.map((m) => m.id));
const LOCAL_ID_PREFIX = "local:";

/** Returns "local" for namespaced local-provider ids, "openrouter" for
 *  OpenRouter-group ids, "anthropic" otherwise (unrecognized ids are treated
 *  as anthropic, per convention). */
export function getModelProvider(modelId) {
  if (typeof modelId === "string" && modelId.startsWith(LOCAL_ID_PREFIX)) return "local";
  return OPENROUTER_IDS.has(modelId) ? "openrouter" : "anthropic";
}

/** Decodes a namespaced local model picker id ("local:<providerId>:<modelId>")
 *  into { providerId, modelId }, or null when the id isn't a local id. The
 *  model id itself may contain ":" (e.g. quantization tags), so only the
 *  first two segments are split off. */
export function parseLocalModelId(id) {
  if (typeof id !== "string" || !id.startsWith(LOCAL_ID_PREFIX)) return null;
  const rest = id.slice(LOCAL_ID_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep === -1) return null;
  const providerId = rest.slice(0, sep);
  const modelId = rest.slice(sep + 1);
  if (!providerId || !modelId) return null;
  return { providerId, modelId };
}

/** Builds one picker group per reachable local provider that has >=1 model,
 *  from GET /api/local/providers + per-provider GET /api/local/{id}/models
 *  responses. Ids are namespaced "local:<providerId>:<modelId>" so they can
 *  never collide with Anthropic/OpenRouter ids or each other. Providers that
 *  are unreachable or have no models are simply omitted — the group list is
 *  expected to change shape as models load/unload. */
export function buildLocalGroups(providers, modelsByProviderId) {
  if (!Array.isArray(providers)) return [];
  const groups = [];
  for (const provider of providers) {
    if (!provider || typeof provider.id !== "string") continue;
    const resp = modelsByProviderId?.[provider.id];
    if (!resp || resp.reachable === false || !Array.isArray(resp.models) || resp.models.length === 0) continue;
    const models = resp.models
      .filter((m) => m && typeof m.id === "string")
      .map((m) => {
        const loaded = m.state === "loaded";
        return {
          id: `${LOCAL_ID_PREFIX}${provider.id}:${m.id}`,
          label: loaded ? m.id : `${m.id} · not loaded`,
          provider: "local",
          localProviderId: provider.id,
          localModelId: m.id,
          loaded,
        };
      });
    if (models.length === 0) continue;
    groups.push({ label: provider.label || provider.id, provider: "local", models });
  }
  return groups;
}

/** True when the id is an Opus model (fast-toggle eligible). Matches the alias
 *  "opus", any claude-opus-* id, and their [1m] variants. */
export function isOpusModel(modelId) {
  if (!modelId) return false;
  const base = modelId.replace(/\[1m\]$/, "");
  return base === "opus" || /opus/i.test(base);
}

// Opus/Sonnet families get a synthesized (1M) long-context entry; Haiku/Fable
// do not (mirrors the prior curated list's 1M coverage).
function supports1M(model) {
  return /opus|sonnet/i.test(model.display_name || model.id);
}

// Short entry label: "Claude Opus 5" -> "Opus 5".
function shortLabel(model) {
  return (model.display_name || model.id).replace(/^Claude\s+/i, "");
}

// Model ids/aliases that are retired (API 404s) or deprecated and retiring
// imminently. Verified against the Anthropic model catalog on 2026-07-29 —
// re-verify before trusting this list stale. Matched by exact id AND by
// prefix (see isDeprecatedModel) since the live list may return either the
// bare alias (e.g. "claude-opus-4-1") or a fully dated id
// (e.g. "claude-opus-4-1-20250805").
export const DEPRECATED_MODEL_IDS = new Set([
  // Retired — API returns 404
  "claude-3-7-sonnet-20250219",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-sonnet-20240620",
  "claude-3-sonnet-20240229",
  "claude-2.1",
  "claude-2.0",
  "claude-3-haiku-20240307",
  // Deprecated, retiring imminently
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-sonnet-4-0",
]);

/** True when `id` exactly matches, or is a dated variant of (id + "-"), a
 *  known deprecated/retired model id. Exported for tests. */
export function isDeprecatedModel(id) {
  if (typeof id !== "string" || !id) return false;
  for (const deprecatedId of DEPRECATED_MODEL_IDS) {
    if (id === deprecatedId || id.startsWith(`${deprecatedId}-`)) return true;
  }
  return false;
}

// Fixed family display order — everything else lands in "Other" rather than
// being silently dropped (an unrecognized family is likely a model newer
// than these regexes, and hiding it would be exactly the drift bug this
// catalog exists to avoid).
const FAMILY_ORDER = ["Opus", "Sonnet", "Haiku", "Fable", "Mythos", "Other"];

// Model family from the display name / id: matches the first family regex
// that hits, falling back to "Other" for anything unrecognized.
function familyLabel(model) {
  const text = `${model.display_name || ""} ${model.id || ""}`;
  if (/opus/i.test(text)) return "Opus";
  if (/sonnet/i.test(text)) return "Sonnet";
  if (/haiku/i.test(text)) return "Haiku";
  if (/fable/i.test(text)) return "Fable";
  if (/mythos/i.test(text)) return "Mythos";
  return "Other";
}

/** Build the grouped picker shape from Anthropic's live [{id, display_name}]
 *  list: filter deprecated/retired models, group by FAMILY (Opus, Sonnet,
 *  Haiku, Fable, Mythos, Other — fixed order, API order preserved within
 *  each family), synthesize (1M) variants, then append the static OpenRouter
 *  group. Empty/invalid input falls back to FALLBACK_MODEL_GROUPS. */
export function buildModelGroups(liveModels) {
  if (!Array.isArray(liveModels) || liveModels.length === 0) {
    return FALLBACK_MODEL_GROUPS;
  }
  const byFamily = new Map();
  for (const model of liveModels) {
    if (!model || typeof model.id !== "string") continue;
    if (isDeprecatedModel(model.id)) continue;
    const family = familyLabel(model);
    if (!byFamily.has(family)) byFamily.set(family, []);
    const entries = byFamily.get(family);
    const short = shortLabel(model);
    entries.push({ id: model.id, label: short });
    if (supports1M(model)) {
      entries.push({ id: `${model.id}[1m]`, label: `${short} (1M)` });
    }
  }
  if (byFamily.size === 0) return FALLBACK_MODEL_GROUPS;
  const groups = FAMILY_ORDER.filter((family) => byFamily.has(family)).map((family) => ({
    label: family,
    models: byFamily.get(family),
  }));
  groups.push(OPENROUTER_GROUP);
  return groups;
}

const flatten = (groups) => groups.flatMap((g) => g.models);

const DEFAULT_CATALOG = {
  groups: FALLBACK_MODEL_GROUPS,
  models: flatten(FALLBACK_MODEL_GROUPS),
  source: "fallback",
};

// Exported (in addition to the useModelCatalog hook) so tests can wrap a
// component tree in ModelCatalogContext.Provider with a custom catalog value
// (e.g. one that includes a local-provider group) without needing to mock
// the /api/models + /api/local/* fetch chain.
export const ModelCatalogContext = createContext(DEFAULT_CATALOG);

/** Returns { groups, models, source }. Without a provider, returns the static
 *  fallback catalog (so components render standalone in tests). */
export function useModelCatalog() {
  return useContext(ModelCatalogContext);
}

/** Fetches /api/models on mount + every 10 min, builds the live Anthropic
 *  catalog, and — when local broker access is enabled (see
 *  LOCAL_ENABLED_KEY) — separately polls /api/local/providers +
 *  /api/local/{id}/models every 20s to append per-provider local groups
 *  after the OpenRouter group. The two fetches are independent so a local
 *  broker outage never affects the Anthropic/OpenRouter fallback behavior
 *  tests depend on. Keeps the fallback catalog on any error. */
export function ModelCatalogProvider({ children }) {
  const [baseGroups, setBaseGroups] = useState(FALLBACK_MODEL_GROUPS);
  const [source, setSource] = useState("fallback");
  const [localGroups, setLocalGroups] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !Array.isArray(data.models) || data.models.length === 0) return;
        setBaseGroups(buildModelGroups(data.models));
        setSource(data.source || "live");
      } catch {
        /* keep fallback — best-effort, the picker still works offline */
      }
    }
    load();
    const iv = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Re-checked on every poll tick (not just mount) so toggling the local
    // broker off from LocalBrokerView clears the groups without a remount.
    async function load() {
      if (!readLocalEnabled()) {
        if (!cancelled) setLocalGroups([]);
        return;
      }
      try {
        const provRes = await fetch("/api/local/providers");
        if (!provRes.ok) return;
        const provData = await provRes.json();
        const providers = Array.isArray(provData.providers) ? provData.providers : [];
        if (providers.length === 0) {
          if (!cancelled) setLocalGroups([]);
          return;
        }
        const entries = await Promise.all(
          providers.map(async (p) => {
            try {
              const res = await fetch(`/api/local/${encodeURIComponent(p.id)}/models`);
              return [p.id, res.ok ? await res.json() : { reachable: false }];
            } catch {
              return [p.id, { reachable: false }];
            }
          })
        );
        if (cancelled) return;
        const modelsByProviderId = Object.fromEntries(entries);
        setLocalGroups(buildLocalGroups(providers, modelsByProviderId));
      } catch {
        /* keep whatever local groups we had — best-effort */
      }
    }
    load();
    const iv = setInterval(load, LOCAL_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, []);

  const groups = localGroups.length > 0 ? [...baseGroups, ...localGroups] : baseGroups;
  const catalog = { groups, models: flatten(groups), source };
  return createElement(ModelCatalogContext.Provider, { value: catalog }, children);
}
