/**
 * Unit tests for assembleReportingMetrics — assembling ALL used local providers
 * into backend columns + local totals for the Routing & Reporting view.
 */
import { describe, it, expect } from "vitest";
import { assembleReportingMetrics } from "../components/localReporting/useReportingData.js";

const vllm = {
  reachable: true,
  runs_total: 12,
  served_model: "qwen3-coder-30b-awq",
  tokens_total: { prompt: 15000, completion: 687 },
  ttft_ms: { p50: 100, p95: 900 },
  decode_tokens_per_sec: { avg: 90 },
  run_time_ms: { p50: 1000, p95: 2000 },
};
const lmstudio = {
  reachable: true,
  runs_total: 5,
  tokens_total: { prompt: 100, completion: 50 },
  queue_wait_ms: { p50: 20 },
};

describe("assembleReportingMetrics", () => {
  it("builds a column for EVERY used provider and sums local totals", () => {
    const rows = [
      { id: "lmstudio-local", label: "LM Studio", metrics: lmstudio },
      { id: "vllm-local", label: "vLLM (local)", metrics: vllm },
    ];
    const out = assembleReportingMetrics(lmstudio, rows);
    expect(out.by_provider.map((r) => r.id)).toEqual(["lmstudio-local", "vllm-local"]);
    expect(out.by_provider[1]).toMatchObject({ label: "vLLM (local)", model: "qwen3-coder-30b-awq", runs_total: 12 });
    expect(out.runs_total).toBe(17); // 5 + 12
    expect(out.tokens_total).toEqual({ prompt: 15100, completion: 737 });
  });

  it("omits idle (runs_total 0) and unreachable providers", () => {
    const rows = [
      { id: "lmstudio-local", label: "LM Studio", metrics: { ...lmstudio, runs_total: 0 } },
      { id: "vllm-local", label: "vLLM", metrics: vllm },
      { id: "dead", label: "Dead", metrics: { reachable: false } },
    ];
    const out = assembleReportingMetrics(lmstudio, rows);
    expect(out.by_provider.map((r) => r.id)).toEqual(["vllm-local"]);
    expect(out.runs_total).toBe(12);
  });

  it("keeps primary top-level fields (hero/queue) while summing runs across all", () => {
    const rows = [
      { id: "lmstudio-local", label: "LM Studio", metrics: lmstudio },
      { id: "vllm-local", label: "vLLM", metrics: vllm },
    ];
    const out = assembleReportingMetrics(lmstudio, rows);
    expect(out.queue_wait_ms).toEqual({ p50: 20 }); // from the primary
    expect(out.runs_total).toBe(17);
  });

  it("assembles even when the primary is offline, from the reachable ones", () => {
    const rows = [
      { id: "lmstudio-local", label: "LM Studio", metrics: { reachable: false } },
      { id: "vllm-local", label: "vLLM", metrics: vllm },
    ];
    const out = assembleReportingMetrics({ reachable: false }, rows);
    expect(out.reachable).toBe(true);
    expect(out.runs_total).toBe(12);
    expect(out.by_provider).toHaveLength(1);
  });

  it("returns the primary unchanged when nothing has run", () => {
    const primary = { reachable: true, runs_total: 0, tokens_total: { prompt: 0, completion: 0 } };
    const rows = [{ id: "vllm-local", label: "vLLM", metrics: { reachable: false } }];
    expect(assembleReportingMetrics(primary, rows)).toBe(primary);
    expect(assembleReportingMetrics(primary, [])).toBe(primary);
  });
});
