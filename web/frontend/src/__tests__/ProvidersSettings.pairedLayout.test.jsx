/**
 * Settings ▸ Providers — the page is THREE half-width pairs, and nothing is
 * full width.
 *
 * The owner walked this page on 1.29 and read the widths as a claim about
 * importance: *"Lane Broker has no business being that wide"*, *"LM Studio and
 * VLLM can share the width and get bumped to be together like OLLAMA and
 * OpenRouter"*, *"Spill policy … is not the full page width"*. Six blocks, three
 * rows of two.
 *
 * The load-bearing test is the LAST one, and it is why this file exists rather
 * than three assertions bolted onto the existing suite. Pinning "these two are
 * in a row together" three times still passes the moment somebody adds a
 * seventh block full width — which is exactly how the page drifted into two
 * full-width cards above one pair in the first place. So the invariant under
 * test is not the three rows, it is that EVERY card on this page lives inside a
 * pair. A new card must choose a partner or fail this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ProvidersSettings from "../components/settings/ProvidersSettings";

const PROVIDERS = {
  providers: [
    {
      id: "lmstudio-local",
      label: "LM Studio (local)",
      kind: "lmstudio",
      scope: "local",
      capabilities: ["models", "health", "queue", "metrics", "spill"],
    },
  ],
};
const STATUS = {
  reachable: true,
  compatible: true,
  service: "lane-broker",
  detail: "lane broker contract verified via /queue",
  url: "http://127.0.0.1:1235",
  managed: true,
};
const OWNERSHIP = {
  effective: false, configured: false, external: false, source: "settings",
  pending_restart: false, requires_restart: false, env_set: false,
  reason: "vLLM is external — start and stop it where you started it.",
};

const json = (body) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

function harness() {
  const store = {};
  return {
    get: (path, fallback) => (path in store ? store[path] : fallback),
    setField: (path, value) => { store[path] = value; },
    isDirty: () => false,
  };
}

/** The three rows, as the owner described them. */
const ROWS = [
  ["row-broker-spill", ["card-lane-broker", "card-spill-policy"]],
  ["row-lmstudio-vllm", ["card-lmstudio", "card-vllm"]],
  ["row-ollama-openrouter", ["card-ollama", "card-openrouter"]],
];

describe("Providers page layout — three half-width pairs", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url) => {
      const u = String(url);
      if (u.includes("/api/local/providers")) return json(PROVIDERS);
      if (u.includes("/api/local/status")) return json(STATUS);
      if (u.includes("/vllm/ownership")) return json(OWNERSHIP);
      if (u.includes("/health")) return json({ ok: true, provider: { reachable: true, models_loaded: 1 } });
      return json({});
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  for (const [rowId, cardIds] of ROWS) {
    it(`${rowId} is a two-column grid holding ${cardIds.join(" + ")}`, async () => {
      const h = harness();
      render(<ProvidersSettings {...h} />);
      const row = await screen.findByTestId(rowId);

      // The pairing itself: two equal tracks. A row that exists but renders one
      // column is the same full-width card wearing a wrapper.
      expect(row).toHaveStyle({ gridTemplateColumns: "1fr 1fr" });

      for (const cardId of cardIds) {
        await waitFor(() => expect(screen.getByTestId(cardId)).toBeInTheDocument());
        expect(row).toContainElement(screen.getByTestId(cardId));
      }
    });
  }

  it("every card on the page is inside a pair — nothing is full width", async () => {
    const h = harness();
    const { container } = render(<ProvidersSettings {...h} />);
    await screen.findByTestId("row-broker-spill");

    const rows = ROWS.map(([id]) => screen.getByTestId(id));
    const cards = Array.from(container.querySelectorAll('[data-testid^="card-"]'));

    // Guard against the assertion passing vacuously: if the selector stops
    // matching, "all zero cards are paired" is trivially true.
    expect(cards.length).toBeGreaterThanOrEqual(ROWS.length * 2);

    const orphans = cards
      .filter((card) => !rows.some((row) => row !== card && row.contains(card)))
      .map((card) => card.getAttribute("data-testid"));

    expect(orphans).toEqual([]);
  });
});
