/**
 * TokensSettings — Settings ▸ Design tokens page.
 *
 * The contract under test:
 *   - every TOKEN_GROUPS entry and every token in it renders a card
 *   - an edit performs BOTH writes: setTokenOverride (live paint) AND
 *     setField("appearance.token_overrides", COMPLETE MAP). The complete-map
 *     assertion is the regression test for the data-loss bug: the backend
 *     REPLACES that key, so a narrow leaf write would delete untouched siblings.
 *   - a clear OMITS the key from the map (it does not null it)
 *   - EDITED appears only on overridden tokens
 *   - Reset overrides clears the theme AND the settings path
 *   - export emits valid JSON of {base, overrides}
 *   - import rejects unknown token keys with a visible error, applies valid ones
 *   - the glow slider writes step-2 values to setGlowStrength AND appearance.glow_size
 *   - a translucent token's swatch gets the alpha (checkerboard) treatment
 *
 * useTheme is mocked: this page must be testable without the theming plumbing
 * landing first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import { TOKEN_GROUPS } from "../themes/themeData.js";
import TokensSettings, { parseImportedTheme, effectiveValue, isTranslucent } from "../components/settings/TokensSettings.jsx";

const THEME = {
  id: "va-night", label: "Visual Assist Night", group: "dark",
  bg: "#1a1a1a", bg2: "#151515", surface: "#212121", elev: "#262626", term: "#181818",
  border: "rgba(255,255,255,.08)", line: "rgba(255,255,255,.06)",
  fg: "#d7d6d3", dim: "#9a9a97", muted: "#666664", accent: "#4ea1e8",
  kw: "#cc7832", fn: "#ffc66d", type: "#4ec9b0", ok: "#7fb86a", macro: "#c497d6", num: "#6897bb",
  working: "#4ea1e8", thinking: "#7cc7ff", waiting: "#e0b060", idle: "#5bbf9f", error: "#e0698a",
};

const ALL_TOKENS = TOKEN_GROUPS.flatMap((g) => g.tokens);

let themeApi;

vi.mock("../hooks/useTheme.jsx", () => ({
  useTheme: () => themeApi,
}));

/** Build the mocked useTheme() value, with spies on every mutator. */
function makeTheme({ tokenOverrides = {}, userPalettes = {}, glowStrength = 30 } = {}) {
  return {
    themeId: "va-night",
    theme: THEME,
    themes: [
      { id: "va-night", label: "Visual Assist Night", group: "dark" },
      { id: "cockpit-blue", label: "Cockpit Blue", group: "dark" },
    ],
    switchTheme: vi.fn(),
    accent: null,
    setAccent: vi.fn(),
    glowEnabled: true,
    setGlowEnabled: vi.fn(),
    glowStrength,
    setGlowStrength: vi.fn(),
    tokenOverrides,
    overrideCount: Object.keys(tokenOverrides).length,
    setTokenOverride: vi.fn(),
    clearTokenOverride: vi.fn(),
    resetTokenOverrides: vi.fn(),
    userPalettes,
    savePalette: vi.fn(),
    applyPalette: vi.fn(),
    deletePalette: vi.fn(),
  };
}

/** A minimal stand-in for the Settings shell's draft store. */
function makeShell({ draft = {}, dirtyPaths = [] } = {}) {
  return {
    get: (path, fallback) => (path in draft ? draft[path] : fallback),
    setField: vi.fn(),
    deleteField: vi.fn(),
    isDirty: (path) => dirtyPaths.some((p) => p === path || p.startsWith(`${path}.`)),
  };
}

function setup({ theme = {}, shell = {} } = {}) {
  themeApi = makeTheme(theme);
  const props = makeShell(shell);
  render(<TokensSettings {...props} />);
  return { props, themeApi };
}

/** The map a given setField call sent for the token-overrides path. */
function lastOverrideMap(setField) {
  const calls = setField.mock.calls.filter((c) => c[0] === "appearance.token_overrides");
  return calls.length ? calls[calls.length - 1][1] : null;
}

