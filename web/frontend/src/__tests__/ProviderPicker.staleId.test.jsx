/**
 * ProviderPicker — surviving a provider id that no longer exists.
 *
 * This stopped being hypothetical when `plexar` was renamed to `plexar-vllm`
 * (the APP is Plexar; the provider is the model side). Anyone who had selected
 * it before upgrading still has the old id sitting in localStorage.
 *
 * The picker must fall back to a real provider rather than render an empty
 * selection bound to a dead id — a `<select>` whose value matches no option
 * shows blank, and the parent would be told a provider is selected that the
 * server has never heard of.
 *
 * This is why the rename needed no localStorage migration. It is pinned here
 * rather than assumed, because "it already handles that" is exactly the sort
 * of claim that quietly stops being true.
 */

import React from "react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import ProviderPicker from "../components/ProviderPicker.jsx";

const PROVIDERS = [
  { id: "lmstudio-local", label: "LM Studio (local)", scope: "local" },
  { id: "plexar-vllm", label: "Plexar-vLLM", scope: "local" },
];

beforeEach(() => {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ providers: PROVIDERS }) })
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("ProviderPicker — stale selection", () => {
  it("falls back to a real provider when the stored id no longer exists", async () => {
    // What an upgrading user actually has on disk after the rename.
    localStorage.setItem("localProviderId", "plexar");
    const onSelect = vi.fn();

    render(<ProviderPicker enabled onSelect={onSelect} />);

    const select = await screen.findByLabelText("Local model provider");
    await waitFor(() => expect(select.value).toBe("lmstudio-local"));
    expect(select.value).not.toBe("plexar", "a dead id would render a blank select");
  });

  it("tells the parent about the provider it actually settled on", async () => {
    localStorage.setItem("localProviderId", "plexar");
    const onSelect = vi.fn();

    render(<ProviderPicker enabled onSelect={onSelect} />);
    await screen.findByLabelText("Local model provider");

    // The parent drives polling from this; handing it a nonexistent provider
    // would point every request at a 404.
    await waitFor(() => {
      const last = onSelect.mock.calls.at(-1)?.[0];
      expect(last?.id).toBe("lmstudio-local");
    });
  });

  it("keeps a stored id that IS still real", async () => {
    localStorage.setItem("localProviderId", "plexar-vllm");
    render(<ProviderPicker enabled onSelect={vi.fn()} />);

    const select = await screen.findByLabelText("Local model provider");
    await waitFor(() => expect(select.value).toBe("plexar-vllm"));
  });

  it("renders the renamed label", async () => {
    render(<ProviderPicker enabled onSelect={vi.fn()} />);
    expect(await screen.findByText("Plexar-vLLM")).toBeInTheDocument();
  });
});
