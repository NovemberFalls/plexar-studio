/**
 * Engine ▸ frame tests: tab routing, the two hand-off links, the polling gate,
 * and the offline contract (unknown must never render as a measured zero).
 *
 * The polling assertions are the load-bearing ones: Engine polls the provider
 * every 3s, and eight live terminals plus an unguarded background loop is real
 * cost. `active=false` must tear the intervals down completely.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import EngineView from "../components/engine/EngineView.jsx";
import { useLocalModelsPoller, __resetLocalModelsStore } from "../hooks/useLocalModels.js";

/**
 * EngineView no longer polls /models — the shared useLocalModels store does, and
 * App drives its single poller. Tests that need a models LIST therefore have to
 * supply the shell's half of that contract, which is exactly what this harness
 * is: App, reduced to the one hook it owns.
 */
function WithShell(props) {
  useLocalModelsPoller({ enabled: true, provider: props.provider, watching: true });
  return <EngineView {...props} />;
}

const PROVIDER = {
  id: "lmstudio-local",
  label: "LM Studio (local)",
  kind: "lmstudio",
  scope: "local",
  capabilities: ["queue", "metrics", "spill", "models", "traces", "health"],
};

/** vLLM: served direct, so no queue/spill/traces capability at all. */
const VLLM = {
  id: "vllm-local",
  label: "vLLM (local)",
  kind: "vllm",
  scope: "local",
  capabilities: ["models", "health", "metrics", "model-discovery", "model-control"],
};

const PAYLOADS = {
  "/queue": { reachable: true, in_flight: null, queued: [], estimated_clear_seconds: 0 },
  "/metrics": {
    reachable: true,
    runs_total: 12,
    engine: { running: 1, waiting: 2, kv_cache_pct: 41.5 },
    decode_tokens_per_sec: { avg: 68.2 },
    run_time_ms: { p50: 4200 },
    served_model: "qwen3-coder-30b-awq",
  },
  "/models": { reachable: true, models: [{ id: "qwen3-coder-30b-awq", state: "loaded", arch: "qwen3", quantization: "AWQ" }] },
  "/spill": { spill_thresholds_s: { interactive: 30, worker: 600, batch: null }, spilled_total: 3, spilled_by_class: {}, persisted: false },
  "/traces": { reachable: true, traces: [] },
  "/health": { broker: { reachable: true }, provider: { reachable: true, models_loaded: 1 }, ok: true },
};

