/**
 * Plexar Harness model/effort pills on TopBar (CARD H-MODELS).
 *
 * - Models render from GET /api/harness/models.
 * - The effort list follows the currently selected model.
 * - A stored-but-invalid-for-this-model effort renders verbatim, never
 *   silently substituted (R-169 shape, applied to the harness pills too).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";

function renderTopBar(props = {}) {
  const spies = {
    setModel: vi.fn(),
    setPermissionMode: vi.fn(),
    setEffort: vi.fn(),
    setFast: vi.fn(),
    setSidebarOpen: vi.fn(),
    setHarness: vi.fn(),
  };
  render(
    <ThemeProvider>
      <TopBar
        harness="plexar-harness"
        setHarness={spies.setHarness}
        model="claude-opus-4-8"
        setModel={spies.setModel}
        permissionMode="default"
        setPermissionMode={spies.setPermissionMode}
        effort=""
        setEffort={spies.setEffort}
        fast={false}
        setFast={spies.setFast}
        sidebarOpen={false}
        setSidebarOpen={spies.setSidebarOpen}
        user={{ name: "X" }}
        {...props}
      />
    </ThemeProvider>
  );
  return spies;
}

const MODELS_TWO = {
  source: "session",
  models: [
    { id: "m1", label: "Model One", efforts: ["off", "high"] },
    { id: "m2", label: "Model Two", efforts: [] },
    { id: "m3", label: "Model Three", efforts: null },
  ],
};

beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = vi.fn((url) => {
    if (String(url).includes("/api/harness/models")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MODELS_TWO) });
    }
    if (String(url).includes("/api/settings/openrouter")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: false }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TopBar — Plexar Harness model pill", () => {
  it("fetches and renders models from GET /api/harness/models", async () => {
    renderTopBar();
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/harness/models"));
    await waitFor(() => expect(screen.getByTestId("harness-model-pill")).toHaveTextContent("Model One"));
    fireEvent.click(screen.getByTestId("harness-model-pill"));
    expect(screen.getByRole("option", { name: "Model One" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Model Two" })).toBeInTheDocument();
  });

  it("renders a visible error state rather than swallowing a fetch failure", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    renderTopBar();
    await waitFor(() => expect(screen.getByTestId("harness-model-pill")).toHaveTextContent("unavailable"));
  });

  it("effort list follows the selected model", async () => {
    renderTopBar();
    await waitFor(() => expect(screen.getByTestId("harness-model-pill")).toHaveTextContent("Model One"));
    // Model One has efforts -> the effort pill is a real control.
    await waitFor(() => expect(screen.getByTestId("harness-effort-pill")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("harness-effort-pill"));
    expect(screen.getByRole("option", { name: "off" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "high" })).toBeInTheDocument();

    // Switch to Model Two, whose efforts were OBSERVED as [] -> no effort
    // control at all, and no "effort set after start" label either: the two
    // states ([] vs null) must render distinctly.
    fireEvent.click(screen.getByTestId("harness-model-pill"));
    fireEvent.click(screen.getByRole("option", { name: "Model Two" }));
    await waitFor(() => expect(screen.queryByTestId("harness-effort-pill")).not.toBeInTheDocument());
    expect(screen.queryByText("effort set after start")).not.toBeInTheDocument();
  });

  it("efforts: null (genuinely unknown) shows the 'effort set after start' label, distinct from efforts: []", async () => {
    renderTopBar();
    await waitFor(() => expect(screen.getByTestId("harness-model-pill")).toHaveTextContent("Model One"));
    fireEvent.click(screen.getByTestId("harness-model-pill"));
    fireEvent.click(screen.getByRole("option", { name: "Model Three" }));
    await waitFor(() => expect(screen.queryByTestId("harness-effort-pill")).not.toBeInTheDocument());
    expect(screen.getByText("effort set after start")).toBeInTheDocument();
  });

  it("source 'none' renders one static model pill plus a static effort label, no dropdowns", async () => {
    globalThis.fetch = vi.fn((url) => {
      if (String(url).includes("/api/harness/models")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ source: "none", models: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: false }) });
    });
    renderTopBar();
    await waitFor(() => expect(screen.getByTestId("harness-model-pill")).toHaveTextContent("Model: harness default"));
    expect(screen.getByText("effort set after start")).toBeInTheDocument();
    expect(screen.queryByTestId("harness-effort-pill")).not.toBeInTheDocument();
    // Static, not a button -> no dropdown to open.
    fireEvent.click(screen.getByTestId("harness-model-pill"));
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows a stored-but-invalid-for-this-model effort verbatim, never silently substituted", async () => {
    localStorage.setItem("cockpit-harness-model", "m1");
    localStorage.setItem("cockpit-harness-effort", "medium"); // not offered by m1 (["off","high"])
    renderTopBar();
    await waitFor(() => expect(screen.getByTestId("harness-effort-pill")).toHaveTextContent("medium"));
    expect(screen.getByTestId("harness-effort-pill")).toHaveAttribute(
      "aria-label",
      expect.stringContaining("not available for this model")
    );
  });

  it("falls back to the model's first effort only when nothing is stored at all", async () => {
    localStorage.setItem("cockpit-harness-model", "m1");
    renderTopBar();
    await waitFor(() => expect(screen.getByTestId("harness-effort-pill")).toHaveTextContent("off"));
  });

  it("a stored model the live list no longer offers shows its served name, marked, not JSON and not a neighbour", async () => {
    localStorage.setItem("cockpit-harness-model", '["plexar","qwen3.8-27b"]');
    renderTopBar();
    const pill = screen.getByTestId("harness-model-pill");
    await waitFor(() => expect(pill).toHaveTextContent("qwen3.8-27b · not offered"));
    expect(pill.textContent).not.toContain("[");
  });
});
