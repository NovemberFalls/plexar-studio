import { describe, it, expect } from "vitest";
import { harnessModelServedName } from "../modelCatalog";

describe("harnessModelServedName", () => {
  it("renders the served name of an ACP pair, not the JSON", () => {
    expect(harnessModelServedName('["plexar","qwen3.8-27b"]')).toBe("qwen3.8-27b");
  });
  it("leaves anything that is not a pair verbatim, never another model", () => {
    expect(harnessModelServedName("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(harnessModelServedName('["broken"')).toBe('["broken"');
    expect(harnessModelServedName('["a","b","c"]')).toBe('["a","b","c"]');
    expect(harnessModelServedName("")).toBe("");
  });
});
