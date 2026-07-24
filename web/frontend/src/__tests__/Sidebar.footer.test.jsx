/**
 * Tests for the Sidebar resources footer (web/frontend/src/components/Sidebar.jsx).
 *
 * Covers:
 *   1. Support button — posts https://desk.boord-its.com to /api/open-url
 *      (backend opens the default browser; correct path in the Tauri app).
 *   2. Support button — falls back to window.open when the POST fails
 *      (plain-browser dev mode without the backend).
 *
 * Note: the "MCP Servers" footer link was removed in the visual redesign —
 * the resources footer now only contains the Support button.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Sidebar from "../components/Sidebar.jsx";

function renderSidebar() {
  return render(
    <Sidebar
      sessions={[]}
      activeIds={[]}
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onNewAt={vi.fn()}
      onDelete={vi.fn()}
      open={true}
      savedLocations={[]}
      onAddLocations={vi.fn()}
      onRemoveLocation={vi.fn()}
      onToggleLocationBypass={vi.fn()}
    />
  );
}

describe("Sidebar — resources footer external links", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: true })));
    vi.stubGlobal("open", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Support posts the BITS desk URL to /api/open-url", () => {
    renderSidebar();
    fireEvent.click(screen.getByText("Support"));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [path, opts] = fetch.mock.calls[0];
    expect(path).toBe("/api/open-url");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ url: "https://desk.boord-its.com" });
  });

  it("Support falls back to window.open when the POST fails", async () => {
    fetch.mockImplementation(() => Promise.reject(new Error("backend down")));
    renderSidebar();
    fireEvent.click(screen.getByText("Support"));

    await waitFor(() => {
      expect(window.open).toHaveBeenCalledWith("https://desk.boord-its.com", "_blank");
    });
  });
});

describe("Sidebar — session filter focus target", () => {
  it("filter input carries data-sidebar-filter (the rail Search button focuses it)", () => {
    // The filter box only renders when at least one session exists.
    render(
      <Sidebar
        sessions={[{ id: "s1", name: "Session 1", terminalId: "t1", model: "opus", status: "running", workdir: "C:/proj" }]}
        activeIds={["s1"]}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onNewAt={vi.fn()}
        onDelete={vi.fn()}
        open={true}
        savedLocations={[]}
        onAddLocations={vi.fn()}
        onRemoveLocation={vi.fn()}
        onToggleLocationBypass={vi.fn()}
      />
    );
    // Regression: the rail's magnifying-glass button focuses this selector;
    // without the attribute the button silently does nothing.
    expect(document.querySelector("[data-sidebar-filter]")).not.toBeNull();
  });
});
