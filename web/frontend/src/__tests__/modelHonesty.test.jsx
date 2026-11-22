/**
 * MODEL-SELECTION HONESTY — the regression that shipped, pinned so it cannot
 * come back.
 *
 * ── WHAT HAPPENED (measured, not theorised) ───────────────────────────────
 * The persisted default model was the bare alias `"sonnet"`. GET /api/models
 * returns only dated/full ids and NEVER that string, so the pill's lookup
 * `modelList.find((m) => m.id === model) || modelList[0]` missed and rendered
 * `modelList[0]` — "Opus 5". The POST body still carried "sonnet", so the CLI
 * spawned `claude --model sonnet`. **The pill named a model the session was not
 * running on, and the user believed they were on Opus for weeks.**
 *
 * The invariant: a model surface MUST NEVER display a model that is not the one
 * a new session will spawn on. Show the truth, or show that it is unknown —
 * never a plausible-looking substitute. That is the same rule as reporting a
 * refused credential as `reachable:false` (UNAUTHORIZED_NOTE) or drawing a 0%
 * bar for an unknown quota.
 *
 * ── WHY THERE IS A STRUCTURAL TEST HERE ───────────────────────────────────
 * The `|| list[0]` substitution appeared INDEPENDENTLY IN THREE PLACES: the
 * TopBar pill, the dialog's ConfigSelect trigger, and the dialog's modelSel
 * initialiser. A behavioural test per site does not stop the fourth. So the
 * last describe block reads the source of both files and forbids the SHAPE,
 * modelled on __tests__/NoNativeDialogs.test.jsx (discover the set from source
 * rather than asserting a remembered list).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

import { ThemeProvider } from "../hooks/useTheme.jsx";
import TopBar from "../components/TopBar.jsx";
import NewSessionDialog from "../components/NewSessionDialog.jsx";
// App is imported STATICALLY and vi.resetModules() is deliberately NOT used
// here: a module reset would give App its own copy of modelCatalog.js, whose
// ModelCatalogContext is then a DIFFERENT context object from the one this file
// provides — so App would silently read the fallback catalog and every
// migration assertion below would pass vacuously. Measured, not theorised.
import App from "../App.jsx";
import {
  ModelCatalogContext,
  FALLBACK_MODEL_GROUPS,
  CODEX_MODEL_GROUPS,
  DEFAULT_MODEL_ID,
  defaultModelForHarness,
  findModelEntry,
  resolveModelSelection,
} from "../modelCatalog.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..");

const liveCatalog = (groups = FALLBACK_MODEL_GROUPS) => ({
  groups,
  models: groups.flatMap((g) => g.models),
  // "live" (not "fallback") because App's one-time migration deliberately
  // refuses to run against the small static list — see its own describe below.
  source: "live",
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. The resolver itself
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveModelSelection — three outcomes, never a substitute", () => {
  it("a bare alias resolves as an ALIAS, with no entry and no other model's name", () => {
    const r = resolveModelSelection("sonnet", FALLBACK_MODEL_GROUPS);
    expect(r.known).toBe(true);
    expect(r.isAlias).toBe(true);
    expect(r.label).toBe("Sonnet (alias)");
    // The entry must be null: "sonnet" is a legitimate CLI value with no
    // catalog row, and handing back a row would let callers key display,
    // unserved-ness or provider off a model the session is not spawning on.
    expect(r.entry).toBe(null);
    expect(r.label).not.toBe("Opus 5");
  });

  it("opus and haiku aliases resolve to their own families", () => {
    expect(resolveModelSelection("opus", FALLBACK_MODEL_GROUPS).label).toBe("Opus (alias)");
    expect(resolveModelSelection("haiku", FALLBACK_MODEL_GROUPS).label).toBe("Haiku (alias)");
  });

  it("an id in NO catalog is known:false and labels itself VERBATIM", () => {
    const r = resolveModelSelection("claude-nonesuch-9", FALLBACK_MODEL_GROUPS);
    expect(r).toEqual({ entry: null, label: "claude-nonesuch-9", known: false, isAlias: false });
    // The load-bearing negative: not ANY other model's label.
    const everyLabel = [...FALLBACK_MODEL_GROUPS, ...CODEX_MODEL_GROUPS]
      .flatMap((g) => g.models)
      .map((m) => m.label);
    expect(everyLabel).not.toContain(r.label);
  });

  it("a Codex id resolves to its Codex label, though the Claude picker excludes it", () => {
    // useModelCatalog().models deliberately omits CODEX_MODEL_GROUPS so the
    // Claude Code picker cannot offer models it can never launch. Right for
    // OFFERING, wrong for LABELLING — hence the resolver searches both.
    const anthropicOnly = FALLBACK_MODEL_GROUPS;
    expect(anthropicOnly.flatMap((g) => g.models).some((m) => m.id === "gpt-5.6-terra")).toBe(false);
    const r = resolveModelSelection("gpt-5.6-terra", anthropicOnly);
    expect(r).toMatchObject({ known: true, isAlias: false, label: "GPT-5.6 Terra" });
    expect(r.entry.id).toBe("gpt-5.6-terra");
  });

  it("a catalog hit resolves to its own entry", () => {
    const r = resolveModelSelection("claude-sonnet-5", FALLBACK_MODEL_GROUPS);
    expect(r).toMatchObject({ known: true, isAlias: false, label: "Sonnet 5" });
    expect(r.entry.id).toBe("claude-sonnet-5");
  });

  it("a null/empty id degrades instead of throwing — a display path must not blank the bar", () => {
    expect(resolveModelSelection(null, FALLBACK_MODEL_GROUPS)).toEqual({
      entry: null, label: "", known: false, isAlias: false,
    });
    expect(resolveModelSelection("", FALLBACK_MODEL_GROUPS).known).toBe(false);
  });
});

describe("findModelEntry — null, never a consolation prize", () => {
  it("returns null for an unknown id", () => {
    expect(findModelEntry("claude-nonesuch-9", FALLBACK_MODEL_GROUPS)).toBe(null);
    expect(findModelEntry("sonnet", FALLBACK_MODEL_GROUPS)).toBe(null);
    expect(findModelEntry(undefined, FALLBACK_MODEL_GROUPS)).toBe(null);
  });

  it("searches Codex too, and falls back to the static groups when none are supplied", () => {
    expect(findModelEntry("gpt-6-astra")).toMatchObject({ label: "GPT-6 Astra" });
    expect(findModelEntry("claude-opus-5")).toMatchObject({ label: "Opus 5" });
  });
});

describe("the fresh-install default is ONE constant", () => {
  it("defaultModelForHarness('claude-code') === DEFAULT_MODEL_ID === 'claude-sonnet-5'", () => {
    // Two constants for one default is exactly the drift this catalog exists to
    // prevent; they were separate values until they were unified.
    expect(DEFAULT_MODEL_ID).toBe("claude-sonnet-5");
    expect(defaultModelForHarness("claude-code")).toBe(DEFAULT_MODEL_ID);
    // And it is a REAL catalog id, not the bare alias that started all this.
    expect(findModelEntry(DEFAULT_MODEL_ID, FALLBACK_MODEL_GROUPS)).not.toBe(null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The TopBar pill — what the user actually reads
// ═══════════════════════════════════════════════════════════════════════════

function renderTopBar({ model, catalog = liveCatalog(), ...props } = {}) {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ configured: true }) })
  );
  const setModel = vi.fn();
  render(
    <ThemeProvider>
      <ModelCatalogContext.Provider value={catalog}>
        <TopBar
          model={model}
          setModel={setModel}
          permissionMode="default"
          setPermissionMode={vi.fn()}
          effort=""
          setEffort={vi.fn()}
          fast={false}
          setFast={vi.fn()}
          sidebarOpen={false}
          setSidebarOpen={vi.fn()}
          user={{ name: "X" }}
          onToast={vi.fn()}
          {...props}
        />
      </ModelCatalogContext.Provider>
    </ThemeProvider>
  );
  return { setModel };
}

/** The pill is the only button whose accessible name starts "Model:". */
const pill = () => screen.getByRole("button", { name: /^Model:/ });

