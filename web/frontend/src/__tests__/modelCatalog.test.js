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
  getModelProvider,
  parseLocalModelId,
} from "../modelCatalog.js";

describe("buildModelGroups (unchanged fallback contract)", () => {
  it("falls back to FALLBACK_MODEL_GROUPS for empty/invalid input", () => {
    expect(buildModelGroups([])).toBe(FALLBACK_MODEL_GROUPS);
    expect(buildModelGroups(null)).toBe(FALLBACK_MODEL_GROUPS);
    expect(buildModelGroups(undefined)).toBe(FALLBACK_MODEL_GROUPS);
  });

  it("groups live models by generation and appends OPENROUTER_GROUP", () => {
    const groups = buildModelGroups([
      { id: "claude-opus-5-x", display_name: "Claude Opus 5" },
      { id: "claude-sonnet-5-x", display_name: "Claude Sonnet 5" },
    ]);
    expect(groups[0].label).toBe("Claude 5");
    expect(groups.at(-1)).toBe(OPENROUTER_GROUP);
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
    { id: "lmstudio-local", label: "LM Studio (local)", kind: "lmstudio", scope: "local", capabilities: ["models"] },
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
      },
      {
        id: "local:lmstudio-local:llama-3.1-8b",
        label: "llama-3.1-8b · not loaded",
        provider: "local",
        localProviderId: "lmstudio-local",
        localModelId: "llama-3.1-8b",
        loaded: false,
      },
    ]);
    expect(groups[1].label).toBe("vLLM (local)");
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

  it("returns an empty array for missing/invalid input", () => {
    expect(buildLocalGroups(null, {})).toEqual([]);
    expect(buildLocalGroups(undefined, undefined)).toEqual([]);
    expect(buildLocalGroups([], {})).toEqual([]);
  });
});
