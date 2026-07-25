/**
 * Tests for TopBar model picker — verifies the Claude 4.8 group appears
 * and that the newest generation is ordered ahead of older ones.
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
// Suite — Claude 4.8 models appear in the picker
// ---------------------------------------------------------------------------

describe("TopBar model picker — Claude 4.8 group", () => {
  it("shows Opus 4.8 and Opus 4.8 (1M) entries after opening the picker", () => {
    renderTopBar();

    // Open the model picker by clicking the button that shows the current model label
    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    // Both model entries must be in the DOM
    expect(screen.getByText("Opus 4.8")).toBeInTheDocument();
    expect(screen.getByText("Opus 4.8 (1M)")).toBeInTheDocument();
  });

  it("shows the Claude 4.8 group label in the picker", () => {
    renderTopBar();

    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    expect(screen.getByText("Claude 4.8")).toBeInTheDocument();
  });

  it("newest generation (Claude 5) is ordered before Claude 4.8 in the DOM", () => {
    // Rendered without a ModelCatalogProvider, TopBar uses the static fallback
    // catalog; group ordering there is newest-first (in the live app it comes
    // from Anthropic's /v1/models order). Either way, newer precedes older.
    renderTopBar();

    const pickerButton = screen.getByRole("button", { name: /opus/i });
    fireEvent.click(pickerButton);

    const allText = document.body.textContent;
    const idx5 = allText.indexOf("Claude 5");
    const idx48 = allText.indexOf("Claude 4.8");

    expect(idx5).toBeGreaterThan(-1);
    expect(idx48).toBeGreaterThan(-1);
    expect(idx5).toBeLessThan(idx48);
  });
});
