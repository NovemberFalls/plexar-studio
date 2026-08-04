/**
 * xterm.js palette construction from Plexar Studio design tokens.
 *
 * History / why this file exists: the previous inline `buildXtermTheme` read
 * keys that DO NOT EXIST on any theme object (`theme.red`, `theme.green`,
 * `theme.yellow`, `theme.purple`, `theme.cyan`, `theme.bgSurface`,
 * `theme.fgMuted`). Twelve of the sixteen ANSI slots therefore resolved to
 * `undefined` and xterm silently used its own built-in defaults — so ANSI
 * colors never followed the Plexar Studio theme. Every slot below maps to a token
 * that actually exists, and resolution goes through the same `--cc-*` custom
 * properties the rest of the app uses, so per-token user overrides reach the
 * terminal too.
 */
import { THEMES, DEFAULT_THEME_ID } from "../themes/themeData";

const FALLBACK_THEME = THEMES[DEFAULT_THEME_ID];

/** Last-resort literal, used only if the default theme itself lacks a key. */
const HARD_FALLBACK = "#d7d6d3";

/** How far the bright ANSI slots are mixed toward white. Kept subtle. */
const BRIGHT_MIX = 0.22;

/**
 * ANSI slot -> [custom property, theme object key].
 *
 * Bright variants read the SAME token as their base and are then lightened by
 * `lighten()` — never a hand-invented hex. xterm renders bold text with the
 * bright slots (`drawBoldTextInBrightColors`), so if bright === base, bold text
 * becomes indistinguishable from normal text. Lightening is done in sRGB from
 * the resolved value, and silently returns the base unchanged for color forms
 * we cannot parse, so hue stays honest under every theme and every override.
 */
export const ANSI_SLOT_TOKENS = {
  black: ["--cc-elev", "elev"],
  red: ["--cc-error", "error"],
  green: ["--cc-ok", "ok"],
  yellow: ["--cc-fn", "fn"],
  blue: ["--cc-accent", "accent"],
  magenta: ["--cc-macro", "macro"],
  cyan: ["--cc-type", "type"],
  white: ["--cc-fg", "fg"],
  brightBlack: ["--cc-muted", "muted"],
  brightRed: ["--cc-error", "error"],
  brightGreen: ["--cc-ok", "ok"],
  brightYellow: ["--cc-fn", "fn"],
  brightBlue: ["--cc-accent", "accent"],
  brightMagenta: ["--cc-macro", "macro"],
  brightCyan: ["--cc-type", "type"],
};

/** The full set of keys the built palette guarantees to be non-empty strings. */
export const REQUIRED_XTERM_KEYS = [
  "background", "foreground", "cursor", "cursorAccent",
  "selectionBackground", "selectionForeground",
  ...Object.keys(ANSI_SLOT_TOKENS),
  "brightWhite",
];

function clampByte(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * Parses any of `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`,
 * `rgba(...)` into `[r, g, b]`. Returns null for anything else (named colors,
 * `hsl()`, `color-mix()`, `var()`, garbage).
 */
function parseRgb(color) {
  if (typeof color !== "string") return null;
  const c = color.trim();
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
    }
    if (h.length === 6 || h.length === 8) {
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return null;
  }
  const fn = /^rgba?\(\s*([^)]+)\)$/i.exec(c);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const nums = parts.slice(0, 3).map((p) => (p.endsWith("%")
      ? (parseFloat(p) / 100) * 255
      : parseFloat(p)));
    if (nums.some((n) => Number.isNaN(n))) return null;
    return nums.map(clampByte);
  }
  return null;
}

/**
 * Resolves an arbitrary CSS color to `rgb(...)` by letting the browser do it.
 * Used only when direct parsing fails (named colors, `hsl()`, `color-mix()`).
 * Returns null when there is no usable document or the browser declines.
 */
