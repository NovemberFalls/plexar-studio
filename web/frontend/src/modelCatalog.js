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

import { useLocalModelsCatalog, offersModels, offersModelControl } from "./hooks/useLocalModels.js";

const POLL_MS = 10 * 60 * 1000; // models change on the order of weeks; 10 min is plenty

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

/** Shown instead of a model list for a provider that does not declare the
 *  `models` capability. Deliberately NOT an offline/unreachable message: such a
 *  provider may be perfectly healthy, it simply does not publish a list, and
 *  Plexar Studio never asks it (the route would 404 and a 404 rendered as
 *  reachable:false is a false claim about machine state). */
export const NO_MODEL_LIST_NOTE = "Does not publish a model list";

/** Suffix for a model that exists on disk but is NOT the one the engine is
 *  currently serving, on a provider Plexar Studio cannot load into (no
 *  `model-control`). Deliberately different from "· not loaded": on a
 *  controllable provider "not loaded" is a state you can change by clicking;
 *  here it is a state nothing in Plexar Studio can change, so it must not read as a
 *  one-click-away option. */
export const UNSERVED_MODEL_SUFFIX = "on disk, not served";

/** The short, visible tag on a row that cannot become the session default. */
export const UNSERVED_ROW_TAG = "not selectable";

/** Row-level reason (title + note text). Says what to DO, not where to look. */
export const UNSERVED_MODEL_REASON =
  "This engine serves one model, fixed when it starts, and runs outside Plexar Studio. " +
  "Restart it with this model to use it.";

/** Group-level note for a local provider that publishes a list but cannot be
 *  loaded into. Browse-only is a true, healthy state — not an error. */
export const BROWSE_ONLY_NOTE =
  "Only the model this engine is serving can be used. Restart it with another model to switch.";

/** Group-level note for a provider that is UP and REFUSED the credential.
 *  Distinct from omission (which is what "down" looks like) and from
 *  NO_MODEL_LIST_NOTE (a healthy provider that publishes no list). The rig is
 *  reachable; the credential is the problem, and the note names the fix rather
 *  than pointing at another screen. */
export const UNAUTHORIZED_NOTE =
  "This engine is running but did not accept the credential. " +
  "Set a key in Settings ▸ Providers to list its models.";

/** Same shape, different remedy: the key is valid and this is not its scope.
 *  Telling this user to re-enter a key would send them to fix the one thing
 *  that is not broken. */
export const FORBIDDEN_NOTE =
  "This engine is running and the key is valid, but it is not permitted to " +
  "list models here. Ask the rig owner to widen its scope.";

/** Builds one picker group per reachable local provider that has >=1 model,
 *  from GET /api/local/providers + per-provider GET /api/local/{id}/models
 *  responses. Ids are namespaced "local:<providerId>:<modelId>" so they can
 *  never collide with Anthropic/OpenRouter ids or each other. Providers that
 *  are unreachable or have no models are simply omitted — the group list is
 *  expected to change shape as models load/unload.
 *
 *  A provider that does not declare the `models` capability is NOT omitted and
 *  NOT reported as offline: it gets a group with an empty model list and
 *  NO_MODEL_LIST_NOTE, so the user can see the backend exists and understand
 *  why there is nothing to pick. */
export function buildLocalGroups(providers, modelsByProviderId) {
  if (!Array.isArray(providers)) return [];
  const groups = [];
  for (const provider of providers) {
    if (!provider || typeof provider.id !== "string") continue;
    if (!offersModels(provider)) {
      groups.push({
        label: provider.label || provider.id,
        provider: "local",
        models: [],
        note: NO_MODEL_LIST_NOTE,
      });
      continue;
    }
    const resp = modelsByProviderId?.[provider.id];
    // REACHABLE-BUT-REFUSED IS NOT ABSENCE. Checked BEFORE the omission rule
    // below, because that rule drops the provider from the picker entirely and
    // a dropped provider is exactly what "down" looks like. A rig that is up
    // and refusing a credential must stay VISIBLE and say so, or the user is
    // left debugging a network problem they do not have.
    if (resp && resp.authorized === false) {
      groups.push({
        label: provider.label || provider.id,
        provider: "local",
        models: [],
        note: resp.reason === "forbidden" ? FORBIDDEN_NOTE : UNAUTHORIZED_NOTE,
      });
      continue;
    }
    if (!resp || resp.reachable === false || !Array.isArray(resp.models) || resp.models.length === 0) continue;
    // Whether Plexar Studio can make an unserved model become the served one. Without
    // it, "pick this model for my session" and "load this model" come apart:
    // only the served model can actually answer a request, and nothing in
    // Plexar Studio can change which one that is.
    const canLoad = offersModelControl(provider);
    const models = resp.models
      .filter((m) => m && typeof m.id === "string")
      .map((m) => {
        const loaded = m.state === "loaded";
        const selectable = loaded || canLoad;
        return {
          id: `${LOCAL_ID_PREFIX}${provider.id}:${m.id}`,
          label: loaded ? m.id : canLoad ? `${m.id} · not loaded` : `${m.id} · ${UNSERVED_MODEL_SUFFIX}`,
          provider: "local",
          localProviderId: provider.id,
          localModelId: m.id,
          loaded,
          canLoad,
          selectable,
          unavailableReason: selectable ? null : UNSERVED_MODEL_REASON,
        };
      });
    if (models.length === 0) continue;
    groups.push({
      label: provider.label || provider.id,
      provider: "local",
      localProviderId: provider.id,
      canLoad,
      models,
      ...(canLoad ? null : { note: BROWSE_ONLY_NOTE }),
    });
  }
  return groups;
}

/** True when a catalog entry is a local model that the engine is NOT currently
 *  serving. A session launched on it fails at request time, far from the click
 *  that chose it — so wherever the selection is displayed, this must read as a
 *  problem rather than a neutral suffix. Non-local entries are never "unserved":
 *  Anthropic/OpenRouter carry no load state. */
export function isUnservedSelection(entry) {
  return Boolean(entry) && entry.provider === "local" && entry.loaded === false;
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
 *  catalog, and appends one group per local provider after the OpenRouter group.
 *
 *  The local half is NOT fetched here. It comes from useLocalModelsCatalog — the
 *  single app-wide owner of GET /api/local/{id}/models — because this provider
 *  used to poll every provider itself every 20s while App polled the SELECTED
 *  provider every 10s, duplicating one of those reads. The shared store also
 *  enforces the capability gate: a provider that does not declare `models` is
 *  never asked, and renders with NO_MODEL_LIST_NOTE rather than as offline.
 *
 *  The two halves stay independent, so a local outage never affects the
 *  Anthropic/OpenRouter fallback behavior tests depend on. */
export function ModelCatalogProvider({ children }) {
  const [baseGroups, setBaseGroups] = useState(FALLBACK_MODEL_GROUPS);
  const [source, setSource] = useState("fallback");
  const { providers, byProvider } = useLocalModelsCatalog();

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

  // Local groups are derived, not fetched: the shared store already holds the
  // registry and one cached response per provider it is allowed to ask.
  const localGroups = providers ? buildLocalGroups(providers, byProvider) : [];

  const groups = localGroups.length > 0 ? [...baseGroups, ...localGroups] : baseGroups;
  const catalog = { groups, models: flatten(groups), source };
  return createElement(ModelCatalogContext.Provider, { value: catalog }, children);
}