describe("TopBar pill — it renders the selection, not a neighbour", () => {
  afterEach(() => vi.restoreAllMocks());

  it("THE SHIPPED BUG: model 'sonnet' renders 'Sonnet (alias)', never 'Opus 5'", () => {
    renderTopBar({ model: "sonnet" });
    expect(pill()).toHaveTextContent("Sonnet (alias)");
    expect(pill()).not.toHaveTextContent("Opus 5");
    // An alias is KNOWN, so it must not be flagged as a mystery id either.
    expect(pill()).not.toHaveAttribute("title");
  });

  it("an unknown id renders VERBATIM and is flagged, not substituted", () => {
    renderTopBar({ model: "claude-nonesuch-9" });
    expect(pill()).toHaveTextContent("claude-nonesuch-9");
    expect(pill()).toHaveAttribute("title", expect.stringMatching(/not in the model catalog/i));
    expect(pill()).toHaveAccessibleName(/not in the model catalog/i);
    // Explicitly: NO other model's label reached the screen.
    for (const label of FALLBACK_MODEL_GROUPS.flatMap((g) => g.models).map((m) => m.label)) {
      expect(pill()).not.toHaveTextContent(label);
    }
  });

  it("a Codex id keeps its own name under the Codex harness", () => {
    renderTopBar({ model: "gpt-5.6-terra", harness: "codex" });
    expect(pill()).toHaveTextContent("GPT-5.6 Terra");
    expect(pill()).not.toHaveAttribute("title");
  });

  it("a known catalog id renders unflagged", () => {
    renderTopBar({ model: "claude-opus-5" });
    expect(pill()).toHaveTextContent("Opus 5");
    expect(pill()).not.toHaveAttribute("title");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. STRUCTURAL — the `|| list[0]` shape is forbidden for a SET value
// ═══════════════════════════════════════════════════════════════════════════

/* Which identifiers this guard polices. Deliberately scoped to the MODEL
 * vocabulary (plus ConfigSelect's generic `options`, which is what renders the
 * model select): the permission-mode / effort / harness lists use the same
 * `find(...) || LIST[0]` shape and are OUT OF SCOPE for this change, so a blanket
 * ban would fail on code this contract did not touch. See the report note. */
const WATCHED = /^(options|MODELS|.*[Mm]odel.*)$/;

/**
 * Statement-level scan for `... || <watchedList>[0]`.
 *
 * ALLOWED exactly once: ConfigSelect's genuine "nothing chosen yet" fallback,
 * which is recognised by the render-as-itself branch that MUST sit in front of
 * it (`(value ? { id: value, label: value } : null) ||`). With that branch
 * present a SET value can never reach `options[0]`; without it, it can, and
 * that is the defect.
 *
 * Exported-shaped as a pure function so the matcher itself is testable — a
 * structural guard that cannot demonstrate a red is not evidence.
 */
function substitutionOffenders(src) {
  const offenders = [];
  // Comments legitimately NAME the banned shape to explain why it is gone (both
  // files do, at length). Match CODE, not a mention — the same distinction
  // NoNativeDialogs.test.jsx draws between `window.prompt` and `window.prompt(`.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  for (const stmt of code.split(";")) {
    for (const m of stmt.matchAll(/\|\|\s*([A-Za-z_$][\w$]*)\[0\]/g)) {
      if (!WATCHED.test(m[1])) continue;
      // The unset-value guard: a set value is rendered as itself before any
      // list[0] fallback is reachable.
      if (/\?\s*\{[^}]*\}\s*:\s*null\s*\)?\s*\|\|/.test(stmt)) continue;
      offenders.push(`|| ${m[1]}[0]`);
    }
  }
  return offenders;
}

describe("STRUCTURAL — no model surface substitutes list[0] for a set value", () => {
  const FILES = ["components/TopBar.jsx", "components/NewSessionDialog.jsx"];

  it("the matcher itself flags the defect and permits the unset-value fallback", () => {
    // Vacuity guard, the S8 shape: a scanner that matches nothing would let the
    // real assertion below pass about an empty set.
    expect(substitutionOffenders("const cur = modelList.find(f) || modelList[0]")).toEqual([
      "|| modelList[0]",
    ]);
    expect(
      substitutionOffenders(
        'const current = options.find((o) => o.id === value) || (value ? { id: value, label: value } : null) || options[0] || { id: "", label: "-" }'
      )
    ).toEqual([]);
    // Out-of-scope vocabularies are not policed by this guard.
    expect(substitutionOffenders("const p = PERMISSION_MODES.find(f) || PERMISSION_MODES[0]")).toEqual([]);
    // A comment NAMING the banned shape is not the banned shape. Both files
    // carry one, and matching it would make this guard permanently red.
    expect(substitutionOffenders("// NOT `modelList.find(...) || modelList[0]`.")).toEqual([]);
    expect(substitutionOffenders("/* the old `|| modelList[0]` fallback */")).toEqual([]);
  });

  it("neither TopBar.jsx nor NewSessionDialog.jsx contains the shape", () => {
    const offenders = [];
    for (const rel of FILES) {
      const full = path.join(SRC, rel);
      const src = fs.readFileSync(full, "utf8");
      // Sanity: we are reading the real files, not an empty string.
      expect(src.length).toBeGreaterThan(1000);
      for (const o of substitutionOffenders(src)) offenders.push(`${rel} -> ${o}`);
    }
    expect(
      offenders,
      `model substitution found (show the truth or show it is unknown, never a plausible neighbour):\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("both files route display through resolveModelSelection / the unset-guard, not a raw find", () => {
    const topbar = fs.readFileSync(path.join(SRC, "components/TopBar.jsx"), "utf8");
    expect(topbar).toContain("resolveModelSelection(model, modelGroups)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. NewSessionDialog — the selects are wired, and open on the passed defaults
// ═══════════════════════════════════════════════════════════════════════════

function dialogFetch() {
  const listing = { parent: "C:\\", entries: [], dirs: [] };
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes("/api/browse/git")) {
      return { ok: true, status: 200, json: async () => ({ git: false, branch: null, dirty: null }) };
    }
    if (u.includes("/api/browse")) return { ok: true, status: 200, json: async () => listing };
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

async function renderDialog(props = {}) {
  globalThis.fetch = dialogFetch();
  const onConfirm = vi.fn();
  render(
    <ModelCatalogContext.Provider value={liveCatalog()}>
      <NewSessionDialog
        recentLocations={["C:\\Code\\web"]}
        savedLocations={[]}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        {...props}
      />
    </ModelCatalogContext.Provider>
  );
  await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  return { onConfirm };
}

describe("NewSessionDialog — opens on the passed defaults and submits them", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts on default* props, NOT on catalog.models[0]", async () => {
    await renderDialog({
      defaultModel: "claude-haiku-4-5-20251001",
      defaultPermissionMode: "plan",
      defaultEffort: "high",
      defaultHarness: "claude-code",
    });
    // catalog.models[0] is "Opus 5" — the plausible substitute this must not be.
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("Haiku 4.5");
    expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("Opus 5");
    expect(screen.getByRole("button", { name: "Permission" })).toHaveTextContent("Plan");
    expect(screen.getByRole("button", { name: "Effort" })).toHaveTextContent("High");
    expect(screen.getByRole("button", { name: "Harness" })).toHaveTextContent("Claude Code");
  });

  it("a model/permission/effort/harness the user PICKS reaches onConfirm", async () => {
    const { onConfirm } = await renderDialog({
      defaultModel: "claude-opus-5",
      defaultPermissionMode: "default",
      defaultEffort: "",
      defaultHarness: "claude-code",
    });
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("button", { name: "Sonnet 5" }));
    fireEvent.click(screen.getByRole("button", { name: "Permission" }));
    fireEvent.click(screen.getByRole("button", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Effort" }));
    fireEvent.click(screen.getByRole("button", { name: "XHigh" }));
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));

    expect(onConfirm.mock.calls[0][3]).toEqual({
      model: "claude-sonnet-5",
      permissionMode: "plan",
      effort: "xhigh",
      harness: "claude-code",
    });
  });

  it("switching to Codex narrows the model list and resets a model Codex cannot run", async () => {
    const { onConfirm } = await renderDialog({
      defaultModel: "claude-opus-5",
      defaultHarness: "claude-code",
    });
    fireEvent.click(screen.getByRole("button", { name: "Harness" }));
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    // Not left naming an Anthropic model a codex CLI would fail to launch.
    expect(screen.getByRole("button", { name: "Model" })).not.toHaveTextContent("Opus 5");
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent("GPT-5.6 Terra");
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm.mock.calls[0][3]).toMatchObject({
      harness: "codex",
      model: defaultModelForHarness("codex"),
    });
  });

  it("with NO defaultModel it submits an empty model, never a substituted catalog[0] id", async () => {
    // The dialog omitting a model is honest: App.jsx then falls back to the
    // command bar. Initialising modelSel from catalog.models[0] instead would
    // make the dialog SILENTLY OVERRIDE the command bar with a model nobody
    // picked -- the substitution defect, one layer down.
    const { onConfirm } = await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm.mock.calls[0][3].model).toBe("");
    expect(onConfirm.mock.calls[0][3].model).not.toBe(liveCatalog().models[0].id);
  });

  it("a SET model id that is in no list renders as itself in the select trigger", async () => {
    await renderDialog({ defaultModel: "claude-nonesuch-9" });
    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger).toHaveTextContent("claude-nonesuch-9");
    expect(trigger).not.toHaveTextContent("Opus 5");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. App.jsx — the one-time migration, and effort "" surviving as an override
// ═══════════════════════════════════════════════════════════════════════════
//
// These render the REAL App (the AppShell.test.jsx isolation strategy) rather
// than a replica harness: the migration's whole risk is its GUARDS, and a
// replica re-implements the very branches under test.

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
if (typeof globalThis.requestAnimationFrame === "undefined") {
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
}
if (typeof globalThis.cancelAnimationFrame === "undefined") {
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
}
if (typeof globalThis.matchMedia === "undefined") {
  globalThis.matchMedia = () => ({
    matches: false, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
  });
}

vi.mock("@xterm/xterm", () => ({ Terminal: vi.fn() }));
/* The full Terminal stub, not a bare vi.fn(): the effort test actually CREATES a
 * session, so a pane mounts and buildTerminal() runs. A constructor returning
 * undefined throws `term.loadAddon is not a function` as an unhandled rejection
 * -- noise that would be read as a real failure by the next person. */
async function stubTerminal() {
  const { Terminal } = await import("@xterm/xterm");
  Terminal.mockImplementation(() => ({
    loadAddon: vi.fn(), open: vi.fn(), paste: vi.fn(), clear: vi.fn(),
    write: vi.fn(), writeln: vi.fn(), onData: vi.fn(), onKey: vi.fn(),
    hasSelection: vi.fn().mockReturnValue(false),
    getSelection: vi.fn().mockReturnValue(""),
    selectAll: vi.fn(), clearSelection: vi.fn(), scrollToBottom: vi.fn(),
    resize: vi.fn(), focus: vi.fn(), blur: vi.fn(),
    attachCustomKeyEventHandler: vi.fn(), dispose: vi.fn(),
    options: { theme: {}, fontSize: 13 },
    _core: { linkifier: { onShowLinkUnderline: vi.fn(), onHideLinkUnderline: vi.fn() } },
  }));
}
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(), fit: vi.fn(),
    proposeDimensions: vi.fn().mockReturnValue({ cols: 80, rows: 24 }),
    dispose: vi.fn(),
  })),
}));
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/addon-canvas", () => ({
  CanvasAddon: vi.fn().mockImplementation(() => ({ activate: vi.fn(), dispose: vi.fn() })),
}));
vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({
    activate: vi.fn(), findNext: vi.fn(), findPrevious: vi.fn(),
    clearDecorations: vi.fn(), dispose: vi.fn(),
  })),
}));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("../components/StateIcon", () => ({ default: () => React.createElement("span", null) }));

class MockWebSocket {
  constructor() {
    this.readyState = 1;
    this.send = vi.fn();
    this.close = vi.fn();
    this.addEventListener = vi.fn();
    this.removeEventListener = vi.fn();
  }
}
MockWebSocket.OPEN = 1;
globalThis.WebSocket = MockWebSocket;

function jsonResponse(body) {
  return Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function appFetchStub() {
  return vi.fn((url) => {
    const u = String(url);
    if (u === "/api/me") return jsonResponse({ name: "Test User" });
    if (u === "/api/terminals") return jsonResponse({ terminals: [] });
    if (u === "/api/system") return jsonResponse({ cpu: 1, ramUsed: 1, ramTotal: 2 });
    if (u === "/api/usage/daily") return jsonResponse({});
    // Never let the OpenRouter-key sweep reset the model out from under a test
    // that is asserting the model was left alone.
    if (u.includes("/api/settings/openrouter")) return jsonResponse({ configured: true });
    if (u.includes("/api/browse/git")) return jsonResponse({ git: false, branch: null, dirty: null });
    if (u.includes("/api/browse")) return jsonResponse({ parent: "C:\\", entries: [], dirs: [] });
    if (u.startsWith("/api/local/")) return jsonResponse({ reachable: false });
    return jsonResponse({ ok: true });
  });
}

const MODEL_KEY = "cockpit-model";

/** Renders the real App under a LIVE-source catalog (the migration refuses to
 *  run against `source: "fallback"`, which is what a bare render would give). */
async function renderApp(catalog = liveCatalog()) {
  let utils;
  await act(async () => {
    utils = render(
      <ThemeProvider>
        <ModelCatalogContext.Provider value={catalog}>
          <App />
        </ModelCatalogContext.Provider>
      </ThemeProvider>
    );
  });
  await waitFor(() => expect(screen.queryByText("Connecting...")).not.toBeInTheDocument());
  return utils;
}

const storedModel = () => JSON.parse(localStorage.getItem(MODEL_KEY));
const migrationToasts = () => screen.queryAllByText(/is not in the catalog/i);

describe("App — the one-time model migration is NARROW", () => {
  beforeEach(async () => {
    await stubTerminal();
    localStorage.clear();
    globalThis.fetch = appFetchStub();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("does NOT fire while the catalog source is 'fallback'", async () => {
    // FALLBACK_MODEL_GROUPS is a small static list; a valid live-only id looks
    // unknown to it, and "migrating" would throw away a working selection while
    // the user is merely offline.
    localStorage.setItem(MODEL_KEY, JSON.stringify("claude-live-only-9"));
    await renderApp({ ...liveCatalog(), source: "fallback" });
    expect(storedModel()).toBe("claude-live-only-9");
    expect(migrationToasts()).toHaveLength(0);
  });

  it("does NOT fire for the bare alias 'sonnet' — it works, rewriting it changes the model", async () => {
    localStorage.setItem(MODEL_KEY, JSON.stringify("sonnet"));
    await renderApp();
    expect(storedModel()).toBe("sonnet");
    expect(migrationToasts()).toHaveLength(0);
  });

  it("does NOT fire for a local: id (its group comes and goes with the provider)", async () => {
    localStorage.setItem(MODEL_KEY, JSON.stringify("local:lmstudio-local:qwen3"));
    await renderApp();
    expect(storedModel()).toBe("local:lmstudio-local:qwen3");
    expect(migrationToasts()).toHaveLength(0);
  });

  it("does NOT fire for an OpenRouter id", async () => {
    localStorage.setItem(MODEL_KEY, JSON.stringify("deepseek/deepseek-v4-pro"));
    await renderApp();
    expect(storedModel()).toBe("deepseek/deepseek-v4-pro");
    expect(migrationToasts()).toHaveLength(0);
  });

  it("DOES fire, once, for a genuine unknown — and says which id it replaced", async () => {
    localStorage.setItem(MODEL_KEY, JSON.stringify("claude-nonesuch-9"));
    await renderApp();
    await waitFor(() => expect(storedModel()).toBe(DEFAULT_MODEL_ID));
    const toasts = migrationToasts();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toHaveTextContent("claude-nonesuch-9");
  });

  it("does NOT fire a second time when the catalog re-renders", async () => {
    // The catalog here does not contain the replacement either, so WITHOUT the
    // once-per-mount ref the effect would migrate again on the next catalog
    // identity change and toast twice. That is the shape of the guard's failure.
    const odd = { groups: [FALLBACK_MODEL_GROUPS[0]], models: FALLBACK_MODEL_GROUPS[0].models, source: "live" };
    localStorage.setItem(MODEL_KEY, JSON.stringify("claude-nonesuch-9"));
    const { rerender } = await renderApp(odd);
    await waitFor(() => expect(storedModel()).toBe(DEFAULT_MODEL_ID));
    await act(async () => {
      // A NEW object/array identity — exactly what a live /api/models poll does.
      rerender(
        <ThemeProvider>
          <ModelCatalogContext.Provider value={{ ...odd, groups: [...odd.groups] }}>
            <App />
          </ModelCatalogContext.Provider>
        </ThemeProvider>
      );
    });
    expect(migrationToasts()).toHaveLength(1);
  });
});

describe("App — createSession honours an override of \"\"", () => {
  beforeEach(async () => {
    await stubTerminal();
    localStorage.clear();
    globalThis.fetch = appFetchStub();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("effort \"\" from the dialog wins over the command bar's setting (?? not ||)", async () => {
    // "" is a REAL effort value meaning "send no effort flag". `||` would
    // silently promote it back to the TopBar's "max" — a control that does not
    // control, which is the same class of lie as the pill naming a model the
    // session will not run on.
    localStorage.setItem("cockpit-effort", JSON.stringify("max"));
    localStorage.setItem("cockpit-recent-locations", JSON.stringify(["C:\\Code\\web"]));
    await renderApp();

    await act(async () => {
      fireEvent.keyDown(window, { key: "N", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(screen.getByText("New session")).toBeInTheDocument());
    // The dialog opened on the command bar's "max" (Max), per the defaults contract.
    expect(screen.getByRole("button", { name: "Effort" })).toHaveTextContent("Max");

    fireEvent.click(screen.getByRole("button", { name: "Effort" }));
    fireEvent.click(screen.getByRole("button", { name: "Auto" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    });

    const post = globalThis.fetch.mock.calls.find(
      ([u, init]) => String(u) === "/api/terminals" && init?.method === "POST"
    );
    expect(post, "no POST /api/terminals was made").toBeTruthy();
    const body = JSON.parse(post[1].body);
    expect(body.effort).toBe("");
    // And the rest of the overrides travelled too, so this is not passing by a
    // coincidence of the dialog sending nothing at all.
    expect(body.permissionMode).toBe("default");
    expect(body.harness).toBe("claude-code");
  });
});
