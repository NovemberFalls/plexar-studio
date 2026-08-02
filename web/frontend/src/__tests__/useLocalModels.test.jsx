/**
 * useLocalModels — the shared /models poller and the load busy marker.
 *
 * WHY THIS FILE EXISTS: `/api/local/{provider}/models` used to have two owners
 * (App's busy-marker poller and EngineView's slow poll), so with Engine open the
 * same request went out twice every 10s. The dedup assertion below is the whole
 * point of the refactor — if it ever goes green-to-red, someone re-introduced a
 * second poller.
 *
 * The busy-marker lifecycle behind the TopBar spinner had no test coverage at
 * all before this, despite being live user-visible behaviour: the spinner is
 * cleared by the POLL (state === "loaded"), not by the write returning.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import useLocalModels, {
  useLocalModelsPoller,
  useLocalModelsCatalog,
  __resetLocalModelsStore,
  unswitchableModelMessage,
} from "../hooks/useLocalModels.js";
import EngineModels from "../components/engine/EngineModels.jsx";
import { buildLocalGroups, NO_MODEL_LIST_NOTE } from "../modelCatalog.js";

const PROVIDER = {
  id: "lmstudio-local",
  label: "LM Studio (local)",
  kind: "lmstudio",
  scope: "local",
  capabilities: ["models", "model-control", "queue"],
};

/** An EXTERNAL vLLM: publishes a model list, but Cockpit does not own the
 *  container, so every load 404s and only the served model can be used. */
const EXTERNAL_VLLM = {
  id: "vllm-local",
  label: "vLLM (local)",
  kind: "vllm",
  scope: "local",
  capabilities: ["models", "health"],
};

/** A provider that does not advertise `models` — must never be asked for one. */
const NO_MODELS = { id: "bare", label: "Bare", kind: "other", scope: "local", capabilities: ["queue"] };

const LIST = (state) => ({
  reachable: true,
  models: [{ id: "qwen3-coder", state, arch: "qwen3", quantization: "AWQ" }],
});

/** Fetch mock whose /models body can be swapped mid-test. */
function mockFetch(initial = LIST("not-loaded")) {
  const box = { body: initial };
  const fn = vi.fn((url) => {
    const u = String(url);
    if (u.includes("/models/")) {
      // a write (…/models/<id>/load)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
    }
    if (u.endsWith("/models")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => box.body });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  globalThis.fetch = fn;
  return { fn, box };
}

const modelsCalls = (fn) => fn.mock.calls.map(([u]) => String(u)).filter((u) => /\/models$/.test(u));
const callsFor = (fn, providerId) => modelsCalls(fn).filter((u) => u.includes(`/${providerId}/`));

/**
 * A realistic 3-provider registry, one of which does NOT declare `models`. This
 * is the fixture the request-volume arithmetic in the report is based on.
 */
const REGISTRY = [
  PROVIDER,
  { id: "vllm-local", label: "vLLM (local)", kind: "vllm", scope: "local", capabilities: ["models", "health"] },
  { id: "bare", label: "Bare broker", kind: "other", scope: "local", capabilities: ["queue"] },
];

/** Fetch mock that also answers provider discovery. */
function mockRegistryFetch(providers = REGISTRY) {
  const fn = vi.fn((url) => {
    const u = String(url);
    if (u === "/api/local/providers") {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ providers }) });
    }
    if (u.endsWith("/models")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => LIST("loaded") });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
  globalThis.fetch = fn;
  return fn;
}

/** Stands in for ModelCatalogProvider. */
function Catalog({ children }) {
  const { providers, byProvider } = useLocalModelsCatalog();
  const groups = providers ? buildLocalGroups(providers, byProvider) : [];
  return (
    <div>
      <span data-testid="groups">{groups.map((g) => `${g.label}:${g.models.length}`).join("|")}</span>
      <span data-testid="notes">{groups.map((g) => g.note || "-").join("|")}</span>
      {children}
    </div>
  );
}

