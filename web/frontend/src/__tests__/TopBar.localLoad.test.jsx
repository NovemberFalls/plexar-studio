/**
 * Tests for the picker's inline "Load" affordance on not-loaded local model
 * rows (see task brief: local model picker load-state + load action).
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";
import { ModelCatalogContext, FALLBACK_MODEL_GROUPS } from "../modelCatalog.js";

const LOCAL_GROUP = {
  label: "LM Studio",
  provider: "local",
  models: [
    {
      id: "local:lmstudio-local:qwen3-coder-30b-awq",
      label: "qwen3-coder-30b-awq · not loaded",
      provider: "local",
      localProviderId: "lmstudio-local",
      localModelId: "qwen3-coder-30b-awq",
      loaded: false,
    },
    {
      id: "local:lmstudio-local:already-loaded",
      label: "already-loaded",
      provider: "local",
      localProviderId: "lmstudio-local",
      localModelId: "already-loaded",
      loaded: true,
    },
  ],
};

const CATALOG_WITH_LOCAL = {
  groups: [...FALLBACK_MODEL_GROUPS, LOCAL_GROUP],
  models: [...FALLBACK_MODEL_GROUPS.flatMap((g) => g.models), ...LOCAL_GROUP.models],
  source: "live",
};

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

function renderTopBar(props = {}) {
  const setModel = vi.fn();
  const onLoadLocalModel = vi.fn();
  render(
    <ThemeProvider>
      <ModelCatalogContext.Provider value={CATALOG_WITH_LOCAL}>
        <TopBar
          model="sonnet"
          setModel={setModel}
          permissionMode="default"
          setPermissionMode={vi.fn()}
          effort=""
          setEffort={vi.fn()}
          fast={false}
          setFast={vi.fn()}
          sidebarOpen={false}
          setSidebarOpen={vi.fn()}
          user={{ name: "X" }}
          onToast={vi.fn()}
          localLaunchEnabled={true}
          onLoadLocalModel={onLoadLocalModel}
          localBusyModelId={null}
          {...props}
        />
      </ModelCatalogContext.Provider>
    </ThemeProvider>
  );
  return { setModel, onLoadLocalModel };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TopBar — local model Load affordance", () => {
  it("shows a Load button only on the not-loaded local entry", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.getByRole("option", { name: /not loaded/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "Load qwen3-coder-30b-awq" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load already-loaded" })).not.toBeInTheDocument();
  });

  it("omits Load affordances when local launch is disabled", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    renderTopBar({ localLaunchEnabled: false });
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.getByText("Enable the local broker to launch local models")).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /^Load /i })).not.toBeInTheDocument();
  });

  it("clicking Load calls onLoadLocalModel with (providerId, modelId) and does not select the model", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    const { setModel, onLoadLocalModel } = renderTopBar();
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Load qwen3-coder-30b-awq" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Load qwen3-coder-30b-awq" }));
    expect(onLoadLocalModel).toHaveBeenCalledWith("lmstudio-local", "qwen3-coder-30b-awq");
    expect(setModel).not.toHaveBeenCalled();
  });

  it("disables the Load button and shows a busy state for the busy model", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    renderTopBar({ localBusyModelId: "qwen3-coder-30b-awq" });
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Load qwen3-coder-30b-awq" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Load qwen3-coder-30b-awq" })).toBeDisabled();
  });
});
