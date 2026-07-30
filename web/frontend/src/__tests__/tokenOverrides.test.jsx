/**
 * Phase 5 theming core — per-token `--cc-*` overrides and named user palettes.
 *
 * applyThemeToDOM is the single writer of every color in the app, so these
 * tests pin the parts that are easy to break silently: override precedence
 * (including the accent → --cc-working retint), restore-on-clear, sanitizing
 * of a corrupt mirror, and the server-adoption path staying non-fatal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  THEMES, getTheme, applyThemeToDOM, DEFAULT_THEME_ID,
  OVERRIDABLE_TOKENS, TOKEN_GROUPS,
  getSavedTokenOverrides, saveTokenOverrides,
  getSavedUserPalettes, saveUserPalettes,
} from "../themes/themeData.js";
import { ThemeProvider, useTheme, useThemeSafe, TOKEN_COMMIT_MS } from "../hooks/useTheme.jsx";

const theme = THEMES[DEFAULT_THEME_ID];
const styleOf = (name) => document.documentElement.style.getPropertyValue(name);

function clearRootStyle() {
  document.documentElement.setAttribute("style", "");
}

beforeEach(() => {
  localStorage.clear();
  clearRootStyle();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Token list integrity ────────────────────────────────────────────────────

describe("OVERRIDABLE_TOKENS", () => {
  const css = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.css"),
    "utf8",
  );
  const rootBlock = css.slice(css.indexOf(":root"), css.indexOf("}", css.indexOf(":root")));

  it.each(OVERRIDABLE_TOKENS)("%s is declared in index.css :root", (token) => {
    expect(rootBlock).toContain(`${token}:`);
  });

  it("has no duplicates", () => {
    expect(new Set(OVERRIDABLE_TOKENS).size).toBe(OVERRIDABLE_TOKENS.length);
  });

  it("is exactly the union of TOKEN_GROUPS members", () => {
    const grouped = TOKEN_GROUPS.flatMap((g) => g.tokens);
    expect(new Set(grouped)).toEqual(new Set(OVERRIDABLE_TOKENS));
    expect(grouped).toHaveLength(OVERRIDABLE_TOKENS.length);
  });

  it("gives every group an id, label and note", () => {
    for (const g of TOKEN_GROUPS) {
      expect(g.id).toBeTruthy();
      expect(g.label).toBeTruthy();
      expect(typeof g.note).toBe("string");
      expect(g.note.length).toBeGreaterThan(0);
    }
  });
});

// ── applyThemeToDOM precedence ──────────────────────────────────────────────

describe("applyThemeToDOM with tokenOverrides", () => {
  it("lets an override beat the base theme value", () => {
    applyThemeToDOM(theme, { tokenOverrides: { "--cc-bg": "#123456" } });
    expect(styleOf("--cc-bg")).toBe("#123456");
    expect(styleOf("--cc-fg")).toBe(theme.fg);
  });

  it("lets a --cc-working override beat the accent retint", () => {
    applyThemeToDOM(theme, {
      accent: "#ff0000",
      tokenOverrides: { "--cc-working": "#00ff00" },
    });
    expect(styleOf("--cc-accent")).toBe("#ff0000");
    expect(styleOf("--cc-working")).toBe("#00ff00");
  });

  it("retints --cc-working from a --cc-accent override when working is not overridden", () => {
    applyThemeToDOM(theme, { tokenOverrides: { "--cc-accent": "#abcdef" } });
    expect(styleOf("--cc-accent")).toBe("#abcdef");
    expect(styleOf("--cc-working")).toBe("#abcdef");
  });

  it("prefers a --cc-accent override over the accent picker", () => {
    applyThemeToDOM(theme, {
      accent: "#ff0000",
      tokenOverrides: { "--cc-accent": "#abcdef" },
    });
    expect(styleOf("--cc-accent")).toBe("#abcdef");
    expect(styleOf("--cc-working")).toBe("#abcdef");
  });

  it("honors both overrides at once", () => {
    applyThemeToDOM(theme, {
      tokenOverrides: { "--cc-accent": "#abcdef", "--cc-working": "#00ff00" },
    });
    expect(styleOf("--cc-accent")).toBe("#abcdef");
    expect(styleOf("--cc-working")).toBe("#00ff00");
  });

  it("restores the base value when an override is cleared", () => {
    applyThemeToDOM(theme, { tokenOverrides: { "--cc-surface": "#001122" } });
    expect(styleOf("--cc-surface")).toBe("#001122");
    applyThemeToDOM(theme, { tokenOverrides: {} });
    expect(styleOf("--cc-surface")).toBe(theme.surface);
  });

  it("restores the theme accent for --cc-working when its override is cleared", () => {
    applyThemeToDOM(theme, { tokenOverrides: { "--cc-working": "#00ff00" } });
    expect(styleOf("--cc-working")).toBe("#00ff00");
    applyThemeToDOM(theme, { tokenOverrides: {} });
    expect(styleOf("--cc-working")).toBe(theme.accent);
  });

  it("ignores unknown keys and never writes them to the DOM", () => {
    applyThemeToDOM(theme, {
      tokenOverrides: { "--cc-not-a-token": "#ff0000", "--evil": "red", "--cc-bg": "#123456" },
    });
    expect(styleOf("--cc-not-a-token")).toBe("");
    expect(styleOf("--evil")).toBe("");
    expect(styleOf("--cc-bg")).toBe("#123456");
  });

  it("ignores non-string override values", () => {
    applyThemeToDOM(theme, { tokenOverrides: { "--cc-bg": 42, "--cc-fg": null } });
    expect(styleOf("--cc-bg")).toBe(theme.bg);
    expect(styleOf("--cc-fg")).toBe(theme.fg);
  });

  it("tolerates junk in the tokenOverrides slot", () => {
    for (const junk of [null, undefined, "nope", 5, []]) {
      expect(() => applyThemeToDOM(theme, { tokenOverrides: junk })).not.toThrow();
      expect(styleOf("--cc-bg")).toBe(theme.bg);
    }
  });

  it("applies every theme with overrides without throwing", () => {
    const overrides = Object.fromEntries(OVERRIDABLE_TOKENS.map((t) => [t, "#010203"]));
    for (const t of Object.values(THEMES)) {
      expect(() => applyThemeToDOM(t, { tokenOverrides: overrides })).not.toThrow();
      expect(() => applyThemeToDOM(t)).not.toThrow();
      expect(styleOf("--cc-bg")).toBe(t.bg);
    }
  });
});

// ── Storage mirror ──────────────────────────────────────────────────────────

describe("token override mirror", () => {
  it("round-trips a map", () => {
    saveTokenOverrides({ "--cc-bg": "#111111" });
    expect(getSavedTokenOverrides()).toEqual({ "--cc-bg": "#111111" });
  });

  it("returns {} when absent", () => {
    expect(getSavedTokenOverrides()).toEqual({});
  });

  it("degrades to no overrides on corrupt JSON", () => {
    localStorage.setItem("cockpit-token-overrides", "{not json");
    expect(getSavedTokenOverrides()).toEqual({});
  });

  it("strips unknown keys and non-strings on read", () => {
    localStorage.setItem(
      "cockpit-token-overrides",
      JSON.stringify({ "--cc-bg": "#111111", "--bogus": "#222", "--cc-fg": 7 }),
    );
    expect(getSavedTokenOverrides()).toEqual({ "--cc-bg": "#111111" });
  });

  it("clears storage when saving an empty map", () => {
    saveTokenOverrides({ "--cc-bg": "#111111" });
    saveTokenOverrides({});
    expect(localStorage.getItem("cockpit-token-overrides")).toBeNull();
  });

  it("round-trips palettes and drops malformed entries", () => {
    saveUserPalettes({
      good: { base: "cockpit-blue", overrides: { "--cc-bg": "#111111", "--bad": "x" } },
      broken: "nope",
    });
    expect(getSavedUserPalettes()).toEqual({
      good: { base: "cockpit-blue", overrides: { "--cc-bg": "#111111" } },
    });
  });

  it("degrades to no palettes on corrupt JSON", () => {
    localStorage.setItem("cockpit-user-palettes", "[[[");
    expect(getSavedUserPalettes()).toEqual({});
  });
});

// ── Context API ─────────────────────────────────────────────────────────────

function renderTheme() {
  return renderHook(() => useTheme(), { wrapper: ThemeProvider });
}

/** Fake-timer helper: run a token write and let the trailing commit fire. */
function settle() {
  act(() => { vi.advanceTimersByTime(TOKEN_COMMIT_MS + 20); });
}

