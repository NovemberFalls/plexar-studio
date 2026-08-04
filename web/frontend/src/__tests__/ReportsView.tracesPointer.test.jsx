/**
 * Reports ▸ Traces — the "not built" copy must point somewhere that EXISTS.
 *
 * MEASURED 2026-08-03. The owner's report was "Traces is unbuilt and that's
 * not great, it should be tracking stuff and it isn't". The measurement splits
 * that into three separate facts, only one of which is "unbuilt":
 *
 *   · THE RENDERER IS BUILT. TracesPanel.jsx renders the trace roots and the
 *     drill-down node tree, and it is mounted at EngineRequests.jsx:253.
 *   · THE POINTER IS WRONG. This copy sent the reader to "Engine ▸ Traces".
 *     ENGINE_TABS is [Live, Models, Requests, API, Logs] -- there is no Traces
 *     tab and never was. Following the instruction lands on nothing, which is
 *     exactly how a built surface gets reported as missing.
 *   · NOTHING IS BEING RECORDED, for two stacking reasons:
 *       GET /api/local/lmstudio-local/traces -> {"traces":[],"count":0}
 *       GET /api/local/plexar-vllm/traces    -> 404 capability not available
 *     Only the lane broker declares `traces`, and it runs in SHADOW by default
 *     (today's log: `shadow=True`), which skips `_queued_forward` entirely --
 *     so no job is ever queued and no trace is ever written. Meanwhile the
 *     provider actually in use, plexar-vllm, does not declare the capability
 *     at all.
 *
 * An empty panel and a switched-off recorder look identical and mean opposite
 * things. This test pins that the copy says which one it is.
 */

import { describe, it, expect } from "vitest";

import { ENGINE_TABS } from "../components/engine/ui.jsx";
import { NOT_BUILT_TABS } from "../components/reports/notBuilt.js";

describe("Reports ▸ Traces — the pointer", () => {
  it("does not name an Engine tab that does not exist", () => {
    const today = NOT_BUILT_TABS.traces.today;
    const named = [...today.matchAll(/Engine ▸ (\w+)/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThan(0);
    for (const label of named) {
      expect(ENGINE_TABS.map((t) => t.label)).toContain(label);
    }
  });

  it("says traces are switched off rather than implying they are merely elsewhere", () => {
    expect(NOT_BUILT_TABS.traces.today).toMatch(/shadow/i);
  });
});
