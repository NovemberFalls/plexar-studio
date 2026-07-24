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

describe("LocalMetricsPanel", () => {
  it("renders runs, prompts, tokens and derived runs/prompt", () => {
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText("812")).toBeInTheDocument();
    expect(screen.getByText("640")).toBeInTheDocument();
    expect(screen.getByText(/1\.27 runs\/prompt/)).toBeInTheDocument(); // 812/640
  });

  it("calls setWindow when a window button is clicked", () => {
    const setWindow = vi.fn();
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={setWindow} />);
    fireEvent.click(screen.getByText("24h"));
    expect(setWindow).toHaveBeenCalledWith("24h");
  });

  it("renders the broker definitions as distinguishable term/definition rows", () => {
    render(<LocalMetricsPanel metrics={METRICS} window="lifetime" setWindow={() => {}} />);
    // Terms are separate elements from their definitions (not one crushed line).
    expect(screen.getByText("run")).toBeInTheDocument();
    expect(screen.getByText(/one completion call to a lane/)).toBeInTheDocument();
    // "session" also appears as the by-session breakdown header — ≥1 is the dt.
    expect(screen.getAllByText("session").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("X-Client-Id")).toBeInTheDocument();
  });
});

describe("LocalMetricsPanel — token honesty", () => {
  it("shows 'not reported' when runs exist but tokens are zero", () => {
    const m = { ...METRICS, tokens_total: { prompt: 0, completion: 0 } };
    render(<LocalMetricsPanel metrics={m} window="lifetime" setWindow={() => {}} />);
    expect(screen.getByText("not reported")).toBeInTheDocument();
    expect(screen.getByText(/stream_options\.include_usage/)).toBeInTheDocument();
  });
});

describe("LocalBrokerView", () => {
  const STATUS_OK = { reachable: true, compatible: true, service: "lane-broker", url: "http://127.0.0.1:1235" };
  const STATUS_LMS = { reachable: true, compatible: false, service: "lmstudio", url: "http://127.0.0.1:1235" };

  it("renders connection + queue + reporting when broker connected", () => {
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={STATUS_OK}
        localQueue={QUEUE}
        localSpill={SPILL}
        localMetrics={METRICS}
        metricsWindow="lifetime"
        setMetricsWindow={() => {}}
        onSpillChange={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText("Lane broker connected")).toBeInTheDocument();
    expect(screen.getByText("Queue & Spill")).toBeInTheDocument();
    expect(screen.getByText("Reporting")).toBeInTheDocument();
  });

  it("names the wrong service and hides queue/reporting when incompatible", () => {
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={STATUS_LMS}
        localQueue={null}
        localSpill={null}
        localMetrics={null}
        metricsWindow="lifetime"
        setMetricsWindow={() => {}}
        onSpillChange={() => {}}
        onClose={() => {}}
      />
    );
    expect(screen.getByText(/LM Studio is answering/)).toBeInTheDocument();
    expect(screen.queryByText("Queue & Spill")).not.toBeInTheDocument();
  });

  it("close button calls onClose", () => {
    const onClose = vi.fn();
    render(
      <LocalBrokerView
        localEnabled={false}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        localSpill={null}
        localMetrics={null}
        metricsWindow="lifetime"
        setMetricsWindow={() => {}}
        onSpillChange={() => {}}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByLabelText("Close Local Broker view"));
    expect(onClose).toHaveBeenCalled();
  });
});