describe("ThemeProvider token override API", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ settings: { appearance: {} } }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("paints and mirrors setTokenOverride", async () => {
    const { result } = renderTheme();
    act(() => result.current.setTokenOverride("--cc-bg", "#123456"));
    settle();
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#123456" });
    expect(result.current.overrideCount).toBe(1);
    expect(styleOf("--cc-bg")).toBe("#123456");
    expect(getSavedTokenOverrides()).toEqual({ "--cc-bg": "#123456" });
  });

  it("rejects unknown tokens and non-string values", () => {
    const { result } = renderTheme();
    act(() => result.current.setTokenOverride("--nope", "#123456"));
    act(() => result.current.setTokenOverride("--cc-bg", 42));
    settle();
    expect(result.current.tokenOverrides).toEqual({});
  });

  it("restores the base paint on clearTokenOverride", () => {
    const { result } = renderTheme();
    act(() => result.current.setTokenOverride("--cc-surface", "#001122"));
    settle();
    act(() => result.current.clearTokenOverride("--cc-surface"));
    expect(result.current.tokenOverrides).toEqual({});
    expect(styleOf("--cc-surface")).toBe(theme.surface);
    expect(localStorage.getItem("cockpit-token-overrides")).toBeNull();
  });

  it("resets every override at once", () => {
    const { result } = renderTheme();
    act(() => {
      result.current.setTokenOverride("--cc-bg", "#111111");
      result.current.setTokenOverride("--cc-fg", "#222222");
    });
    settle();
    expect(result.current.overrideCount).toBe(2);
    act(() => result.current.resetTokenOverrides());
    expect(result.current.overrideCount).toBe(0);
    expect(styleOf("--cc-bg")).toBe(theme.bg);
    expect(styleOf("--cc-fg")).toBe(theme.fg);
  });

  it("paints from the mirror on mount", () => {
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#0f0f0f" });
    expect(styleOf("--cc-bg")).toBe("#0f0f0f");
  });

  it("round-trips palette save / apply / delete", () => {
    const { result } = renderTheme();
    act(() => {
      result.current.switchTheme("cockpit-blue");
      result.current.setTokenOverride("--cc-bg", "#123456");
    });
    settle();
    act(() => result.current.savePalette("  Mine  "));
    expect(result.current.userPalettes.Mine).toEqual({
      base: "cockpit-blue",
      overrides: { "--cc-bg": "#123456" },
    });
    expect(getSavedUserPalettes().Mine).toBeTruthy();

    act(() => {
      result.current.switchTheme("va-night");
      result.current.resetTokenOverrides();
    });
    expect(result.current.overrideCount).toBe(0);

    act(() => result.current.applyPalette("Mine"));
    expect(result.current.themeId).toBe("cockpit-blue");
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#123456" });
    expect(styleOf("--cc-bg")).toBe("#123456");

    act(() => result.current.deletePalette("Mine"));
    expect(result.current.userPalettes).toEqual({});
    expect(localStorage.getItem("cockpit-user-palettes")).toBeNull();
  });

  it("overwrites an existing palette name", () => {
    const { result } = renderTheme();
    act(() => result.current.setTokenOverride("--cc-bg", "#111111"));
    settle();
    act(() => result.current.savePalette("p"));
    act(() => result.current.setTokenOverride("--cc-bg", "#222222"));
    settle();
    act(() => result.current.savePalette("p"));
    expect(Object.keys(result.current.userPalettes)).toEqual(["p"]);
    expect(result.current.userPalettes.p.overrides).toEqual({ "--cc-bg": "#222222" });
  });

  it("rejects a blank palette name silently", () => {
    const { result } = renderTheme();
    act(() => result.current.savePalette("   "));
    act(() => result.current.savePalette(null));
    expect(result.current.userPalettes).toEqual({});
  });

  it("ignores applyPalette / deletePalette for unknown names", () => {
    const { result } = renderTheme();
    expect(() => act(() => result.current.applyPalette("ghost"))).not.toThrow();
    expect(() => act(() => result.current.deletePalette("ghost"))).not.toThrow();
    expect(result.current.tokenOverrides).toEqual({});
  });

  it("adopts a server map via adoptServerTheme", () => {
    const { result } = renderTheme();
    act(() => result.current.adoptServerTheme({
      tokenOverrides: { "--cc-bg": "#654321", "--junk": "x" },
      userPalettes: { srv: { base: "va-night", overrides: {} } },
    }));
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#654321" });
    expect(styleOf("--cc-bg")).toBe("#654321");
    expect(result.current.userPalettes.srv).toBeTruthy();
  });

  it("treats a present-but-empty server map as authoritative", () => {
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    act(() => result.current.adoptServerTheme({ tokenOverrides: {} }));
    expect(result.current.tokenOverrides).toEqual({});
    expect(styleOf("--cc-bg")).toBe(theme.bg);
  });

  it("leaves the mirror alone for keys the server omits", () => {
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    act(() => result.current.adoptServerTheme({ userPalettes: {} }));
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#0f0f0f" });
  });
});

