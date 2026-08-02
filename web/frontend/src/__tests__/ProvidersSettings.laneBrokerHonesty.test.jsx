/**
 * S8 — a setting that silently does nothing is worse than an absent one,
 * because the user believes they have configured something.
 *
 * The lane-broker card offers three controls and the server reads NONE of them:
 *   base_url    — the truth is GET /api/local/status -> `url`
 *                 (COCKPIT_BROKER_URL / _LOCAL_BROKER_URL)
 *   autostart   — governed by COCKPIT_MANAGED_BROKER
 *   concurrency — read by nothing at all; validated on save, then ignored
 *
 * THE STRUCTURAL TEST IS THE POINT. Asserting "these three notes exist" would
 * pass forever while a FOURTH control was added beside them with no note --
 * which is exactly how the first three got here. So the guard reads the
 * component's own source, extracts every `providers.lane_broker.*` path it
 * binds, and requires a rendered not-enforced note for each. Add a control
 * without a note and this goes red on the control you added, naming it.
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
            capabilities: ["models", "health", "queue", "metrics", "spill"],
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

describe("lane-broker card: no control may claim an effect it does not have", () => {
  it("EVERY providers.lane_broker.* control the card binds has a not-enforced note", async () => {
    const src = fs.readFileSync(SOURCE, "utf8");
    const bound = [...src.matchAll(/path="providers\.lane_broker\.([a-z_]+)"/g)].map((m) => m[1]);

    // Sanity: if this ever reads zero, the regex has drifted and the test would
    // pass vacuously -- the failure mode this whole suite exists to refuse.
    expect(bound.length).toBeGreaterThan(0);

    render(<ProvidersSettings {...makeShell()} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());

    const missing = bound.filter((key) => {
      const id = `not-enforced-lane-broker-${key.replace(/_/g, "-")}`;
      return screen.queryByTestId(id) === null;
    });
    expect(missing, `lane_broker controls with no not-enforced note: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("shows the address the broker ACTUALLY binds, from status.url", async () => {
    render(<ProvidersSettings {...makeShell()} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());
    const note = screen.getByTestId("broker-effective-url");
    expect(note).toHaveTextContent("127.0.0.1:1235");
    expect(note).toHaveTextContent(/started by Cockpit/i);
  });

  it("the effective address survives a field value that disagrees with it", async () => {
    // The sharpest case, and the one that was actually broken: the stored
    // setting said :8431, nothing has ever listened there, and the card showed
    // it as though it were the address in use. The displayed truth must come
    // from the server, not from the box.
    const shell = makeShell({
      get: (p, fallback) =>
        p === "providers.lane_broker.base_url" ? "http://127.0.0.1:8431" : fallback,
    });
    render(<ProvidersSettings {...shell} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());
    expect(screen.getByTestId("broker-effective-url")).toHaveTextContent("127.0.0.1:1235");
  });

  it("each note gives a reason TRUE OF THAT CONTROL, not one blanket sentence", async () => {
    // Lane concurrency is read by no code path AND no env var. Telling that
    // user to go look at an environment variable sends them somewhere that does
    // not exist -- a second wrong turn on top of the first.
    render(<ProvidersSettings {...makeShell()} />);
    await waitFor(() => expect(screen.getByTestId("broker-health")).toBeInTheDocument());

    expect(screen.getByTestId("not-enforced-lane-broker-concurrency")).toHaveTextContent(
      /no code path reads it/i
    );
    expect(screen.getByTestId("not-enforced-lane-broker-base-url")).toHaveTextContent(
      /COCKPIT_BROKER_URL/
    );
    expect(screen.getByTestId("not-enforced-lane-broker-autostart")).toHaveTextContent(
      /COCKPIT_MANAGED_BROKER/
    );

    // Pairwise: the three reasons must not collapse into the same sentence.
    const text = (id) => screen.getByTestId(id).textContent;
    const a = text("not-enforced-lane-broker-concurrency");
    const b = text("not-enforced-lane-broker-base-url");
    const c = text("not-enforced-lane-broker-autostart");
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});
