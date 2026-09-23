import { describe, it, expect } from "vitest";
import { HARNESSES, reconcileModelForHarness } from "../modelCatalog";

describe("Plexar Harness in the shared harness list", () => {
  it("is offered wherever HARNESSES is rendered (TopBar pill and New Session dialog)", () => {
    expect(HARNESSES.map((h) => h.id)).toEqual(["claude-code", "codex", "plexar-harness"]);
  });

  it("switching to it keeps the stored Claude model instead of replacing it", () => {
    expect(reconcileModelForHarness("claude-opus-5-5", "plexar-harness")).toEqual({
      model: "claude-opus-5-5",
      changed: false,
    });
  });
});
