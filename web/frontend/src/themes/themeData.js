/**
 * Claude Cockpit — Theme Data
 * Two palettes: Visual Assist Night (default) and Cockpit Blue.
 * Drives the `--cc-*` design-token custom properties consumed by index.css.
 */

export const THEMES = {
  "va-night": {
    id: "va-night", label: "Visual Assist Night", group: "dark",
    bg: "#1a1a1a", bg2: "#151515", surface: "#212121", elev: "#262626", term: "#181818",
    border: "rgba(255,255,255,.08)", line: "rgba(255,255,255,.06)",
    fg: "#d7d6d3", dim: "#9a9a97", muted: "#666664",
    accent: "#4ea1e8",
    kw: "#cc7832", fn: "#ffc66d", type: "#4ec9b0", ok: "#7fb86a", macro: "#c497d6", num: "#6897bb",
    working: "#4ea1e8", thinking: "#7cc7ff", waiting: "#e0b060", idle: "#5bbf9f", error: "#e0698a",
  },
  "cockpit-blue": {
    id: "cockpit-blue", label: "Cockpit Blue", group: "dark",
    bg: "#1b1e23", bg2: "#101317", surface: "#20242b", elev: "#262b33", term: "#16191d",
    border: "rgba(255,255,255,.08)", line: "rgba(255,255,255,.06)",
    fg: "#d6dae1", dim: "#9aa4af", muted: "#626d78",
    accent: "#4ea1e8",
    kw: "#4ea1e8", fn: "#d8a75f", type: "#45c4b0", ok: "#86c26b", macro: "#b98ee0", num: "#6897bb",
    working: "#4ea1e8", thinking: "#7cc7ff", waiting: "#d8a75f", idle: "#45c4b0", error: "#e5698a",
  },
};

/**
 * Every `--cc-*` token a user is allowed to override by hand. Kept flat and
 * exported so the tokens settings page and the sanitizers share one list —
 * anything not in here is ignored on read and never written to the DOM.
 */
export const OVERRIDABLE_TOKENS = [
  "--cc-bg", "--cc-bg2", "--cc-surface", "--cc-elev", "--cc-term",
  "--cc-border", "--cc-line", "--cc-accent",
  "--cc-fg", "--cc-dim", "--cc-muted", "--cc-fn",
  "--cc-working", "--cc-thinking", "--cc-waiting", "--cc-idle", "--cc-error", "--cc-ok",
  "--cc-kw", "--cc-type", "--cc-macro", "--cc-num",
];

/** UI grouping for the tokens settings page. Membership follows the design spec. */
export const TOKEN_GROUPS = [
  {
    id: "surfaces",
    label: "Surfaces",
    note: "Backgrounds, panel fills, borders, and the accent that ties them together.",
    tokens: ["--cc-bg", "--cc-bg2", "--cc-surface", "--cc-elev", "--cc-term", "--cc-border", "--cc-line", "--cc-accent"],
  },
  {
    id: "text",
    label: "Text",
    note: "Body text and the two quieter tiers used for labels and hints.",
    tokens: ["--cc-fg", "--cc-dim", "--cc-muted", "--cc-fn"],
  },
  {
    id: "state",
    label: "Session state",
    note: "The colors a pane uses to say what a session is doing right now.",
    tokens: ["--cc-working", "--cc-thinking", "--cc-waiting", "--cc-idle", "--cc-error", "--cc-ok"],
  },
  {
    id: "syntax",
    label: "Syntax",
    note: "Code coloring inside terminal panes and code previews.",
    tokens: ["--cc-kw", "--cc-type", "--cc-macro", "--cc-num"],
  },
];

const TOKEN_SET = new Set(OVERRIDABLE_TOKENS);

/** Drops unknown token names and non-string values. Never throws. */
function sanitizeOverrides(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (TOKEN_SET.has(k) && typeof v === "string") out[k] = v;
  }
  return out;
}

/** Drops malformed palettes and sanitizes each palette's override map. */
function sanitizePalettes(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [name, entry] of Object.entries(raw)) {
    if (!name || typeof name !== "string") continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    out[name] = {
      base: typeof entry.base === "string" ? entry.base : DEFAULT_THEME_ID,
      overrides: sanitizeOverrides(entry.overrides),
    };
  }
  return out;
}

export { sanitizeOverrides, sanitizePalettes };

const STORAGE_KEY = "cockpit-theme";
const ACCENT_KEY = "cockpit-accent";
const GLOW_KEY = "cockpit-glow";
const GLOW_SIZE_KEY = "cockpit-glow-size";
const TOKEN_OVERRIDES_KEY = "cockpit-token-overrides";
const USER_PALETTES_KEY = "cockpit-user-palettes";

const DEFAULT_THEME_ID = "va-night";
const DEFAULT_GLOW_SIZE = 30;

export function getTheme(id) {
  return THEMES[id] || null;
}

export function listThemes() {
  return Object.values(THEMES).map(({ id, label, group }) => ({ id, label, group }));
}

export function getSavedTheme() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

export function saveTheme(id) {
  try { localStorage.setItem(STORAGE_KEY, id); } catch {}
}

