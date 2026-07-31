/**
 * Reports ▸ Local engine — Cockpit's reporting married to Plexar's.
 *
 * The rules under test are the ones that make two reports into one defensible
 * view rather than one indefensible number:
 *
 *   · figures are GROUPED by source, never merged — a Prometheus counter and a
 *     gateway request record mean different things by the same integer;
 *   · a cumulative-since-start figure says so, because only lifetime is exact
 *     for it;
 *   · an unreachable Plexar renders its reason, never an empty table (empty
 *     reads as "zero engine activity", which is the opposite claim);
 *   · a null gauge renders as an em dash, never 0.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import LocalEnginePanel from "../components/reports/LocalEnginePanel.jsx";
import { toPlexarRange } from "../components/reports/format.js";

const REPORTS = {
  available: true,
  range: "lifetime",
  figures: [
    { key: "requests", value: 8, source: "gateway-requests", window_exact: true },
    { key: "errors", value: 1, source: "gateway-requests", window_exact: true },
    { key: "runs_total", value: 10, source: "vllm-prometheus", window_exact: false },
  ],
  sources: {},
  engine_unknown: null,
};

const INSTANCES = {
  available: true,
  instances: [{
    id: "gpu-main",
    served_model_name: "qwen3-coder-30b-awq",
    state: "serving",
    available: true,
    reason: null,
    action: null,
    external: true,
    live: { available: true, running: 0, tokens_per_sec: 55.05 },
  }],
};

const GPUS = {
  available: true,
  gpus: [{ uuid: "GPU-1", name: "RTX 3090", total_mb: 24576, free_mb: 20314, used_by_display: true }],
};

function mockRoutes({ reports = REPORTS, instances = INSTANCES, gpus = GPUS } = {}) {
  const seen = [];
  globalThis.fetch = vi.fn((url) => {
    seen.push(url);
    const body = url.includes("/reports")
      ? reports
      : url.includes("/instances")
        ? instances
        : gpus;
    if (body === null) return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
  return seen;
}

afterEach(() => vi.restoreAllMocks());

describe("toPlexarRange", () => {
  it("maps Reports' 'all' onto Plexar's 'lifetime' and passes the rest through", () => {
    expect(toPlexarRange("all")).toBe("lifetime");
    expect(toPlexarRange("24h")).toBe("24h");
    expect(toPlexarRange("7d")).toBe("7d");
    expect(toPlexarRange("30d")).toBe("30d");
  });
});

describe("LocalEnginePanel", () => {
  it("groups figures under their source rather than merging them", async () => {
    mockRoutes();
    render(<LocalEnginePanel range="all" />);

    expect(await screen.findByText("Gateway requests")).toBeInTheDocument();
    expect(screen.getByText("vLLM engine")).toBeInTheDocument();
    // Both figures present, each under its own heading.
    expect(screen.getByText("requests")).toBeInTheDocument();
    expect(screen.getByText("runs total")).toBeInTheDocument();
  });

  it("warns that engine counters are not scoped to the selected range", async () => {
    mockRoutes();
    render(<LocalEnginePanel range="7d" />);
    expect(
      await screen.findByText(/cumulative since it last started/i)
    ).toBeInTheDocument();
  });

  it("does not warn when every figure is window-exact", async () => {
    mockRoutes({
      reports: {
        ...REPORTS,
        figures: [{ key: "requests", value: 8, source: "gateway-requests", window_exact: true }],
      },
    });
    render(<LocalEnginePanel range="7d" />);
    await screen.findByText("Gateway requests");
    expect(screen.queryByText(/cumulative since it last started/i)).not.toBeInTheDocument();
  });

  it("requests the mapped range", async () => {
    const seen = mockRoutes();
    render(<LocalEnginePanel range="all" />);
    await screen.findByText("Gateway requests");
    expect(seen.some((u) => u.includes("range=lifetime"))).toBe(true);
  });

  it("shows an engine's state and, when it cannot serve, its remediation", async () => {
    mockRoutes({
      instances: {
        available: true,
        instances: [{
          id: "gpu-main",
          served_model_name: "qwen",
          state: "unreachable",
          available: false,
          reason: "adopted an engine already answering",
          action: "the container is running but not answering — check logs, then restart",
          eta_seconds: null,
        }],
      },
    });
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText(/check logs, then restart/)).toBeInTheDocument();
  });

  it("shows a loading engine's ETA rather than a flat failure", async () => {
    mockRoutes({
      instances: {
        available: true,
        instances: [{
          id: "gpu-main", served_model_name: "qwen", state: "loading",
          available: false, reason: "container starting",
          action: "waiting for the engine", eta_seconds: 30,
        }],
      },
    });
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText("loading")).toBeInTheDocument();
    expect(screen.getByText(/~30s/)).toBeInTheDocument();
  });

  it("renders a reason, not an empty table, when Plexar is unreachable", async () => {
    mockRoutes({
      reports: { available: false, reason: "unreachable", detail: "Plexar is not answering." },
    });
    render(<LocalEnginePanel range="all" />);

    expect(await screen.findByText(/No local engine history/i)).toBeInTheDocument();
    expect(screen.getByText(/Plexar is not answering/)).toBeInTheDocument();
    // The critical assertion: no figures table implying zero activity.
    expect(screen.queryByText("Gateway requests")).not.toBeInTheDocument();
  });

  it("treats a payload without an explicit availability flag as unreadable", async () => {
    // e.g. some other endpoint's 200 body. Falling through would render an
    // empty figures table, which reads as "zero engine activity".
    mockRoutes({ reports: { kpis: {}, sessions: [] } });
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText(/No local engine history/i)).toBeInTheDocument();
  });

  it("renders a null figure as an em dash, never as 0", async () => {
    mockRoutes({
      reports: {
        ...REPORTS,
        figures: [{ key: "tokens", value: null, source: "vllm-prometheus", window_exact: true }],
      },
    });
    render(<LocalEnginePanel range="all" />);
    await screen.findByText("vLLM engine");
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("reports unread engine counters as absent rather than zero", async () => {
    mockRoutes({ reports: { ...REPORTS, engine_unknown: { instances: 2 } } });
    render(<LocalEnginePanel range="all" />);
    expect(
      await screen.findByText(/absent rather than shown as zero/i)
    ).toBeInTheDocument();
  });

  it("lists GPUs with free/total VRAM", async () => {
    mockRoutes();
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText(/RTX 3090/)).toBeInTheDocument();
    expect(screen.getByText(/20,314 \/ 24,576 MB free/)).toBeInTheDocument();
  });

  it("survives Plexar answering for reports but not for GPUs", async () => {
    mockRoutes({ gpus: null });
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText("Gateway requests")).toBeInTheDocument();
    expect(screen.queryByText(/RTX 3090/)).not.toBeInTheDocument();
  });
});