function resolveViaDom(color, doc) {
  if (!doc || !doc.body || typeof window === "undefined" || !window.getComputedStyle) return null;
  let el = null;
  try {
    el = doc.createElement("span");
    el.style.display = "none";
    el.style.color = color;
    doc.body.appendChild(el);
    const computed = window.getComputedStyle(el).color;
    return parseRgb(computed);
  } catch {
    return null;
  } finally {
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
}

/**
 * Returns `color` at the given alpha as an `rgba()` string.
 *
 * Replaces the old `` `${theme.accent}40` `` string concatenation, which only
 * worked for 6-digit hex and produced silent garbage (`rgb(1,2,3)40`) for any
 * other CSS color form — now reachable because users can override tokens with
 * arbitrary CSS colors.
 */
export function withAlpha(color, alpha, doc) {
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  const rgb = parseRgb(color) || resolveViaDom(color, doc);
  if (!rgb) return `rgba(255, 255, 255, ${a})`;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

/**
 * Mixes `color` toward white by `amount` (0..1) and returns `rgb(...)`.
 * Returns the input untouched when the color cannot be parsed — a slightly
 * duller bright slot is strictly better than an invalid one.
 */
export function lighten(color, amount = BRIGHT_MIX, doc) {
  const a = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
  const rgb = parseRgb(color) || resolveViaDom(color, doc);
  if (!rgb) return color;
  const [r, g, b] = rgb.map((v) => clampByte(v + (255 - v) * a));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Builds the xterm theme for the current Plexar Studio theme.
 *
 * Resolution order per token, highest first:
 *  1. explicit `options.tokenOverrides[prop]` — passed in rather than only read
 *     off the DOM because child effects run BEFORE the ThemeProvider parent
 *     effect that writes the properties, so a freshly-changed override is not
 *     yet on `document.documentElement` when this runs.
 *  2. `options.accent` (for `--cc-accent` only) — mirrors `applyThemeToDOM`,
 *     where an explicit `--cc-accent` override outranks the accent picker.
 *  3. the computed custom property on the root element.
 *  4. the theme object's own value for that token.
 *  5. the default theme's value (guarantees a non-empty string).
 *
 * @param {object} theme  a THEMES entry
 * @param {object} [options] { accent, tokenOverrides, root, doc }
 */
export function buildXtermTheme(theme, options = {}) {
  const t = theme && typeof theme === "object" ? theme : FALLBACK_THEME;
  const overrides = options.tokenOverrides && typeof options.tokenOverrides === "object"
    ? options.tokenOverrides
    : {};
  const accent = typeof options.accent === "string" && options.accent ? options.accent : null;

  const doc = options.doc || (typeof document !== "undefined" ? document : null);
  const root = options.root || (doc ? doc.documentElement : null);
  let computed = null;
  try {
    if (root && typeof window !== "undefined" && window.getComputedStyle) {
      computed = window.getComputedStyle(root);
    }
  } catch {
    computed = null;
  }

  const str = (v) => (typeof v === "string" ? v.trim() : "");

  const resolve = (prop, key, altKey) => {
    const ovr = str(overrides[prop]);
    if (ovr) return ovr;
    if (prop === "--cc-accent" && accent) return accent;
    let fromDom = "";
    try {
      fromDom = computed ? str(computed.getPropertyValue(prop)) : "";
    } catch {
      fromDom = "";
    }
    if (fromDom) return fromDom;
    return str(t[key]) || (altKey ? str(t[altKey]) : "")
      || str(FALLBACK_THEME[key]) || (altKey ? str(FALLBACK_THEME[altKey]) : "")
      || HARD_FALLBACK;
  };

  // The terminal canvas paints `--cc-term`, NOT `--cc-bg`: the token is named
  // for the terminal, the pane container around the canvas already uses
  // `var(--cc-term, ...)`, and the two tokens differ per theme (#181818 vs
  // #1a1a1a in va-night), which left a visible seam in the pane padding — worse
  // still once someone overrides `--cc-term` alone. `theme.bg` is kept as a
  // secondary fallback so a theme without a `term` key still gets a dark canvas.
  const termBg = resolve("--cc-term", "term", "bg");
  const fg = resolve("--cc-fg", "fg");
  const accentValue = resolve("--cc-accent", "accent");

  const palette = {
    background: termBg,
    foreground: fg,
    cursor: accentValue,
    // Pairs with background — it is the color drawn UNDER the cursor block.
    cursorAccent: termBg,
    // 0.25 ≈ the old "40" hex alpha suffix (0x40/0xff = 0.251).
    selectionBackground: withAlpha(accentValue, 0.25, doc),
    selectionForeground: fg,
  };

  for (const [slot, [prop, key]] of Object.entries(ANSI_SLOT_TOKENS)) {
    const value = resolve(prop, key);
    palette[slot] = slot.startsWith("bright") ? lighten(value, BRIGHT_MIX, doc) : value;
  }
  // brightWhite is the one deliberate literal: pure white is the brightest
  // reading of the foreground slot and matches the previous behavior.
  palette.brightWhite = "#ffffff";

  return palette;
}

export default buildXtermTheme;
