/**
 * SessionDefaultsSettings — Settings ▸ Defaults & models.
 *
 * The contract under test:
 *   - each control writes its correct dotted path under sessions.*
 *   - the model list comes from the SHARED source (TopBar's MODELS re-export of
 *     modelCatalog), asserted by picking a real entry OUT OF MODELS rather than
 *     a fixture — a hardcoded fixture would still pass if the page grew its own
 *     parallel list, which is the exact drift being guarded against
 *   - the "new sessions only" note is present (and points at the Inspector)
 *   - the "not read yet" note is present, so no stored default is implied to be
 *     in force
 *   - fast mode is not offered as live for a model it cannot apply to
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { MODELS, MODEL_GROUPS } from "../components/TopBar.jsx";
// The vocabularies come from the plain module, which is where they are DEFINED
// (TopBar only re-exports them). Asserting against the definition means a test
// cannot pass on a stale re-export.
import { PERMISSION_MODES, EFFORT_OPTIONS } from "../sessionVocabulary";
import { OPENROUTER_GROUP, ModelCatalogContext } from "../modelCatalog";
import SessionDefaultsSettings, {
  buildModelSelectGroups,
} from "../components/settings/SessionDefaultsSettings.jsx";

/** A minimal stand-in for the Settings shell's draft store. */
function makeShell({ draft = {}, dirtyPaths = [] } = {}) {
  return {
    get: (path, fallback) => (path in draft ? draft[path] : fallback),
    setField: vi.fn(),
    isDirty: (path) => dirtyPaths.some((p) => p === path || p.startsWith(`${path}.`)),
  };
}

function renderPage(shell, catalog) {
  const view = catalog ? (
    <ModelCatalogContext.Provider value={catalog}>
      <SessionDefaultsSettings {...shell} />
    </ModelCatalogContext.Provider>
  ) : (
    <SessionDefaultsSettings {...shell} />
  );
  return render(view);
}

describe("SessionDefaultsSettings — paths", () => {
  it("writes the model to sessions.model", () => {
    const shell = makeShell();
    renderPage(shell);
    // A real id from the shared list, not an invented one.
    const target = MODELS.find((m) => m.id.startsWith("claude-sonnet"));
    expect(target).toBeTruthy();
    fireEvent.change(screen.getByTestId("field-sessions.model"), {
      target: { value: target.id },
    });
    expect(shell.setField).toHaveBeenCalledWith("sessions.model", target.id);
  });

  it("writes the permission mode to sessions.permission_mode", () => {
    const shell = makeShell();
    renderPage(shell);
    fireEvent.change(screen.getByTestId("field-sessions.permission_mode"), {
      target: { value: "plan" },
    });
    expect(shell.setField).toHaveBeenCalledWith("sessions.permission_mode", "plan");
  });

  it("writes the effort to sessions.effort", () => {
    const shell = makeShell();
    renderPage(shell);
    fireEvent.change(screen.getByTestId("field-sessions.effort"), {
      target: { value: "xhigh" },
    });
    expect(shell.setField).toHaveBeenCalledWith("sessions.effort", "xhigh");
  });

  it("writes fast mode to sessions.fast when the model is Opus", () => {
    const opus = MODELS.find((m) => m.id.includes("opus"));
    expect(opus).toBeTruthy();
    const shell = makeShell({ draft: { "sessions.model": opus.id } });
    renderPage(shell);
    fireEvent.click(screen.getByLabelText("Fast mode: On"));
    expect(shell.setField).toHaveBeenCalledWith("sessions.fast", true);
  });

  it("renders every option from the SHARED permission and effort vocabularies", () => {
    renderPage(makeShell());
    const permission = screen.getByTestId("field-sessions.permission_mode");
    const offeredPermission = [...permission.querySelectorAll("option")].map((o) => o.value);
    // Asserted against TopBar's export, not a fixture: a fixture would still
    // pass if this page grew its own copy, which is the drift being guarded.
    for (const p of PERMISSION_MODES) expect(offeredPermission).toContain(p.id);

    const effort = screen.getByTestId("field-sessions.effort");
    const offeredEffort = [...effort.querySelectorAll("option")].map((o) => o.value);
    expect(offeredEffort).toEqual(EFFORT_OPTIONS.map((e) => e.id));
  });

  it("keeps Auto's empty-string value through the shared export", () => {
    // Auto MUST be "" — pty_manager._ALLOWED_EFFORT_LEVELS raises on any other
    // spelling of 'let the model decide'.
    expect(EFFORT_OPTIONS[0]).toEqual({ id: "", label: "Auto" });
    renderPage(makeShell());
    const auto = [...screen.getByTestId("field-sessions.effort").querySelectorAll("option")].find(
      (o) => o.textContent === "Auto"
    );
    expect(auto.value).toBe("");
  });
});