describe("ThemeProvider server reconciliation", () => {
  it("adopts appearance.token_overrides from GET /api/settings", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        settings: {
          appearance: {
            token_overrides: { "--cc-bg": "#5a5a5a" },
            user_palettes: { srv: { base: "cockpit-blue", overrides: {} } },
          },
        },
      }),
    });
    const { result } = renderTheme();
    await waitFor(() => {
      expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#5a5a5a" });
    });
    expect(styleOf("--cc-bg")).toBe("#5a5a5a");
    expect(result.current.userPalettes.srv).toBeTruthy();
  });

  it("keeps the mirror painted when the settings fetch rejects", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    await waitFor(() => expect(styleOf("--cc-bg")).toBe("#0f0f0f"));
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#0f0f0f" });
  });

  it("keeps the mirror painted on a non-ok response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({ ok: false, json: async () => ({}) });
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    await waitFor(() => expect(styleOf("--cc-bg")).toBe("#0f0f0f"));
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#0f0f0f" });
  });

  it("keeps the mirror painted when the response body is junk", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => "not an object",
    });
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    await waitFor(() => expect(styleOf("--cc-bg")).toBe("#0f0f0f"));
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#0f0f0f" });
  });
});

// ── Coalescing (drag jank) ──────────────────────────────────────────────────

