/**
 * ThemeSettings — Settings ▸ Theme & glow page.
 *
 * The contract under test:
 *   - both real palettes render and picking one calls switchTheme AND writes
 *     appearance.theme
 *   - NO dark/light variant control is rendered. This is asserted as an ABSENCE
 *     because the design handoff promises a variant toggle that cannot exist:
 *     themeData ships two palettes and both are dark.
 *   - the accent control performs BOTH writes (setAccent + appearance.accent)
 *   - the glow toggle and the step-2 size slider each perform both writes
 *   - with a --cc-accent override active, the supersession note and its Clear
 *     action appear, and clicking Clear calls clearTokenOverride. This is the
 *     behaviour re-homed from ThemePopover; losing it in the move would restore
 *     a silently-dead accent picker.
 *   - a FAILED persist surfaces a role="alert" rather than pretending it worked
 *
 * useTheme is mocked so the page is testable without the theming plumbing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import ThemeSettings from "../components/settings/ThemeSettings.jsx";

const PALETTES = [
  {
    id: "va-night",
    label: "Visual Assist Night",
    group: "dark",
    bg: "#1a1a1a",
    surface: "#212121",
    accent: "#4ea1e8",
    fn: "#ffc66d",
    ok: "#7fb86a",
    error: "#e0698a",
  },
  {
    id: "cockpit-blue",
    label: "Cockpit Blue",
    group: "dark",
    bg: "#0f1620",
    surface: "#16202c",
    accent: "#4ea1e8",
    fn: "#ffc66d",
    ok: "#7fb86a",
    error: "#e0698a",
  },
];

let themeApi;

vi.mock("../hooks/useTheme.jsx", () => ({
  useTheme: () => themeApi,
}));

function makeTheme({
  themeId = "va-night",
  accent = null,
  glowEnabled = true,
  glowStrength = 30,
  tokenOverrides = {},
  clearResult = { ok: true },
} = {}) {
  return {
    themeId,
    theme: PALETTES.find((p) => p.id === themeId),
    themes: PALETTES,
    switchTheme: vi.fn(),
    accent,
    setAccent: vi.fn(),
    glowEnabled,
    setGlowEnabled: vi.fn(),
    glowStrength,
    setGlowStrength: vi.fn(),
    tokenOverrides,
    clearTokenOverride: vi.fn().mockResolvedValue(clearResult),
  };
}

/** A minimal stand-in for the Settings shell's draft store. */
function makeShell({ draft = {}, dirtyPaths = [] } = {}) {
  return {
    get: (path, fallback) => (path in draft ? draft[path] : fallback),
    setField: vi.fn(),
    isDirty: (path) => dirtyPaths.some((p) => p === path || p.startsWith(`${path}.`)),
  };
}

function setup({ theme = {}, shell = {} } = {}) {
  themeApi = makeTheme(theme);
  const props = makeShell(shell);
  render(<ThemeSettings {...props} />);
  return { props, themeApi };
}

/** The last value written to a given settings path. */
function lastWrite(setField, path) {
  const calls = setField.mock.calls.filter((c) => c[0] === path);
  return calls.length ? calls[calls.length - 1][1] : undefined;
}

