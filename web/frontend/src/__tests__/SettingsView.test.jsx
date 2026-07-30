/**
 * Shell-level tests for the Settings section: the SettingsView frame, the
 * SettingsNav item contract (ids are deep-link values — a rename is a breaking
 * change), and the useSettings minimal-patch behaviour.
 *
 * ProvidersSettings is authored in parallel, so a stub is injected through
 * SettingsView's `providersPage` seam — these tests deliberately cover only
 * shell + nav + hook behaviour.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import SettingsView, { middleEllipsize } from "../components/settings/SettingsView.jsx";
import { ThemeProvider } from "../hooks/useTheme.jsx";
import SettingsNav, {
  SETTINGS_GROUPS,
  SETTINGS_SECTION_LABELS,
  filterSettingsGroups,
} from "../components/settings/SettingsNav.jsx";
import useSettings, {
  getIn,
  setIn,
  deleteIn,
  buildPatch,
  wholeDictPrefixFor,
  WHOLE_DICT_PATHS,
} from "../hooks/useSettings.js";

// Long on purpose: the header label must middle-ellipsize past 46 chars.
const SETTINGS_PATH = "C:\\Users\\someone\\AppData\\Roaming\\claude-cockpit\\settings.json";

// Stand-in for the parallel-authored ProvidersSettings page, injected through
// SettingsView's `providersPage` test seam. It asserts the exact prop contract
// the real page will consume.
// Variant that can dirty a field, to exercise the Discard / Save affordances.
const DirtyingStub = ({ get, setField }) => (
  <div data-testid="providers-page">
    <button onClick={() => setField("providers.lmstudio.base_url", "http://127.0.0.1:9999")}>
      dirty it
    </button>
    <span data-testid="value">{get("providers.lmstudio.base_url", "")}</span>
  </div>
);

const ProvidersStub = ({ get, setField, isDirty }) => (
  <div data-testid="providers-page">
    providers page
    {typeof get === "function" && typeof setField === "function" && typeof isDirty === "function"
      ? " · props ok"
      : " · props MISSING"}
  </div>
);

const BASE_SETTINGS = {
  general: { workspace_root: "C:\\Code" },
  providers: {
    lmstudio: { base_url: "http://127.0.0.1:1234", enabled: true },
    vllm: { base_url: "http://127.0.0.1:8001" },
  },
  // Free-form maps the backend REPLACES wholesale — the data-loss trap.
  appearance: {
    theme: "graphite",
    token_overrides: { "--cc-bg": "#101010", "--cc-accent": "#4ea1e8" },
    user_palettes: { mine: { "--cc-bg": "#000000" } },
  },
  system: { keybindings: { "palette.open": "Ctrl+K", "pane.next": "Ctrl+]" } },
};

function jsonRes(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

beforeEach(() => {
  globalThis.fetch = vi.fn((url, opts) => {
    if (url === "/api/settings" && (!opts || opts.method === undefined)) {
      return jsonRes({ path: SETTINGS_PATH, settings: BASE_SETTINGS });
    }
    if (url === "/api/settings" && opts?.method === "PUT") {
      return jsonRes({ path: SETTINGS_PATH, settings: BASE_SETTINGS });
    }
    if (url === "/api/settings/reveal") {
      return jsonRes({ ok: true, path: SETTINGS_PATH });
    }
    return jsonRes({}, false, 404);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SettingsNav — deep-linkable ids", () => {
  it("exposes exactly the specified groups and item ids", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual([
      "Machine",
      "Sessions",
      "Appearance",
      "Data",
      "System",
    ]);
    expect(Object.keys(SETTINGS_SECTION_LABELS)).toEqual([
      "general",
      "providers",
      "claude-cli",
      "keys",
      "session-defaults",
      "permissions",
      // "layout" REMOVED (owner-confirmed): pane count and sidebar width are set
      // by direct manipulation and already persist, so a page for them could only
      // ever disagree with what is on screen.
      "terminal",
      "theme",
      "tokens",
      "reporting",
      "pricing",
      "keybindings",
      "updates",
      "diagnostics",
    ]);
  });

  it("marks the active item with aria-current and calls onSelectSection", () => {
    const onSelectSection = vi.fn();
    render(<SettingsNav section="theme" onSelectSection={onSelectSection} query="" />);

    expect(screen.getByText("Theme & glow")).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByText("Keybindings"));
    expect(onSelectSection).toHaveBeenCalledWith("keybindings");
  });

  it("filters items by label and drops empty groups", () => {
    const groups = filterSettingsGroups("term");
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["terminal"]);
    expect(filterSettingsGroups("")).toBe(SETTINGS_GROUPS);
  });

  it("renders the import/export footer button, disabled without a handler", () => {
    render(<SettingsNav section="general" onSelectSection={() => {}} query="" />);
    expect(screen.getByText("Import / export settings…")).toBeDisabled();
  });
});

describe("SettingsView — page frame", () => {
  it("renders the breadcrumb, storage path, and Reveal button", async () => {
    render(<SettingsView section="general" onSelectSection={() => {}} />);

    expect(screen.getByText("Settings")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTitle(SETTINGS_PATH)).toBeInTheDocument();
    });
    // Long path is middle-ellipsized in the visible label, full path in title.
    expect(screen.getByTitle(SETTINGS_PATH).textContent).toContain("…");

    fireEvent.click(screen.getByLabelText("Reveal settings file"));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/settings/reveal", { method: "POST" });
    });
  });

  it("renders the providers page with get/setField/isDirty for the providers section", async () => {
    render(
      <SettingsView section="providers" onSelectSection={() => {}} providersPage={ProvidersStub} />
    );
    await waitFor(() => {
      expect(screen.getByTestId("providers-page")).toHaveTextContent("props ok");
    });
  });

  it("says so honestly when the providers page is not in the build", async () => {
    render(<SettingsView section="providers" onSelectSection={() => {}} providersPage={null} />);
    await waitFor(() => {
      expect(screen.getByText("Providers page is not loaded")).toBeInTheDocument();
    });
  });

  /* This used to assert the not-built panel via `theme`, which was correct when
     `providers` was the only real page. Twelve of the fourteen sections now have
     one, so the case is pinned on a section that is GENUINELY unbuilt instead --
     and `permissions` is the one still genuinely unbuilt. (`layout` was RETIRED
     from the nav entirely rather than built -- see the id-contract test above.)
     If someone builds Permissions, this test should fail and be retired along
     with NotBuiltPanel, not edited to point at yet another section. */
  it("renders an honest not-built panel for a section that genuinely has no page", async () => {
    render(<SettingsView section="permissions" onSelectSection={() => {}} providersPage={ProvidersStub} />);
    await waitFor(() => {
      expect(screen.getByText("Permissions & safety is not built yet")).toBeInTheDocument();
    });
    // Still names where the setting lives today rather than leaving a blank panel.
    expect(screen.getByText(/DEFAULTS pill/)).toBeInTheDocument();
    expect(screen.queryByTestId("providers-page")).not.toBeInTheDocument();
  });

  it("routes every built section to a real page, not the not-built panel", async () => {
    // The registry is the thing under test: a page that exists but is missing
    // from PAGES silently falls through to "not built yet", which would be a
    // lie that no other test catches.
    for (const id of [
      "claude-cli", "keys", "session-defaults", "terminal", "theme",
      "tokens", "reporting", "pricing", "keybindings", "updates", "diagnostics",
    ]) {
      // ThemeSettings consumes the THROWING useTheme, which is correct for a
      // page that genuinely needs the palette — main.jsx wraps the whole app in
      // ThemeProvider. The harness has to match that, not the page be loosened.
      const { unmount } = render(
        <ThemeProvider>
          <SettingsView section={id} onSelectSection={() => {}} providersPage={ProvidersStub} />
        </ThemeProvider>,
      );
      // Assert on the PANEL, not on the phrase. Matching /is not built yet/ as
      // text gave a false positive: utils/keybindings.js honestly notes that the
      // command palette itself is not built (Ctrl+K opens the Projects drawer),
      // and that truthful copy is page content, not a missing page.
      await waitFor(() => expect(screen.queryByTestId("not-built-panel")).not.toBeInTheDocument());
      unmount();
    }
  });

  it("disables Save changes until something is dirty", async () => {
    render(<SettingsView section="general" onSelectSection={() => {}} />);
    await waitFor(() => expect(screen.getByText("Save changes")).toBeDisabled());
  });

  it("hides Test all unless an onTestAll handler is supplied", async () => {
    const { unmount } = render(
      <SettingsView section="providers" onSelectSection={() => {}} providersPage={ProvidersStub} />
    );
    await waitFor(() => expect(screen.getByTestId("providers-page")).toBeInTheDocument());
    expect(screen.queryByText("Test all")).not.toBeInTheDocument();
    unmount();

    render(
      <SettingsView
        section="providers"
        onSelectSection={() => {}}
        onTestAll={() => {}}
        providersPage={ProvidersStub}
      />
    );
    await waitFor(() => expect(screen.getByText("Test all")).toBeInTheDocument());
  });

  it("filtering the header search filters the nav", async () => {
    render(<SettingsView section="general" onSelectSection={() => {}} />);
    await waitFor(() => expect(screen.getByText("Keybindings")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "pricing" } });
    expect(screen.queryByText("Keybindings")).not.toBeInTheDocument();
    expect(screen.getByText("Pricing table")).toBeInTheDocument();
  });

  it("surfaces a 400 error message from the server", async () => {
    globalThis.fetch = vi.fn((url, opts) => {
      if (url === "/api/settings" && !opts) return jsonRes({ path: SETTINGS_PATH, settings: BASE_SETTINGS });
      if (url === "/api/settings" && opts?.method === "PUT") {
        return jsonRes({ error: "base_url must be http or https" }, false, 400);
      }
      return jsonRes({}, false, 404);
    });

    const Harness = () => {
      const s = useSettings();
      return (
        <div>
          <button onClick={() => s.setField("providers.lmstudio.base_url", "ftp://nope")}>edit</button>
          <button onClick={() => s.save()}>go</button>
          <span data-testid="err">{s.error || ""}</span>
          <span data-testid="draft">{s.get("providers.lmstudio.base_url", "")}</span>
        </div>
      );
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("draft")).toHaveTextContent("127.0.0.1:1234"));
    fireEvent.click(screen.getByText("edit"));
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByTestId("err")).toHaveTextContent("base_url must be http or https"));
    // Draft is KEPT on failure so the user does not lose their edit.
    expect(screen.getByTestId("draft")).toHaveTextContent("ftp://nope");
  });
});