/**
 * The de-duplication itself. TopBar.jsx is the single source; this asserts the
 * shape and content of that source so a "tidy-up" of the ids (which are the wire
 * values the CLI receives) fails loudly, and that the Inspector's effort list is
 * derived from it rather than forked.
 */
describe("shared session vocabularies (TopBar is the single source)", () => {
  it("exports the four permission modes the CLI accepts", () => {
    expect(PERMISSION_MODES.map((p) => p.id)).toEqual([
      "default", "plan", "acceptEdits", "bypassPermissions",
    ]);
  });

  it("exports the six effort levels pty_manager allows, Auto first as \"\"", () => {
    expect(EFFORT_OPTIONS.map((e) => e.id)).toEqual([
      "", "low", "medium", "high", "xhigh", "max",
    ]);
    expect(EFFORT_OPTIONS.map((e) => e.label)).toEqual([
      "Auto", "Low", "Medium", "High", "XHigh", "Max",
    ]);
  });
});

describe("SessionDefaultsSettings — the model list is the pill's list", () => {
  it("offers every id from the shared MODELS export", () => {
    renderPage(makeShell());
    const select = screen.getByTestId("field-sessions.model");
    const offered = new Set([...select.querySelectorAll("option")].map((o) => o.value));
    // Asserted against the shared source, so growing a parallel list here fails.
    for (const m of MODELS) expect(offered.has(m.id)).toBe(true);
  });

  it("keeps the pill's grouping and marks the OpenRouter group", () => {
    renderPage(makeShell());
    const select = screen.getByTestId("field-sessions.model");
    const labels = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    // Family groups come straight from MODEL_GROUPS.
    for (const g of MODEL_GROUPS) {
      expect(labels.some((l) => l.startsWith(g.label))).toBe(true);
    }
    expect(labels).toContain(`${OPENROUTER_GROUP.label} · OpenRouter`);
  });

  it("marks a local-provider group as local", () => {
    const groups = buildModelSelectGroups([
      { label: "LM Studio", models: [{ id: "local:lmstudio-local:qwen", label: "Qwen" }] },
    ]);
    expect(groups[0].label).toBe("LM Studio · local");
  });

  it("uses a live catalog when the app supplies one", () => {
    const catalog = {
      source: "live",
      groups: [{ label: "Fresh", models: [{ id: "claude-fresh-9", label: "Fresh 9" }] }],
      models: [{ id: "claude-fresh-9", label: "Fresh 9" }],
    };
    renderPage(makeShell(), catalog);
    const select = screen.getByTestId("field-sessions.model");
    const offered = [...select.querySelectorAll("option")].map((o) => o.value);
    expect(offered).toContain("claude-fresh-9");
  });

  it("keeps an unrecognised stored model rather than dropping it", () => {
    const shell = makeShell({ draft: { "sessions.model": "local:ghost:some-model" } });
    renderPage(shell);
    expect(screen.getByTestId("unknown-model")).toBeInTheDocument();
    expect(shell.setField).not.toHaveBeenCalled();
  });
});

describe("SessionDefaultsSettings — honesty", () => {
  it("says these are defaults for NEW sessions and points at the Inspector", () => {
    renderPage(makeShell());
    const note = screen.getByTestId("new-sessions-only");
    expect(note).toHaveAttribute("role", "note");
    expect(note.textContent).toMatch(/new sessions only/i);
    expect(note.textContent).toMatch(/Inspector/);
  });

  it("says the stored defaults are not in force yet", () => {
    renderPage(makeShell());
    const note = screen.getByTestId("not-read-sessions");
    expect(note).toHaveAttribute("role", "note");
    expect(note.textContent).toMatch(/not in force yet/i);
    expect(note.textContent).toMatch(/DEFAULTS pill/);
  });

  it("does not offer fast mode as live for a non-Opus model", () => {
    const sonnet = MODELS.find((m) => m.id.startsWith("claude-sonnet"));
    renderPage(makeShell({ draft: { "sessions.model": sonnet.id } }));
    expect(screen.getByLabelText("Fast mode: On")).toBeDisabled();
    expect(screen.getByTestId("fast-ineligible").textContent).toMatch(/Opus models only/i);
  });

  it("does not offer fast mode for an OpenRouter model", () => {
    const or = OPENROUTER_GROUP.models[0].id;
    renderPage(makeShell({ draft: { "sessions.model": or } }));
    expect(screen.getByLabelText("Fast mode: On")).toBeDisabled();
  });

  it("marks dirty fields", () => {
    renderPage(makeShell({ dirtyPaths: ["sessions.effort"] }));
    expect(screen.getByTestId("field-sessions.effort")).toHaveAttribute("data-dirty", "true");
    expect(screen.getByTestId("field-sessions.model")).toHaveAttribute("data-dirty", "false");
  });
});
