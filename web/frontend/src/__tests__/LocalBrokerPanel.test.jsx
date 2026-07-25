/**
 * Tests for the local-broker panels
 * (LaneQueuePanel.jsx + LocalMetricsPanel.jsx).
 *
 * Covers:
 *   1. LaneQueuePanel renders in-flight + queued jobs and the spill count.
 *   2. LaneQueuePanel shows an offline message when queue is null/unreachable.
 *   3. LaneQueuePanel's spill slider is disabled (broker write endpoint not wired).
 *   4. LocalMetricsPanel renders runs/prompts/tokens + derived runs-per-prompt.
 *   5. LocalMetricsPanel window buttons call setWindow.
 *   6. LocalMetricsPanel renders the verbatim broker definitions.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import LaneQueuePanel from "../components/LaneQueuePanel.jsx";
import LocalMetricsPanel from "../components/LocalMetricsPanel.jsx";
import LocalBrokerView from "../components/LocalBrokerView.jsx";

// Pinned /queue shape (broker.py::_queue_state, confirmed 2026-07-24).
const QUEUE = {
  shadow: true,
  in_flight: { class: "workhorse", elapsed_s: 12.5, predicted_remaining_s: 30.2, model: "qwen/qwen3.6-27b", client_id: "bench-1" },
  queued: [
    { class: "mundane", position: 0, predicted_wall_s: 45.0, waiting_s: 5.1, model: "qwen/qwen3.6-27b", client_id: "bench-2" },
    { class: "workhorse", position: 1, predicted_wall_s: 90.0, waiting_s: 2.0, model: "qwen/qwen3.6-27b", client_id: "bench-3" },
  ],
  estimated_clear_seconds: 42.0,
};

const SPILL = {
  spill_thresholds_s: { interactive: 30, worker: 300, batch: null },
  spilled_total: 5,
  spilled_by_class: { interactive: 5 },
  persisted: false,
};

const METRICS = {
  window: "lifetime",
  window_start: "2026-07-01T00:00:00Z",
  persisted: true,
  runs_total: 812,
  prompts_total: 640,
  tokens_total: { prompt: 900000, completion: 300000 },
  tokens_per_sec: { current: 34, avg: 29 },
  run_time_ms: { min: 120, max: 90000, avg: 4200, p50: 3000, p95: 12000 },
  by_session: [{ key: "client-a", runs_total: 400, prompts_total: 320, tokens_total: { prompt: 500000, completion: 150000 } }],
  by_agent: [{ key: "ash", runs_total: 200, prompts_total: 200, tokens_total: { prompt: 200000, completion: 60000 } }],
  by_lane_class: [{ key: "workhorse", runs_total: 600, prompts_total: 480, tokens_total: { prompt: 700000, completion: 250000 } }],
};

describe("LaneQueuePanel", () => {
  it("renders in-flight + queued jobs with pinned field names", () => {
    render(<LaneQueuePanel queue={QUEUE} spillConfig={SPILL} onSpillChange={() => {}} />);
    expect(screen.getAllByText(/workhorse/).length).toBeGreaterThanOrEqual(1);
    // spilled counter comes from /config/spill (spilled_total), not /queue
    expect(screen.getByText(/spilled: 5/)).toBeInTheDocument();
    expect(screen.getByText(/queued: 2 · shadow mode/)).toBeInTheDocument();
    expect(screen.getByText(/clears ~42s/)).toBeInTheDocument();
    // in-flight row shows elapsed + predicted remaining from pinned fields
    expect(screen.getByText(/13s in · ~30s left/)).toBeInTheDocument();
  });

  it("shows offline message when queue is null", () => {
    render(<LaneQueuePanel queue={null} />);
    expect(screen.getByText(/Broker offline/)).toBeInTheDocument();
  });

  it("renders one spill slider per lane class from spillConfig", () => {
    render(<LaneQueuePanel queue={QUEUE} spillConfig={SPILL} onSpillChange={() => {}} />);
    // interactive + worker + batch = 3 sliders
    expect(screen.getAllByRole("slider")).toHaveLength(3);
    expect(screen.getByText("Interactive")).toBeInTheDocument();
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("Batch")).toBeInTheDocument();
  });

  it("enabled classes have an active slider; null classes are off", () => {
    render(<LaneQueuePanel queue={QUEUE} spillConfig={SPILL} onSpillChange={() => {}} />);
    const interactive = screen.getByLabelText(/Interactive spill threshold/);
    const batch = screen.getByLabelText(/Batch spill threshold/);
    expect(interactive).not.toBeDisabled(); // 30s → active
    expect(batch).toBeDisabled();           // null → off
  });

  it("toggling a class off calls onSpillChange with null", () => {
    const onSpillChange = vi.fn();
    render(<LaneQueuePanel queue={QUEUE} spillConfig={SPILL} onSpillChange={onSpillChange} />);
    // Interactive (30s) + Worker (300s) render as "on"; batch (null) is "off".
    // Clicking the first "on" toggle disables interactive → onSpillChange(_, null).
    const onButtons = screen.getAllByRole("button", { name: "on" });
    fireEvent.click(onButtons[0]);
    expect(onSpillChange).toHaveBeenCalledWith("interactive", null);
  });

  it("shows spill controls unavailable when broker offline", () => {
    render(<LaneQueuePanel queue={QUEUE} spillConfig={{ reachable: false }} onSpillChange={() => {}} />);
    expect(screen.getByText(/spill controls unavailable/)).toBeInTheDocument();
  });
});

describe("LocalMetricsPanel — Overview (default)", () => {
  it("leads with a savings hero: local tokens valued at the reference model", () => {
    // 900k prompt + 300k completion at Sonnet ($3/$15 per 1M) = 2.70 + 4.50 = $7.20
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText("$7.20")).toBeInTheDocument();
    expect(screen.getByText(/Saved vs API/i)).toBeInTheDocument();
  });

  it("recomputes savings when the reference model changes", () => {
    // Same tokens at Opus ($5/$25) = 4.50 + 7.50 = $12.00
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Opus 5" }));
    expect(screen.getByText("$12.00")).toBeInTheDocument();
  });

  it("shows real (token-bearing) requests, not the probe-inflated total", () => {
    // by_session: client-a has 400 token-bearing runs; runs_total 812 incl. probes
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText("400")).toBeInTheDocument();
    expect(screen.getByText(/812 incl\. probes/)).toBeInTheDocument();
  });

  it("shows live queue depth + ETA from the queue prop", () => {
    render(<LocalMetricsPanel metrics={METRICS} queue={QUEUE} window="lifetime" setWindow={() => {}} />);
    // QUEUE: 1 in-flight + 2 queued = 3 deep
    expect(screen.getByText("3 deep")).toBeInTheDocument();
    expect(screen.getByText(/to clear/)).toBeInTheDocument();
  });

  it("names the busiest session", () => {
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText(/Busiest sessions/i)).toBeInTheDocument();
    expect(screen.getByText("client-a")).toBeInTheDocument();
  });

  it("calls setWindow when a window button is clicked", () => {
    const setWindow = vi.fn();
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={setWindow} />);
    fireEvent.click(screen.getByText("24h"));
    expect(setWindow).toHaveBeenCalledWith("24h");
  });

  it("surfaces the 'usage not reported' hint when runs exist but tokens are zero", () => {
    const m = { ...METRICS, tokens_total: { prompt: 0, completion: 0 } };
    render(<LocalMetricsPanel metrics={m} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText(/stream_options\.include_usage/)).toBeInTheDocument();
  });
});

describe("LocalMetricsPanel — API detail tab (lower layer)", () => {
  const NOISY = {
    ...METRICS,
    runs_total: 18,
    prompts_total: 18,
    tokens_total: { prompt: 17, completion: 10 },
    by_session: [
      ...Array.from({ length: 17 }, (_, i) => ({
        key: `127.0.0.1:${60000 + i}`,
        runs_total: 1,
        prompts_total: 1,
        tokens_total: { prompt: 0, completion: 0 },
      })),
      { key: "cockpit-verify", runs_total: 1, prompts_total: 1, tokens_total: { prompt: 17, completion: 10 } },
    ],
  };

  const openDetail = () => fireEvent.click(screen.getByRole("button", { name: "API detail" }));

  it("shows raw runs/prompts and the verbatim broker definitions", () => {
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    openDetail();
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("640")).toBeInTheDocument();
    expect(screen.getByText("run")).toBeInTheDocument();
    expect(screen.getByText(/one completion call to a lane/)).toBeInTheDocument();
    expect(screen.getByText("X-Client-Id")).toBeInTheDocument();
  });

  it("de-noises: token-bearing row surfaces, probe tail capped behind '+N more'", () => {
    render(<LocalMetricsPanel metrics={NOISY} window="lifetime" setWindow={() => {}} />);
    openDetail();
    expect(screen.getByText("cockpit-verify")).toBeInTheDocument();
    expect(screen.getByText(/\+10 more/)).toBeInTheDocument(); // 18 rows → 8 shown, 10 hidden
  });
});

describe("LocalBrokerView", () => {
  const STATUS_OK = { reachable: true, compatible: true, service: "lane-broker", url: "http://127.0.0.1:1235" };
  const STATUS_LMS = { reachable: true, compatible: false, service: "lmstudio", url: "http://127.0.0.1:1235" };

  it("mounts the Routing & Reporting dashboard with a live badge when connected", () => {
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={STATUS_OK}
        localQueue={{ ...QUEUE, shadow: false }}
        onSpillChange={() => {}}
        onToast={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/ROUTING & REPORTING/i)).toBeInTheDocument();
    expect(screen.getByText("broker live")).toBeInTheDocument();
    // Lead-with control + backend toolbar are always present when enabled.
    expect(screen.getByText("Lead with")).toBeInTheDocument();
  });

  it("exposes Connection identity via the header settings popover", () => {
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={STATUS_LMS}
        localQueue={null}
        onSpillChange={() => {}}
        onToast={() => {}}
        onClose={() => {}}
      />
    );
    // Wrong service => badge reads offline and the reporting body is gated.
    expect(screen.getByText("broker offline")).toBeInTheDocument();
    // Connection detail is behind the settings popover, opened from the badge.
    expect(screen.queryByText(/LM Studio is answering/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));
    expect(screen.getByText(/LM Studio is answering/)).toBeInTheDocument();
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <LocalBrokerView
        localEnabled={false}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        onSpillChange={() => {}}
        onToast={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByLabelText("Close Routing & Reporting view"));
    expect(onClose).toHaveBeenCalled();
  });
});
