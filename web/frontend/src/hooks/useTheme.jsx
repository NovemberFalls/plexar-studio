/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import {
  getTheme, getSavedTheme, saveTheme, applyThemeToDOM, listThemes,
  getSavedAccent, saveAccent, getSavedGlowEnabled, saveGlowEnabled,
  getSavedGlowStrength, saveGlowStrength, DEFAULT_THEME_ID,
  OVERRIDABLE_TOKENS, TOKEN_GROUPS,
  getSavedTokenOverrides, saveTokenOverrides,
  getSavedUserPalettes, saveUserPalettes,
  sanitizeOverrides, sanitizePalettes,
  TOKEN_OVERRIDES_KEY, USER_PALETTES_KEY,
  THEME_KEY, ACCENT_KEY, GLOW_KEY, GLOW_SIZE_KEY,
} from "../themes/themeData";

const ThemeContext = createContext(null);

/**
 * Trailing-edge delay for publishing a token override to React state.
 * A color <input> fires per pointer-move; terminals rebuild their whole xterm
 * palette (and force a Canvas re-rasterize) whenever the `tokenOverrides`
 * object identity changes, so with 8 open panes an un-coalesced drag is a
 * rendering-jank generator. The custom property is still written on every
 * event, so the drag stays visually live.
 */
export const TOKEN_COMMIT_MS = 120;

/**
 * Broadcast after this hook writes settings behind the Settings section's back,
 * so `useSettings` can refetch instead of holding a copy it does not know is
 * stale. Listened for in hooks/useSettings.js.
 */
export const SETTINGS_CHANGED_EVENT = "cockpit:settings-changed";

/**
 * Persist the override map to settings.json.
 *
 * WHY THIS EXISTS — the bug it fixes: clearing an override used to write React
 * state and the localStorage mirror ONLY. But ThemeProvider's mount-time
 * /api/settings read treats a present `appearance.token_overrides` as
 * authoritative and overwrites the mirror. So "Clear token override" appeared to
 * work, and then the override came BACK on the next launch — a remedy that
 * silently un-did itself, which is the exact class of behavior we are removing.
 *
 * WHOLE MAP, ALWAYS. `appearance.token_overrides` is a WHOLE_DICT_PATH (see
 * useSettings.js): the backend REPLACES that key rather than deep-merging,
 * because a free-form map has to allow deletion. A narrow patch would silently
 * destroy every sibling override. `{}` is meaningful ("clear them all") and is
 * NOT the same as omitting the key.
 *
 * Resolves {ok: true} or {ok: false, error} — never throws, and never reports
 * success it did not get. A swallowed failure here would reproduce the original
 * bug in a new place.
 */
export async function persistTokenOverrides(map) {
  const clean = sanitizeOverrides(map);
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance: { token_overrides: clean } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return { ok: false, error: data?.error || "The settings service rejected the change." };
    }
    window.dispatchEvent(
      new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { section: "appearance" } })
    );
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not reach the settings service." };
  }
}

/** Parses a `storage` event payload. Returns undefined when unusable. */
function parseMirrorPayload(raw, sanitize) {
  if (raw === null) return {};        // key removed => a real "clear them all"
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return sanitize(parsed);
  } catch {
    return undefined;                 // corrupt: another build, or a bad write
  }
}

