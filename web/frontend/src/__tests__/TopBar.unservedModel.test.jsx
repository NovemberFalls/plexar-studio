/**
 * The picker used to conflate two different actions: "use this model for my
 * session" and "load this model into the engine". On LM Studio (model-control)
 * they are one click. On an EXTERNAL vLLM they are not — only the served model
 * can answer a request, and nothing in Plexar Studio can change which one that is.
 *
 * The owner picked an unserved vLLM model, got a toast pointing at another
 * screen, and was left with a session default the engine cannot serve. These
 * tests pin the state that made that possible as impossible.
 */

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";
import {
  ModelCatalogContext,
  FALLBACK_MODEL_GROUPS,
  buildLocalGroups,
} from "../modelCatalog.js";

const VLLM_PROVIDER = {
  id: "vllm-local",
  label: "vLLM (local)",
  scope: "local",
  capabilities: ["models", "health"], // NO model-control — external container
};
const LMSTUDIO_PROVIDER = {
  id: "lmstudio-local",
  label: "LM Studio (local)",
  scope: "local",
  capabilities: ["models", "model-control"],
};

const VLLM_MODELS = {
  "vllm-local": {
    reachable: true,
    models: [
      { id: "qwen3-30b-instruct", state: "loaded" },
      { id: "/models/Qwen3-Coder-30B-A3B-AWQ", state: "not-loaded" },
    ],
  },
};

function catalogFor(providers, byProvider) {
  const groups = [...FALLBACK_MODEL_GROUPS, ...buildLocalGroups(providers, byProvider)];
  return { groups, models: groups.flatMap((g) => g.models), source: "live" };
}

function jsonResponse(body, ok = true) {
  return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
}

function renderTopBar({ catalog, model = "sonnet", ...props } = {}) {
  const setModel = vi.fn();
  const onLoadLocalModel = vi.fn();
  render(
    <ThemeProvider>
      <ModelCatalogContext.Provider value={catalog}>
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

describe("TopBar — local provider WITHOUT model-control", () => {
  const catalog = () => catalogFor([VLLM_PROVIDER], VLLM_MODELS);

  async function openPicker() {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    const handles = renderTopBar({ catalog: catalog() });
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "qwen3-30b-instruct" })).toBeInTheDocument();
    });
    return handles;
  }

  it("does not let an unserved model become the session default", async () => {
    const { setModel } = await openPicker();
    const row = screen.getByRole("option", { name: /Qwen3-Coder-30B-A3B-AWQ/ });
    expect(row).toBeDisabled();
    fireEvent.click(row);
    expect(setModel).not.toHaveBeenCalled();
  });

  it("carries the reason in visible text AND in a title", async () => {
    await openPicker();
    const row = screen.getByRole("option", { name: /Qwen3-Coder-30B-A3B-AWQ/ });
    expect(row).toHaveAttribute("title", expect.stringMatching(/restart it with this model/i));
    // Visible on the row itself — the owner reads the screen, not tooltips.
    expect(screen.getByText("not selectable")).toBeInTheDocument();
    expect(row).toHaveTextContent("on disk, not served");
  });

  it("still lets the SERVED model be chosen, and shows it without a caveat", async () => {
    const { setModel } = await openPicker();
    const served = screen.getByRole("option", { name: "qwen3-30b-instruct" });
    expect(served).not.toBeDisabled();
    expect(served).not.toHaveTextContent("not served");
    fireEvent.click(served);
    expect(setModel).toHaveBeenCalledWith("local:vllm-local:qwen3-30b-instruct");
  });

  it("keeps unserved models visible (the list doubles as what-is-on-disk)", async () => {
    await openPicker();
    expect(screen.getByRole("option", { name: /Qwen3-Coder-30B-A3B-AWQ/ })).toBeInTheDocument();
  });

  it("offers no Load button — Plexar Studio cannot load into this engine", async () => {
    await openPicker();
    expect(screen.queryByRole("button", { name: /^Load / })).not.toBeInTheDocument();
  });

  it("explains the limit at the group, as a note rather than an error", async () => {
    await openPicker();
    expect(
      screen.getByText(/Only the model this engine is serving can be used/i)
    ).toBeInTheDocument();
  });

  it("renders the warning treatment when the default is not the served model", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    renderTopBar({
      catalog: catalog(),
      model: "local:vllm-local:/models/Qwen3-Coder-30B-A3B-AWQ",
    });
    const pill = screen.getByRole("button", { name: /not being served, sessions will fail/i });
    expect(pill).toHaveAttribute("title", expect.stringMatching(/will fail/i));
    expect(pill.getAttribute("style")).toContain("--cc-waiting");
  });

  it("renders no warning treatment when the default IS the served model", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    renderTopBar({ catalog: catalog(), model: "local:vllm-local:qwen3-30b-instruct" });
    const pill = screen.getByRole("button", { name: /^Model:/ });
    expect(pill.getAttribute("style")).not.toContain("--cc-waiting");
  });
});

describe("TopBar — local provider WITH model-control is unchanged", () => {
  it("keeps an unloaded model selectable and still offers Load", async () => {
    globalThis.fetch = vi.fn().mockReturnValue(jsonResponse({ configured: false }));
    const catalog = catalogFor([LMSTUDIO_PROVIDER], {
      "lmstudio-local": {
        reachable: true,
        models: [{ id: "qwen3-coder-30b", state: "not-loaded" }],
      },
    });
    const { setModel, onLoadLocalModel } = renderTopBar({ catalog });
    fireEvent.click(screen.getByRole("button", { name: /model:/i }));

    const row = await screen.findByRole("option", { name: /qwen3-coder-30b · not loaded/ });
    expect(row).not.toBeDisabled();
    expect(screen.queryByText("not selectable")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load qwen3-coder-30b" }));
    expect(onLoadLocalModel).toHaveBeenCalledWith("lmstudio-local", "qwen3-coder-30b");

    fireEvent.click(row);
    expect(setModel).toHaveBeenCalledWith("local:lmstudio-local:qwen3-coder-30b");
  });
});