describe("setTokenOverride coalescing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ settings: { appearance: {} } }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("paints immediately but does not publish to consumers yet", () => {
    const { result } = renderTheme();
    const before = result.current.tokenOverrides;
    act(() => result.current.setTokenOverride("--cc-bg", "#010101"));
    // Visually live...
    expect(styleOf("--cc-bg")).toBe("#010101");
    // ...but consumers (terminals) have not been churned.
    expect(result.current.tokenOverrides).toBe(before);
    expect(result.current.overrideCount).toBe(0);
  });

  it("keeps one stable identity across a whole drag, then publishes once", () => {
    const { result } = renderTheme();
    const identities = new Set([result.current.tokenOverrides]);
    for (const v of ["#100000", "#200000", "#300000", "#400000", "#500000"]) {
      act(() => result.current.setTokenOverride("--cc-bg", v));
      identities.add(result.current.tokenOverrides);
      expect(styleOf("--cc-bg")).toBe(v);   // live the whole way
    }
    expect(identities.size).toBe(1);        // zero consumer churn mid-drag
    settle();
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#500000" });
  });

  it("ends a settled drag with the final value, never an intermediate", () => {
    const { result } = renderTheme();
    act(() => result.current.setTokenOverride("--cc-bg", "#aaaaaa"));
    act(() => { vi.advanceTimersByTime(TOKEN_COMMIT_MS - 20); });
    act(() => result.current.setTokenOverride("--cc-bg", "#bbbbbb"));
    act(() => { vi.advanceTimersByTime(TOKEN_COMMIT_MS - 20); });
    act(() => result.current.setTokenOverride("--cc-bg", "#cccccc"));
    settle();
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#cccccc" });
    expect(getSavedTokenOverrides()).toEqual({ "--cc-bg": "#cccccc" });
    expect(styleOf("--cc-bg")).toBe("#cccccc");
  });

  it("loses no writes across a rapid sequence of distinct tokens", () => {
    const { result } = renderTheme();
    const writes = {
      "--cc-bg": "#111111", "--cc-fg": "#222222", "--cc-surface": "#333333",
      "--cc-accent": "#444444", "--cc-kw": "#555555", "--cc-num": "#666666",
    };
    for (const [k, v] of Object.entries(writes)) {
      act(() => result.current.setTokenOverride(k, v));
      act(() => { vi.advanceTimersByTime(5) });   // faster than the settle edge
    }
    settle();
    expect(result.current.tokenOverrides).toEqual(writes);
    expect(getSavedTokenOverrides()).toEqual(writes);
  });

  it("flushes an in-flight drag to the mirror on unmount", () => {
    const { result, unmount } = renderTheme();
    act(() => result.current.setTokenOverride("--cc-bg", "#dddddd"));
    expect(getSavedTokenOverrides()).toEqual({});   // not yet committed
    unmount();
    expect(getSavedTokenOverrides()).toEqual({ "--cc-bg": "#dddddd" });
  });

  it("publishes a pending drag value when a palette is saved mid-drag", () => {
    const { result } = renderTheme();
    act(() => result.current.setTokenOverride("--cc-bg", "#eeeeee"));
    act(() => result.current.savePalette("mid"));
    expect(result.current.userPalettes.mid.overrides).toEqual({ "--cc-bg": "#eeeeee" });
  });

  it("clearTokenOverride cancels a pending commit for that token", () => {
    const { result } = renderTheme();
    act(() => result.current.setTokenOverride("--cc-bg", "#f0f0f0"));
    act(() => result.current.clearTokenOverride("--cc-bg"));
    settle();
    expect(result.current.tokenOverrides).toEqual({});
    expect(styleOf("--cc-bg")).toBe(theme.bg);
  });
});

