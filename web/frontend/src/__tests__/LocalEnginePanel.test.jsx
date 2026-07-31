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
    container: "plexar-vllm-gpu-main",
    container_reason: null,
    live: { available: true, running: 0, tokens_per_sec: 55.05 },
  }],
};

const GPUS = {
  available: true,
  gpus: [{ uuid: "GPU-1", name: "RTX 3090", total_mb: 24576, free_mb: 20314, used_by_display: true }],
};

const SERIES = {
  available: true,
  range: "lifetime",
  bucket: "1d",
  truncated: false,
  series: {
    "gateway-requests": {
      window_exact: true,
      buckets: [
        { t: "1", requests: 12, errors: 1, ttft_ms: { p95: 400 } },
        // A quiet hour: a MEASURED zero, and nothing measured.
        { t: "2", requests: 0, errors: 0, ttft_ms: { p95: null } },
        { t: "3", requests: 8, errors: 0, ttft_ms: { p95: 610 } },
      ],
    },
    "vllm-prometheus": {
      window_exact: false,
      buckets: [
        { t: "1", tps_avg: 40, kv_cache_pct: { mean: 20 } },
        { t: "2", tps_avg: null, kv_cache_pct: { mean: null } },
        { t: "3", tps_avg: 90, kv_cache_pct: { mean: 55 } },
      ],
    },
  },
};

function mockRoutes({
  reports = REPORTS, instances = INSTANCES, gpus = GPUS, series = SERIES,
} = {}) {
  const seen = [];
  globalThis.fetch = vi.fn((url) => {
    seen.push(url);
    const body = url.includes("/timeseries")
      ? series
      : url.includes("/reports")
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
      series: {
        available: true,
        series: { "gateway-requests": { window_exact: true, buckets: [] } },
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

  it("shows the container name, which is what `docker logs` needs", async () => {
    mockRoutes();
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText("plexar-vllm-gpu-main")).toBeInTheDocument();
  });

  it("says a container could not be identified rather than going blank", async () => {
    // A null container means "we could not determine it", never "there is no
    // container" — something is answering, which is why it was adopted.
    mockRoutes({
      instances: {
        available: true,
        instances: [{
          id: "gpu-main", served_model_name: "qwen", state: "serving",
          available: true, external: true, container: null,
          container_reason: "two containers publish this port",
        }],
      },
    });
    render(<LocalEnginePanel range="all" />);
    const marker = await screen.findByText("container not identified");
    expect(marker).toHaveAttribute("title", "two containers publish this port");
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

/**
 * Bucketed history. `/reports` gives window totals; a client could otherwise
 * only diff repeated polls, which is not history and dies on reload.
 *
 * The charts inherit every rule the figures already obey — and add one: an
 * empty bucket is emitted by Plexar deliberately, so that a gap and a zero can
 * be told apart. That only pays off if the renderer honours the difference.
 */
describe("LocalEnginePanel — history", () => {
  it("draws each source's history inside that source's own card", async () => {
    mockRoutes();
    render(<LocalEnginePanel range="all" />);

    expect(await screen.findByLabelText("Requests over time")).toBeInTheDocument();
    expect(screen.getByLabelText("Tokens/sec over time")).toBeInTheDocument();
    // The rule this panel exists for: never one line drawn from both sources.
    const gateway = screen.getByText("Gateway requests").closest("div").parentElement;
    expect(gateway.querySelector('[aria-label="Tokens/sec over time"]')).toBeNull();
  });

  it("omits the bucket so Plexar keeps ownership of the 720-point rule", async () => {
    const seen = mockRoutes();
    render(<LocalEnginePanel range="all" />);
    await screen.findByLabelText("Requests over time");
    const ts = seen.find((u) => u.includes("/timeseries"));
    expect(ts).toContain("range=lifetime");
    expect(ts).not.toContain("bucket=");
  });

  it("breaks a gauge line at a null instead of sloping through the axis", async () => {
    mockRoutes();
    render(<LocalEnginePanel range="all" />);
    const svg = await screen.findByLabelText("Tokens/sec over time");
    // Two measured runs either side of the unmeasured bucket → two polylines.
    expect(svg.querySelectorAll("polyline").length).toBe(2);
  });

  it("still draws a measured zero, because it is an observation", async () => {
    mockRoutes();
    render(<LocalEnginePanel range="all" />);
    const svg = await screen.findByLabelText("Requests over time");
    // All three buckets are measured (12, 0, 8) — the zero must not vanish, or
    // it becomes indistinguishable from a bucket that could not be read.
    expect(svg.querySelectorAll("rect").length).toBe(3);
  });

  it("renders nothing for a metric no bucket ever reported", async () => {
    mockRoutes({
      series: {
        available: true,
        series: {
          "gateway-requests": {
            window_exact: true,
            buckets: [{ t: "1", requests: 5, ttft_ms: { p95: null } }],
          },
        },
      },
    });
    render(<LocalEnginePanel range="all" />);
    await screen.findByLabelText("Requests over time");
    expect(screen.queryByLabelText("TTFT p95 over time")).toBeNull();
  });

  it("says so when history is clipped by retention", async () => {
    mockRoutes({ series: { ...SERIES, truncated: true } });
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText(/clipped rather than complete/i)).toBeInTheDocument();
  });

  it("shows the figures when history is unavailable, and vice versa", async () => {
    mockRoutes({ series: { available: false, reason: "unreachable" } });
    render(<LocalEnginePanel range="all" />);
    expect(await screen.findByText("Gateway requests")).toBeInTheDocument();
    expect(screen.queryByLabelText("Requests over time")).toBeNull();
  });

  it("renders a source that has history but no summary figure", async () => {
    mockRoutes({
      reports: {
        ...REPORTS,
        figures: [{ key: "requests", value: 8, source: "gateway-requests", window_exact: true }],
      },
    });
    render(<LocalEnginePanel range="all" />);
    // vLLM contributes no figure in this window, but it does have history —
    // keying the cards off figures alone would silently drop the whole chart.
    expect(await screen.findByText("vLLM engine")).toBeInTheDocument();
    expect(screen.getByLabelText("Tokens/sec over time")).toBeInTheDocument();
  });

  it("warns when a series is cumulative, even if every figure was exact", async () => {
    mockRoutes({
      reports: {
        ...REPORTS,
        figures: [{ key: "requests", value: 8, source: "gateway-requests", window_exact: true }],
      },
    });
    render(<LocalEnginePanel range="7d" />);
    expect(
      await screen.findByText(/cumulative since it last started/i)
    ).toBeInTheDocument();
  });
});
