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
export const FALLBACK_MODEL_GROUPS = [
  {
    label: "Claude 5",
    models: [
      { id: "claude-opus-5", label: "Opus 5" },
      { id: "claude-opus-5[1m]", label: "Opus 5 (1M)" },
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-fable-5", label: "Fable 5" },
    ],
  },
  {
    label: "Claude 4.8",
    models: [
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
    ],
  },
  {
    label: "Claude 4.5",
    models: [{ id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" }],
  },
  OPENROUTER_GROUP,
];

const OPENROUTER_IDS = new Set(OPENROUTER_GROUP.models.map((m) => m.id));

/** Returns "openrouter" for OpenRouter-group ids, "anthropic" otherwise
 *  (unrecognized ids are treated as anthropic, per convention). */
export function getModelProvider(modelId) {
  return OPENROUTER_IDS.has(modelId) ? "openrouter" : "anthropic";
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

// Generation group label from the display name: "Claude Opus 5" -> "Claude 5",
// "Claude Opus 4.8" -> "Claude 4.8". No trailing version -> "Claude".
function genLabel(model) {
  const m = /(\d+(?:\.\d+)?)\s*$/.exec(model.display_name || "");
  return m ? `Claude ${m[1]}` : "Claude";
}

// Short entry label: "Claude Opus 5" -> "Opus 5".
function shortLabel(model) {
  return (model.display_name || model.id).replace(/^Claude\s+/i, "");
}

/** Build the grouped picker shape from Anthropic's live [{id, display_name}]
 *  list: group by generation (API order preserved, newest first), synthesize
 *  (1M) variants, then append the static OpenRouter group. Empty/invalid input
 *  falls back to FALLBACK_MODEL_GROUPS. */
export function buildModelGroups(liveModels) {
  if (!Array.isArray(liveModels) || liveModels.length === 0) {
    return FALLBACK_MODEL_GROUPS;
  }
  const order = [];
  const byGen = new Map();
  for (const model of liveModels) {
    if (!model || typeof model.id !== "string") continue;
    const gen = genLabel(model);
    if (!byGen.has(gen)) {
      byGen.set(gen, []);
      order.push(gen);
    }
    const entries = byGen.get(gen);
    const short = shortLabel(model);
    entries.push({ id: model.id, label: short });
    if (supports1M(model)) {
      entries.push({ id: `${model.id}[1m]`, label: `${short} (1M)` });
    }
  }
  if (order.length === 0) return FALLBACK_MODEL_GROUPS;
  const groups = order.map((gen) => ({ label: gen, models: byGen.get(gen) }));
  groups.push(OPENROUTER_GROUP);
  return groups;
}

const flatten = (groups) => groups.flatMap((g) => g.models);

const DEFAULT_CATALOG = {
  groups: FALLBACK_MODEL_GROUPS,
  models: flatten(FALLBACK_MODEL_GROUPS),
  source: "fallback",
};

const ModelCatalogContext = createContext(DEFAULT_CATALOG);

/** Returns { groups, models, source }. Without a provider, returns the static
 *  fallback catalog (so components render standalone in tests). */
export function useModelCatalog() {
  return useContext(ModelCatalogContext);
}

/** Fetches /api/models on mount + every 10 min, builds the live catalog, and
 *  provides it. Keeps the fallback catalog on any error. */
export function ModelCatalogProvider({ children }) {
  const [catalog, setCatalog] = useState(DEFAULT_CATALOG);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/models");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !Array.isArray(data.models) || data.models.length === 0) return;
        const groups = buildModelGroups(data.models);
        setCatalog({ groups, models: flatten(groups), source: data.source || "live" });
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
  return createElement(ModelCatalogContext.Provider, { value: catalog }, children);
}
