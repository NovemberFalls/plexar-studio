/**
 * S9 UI arm — the model picker must render THREE distinguishable states.
 *
 * The defect: `buildLocalGroups` omitted any provider that was not reachable
 * OR had no models. Omission is exactly what "the rig is down" looks like, so
 * a rig that was UP and REFUSING THE CREDENTIAL vanished from the picker in
 * the same way — leaving the user to debug a network problem they do not have.
 *
 * This is the same collapse-of-distinguishable-states defect the repo already
 * refuses in three other places (NO_MODEL_LIST_NOTE for a healthy provider that
 * publishes no list; 401-vs-403 in plexar_client._refused; a null latency vs a
 * measured zero in the charts). This pins it for the picker.
 */
import { describe, it, expect } from "vitest";
import {
  buildLocalGroups,
  UNAUTHORIZED_NOTE,
  FORBIDDEN_NOTE,
  NO_MODEL_LIST_NOTE,
} from "../modelCatalog.js";

const PROVIDER = { id: "plexar-vllm", label: "Plexar-vLLM", capabilities: ["models"] };

function groupsFor(resp) {
  return buildLocalGroups([PROVIDER], { "plexar-vllm": resp });
}

describe("model picker: reachable, refused and down are three different things", () => {
  it("STATE 1 — up and authorized: lists the models", () => {
    const groups = groupsFor({
      reachable: true,
      models: [{ id: "qwen3-30b-instruct", state: "loaded" }],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].models.map((m) => m.localModelId)).toEqual(["qwen3-30b-instruct"]);
    // BROWSE_ONLY_NOTE here is correct and pre-existing: this fixture declares
    // `models` but not `model-control`, so the engine is browse-only. What
    // matters for S9 is that it is NOT an auth note -- a healthy, listing
    // provider must never be labelled a credential problem.
    expect(groups[0].note).not.toBe(UNAUTHORIZED_NOTE);
    expect(groups[0].note).not.toBe(FORBIDDEN_NOTE);
  });

  it("STATE 2 — up but refused: provider STAYS VISIBLE and names the fix", () => {
    const groups = groupsFor({
      reachable: true,
      authorized: false,
      models: [],
      reason: "unauthorized",
    });
    // Visible. This is the whole fix: it used to disappear.
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Plexar-vLLM");
    expect(groups[0].models).toEqual([]);
    expect(groups[0].note).toBe(UNAUTHORIZED_NOTE);
    // A note that only diagnoses is half a note; it has to say what to DO.
    expect(groups[0].note).toMatch(/Settings/);
  });

  it("STATE 2b — 403 gets a DIFFERENT remedy than 401", () => {
    const groups = groupsFor({
      reachable: true,
      authorized: false,
      models: [],
      reason: "forbidden",
    });
    expect(groups[0].note).toBe(FORBIDDEN_NOTE);
    expect(groups[0].note).not.toBe(UNAUTHORIZED_NOTE);
    // Telling this user to re-enter a valid key sends them to fix the one
    // thing that is not broken.
    expect(groups[0].note).not.toMatch(/Set a key/);
  });

  it("STATE 3 — genuinely down: omitted, which is DIFFERENT from both above", () => {
    expect(groupsFor({ reachable: false })).toHaveLength(0);
    expect(groupsFor(undefined)).toHaveLength(0);
  });

  it("the three states are pairwise distinct (the actual regression guard)", () => {
    // A per-state assertion still passes when two states quietly become EQUAL,
    // which is precisely how this shipped. Compare them to each other.
    const up = groupsFor({ reachable: true, models: [{ id: "m", state: "loaded" }] });
    const refused = groupsFor({ reachable: true, authorized: false, models: [], reason: "unauthorized" });
    const down = groupsFor({ reachable: false });

    const shape = (g) => JSON.stringify([g.length, g[0]?.note ?? null, g[0]?.models?.length ?? null]);
    expect(shape(up)).not.toBe(shape(refused));
    expect(shape(up)).not.toBe(shape(down));
    // The one that was broken: refused and down were both "nothing at all".
    expect(shape(refused)).not.toBe(shape(down));
  });

  it("does not disturb the existing no-capability rendering", () => {
    // A provider without `models` is healthy and must keep its own note --
    // regression guard on the precedent this fix was modelled on.
    const groups = buildLocalGroups([{ id: "x", label: "X", capabilities: [] }], {});
    expect(groups[0].note).toBe(NO_MODEL_LIST_NOTE);
    expect(groups[0].note).not.toBe(UNAUTHORIZED_NOTE);
  });
});