export function ThemeProvider({ children }) {
  const [themeId, setThemeId] = useState(() => getSavedTheme() || DEFAULT_THEME_ID);
  const [accent, setAccentState] = useState(() => getSavedAccent());
  const [glowEnabled, setGlowEnabledState] = useState(() => getSavedGlowEnabled());
  const [glowStrength, setGlowStrengthState] = useState(() => getSavedGlowStrength());
  // localStorage is a paint-on-boot MIRROR, read synchronously so there is no
  // flash of un-overridden theme. settings.json stays the source of truth and
  // is adopted over the mirror by the one-shot fetch below.
  const [tokenOverrides, setTokenOverridesState] = useState(() => getSavedTokenOverrides());
  const [userPalettes, setUserPalettesState] = useState(() => getSavedUserPalettes());

  const theme = getTheme(themeId) || getTheme(DEFAULT_THEME_ID);

  useEffect(() => {
    applyThemeToDOM(theme, { accent, glowEnabled, glowStrength, tokenOverrides });
    saveTheme(themeId);
  }, [themeId, theme, accent, glowEnabled, glowStrength, tokenOverrides]);

  const switchTheme = useCallback((id) => {
    if (getTheme(id)) setThemeId(id);
  }, []);

  const setAccent = useCallback((value) => {
    setAccentState(value);
    saveAccent(value);
  }, []);

  const setGlowEnabled = useCallback((value) => {
    setGlowEnabledState(value);
    saveGlowEnabled(value);
  }, []);

  const setGlowStrength = useCallback((value) => {
    setGlowStrengthState(value);
    saveGlowStrength(value);
  }, []);

  // `pendingRef` is the authoritative in-flight override map. Every mutation
  // goes through it, so a burst of distinct tokens accumulates instead of
  // racing stale React state, and the trailing commit always publishes the
  // final value rather than an intermediate one.
  const pendingRef = useRef(tokenOverrides);
  const commitTimerRef = useRef(null);
  // Latest paint inputs, so the immediate paint during a drag never reads a
  // stale closure and never has to be a dependency of the setters.
  const paintRef = useRef({ theme, accent, glowEnabled, glowStrength });
  useEffect(() => {
    paintRef.current = { theme, accent, glowEnabled, glowStrength };
  }, [theme, accent, glowEnabled, glowStrength]);

  const cancelPendingCommit = useCallback(() => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }, []);

  /** Publishes pendingRef to consumers + the mirror. */
  const publishOverrides = useCallback(() => {
    cancelPendingCommit();
    const map = pendingRef.current;
    setTokenOverridesState(map);
    saveTokenOverrides(map);
  }, [cancelPendingCommit]);

  /** Immediate, identity-free paint. applyThemeToDOM stays the single writer. */
  const paintOverrides = useCallback((map) => {
    const { theme: t, accent: a, glowEnabled: ge, glowStrength: gs } = paintRef.current;
    applyThemeToDOM(t, { accent: a, glowEnabled: ge, glowStrength: gs, tokenOverrides: map });
  }, []);

  const commitOverrides = useCallback((next) => {
    cancelPendingCommit();
    const clean = sanitizeOverrides(next);
    pendingRef.current = clean;
    setTokenOverridesState(clean);
    saveTokenOverrides(clean);
  }, [cancelPendingCommit]);

  const commitPalettes = useCallback((next) => {
    const clean = sanitizePalettes(next);
    setUserPalettesState(clean);
    saveUserPalettes(clean);
  }, []);

  const setTokenOverride = useCallback((name, value) => {
    if (!OVERRIDABLE_TOKENS.includes(name) || typeof value !== "string") return;
    const next = { ...pendingRef.current, [name]: value };
    pendingRef.current = next;
    paintOverrides(next);              // live feedback, no consumer churn
    cancelPendingCommit();
    commitTimerRef.current = setTimeout(publishOverrides, TOKEN_COMMIT_MS);
  }, [paintOverrides, cancelPendingCommit, publishOverrides]);

  /**
   * DISCRETE actions persist to the server; the live drag (setTokenOverride)
   * deliberately does not. A drag is a provisional edit that the tokens page
   * routes through the Settings draft and its explicit `Save changes`;
   * persisting per pointer-move would spam the endpoint and fight that draft.
   * A clear is a decision, and it has to outlive the process — see
   * persistTokenOverrides' header for the bug this closes.
   *
   * Both resolve {ok, error?} so the caller can SHOW a failure. The local clear
   * stands either way (the picker is usable again in this window immediately);
   * what a failed PUT costs is durability, and the UI says so rather than
   * implying the override is gone for good.
   */
  const clearTokenOverride = useCallback((name) => {
    if (!(name in pendingRef.current)) return Promise.resolve({ ok: true, changed: false });
    const next = { ...pendingRef.current };
    delete next[name];
    commitOverrides(next);             // discrete action: publish at once
    return persistTokenOverrides(next);
  }, [commitOverrides]);

  const resetTokenOverrides = useCallback(() => {
    commitOverrides({});
    return persistTokenOverrides({});  // {} means "clear them all", not "leave alone"
  }, [commitOverrides]);

  // A drag that is still mid-flight when the window closes must not be lost.
  useEffect(() => () => {
    if (commitTimerRef.current !== null) {
      clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
      saveTokenOverrides(pendingRef.current);
    }
  }, []);

  const savePalette = useCallback((name) => {
    const key = typeof name === "string" ? name.trim() : "";
    if (!key) return;
    setUserPalettesState((prev) => {
      // pendingRef, not state: a palette saved while a color drag is still
      // settling must capture the value the user is actually looking at.
      const next = { ...prev, [key]: { base: themeId, overrides: { ...pendingRef.current } } };
      saveUserPalettes(next);
      return next;
    });
  }, [themeId]);

  const applyPalette = useCallback((name) => {
    const entry = userPalettes[name];
    if (!entry) return;
    if (getTheme(entry.base)) setThemeId(entry.base);
    commitOverrides(entry.overrides);
  }, [userPalettes, commitOverrides]);

  const deletePalette = useCallback((name) => {
    setUserPalettesState((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      saveUserPalettes(next);
      return next;
    });
  }, []);

  /**
   * Reconciles from settings.json. A present key — even an empty object —
   * is authoritative ("no overrides"); an absent key leaves the mirror alone.
   */
  const adoptServerTheme = useCallback((payload) => {
    if (!payload || typeof payload !== "object") return;
    if (payload.tokenOverrides !== undefined) commitOverrides(payload.tokenOverrides);
    if (payload.userPalettes !== undefined) commitPalettes(payload.userPalettes);
  }, [commitOverrides, commitPalettes]);

  // One best-effort read of the server's intent on mount. Any failure leaves
  // the mirror painted and reports nothing — a down settings endpoint must
  // never leave the app unstyled.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings");
        if (!res.ok) return;
        const data = await res.json();
        const appearance = data?.settings?.appearance;
        if (cancelled || !appearance || typeof appearance !== "object") return;
        adoptServerTheme({
          tokenOverrides: appearance.token_overrides,
          userPalettes: appearance.user_palettes,
        });
      } catch { /* mirror stands */ }
    })();
    return () => { cancelled = true; };
  }, [adoptServerTheme]);

  /**
   * A popout terminal is a SEPARATE DOCUMENT with its own ThemeProvider. It
   * hydrates from the mirror at mount, but without this listener it would keep
   * the palette it booted with until it is closed and reopened — two windows
   * side by side in different colors. `storage` fires only in OTHER documents,
   * never the one that wrote, so adopting here cannot loop; and localStorage
   * does not fire an event when the written value is unchanged, so the
   * write-back inside these state paths cannot ping-pong either.
   *
   * Payloads are untrusted (another window may be running a different build),
   * so they go through exactly the same sanitizers as a mount-time read.
   */
  useEffect(() => {
    const onStorage = (e) => {
      if (!e || !e.key) return;       // e.key === null means "storage cleared"
      switch (e.key) {
        case TOKEN_OVERRIDES_KEY: {
          const next = parseMirrorPayload(e.newValue, sanitizeOverrides);
          if (next !== undefined) commitOverrides(next);
          break;
        }
        case USER_PALETTES_KEY: {
          const next = parseMirrorPayload(e.newValue, sanitizePalettes);
          if (next !== undefined) commitPalettes(next);
          break;
        }
        case THEME_KEY:
          if (getTheme(e.newValue)) setThemeId(e.newValue);
          break;
        case ACCENT_KEY:
          setAccentState(e.newValue || null);
          break;
        case GLOW_KEY:
          if (e.newValue === "on" || e.newValue === "off") {
            setGlowEnabledState(e.newValue === "on");
          }
          break;
        case GLOW_SIZE_KEY: {
          const n = parseInt(e.newValue, 10);
          if (Number.isFinite(n)) setGlowStrengthState(n);
          break;
        }
        default:
          break;                      // not ours
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [commitOverrides, commitPalettes]);

  return (
    <ThemeContext.Provider
      value={{
        themeId, theme, switchTheme, themes: listThemes(),
        accent, setAccent, glowEnabled, setGlowEnabled, glowStrength, setGlowStrength,
        tokenOverrides,
        overrideCount: Object.keys(tokenOverrides).length,
        setTokenOverride, clearTokenOverride, resetTokenOverrides,
        persistTokenOverrides,
        userPalettes, savePalette, applyPalette, deletePalette,
        adoptServerTheme,
        tokenGroups: TOKEN_GROUPS,
        overridableTokens: OVERRIDABLE_TOKENS,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/**
 * Non-throwing variant for components that must render even without a
 * ThemeProvider ancestor (e.g. HexGrid inside ErrorBoundary's fallback).
 * Returns the real context when available; falls back to the default theme
 * so purely decorative components stay functional without crashing.
 */
export function useThemeSafe() {
  const ctx = useContext(ThemeContext);
  if (ctx) return ctx;
  const defaultTheme = getTheme(DEFAULT_THEME_ID);
  return {
    themeId: DEFAULT_THEME_ID,
    theme: defaultTheme,
    switchTheme: () => {},
    themes: listThemes(),
    accent: null,
    setAccent: () => {},
    glowEnabled: true,
    setGlowEnabled: () => {},
    glowStrength: 30,
    setGlowStrength: () => {},
    tokenOverrides: {},
    overrideCount: 0,
    setTokenOverride: () => {},
    clearTokenOverride: () => Promise.resolve({ ok: true, changed: false }),
    resetTokenOverrides: () => Promise.resolve({ ok: true }),
    persistTokenOverrides: () => Promise.resolve({ ok: true }),
    userPalettes: {},
    savePalette: () => {},
    applyPalette: () => {},
    deletePalette: () => {},
    adoptServerTheme: () => {},
    tokenGroups: TOKEN_GROUPS,
    overridableTokens: OVERRIDABLE_TOKENS,
  };
}
