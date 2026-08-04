/**
 * ThemePopover — accent supersession.
 *
 * The bug this pins: applyThemeToDOM resolves the accent as
 * `overrides["--cc-accent"] || accent || theme.accent`. That precedence is
 * correct, but it makes the rail's accent picker completely inert once a user
 * has set a `--cc-accent` design-token override — they drag it, the value
 * saves, and nothing on screen changes. Silence is the defect.
 *
 * Contract:
 *   - with a --cc-accent override active, a role="note" explains that the
 *     override is winning, and a Clear token override action is offered
 *   - clicking that action calls clearTokenOverride("--cc-accent")
 *   - the picker is visually marked superseded and aria-describedby the note,
 *     but NOT hard-disabled and silent
 *   - with no override there is no note and the picker is normal
 *   - --cc-working gets the same treatment: an override on it stops the pane
 *     glow from following the accent, so it is named and clearable too
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { ThemePopover } from "../components/ActivityRail.jsx";

let themeApi;

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => themeApi,
}));

function makeTheme(tokenOverrides = {}, clearResult = { ok: true }) {
  return {
    themeId: "va-night",
    themes: [{ id: "va-night", label: "Visual Assist Night", group: "dark" }],
    switchTheme: vi.fn(),
    accent: "#5bbf9f",
    setAccent: vi.fn(),
    glowEnabled: true,
    setGlowEnabled: vi.fn(),
    glowStrength: 30,
    setGlowStrength: vi.fn(),
    tokenOverrides,
    clearTokenOverride: vi.fn().mockResolvedValue(clearResult),
  };
}

function setup(tokenOverrides, clearResult) {
  themeApi = makeTheme(tokenOverrides, clearResult);
  render(<ThemePopover onClose={vi.fn()} />);
  return themeApi;
}

describe("ThemePopover accent supersession", () => {
  beforeEach(() => {
    themeApi = makeTheme();
  });

  it("says nothing and leaves the picker normal when no override is active", () => {
    setup({});
    expect(screen.queryByTestId("accent-override-note")).toBeNull();
    const picker = screen.getByTestId("accent-picker");
    expect(picker).toHaveAttribute("data-superseded", "false");
    expect(screen.getByLabelText("Accent #4ea1e8")).not.toHaveAttribute("aria-disabled");
  });

  it("explains that a --cc-accent override is winning", () => {
    setup({ "--cc-accent": "#ff0000" });
    const note = screen.getByTestId("accent-override-note");
    expect(note).toHaveAttribute("role", "note");
    expect(note).toHaveTextContent("--cc-accent");
    expect(note).toHaveTextContent("#ff0000");
    expect(note).toHaveTextContent(/no effect/i);
  });

  it("offers a clear action that calls clearTokenOverride('--cc-accent')", () => {
    const api = setup({ "--cc-accent": "#ff0000" });
    fireEvent.click(screen.getByTestId("clear-override---cc-accent"));
    expect(api.clearTokenOverride).toHaveBeenCalledWith("--cc-accent");
  });

  it("marks the picker superseded and describes it by the note, without silence", () => {
    setup({ "--cc-accent": "#ff0000" });
    expect(screen.getByTestId("accent-picker")).toHaveAttribute("data-superseded", "true");
    const swatch = screen.getByLabelText("Accent #4ea1e8");
    expect(swatch).toHaveAttribute("aria-disabled", "true");
    expect(swatch).toHaveAttribute("aria-describedby", "accent-override-note");
    // Not hard-disabled: the user must be able to reach it and understand why.
    expect(swatch).not.toBeDisabled();
  });

  it("names and clears a --cc-working override too, since accent retints the glow", () => {
    const api = setup({ "--cc-accent": "#ff0000", "--cc-working": "#00ff00" });
    const note = screen.getByTestId("accent-override-note");
    expect(note).toHaveTextContent("--cc-working");
    fireEvent.click(screen.getByTestId("clear-override---cc-working"));
    expect(api.clearTokenOverride).toHaveBeenCalledWith("--cc-working");
  });

  it("does not mention --cc-working when only the accent is overridden", () => {
    setup({ "--cc-accent": "#ff0000" });
    expect(screen.queryByTestId("clear-override---cc-working")).toBeNull();
  });

  // ── the clear must not silently fail to persist ─────────
  it("reports nothing when the clear persisted successfully", async () => {
    setup({ "--cc-accent": "#ff0000" }, { ok: true });
    fireEvent.click(screen.getByTestId("clear-override---cc-accent"));
    await waitFor(() => expect(themeApi.clearTokenOverride).toHaveBeenCalled());
    expect(screen.queryByTestId("clear-override-error")).toBeNull();
  });

  it("surfaces a role=alert when the clear could not be saved to the server", async () => {
    setup({ "--cc-accent": "#ff0000" }, { ok: false, error: "disk is read-only." });
    fireEvent.click(screen.getByTestId("clear-override---cc-accent"));
    const alert = await screen.findByTestId("clear-override-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("disk is read-only.");
    // The user must be told the override is coming back, not left believing it is gone.
    expect(alert).toHaveTextContent(/reappear when Plexar Studio restarts/i);
  });
});
