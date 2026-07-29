/**
 * Tests for TopBar model picker — verifies the Opus family group appears
 * and that families are ordered Opus, Sonnet, Haiku, Fable.
 *
 * TopBar calls useTheme() which requires a ThemeProvider. We wrap
 * the render in a ThemeProvider to satisfy that requirement.
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";

// lucide-react icons render as real SVGs — no mock needed.

function renderTopBar(modelOverride = "claude-opus-4-7") {
  return render(
    <ThemeProvider>
      <TopBar
        model={modelOverride}
        setModel={vi.fn()}
        sidebarOpen={false}
        setSidebarOpen={vi.fn()}
        user={{ name: "X" }}
      />
    </ThemeProvider>
  );
}

// ---------------------------------------------------------------------------
// Suite — Opus 4.8 models appear in the picker
// ---------------------------------------------------------------------------

describe("TopBar model picker — Opus family group", () => {
  it("shows Opus 4.8 and Opus 4.8 (1M) entries after opening the picker", () => {
    renderTopBar();

    // Open the model picker by clicking the button that shows the current model label
    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    // Both model entries must be in the DOM
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("Opus 4.8 (1M)")).toBeInTheDocument();
  });

  it("shows the Opus family group label in the picker", () => {
    renderTopBar();

    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    expect(screen.getByText("Opus")).toBeInTheDocument();
  });

  it("families are ordered Opus before Sonnet before Haiku before Fable in the DOM", () => {
    // Rendered without a ModelCatalogProvider, TopBar uses the static fallback
    // catalog; family ordering is fixed (Opus, Sonnet, Haiku, Fable, ...).
    renderTopBar();

    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    const allText = document.body.textContent;
    const idxOpus = allText.indexOf("Opus");
    const idxSonnet = allText.indexOf("Sonnet");
    const idxHaiku = allText.indexOf("Haiku");
    const idxFable = allText.indexOf("Fable");

    expect(idxOpus).toBeGreaterThan(-1);
    expect(idxSonnet).toBeGreaterThan(-1);
    expect(idxHaiku).toBeGreaterThan(-1);
    expect(idxFable).toBeGreaterThan(-1);
    expect(idxOpus).toBeLessThan(idxSonnet);
    expect(idxSonnet).toBeLessThan(idxHaiku);
    expect(idxHaiku).toBeLessThan(idxFable);
  });
});
