import { describe, it, expect, afterEach } from "vitest";
import { buildXtermTheme, withAlpha, lighten, ANSI_SLOT_TOKENS, REQUIRED_XTERM_KEYS } from "../utils/xtermTheme";
import { THEMES, applyThemeToDOM } from "../themes/themeData";

const ANSI_SLOTS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
];

afterEach(() => {
  // applyThemeToDOM writes inline custom properties on <html>; clear between tests.
  document.documentElement.removeAttribute("style");
});

describe("buildXtermTheme — slot completeness (the regression guard)", () => {
  // This is the test that would have caught the original bug: twelve ANSI slots
  // resolved to `undefined` because they read theme keys that never existed.
  for (const [id, theme] of Object.entries(THEMES)) {
    it(`fills every slot for theme "${id}"`, () => {
      const p = buildXtermTheme(theme);
      for (const key of [...ANSI_SLOTS, "background", "foreground", "cursor", "cursorAccent", "selectionBackground", "selectionForeground"]) {
        expect(typeof p[key], `${key} type`).toBe("string");
        expect(p[key].length, `${key} empty`).toBeGreaterThan(0);
        expect(p[key]).not.toContain("undefined");
      }
    });
  }

  it("REQUIRED_XTERM_KEYS covers all sixteen ANSI slots", () => {
    for (const slot of ANSI_SLOTS) expect(REQUIRED_XTERM_KEYS).toContain(slot);
    expect(Object.keys(ANSI_SLOT_TOKENS)).toHaveLength(15); // brightWhite is a literal
  });

  it("never yields undefined even for a garbage theme", () => {
    for (const bad of [null, undefined, {}, { bg: "" }, 42]) {
      const p = buildXtermTheme(bad);
      for (const key of REQUIRED_XTERM_KEYS) {
        expect(typeof p[key], `${key} for ${JSON.stringify(bad)}`).toBe("string");
        expect(p[key].length).toBeGreaterThan(0);
      }
    }
  });
});

