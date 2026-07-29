/**
 * Tests for the vLLM models-folder config card (model-discovery capability)
 * in LocalBrokerView's DirectProviderConnectionCard, and for LocalModelsPanel
 * rendering disk-only models when the provider reports reachable:false.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import LocalBrokerView from "../components/LocalBrokerView.jsx";
import LocalModelsPanel from "../components/LocalModelsPanel.jsx";

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
}

const VLLM_PROVIDER = {
  id: "vllm-local",
  label: "vLLM",
  kind: "vllm",
  scope: "local",
  capabilities: ["models", "health", "model-control", "model-discovery"],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalBrokerView — models folder config card", () => {
  it("renders only when the provider has model-discovery capability", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ path: "/models", exists: true, writable_config: true }));
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={VLLM_PROVIDER}
        localModels={{ reachable: true, models: [] }}
        onSpillChange={() => {}}
        onToast={() => {}}
        onModelsRefresh={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));
    await waitFor(() => {
      expect(screen.getByText("Models Folder")).toBeInTheDocument();
    });
  });

  it("does not render without model-discovery capability", () => {
    const noDiscovery = { ...VLLM_PROVIDER, capabilities: ["models", "health", "model-control"] };
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({}));
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={noDiscovery}
        localModels={{ reachable: true, models: [] }}
        onSpillChange={() => {}}
        onToast={() => {}}
        onModelsRefresh={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));
    expect(screen.queryByText("Models Folder")).not.toBeInTheDocument();
  });

  it("PUTs the entered path on Save and refreshes models on success", async () => {
    const fetchMock = vi.fn((url, opts) => {
      if (!opts) return jsonResponse({ path: "/models", exists: true, writable_config: true });
      if (opts.method === "PUT") return jsonResponse({ path: "/mnt/models", exists: true, writable_config: true });
      return jsonResponse({ reachable: true, models: [{ id: "/models/newmodel", state: "available" }] });
    });
    globalThis.fetch = fetchMock;
    const onModelsRefresh = vi.fn();
    const onToast = vi.fn();
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={VLLM_PROVIDER}
        localModels={{ reachable: true, models: [] }}
        onSpillChange={() => {}}
        onToast={onToast}
        onModelsRefresh={onModelsRefresh}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));
    await waitFor(() => expect(screen.getByText("Models Folder")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("C:\\models");
    fireEvent.change(input, { target: { value: "/mnt/models" } });
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/local/vllm-local/models-dir",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ path: "/mnt/models" }) })
      );
    });
    await waitFor(() => expect(onModelsRefresh).toHaveBeenCalled());
    expect(onToast).toHaveBeenCalledWith("Models folder saved", "success");
  });

  it("surfaces the server error message on a 400 response", async () => {
    const fetchMock = vi.fn((url, opts) => {
      if (!opts) return jsonResponse({ path: "", exists: false, writable_config: true });
      if (opts.method === "PUT") return jsonResponse({ error: "path must be absolute" }, false);
      return jsonResponse({ reachable: true, models: [] });
    });
    globalThis.fetch = fetchMock;
    const onToast = vi.fn();
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={VLLM_PROVIDER}
        localModels={{ reachable: true, models: [] }}
        onSpillChange={() => {}}
        onToast={onToast}
        onModelsRefresh={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));
    await waitFor(() => expect(screen.getByText("Models Folder")).toBeInTheDocument());

    const input = screen.getByPlaceholderText("C:\\models");
    fireEvent.change(input, { target: { value: "relative/path" } });
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    fireEvent.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(onToast).toHaveBeenCalledWith("path must be absolute", "error");
    });
  });
});

describe("LocalModelsPanel — reachable:false with non-empty models", () => {
  it("still lists disk-only models with an offline note instead of the empty state", () => {
    render(
      <LocalModelsPanel
        models={{ reachable: false, models: [{ id: "/models/foo", state: "available" }] }}
        controlEnabled
      />
    );
    expect(screen.queryByText("Provider offline — no models data.")).not.toBeInTheDocument();
    expect(screen.getByText(/models found on disk/i)).toBeInTheDocument();
    expect(screen.getByText("/models/foo")).toBeInTheDocument();
  });
});
