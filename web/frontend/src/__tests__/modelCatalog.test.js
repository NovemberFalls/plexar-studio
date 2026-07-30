/**
 * Unit tests for modelCatalog.js — the live Anthropic catalog builder plus
 * (Tier 1) the local-broker group builder and id namespacing.
 *
 * buildModelGroups / FALLBACK_MODEL_GROUPS behavior is UNCHANGED by the
 * local-broker additions; those tests pin the existing fallback contract.
 */
import { describe, it, expect } from "vitest";
import {
  buildModelGroups,
  buildLocalGroups,
  FALLBACK_MODEL_GROUPS,
  OPENROUTER_GROUP,
  DEPRECATED_MODEL_IDS,
  isDeprecatedModel,
  getModelProvider,
  parseLocalModelId,
  isUnservedSelection,
  UNSERVED_MODEL_SUFFIX,
  UNSERVED_MODEL_REASON,
  BROWSE_ONLY_NOTE,
} from "../modelCatalog.js";

describe("buildModelGroups — family grouping + fallback contract", () => {
  it("falls back to FALLBACK_MODEL_GROUPS for empty/invalid input", () => {
    expect(buildModelGroups([])).toBe(FALLBACK_MODEL_GROUPS);
    expect(buildModelGroups(null)).toBe(FALLBACK_MODEL_GROUPS);
    expect(buildModelGroups(undefined)).toBe(FALLBACK_MODEL_GROUPS);
  });

  it("groups live models by family and appends OPENROUTER_GROUP", () => {
    const groups = buildModelGroups([
      { id: "claude-opus-5-x", display_name: "Claude Opus 5" },
      { id: "claude-sonnet-5-x", display_name: "Claude Sonnet 5" },
    ]);
    expect(groups[0].label).toBe("Opus");
    expect(groups.at(-1)).toBe(OPENROUTER_GROUP);
  });

  it("emits groups in fixed family order (Opus, Sonnet, Haiku, Fable) regardless of input order", () => {
    const groups = buildModelGroups([
      { id: "claude-fable-5", display_name: "Claude Fable 5" },
      { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
    ]);
    const labels = groups.map((g) => g.label);
    // OPENROUTER_GROUP is always last; family groups precede it in fixed order.
    expect(labels).toEqual(["Opus", "Sonnet", "Haiku", "Fable", "OpenRouter"]);
  });

  it("only emits family groups that have at least one entry", () => {
    const groups = buildModelGroups([{ id: "claude-opus-5", display_name: "Claude Opus 5" }]);
    const labels = groups.map((g) => g.label);
    expect(labels).toEqual(["Opus", "OpenRouter"]);
  });

  it("unrecognized families land in a trailing 'Other' group instead of being dropped", () => {
    const groups = buildModelGroups([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-mystery-1", display_name: "Claude Mystery 1" },
    ]);
    const otherGroup = groups.find((g) => g.label === "Other");
    expect(otherGroup).toBeDefined();
    expect(otherGroup.models).toEqual([{ id: "claude-mystery-1", label: "Mystery 1" }]);
    // Other precedes OpenRouter but follows the recognized families.
    const labels = groups.map((g) => g.label);
    expect(labels.indexOf("Other")).toBeLessThan(labels.indexOf("OpenRouter"));
  });

  it("recognizes the Mythos family", () => {
    const groups = buildModelGroups([{ id: "claude-mythos-1", display_name: "Claude Mythos 1" }]);
    expect(groups[0].label).toBe("Mythos");
  });

  it("preserves API order within a family (does not re-sort by parsed version)", () => {
    const groups = buildModelGroups([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-8", display_name: "Claude Opus 4.8" },
      { id: "claude-opus-4-10", display_name: "Claude Opus 4.10" },
    ]);
    const opusGroup = groups.find((g) => g.label === "Opus");
    const ids = opusGroup.models.map((m) => m.id);
    // Opus 5 gets a (1M) variant inserted right after it; 4.8/4.10 order is
    // preserved exactly as given (API order), not numerically re-sorted.
    expect(ids).toEqual([
      "claude-opus-5",
      "claude-opus-5[1m]",
      "claude-opus-4-8",
      "claude-opus-4-8[1m]",
      "claude-opus-4-10",
      "claude-opus-4-10[1m]",
    ]);
  });

  it("inserts the synthesized (1M) variant immediately after its base entry", () => {
    const groups = buildModelGroups([{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }]);
    const sonnetGroup = groups.find((g) => g.label === "Sonnet");
    expect(sonnetGroup.models).toEqual([
      { id: "claude-sonnet-5", label: "Sonnet 5" },
      { id: "claude-sonnet-5[1m]", label: "Sonnet 5 (1M)" },
    ]);
  });

  it("does not synthesize a (1M) variant for Haiku/Fable families", () => {
    const groups = buildModelGroups([
      { id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      { id: "claude-fable-5", display_name: "Claude Fable 5" },
    ]);
    const haikuGroup = groups.find((g) => g.label === "Haiku");
    const fableGroup = groups.find((g) => g.label === "Fable");
    expect(haikuGroup.models).toEqual([{ id: "claude-haiku-4-5", label: "Haiku 4.5" }]);
    expect(fableGroup.models).toEqual([{ id: "claude-fable-5", label: "Fable 5" }]);
  });

  it("filters out deprecated/retired models before grouping, and never resurrects them via (1M)", () => {
    const groups = buildModelGroups([
      { id: "claude-opus-5", display_name: "Claude Opus 5" },
      { id: "claude-opus-4-1", display_name: "Claude Opus 4.1" },
      { id: "claude-opus-4-1-20250805", display_name: "Claude Opus 4.1" },
      { id: "claude-3-5-sonnet-20241022", display_name: "Claude Sonnet 3.5" },
    ]);
    const allIds = groups.flatMap((g) => g.models.map((m) => m.id));
    expect(allIds).not.toContain("claude-opus-4-1");
    expect(allIds).not.toContain("claude-opus-4-1-20250805");
    expect(allIds).not.toContain("claude-opus-4-1[1m]");
    expect(allIds).not.toContain("claude-3-5-sonnet-20241022");
    expect(allIds).not.toContain("claude-3-5-sonnet-20241022[1m]");
    expect(allIds).toContain("claude-opus-5");
  });

  it("falls back when every live model is filtered out as deprecated", () => {
    const groups = buildModelGroups([{ id: "claude-opus-4-0", display_name: "Claude Opus 4.0" }]);
    expect(groups).toBe(FALLBACK_MODEL_GROUPS);
  });
});

describe("isDeprecatedModel", () => {
  it("matches every id in DEPRECATED_MODEL_IDS exactly", () => {
    for (const id of DEPRECATED_MODEL_IDS) {
      expect(isDeprecatedModel(id)).toBe(true);
    }
  });

  it("matches dated variants via prefix", () => {
    expect(isDeprecatedModel("claude-opus-4-1-20250805")).toBe(true);
    expect(isDeprecatedModel("claude-3-5-sonnet-20241022")).toBe(true);
  });

  it("does not match unrelated ids, including ids that share a prefix substring without a hyphen boundary", () => {
    expect(isDeprecatedModel("claude-opus-5")).toBe(false);
    // "claude-opus-4-10" is NOT a dated variant of "claude-opus-4-1" — the
    // hyphen-boundary check (`id.startsWith(deprecatedId + "-")`) correctly
    // rejects it since the next char after "4-1" is "0", not "-".
    expect(isDeprecatedModel("claude-opus-4-10")).toBe(false);
    expect(isDeprecatedModel("claude-sonnet-5")).toBe(false);
  });

  it("returns false for non-string/empty input", () => {
    expect(isDeprecatedModel(null)).toBe(false);
    expect(isDeprecatedModel(undefined)).toBe(false);
    expect(isDeprecatedModel("")).toBe(false);
  });
});

describe("FALLBACK_MODEL_GROUPS shape", () => {
  it("is grouped by family in fixed order, ending with OPENROUTER_GROUP", () => {
    const labels = FALLBACK_MODEL_GROUPS.map((g) => g.label);
    expect(labels).toEqual(["Opus", "Sonnet", "Haiku", "Fable", "OpenRouter"]);
  });

  it("contains no deprecated model ids", () => {
    const allIds = FALLBACK_MODEL_GROUPS.flatMap((g) => g.models.map((m) => m.id));
    for (const id of allIds) {
      expect(isDeprecatedModel(id)).toBe(false);
    }
  });
});

describe("getModelProvider", () => {
  it("returns 'openrouter' for OpenRouter-group ids", () => {
    expect(getModelProvider("deepseek/deepseek-v4-pro")).toBe("openrouter");
  });

  it("returns 'local' for namespaced local ids", () => {
    expect(getModelProvider("local:lmstudio-local:qwen3-coder-30b")).toBe("local");
  });

  it("returns 'anthropic' for everything else", () => {
    expect(getModelProvider("claude-opus-5")).toBe("anthropic");
    expect(getModelProvider("sonnet")).toBe("anthropic");
  });
});

describe("parseLocalModelId", () => {
  it("round-trips provider/model ids built by buildLocalGroups", () => {
    expect(parseLocalModelId("local:lmstudio-local:qwen3-coder-30b")).toEqual({
      providerId: "lmstudio-local",
      modelId: "qwen3-coder-30b",
    });
  });

  it("preserves ':' characters inside the model id (e.g. quantization tags)", () => {
    expect(parseLocalModelId("local:vllm-local:qwen3:awq")).toEqual({
      providerId: "vllm-local",
      modelId: "qwen3:awq",
    });
  });

  it("returns null for non-local or malformed ids", () => {
    expect(parseLocalModelId("claude-opus-5")).toBeNull();
    expect(parseLocalModelId("local:onlyproviderid")).toBeNull();
    expect(parseLocalModelId(null)).toBeNull();
    expect(parseLocalModelId(undefined)).toBeNull();
  });
});

describe("buildLocalGroups", () => {
  const providers = [
    {
      id: "lmstudio-local",
      label: "LM Studio (local)",
      kind: "lmstudio",
      scope: "local",
      capabilities: ["models", "model-control"],
    },
    { id: "vllm-local", label: "vLLM (local)", kind: "vllm", scope: "local", capabilities: ["models"] },
  ];

  it("builds one group per reachable provider with models, namespaced by provider", () => {
    const modelsByProviderId = {
      "lmstudio-local": {
        reachable: true,
        models: [
          { id: "qwen3-coder-30b", state: "loaded" },
          { id: "llama-3.1-8b", state: "not-loaded" },
        ],
      },
      "vllm-local": {
        reachable: true,
        models: [{ id: "qwen3-coder-30b-awq", state: "loaded" }],
      },
    };
    const groups = buildLocalGroups(providers, modelsByProviderId);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ label: "LM Studio (local)", provider: "local" });
    expect(groups[0].models).toEqual([
      {
        id: "local:lmstudio-local:qwen3-coder-30b",
        label: "qwen3-coder-30b",
        provider: "local",
        localProviderId: "lmstudio-local",
        localModelId: "qwen3-coder-30b",
        loaded: true,
        canLoad: true,
        selectable: true,
        unavailableReason: null,
      },
      {
        id: "local:lmstudio-local:llama-3.1-8b",
        label: "llama-3.1-8b · not loaded",
        provider: "local",
        localProviderId: "lmstudio-local",
        localModelId: "llama-3.1-8b",
        loaded: false,
        canLoad: true,
        selectable: true,
        unavailableReason: null,
      },
    ]);
    expect(groups[1].label).toBe("vLLM (local)");
  });

  // The owner picked an unserved vLLM model from this list and their session
  // default silently became a model the engine cannot be made to serve.
  describe("provider WITHOUT model-control (external vLLM)", () => {
    const modelsByProviderId = {
      "vllm-local": {
        reachable: true,
        models: [
          { id: "qwen3-30b-instruct", state: "loaded" },
          { id: "/models/Qwen3-Coder-30B-A3B-AWQ", state: "not-loaded" },
        ],
      },
    };
    const group = () => buildLocalGroups([providers[1]], modelsByProviderId)[0];

    it("marks the unserved model unselectable, with a reason", () => {
      const unserved = group().models[1];
      expect(unserved.selectable).toBe(false);
      expect(unserved.canLoad).toBe(false);
      expect(unserved.unavailableReason).toBe(UNSERVED_MODEL_REASON);
      expect(unserved.unavailableReason).toMatch(/restart it with this model/i);
    });

    it("distinguishes the served model — selectable, and labelled without a caveat", () => {
      const served = group().models[0];
      expect(served.selectable).toBe(true);
      expect(served.loaded).toBe(true);
      expect(served.label).toBe("qwen3-30b-instruct");
    });

    it("labels unserved models 'on disk, not served', never 'not loaded'", () => {
      const unserved = group().models[1];
      expect(unserved.label).toBe(`/models/Qwen3-Coder-30B-A3B-AWQ · ${UNSERVED_MODEL_SUFFIX}`);
      expect(unserved.label).not.toMatch(/not loaded/);
    });

    it("keeps unserved models in the list (browse) and notes why the group is limited", () => {
      expect(group().models).toHaveLength(2);
      expect(group().note).toBe(BROWSE_ONLY_NOTE);
      expect(group().canLoad).toBe(false);
    });
  });

  it("leaves a model-control provider fully selectable and un-noted", () => {
    const groups = buildLocalGroups([providers[0]], {
      "lmstudio-local": { reachable: true, models: [{ id: "a", state: "not-loaded" }] },
    });
    expect(groups[0].note).toBeUndefined();
    expect(groups[0].models[0]).toMatchObject({ selectable: true, canLoad: true, label: "a · not loaded" });
  });

  it("omits unreachable providers", () => {
    const modelsByProviderId = {
      "lmstudio-local": { reachable: false },
      "vllm-local": { reachable: true, models: [{ id: "m", state: "loaded" }] },
    };
    const groups = buildLocalGroups(providers, modelsByProviderId);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("vLLM (local)");
  });

  it("omits reachable providers with zero models", () => {
    const modelsByProviderId = {
      "lmstudio-local": { reachable: true, models: [] },
      "vllm-local": { reachable: true, models: [{ id: "m", state: "loaded" }] },
    };
    const groups = buildLocalGroups(providers, modelsByProviderId);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("vLLM (local)");
  });

  it("flags a default that disagrees with the served model", () => {
    const groups = buildLocalGroups([providers[1]], {
      "vllm-local": {
        reachable: true,
        models: [
          { id: "served", state: "loaded" },
          { id: "other", state: "not-loaded" },
        ],
      },
    });
    expect(isUnservedSelection(groups[0].models[1])).toBe(true);
    expect(isUnservedSelection(groups[0].models[0])).toBe(false);
    expect(isUnservedSelection({ id: "claude-opus-5", label: "Opus 5" })).toBe(false);
    expect(isUnservedSelection(undefined)).toBe(false);
  });

  it("returns an empty array for missing/invalid input", () => {
    expect(buildLocalGroups(null, {})).toEqual([]);
    expect(buildLocalGroups(undefined, undefined)).toEqual([]);
    expect(buildLocalGroups([], {})).toEqual([]);
  });
});