describe("ThemeSettings", () => {
  beforeEach(() => {
    themeApi = makeTheme();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("base palette", () => {
    it("renders both real palettes", () => {
      setup();
      expect(screen.getByTestId("palette-va-night")).toBeInTheDocument();
      expect(screen.getByTestId("palette-cockpit-blue")).toBeInTheDocument();
      expect(screen.getByText("Visual Assist Night")).toBeInTheDocument();
      expect(screen.getByText("Cockpit Blue")).toBeInTheDocument();
    });

    it("marks the active palette pressed and the other not", () => {
      setup({ theme: { themeId: "va-night" } });
      expect(screen.getByTestId("palette-va-night")).toHaveAttribute("aria-pressed", "true");
      expect(screen.getByTestId("palette-cockpit-blue")).toHaveAttribute("aria-pressed", "false");
    });

    it("clicking a palette calls switchTheme AND writes appearance.theme", () => {
      const { props, themeApi: api } = setup();
      fireEvent.click(screen.getByTestId("palette-cockpit-blue"));
      expect(api.switchTheme).toHaveBeenCalledWith("cockpit-blue");
      expect(lastWrite(props.setField, "appearance.theme")).toBe("cockpit-blue");
    });

    it("labels every palette as dark and offers NO dark/light variant control", () => {
      setup();
      // Both palettes carry a "dark" marker...
      expect(screen.getAllByText("dark")).toHaveLength(2);
      // ...and there is no variant CONTROL of any spelling. The handoff promised
      // one; it cannot exist, so its absence is the assertion. The prose is
      // allowed to say the word "light" — it is explaining why there is no switch.
      expect(screen.queryByTestId("variant-toggle")).toBeNull();
      expect(screen.queryByLabelText(/variant/i)).toBeNull();
      expect(screen.queryByLabelText(/light/i)).toBeNull();
      expect(screen.queryByRole("button", { name: /light/i })).toBeNull();
      expect(screen.queryByRole("switch")).toBeNull();
      // The page explicitly states the constraint rather than implying it.
      expect(screen.getByTestId("palette-card")).toHaveTextContent(
        /both of them are dark/i
      );
    });
  });

  describe("accent", () => {
    it("a preset writes setAccent AND appearance.accent", () => {
      const { props, themeApi: api } = setup();
      fireEvent.click(screen.getByTestId("accent-preset-#5bbf9f"));
      expect(api.setAccent).toHaveBeenCalledWith("#5bbf9f");
      expect(lastWrite(props.setField, "appearance.accent")).toBe("#5bbf9f");
    });

    it("the custom color input writes both targets", () => {
      const { props, themeApi: api } = setup();
      fireEvent.change(screen.getByTestId("field-appearance.accent"), {
        target: { value: "#123456" },
      });
      expect(api.setAccent).toHaveBeenCalledWith("#123456");
      expect(lastWrite(props.setField, "appearance.accent")).toBe("#123456");
    });

    it("Use palette accent clears the accent on both targets", () => {
      const { props, themeApi: api } = setup({ theme: { accent: "#e0b060" } });
      fireEvent.click(screen.getByTestId("accent-reset"));
      expect(api.setAccent).toHaveBeenCalledWith(null);
      expect(lastWrite(props.setField, "appearance.accent")).toBeNull();
    });

    it("shows the palette default when no accent is set", () => {
      setup({ theme: { accent: null } });
      expect(screen.getByTestId("accent-value")).toHaveTextContent("palette default");
    });
  });

  describe("glow", () => {
    it("the toggle writes setGlowEnabled AND appearance.glow_enabled", () => {
      const { props, themeApi: api } = setup({ theme: { glowEnabled: true } });
      fireEvent.click(screen.getByTestId("field-appearance.glow_enabled"));
      expect(api.setGlowEnabled).toHaveBeenCalledWith(false);
      expect(lastWrite(props.setField, "appearance.glow_enabled")).toBe(false);
    });

    it("the size slider writes a step-2 number to setGlowStrength AND appearance.glow_size", () => {
      const { props, themeApi: api } = setup({ theme: { glowStrength: 30 } });
      const slider = screen.getByTestId("field-appearance.glow_size");
      expect(slider).toHaveAttribute("step", "2");
      expect(slider).toHaveAttribute("min", "0");
      expect(slider).toHaveAttribute("max", "48");
      fireEvent.change(slider, { target: { value: "18" } });
      expect(api.setGlowStrength).toHaveBeenCalledWith(18);
      expect(lastWrite(props.setField, "appearance.glow_size")).toBe(18);
    });

    it("disables the slider when the glow is off", () => {
      setup({ theme: { glowEnabled: false } });
      expect(screen.getByTestId("field-appearance.glow_size")).toBeDisabled();
      expect(screen.getByTestId("glow-enabled-value")).toHaveTextContent("Disabled");
    });

    it("marks a dirty size field", () => {
      setup({ shell: { dirtyPaths: ["appearance.glow_size"] } });
      expect(screen.getByTestId("field-appearance.glow_size")).toHaveAttribute("data-dirty", "true");
    });
  });

  describe("accent supersession (re-homed from ThemePopover)", () => {
    it("renders no note and no clear action when nothing is overridden", () => {
      setup();
      expect(screen.queryByTestId("accent-override-note")).toBeNull();
      expect(screen.queryByTestId("clear-override---cc-accent")).toBeNull();
      expect(screen.getByTestId("accent-picker")).toHaveAttribute("data-superseded", "false");
    });

    it("names the override and its value, and offers Clear", () => {
      setup({ theme: { tokenOverrides: { "--cc-accent": "#ff00ff" } } });
      const note = screen.getByTestId("accent-override-note");
      expect(note).toHaveAttribute("role", "note");
      expect(note).toHaveTextContent("--cc-accent");
      expect(note).toHaveTextContent("#ff00ff");
      expect(screen.getByTestId("accent-picker")).toHaveAttribute("data-superseded", "true");
      expect(screen.getByTestId("clear-override---cc-accent")).toBeInTheDocument();
    });

    it("clicking Clear calls clearTokenOverride with --cc-accent", async () => {
      const { themeApi: api } = setup({ theme: { tokenOverrides: { "--cc-accent": "#ff00ff" } } });
      fireEvent.click(screen.getByTestId("clear-override---cc-accent"));
      await waitFor(() => expect(api.clearTokenOverride).toHaveBeenCalledWith("--cc-accent"));
    });

    it("also surfaces a --cc-working override with its own Clear", async () => {
      const { themeApi: api } = setup({
        theme: { tokenOverrides: { "--cc-accent": "#ff00ff", "--cc-working": "#00ff00" } },
      });
      const note = screen.getByTestId("accent-override-note");
      expect(note).toHaveTextContent("--cc-working");
      expect(note).toHaveTextContent("#00ff00");
      fireEvent.click(screen.getByTestId("clear-override---cc-working"));
      await waitFor(() => expect(api.clearTokenOverride).toHaveBeenCalledWith("--cc-working"));
    });

    it("describes the accent controls by the note while superseded", () => {
      setup({ theme: { tokenOverrides: { "--cc-accent": "#ff00ff" } } });
      expect(screen.getByLabelText("Custom accent color")).toHaveAttribute(
        "aria-describedby",
        "theme-accent-override-note"
      );
    });

    it("a FAILED persist surfaces a role=alert instead of claiming success", async () => {
      setup({
        theme: {
          tokenOverrides: { "--cc-accent": "#ff00ff" },
          clearResult: { ok: false, error: "The settings service rejected the change." },
        },
      });
      fireEvent.click(screen.getByTestId("clear-override---cc-accent"));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("The settings service rejected the change.");
      expect(alert).toHaveTextContent(/this\s+window only/i);
      expect(alert).toHaveTextContent(/reappear/i);
    });

    it("shows no alert when the persist succeeds", async () => {
      const { themeApi: api } = setup({ theme: { tokenOverrides: { "--cc-accent": "#ff00ff" } } });
      fireEvent.click(screen.getByTestId("clear-override---cc-accent"));
      await waitFor(() => expect(api.clearTokenOverride).toHaveBeenCalled());
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("points at the Design tokens page for per-token editing", () => {
    setup();
    const pointer = screen.getByTestId("tokens-pointer");
    expect(pointer).toHaveAttribute("role", "note");
    expect(pointer).toHaveTextContent("Design tokens");
  });
});