describe("TokensSettings", () => {
  beforeEach(() => {
    themeApi = makeTheme();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders every token group and every token card", () => {
    setup();
    TOKEN_GROUPS.forEach((g) => {
      expect(screen.getByTestId(`token-group-${g.id}`)).toBeInTheDocument();
    });
    expect(TOKEN_GROUPS.length).toBe(4);
    ALL_TOKENS.forEach((t) => {
      expect(screen.getByTestId(`token-card-${t}`)).toBeInTheDocument();
    });
  });

  it("shows the effective palette value on each card when nothing is overridden", () => {
    setup();
    expect(screen.getByTestId("swatch---cc-bg")).toHaveAttribute("data-value", "#1a1a1a");
    expect(screen.getByTestId("swatch---cc-accent")).toHaveAttribute("data-value", "#4ea1e8");
  });

  // ── THE REGRESSION TEST ────────────────────────────────
  it("editing a token calls setTokenOverride AND setField with the COMPLETE map, preserving untouched siblings", () => {
    const { props, themeApi: api } = setup({
      theme: { tokenOverrides: { "--cc-fg": "#ffffff", "--cc-error": "#ff0000" } },
    });

    fireEvent.click(screen.getByTestId("token-card---cc-bg"));
    fireEvent.change(screen.getByTestId("field-appearance.token_overrides.--cc-bg"), {
      target: { value: "#123456" },
    });

    // 1. live paint
    expect(api.setTokenOverride).toHaveBeenCalledWith("--cc-bg", "#123456");

    // 2. persistence — the WHOLE map, never a leaf path
    const map = lastOverrideMap(props.setField);
    expect(map).toEqual({
      "--cc-fg": "#ffffff",
      "--cc-error": "#ff0000",
      "--cc-bg": "#123456",
    });
    // No narrow leaf write may ever happen for this dict.
    props.setField.mock.calls.forEach(([path]) => {
      expect(path).not.toMatch(/^appearance\.token_overrides\./);
    });
  });

  it("the color picker performs the same dual write", () => {
    const { props, themeApi: api } = setup();
    fireEvent.click(screen.getByTestId("token-card---cc-surface"));
    fireEvent.change(screen.getByTestId("picker---cc-surface"), { target: { value: "#0a0b0c" } });
    expect(api.setTokenOverride).toHaveBeenCalledWith("--cc-surface", "#0a0b0c");
    expect(lastOverrideMap(props.setField)).toEqual({ "--cc-surface": "#0a0b0c" });
  });

  it("editing --cc-accent also mirrors appearance.accent", () => {
    const { props, themeApi: api } = setup();
    fireEvent.click(screen.getByTestId("token-card---cc-accent"));
    fireEvent.change(screen.getByTestId("field-appearance.token_overrides.--cc-accent"), {
      target: { value: "#00ff88" },
    });
    expect(api.setAccent).toHaveBeenCalledWith("#00ff88");
    expect(props.setField).toHaveBeenCalledWith("appearance.accent", "#00ff88");
  });

  it("clearing a token OMITS its key from the map and keeps the others", () => {
    const { props, themeApi: api } = setup({
      theme: { tokenOverrides: { "--cc-bg": "#000000", "--cc-fg": "#ffffff" } },
    });
    fireEvent.click(screen.getByTestId("token-card---cc-bg"));
    fireEvent.click(screen.getByTestId("token-editor-reset"));

    expect(api.clearTokenOverride).toHaveBeenCalledWith("--cc-bg");
    const map = lastOverrideMap(props.setField);
    expect(map).toEqual({ "--cc-fg": "#ffffff" });
    expect("--cc-bg" in map).toBe(false); // omitted, not nulled
  });

  it("shows the EDITED pill only for overridden tokens", () => {
    setup({ theme: { tokenOverrides: { "--cc-bg": "#000000" } } });
    expect(screen.getByTestId("token-card---cc-bg")).toHaveAttribute("data-overridden", "true");
    expect(screen.getByTestId("token-card---cc-fg")).toHaveAttribute("data-overridden", "false");
    expect(screen.getByTestId("token-card---cc-bg")).toHaveTextContent("Edited");
    expect(screen.getByTestId("token-card---cc-fg")).not.toHaveTextContent("Edited");
  });

  it("hides the override count at zero and shows it in --cc-waiting otherwise", () => {
    setup();
    expect(screen.queryByTestId("override-count")).toBeNull();
    render(<div />); // isolate
    themeApi = makeTheme({ tokenOverrides: { "--cc-bg": "#000", "--cc-fg": "#fff" } });
    const props = makeShell();
    render(<TokensSettings {...props} />);
    const badge = screen.getByTestId("override-count");
    expect(badge).toHaveTextContent("2 overrides");
    expect(badge).toHaveStyle({ color: "var(--cc-waiting)" });
  });

  it("Reset overrides clears the theme state AND the settings path", () => {
    const { props, themeApi: api } = setup({ theme: { tokenOverrides: { "--cc-bg": "#000000" } } });
    fireEvent.click(screen.getByTestId("reset-overrides"));
    expect(api.resetTokenOverrides).toHaveBeenCalled();
    expect(props.deleteField).toHaveBeenCalledWith("appearance.token_overrides");
  });

  it("Reset overrides falls back to an empty map when the shell has no deleteField", () => {
    themeApi = makeTheme({ tokenOverrides: { "--cc-bg": "#000000" } });
    const setField = vi.fn();
    render(
      <TokensSettings get={() => undefined} setField={setField} isDirty={() => false} />
    );
    fireEvent.click(screen.getByTestId("reset-overrides"));
    expect(setField).toHaveBeenCalledWith("appearance.token_overrides", {});
  });

  // ── export ─────────────────────────────────────────────
  it("Export as JSON produces a real blob with {base, overrides}", () => {
    const overrides = { "--cc-bg": "#101010" };
    const captured = [];
    const createObjectURL = vi.fn((blob) => {
      captured.push(blob);
      return "blob:mock";
    });
    globalThis.URL.createObjectURL = createObjectURL;
    globalThis.URL.revokeObjectURL = vi.fn();
    let text = null;
    const OriginalBlob = globalThis.Blob;
    globalThis.Blob = class extends OriginalBlob {
      constructor(parts, opts) {
        super(parts, opts);
        text = String(parts[0]);
      }
    };

    setup({ theme: { tokenOverrides: overrides } });
    fireEvent.click(screen.getByTestId("export-theme"));

    globalThis.Blob = OriginalBlob;
    expect(createObjectURL).toHaveBeenCalled();
    const doc = JSON.parse(text);
    expect(doc).toEqual({ base: "va-night", overrides });
  });

  // ── import ─────────────────────────────────────────────
  it("import REJECTS an unknown token key with a visible error and applies nothing", () => {
    const { props, themeApi: api } = setup();
    fireEvent.click(screen.getByTestId("import-theme"));
    fireEvent.change(screen.getByTestId("import-text"), {
      target: { value: JSON.stringify({ base: "va-night", overrides: { "--cc-nope": "#fff" } }) },
    });
    fireEvent.click(screen.getByTestId("import-apply"));

    const err = screen.getByTestId("tokens-error");
    expect(err).toBeInTheDocument();
    expect(err).toHaveTextContent("--cc-nope");
    expect(err).toHaveStyle({ color: "var(--cc-error)" });
    expect(api.setTokenOverride).not.toHaveBeenCalled();
    expect(props.setField).not.toHaveBeenCalled();
  });

  it("import applies a valid document through both writes", () => {
    const { props, themeApi: api } = setup();
    fireEvent.click(screen.getByTestId("import-theme"));
    fireEvent.change(screen.getByTestId("import-text"), {
      target: {
        value: JSON.stringify({
          base: "cockpit-blue",
          overrides: { "--cc-accent": "#ff8800", "--cc-bg": "#050505" },
        }),
      },
    });
    fireEvent.click(screen.getByTestId("import-apply"));

    expect(api.switchTheme).toHaveBeenCalledWith("cockpit-blue");
    expect(api.setTokenOverride).toHaveBeenCalledWith("--cc-accent", "#ff8800");
    expect(api.setTokenOverride).toHaveBeenCalledWith("--cc-bg", "#050505");
    expect(lastOverrideMap(props.setField)).toEqual({
      "--cc-accent": "#ff8800",
      "--cc-bg": "#050505",
    });
    expect(screen.queryByTestId("tokens-error")).toBeNull();
  });

  it("import rejects malformed JSON", () => {
    setup();
    fireEvent.click(screen.getByTestId("import-theme"));
    fireEvent.change(screen.getByTestId("import-text"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByTestId("import-apply"));
    expect(screen.getByTestId("tokens-error")).toHaveTextContent("not valid JSON");
  });

  // ── palettes ───────────────────────────────────────────
  it("saves a named palette through savePalette AND the whole user_palettes map", () => {
    const { props, themeApi: api } = setup({
      theme: {
        tokenOverrides: { "--cc-bg": "#010101" },
        userPalettes: { existing: { base: "va-night", overrides: {} } },
      },
    });
    fireEvent.change(screen.getByTestId("palette-name"), { target: { value: "midnight" } });
    fireEvent.click(screen.getByTestId("save-palette"));

    expect(api.savePalette).toHaveBeenCalledWith("midnight");
    expect(props.setField).toHaveBeenCalledWith("appearance.user_palettes", {
      existing: { base: "va-night", overrides: {} },
      midnight: { base: "va-night", overrides: { "--cc-bg": "#010101" } },
    });
  });

  it("deleting a user palette omits it from the whole map", () => {
    const { props, themeApi: api } = setup({
      theme: {
        userPalettes: {
          keep: { base: "va-night", overrides: {} },
          drop: { base: "va-night", overrides: {} },
        },
      },
    });
    fireEvent.click(screen.getByTestId("delete-palette-drop"));
    expect(api.deletePalette).toHaveBeenCalledWith("drop");
    expect(props.setField).toHaveBeenCalledWith("appearance.user_palettes", {
      keep: { base: "va-night", overrides: {} },
    });
  });

  it("base palette pills switch the theme", () => {
    const { themeApi: api } = setup();
    fireEvent.click(screen.getByTestId("palette-cockpit-blue"));
    expect(api.switchTheme).toHaveBeenCalledWith("cockpit-blue");
  });

  // ── glow ───────────────────────────────────────────────
  it("the glow slider is step 2 and writes to setGlowStrength AND appearance.glow_size", () => {
    const { props, themeApi: api } = setup({ theme: { glowStrength: 30 } });
    const slider = screen.getByTestId("field-appearance.glow_size");
    expect(slider).toHaveAttribute("step", "2");
    expect(slider).toHaveAttribute("min", "0");
    expect(slider).toHaveAttribute("max", "48");

    fireEvent.change(slider, { target: { value: "18" } });
    expect(api.setGlowStrength).toHaveBeenCalledWith(18);
    expect(props.setField).toHaveBeenCalledWith("appearance.glow_size", 18);
  });

  // ── alpha ──────────────────────────────────────────────
  it("a translucent token's swatch gets the alpha treatment", () => {
    setup();
    const border = screen.getByTestId("swatch---cc-border");
    expect(border).toHaveAttribute("data-alpha", "true");
    expect(border).toHaveAttribute("data-value", "rgba(255,255,255,.08)");
    expect(screen.getByTestId("swatch---cc-bg")).toHaveAttribute("data-alpha", "false");
  });

  it("the editor says the picker cannot express a translucent value", () => {
    setup();
    fireEvent.click(screen.getByTestId("token-card---cc-border"));
    expect(screen.getByTestId("token-editor")).toHaveTextContent(/carries alpha/i);
  });

  // ── rail ───────────────────────────────────────────────
  it("the rail shows verified surfaces for a selected token, never an invented count", () => {
    setup();
    expect(screen.getByTestId("where-used")).toHaveTextContent(/Pick a token card/i);
    fireEvent.click(screen.getByTestId("token-card---cc-kw"));
    // --cc-kw genuinely has no component consumer — say so, do not invent one.
    expect(screen.getByTestId("where-used")).toHaveTextContent(/not read by any component/i);
    fireEvent.click(screen.getByTestId("token-card---cc-kw")); // deselect
    fireEvent.click(screen.getByTestId("token-card---cc-surface"));
    expect(screen.getByTestId("where-used")).toHaveTextContent(/component modules/i);
    expect(screen.getByTestId("where-used")).toHaveTextContent("Inspector");
  });

  it("renders the preview pane, all five state chips, and the honesty notes", () => {
    setup();
    expect(screen.getByTestId("preview-pane")).toBeInTheDocument();
    ["working", "thinking", "waiting", "idle", "error"].forEach((s) => {
      expect(screen.getByTestId(`state-chip-${s}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId("legacy-alias-note")).toHaveTextContent("--text-primary");
    expect(screen.getByTestId("ansi-note")).toHaveTextContent(/ANSI palette/i);
  });

  it("shows the radius scale and mono stack as read-only reference", () => {
    setup();
    [4, 7, 9, 12, 999].forEach((r) => {
      expect(screen.getByTestId(`radius-${r}`)).toBeInTheDocument();
    });
    expect(screen.getByTestId("mono-stack")).toBeInTheDocument();
    expect(screen.getByTestId("token-group-scales")).toHaveTextContent(/read-only here by design/i);
  });

  it("every interactive control carries an accessible name", () => {
    setup();
    screen.getAllByRole("button").forEach((b) => {
      const name = b.getAttribute("aria-label") || b.textContent;
      expect(name && name.trim().length).toBeTruthy();
    });
  });
});

describe("parseImportedTheme", () => {
  it("accepts a valid document", () => {
    const r = parseImportedTheme('{"base":"va-night","overrides":{"--cc-bg":"#000000"}}');
    expect(r).toEqual({ ok: true, base: "va-night", overrides: { "--cc-bg": "#000000" } });
  });

  it("rejects unknown tokens, non-objects, and non-string values", () => {
    expect(parseImportedTheme('{"overrides":{"--nope":"#000"}}').ok).toBe(false);
    expect(parseImportedTheme("[]").ok).toBe(false);
    expect(parseImportedTheme('{"overrides":{"--cc-bg":3}}').ok).toBe(false);
    expect(parseImportedTheme('{"base":"x"}').ok).toBe(false);
    expect(parseImportedTheme("nope").ok).toBe(false);
  });
});

describe("effectiveValue / isTranslucent", () => {
  it("prefers the override, then the accent, then the palette", () => {
    expect(effectiveValue("--cc-bg", { "--cc-bg": "#111" }, THEME, null)).toBe("#111");
    expect(effectiveValue("--cc-accent", {}, THEME, "#abcdef")).toBe("#abcdef");
    expect(effectiveValue("--cc-working", {}, THEME, "#abcdef")).toBe("#abcdef");
    expect(effectiveValue("--cc-fg", {}, THEME, null)).toBe("#d7d6d3");
    expect(effectiveValue("--cc-fg", {}, null, null)).toBe("unset");
  });

  it("detects alpha-bearing values", () => {
    expect(isTranslucent("rgba(0,0,0,.5)")).toBe(true);
    expect(isTranslucent("color-mix(in srgb, red 50%, transparent)")).toBe(true);
    expect(isTranslucent("#11223344")).toBe(true);
    expect(isTranslucent("#112233")).toBe(false);
  });
});
