import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { THEMES, applyThemeToDOM } from "../themes/themeData";
import AppBackground from "../components/AppBackground";
import { ThemeProvider } from "../hooks/useTheme";

const SURFACES = ["--cc-bg", "--cc-bg2", "--cc-surface", "--cc-elev", "--cc-term"];
const snapshot = () => {
  const s = document.documentElement.style;
  const out = {};
  for (let i = 0; i < s.length; i++) out[s[i]] = s.getPropertyValue(s[i]);
  return out;
};
const theme = Object.values(THEMES)[0];

describe("applyThemeToDOM background", () => {
  afterEach(() => document.documentElement.removeAttribute("style"));

  it("writes identical properties with the feature off, absent or inactive", () => {
    applyThemeToDOM(theme, {});
    const baseline = snapshot();
    applyThemeToDOM(theme, { background: { active: false, paneOpacity: 0.4 } });
    expect(snapshot()).toEqual(baseline);
    for (const n of SURFACES) expect(baseline[n]).not.toMatch(/color-mix/);
  });

  it("makes only the five surface tokens translucent when active", () => {
    applyThemeToDOM(theme, {});
    const baseline = snapshot();
    applyThemeToDOM(theme, { background: { active: true, paneOpacity: 0.6 } });
    const on = snapshot();
    for (const n of SURFACES) expect(on[n]).toBe(`color-mix(in srgb, ${baseline[n]} 60%, transparent)`);
    for (const k of Object.keys(baseline)) {
      if (!SURFACES.includes(k)) expect(on[k]).toBe(baseline[k]);
    }
    // and turning it off restores the exact original values
    applyThemeToDOM(theme, { background: { active: false, paneOpacity: 0.6 } });
    expect(snapshot()).toEqual(baseline);
  });
});

describe("AppBackground", () => {
  const mockFetch = (bg, set) => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/settings") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ settings: { appearance: { background: bg } } }) });
      }
      if (url === "/api/background") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ set, version: "v1" }) });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    });
  };
  beforeEach(() => cleanup());
  afterEach(() => document.documentElement.removeAttribute("style"));

  it("renders the image layer only when enabled and an image is set", async () => {
    mockFetch({ enabled: true, dim: 0.4, blur: 6, pane_opacity: 0.7 }, true);
    render(<ThemeProvider><AppBackground /></ThemeProvider>);
    const img = await screen.findByTestId("app-background-image");
    expect(img.style.backgroundImage).toContain("/api/background/image?v=v1");
    expect(img.style.filter).toBe("blur(6px)");
    expect(screen.getByTestId("app-background-dim").style.opacity).toBe("0.4");
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--cc-surface")).toMatch(/color-mix.*70%/));
  });

  it("renders nothing when disabled or when no image is set", async () => {
    mockFetch({ enabled: false }, true);
    const { unmount } = render(<ThemeProvider><AppBackground /></ThemeProvider>);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/background"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("app-background")).toBeNull();
    unmount();
    mockFetch({ enabled: true }, false);
    render(<ThemeProvider><AppBackground /></ThemeProvider>);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("/api/background"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId("app-background")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--cc-surface")).not.toMatch(/color-mix/);
  });
});
