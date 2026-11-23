/**
 * The Plexar Harness card moved from Settings ▸ Remote to Settings ▸ Keys &
 * secrets. It keeps its behaviour: the permission mode and rig URL are ordinary
 * drafts through get/setField, the key writes through immediately.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import KeysSettings from "../components/settings/KeysSettings.jsx";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url) === "/api/harness/status") {
        return { ok: true, status: 200, json: async () => ({ launcher: "plexar-harness", node_version: "22.1.0", node_ok: true, key_set: false, key_source: null }) };
      }
      return { ok: true, status: 200, json: async () => ({ configured: false, source: null, masked: null }) };
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KeysSettings — Plexar Harness card", () => {
  it("renders card-harness on this page, after the key cards", async () => {
    render(<KeysSettings get={(_p, f) => f} setField={vi.fn()} />);
    const harness = screen.getByTestId("card-harness");
    expect(harness).toBeInTheDocument();
    expect(screen.getByTestId("card-plexar").compareDocumentPosition(harness) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("harness-status")).toHaveTextContent("22.1.0"));
  });

  it("writes the permission mode and rig URL through setField", () => {
    const setField = vi.fn();
    render(<KeysSettings get={(_p, f) => f} setField={setField} />);
    fireEvent.change(screen.getByTestId("harness-permission-mode"), { target: { value: "read-only" } });
    expect(setField).toHaveBeenCalledWith("harness.permission_mode", "read-only");
    fireEvent.change(screen.getByTestId("harness-rig-url"), { target: { value: "http://rig:8760" } });
    expect(setField).toHaveBeenCalledWith("harness.rig_url", "http://rig:8760");
  });
});
