/**
 * Engine ▸ API tests. These cover the honesty rules, which are the point of the
 * screen — a route explorer that can fire a request the operator did not intend,
 * or that offers a Run it cannot actually perform, is worse than no explorer.
 *
 *  - broker-direct rows are not runnable from the browser and say why
 *  - non-GET rows need an explicit confirm before any fetch happens
 *  - POST /v1/chat/completions is never runnable (it would spend inference)
 *  - capability-gated rows dim when the provider lacks the capability
 *  - Watch (1s) stops on unmount
 *  - the exported OpenAPI describes only real, same-origin routes
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import EngineApi, {
  buildOpenApi,
  highlightJson,
  resolvePath,
  routeId,
} from "../components/engine/EngineApi.jsx";

const CAPS = new Set(["queue", "metrics", "models", "traces", "health", "model-control"]);

const PROVIDER = { id: "lmstudio-local", label: "LM Studio (local)", kind: "lmstudio", scope: "local" };

const DATA = {
  models: { reachable: true, models: [{ id: "qwen3-coder-30b-awq", state: "loaded" }] },
  traces: { reachable: true, traces: [{ trace_id: "trace-abc" }] },
};

function setup(props = {}) {
  return render(
    <EngineApi provider={PROVIDER} caps={CAPS} data={DATA} onToast={vi.fn()} {...props} />
  );
}

const fetched = () => globalThis.fetch.mock.calls.map(([u, o]) => `${o?.method || "GET"} ${u}`);

describe("EngineApi route explorer", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ providers: [{ id: "lmstudio-local" }], count: 1, note: null }),
      })
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders grouped route rows and sends nothing on mount", () => {
    setup();
    // T11: the "Lane broker · direct" group is gone with the broker.
    expect(screen.queryByText("Lane broker · direct")).not.toBeInTheDocument();
    expect(screen.getByText("Plexar Studio · per-provider")).toBeInTheDocument();
    expect(screen.getByText("Plexar Studio · usage & sessions")).toBeInTheDocument();
    expect(screen.getByTestId("api-no-selection")).toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("runs a same-origin GET immediately and shows status + latency", async () => {
    setup();
    fireEvent.click(screen.getByTestId("route-run-GET /api/local/providers"));
    await waitFor(() => expect(screen.getByTestId("api-status")).toHaveTextContent("200"));
    expect(fetched()).toEqual(["GET /api/local/providers"]);
    expect(screen.getByTestId("api-response-body")).toHaveTextContent(/providers/);
  });

  it("requires an explicit confirm before firing a destructive row", async () => {
    setup();
    const id = "POST /api/local/{provider_id}/models/{model_id}/unload";
    const run = screen.getByTestId(`route-run-${id}`);
    expect(run).toBeEnabled();

    fireEvent.click(run);
    // First click only arms the confirm — nothing has been sent.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId(`route-confirm-${id}`)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(`route-confirm-${id}`));
    await waitFor(() =>
      expect(fetched()).toEqual([
        "POST /api/local/lmstudio-local/models/qwen3-coder-30b-awq/unload",
      ])
    );
  });

  it("lets the user back out of a destructive row without sending it", () => {
    setup();
    const id = "POST /api/local/{provider_id}/models/{model_id}/load";
    fireEvent.click(screen.getByTestId(`route-run-${id}`));
    fireEvent.click(screen.getByTestId(`route-cancel-${id}`));
    expect(screen.queryByTestId(`route-confirm-${id}`)).not.toBeInTheDocument();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("dims capability-gated rows when the provider lacks the capability", () => {
    setup({ caps: new Set(["models", "health"]) });
    const metricsRow = screen.getByTestId("route-row-GET /api/local/{provider_id}/metrics");
    expect(metricsRow).toHaveAttribute("data-blocked", "true");
    const run = screen.getByTestId("route-run-GET /api/local/{provider_id}/metrics");
    expect(run).toBeDisabled();
    expect(run.getAttribute("title")).toMatch(/does not declare the "metrics" capability/i);
    // A route the provider DOES declare stays runnable.
    expect(screen.getByTestId("route-run-GET /api/local/{provider_id}/models")).toBeEnabled();
  });

  it("refuses to run routes that need a body, naming the body it would need", () => {
    setup();
    const run = screen.getByTestId("route-run-POST /api/local/{provider_id}/endpoint");
    expect(run).toBeDisabled();
    expect(run.getAttribute("title")).toMatch(/needs a request body/i);
  });

  it("refuses to run routes whose path parameter cannot be filled", () => {
    // The {trace_id} row went with the broker (T11); {terminal_id} carries
    // this behaviour on its own.
    setup({ data: { models: { models: [] } } });
    expect(
      screen.getByTestId("route-run-GET /api/terminals/{terminal_id}/usage").getAttribute("title")
    ).toMatch(/\{terminal_id\}/);
  });

  it("watches a GET every second and clears the interval on unmount", async () => {
    vi.useFakeTimers();
    const { unmount } = setup();
    fireEvent.click(screen.getByTestId("route-run-GET /api/local/providers"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterFirstRun = globalThis.fetch.mock.calls.length;
    expect(afterFirstRun).toBe(1);

    fireEvent.click(screen.getByTestId("api-watch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const watched = globalThis.fetch.mock.calls.length;
    expect(watched).toBeGreaterThan(afterFirstRun);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(globalThis.fetch.mock.calls.length).toBe(watched);
  });

  it("does not watch while Engine is not the visible section", async () => {
    vi.useFakeTimers();
    const { rerender } = setup();
    fireEvent.click(screen.getByTestId("route-run-GET /api/local/providers"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(screen.getByTestId("api-watch"));
    rerender(<EngineApi provider={PROVIDER} caps={CAPS} data={DATA} active={false} />);
    const before = globalThis.fetch.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(globalThis.fetch.mock.calls.length).toBe(before);
  });

  it("refuses to watch a non-GET route", () => {
    setup();
    fireEvent.click(
      screen.getByTestId("route-select-POST /api/local/{provider_id}/models/{model_id}/load")
    );
    const watch = screen.getByTestId("api-watch");
    expect(watch).toBeDisabled();
    expect(watch.getAttribute("title")).toMatch(/only get routes can be watched/i);
  });

  it("offers cURL only when it can write a correct URL", () => {
    setup();
    fireEvent.click(screen.getByTestId("route-select-GET /api/local/providers"));
    expect(screen.getByTestId("api-copy-curl")).toBeEnabled();
  });
});

describe("EngineApi pure helpers", () => {
  it("resolvePath substitutes provider and model ids", () => {
    const ctx = { providerId: "p 1", caps: CAPS, modelId: "m/1" };
    expect(resolvePath({ path: "/api/local/{provider_id}/metrics" }, ctx).path).toBe("/api/local/p%201/metrics");
    expect(
      resolvePath({ path: "/api/local/{provider_id}/models/{model_id}/load", needs: "model_id" }, ctx).path
    ).toBe("/api/local/p%201/models/m%2F1/load");
    expect(resolvePath({ path: "/api/local/{provider_id}/metrics" }, { ...ctx, providerId: null }).missing).toBe(
      "provider_id"
    );
  });

  it("buildOpenApi emits a real 3.1 spec of the same-origin routes only", () => {
    const routes = [
      { group: "broker", method: "GET", path: "/queue", desc: "broker queue" },
      { group: "provider", method: "GET", path: "/api/local/{provider_id}/queue", desc: "proxied queue" },
      { group: "provider", method: "PUT", path: "/api/local/{provider_id}/models-dir", desc: "set models dir", body: "{}" },
    ];
    const spec = buildOpenApi(routes);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toEqual([{ url: "/" }]);
    expect(Object.keys(spec.paths)).toEqual([
      "/api/local/{provider_id}/queue",
      "/api/local/{provider_id}/models-dir",
    ]);
    expect(spec.paths["/api/local/{provider_id}/queue"].get.summary).toBe("proxied queue");
    expect(spec.paths["/api/local/{provider_id}/queue"].get.parameters[0]).toMatchObject({
      name: "provider_id",
      in: "path",
      required: true,
    });
    expect(spec.paths["/api/local/{provider_id}/models-dir"].put.requestBody.required).toBe(true);
  });

  it("highlightJson classifies keys, strings, numbers and null distinctly", () => {
    const parts = highlightJson('{\n  "a": "x",\n  "b": 12,\n  "c": null,\n  "d": true\n}');
    const tokenFor = (text) => parts.find((p) => p.text === text)?.token;
    expect(tokenFor('"a"')).toBe("key");
    expect(tokenFor('"x"')).toBe("string");
    expect(tokenFor("12")).toBe("number");
    expect(tokenFor("null")).toBe("null");
    expect(tokenFor("true")).toBe("bool");
    // Round-trips losslessly — the pane must never silently drop characters.
    expect(parts.map((p) => p.text).join("")).toBe(
      '{\n  "a": "x",\n  "b": 12,\n  "c": null,\n  "d": true\n}'
    );
  });

  it("routeId is method + path so ids are stable across renders", () => {
    expect(routeId({ method: "GET", path: "/queue" })).toBe("GET /queue");
  });
});
