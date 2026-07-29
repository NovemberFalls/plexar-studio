/**
 * Tests for TopBar's local-model group gating (see task brief: wire the
 * local-model picker to the local launch path).
 *
 * A local group is only present in the catalog when the local broker feature
 * has produced reachable providers with models (see modelCatalog.js
 * buildLocalGroups). Rather than mocking the /api/models + /api/local/*
 * fetch chain, we wrap TopBar in ModelCatalogContext.Provider with a fixed
 * catalog value that includes one local group — mirroring the shape
 * buildLocalGroups() produces.
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
      label: "qwen3-coder-30b-awq",
      provider: "local",
      localProviderId: "lmstudio-local",
      localModelId: "qwen3-coder-30b-awq",
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

function renderTopBar({ model = "sonnet", setModel = vi.fn(), localLaunchEnabled = false } = {}) {
  render(
    <ThemeProvider>
      <ModelCatalogContext.Provider value={CATALOG_WITH_LOCAL}>
        <TopBar
          model={model}
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
          localLaunchEnabled={localLaunchEnabled}
        />
      </ModelCatalogContext.Provider>
    </ThemeProvider>
  );
  return { setModel };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TopBar — local model group gating", () => {
  it("disables local entries when localLaunchEnabled is false", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false, source: null, masked: null }));
    const { setModel } = renderTopBar({ localLaunchEnabled: false });

    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.getByText("Enable the local broker to launch local models")).toBeInTheDocument();
    });

    const entry = screen.getByRole("option", { name: "qwen3-coder-30b-awq" });
    expect(entry).toBeDisabled();

    fireEvent.click(entry);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("makes local entries selectable when localLaunchEnabled is true", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false, source: null, masked: null }));
    const { setModel } = renderTopBar({ localLaunchEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    await waitFor(() => {
      expect(screen.queryByText("Enable the local broker to launch local models")).not.toBeInTheDocument();
    });

    const entry = screen.getByRole("option", { name: "qwen3-coder-30b-awq" });
    expect(entry).not.toBeDisabled();

    fireEvent.click(entry);
    expect(setModel).toHaveBeenCalledWith("local:lmstudio-local:qwen3-coder-30b-awq");
  });
});