describe("useSettings — dotted-path helpers and minimal patch", () => {
  it("getIn / setIn walk and clone nested paths", () => {
    expect(getIn(BASE_SETTINGS, "providers.lmstudio.base_url")).toBe("http://127.0.0.1:1234");
    expect(getIn(BASE_SETTINGS, "providers.nope.base_url", "fb")).toBe("fb");
    const next = setIn(BASE_SETTINGS, "providers.lmstudio.enabled", false);
    expect(next.providers.lmstudio.enabled).toBe(false);
    expect(BASE_SETTINGS.providers.lmstudio.enabled).toBe(true); // original untouched
  });

  it("buildPatch emits ONLY the dirty subtree, never the whole blob", () => {
    const draft = setIn(BASE_SETTINGS, "providers.vllm.base_url", "http://127.0.0.1:9000");
    const patch = buildPatch(draft, new Set(["providers.vllm.base_url"]));
    expect(patch).toEqual({ providers: { vllm: { base_url: "http://127.0.0.1:9000" } } });
    expect(patch.providers.lmstudio).toBeUndefined();
    expect(patch.general).toBeUndefined();
  });

  it("save() PUTs the minimal patch and clears dirty on success", async () => {
    // The hook is driven entirely through the DOM — no outer binding captures
    // its return value, so React's immutability lint stays satisfied and the
    // assertions run against real rendered output.
    const Harness = () => {
      const s = useSettings();
      return (
        <div>
          <button onClick={() => s.setField("general.workspace_root", "D:\\Work")}>edit</button>
          <button onClick={() => s.save()}>go</button>
          <span data-testid="loading">{String(s.loading)}</span>
          <span data-testid="dirty">{String(s.dirty)}</span>
          <span data-testid="dirty-root">{String(s.isDirty("general.workspace_root"))}</span>
          <span data-testid="dirty-other">{String(s.isDirty("providers.lmstudio.base_url"))}</span>
        </div>
      );
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByTestId("dirty")).toHaveTextContent("true");
    expect(screen.getByTestId("dirty-root")).toHaveTextContent("true");
    expect(screen.getByTestId("dirty-other")).toHaveTextContent("false");

    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("false"));

    const putCall = globalThis.fetch.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(JSON.parse(putCall[1].body)).toEqual({ general: { workspace_root: "D:\\Work" } });
  });

  it("does not poll — settings are fetched exactly once", async () => {
    render(<SettingsView section="general" onSelectSection={() => {}} />);
    await waitFor(() => expect(screen.getByTitle(SETTINGS_PATH)).toBeInTheDocument());
    const gets = globalThis.fetch.mock.calls.filter((c) => c[0] === "/api/settings" && !c[1]);
    expect(gets).toHaveLength(1);
  });
});

