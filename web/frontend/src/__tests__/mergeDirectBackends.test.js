/**
 * Unit tests for mergeDirectBackends — folding a direct-served backend (vLLM)
 * into a broker-shaped metrics object so it appears as a backend column and
 * counts toward local totals (Routing & Reporting).
 */
import { describe, it, expect } from "vitest";
import { mergeDirectBackends } from "../components/localReporting/useReportingData.js";

const vllm = {
  reachable: true,
  runs_total: 12,
  served_model: "qwen3-coder-30b-awq",
  tokens_total: { prompt: 15000, completion: 687 },
  ttft_ms: { p50: 100, p95: 900 },
  decode_tokens_per_sec: { avg: 90 },
  run_time_ms: { p50: 1000, p95: 2000 },
};

describe("mergeDirectBackends", () => {
  it("adds a by_provider row and folds runs/tokens into the base totals", () => {
    const base = { reachable: true, runs_total: 0, tokens_total: { prompt: 0, completion: 0 }, by_provider: [] };
    const out = mergeDirectBackends(base, [{ id: "vllm-local", label: "vLLM (local)", metrics: vllm }]);
    expect(out.by_provider).toHaveLength(1);
    expect(out.by_provider[0]).toMatchObject({ id: "vllm-local", label: "vLLM (local)", model: "qwen3-coder-30b-awq", runs_total: 12 });
    expect(out.runs_total).toBe(12);
    expect(out.tokens_total).toEqual({ prompt: 15000, completion: 687 });
  });

  it("preserves existing by_provider rows and the base's own runs", () => {
    const base = { reachable: true, runs_total: 5, tokens_total: { prompt: 100, completion: 50 }, by_provider: [{ id: "x", runs_total: 5 }] };
    const out = mergeDirectBackends(base, [{ id: "vllm-local", label: "vLLM", metrics: vllm }]);
    expect(out.by_provider.map((r) => r.id)).toEqual(["x", "vllm-local"]);
    expect(out.runs_total).toBe(17); // 5 + 12
    expect(out.tokens_total).toEqual({ prompt: 15100, completion: 737 });
  });

  it("synthesizes a base when the broker metrics is offline", () => {
    const out = mergeDirectBackends({ reachable: false }, [{ id: "vllm-local", label: "vLLM", metrics: vllm }]);
    expect(out.reachable).toBe(true);
    expect(out.runs_total).toBe(12);
    expect(out.by_provider).toHaveLength(1);
  });

  it("returns base unchanged when no direct backend is reachable", () => {
    const base = { reachable: true, runs_total: 3, tokens_total: { prompt: 1, completion: 1 } };
    expect(mergeDirectBackends(base, [{ id: "v", label: "v", metrics: { reachable: false } }])).toBe(base);
    expect(mergeDirectBackends(base, [])).toBe(base);
  });
});
