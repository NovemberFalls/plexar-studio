/**
 * Engine ▸ Live — the model swap/restart picker.
 *
 * Coverage re-homed from the deleted LocalBrokerView.restartPicker.test.jsx.
 * The picker itself moved from LocalBrokerView's connection popover to
 * engine/EngineLive.jsx's LoadedModelCard, and the parts that survived the move
 * are asserted here against the new component.
 *
 * What is asserted (and NOT weakened):
 *   - option VALUES are container_path, not the display id — the restart route
 *     wants a path inside the container, so an id here silently 400s
 *   - the loaded model is preselected when the picker opens
 *   - Apply is confirm-gated and the POST body carries the CHOSEN model, not
 *     the running one (the original test never checked the body; this is
 *     stricter, not looser)
 *   - Apply stays disabled with an explanatory title while nothing is chosen
 *
 * Two of the old file's behaviours are NOT ported because EngineLive genuinely
 * does not have them (see the report): the `__custom__` free-text path escape
 * hatch, and the GET /models-dir `current_model` prefill fallback. Writing a
 * softened assertion for either would claim coverage that does not exist.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import EngineView from "../components/engine/EngineView.jsx";
import {
  useLocalModelsPoller,
  __resetLocalModelsStore,
} from "../hooks/useLocalModels.js";

const VLLM = {
  id: "vllm-local",
  label: "vLLM (local)",
  kind: "vllm",
  scope: "local",
  capabilities: ["models", "health", "metrics", "model-discovery", "model-control"],
};

/** Two models with distinct container_paths so an id/path mix-up is visible. */
const MODELS = {
  reachable: true,
  models: [
    {
      id: "qwen3-30b",
      name: "Qwen3 30B AWQ",
      state: "loaded",
      container_path: "/models/Qwen3-30B-A3B-Instruct-2507-AWQ",
    },
    { id: "qwen3-14b", name: "Qwen3 14B", state: "available", container_path: "/models/Qwen3-14B" },
  ],
};

const PAYLOADS = {
  "/models": MODELS,
  "/metrics": { reachable: true, runs_total: 3, engine: { kv_cache_pct: 20 } },
  "/health": { broker: { reachable: false }, provider: { reachable: true, models_loaded: 1 }, ok: false },
  "/restart": { ok: true },
};

function mockFetch(overrides = {}) {
  return vi.fn((url) => {
    const path = String(url).replace(/^\/api\/local\/[^/]+/, "").split("?")[0];
    const body = overrides[path] ?? PAYLOADS[path];
    if (!body) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
}

const settle = () => act(async () => {});

/**
 * EngineView no longer fetches /models itself — the list is owned by the shared
 * useLocalModels store, and App drives the only poller. So the harness mounts
 * the poller next to the view, exactly as the shell does; the alternative
 * (reaching into the module store) would test a seam the product never uses.
 */
function Harness(props) {
  useLocalModelsPoller({ enabled: true, provider: VLLM, watching: true });
  return <EngineView provider={VLLM} onNavigate={vi.fn()} {...props} />;
}

/** Mount Engine ▸ Live, wait for the shared model list, open the inline picker. */
async function openPicker(props = {}) {
  render(<Harness {...props} />);
  await waitFor(() => expect(screen.getByTestId("engine-swap")).toBeEnabled());
  // The picker seeds its selection from the loaded model, so the list must have
  // landed before it opens.
  await waitFor(() =>
    expect(screen.getByTestId("engine-loaded-model")).toHaveTextContent("Qwen3 30B AWQ")
  );
  fireEvent.click(screen.getByTestId("engine-swap"));
  return screen.getByTestId("engine-swap-select");
}

describe("EngineLive — model swap picker", () => {
  beforeEach(() => {
    __resetLocalModelsStore();
    globalThis.fetch = mockFetch();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __resetLocalModelsStore();
  });

  it("uses container_path for option values and preselects the loaded model", async () => {
    const select = await openPicker();

    expect(select).toHaveValue("/models/Qwen3-30B-A3B-Instruct-2507-AWQ");

    const values = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(values).toContain("/models/Qwen3-30B-A3B-Instruct-2507-AWQ");
    expect(values).toContain("/models/Qwen3-14B");
    // The display ids must NOT leak into the values the restart route receives.
    expect(values).not.toContain("qwen3-30b");
    expect(values).not.toContain("qwen3-14b");
    await settle();
  });

  it("marks which option is currently loaded so the picker is readable", async () => {
    const select = await openPicker();
    const loaded = Array.from(select.querySelectorAll("option")).find(
      (o) => o.value === "/models/Qwen3-30B-A3B-Instruct-2507-AWQ"
    );
    expect(loaded.textContent).toMatch(/loaded/);
    await settle();
  });

  it("POSTs the CHOSEN model to /restart, not the one already running", async () => {
    const select = await openPicker();

    fireEvent.change(select, { target: { value: "/models/Qwen3-14B" } });
    fireEvent.click(screen.getByTestId("engine-swap-apply"));
    // Confirm-gated: the first click must not have written anything.
    expect(
      globalThis.fetch.mock.calls.some(([u]) => String(u).includes("/restart"))
    ).toBe(false);

    fireEvent.click(screen.getByTestId("engine-swap-confirm"));

    await waitFor(() => {
      const call = globalThis.fetch.mock.calls.find(([u]) => String(u).includes("/restart"));
      expect(call).toBeTruthy();
      expect(call[0]).toBe("/api/local/vllm-local/restart");
      expect(call[1].method).toBe("POST");
      expect(JSON.parse(call[1].body)).toEqual({ model: "/models/Qwen3-14B" });
    });
  });

  it("reports the refusal reason when the engine rejects the restart", async () => {
    globalThis.fetch = mockFetch({ "/restart": { ok: false, error: "model path not found" } });
    const onToast = vi.fn();
    const select = await openPicker({ onToast });

    fireEvent.change(select, { target: { value: "/models/Qwen3-14B" } });
    fireEvent.click(screen.getByTestId("engine-swap-apply"));
    fireEvent.click(screen.getByTestId("engine-swap-confirm"));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith("model path not found", "error"));
  });

  it("keeps Apply disabled with an explanatory title while no model is chosen", async () => {
    globalThis.fetch = mockFetch({ "/models": { reachable: true, models: [] } });
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("engine-swap")).toBeEnabled());
    fireEvent.click(screen.getByTestId("engine-swap"));

    const apply = screen.getByTestId("engine-swap-apply");
    expect(apply).toBeDisabled();
    // vLLM's one-model-per-container consequence must be stated before the click.
    expect(apply.getAttribute("title")).toMatch(/restarts it/i);
    await settle();
  });

  it("says swapping restarts the engine before the user commits to it", async () => {
    await openPicker();
    expect(
      screen.getByText(/vLLM serves one model per container, so swapping restarts the engine/i)
    ).toBeInTheDocument();
    await settle();
  });
});
