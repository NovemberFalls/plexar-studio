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

/** vLLM: served direct, so no queue/spill/traces capability at all. Plexar Studio owns
 *  the container here (`managed`), which is what makes restart offerable. */
const VLLM = {
  id: "vllm-local",
  label: "vLLM (local)",
  kind: "vllm",
  scope: "local",
  managed: true,
  capabilities: ["models", "health", "metrics", "model-discovery", "model-control"],
};

/**
 * The owner's actual live registry: an EXTERNAL vLLM. The backend stopped
 * advertising `model-control` for this case, so no swap/restart control may
 * render — clicking one could only ever produce a refusal toast, which is the
 * bug this fixture exists to pin.
 */
const VLLM_EXTERNAL = {
  id: "vllm-local",
  label: "vLLM (local)",
  kind: "vllm",
  scope: "local",
  managed: false,
  capabilities: ["models", "health", "metrics", "model-discovery"],
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
      // The backend now answers an unavailable capability with 404, not 409.
      if (v === "notfound") {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ error: "capability not available" }),
        });
      }
      // { status, body } for the refusal codes whose STATUS is the contract.
      if (v && typeof v === "object" && typeof v.status === "number" && "body" in v) {
        return Promise.resolve({ ok: v.status < 400, status: v.status, json: async () => v.body });
      }
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

  // S26: Engine is three tabs. `requests` and `logs` moved to Reports; the
  // absence assertions below are the half that matters — a stale Engine tab
  // beside its new Reports home is two doors to one room, which is the
  // two-product illusion S22 counted.
  it("renders the header, the serving pill and exactly the three Engine tabs", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    expect(screen.getByText("Engine")).toBeInTheDocument();
    expect(screen.getByTestId("engine-serving-pill")).toBeInTheDocument();
    for (const id of ["live", "models", "api"]) {
      expect(screen.getByTestId(`engine-tab-${id}`)).toBeInTheDocument();
    }
    for (const id of ["requests", "logs"]) {
      expect(screen.queryByTestId(`engine-tab-${id}`)).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByTestId("engine-tab-api"));
    await waitFor(() => expect(screen.getByTestId("api-response-pane")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("engine-tab-live"));
    await waitFor(() => expect(screen.getByTestId("engine-lane-card")).toBeInTheDocument());
  });

  it("honours a controlled tab and reports selection upward", async () => {
    const onSelectTab = vi.fn();
    render(<EngineView provider={PROVIDER} tab="models" onSelectTab={onSelectTab} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-models-card")).toBeInTheDocument());
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

  it("offers NO swap/restart control at all when the backend declares no model-control", async () => {
    render(<EngineView provider={PROVIDER} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-model-control-note")).toBeInTheDocument());
    // The absent direction is the point: a disabled-then-toast button was the bug.
    expect(screen.queryByTestId("engine-swap")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-restart")).not.toBeInTheDocument();
    const note = screen.getByTestId("engine-model-control-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/does not declare the model-control capability/i);
  });

  it("explains an EXTERNAL vLLM instead of offering a restart it cannot perform", async () => {
    render(<WithShell provider={VLLM_EXTERNAL} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-model-control-note")).toBeInTheDocument());
    expect(screen.queryByTestId("engine-swap")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-restart")).not.toBeInTheDocument();
    const note = screen.getByTestId("engine-model-control-note");
    // The `managed: false` flag is what lets the note say something TRUE: no
    // hot-swap API, and Plexar Studio does not own the process.
    expect(note).toHaveTextContent(/no model hot-swap API/i);
    expect(note).toHaveTextContent(/COCKPIT_MANAGED_VLLM/);
    expect(note).toHaveTextContent(/Restart it where you started it/i);
    // Nothing may have been POSTed to the lifecycle routes.
    expect(paths(globalThis.fetch).some((u) => u.includes("/restart"))).toBe(false);
  });

  it("renders the working controls for a managed provider that declares model-control", async () => {
    render(<WithShell provider={VLLM} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-swap")).toBeEnabled());
    expect(screen.getByTestId("engine-restart")).toBeEnabled();
    expect(screen.queryByTestId("engine-model-control-note")).not.toBeInTheDocument();
  });

  it("says restart is vLLM-only in words rather than as a dead button", async () => {
    const LMS_CONTROL = { ...PROVIDER, managed: true, capabilities: [...PROVIDER.capabilities, "model-control"] };
    render(<WithShell provider={LMS_CONTROL} onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-swap")).toBeEnabled());
    expect(screen.queryByTestId("engine-restart")).not.toBeInTheDocument();
    expect(screen.getByTestId("engine-restart-not-offered")).toHaveTextContent(/vLLM-only/i);
  });

  it("retracts the control on a 404 instead of reporting a failure", async () => {
    globalThis.fetch = mockFetch({ "/restart": "notfound" });
    const onToast = vi.fn();
    render(<WithShell provider={VLLM} onNavigate={vi.fn()} onToast={onToast} />);
    await waitFor(() => expect(screen.getByTestId("engine-restart")).toBeEnabled());

    fireEvent.click(screen.getByTestId("engine-restart"));
    fireEvent.click(screen.getByTestId("engine-restart-confirm"));

    // 404 = "capability not available": the affordance was wrong, so it goes away
    // and the reason is stated. No red toast about a healthy backend.
    await waitFor(() => expect(screen.getByTestId("engine-model-control-note")).toBeInTheDocument());
    expect(screen.queryByTestId("engine-restart")).not.toBeInTheDocument();
    expect(screen.queryByTestId("engine-swap")).not.toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalled();
  });

  it("surfaces a 409 refusal verbatim, env var and all", async () => {
    const REFUSAL =
      "vLLM is external — Plexar Studio can't restart it. Set COCKPIT_MANAGED_VLLM=1 and restart Plexar Studio " +
      "to let it own the container.";
    globalThis.fetch = mockFetch({ "/restart": { status: 409, body: { error: REFUSAL, managed: false, env: "COCKPIT_MANAGED_VLLM" } } });
    const onToast = vi.fn();
    render(<WithShell provider={VLLM} onNavigate={vi.fn()} onToast={onToast} />);
    await waitFor(() => expect(screen.getByTestId("engine-restart")).toBeEnabled());

    fireEvent.click(screen.getByTestId("engine-restart"));
    fireEvent.click(screen.getByTestId("engine-restart-confirm"));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith(REFUSAL, "error"));
  });

  it("labels the models list browse-only when discovery exists without control", async () => {
    render(<WithShell provider={VLLM_EXTERNAL} tab="models" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-models-card")).toBeInTheDocument());
    expect(screen.getByTestId("models-browse-only-badge")).toHaveTextContent(/browse only/i);
    const note = screen.getByTestId("models-browse-only-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent(/Browse only/);
    expect(note).toHaveTextContent(/cannot switch to one/i);
    // No per-row Load buttons, so the list cannot read as a picker.
    expect(screen.queryByRole("button", { name: /^Load /i })).not.toBeInTheDocument();
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

  it("treats a 404 from load as not-offered and retracts the row buttons", async () => {
    globalThis.fetch = mockFetch({ "/models/qwen3-coder-30b-awq/unload": "notfound" });
    const onToast = vi.fn();
    render(<WithShell provider={VLLM} tab="models" onNavigate={vi.fn()} onToast={onToast} />);
    const btn = await waitFor(() => screen.getByRole("button", { name: /^Unload qwen3-coder-30b-awq$/i }));
    fireEvent.click(btn);

    await waitFor(() => expect(screen.getByTestId("models-browse-only-note")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /^Unload qwen3-coder-30b-awq$/i })).not.toBeInTheDocument();
    expect(onToast).not.toHaveBeenCalled();
  });

  it("passes a load refusal through verbatim rather than a generic message", async () => {
    const REFUSAL = "lms CLI not found on PATH — install it or set COCKPIT_LMS_PATH.";
    globalThis.fetch = mockFetch({
      "/models/qwen3-coder-30b-awq/unload": { status: 409, body: { error: REFUSAL } },
    });
    const onToast = vi.fn();
    render(<WithShell provider={VLLM} tab="models" onNavigate={vi.fn()} onToast={onToast} />);
    const btn = await waitFor(() => screen.getByRole("button", { name: /^Unload qwen3-coder-30b-awq$/i }));
    fireEvent.click(btn);
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(REFUSAL, "error"));
  });

  // S26: an unknown tab id falls back to the DEFAULT tab rather than rendering
  // blank. This matters on upgrade: Len's installed copy may have "logs" or
  // "requests" persisted as its last Engine tab, and a blank Engine on first
  // launch of 1.30.0 would read as the release having broken the section.
  // The Logs empty-state assertions moved WITH the panel — see
  // ReportsView.consolidation.test.jsx, which now owns them.
  it("falls back to Live when handed a tab id that no longer exists", async () => {
    render(<EngineView provider={PROVIDER} tab="logs" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("engine-lane-card")).toBeInTheDocument());
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
