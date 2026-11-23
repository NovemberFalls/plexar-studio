import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { THEMES, applyThemeToDOM } from "../themes/themeData";
import AppBackground from "../components/AppBackground";
import { advance, frameDurationMs, coverRect } from "../utils/backgroundFrames";
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

describe("frameDelayMs / coverRect", () => {
  it("accumulates progress with carry, speed, a dt cap and a 100 ms default", () => {
    const a = (progressMs, dtMs, speed, durationMs) => advance({ progressMs, dtMs, speed, durationMs });
    expect(a(0, 250, 1, 250)).toEqual({ progressMs: 0, steps: 1 });
    expect(a(0, 125, 2, 500)).toEqual({ progressMs: 250, steps: 0 });   // speed 2: half the real time
    expect(a(250, 125, 2, 500)).toEqual({ progressMs: 0, steps: 1 });
    expect(a(0, 200, 0, 100)).toEqual({ progressMs: 0, steps: 0 });     // paused
    expect(a(30, 100, 1, 100)).toEqual({ progressMs: 30, steps: 1 });   // remainder carried
    expect(a(0, 100, 4, 50)).toEqual({ progressMs: 0, steps: 8 });      // several steps in one tick
    expect(a(0, 5000, 1, 1000)).toEqual({ progressMs: 250, steps: 0 });   // dt capped at 250
    expect(a(0, 100, 1, 0)).toEqual({ progressMs: 0, steps: 1 });       // missing duration = 100
    expect(frameDurationMs(500000)).toBe(500);
    expect(frameDurationMs(0)).toBe(100);
    expect(frameDurationMs(undefined)).toBe(100);
  });
  it("covers a box, centred and cropped", () => {
    expect(coverRect(200, 100, 100, 200)).toEqual({ dx: -150, dy: 0, dw: 400, dh: 200 });
    expect(coverRect(100, 200, 200, 100)).toEqual({ dx: 0, dy: -150, dw: 200, dh: 400 });
  });
});

describe("AppBackground animated path", () => {
  const mockFetch = (type) => {
    globalThis.fetch = vi.fn((url) => {
      if (url === "/api/settings") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ settings: { appearance: { background: { enabled: true } } } }) });
      }
      if (url === "/api/background") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ set: true, version: "v1", type }) });
      }
      return Promise.resolve({ ok: true, body: {}, json: () => Promise.resolve({}) });
    });
  };
  beforeEach(() => cleanup());
  afterEach(() => { delete globalThis.ImageDecoder; });

  it("keeps the CSS background when ImageDecoder is missing", async () => {
    mockFetch("image/gif");
    render(<ThemeProvider><AppBackground /></ThemeProvider>);
    await screen.findByTestId("app-background-image");
    expect(screen.queryByTestId("app-background-canvas")).toBeNull();
  });

  it("renders a canvas for a multi-frame image", async () => {
    mockFetch("image/gif");
    globalThis.ImageDecoder = class {
      constructor() {
        this.tracks = { ready: Promise.resolve(), selectedTrack: { frameCount: 3 } };
        this.completed = Promise.resolve();
      }
      decode() { return Promise.reject(new Error("no frames in jsdom")); }
      close() {}
    };
    render(<ThemeProvider><AppBackground /></ThemeProvider>);
    await screen.findByTestId("app-background-canvas");
    expect(screen.queryByTestId("app-background-image")).toBeNull();
  });
});
