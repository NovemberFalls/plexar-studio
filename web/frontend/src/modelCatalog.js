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
    models: [
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-fable-5", label: "Fable 5" },
    ],
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

/** providerId -> does this engine serve the Responses API? true | false | null.
 *
 *  Written by buildLocalGroups from what the server MEASURED (see
 *  _probe_responses_api in server.py), read by getModelHarness, which is handed
 *  only a model id and therefore cannot ask a provider anything itself.
 *
 *  A module-level map rather than a parameter because getModelHarness is the
 *  single arbiter called from a dozen places (harness pill, dialog, restore
 *  paths, the Inspector); threading provider state through every one of them is
 *  how a rule ends up enforced per site and disagreeing with itself, which is
 *  the exact history the groupsForHarness doc records.
 *
 *  ABSENT MEANS UNKNOWN, AND UNKNOWN IS NOT FALSE. An id whose provider has not
 *  been measured stays offerable; only a measured `false` narrows a model to
 *  Claude Code. */
const LOCAL_RESPONSES_API = new Map();

/** Test seam: reset the measured-protocol registry between cases. */
export function __resetLocalResponsesApi() {
  LOCAL_RESPONSES_API.clear();
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

/** Group-level note for a keyed provider that answered NOTHING and has no
 *  credential set — the OpenRouter group's "add a key" case, for a backend
 *  whose model list happens to be live rather than static.
 *
 *  This note REPLACES a silent omission, and only for `needs_key && !configured`.
 *  That ordering is the whole point: a keyless loopback Plexar that is serving
 *  fine never reaches here (it has models), and a rig that is up and REFUSING
 *  a key is caught earlier by UNAUTHORIZED_NOTE. So this can only ever appear
 *  over an absence we have actually observed, never over a working engine. */
export const NEEDS_KEY_NOTE = "Add a URL and key via the key icon to enable";

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
    // Recorded for EVERY provider, before any of the omission branches below:
    // a provider that publishes no list, or is unreachable, still has a known
    // (or knowably-unknown) protocol, and getModelHarness may be asked about a
    // remembered selection of one long after it dropped out of the picker.
    LOCAL_RESPONSES_API.set(
      provider.id,
      typeof provider.responses_api === "boolean" ? provider.responses_api : null,
    );
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
    if (!resp || resp.reachable === false || !Array.isArray(resp.models) || resp.models.length === 0) {
      // Nothing to list. A provider that takes a credential and has none set
      // gets the OpenRouter treatment — a visible, disabled group naming the
      // fix — instead of vanishing, because vanishing is indistinguishable
      // from "this backend does not exist" and is precisely why a user with a
      // Plexar rig could not find any way to reach it. Everything else still
      // omits: an unkeyed backend that is simply down has nothing to say here
      // that the health dot does not already say better.
      if (provider.needs_key && !provider.configured) {
        groups.push({
          label: provider.label || provider.id,
          provider: "local",
          localProviderId: provider.id,
          needsKey: true,
          models: [],
          note: NEEDS_KEY_NOTE,
        });
      }
      continue;
    }
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
      // A provider the user has explicitly configured (URL + key) is usable on
      // its own authority, exactly like an OpenRouter group with a key — it
      // does not additionally require the master local-inference flag, which
      // is an Engine-page toggle no one looking for their rig would ever find.
      configured: provider.needs_key ? Boolean(provider.configured) : false,
      responsesApi:
        typeof provider.responses_api === "boolean" ? provider.responses_api : null,
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

/* ── Harness selection ────────────────────────────────────────────────────────
 *
 * Plexar Studio can drive TWO different CLIs in a pane: Anthropic's `claude`
 * (harness "claude-code") and OpenAI's `codex` (harness "codex"). They are not
 * two skins on one model list — each one can only speak to the models its own
 * CLI knows how to reach, so the picker must narrow with the harness or it
 * offers choices that fail at spawn time, far from the click that made them.
 *
 * The narrowing is a PURE function (groupsForHarness) applied by consumers, and
 * deliberately NOT baked into the catalog context: useModelCatalog() keeps
 * returning the full, unfiltered catalog so a stale/foreign model id still
 * resolves to a label instead of rendering as a raw id.
 */

export const HARNESSES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export const DEFAULT_HARNESS = "claude-code";

/* Codex publishes no live model-list route, so unlike the Anthropic half of
 * this file the Codex catalog is STATIC and must be re-verified by hand.
 * Verified 2026-09-03. Retired that day and deliberately absent: gpt-5.4,
 * gpt-5.4-mini, gpt-5.3-codex, gpt-5.2 — a retired id in a static list is the
 * exact drift this catalog's live-fetch half exists to avoid, and here there is
 * no live list to correct it. */
export const CODEX_MODEL_GROUPS = [
  {
    label: "GPT-6",
    harness: "codex",
    models: [{ id: "gpt-6-astra", label: "GPT-6 Astra", provider: "codex" }],
  },
  {
    label: "GPT-5.6",
    harness: "codex",
    models: [
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", provider: "codex" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "codex" },
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", provider: "codex" },
    ],
  },
  {
    label: "GPT-5.5",
    harness: "codex",
    models: [{ id: "gpt-5.5", label: "GPT-5.5", provider: "codex" }],
  },
  {
    label: "Codex",
    harness: "codex",
    models: [{ id: "gpt-5.3-codex-spark", label: "Codex Spark", provider: "codex" }],
  },
];

const CODEX_IDS = new Set(CODEX_MODEL_GROUPS.flatMap((g) => g.models.map((m) => m.id)));

/** Row- and group-level reason for a local engine MEASURED not to serve the
 *  Responses API, under the Codex harness.
 *
 *  A protocol mismatch, not an outage and not a permission problem: the engine
 *  is up and publishes its models, and Codex cannot talk to it. So the group
 *  stays VISIBLE (omitting it is what "down" looks like, the same argument
 *  UNAUTHORIZED_NOTE makes) and the note says what to DO — switch the harness —
 *  rather than pointing at another screen or implying a fix on the engine's side.
 *
 *  IT NO LONGER CLAIMS THE ENGINE "SERVES CHAT COMPLETIONS", because that is not
 *  what was measured. The probe asks one question — does /v1/responses exist —
 *  and a 404 answers only that. Which protocols the engine DOES speak is a
 *  separate fact nobody checked, and asserting it was how the blanket "local
 *  engines serve Chat Completions" rule survived long after vLLM had gained a
 *  Responses endpoint. State the measurement, not the inference. */
export const CODEX_LOCAL_UNSUPPORTED_NOTE =
  "This engine does not serve the Responses API, which is the only protocol Codex " +
  "speaks. Switch the harness to Claude Code to use it.";

/** Which harness can run `modelId`. "any" ONLY for OpenRouter, which both CLIs
 *  genuinely reach (Codex via its custom model_provider, Claude Code via the
 *  ANTHROPIC_* swap). "codex" for a Codex catalog id, and "claude-code"
 *  otherwise. Unrecognized ids fall to "claude-code" for the same reason
 *  getModelProvider() calls them anthropic: an id we do not know is far more
 *  likely a model newer than this file than a foreign one.
 *
 *  LOCAL DEPENDS ON THE ENGINE, and is the one answer this function cannot give
 *  from the id alone. History, because it has now been wrong in both
 *  directions: it returned "any" while the backend refused the pair outright,
 *  so a local model selected before switching to Codex survived the switch and
 *  spawned a guaranteed failure (corrected 2026-09-07 to a flat "claude-code").
 *  That correction then became wrong itself — vLLM gained /v1/responses and
 *  Plexar passes it through, so `codex` drives a Plexar rig end to end
 *  (verified against codex-cli 0.153.4), and a flat "claude-code" locked users
 *  out of a working combination.
 *
 *  Both mistakes were the same mistake: answering from the KIND instead of the
 *  engine. The answer now comes from LOCAL_RESPONSES_API, which holds what the
 *  server measured. Only a measured `false` narrows a local model to Claude
 *  Code; unknown stays "any", because refusing on an engine we never reached is
 *  a claim about machine state we have not earned. */
export function getModelHarness(modelId) {
  if (CODEX_IDS.has(modelId)) return "codex";
  const provider = getModelProvider(modelId);
  if (provider === "openrouter") return "any";
  if (provider === "local") {
    const parsed = parseLocalModelId(modelId);
    const speaks = parsed ? LOCAL_RESPONSES_API.get(parsed.providerId) : undefined;
    return speaks === false ? "claude-code" : "any";
  }
  return "claude-code";
}

/** THE SINGLE ARBITER of "may this model run on this harness", and the one
 *  place that answers "if not, what instead".
 *
 *  It exists because the rule was previously enforced PER SITE and the sites
 *  disagreed: App.jsx's selectHarness checked it, NewSessionDialog's
 *  changeHarness checked it, and the two paths that did NOT — restoring
 *  `cockpit-harness` and `cockpit-model` independently from localStorage at
 *  mount, and the Inspector's applySessionOverride("model", …) writing an
 *  unfiltered Anthropic list straight into the workspace default — are exactly
 *  where the incoherent pair came from (harness pill "Codex", model pill
 *  "Opus 5", measured 2026-09-07 on 2.1.0). This is the same lesson R-169
 *  recorded about `|| list[0]`: a rule that lives at each call site is a rule
 *  the next call site will not have.
 *
 *  Returns the SAME object shape whether or not it changed anything, so a
 *  caller cannot accidentally treat "no change" as "no answer". */
export function reconcileModelForHarness(model, harness) {
  const owner = getModelHarness(model);
  if (owner === "any" || owner === harness) return { model, changed: false };
  return { model: defaultModelForHarness(harness), changed: true };
}

// A group is harness-agnostic when it belongs to a provider both CLIs can
// reach: `provider: "openrouter"` or `provider: "local"`. Anthropic family
// groups carry no `provider` key at all (see buildModelGroups), which is what
// makes them claude-code-only — the absence IS the discriminator.

/** Pure filter/decorate: the subset of `groups` a given harness can actually
 *  launch. Never mutates its input — the catalog is shared state, and marking a
 *  local model unselectable for Codex must not leave it unselectable for Claude
 *  Code the moment the user switches back. */
export function groupsForHarness(groups, harness) {
  const list = Array.isArray(groups) ? groups : [];
  if (harness !== "codex") return list; // claude-code: exactly today's behaviour
  const openrouter = list.filter((g) => g?.provider === "openrouter");
  // Only an engine MEASURED not to serve the Responses API is narrowed here.
  // `responsesApi` is true / false / null from the server's probe, and null
  // (unreachable, or refused the credential) leaves the group offerable —
  // painting "Codex cannot use this" over an engine we failed to ask is the
  // same false claim the UNAUTHORIZED / omission split exists to prevent.
  const local = list
    .filter((g) => g?.provider === "local")
    .map((g) =>
      g.responsesApi === false
        ? {
            ...g,
            note: CODEX_LOCAL_UNSUPPORTED_NOTE,
            models: (g.models || []).map((m) => ({
              ...m,
              selectable: false,
              unavailableReason: CODEX_LOCAL_UNSUPPORTED_NOTE,
            })),
          }
        : g,
    );
  return [...CODEX_MODEL_GROUPS, ...openrouter, ...local];
}

/** The model a FRESH install starts on, and the Claude Code fallback.
 *
 *  A REAL catalog id, never the bare alias "sonnet". Both spawn the same model
 *  -- `claude --model sonnet` is valid and resolveModelSelection renders the
 *  alias honestly -- but they render DIFFERENTLY ("Sonnet 5" vs "Sonnet
 *  (alias)"), and a user who switched harness away and back would silently
 *  change how their unchanged selection is labelled. It lives here rather than
 *  in App.jsx because defaultModelForHarness needs the same value, and two
 *  constants for one default is the drift this catalog exists to prevent. */
export const DEFAULT_MODEL_ID = "claude-sonnet-5";

/** The model a session falls back to when the current selection is not valid
 *  for the harness being switched to. */
export function defaultModelForHarness(harness) {
  return harness === "codex" ? "gpt-5.6-terra" : DEFAULT_MODEL_ID;
}

/* ── Honest resolution of a stored model id ───────────────────────────────────
 *
 * THE DEFECT THIS SECTION EXISTS TO REMOVE, measured 2026-09-04: the pill did
 * `modelList.find((m) => m.id === model) || modelList[0]`. The persisted default
 * was the bare alias "sonnet", which GET /api/models never returns, so the
 * lookup missed and the pill rendered modelList[0] — "Opus 5" — while the POST
 * body still carried "sonnet" and the CLI spawned `claude --model sonnet`. The
 * user read the pill and believed they were on Opus for weeks.
 *
 * Substituting a DIFFERENT model when the id is unrecognized is the same class
 * of false claim as reporting a refused credential as `reachable: false` (see
 * UNAUTHORIZED_NOTE) or drawing a 0% bar for an unknown quota. The rule here is
 * the same one those notes encode: show the truth, or show that it is unknown —
 * never a plausible-looking substitute.
 */

/** Bare CLI aliases. `claude --model sonnet` is a LEGITIMATE, working value
 *  that Anthropic's /v1/models list does not contain, so an aliased selection
 *  is neither a catalog hit nor a mistake — it is a third case, and it needs a
 *  label of its own or it renders as another model's name.
 *
 *  Mapped to the FAMILY, not to a dated id, deliberately: rewriting "sonnet" to
 *  "claude-sonnet-5" would pin the user to whatever was current the day this
 *  file was edited, whereas the alias follows Anthropic's own pointer. The
 *  alias is a different (and often better) choice, not a stale one. */
export const MODEL_ALIASES = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

/** Resolves `id` to its catalog entry across EVERY harness — the supplied
 *  `groups` (live or fallback anthropic + openrouter + local) AND the static
 *  CODEX_MODEL_GROUPS, which useModelCatalog() deliberately excludes so the
 *  Claude Code picker does not offer models it cannot launch. That exclusion is
 *  right for OFFERING and wrong for LABELLING: a Codex id is a real selection
 *  and must render its own name, not the first Anthropic entry.
 *
 *  Returns the entry or null. It NEVER returns a different model as a
 *  consolation prize — that substitution is the whole bug. */
export function findModelEntry(id, groups) {
  if (typeof id !== "string" || !id) return null;
  const lists = [Array.isArray(groups) && groups.length > 0 ? groups : FALLBACK_MODEL_GROUPS, CODEX_MODEL_GROUPS];
  for (const list of lists) {
    for (const group of list) {
      for (const model of group?.models || []) {
        if (model?.id === id) return model;
      }
    }
  }
  return null;
}

/** The ONE resolver every surface that DISPLAYS a model selection uses (TopBar
 *  pill, New Session dialog). Three outcomes, kept distinct because they call
 *  for three different things on screen:
 *
 *    catalog hit -> { entry, label: entry.label, known: true,  isAlias: false }
 *    bare alias  -> { entry: null, label: "Sonnet (alias)", known: true, isAlias: true }
 *    anything else -> { entry: null, label: id, known: false, isAlias: false }
 *
 *  The third case renders the id AS ITSELF. It looks unpolished, and that is the
 *  point: a raw id on screen is a true statement about what a new session will
 *  spawn on, where a tidy "Opus 5" was a false one. Callers flag `known: false`
 *  visually (see TopBar) so the user can tell "unusual" from "wrong".
 *
 *  A null/empty id resolves to known: false with an empty label rather than
 *  throwing — a display path must not be able to blank the whole bar. */
export function resolveModelSelection(id, groups) {
  const entry = findModelEntry(id, groups);
  if (entry) return { entry, label: entry.label, known: true, isAlias: false };
  const family = typeof id === "string" ? MODEL_ALIASES[id] : undefined;
  if (family) return { entry: null, label: `${family} (alias)`, known: true, isAlias: true };
  return { entry: null, label: typeof id === "string" ? id : "", known: false, isAlias: false };
}
