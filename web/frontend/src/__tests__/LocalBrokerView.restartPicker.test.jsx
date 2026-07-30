/**
 * Tests for the vLLM restart-with-model picker (select of discovered models,
 * container_path values, custom-path escape hatch, prefill fallback to
 * models-dir current_model, and the models-folder card's mount/scan display),
 * plus LocalModelsPanel's `reason`-aware offline messaging.
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

describe("LocalBrokerView — restart model picker", () => {
  it("renders a select whose options use container_path values, preselects the running model", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ path: "/models", exists: true, writable_config: true }));
    const localModels = {
      reachable: true,
      models: [
        { id: "qwen3-30b", name: "Qwen3 30B AWQ", state: "loaded", container_path: "/models/Qwen3-30B-A3B-Instruct-2507-AWQ" },
        { id: "qwen3-14b", name: "Qwen3 14B", state: "available", container_path: "/models/Qwen3-14B" },
      ],
    };
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={VLLM_PROVIDER}
        localModels={localModels}
        onSpillChange={() => {}}
        onToast={() => {}}
        onModelsRefresh={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));

    const select = await screen.findByLabelText("Model to restart with");
    expect(select.value).toBe("/models/Qwen3-30B-A3B-Instruct-2507-AWQ");

    const options = Array.from(select.querySelectorAll("option")).map((o) => o.value);
    expect(options).toContain("/models/Qwen3-30B-A3B-Instruct-2507-AWQ");
    expect(options).toContain("/models/Qwen3-14B");
    expect(options).toContain("__custom__");
  });

  it("reveals a text input when 'custom path…' is selected", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ path: "/models", exists: true, writable_config: true }));
    const localModels = {
      reachable: true,
      models: [{ id: "m1", state: "loaded", container_path: "/models/m1" }],
    };
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={VLLM_PROVIDER}
        localModels={localModels}
        onSpillChange={() => {}}
        onToast={() => {}}
        onModelsRefresh={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));

    const select = await screen.findByLabelText("Model to restart with");
    fireEvent.change(select, { target: { value: "__custom__" } });

    expect(await screen.findByPlaceholderText("/models/Qwen3-Coder-30B-A3B-AWQ")).toBeInTheDocument();
  });

  it("disables Restart with model with an explanatory title when nothing is selected", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ path: "/models", exists: true, writable_config: true }));
    const localModels = { reachable: true, models: [] };
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={VLLM_PROVIDER}
        localModels={localModels}
        onSpillChange={() => {}}
        onToast={() => {}}
        onModelsRefresh={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));

    const restartBtn = await screen.findByRole("button", { name: "Restart with model" });
    expect(restartBtn.disabled).toBe(true);
    expect(restartBtn.title).toMatch(/select or enter a model/i);
  });

  it("falls back to models-dir current_model as prefill when no model is loaded", async () => {
    const fetchMock = vi.fn((url, opts) => {
      if (!opts && String(url).includes("models-dir")) {
        return jsonResponse({
          path: "/models",
          exists: true,
          writable_config: true,
          current_model: "/models/fallback-model",
        });
      }
      return jsonResponse({});
    });
    globalThis.fetch = fetchMock;
    const localModels = {
      reachable: true,
      models: [
        { id: "m1", state: "available", container_path: "/models/m1" },
        { id: "fallback", state: "available", container_path: "/models/fallback-model" },
      ],
    };
    render(
      <LocalBrokerView
        localEnabled={true}
        setLocalEnabled={() => {}}
        localStatus={null}
        localQueue={null}
        selectedProvider={VLLM_PROVIDER}
        localModels={localModels}
        onSpillChange={() => {}}
        onToast={() => {}}
        onModelsRefresh={() => {}}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText("Connection & provider settings"));

    const select = await screen.findByLabelText("Model to restart with");
    await waitFor(() => expect(select.value).toBe("/models/fallback-model"));
  });
});

describe("LocalBrokerView — models folder mount/scan paths", () => {
  it("shows mount_path and scan_path when they differ, plus the exists indicator", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      jsonResponse({
        path: "/home/user/models",
        mount_path: "/home/user/models",
        scan_path: "\\\\wsl$\\Ubuntu\\home\\user\\models",
        exists: true,
        writable_config: true,
      })
    );
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

    await waitFor(() => expect(screen.getByText("Models Folder")).toBeInTheDocument());
    expect(screen.getByText(/mounted at .*scanned at/)).toBeInTheDocument();
    expect(screen.getByText(/exists/)).toBeInTheDocument();
  });
});

describe("LocalModelsPanel — reason-aware offline messaging", () => {
  it("shows LM Studio 'lms server start' guidance when reason is unreachable", () => {
    render(<LocalModelsPanel models={{ reachable: false, reason: "unreachable", models: [] }} providerKind="lmstudio" />);
    expect(screen.getByText(/lms server start/i)).toBeInTheDocument();
  });

  it("shows vLLM container guidance when reason is unreachable", () => {
    render(<LocalModelsPanel models={{ reachable: false, reason: "unreachable", models: [] }} providerKind="vllm" />);
    expect(screen.getByText(/container isn't running/i)).toBeInTheDocument();
  });

  it("still lists disk-only models when reason is server_offline_disk_only", () => {
    render(
      <LocalModelsPanel
        models={{ reachable: false, reason: "server_offline_disk_only", models: [{ id: "/models/foo", state: "available" }] }}
        providerKind="vllm"
        controlEnabled
      />
    );
    expect(screen.getByText(/found on disk/i)).toBeInTheDocument();
    expect(screen.getByText("/models/foo")).toBeInTheDocument();
  });
});
