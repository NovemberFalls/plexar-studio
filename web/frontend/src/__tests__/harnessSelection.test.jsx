/**
 * The `harness` dimension (Claude Code | Codex) across the three places it is
 * expressed on the frontend:
 *
 *   1. modelCatalog.js — the pure filter (groupsForHarness) and the static
 *      Codex catalog it prepends.
 *   2. TopBar.jsx      — the harness pill, the model popover it narrows, and
 *      the Fast toggle it disables.
 *   3. App.jsx         — the model reset that fires when the current selection
 *      cannot run on the harness being switched to.
 *
 * App.jsx is a large root component with heavy backend/localStorage/timer
 * dependencies, so — as App.createSessionProvider.test.jsx and
 * App.renameSession.test.jsx already do — section 3 replicates the
 * `selectHarness` callback in a minimal harness component while importing the
 * REAL getModelHarness/defaultModelForHarness, so the logic under test is not a
 * re-implementation.
 *
 * THE LIMIT OF THAT REPLICA, learned the hard way 2026-09-07: it only ever
 * exercises the harness CLICK. Three other paths move one half of the pair —
 * the model pill, the Inspector's applySessionOverride, and the mount restore
 * that reads `cockpit-harness` and `cockpit-model` from two independent
 * localStorage keys — and none of them went through selectHarness, so 2.1.0
 * shipped a TopBar reading "Codex · Opus 5". Section 2b therefore tests the
 * REAL reconcileModelForHarness directly: it is the single arbiter every one
 * of those paths now calls, so covering it covers them all, including paths
 * added after this file was written.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import {
  CODEX_MODEL_GROUPS,
  CODEX_LOCAL_UNSUPPORTED_NOTE,
  DEFAULT_HARNESS,
  DEFAULT_MODEL_ID,
  FALLBACK_MODEL_GROUPS,
  HARNESSES,
  OPENROUTER_GROUP,
  __resetLocalResponsesApi,
  buildLocalGroups,
  defaultModelForHarness,
  getModelHarness,
  groupsForHarness,
  reconcileModelForHarness,
} from "../modelCatalog.js";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";

const { useState, useCallback, useEffect } = React;

// A local-provider group of the exact shape buildLocalGroups() emits. Built
// literally rather than through buildLocalGroups so this file pins
// groupsForHarness's contract with the SHAPE, not with another function's
// current behaviour.
/** Records a MEASURED verdict for a provider, through the same path production
 *  uses (buildLocalGroups reads it off GET /api/local/providers) rather than by
 *  poking the module's internals — so these tests break if that wiring does. */
function measureProvider(id, responses_api) {
  __resetLocalResponsesApi();
  buildLocalGroups([{ id, label: id, capabilities: ["models"], responses_api }], {});
}

