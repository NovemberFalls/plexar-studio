/**
 * The default Settings section must RESOLVE — a gate written because deleting
 * a pane was about to break it.
 *
 * `General & startup` and `Permissions & safety` were removed on the owner's
 * ruling (*"General & Startup Remove it. Permissions & Safety remove it."*).
 * Both were genuine empty scaffolding: `PAGES.general` and `PAGES.permissions`
 * were literally `null`, so the panes rendered NotBuiltPanel and nothing else,
 * and Permissions' own copy conceded the setting is owned elsewhere (the
 * DEFAULTS pill, the per-session Inspector, and session defaults).
 *
 * THE TRAP, which is why this file exists rather than a line in the deletion:
 * `general` was ALSO `DEFAULT_SETTINGS_SECTION`. Deleting the pane without
 * re-pointing that constant leaves Settings opening on a section that does not
 * exist, EVERY LAUNCH — and it fails quietly, because `SettingsView` falls back
 * to `DEFAULT_SETTINGS_SECTION` when the requested section is unknown, so the
 * fallback would have been pointing at the missing section too. That is an
 * infinite non-answer, not an error anyone would see in a stack trace.
 *
 * So the invariant under test is not "the default is `providers`". It is that
 * WHATEVER the default is, it names a section that both the nav lists and the
 * page frame can title. Re-pointing it at another deleted id fails this file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import SettingsNav, {
  SETTINGS_GROUPS,
  SETTINGS_SECTION_LABELS,
  DEFAULT_SETTINGS_SECTION,
} from "../components/settings/SettingsNav";
import SettingsView from "../components/settings/SettingsView";

function ProvidersStub() {
  return <div data-testid="providers-page">providers</div>;
}

describe("DEFAULT_SETTINGS_SECTION resolves to a section that exists", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ path: "C:\\x\\settings.json", settings: {} }),
      })
    ));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("is an id the nav actually lists", () => {
    const ids = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain(DEFAULT_SETTINGS_SECTION);
    expect(SETTINGS_SECTION_LABELS[DEFAULT_SETTINGS_SECTION]).toBeTruthy();
  });

  it("renders as a selectable nav item, so launching lands somewhere highlighted", () => {
    render(
      <SettingsNav section={DEFAULT_SETTINGS_SECTION} onSelectSection={() => {}} query="" />
    );
    const label = SETTINGS_SECTION_LABELS[DEFAULT_SETTINGS_SECTION];
    expect(screen.getByText(label)).toHaveAttribute("aria-current", "page");
  });

  it("titles a real page rather than falling through to nothing", async () => {
    render(
      <SettingsView
        section={DEFAULT_SETTINGS_SECTION}
        onSelectSection={() => {}}
        providersPage={ProvidersStub}
      />
    );
    await waitFor(() => {
      // Twice, deliberately: once in the nav list and once in the breadcrumb.
      // A default that resolves must be BOTH listed and titled, so anything
      // less than two is the failure this file exists to catch.
      expect(
        screen.getAllByText(SETTINGS_SECTION_LABELS[DEFAULT_SETTINGS_SECTION]).length
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it("an UNKNOWN section falls back to the default and still titles it", async () => {
    // The fallback path is the one that would have gone silent: an unknown
    // section resolves to DEFAULT_SETTINGS_SECTION, so if the default is also
    // unknown the frame has no meta at all.
    render(
      <SettingsView
        section="this-section-was-deleted"
        onSelectSection={() => {}}
        providersPage={ProvidersStub}
      />
    );
    await waitFor(() => {
      // Twice, deliberately: once in the nav list and once in the breadcrumb.
      // A default that resolves must be BOTH listed and titled, so anything
      // less than two is the failure this file exists to catch.
      expect(
        screen.getAllByText(SETTINGS_SECTION_LABELS[DEFAULT_SETTINGS_SECTION]).length
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it("the two removed panes are gone from the nav entirely", () => {
    const ids = SETTINGS_GROUPS.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).not.toContain("general");
    expect(ids).not.toContain("permissions");
    expect(SETTINGS_SECTION_LABELS).not.toHaveProperty("general");
    expect(SETTINGS_SECTION_LABELS).not.toHaveProperty("permissions");
  });
});