export function getSavedAccent() {
  try { return localStorage.getItem(ACCENT_KEY) || null; } catch { return null; }
}

export function saveAccent(accent) {
  try {
    if (accent) localStorage.setItem(ACCENT_KEY, accent);
    else localStorage.removeItem(ACCENT_KEY);
  } catch {}
}

export function getSavedGlowEnabled() {
  try {
    const v = localStorage.getItem(GLOW_KEY);
    return v === null ? true : v === "on";
  } catch { return true; }
}

export function saveGlowEnabled(enabled) {
  try { localStorage.setItem(GLOW_KEY, enabled ? "on" : "off"); } catch {}
}

export function getSavedGlowStrength() {
  try {
    const v = localStorage.getItem(GLOW_SIZE_KEY);
    const n = v === null ? DEFAULT_GLOW_SIZE : parseInt(v, 10);
    return Number.isFinite(n) ? n : DEFAULT_GLOW_SIZE;
  } catch { return DEFAULT_GLOW_SIZE; }
}

export function saveGlowStrength(strength) {
  try { localStorage.setItem(GLOW_SIZE_KEY, String(strength)); } catch {}
}

export function getSavedTokenOverrides() {
  try { return sanitizeOverrides(JSON.parse(localStorage.getItem(TOKEN_OVERRIDES_KEY))); }
  catch { return {}; }
}

export function saveTokenOverrides(map) {
  try {
    const clean = sanitizeOverrides(map);
    if (Object.keys(clean).length) localStorage.setItem(TOKEN_OVERRIDES_KEY, JSON.stringify(clean));
    else localStorage.removeItem(TOKEN_OVERRIDES_KEY);
  } catch {}
}

export function getSavedUserPalettes() {
  try { return sanitizePalettes(JSON.parse(localStorage.getItem(USER_PALETTES_KEY))); }
  catch { return {}; }
}

export function saveUserPalettes(map) {
  try {
    const clean = sanitizePalettes(map);
    if (Object.keys(clean).length) localStorage.setItem(USER_PALETTES_KEY, JSON.stringify(clean));
    else localStorage.removeItem(USER_PALETTES_KEY);
  } catch {}
}

/**
 * Applies a theme + user overrides (accent, glow) to the document root as
 * `--cc-*` custom properties. Legacy `--bg`, `--text-primary`, etc. vars are
 * aliased to the `--cc-*` tokens statically in index.css, so they update too.
 */
export function applyThemeToDOM(theme, options = {}) {
  if (!theme) return;
  const { accent, glowEnabled = true, glowStrength = DEFAULT_GLOW_SIZE } = options;
  const overrides = sanitizeOverrides(options.tokenOverrides);
  const root = document.documentElement;
  const s = root.style;

  s.setProperty("--cc-bg", theme.bg);
  s.setProperty("--cc-bg2", theme.bg2);
  s.setProperty("--cc-surface", theme.surface);
  s.setProperty("--cc-elev", theme.elev);
  s.setProperty("--cc-term", theme.term);
  s.setProperty("--cc-border", theme.border);
  s.setProperty("--cc-line", theme.line);
  s.setProperty("--cc-fg", theme.fg);
  s.setProperty("--cc-dim", theme.dim);
  s.setProperty("--cc-muted", theme.muted);
  s.setProperty("--cc-kw", theme.kw);
  s.setProperty("--cc-fn", theme.fn);
  s.setProperty("--cc-type", theme.type);
  s.setProperty("--cc-ok", theme.ok);
  s.setProperty("--cc-macro", theme.macro);
  s.setProperty("--cc-num", theme.num);

  s.setProperty("--cc-thinking", theme.thinking);
  s.setProperty("--cc-waiting", theme.waiting);
  s.setProperty("--cc-idle", theme.idle);
  s.setProperty("--cc-error", theme.error);

  // Accent override retints both --cc-accent AND --cc-working (the "working" glow).
  // An explicit --cc-accent token override outranks the accent picker here, so
  // that it retints --cc-working too; an explicit --cc-working override then
  // beats the retint below, because overrides are applied last.
  const accentValue = overrides["--cc-accent"] || accent || theme.accent;
  s.setProperty("--cc-accent", accentValue);
  s.setProperty("--cc-working", accentValue);

  // Per-token user overrides win over everything above. Every base token is
  // rewritten on each call, so clearing an override restores the base value.
  for (const name of OVERRIDABLE_TOKENS) {
    if (name in overrides) s.setProperty(name, overrides[name]);
  }

  s.setProperty("--cc-glow-size", `${glowStrength}px`);
  root.setAttribute("data-glow", glowEnabled ? "on" : "off");

  document.body.style.background = theme.bg;
  document.body.classList.remove("scanlines");
}

export { DEFAULT_THEME_ID, DEFAULT_GLOW_SIZE };

// Exported so ThemeProvider can match `storage` events against them — a popout
// is a separate document and only learns about a theme change this way.
export {
  STORAGE_KEY as THEME_KEY, ACCENT_KEY, GLOW_KEY, GLOW_SIZE_KEY,
  TOKEN_OVERRIDES_KEY, USER_PALETTES_KEY,
};