// ── Cross-document sync (popouts) ───────────────────────────────────────────

function fireStorage(key, newValue) {
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
}

describe("cross-document storage sync", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ settings: { appearance: {} } }),
    });
  });

  it("repaints when another window writes the overrides mirror", () => {
    const { result } = renderTheme();
    fireStorage("cockpit-token-overrides", JSON.stringify({ "--cc-bg": "#5b5b5b" }));
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#5b5b5b" });
    expect(styleOf("--cc-bg")).toBe("#5b5b5b");
  });

  it("adopts palettes written by another window", () => {
    const { result } = renderTheme();
    fireStorage("cockpit-user-palettes", JSON.stringify({
      other: { base: "cockpit-blue", overrides: { "--cc-fg": "#0a0a0a" } },
    }));
    expect(result.current.userPalettes.other).toEqual({
      base: "cockpit-blue", overrides: { "--cc-fg": "#0a0a0a" },
    });
  });

  it("sanitizes a foreign payload from a different build", () => {
    const { result } = renderTheme();
    fireStorage("cockpit-token-overrides", JSON.stringify({
      "--cc-bg": "#5b5b5b", "--cc-future-token": "#ffffff", "--cc-fg": 9,
    }));
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#5b5b5b" });
    expect(styleOf("--cc-future-token")).toBe("");
  });

  it("ignores a corrupt payload without throwing or clearing overrides", () => {
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    for (const junk of ["{not json", "[1,2,3]", "\"a string\"", "null"]) {
      expect(() => fireStorage("cockpit-token-overrides", junk)).not.toThrow();
      expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#0f0f0f" });
    }
    expect(styleOf("--cc-bg")).toBe("#0f0f0f");
  });

  it("treats key removal as a real clear", () => {
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    fireStorage("cockpit-token-overrides", null);
    expect(result.current.tokenOverrides).toEqual({});
    expect(styleOf("--cc-bg")).toBe(theme.bg);
  });

  it("ignores unrelated keys", () => {
    saveTokenOverrides({ "--cc-bg": "#0f0f0f" });
    const { result } = renderTheme();
    fireStorage("cockpit-terminal-zoom", "18");
    fireStorage("some-other-app", "{}");
    fireStorage(null, null);            // storage.clear()
    expect(result.current.tokenOverrides).toEqual({ "--cc-bg": "#0f0f0f" });
    expect(result.current.themeId).toBe(DEFAULT_THEME_ID);
  });

  it("syncs theme, accent and glow across documents too", () => {
    const { result } = renderTheme();
    fireStorage("cockpit-theme", "cockpit-blue");
    expect(result.current.themeId).toBe("cockpit-blue");
    fireStorage("cockpit-accent", "#ff00ff");
    expect(result.current.accent).toBe("#ff00ff");
    expect(styleOf("--cc-accent")).toBe("#ff00ff");
    fireStorage("cockpit-glow", "off");
    expect(result.current.glowEnabled).toBe(false);
    fireStorage("cockpit-glow-size", "42");
    expect(result.current.glowStrength).toBe(42);
    expect(styleOf("--cc-glow-size")).toBe("42px");
  });

  it("ignores invalid theme / glow payloads", () => {
    const { result } = renderTheme();
    fireStorage("cockpit-theme", "no-such-theme");
    expect(result.current.themeId).toBe(DEFAULT_THEME_ID);
    fireStorage("cockpit-glow", "maybe");
    expect(result.current.glowEnabled).toBe(true);
    fireStorage("cockpit-glow-size", "huge");
    expect(result.current.glowStrength).toBe(30);
  });
});

describe("useThemeSafe", () => {
  it("exposes the new keys with inert defaults and no provider", () => {
    const { result } = renderHook(() => useThemeSafe());
    const ctx = result.current;
    expect(ctx.theme).toEqual(getTheme(DEFAULT_THEME_ID));
    expect(ctx.tokenOverrides).toEqual({});
    expect(ctx.overrideCount).toBe(0);
    expect(ctx.userPalettes).toEqual({});
    expect(ctx.tokenGroups).toBe(TOKEN_GROUPS);
    expect(ctx.overridableTokens).toBe(OVERRIDABLE_TOKENS);
    for (const fn of [
      "setTokenOverride", "clearTokenOverride", "resetTokenOverrides",
      "savePalette", "applyPalette", "deletePalette", "adoptServerTheme",
    ]) {
      expect(typeof ctx[fn]).toBe("function");
      expect(() => ctx[fn]("x", "y")).not.toThrow();
    }
  });
});