/**
 * The backend REPLACES appearance.token_overrides / appearance.user_palettes /
 * system.keybindings wholesale rather than deep-merging them (otherwise a
 * delete would be inexpressible). A narrow leaf patch would therefore destroy
 * every untouched sibling. These tests pin the promotion behaviour that
 * prevents that — Phase 5's Design tokens page is nothing but such edits.
 */
describe("useSettings — whole-dict leaves are never sent as partials", () => {
  it("recognises the exact set of whole-dict prefixes", () => {
    expect(WHOLE_DICT_PATHS).toEqual([
      "appearance.token_overrides",
      "appearance.user_palettes",
      "system.keybindings",
    ]);
    expect(wholeDictPrefixFor("appearance.token_overrides.--cc-bg")).toBe(
      "appearance.token_overrides"
    );
    expect(wholeDictPrefixFor("appearance.token_overrides")).toBe("appearance.token_overrides");
    expect(wholeDictPrefixFor("system.keybindings.palette.open")).toBe("system.keybindings");
    // Not a false-positive on a merely similar prefix.
    expect(wholeDictPrefixFor("appearance.token_overrides_extra.x")).toBe(null);
    expect(wholeDictPrefixFor("appearance.theme")).toBe(null);
    expect(wholeDictPrefixFor("providers.lmstudio.base_url")).toBe(null);
  });

  it("editing ONE override PUTs the complete map, untouched siblings included", () => {
    const draft = setIn(BASE_SETTINGS, "appearance.token_overrides.--cc-bg", "#123456");
    const patch = buildPatch(draft, new Set(["appearance.token_overrides.--cc-bg"]));
    expect(patch).toEqual({
      appearance: { token_overrides: { "--cc-bg": "#123456", "--cc-accent": "#4ea1e8" } },
    });
    // The sibling survives — this is the exact regression being guarded.
    expect(patch.appearance.token_overrides["--cc-accent"]).toBe("#4ea1e8");
    // And unrelated sections are still not shipped.
    expect(patch.appearance.theme).toBeUndefined();
    expect(patch.providers).toBeUndefined();
  });

  it("two overrides edited collapse into ONE token_overrides entry", () => {
    let draft = setIn(BASE_SETTINGS, "appearance.token_overrides.--cc-bg", "#111111");
    draft = setIn(draft, "appearance.token_overrides.--cc-accent", "#222222");
    const patch = buildPatch(
      draft,
      new Set([
        "appearance.token_overrides.--cc-bg",
        "appearance.token_overrides.--cc-accent",
      ])
    );
    expect(patch).toEqual({
      appearance: { token_overrides: { "--cc-bg": "#111111", "--cc-accent": "#222222" } },
    });
    expect(Object.keys(patch.appearance)).toEqual(["token_overrides"]);
  });

  it("deleteIn actually removes a key from the PUT body (Reset this override)", () => {
    const draft = deleteIn(BASE_SETTINGS, "appearance.token_overrides.--cc-bg");
    expect(BASE_SETTINGS.appearance.token_overrides["--cc-bg"]).toBe("#101010"); // original intact
    const patch = buildPatch(draft, new Set(["appearance.token_overrides.--cc-bg"]));
    expect(patch).toEqual({ appearance: { token_overrides: { "--cc-accent": "#4ea1e8" } } });
    expect("--cc-bg" in patch.appearance.token_overrides).toBe(false);
  });

  it("clearing every override sends an empty map, not a missing key", () => {
    let draft = deleteIn(BASE_SETTINGS, "appearance.token_overrides.--cc-bg");
    draft = deleteIn(draft, "appearance.token_overrides.--cc-accent");
    const patch = buildPatch(draft, new Set(["appearance.token_overrides.--cc-bg"]));
    expect(patch).toEqual({ appearance: { token_overrides: {} } });
  });

  it("promotes user_palettes leaf edits the same way", () => {
    const draft = setIn(BASE_SETTINGS, "appearance.user_palettes.mine.--cc-bg", "#abcdef");
    const patch = buildPatch(draft, new Set(["appearance.user_palettes.mine.--cc-bg"]));
    expect(patch).toEqual({
      appearance: { user_palettes: { mine: { "--cc-bg": "#abcdef" } } },
    });
  });

  /**
   * Keybinding KEYS contain dots ("pane.next"), so dotted-path leaf addressing
   * is ambiguous for that dict — "system.keybindings.pane.next" is
   * indistinguishable from a nested {pane:{next}}. The hook must not silently
   * corrupt data in that case, and the correct way to edit such a dict is a
   * single whole-dict setField (safe precisely BECAUSE it is replaced wholesale).
   */
  it("does not corrupt a dict whose keys contain dots", () => {
    // Ambiguous leaf delete is a no-op, not a partial write.
    const draft = deleteIn(BASE_SETTINGS, "system.keybindings.pane.next");
    expect(draft).toBe(BASE_SETTINGS);
    // Even if such a path were marked dirty, the promoted patch is the intact map.
    const patch = buildPatch(draft, new Set(["system.keybindings.pane.next"]));
    expect(patch).toEqual({
      system: { keybindings: { "palette.open": "Ctrl+K", "pane.next": "Ctrl+]" } },
    });
  });

  it("whole-dict setField is the supported way to edit dot-keyed dicts", () => {
    const nextMap = { "palette.open": "Ctrl+P" }; // pane.next unbound
    const draft = setIn(BASE_SETTINGS, "system.keybindings", nextMap);
    const patch = buildPatch(draft, new Set(["system.keybindings"]));
    expect(patch).toEqual({ system: { keybindings: { "palette.open": "Ctrl+P" } } });
    expect("pane.next" in patch.system.keybindings).toBe(false);
  });

  it("isDirty(prefix) is true when any leaf beneath it is dirty", async () => {
    const Harness = () => {
      const s = useSettings();
      return (
        <div>
          <button onClick={() => s.setField("appearance.token_overrides.--cc-bg", "#0a0a0a")}>
            edit
          </button>
          <button onClick={() => s.deleteField("appearance.token_overrides.--cc-accent")}>
            reset
          </button>
          <button onClick={() => s.save()}>go</button>
          <span data-testid="loading">{String(s.loading)}</span>
          <span data-testid="group">{String(s.isDirty("appearance.token_overrides"))}</span>
          <span data-testid="leaf">
            {String(s.isDirty("appearance.token_overrides.--cc-bg"))}
          </span>
          <span data-testid="other">{String(s.isDirty("appearance.theme"))}</span>
        </div>
      );
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("group")).toHaveTextContent("false");

    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByTestId("group")).toHaveTextContent("true");
    expect(screen.getByTestId("leaf")).toHaveTextContent("true");
    expect(screen.getByTestId("other")).toHaveTextContent("false");
  });

  it("end-to-end: an edit plus a delete PUT one complete, correct map", async () => {
    const Harness = () => {
      const s = useSettings();
      return (
        <div>
          <button onClick={() => s.setField("appearance.token_overrides.--cc-bg", "#0a0a0a")}>
            edit
          </button>
          <button onClick={() => s.deleteField("appearance.token_overrides.--cc-accent")}>
            reset
          </button>
          <button onClick={() => s.save()}>go</button>
          <span data-testid="loading">{String(s.loading)}</span>
          <span data-testid="dirty">{String(s.dirty)}</span>
        </div>
      );
    };
    render(<Harness />);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));

    fireEvent.click(screen.getByText("edit"));
    fireEvent.click(screen.getByText("reset"));
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(screen.getByTestId("dirty")).toHaveTextContent("false"));

    const putCall = globalThis.fetch.mock.calls.find((c) => c[1]?.method === "PUT");
    expect(JSON.parse(putCall[1].body)).toEqual({
      appearance: { token_overrides: { "--cc-bg": "#0a0a0a" } },
    });
  });
});