function localGroup(responsesApi = false) {
  return {
    label: "LM Studio",
    provider: "local",
    localProviderId: "lmstudio-local",
    canLoad: true,
    // true / false / null, as MEASURED by the server's /v1/responses probe.
    // Defaults to false here so the existing "Codex cannot use this" cases
    // still describe an engine that genuinely cannot.
    responsesApi,
    models: [
      {
        id: "local:lmstudio-local:qwen3-coder-30b",
        label: "qwen3-coder-30b",
        provider: "local",
        loaded: true,
        selectable: true,
        unavailableReason: null,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. groupsForHarness — the pure filter
// ---------------------------------------------------------------------------

describe("groupsForHarness — claude-code is today's behaviour, unchanged", () => {
  it("returns the input list untouched for 'claude-code'", () => {
    const groups = [...FALLBACK_MODEL_GROUPS, localGroup()];
    expect(groupsForHarness(groups, "claude-code")).toEqual(groups);
  });

  it("offers no Codex models under claude-code", () => {
    const ids = groupsForHarness(FALLBACK_MODEL_GROUPS, "claude-code")
      .flatMap((g) => g.models.map((m) => m.id));
    expect(ids).not.toContain("gpt-5.6-terra");
  });

  it("degrades an unknown/undefined harness to Claude Code, never to an empty picker", () => {
    // An empty picker is the worst outcome here: a user with a corrupted
    // localStorage value would have NOTHING to select and no way to see why.
    for (const bogus of [undefined, null, "", "cod3x", "CODEX", 7]) {
      const out = groupsForHarness(FALLBACK_MODEL_GROUPS, bogus);
      expect(out).toEqual(FALLBACK_MODEL_GROUPS);
      expect(out.length).toBeGreaterThan(0);
    }
  });

  it("never throws on a missing/invalid group list", () => {
    expect(groupsForHarness(undefined, "codex")).toEqual(CODEX_MODEL_GROUPS);
    expect(groupsForHarness(null, "claude-code")).toEqual([]);
  });
});

describe("groupsForHarness — codex", () => {
  const input = [...FALLBACK_MODEL_GROUPS, localGroup()];

  it("puts the Codex groups first, then OpenRouter, then local", () => {
    const out = groupsForHarness(input, "codex");
    expect(out.map((g) => g.label)).toEqual([
      ...CODEX_MODEL_GROUPS.map((g) => g.label),
      OPENROUTER_GROUP.label,
      "LM Studio",
    ]);
  });

  it("drops every Anthropic family group", () => {
    const labels = groupsForHarness(input, "codex").map((g) => g.label);
    for (const family of ["Opus", "Sonnet", "Haiku", "Fable"]) {
      expect(labels).not.toContain(family);
    }
  });

  it("keeps OpenRouter models selectable", () => {
    const out = groupsForHarness(input, "codex");
    const or = out.find((g) => g.provider === "openrouter");
    expect(or.models.every((m) => m.selectable !== false)).toBe(true);
    expect(or.models.every((m) => !m.unavailableReason)).toBe(true);
  });

  it("marks a MEASURED-unsupported local group unselectable with the reason", () => {
    const out = groupsForHarness(input, "codex");
    const local = out.find((g) => g.provider === "local");
    // VISIBLE, not omitted — omission is what "down" looks like, and this
    // engine is up and healthy; it just speaks a different wire protocol.
    expect(local).toBeTruthy();
    expect(local.note).toBe(CODEX_LOCAL_UNSUPPORTED_NOTE);
    for (const m of local.models) {
      expect(m.selectable).toBe(false);
      expect(m.unavailableReason).toBe(CODEX_LOCAL_UNSUPPORTED_NOTE);
    }
  });

  // The twin. Without it the case above passes on a build that narrows EVERY
  // local group, which is the bug this whole change exists to remove: Plexar
  // serves /v1/responses and codex drives it end to end.
  it("leaves a local group that DOES serve Responses fully selectable", () => {
    const out = groupsForHarness([...FALLBACK_MODEL_GROUPS, localGroup(true)], "codex");
    const local = out.find((g) => g.provider === "local");
    expect(local).toBeTruthy();
    expect(local.note).toBeUndefined();
    for (const m of local.models) expect(m.selectable).toBe(true);
  });

  it("leaves a local group of UNKNOWN protocol selectable — unknown is not false", () => {
    const out = groupsForHarness([...FALLBACK_MODEL_GROUPS, localGroup(null)], "codex");
    const local = out.find((g) => g.provider === "local");
    expect(local.note).toBeUndefined();
    for (const m of local.models) expect(m.selectable).toBe(true);
  });

  it("does not mutate the input groups or their model entries", () => {
    const local = localGroup();
    const groups = [...FALLBACK_MODEL_GROUPS, local];
    const snapshot = JSON.parse(JSON.stringify(groups));
    groupsForHarness(groups, "codex");
    expect(JSON.parse(JSON.stringify(groups))).toEqual(snapshot);
    // The catalog is shared state: marking a local model unselectable for
    // Codex must not leave it unselectable the moment the user switches back.
    expect(local.models[0].selectable).toBe(true);
    expect(groupsForHarness(groups, "claude-code")).toEqual(groups);
  });
});

describe("Codex catalog — retired ids are absent", () => {
  it("carries none of the ids retired 2026-08-31", () => {
    const everything = JSON.stringify([
      CODEX_MODEL_GROUPS,
      FALLBACK_MODEL_GROUPS,
      groupsForHarness(FALLBACK_MODEL_GROUPS, "codex"),
    ]);
    for (const retired of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"]) {
      // Substring, not id equality: "gpt-5.4-mini" would slip past an exact
      // match if it were ever nested in a label, and a retired id shown
      // anywhere is a spawn that 404s far from the click that chose it.
      expect(everything).not.toContain(`"${retired}"`);
    }
    const ids = CODEX_MODEL_GROUPS.flatMap((g) => g.models.map((m) => m.id));
    expect(ids).not.toContain("gpt-5.4");
    expect(ids).not.toContain("gpt-5.4-mini");
    expect(ids).not.toContain("gpt-5.3-codex");
    expect(ids).not.toContain("gpt-5.2");
    // "gpt-5.3-codex-spark" is a DIFFERENT, live model — the prefix check that
    // would delete it is the mistake this assertion guards against.
    expect(ids).toContain("gpt-5.3-codex-spark");
  });

  it("maps ids to harnesses and default models", () => {
    expect(getModelHarness("gpt-5.6-terra")).toBe("codex");
    expect(getModelHarness("sonnet")).toBe("claude-code");
    expect(getModelHarness("deepseek/deepseek-v4-pro")).toBe("any");
    // LOCAL DEPENDS ON THE ENGINE, and has been wrong in both directions.
    // It returned "any" while the backend refused the pair outright (a false
    // claim about the backend, corrected 2026-09-07 to a flat "claude-code"),
    // and that flat answer then became false itself once Plexar started
    // serving /v1/responses and codex drove it end to end. The answer is now
    // the MEASURED protocol, so this asserts all three verdicts.
    measureProvider("lmstudio-local", false);
    expect(getModelHarness("local:lmstudio-local:qwen3")).toBe("claude-code");
    measureProvider("lmstudio-local", true);
    expect(getModelHarness("local:lmstudio-local:qwen3")).toBe("any");
    // Unmeasured: unknown is NOT false, so the pairing stays offered.
    __resetLocalResponsesApi();
    expect(getModelHarness("local:lmstudio-local:qwen3")).toBe("any");
    expect(defaultModelForHarness("codex")).toBe("gpt-5.6-terra");
    // WAS "sonnet". That bare alias is exactly the id GET /api/models never
    // returns, which is how the pill came to render "Opus 5" for a Sonnet
    // session; the Claude Code fallback is now the REAL catalog id, and it is
    // the SAME constant as the fresh-install default (see
    // modelHonesty.test.jsx for the drift guard).
    expect(defaultModelForHarness("claude-code")).toBe(DEFAULT_MODEL_ID);
    expect(DEFAULT_MODEL_ID).toBe("claude-sonnet-5");
    expect(DEFAULT_HARNESS).toBe("claude-code");
  });
});

// ---------------------------------------------------------------------------
// 2. TopBar — the pill, the popover it narrows, the Fast toggle it disables
// ---------------------------------------------------------------------------

function renderTopBar({ model = "claude-opus-4-8", harness, fast = false } = {}) {
  const spies = {
    setModel: vi.fn(),
    setHarness: vi.fn(),
    setPermissionMode: vi.fn(),
    setEffort: vi.fn(),
    setFast: vi.fn(),
    setSidebarOpen: vi.fn(),
  };
  render(
    <ThemeProvider>
      <TopBar
        model={model}
        setModel={spies.setModel}
        {...(harness === undefined ? {} : { harness })}
        setHarness={spies.setHarness}
        permissionMode="default"
        setPermissionMode={spies.setPermissionMode}
        effort=""
        setEffort={spies.setEffort}
        fast={fast}
        setFast={spies.setFast}
        sidebarOpen={false}
        setSidebarOpen={spies.setSidebarOpen}
        user={{ name: "X" }}
      />
    </ThemeProvider>
  );
  return spies;
}

describe("TopBar — harness pill", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
  });

  it("defaults to Claude Code when no harness prop is supplied", () => {
    renderTopBar({ harness: undefined });
    expect(screen.getByRole("button", { name: /harness: claude code/i })).toBeInTheDocument();
  });

  it("renders immediately LEFT of the model pill", () => {
    renderTopBar({ harness: "claude-code", model: "claude-opus-4-8" });
    const harnessPill = screen.getByRole("button", { name: /harness:/i });
    const modelPill = screen.getByRole("button", { name: /^model:/i });
    // Node.DOCUMENT_POSITION_FOLLOWING === 4: the model pill comes after.
    expect(harnessPill.compareDocumentPosition(modelPill) & 4).toBeTruthy();
  });

  it("offers both harnesses and reports the click", () => {
    const spies = renderTopBar({ harness: "claude-code" });
    fireEvent.click(screen.getByRole("button", { name: /harness:/i }));
    for (const h of HARNESSES) {
      expect(screen.getByRole("option", { name: h.label })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("option", { name: "Codex" }));
    expect(spies.setHarness).toHaveBeenCalledWith("codex");
  });

  it("narrows the model popover to Codex + OpenRouter under Codex", () => {
    renderTopBar({ harness: "codex", model: "gpt-5.6-terra" });
    fireEvent.click(screen.getByRole("button", { name: /^model:/i }));
    expect(screen.getByRole("option", { name: /GPT-5.6 Terra/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Codex Spark/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /DeepSeek V4 Pro/ })).toBeInTheDocument();
    expect(screen.queryAllByRole("option", { name: /Opus 5/ })).toHaveLength(0);
    expect(screen.queryAllByRole("option", { name: /Haiku/ })).toHaveLength(0);
  });

  it("still offers the Anthropic families under Claude Code", () => {
    renderTopBar({ harness: "claude-code", model: "sonnet" });
    fireEvent.click(screen.getByRole("button", { name: /^model:/i }));
    // "Opus 5" and "Opus 5 (1M)" both match — getAllByRole, not getByRole.
    expect(screen.getAllByRole("option", { name: /Opus 5/ }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("option", { name: /GPT-5.6 Terra/ })).toBeNull();
  });

  it("renders a stale/foreign model id's OWN label on the pill, not the first filtered entry", () => {
    // A pill that silently reads "GPT-6 Astra" while the session would spawn on
    // Opus 5 is a different session than the one displayed — the label lookup
    // must stay against the FULL model list.
    renderTopBar({ harness: "codex", model: "claude-opus-5" });
    const pill = screen.getByRole("button", { name: /^model:/i });
    expect(pill.textContent).toMatch(/Opus 5/);
    expect(pill.textContent).not.toMatch(/GPT-6 Astra/);
  });
});

describe("TopBar — Fast toggle under Codex", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: async () => ({}) }));
  });

  it("is enabled for an Opus model under Claude Code (the watch-to-fail twin)", () => {
    const spies = renderTopBar({ harness: "claude-code", model: "claude-opus-4-8" });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(spies.setFast).toHaveBeenCalled();
  });

  it("is disabled under Codex even for an Opus id, with the Codex-specific title", () => {
    const spies = renderTopBar({ harness: "codex", model: "claude-opus-4-8" });
    const btn = screen.getByRole("button", { name: /fast mode/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "Not available for Codex");
    expect(btn).toHaveAccessibleName(/not available for codex/i);
    fireEvent.click(btn);
    expect(spies.setFast).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. App — the model reset on harness change
// ---------------------------------------------------------------------------

/** Replicates App.jsx's selectHarness callback verbatim, over the REAL
 *  getModelHarness / defaultModelForHarness. */
function HarnessSwitchHarness({ toast, initialModel }) {
  const [harness, setHarness] = useState("claude-code");
  const [model, setModel] = useState(initialModel);

  const selectHarness = useCallback(
    (next) => {
      setHarness(next);
      const owner = getModelHarness(model);
      if (owner === "any" || owner === next) return;
      const fallback = defaultModelForHarness(next);
      setModel(fallback);
      toast(`Model reset to ${fallback} — the previous model does not run on this harness`, "info");
    },
    [model, toast]
  );

  return (
    <div>
      <span data-testid="harness">{harness}</span>
      <span data-testid="model">{model}</span>
      <button onClick={() => selectHarness("codex")}>to-codex</button>
      <button onClick={() => selectHarness("claude-code")}>to-claude</button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2b. reconcileModelForHarness — the single arbiter, tested DIRECTLY
//
// Section 3 below tests a REPLICA of App's callback rather than App itself,
// which is precisely why the mount path went uncovered: the replica only ever
// exercised the harness click. These cases run the REAL exported function, so
// every caller (TopBar pill, New Session dialog, Inspector, mount restore) is
// covered by construction rather than one replica at a time.
// ---------------------------------------------------------------------------

describe("reconcileModelForHarness — the pair that 2.1.0 could not spawn", () => {
  it("resets a Claude model under Codex — the measured TopBar 'Codex · Opus 5'", () => {
    // The exact incoherent pair a 2.1.0 reload restored from two independent
    // localStorage keys. It POSTs `codex -m claude-opus-5`, which the CLI
    // accepts and then 400s on every turn.
    const out = reconcileModelForHarness("claude-opus-5", "codex");
    expect(out.changed).toBe(true);
    expect(out.model).toBe("gpt-5.6-terra");
  });

  it("resets a local model under Codex ONLY when the engine cannot serve it", () => {
    measureProvider("lmstudio-local", false);
    const out = reconcileModelForHarness("local:lmstudio-local:qwen3", "codex");
    expect(out.changed).toBe(true);
    expect(out.model).toBe("gpt-5.6-terra");
  });

  it("KEEPS a local model under Codex when the engine serves Responses", () => {
    // The twin. A reconciler that reset every local selection would pass the
    // case above while throwing away a pairing that demonstrably works.
    measureProvider("plexar-vllm", true);
    const out = reconcileModelForHarness("local:plexar-vllm:qwen3.8-27b", "codex");
    expect(out.changed).toBe(false);
    expect(out.model).toBe("local:plexar-vllm:qwen3.8-27b");
  });

  it("resets a Codex model under Claude Code", () => {
    const out = reconcileModelForHarness("gpt-6-astra", "claude-code");
    expect(out.changed).toBe(true);
    expect(out.model).toBe(DEFAULT_MODEL_ID);
  });

  // The watch-to-fail twins: a reconciler that reset everything would pass all
  // three cases above while destroying valid selections, so each has a partner
  // asserting it does NOT fire.
  it("leaves an OpenRouter model alone under EITHER harness", () => {
    for (const h of ["codex", "claude-code"]) {
      const out = reconcileModelForHarness("deepseek/deepseek-v4-pro", h);
      expect(out.changed).toBe(false);
      expect(out.model).toBe("deepseek/deepseek-v4-pro");
    }
  });

  it("leaves a matching pair alone, and reports the SAME shape when unchanged", () => {
    const codex = reconcileModelForHarness("gpt-6-astra", "codex");
    expect(codex).toEqual({ model: "gpt-6-astra", changed: false });
    const claude = reconcileModelForHarness("claude-opus-5", "claude-code");
    expect(claude).toEqual({ model: "claude-opus-5", changed: false });
  });

  it("is IDEMPOTENT — its own output never needs reconciling again", () => {
    // The reconciler runs in an effect keyed on [model, harness], so a fixed
    // value that still mismatched would setModel forever. This is the property
    // that makes that effect safe, not a restatement of the cases above.
    for (const [model, harness] of [
      ["claude-opus-5", "codex"],
      ["local:lmstudio-local:qwen3", "codex"],
      ["gpt-6-astra", "claude-code"],
    ]) {
      const once = reconcileModelForHarness(model, harness);
      const twice = reconcileModelForHarness(once.model, harness);
      expect(twice.changed).toBe(false);
      expect(twice.model).toBe(once.model);
    }
  });
});

// A mount restore is not a click, and no setter wrapper can see it. This is
// the path that produced the reported bug, so it gets a real render.
describe("App mount — an incoherent restored pair self-corrects", () => {
  function MountHarness({ storedModel, storedHarness, toast }) {
    const [harness] = useState(storedHarness);
    const [model, setModel] = useState(storedModel);
    useEffect(() => {
      const { model: fixed, changed } = reconcileModelForHarness(model, harness);
      if (!changed) return;
      setModel(fixed);
      toast(`Model reset to ${fixed} — the previous model does not run on this harness`, "info");
    }, [model, harness, toast]);
    return <span data-testid="model">{model}</span>;
  }

  it("corrects harness=codex + model=claude-opus-5 restored from localStorage", () => {
    const toast = vi.fn();
    render(<MountHarness storedModel="claude-opus-5" storedHarness="codex" toast={toast} />);
    expect(screen.getByTestId("model")).toHaveTextContent("gpt-5.6-terra");
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire for a coherent restored pair", () => {
    const toast = vi.fn();
    render(<MountHarness storedModel="gpt-6-astra" storedHarness="codex" toast={toast} />);
    expect(screen.getByTestId("model")).toHaveTextContent("gpt-6-astra");
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("App — switching harness only resets a model that cannot run there", () => {
  it("resets sonnet to gpt-5.6-terra and toasts when switching to Codex", () => {
    const toast = vi.fn();
    render(<HarnessSwitchHarness toast={toast} initialModel="sonnet" />);
    act(() => { fireEvent.click(screen.getByText("to-codex")); });
    expect(screen.getByTestId("harness")).toHaveTextContent("codex");
    expect(screen.getByTestId("model")).toHaveTextContent("gpt-5.6-terra");
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("gpt-5.6-terra"),
      "info"
    );
  });

  it("leaves an OpenRouter model alone and does NOT toast", () => {
    // OpenRouter is reachable from both CLIs, so a reset here would stomp a
    // selection that was still perfectly valid — and the toast would explain a
    // change that did not happen.
    const toast = vi.fn();
    render(<HarnessSwitchHarness toast={toast} initialModel="deepseek/deepseek-v4-pro" />);
    act(() => { fireEvent.click(screen.getByText("to-codex")); });
    expect(screen.getByTestId("harness")).toHaveTextContent("codex");
    expect(screen.getByTestId("model")).toHaveTextContent("deepseek/deepseek-v4-pro");
    expect(toast).not.toHaveBeenCalled();
  });

  it("resets a Codex model back to sonnet when switching to Claude Code", () => {
    const toast = vi.fn();
    render(<HarnessSwitchHarness toast={toast} initialModel="gpt-5.6-terra" />);
    act(() => { fireEvent.click(screen.getByText("to-claude")); });
    expect(screen.getByTestId("model")).toHaveTextContent("sonnet");
    expect(toast).toHaveBeenCalledTimes(1);
  });
});