describe("buildXtermTheme — token mapping", () => {
  const theme = THEMES["va-night"];

  it("maps each ANSI slot to the token it claims", () => {
    const p = buildXtermTheme(theme);
    expect(p.black).toBe(theme.elev);
    expect(p.red).toBe(theme.error);
    expect(p.green).toBe(theme.ok);
    expect(p.yellow).toBe(theme.fn);
    expect(p.blue).toBe(theme.accent);
    expect(p.magenta).toBe(theme.macro);
    expect(p.cyan).toBe(theme.type);
    expect(p.white).toBe(theme.fg);
    expect(p.brightWhite).toBe("#ffffff");
  });

  it("derives each bright slot from its base token by lightening", () => {
    const p = buildXtermTheme(theme);
    expect(p.brightBlack).toBe(lighten(theme.muted));
    expect(p.brightRed).toBe(lighten(theme.error));
    expect(p.brightGreen).toBe(lighten(theme.ok));
    expect(p.brightYellow).toBe(lighten(theme.fn));
    expect(p.brightBlue).toBe(lighten(theme.accent));
    expect(p.brightMagenta).toBe(lighten(theme.macro));
    expect(p.brightCyan).toBe(lighten(theme.type));
    // Bold text must not collapse onto the normal color (xterm draws bold with
    // the bright slots), and must stay a valid color.
    for (const [b, base] of [["brightRed", "red"], ["brightGreen", "green"], ["brightYellow", "yellow"], ["brightMagenta", "magenta"], ["brightCyan", "cyan"], ["brightBlack", "black"]]) {
      expect(p[b]).not.toBe(p[base]);
      expect(p[b]).toMatch(/^rgb\(/);
    }
  });

  it("keeps the four previously-working slots at their old values", () => {
    const p = buildXtermTheme(theme);
    expect(p.foreground).toBe(theme.fg);
    expect(p.cursor).toBe(theme.accent);
    expect(p.blue).toBe(theme.accent);
  });

  it("paints the canvas with --cc-term, not --cc-bg, for every theme", () => {
    // The pane container around the canvas uses var(--cc-term, ...). If the
    // canvas used --cc-bg instead there would be a visible seam in the padding.
    for (const [id, th] of Object.entries(THEMES)) {
      const p = buildXtermTheme(th);
      expect(p.background, `${id} background`).toBe(th.term);
      expect(p.cursorAccent, `${id} cursorAccent`).toBe(th.term);
      // Guard the regression specifically: these two tokens genuinely differ.
      expect(th.term).not.toBe(th.bg);
      expect(p.background).not.toBe(th.bg);
    }
  });

  it("moves the canvas background when --cc-term alone is overridden", () => {
    const p = buildXtermTheme(theme, { tokenOverrides: { "--cc-term": "#000102" } });
    expect(p.background).toBe("#000102");
    expect(p.cursorAccent).toBe("#000102");

    applyThemeToDOM(theme, { tokenOverrides: { "--cc-term": "#030201" } });
    const viaDom = buildXtermTheme(theme);
    expect(viaDom.background).toBe("#030201");
    expect(viaDom.cursorAccent).toBe("#030201");
  });

  it("falls back to theme.bg when a theme has no term token", () => {
    const p = buildXtermTheme({ ...theme, term: undefined });
    expect(p.background).toBe(theme.bg);
  });

  it("distinguishes themes (palette is not a constant)", () => {
    const a = buildXtermTheme(THEMES["va-night"]);
    const b = buildXtermTheme(THEMES["cockpit-blue"]);
    expect(a.black).not.toBe(b.black);
  });
});

describe("buildXtermTheme — overrides reach the terminal", () => {
  const theme = THEMES["va-night"];

  it("prefers an explicitly-passed token override over the theme value", () => {
    const p = buildXtermTheme(theme, { tokenOverrides: { "--cc-error": "#ff0000", "--cc-ok": "#00ff00" } });
    expect(p.red).toBe("#ff0000");
    expect(p.brightRed).toBe(lighten("#ff0000"));
    expect(p.green).toBe("#00ff00");
    expect(p.brightGreen).toBe(lighten("#00ff00"));
  });

  it("honours the accent picker for the blue/cursor slots", () => {
    const p = buildXtermTheme(theme, { accent: "#123456" });
    expect(p.blue).toBe("#123456");
    expect(p.brightBlue).toBe(lighten("#123456"));
    expect(p.cursor).toBe("#123456");
    expect(p.selectionBackground).toBe("rgba(18, 52, 86, 0.25)");
  });

  it("lets an explicit --cc-accent override outrank the accent picker", () => {
    const p = buildXtermTheme(theme, { accent: "#123456", tokenOverrides: { "--cc-accent": "#abcdef" } });
    expect(p.blue).toBe("#abcdef");
  });

  it("reads effective values written to the DOM by applyThemeToDOM", () => {
    applyThemeToDOM(theme, { tokenOverrides: { "--cc-macro": "#0f0f0f" } });
    // No tokenOverrides passed in — the value must come off the root element.
    const p = buildXtermTheme(theme);
    expect(p.magenta).toBe("#0f0f0f");
    expect(p.brightMagenta).toBe(lighten("#0f0f0f"));
  });

  it("falls back to the theme object when the DOM has no custom properties", () => {
    document.documentElement.removeAttribute("style");
    const p = buildXtermTheme(theme);
    expect(p.magenta).toBe(theme.macro);
  });
});

describe("selectionBackground / withAlpha robustness", () => {
  it("handles 6-digit hex (the only form the old code supported)", () => {
    expect(withAlpha("#4ea1e8", 0.25)).toBe("rgba(78, 161, 232, 0.25)");
  });

  it("handles 3-digit and 8-digit hex", () => {
    expect(withAlpha("#f0a", 0.5)).toBe("rgba(255, 0, 170, 0.5)");
    expect(withAlpha("#4ea1e880", 0.25)).toBe("rgba(78, 161, 232, 0.25)");
  });

  it("handles rgb()/rgba() accents — the old concatenation produced garbage here", () => {
    expect(withAlpha("rgb(10, 20, 30)", 0.25)).toBe("rgba(10, 20, 30, 0.25)");
    expect(withAlpha("rgba(10, 20, 30, 0.8)", 0.25)).toBe("rgba(10, 20, 30, 0.25)");
    const p = buildXtermTheme(THEMES["va-night"], { accent: "rgb(10, 20, 30)" });
    expect(p.selectionBackground).toBe("rgba(10, 20, 30, 0.25)");
    expect(p.selectionBackground).not.toContain("undefined");
    expect(p.selectionBackground.endsWith("40")).toBe(false);
  });

  it("never emits a malformed color for exotic values", () => {
    for (const c of ["color-mix(in srgb, red 50%, blue)", "hsl(200 50% 50%)", "papayawhip", "", null, undefined, "nonsense"]) {
      const out = withAlpha(c, 0.25);
      expect(out).toMatch(/^rgba\(\s*\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/);
    }
  });

  it("clamps alpha", () => {
    expect(withAlpha("#000000", 5)).toBe("rgba(0, 0, 0, 1)");
    expect(withAlpha("#000000", -1)).toBe("rgba(0, 0, 0, 0)");
    expect(withAlpha("#000000", NaN)).toBe("rgba(0, 0, 0, 1)");
  });
});

describe("lighten", () => {
  it("mixes toward white without changing hue order", () => {
    expect(lighten("#000000", 0.5)).toBe("rgb(128, 128, 128)");
    expect(lighten("#ffffff", 0.5)).toBe("rgb(255, 255, 255)");
    expect(lighten("rgb(0, 100, 200)", 0)).toBe("rgb(0, 100, 200)");
  });

  it("returns unparseable colors untouched rather than emitting garbage", () => {
    expect(lighten("color-mix(in srgb, red 50%, blue)", 0.2)).toBe("color-mix(in srgb, red 50%, blue)");
  });
});