/** Stands in for App: the one component that owns the poller. */
function Shell({ provider = PROVIDER, enabled = true, watching = true, onToast, loadFrom, children }) {
  const { models, busyModelId, loadOrRestartModel } = useLocalModelsPoller({
    enabled,
    provider,
    watching,
    onToast,
  });
  return (
    <div>
      {/* Stands in for the TopBar picker's spinner, which is driven purely by
          the busy marker matching the row's model id. */}
      <span data-testid="spinner">{busyModelId ? `loading:${busyModelId}` : "idle"}</span>
      <span data-testid="state">{models?.models?.[0]?.state ?? "none"}</span>
      <button
        type="button"
        data-testid="topbar-load"
        onClick={() => loadOrRestartModel(loadFrom || PROVIDER.id, "qwen3-coder")}
      >
        load
      </button>
      {children}
    </div>
  );
}

describe("useLocalModels", () => {
  beforeEach(() => {
    __resetLocalModelsStore();
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    __resetLocalModelsStore();
    localStorage.clear();
  });

  it("reads /models once on mount and then every 10s while idle", async () => {
    const { fn } = mockFetch();
    render(<Shell />);
    await act(async () => {});
    expect(modelsCalls(fn)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(modelsCalls(fn)).toHaveLength(2);
  });

  it("polls ONCE per tick with both consumers mounted (the dedup guarantee)", async () => {
    const { fn } = mockFetch();
    // App's poller AND Engine ▸ Models on screen at the same time — the exact
    // situation that used to produce two identical requests per interval.
    render(
      <Shell>
        <EngineModels provider={PROVIDER} caps={new Set(["models", "model-control"])} data={{}} />
      </Shell>
    );
    await act(async () => {});
    expect(modelsCalls(fn)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    // 3 ticks + the mount read = 4. Two pollers would give 8.
    expect(modelsCalls(fn)).toHaveLength(4);
  });

  it("shares one snapshot, so Engine renders the list App fetched", async () => {
    mockFetch(LIST("loaded"));
    render(
      <Shell>
        <EngineModels provider={PROVIDER} caps={new Set(["models", "model-control"])} data={{}} />
      </Shell>
    );
    await act(async () => {});
    // EngineModels receives no `models` of its own (data={}); it must still show
    // the row, which can only have come from the shared store.
    expect(screen.getByTestId("state")).toHaveTextContent("loaded");
    expect(screen.getByText("qwen3-coder")).toBeInTheDocument();
  });

  it("speeds up to a 2s cadence while a load is in flight", async () => {
    const { fn } = mockFetch();
    render(<Shell />);
    await act(async () => {});
    const before = modelsCalls(fn).length;

    // Hold the busy marker: a load whose POST never settles.
    globalThis.fetch = vi.fn((url) => {
      const u = String(url);
      if (u.includes("/models/")) return new Promise(() => {});
      if (u.endsWith("/models")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => LIST("not-loaded") });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    expect(screen.getByTestId("spinner")).toHaveTextContent("loading:qwen3-coder");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    // 6s at the busy cadence = the immediate re-read plus 3 ticks; at the idle
    // 10s cadence it would have been the re-read alone.
    expect(modelsCalls(globalThis.fetch).length).toBeGreaterThanOrEqual(3);
    expect(before).toBe(1);
  });

  it("clears the spinner as soon as the poll reports state === loaded", async () => {
    const { box } = mockFetch(LIST("not-loaded"));
    // A write that never resolves, so ONLY the poll can clear the marker.
    const pending = { current: false };
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url).includes("/models/") && init?.method === "POST") {
        pending.current = true;
        return new Promise(() => {});
      }
      return base(url, init);
    });

    render(<Shell />);
    await act(async () => {});

    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    expect(screen.getByTestId("spinner")).toHaveTextContent("loading:qwen3-coder");
    expect(pending.current).toBe(true);

    box.body = LIST("loaded");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByTestId("spinner")).toHaveTextContent("idle");
  });

  it("keeps the spinner up while the model is still not loaded", async () => {
    mockFetch(LIST("not-loaded"));
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url).includes("/models/") && init?.method === "POST") return new Promise(() => {});
      return base(url, init);
    });
    render(<Shell />);
    await act(async () => {});
    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(screen.getByTestId("spinner")).toHaveTextContent("loading:qwen3-coder");
  });

  it("falls back to /restart on a 409 and toasts the restart", async () => {
    const onToast = vi.fn();
    globalThis.fetch = vi.fn((url, init) => {
      const u = String(url);
      if (u.includes("/models/") && init?.method === "POST") {
        return Promise.resolve({ ok: false, status: 409, json: async () => ({}) });
      }
      if (u.endsWith("/restart")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => LIST("not-loaded") });
    });
    render(<Shell onToast={onToast} />);
    await act(async () => {});
    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    expect(globalThis.fetch.mock.calls.some(([u]) => String(u).endsWith("/restart"))).toBe(true);
    expect(onToast).toHaveBeenCalledWith("Restarting with qwen3-coder…", "info");
  });

  it("surfaces an unreachable provider as a toast, not a console error", async () => {
    const onToast = vi.fn();
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url).includes("/models/") && init?.method === "POST") {
        return Promise.reject(new Error("offline"));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => LIST("not-loaded") });
    });
    render(<Shell onToast={onToast} />);
    await act(async () => {});
    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    expect(onToast).toHaveBeenCalledWith("Provider unreachable — model not loaded", "error");
    expect(screen.getByTestId("spinner")).toHaveTextContent("idle");
  });

  // The owner clicked Load on an external vLLM, was told to "see Engine ▸ Models
  // for why", went there, then to Settings, and still asked where the model is
  // changed. The message has to contain the action, not a destination.
  it("names the concrete action on a 404 instead of redirecting to another screen", async () => {
    const onToast = vi.fn();
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url).includes("/models/") && init?.method === "POST") {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => LIST("not-loaded") });
    });
    render(<Shell provider={EXTERNAL_VLLM} onToast={onToast} loadFrom={EXTERNAL_VLLM.id} />);
    await act(async () => {});
    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    const [message, kind] = onToast.mock.calls[0] ?? [];
    expect(kind).toBe("info");
    expect(message).toMatch(/restart vLLM with it/i);
    expect(message).toMatch(/--model/);
    expect(message).not.toMatch(/Engine/i);
    expect(message).not.toMatch(/see .* for why/i);
  });

  it("states the same shape without inventing a flag for a non-vLLM engine", () => {
    expect(unswitchableModelMessage("some-broker")).toMatch(/restart the engine with it/i);
    expect(unswitchableModelMessage("some-broker")).not.toMatch(/--model/);
    expect(unswitchableModelMessage("vllm-local")).toMatch(/--model/);
  });

  it("never asks a provider that does not declare the models capability", async () => {
    const { fn } = mockFetch();
    render(<Shell provider={NO_MODELS} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(modelsCalls(fn)).toHaveLength(0);
  });

  it("does not poll when local inference is disabled or no provider is selected", async () => {
    const { fn } = mockFetch();
    const { unmount } = render(<Shell enabled={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(modelsCalls(fn)).toHaveLength(0);
    unmount();

    render(<Shell provider={null} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(modelsCalls(fn)).toHaveLength(0);
  });

  it("does not run the idle poll when nothing is watching", async () => {
    const { fn } = mockFetch();
    render(<Shell watching={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(modelsCalls(fn)).toHaveLength(0);
  });

  it("polls even unwatched while a load is in flight, so the spinner resolves", async () => {
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url).includes("/models/") && init?.method === "POST") return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: async () => LIST("not-loaded") });
    });
    render(<Shell watching={false} />);
    await act(async () => {});
    expect(modelsCalls(globalThis.fetch)).toHaveLength(0);

    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(modelsCalls(globalThis.fetch).length).toBeGreaterThanOrEqual(2);
  });

  it("tears the interval down on unmount", async () => {
    const { fn } = mockFetch();
    const { unmount } = render(<Shell />);
    await act(async () => {});
    const at = modelsCalls(fn).length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(modelsCalls(fn)).toHaveLength(at);
  });

  it("aborts a read that is still in flight at unmount", async () => {
    // The read must actually be OUTSTANDING for an abort to mean anything —
    // aborting an already-settled request proves nothing.
    const aborted = [];
    globalThis.fetch = vi.fn((url, init) => {
      init?.signal?.addEventListener("abort", () => aborted.push(String(url)));
      return new Promise(() => {});
    });
    const { unmount } = render(<Shell />);
    await act(async () => {});
    expect(modelsCalls(globalThis.fetch)).toHaveLength(1);
    expect(aborted).toHaveLength(0);
    unmount();
    expect(aborted.some((u) => /\/models$/.test(u))).toBe(true);
  });

  it("aborts the outgoing read when the selected provider changes", async () => {
    const aborted = [];
    globalThis.fetch = vi.fn((url, init) => {
      init?.signal?.addEventListener("abort", () => aborted.push(String(url)));
      return new Promise(() => {});
    });
    const { rerender } = render(<Shell />);
    await act(async () => {});
    rerender(<Shell provider={{ ...PROVIDER, id: "other-local" }} />);
    await act(async () => {});
    expect(aborted.some((u) => u.includes("lmstudio-local"))).toBe(true);
  });

  it("marks the model busy for BOTH surfaces when Engine starts the load", async () => {
    globalThis.fetch = vi.fn((url, init) => {
      if (String(url).includes("/models/") && init?.method === "POST") return new Promise(() => {});
      return Promise.resolve({ ok: true, status: 200, json: async () => LIST("not-loaded") });
    });
    render(
      <Shell>
        <EngineModels provider={PROVIDER} caps={new Set(["models", "model-control"])} data={{}} />
      </Shell>
    );
    await act(async () => {});
    await act(async () => {
      screen.getByText("Load").click();
    });
    // The Shell's spinner is the TopBar's: an Engine-initiated load lights it.
    expect(screen.getByTestId("spinner")).toHaveTextContent("loading:qwen3-coder");
  });

  // ---------------------------------------------------------------- the catalog

  it("never asks a capability-less provider, and says so instead of 'offline'", async () => {
    localStorage.setItem("cockpit-local-enabled", "true");
    const fn = mockRegistryFetch();
    render(<Catalog />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    // The whole defect: `bare` was being asked, 404'd, and rendered as offline.
    expect(callsFor(fn, "bare")).toHaveLength(0);
    expect(callsFor(fn, "lmstudio-local").length).toBeGreaterThan(0);
    expect(callsFor(fn, "vllm-local").length).toBeGreaterThan(0);
    // It is still LISTED — the backend exists — with an explanation that is not
    // a health claim.
    expect(screen.getByTestId("groups")).toHaveTextContent("Bare broker:0");
    expect(screen.getByTestId("notes")).toHaveTextContent(NO_MODEL_LIST_NOTE);
    expect(screen.getByTestId("notes").textContent).not.toMatch(/offline|unreachable|down/i);
  });

  it("serves the catalog AND the selected read from one request per provider per tick", async () => {
    localStorage.setItem("cockpit-local-enabled", "true");
    const fn = mockRegistryFetch();
    render(
      <Catalog>
        <Shell />
      </Catalog>
    );
    await act(async () => {});
    // Discovery + one read per models-capable provider. The selected provider is
    // read ONCE even though both the catalog and the poller want it.
    expect(callsFor(fn, "lmstudio-local")).toHaveLength(1);
    expect(callsFor(fn, "vllm-local")).toHaveLength(1);
    expect(modelsCalls(fn)).toHaveLength(2);

    // 20s: selected at 10s = 2 more; the other at 20s = 1 more.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(callsFor(fn, "lmstudio-local")).toHaveLength(3);
    expect(callsFor(fn, "vllm-local")).toHaveLength(2);
  });

  it("keeps the fast cadence to the provider being written to, not all of them", async () => {
    localStorage.setItem("cockpit-local-enabled", "true");
    const fn = mockRegistryFetch();
    // Never-settling write so the marker is held for the whole window.
    fn.mockImplementation((url, init) => {
      const u = String(url);
      if (u.includes("/models/") && init?.method === "POST") return new Promise(() => {});
      if (u === "/api/local/providers") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ providers: REGISTRY }) });
      }
      if (u.endsWith("/models")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => LIST("not-loaded") });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    render(
      <Catalog>
        <Shell />
      </Catalog>
    );
    await act(async () => {});
    const selBefore = callsFor(fn, "lmstudio-local").length;
    const othBefore = callsFor(fn, "vllm-local").length;

    await act(async () => {
      screen.getByTestId("topbar-load").click();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    // Selected provider at 2s over 20s = ~10 reads.
    expect(callsFor(fn, "lmstudio-local").length - selBefore).toBeGreaterThanOrEqual(9);
    // The others must NOT have been dragged up to 2s — 20s means exactly one.
    expect(callsFor(fn, "vllm-local").length - othBefore).toBe(1);
  });

  it("does not exceed the pre-change request volume over a 60s window", async () => {
    localStorage.setItem("cockpit-local-enabled", "true");
    const fn = mockRegistryFetch();
    render(
      <Catalog>
        <Shell />
      </Catalog>
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    /*
     * 3 providers, one of them without the `models` capability. Counting the
     * mount read and every tick in [0s, 60s] inclusive:
     *
     * BEFORE — three owners:
     *   App poller            10s -> 7   (selected)
     *   EngineView slow poll  10s -> 7   (selected, an exact duplicate)
     *   ModelCatalogProvider  20s -> 4 ticks x 3 providers = 12
     *                                    (incl. 4 that 404'd and were then
     *                                     rendered to the user as "offline")
     *   TOTAL = 26 /models requests per minute
     *
     * AFTER — one owner, per-provider due times:
     *   lmstudio-local (selected+watched) 10s -> 7
     *   vllm-local     (catalog only)     20s -> 4
     *   bare           (no capability)         -> 0
     *   TOTAL = 11
     */
    expect(modelsCalls(fn).length).toBe(11);
    expect(callsFor(fn, "lmstudio-local")).toHaveLength(7);
    expect(callsFor(fn, "vllm-local")).toHaveLength(4);
    expect(callsFor(fn, "bare")).toHaveLength(0);
  });

  it("stops asking every provider when local inference is switched off", async () => {
    localStorage.setItem("cockpit-local-enabled", "true");
    const fn = mockRegistryFetch();
    render(<Catalog />);
    await act(async () => {});
    expect(modelsCalls(fn).length).toBeGreaterThan(0);
    const at = modelsCalls(fn).length;

    localStorage.setItem("cockpit-local-enabled", "false");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(modelsCalls(fn)).toHaveLength(at);
    expect(screen.getByTestId("groups")).toHaveTextContent("");
  });

  it("keeps the server's reason on a non-ok response instead of flattening it", async () => {
    // S9: `readProvider` used to substitute a bare {reachable:false} for ANY
    // non-2xx, discarding the reason and action the server had just stated. A
    // rig that was up and refusing the credential therefore reached the picker
    // as an indistinguishable "down". This is the middle link of that chain:
    // the server can state it and the picker can render it, but only if the
    // hook carries it across.
    localStorage.setItem("cockpit-local-enabled", "true");
    const fn = vi.fn((url) => {
      const u = String(url);
      if (u === "/api/local/providers") {
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ providers: [PROVIDER] }),
        });
      }
      if (u.endsWith("/models")) {
        return Promise.resolve({
          ok: false, status: 502,
          json: async () => ({ reachable: true, reason: "refused", detail: "HTTP 502" }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    globalThis.fetch = fn;

    // Rendered into the DOM rather than captured into an outer variable:
    // assigning during render is a side effect and the repo's lint rules
    // (correctly) refuse it.
    function Probe() {
      const { byProvider } = useLocalModelsCatalog();
      const resp = byProvider?.[PROVIDER.id];
      return (
        <span data-testid="probe">
          {resp ? `${resp.reachable}:${resp.reason}` : "none"}
        </span>
      );
    }
    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    // The server said "up, but it refused" -- both halves must survive.
    expect(screen.getByTestId("probe")).toHaveTextContent("true:refused");
  });

  it("read-only consumers never fetch on their own", async () => {
    const { fn } = mockFetch();
    function ReadOnly() {
      const { models } = useLocalModels();
      return <span data-testid="ro">{models === undefined ? "none" : "have"}</span>;
    }
    render(<ReadOnly />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(fn).not.toHaveBeenCalled();
    expect(screen.getByTestId("ro")).toHaveTextContent("none");
  });
});