function mockFetch(overrides = {}) {
  return vi.fn((url) => {
    const path = String(url).replace(/^\/api\/local\/[^/]+/, "").split("?")[0];
    if (path in overrides) {
      const v = overrides[path];
      if (v === "reject") return Promise.reject(new Error("offline"));
      if (v === "error") return Promise.resolve({ ok: false, status: 503, json: async () => ({}) });
      return Promise.resolve({ ok: true, status: 200, json: async () => v });
    }
    const body = PAYLOADS[path];
    if (!body) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
}

const paths = (fetchMock) => fetchMock.mock.calls.map(([u]) => String(u));

/** Flush the mount poll so React does not warn about an unwrapped update in
 *  tests whose assertions are all synchronous. */
const settle = () => act(async () => {});

describe("EngineView frame", () => {
  beforeEach(() => {
    __resetLocalModelsStore();
    globalThis.fetch = mockFetch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    __resetLocalModelsStore();
  });

  it("renders the header, the serving pill and all five tabs", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    expect(screen.getByText("Engine")).toBeInTheDocument();
    expect(screen.getByTestId("engine-serving-pill")).toBeInTheDocument();
    for (const id of ["live", "models", "requests", "api", "logs"]) {
      expect(screen.getByTestId(`engine-tab-${id}`)).toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByTestId("engine-serving-pill")).toHaveTextContent("serving"));
  });

  it("renders every tab's body and switches between them", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);

    // live (default)
    await waitFor(() => expect(screen.getByTestId("engine-model-card")).toBeInTheDocument());
    expect(screen.getByTestId("engine-lane-card")).toBeInTheDocument();
    expect(screen.getByTestId("engine-routing-card")).toBeInTheDocument();
    expect(screen.getByTestId("engine-queue-table")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("engine-tab-models"));
    await waitFor(() => expect(screen.getByTestId("engine-models-card")).toBeInTheDocument());
    expect(screen.queryByTestId("engine-lane-card")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("engine-tab-requests"));
    await waitFor(() => expect(screen.getByTestId("engine-queue-table")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("engine-tab-api"));
    await waitFor(() => expect(screen.getByTestId("api-response-pane")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("engine-tab-logs"));
    await waitFor(() => expect(screen.getByTestId("engine-logs-empty")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("engine-tab-live"));
    await waitFor(() => expect(screen.getByTestId("engine-lane-card")).toBeInTheDocument());
  });

  it("honours a controlled tab and reports selection upward", async () => {
    const onSelectTab = vi.fn();
    render(<EngineView provider={PROVIDER} tab="logs" onSelectTab={onSelectTab} onNavigate={vi.fn()} />);
    expect(screen.getByTestId("engine-logs-empty")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("engine-tab-api"));
    expect(onSelectTab).toHaveBeenCalledWith("api");
    await settle();
  });

  it("navigates to Settings and Reports through onNavigate", async () => {
    const onNavigate = vi.fn();
    render(<EngineView provider={PROVIDER} onNavigate={onNavigate} />);

    fireEvent.click(screen.getByTestId("engine-goto-settings"));
    expect(onNavigate).toHaveBeenCalledWith("settings", "providers");

    fireEvent.click(screen.getByTestId("engine-goto-reports"));
    expect(onNavigate).toHaveBeenCalledWith("reports", "history");
    await settle();
  });

  it("disables both hand-off links when the shell supplies no navigator", async () => {
    render(<EngineView provider={PROVIDER} />);
    expect(screen.getByTestId("engine-goto-settings")).toBeDisabled();
    expect(screen.getByTestId("engine-goto-reports")).toBeDisabled();
    await settle();
  });

  it("keeps Stop engine disabled and explains why (no stop route exists)", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    const stop = screen.getByTestId("engine-stop");
    expect(stop).toBeDisabled();
    expect(stop.getAttribute("title")).toMatch(/no stop endpoint/i);
    await settle();
  });

  it("does not poll when active is false", async () => {
    vi.useFakeTimers();
    render(<EngineView provider={PROVIDER} active={false} onNavigate={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not poll when local inference is switched off", async () => {
    vi.useFakeTimers();
    render(<EngineView provider={PROVIDER} localEnabled={false} onNavigate={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12000);
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("engine-serving-pill")).toHaveTextContent("disabled");
  });

  it("polls only the endpoints the provider's capabilities declare", async () => {
    render(<EngineView provider={VLLM} onNavigate={vi.fn()} />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    const called = paths(globalThis.fetch);
    // /models is NOT here on purpose: it is owned by the shared useLocalModels
    // store (App drives the single poller) because App needs the same read for
    // the model-load busy marker. Engine asking as well was a duplicate request
    // every 10s. See useLocalModels.test.jsx for the dedup guard.
    expect(called.some((u) => u.includes("/models"))).toBe(false);
    expect(called.some((u) => u.includes("/metrics"))).toBe(true);
    expect(called.some((u) => u.includes("/queue"))).toBe(false);
    expect(called.some((u) => u.includes("/spill"))).toBe(false);
    expect(called.some((u) => u.includes("/traces"))).toBe(false);
  });

  it("tears the poll intervals down on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    const before = globalThis.fetch.mock.calls.length;
    expect(before).toBeGreaterThan(0);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(globalThis.fetch.mock.calls.length).toBe(before);
  });

  it("renders offline state rather than zeros when the broker does not answer", async () => {
    globalThis.fetch = mockFetch({ "/queue": "reject", "/metrics": "reject", "/spill": "reject", "/health": "reject" });
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);

    // The fast (queue/metrics) and slow (spill/health) polls settle
    // independently, so each offline state is awaited on its own.
    await waitFor(() => expect(screen.getByTestId("lane-offline")).toBeInTheDocument());
    expect(screen.getByTestId("lane-offline")).toHaveTextContent(/unread/i);
    await waitFor(() => expect(screen.getByTestId("spill-offline")).toBeInTheDocument());
    expect(screen.getByTestId("queue-offline")).toHaveTextContent(/not.*nothing running/i);
    // No fabricated zeros: the four lane stats are absent entirely, not zeroed.
    expect(screen.queryByTestId("lane-inflight")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("engine-serving-pill")).toHaveTextContent("not serving"));
  });

  it("says VRAM is unreported instead of drawing a fill", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-vram-bar")).toBeInTheDocument());
    expect(screen.getByTestId("engine-vram-bar")).toHaveTextContent(/no endpoint reports vram/i);
    // KV cache IS reported, so it renders a real percentage.
    await waitFor(() => expect(screen.getByTestId("engine-kv-bar")).toHaveTextContent("42%"));
  });

  it("reports the lane from live data and labels unreported counters honestly", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("lane-inflight")).toHaveTextContent("1"));
    expect(screen.getByTestId("lane-queued")).toHaveTextContent("2");
    expect(screen.getByTestId("lane-tps")).toHaveTextContent("68.2");
    expect(screen.getByTestId("count-rejected")).toHaveTextContent("—");
    expect(screen.getByTestId("spill-counter-window")).toHaveTextContent(/since the broker started/i);
    expect(screen.getByTestId("engine-live-footer")).toHaveTextContent("requests served");
  });

  it("disables Swap model and Restart when the backend declares no model-control", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-swap")).toBeInTheDocument());
    expect(screen.getByTestId("engine-swap")).toBeDisabled();
    expect(screen.getByTestId("engine-restart")).toBeDisabled();
    expect(screen.getByTestId("engine-restart").getAttribute("title")).toMatch(/vllm-only/i);
  });

  it("confirm-gates Restart before touching the engine", async () => {
    render(<WithShell provider={VLLM} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-restart")).toBeEnabled());
    const before = globalThis.fetch.mock.calls.length;

    fireEvent.click(screen.getByTestId("engine-restart"));
    expect(screen.getByTestId("engine-restart-confirm")).toBeInTheDocument();
    // First click must not have fired anything.
    expect(
      paths(globalThis.fetch).slice(before).some((u) => u.includes("/restart"))
    ).toBe(false);

    fireEvent.click(screen.getByTestId("engine-restart-confirm"));
    await waitFor(() =>
      expect(paths(globalThis.fetch).some((u) => u.includes("/restart"))).toBe(true)
    );
  });

  it("explains the missing lane queue for a directly-served backend", async () => {
    render(<EngineView provider={VLLM} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("queue-not-offered")).toBeInTheDocument());
    expect(screen.getByTestId("queue-not-offered")).toHaveTextContent(/does not expose a lane queue/i);
    expect(screen.getByTestId("spill-not-offered")).toBeInTheDocument();
  });

  it("renders an honest empty state on the Logs tab and no fabricated lines", async () => {
    render(<EngineView provider={PROVIDER} tab="logs" onNavigate={vi.fn()} />);
    const empty = screen.getByTestId("engine-logs-empty");
    expect(empty).toHaveTextContent(/no log stream yet/i);
    expect(empty).toHaveTextContent(/cockpit\.server/);
    expect(empty).toHaveTextContent(/docker logs/);
    await settle();
  });

  it("says it is still reading rather than claiming offline before the first poll", async () => {
    // No fetch has resolved yet on the very first render: the cards must not
    // assert "not answering" about an endpoint they have not called.
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    expect(screen.getByTestId("lane-loading")).toBeInTheDocument();
    expect(screen.getByTestId("spill-loading")).toBeInTheDocument();
    expect(screen.getByTestId("queue-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("lane-offline")).not.toBeInTheDocument();
    await settle();
  });

  it("tells the user when no provider is selected instead of rendering empty cards", () => {
    render(<EngineView provider={null} onNavigate={vi.fn()} />);
    expect(screen.getByText("No provider selected")).toBeInTheDocument();
    expect(screen.queryByTestId("engine-lane-card")).not.toBeInTheDocument();
  });
});
