/**
 * S8 -> T9. THE CONTROLS THIS FILE GUARDED ARE GONE, AND THE GUARD SURVIVES
 * INVERTED RATHER THAN DELETED.
 *
 * S8's finding was that the lane-broker card offered three controls the server
 * read NONE of -- base_url (the truth is COCKPIT_BROKER_URL), autostart
 * (COCKPIT_MANAGED_BROKER), concurrency (nothing at all reads it) -- and that a
 * setting which silently does nothing is worse than an absent one. The fix at
 * the time was a not-enforced note per control, structurally discovered from
 * the component's own source so a FOURTH control could not be added without
 * one.
 *
 * T9 / 2026-08-04 deleted the card on the owner's ruling. That resolves S8's
 * defect in the strongest available direction: the three controls that could
 * not move anything are not annotated, they are removed. It also DESTROYS the
 * old guard, and silently -- the discovery regex would match nothing, and "all
 * zero controls have a note" is trivially true. That is exactly the vacuous
 * pass the old file's own comment (R19 / NOTE-17) warned about, arriving by the
 * one route it did not anticipate: the whole set going at once.
 *
 * SO THE PROPERTY IS RESTATED, NOT DROPPED. The old file asserted "every
 * lane_broker control has a note"; this one asserts "the page binds NO
 * lane_broker control at all". Both forbid the same thing -- a control on this
 * page that claims an effect it does not have -- and the new form cannot pass
 * vacuously, because the thing it counts must be ZERO rather than merely
 * matching a set it discovered itself. Re-adding any of the three fails here on
 * the control that was added, naming it.
 *
 * The two effective-address tests are KEPT and re-pointed. `status.url` vs. a
 * disagreeing stored value was the sharpest live defect S8 found, and the
 * statement still ships -- it moved into the LM Studio card, which is where the
 * owner said a property of LM Studio belongs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ProvidersSettings from "../components/settings/ProvidersSettings";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(HERE, "..", "components", "settings", "ProvidersSettings.jsx");

const STATUS = {
  reachable: true,
  compatible: true,
  service: "lane-broker",
  detail: "",
  url: "http://127.0.0.1:1235",
  managed: true,
};

function makeShell(overrides = {}) {
  const values = {
    "providers.lane_broker.base_url": "http://127.0.0.1:1235",
    "providers.lane_broker.autostart": true,
    "providers.lane_broker.concurrency": 1,
  };
  return {
    get: (p, fallback) => (p in values ? values[p] : fallback),
    setField: vi.fn(),
    isDirty: () => false,
    ...overrides,
  };
}

const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body });

beforeEach(() => {
  globalThis.fetch = vi.fn(async (url) => {
    const u = String(url);
    if (u === "/api/local/status") return jsonOk(STATUS);
    if (u === "/api/local/providers") {
      return jsonOk({
        providers: [
          {
            id: "lmstudio-local",
            label: "LM Studio (local)",
            kind: "lmstudio",
            scope: "local",
            capabilities: ["models", "health", "queue", "metrics"],
          },
        ],
      });
    }
    if (u === "/api/local/vllm/ownership") {
      return jsonOk({
        effective: false, configured: false, external: false, source: "settings",
        pending_restart: false, requires_restart: false, env_set: false, reason: "",
      });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.fetch;
});

describe("the lane-broker controls are gone, and nothing may quietly re-add them", () => {
  it("the page binds NO providers.lane_broker.* control at all", async () => {
    const src = fs.readFileSync(SOURCE, "utf8");
    const bound = [...src.matchAll(/path="providers\.lane_broker\.([a-z_]+)"/g)].map((m) => m[1]);

    // The inversion of S8's guard. A zero here is the ASSERTION, not a
    // discovery failure that makes the check vacuous -- which is what the same
    // zero meant in the previous form of this file.
    expect(bound, `providers.lane_broker.* controls are back: ${bound.join(", ")}`).toEqual([]);

    // Not merely unbound: not drawn either. The card, its pair wrapper and its
    // three not-enforced notes must all be absent from the render.
    render(<ProvidersSettings {...makeShell()} />);
    await waitFor(() => expect(screen.getByTestId("card-lmstudio")).toBeInTheDocument());
    for (const id of [
      "card-lane-broker",
      "row-broker-queueing",
      "card-queueing",
      "broker-health",
      "test-lane-broker",
      "not-enforced-lane-broker-base-url",
      "not-enforced-lane-broker-autostart",
      "not-enforced-lane-broker-concurrency",
    ]) {
      expect(screen.queryByTestId(id), `${id} should be gone`).toBeNull();
    }
  });

  it("shows the address the transport ACTUALLY binds, from status.url", async () => {
    render(<ProvidersSettings {...makeShell()} />);
    const note = await screen.findByTestId("broker-effective-url");
    expect(note).toHaveTextContent("127.0.0.1:1235");
    expect(note).toHaveTextContent(/started by Plexar Studio/i);
  });

  it("the effective address survives a stored field value that disagrees with it", async () => {
    // The sharpest case, and the one that was actually broken: the stored
    // setting said :8431, nothing has ever listened there, and the card showed
    // it as though it were the address in use. The control is gone now, but a
    // stale value can still sit in settings.json -- the displayed truth must
    // come from the server, and must not track that value.
    const shell = makeShell({
      get: (p, fallback) =>
        p === "providers.lane_broker.base_url" ? "http://127.0.0.1:8431" : fallback,
    });
    render(<ProvidersSettings {...shell} />);
    const note = await screen.findByTestId("broker-effective-url");
    expect(note).toHaveTextContent("127.0.0.1:1235");
    expect(note).not.toHaveTextContent("8431");
  });

  it("the transport note lives INSIDE the LM Studio card, not beside it", async () => {
    // The owner's ruling was structural, not cosmetic: the broker is a property
    // of LM Studio, so its statement must be contained by LM Studio's card. A
    // note rendered as a sibling would read on screen as the same peer block
    // under a smaller heading.
    render(<ProvidersSettings {...makeShell()} />);
    const card = await screen.findByTestId("card-lmstudio");
    const note = await screen.findByTestId("lmstudio-transport");
    expect(card).toContainElement(note);
    expect(card).toContainElement(screen.getByTestId("broker-effective-url"));
  });

  it("says WHETHER it queues, and never infers that from a depth of zero", async () => {
    // S10's ruling outlived the card that carried it. Three states, never
    // collapsed -- and the flag is READ (`/queue` -> shadow), because a healthy
    // idle queueing broker also reports an empty queue.
    render(<ProvidersSettings {...makeShell()} />);
    await screen.findByTestId("lmstudio-transport");
    await waitFor(() => {
      const states = ["queueing-shadow", "queueing-on", "queueing-unknown"]
        .map((id) => screen.queryByTestId(id))
        .filter(Boolean);
      expect(states).toHaveLength(1);
    });
  });
});