describe("SettingsView — Discard", () => {
  it("appears only once dirty and reverts the draft", async () => {
    render(
      <SettingsView section="providers" onSelectSection={() => {}} providersPage={DirtyingStub} />
    );
    await waitFor(() => expect(screen.getByTestId("providers-page")).toBeInTheDocument());
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
    expect(screen.getByText("Save changes")).toBeDisabled();

    fireEvent.click(screen.getByText("dirty it"));
    expect(screen.getByText("Discard")).toBeInTheDocument();
    expect(screen.getByText("Save changes")).toBeEnabled();
    expect(screen.getByTestId("value")).toHaveTextContent("http://127.0.0.1:9999");

    fireEvent.click(screen.getByText("Discard"));
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
    expect(screen.getByText("Save changes")).toBeDisabled();
    expect(screen.getByTestId("value")).toHaveTextContent("http://127.0.0.1:1234");
  });
});

describe("middleEllipsize", () => {
  it("leaves short strings alone and keeps both ends of long ones", () => {
    expect(middleEllipsize("short", 20)).toBe("short");
    const out = middleEllipsize("/very/long/path/to/a/settings/file/settings.json", 20);
    expect(out).toHaveLength(20);
    expect(out).toContain("…");
    expect(out.endsWith("json")).toBe(true);
  });
});
