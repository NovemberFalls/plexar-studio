/**
 * Settings ▸ Providers — the page is TWO half-width pairs, and nothing is
 * full width.
 *
 * IT WAS THREE UNTIL T9 / 2026-08-04. The owner ruled the `Lane broker` card
 * off the page entirely — *"if lane broker is unique to lmstudio then its not
 * doing the right job, and I would remove it or merge it into the lmstudio
 * card"* — and its partner, `Queueing`, was a property of the same component so
 * it went with it. THE GATE WAS UPDATED, NOT LOOSENED, for the second time: the
 * row count changed, every other assertion is unchanged, and the last test
 * still says every card on the page is paired. Four cards is an EVEN count, so
 * nothing was orphaned and nothing was invented to fill a slot.
 *
 * The card ORDER is the owner's too: he asked for Lane Broker, vLLM, LM Studio,
 * OpenRouter, Ollama. With the first gone the remaining four are applied in his
 * order, and the ROWS table below is the assertion that they stay in it.
 *
 * The owner walked this page on 1.29 and read the widths as a claim about
 * importance: *"Lane Broker has no business being that wide"*, *"LM Studio and
 * VLLM can share the width and get bumped to be together like OLLAMA and
 * OpenRouter"*, *"Spill policy … is not the full page width"*. Six blocks, three
 * rows of two.
 *
 * SPILL POLICY WAS REMOVED 2026-08-03 and its half of the first row is now the
 * Queueing card. THE GATE WAS UPDATED, NOT LOOSENED: the row is still asserted
 * to be two equal tracks holding two named cards, and the last test still says
 * every card on the page is paired. A removal that left Lane broker alone would
 * have failed this file, which is the point of it.
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
      capabilities: ["models", "health", "queue", "metrics"],
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

/** The two rows, in the owner's order. */
const ROWS = [
  ["row-vllm-lmstudio", ["card-vllm", "card-lmstudio"]],
  ["row-openrouter-ollama", ["card-openrouter", "card-ollama"]],
];

/** The owner's order, flattened. Asserted as a SEQUENCE against document
 *  order, because the ROWS table above pins which cards share a row and would
 *  pass just as happily with the two swapped inside it. */
const OWNER_ORDER = ["card-vllm", "card-lmstudio", "card-openrouter", "card-ollama"];

describe("Providers page layout — two half-width pairs", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url) => {
      const u = String(url);
      if (u.includes("/api/local/providers")) return json(PROVIDERS);
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

  it("the four cards appear in the owner's order", async () => {
    const h = harness();
    const { container } = render(<ProvidersSettings {...h} />);
    await screen.findByTestId("row-vllm-lmstudio");
    await waitFor(() => expect(screen.getByTestId("card-ollama")).toBeInTheDocument());

    const order = Array.from(container.querySelectorAll('[data-testid^="card-"]')).map((el) =>
      el.getAttribute("data-testid")
    );
    expect(order).toEqual(OWNER_ORDER);
  });

  it("the deleted Lane broker and Queueing cards are GONE, not hidden", async () => {
    const h = harness();
    const { container } = render(<ProvidersSettings {...h} />);
    await screen.findByTestId("row-vllm-lmstudio");

    // A removal, not a deprecation: no stub, no disabled card, no display:none
    // wrapper keeping the markup alive for a future revival.
    expect(screen.queryByTestId("card-lane-broker")).toBeNull();
    expect(screen.queryByTestId("card-queueing")).toBeNull();
    expect(screen.queryByTestId("row-broker-queueing")).toBeNull();
    expect(container.innerHTML).not.toMatch(/Lane broker/i);
  });

  it("every card on the page is inside a pair — nothing is full width", async () => {
    const h = harness();
    const { container } = render(<ProvidersSettings {...h} />);
    await screen.findByTestId("row-vllm-lmstudio");

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
