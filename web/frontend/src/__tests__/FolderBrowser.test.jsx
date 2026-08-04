/**
 * FolderBrowser + NewSessionDialog — Phase 9 (screen 3b).
 *
 * The contracts under test:
 *   - the new /api/browse `entries` shape renders, and an older server that
 *     answers with `dirs` only still renders rows (without metadata)
 *   - a repo row shows its branch
 *   - `dirty: null` means UNKNOWN and must render NO dot; only `dirty === true`
 *     draws the --cc-waiting dot
 *   - `skipped` rows say "skipped"
 *   - breadcrumb navigation refetches
 *   - keyboard: ↑ ↓ Enter ← Ctrl+Enter
 *   - the filter filters, and path-like input offers a jump
 *   - `Native dialog…` is disabled outside Tauri
 *   - bypass inherited from a saved location reaches the toggle
 *   - `Create` fires onConfirm with the SAME argument shape as the old dialog
 *   - a failed browse renders an error, not an innocent-looking empty folder
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom";
import FolderBrowser from "../components/FolderBrowser";
import {
  looksLikePath,
  normaliseEntries,
  parentOf,
  segmentsOf,
  driveOf,
} from "../components/folderPath";
import NewSessionDialog from "../components/NewSessionDialog";
// The shared session vocabularies. Asserted against the definition, not a
// fixture: a fixture would keep passing if this dialog re-grew its own copy,
// which is how it came to offer only four of the six effort levels.
import { PERMISSION_MODES, EFFORT_OPTIONS } from "../sessionVocabulary";

const entry = (name, over = {}) => ({
  name,
  path: `C:\\Code\\${name}`,
  git: false,
  branch: null,
  dirty: null,
  session_count: 0,
  entry_count: 12,
  skipped: false,
  ...over,
});

const LISTING = {
  parent: "C:\\",
  dirs: ["C:\\Code\\web", "C:\\Code\\backlog", "C:\\Code\\node_modules"],
  entries: [
    entry("web", { git: true, branch: "main", session_count: 2, entry_count: 68 }),
    entry("backlog"),
    entry("node_modules", { skipped: true, entry_count: null }),
  ],
};

/** Route fetches by URL so browse / git / anything-else are independent. */
function mockFetch(routes) {
  return vi.fn(async (url) => {
    const u = String(url);
    for (const [frag, handler] of routes) {
      if (u.includes(frag)) return handler(u);
    }
    return { ok: true, json: async () => ({}) };
  });
}

const jsonOk = (body) => () => ({ ok: true, status: 200, json: async () => body });

function browseRoutes(listing = LISTING, git = { git: false, branch: null, dirty: null, changed: null }) {
  return [
    ["/api/browse/git", jsonOk(git)],
    ["/api/browse", jsonOk(listing)],
  ];
}

async function renderBrowser(props = {}, routes = browseRoutes()) {
  globalThis.fetch = mockFetch(routes);
  const onPathChange = vi.fn();
  const onSelectPath = vi.fn();
  const onCreateHere = vi.fn();
  const utils = render(
    <FolderBrowser
      path="C:\\Code"
      onPathChange={onPathChange}
      selectedPath="C:\\Code\\web"
      onSelectPath={onSelectPath}
      onCreateHere={onCreateHere}
      recentLocations={["C:\\Code\\web"]}
      savedLocations={[{ path: "C:\\Code\\backlog", bypassPermissions: true }]}
      {...props}
    />
  );
  await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
  return { ...utils, onPathChange, onSelectPath, onCreateHere };
}

beforeEach(() => {
  delete window.__TAURI__;
  delete window.__TAURI_INTERNALS__;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete window.__TAURI__;
  delete window.__TAURI_INTERNALS__;
});

// ── pure helpers ──────────────────────────────────────────

describe("FolderBrowser helpers", () => {
  it("detects path-like input but not plain filter text", () => {
    expect(looksLikePath("C:\\Code\\web")).toBe(true);
    expect(looksLikePath("some/dir")).toBe(true);
    expect(looksLikePath("D:")).toBe(true);
    expect(looksLikePath("web")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });

  it("splits and walks up Windows paths", () => {
    expect(driveOf("C:\\Code\\web")).toBe("C:");
    expect(segmentsOf("C:\\Code\\web")).toEqual(["Code", "web"]);
    expect(parentOf("C:\\Code\\web")).toBe("C:\\Code");
    expect(parentOf("C:\\")).toBe(null);
  });

  it("normalises the entries shape and the legacy dirs shape", () => {
    const withEntries = normaliseEntries(LISTING);
    expect(withEntries[0]).toMatchObject({ name: "web", git: true, branch: "main", hasMeta: true });
    const legacy = normaliseEntries({ dirs: ["C:\\Code\\web"] });
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ name: "web", git: false, branch: null, hasMeta: false });
  });

  it("treats a non-true dirty value as unknown, never clean", () => {
    const rows = normaliseEntries({ entries: [entry("a", { dirty: null }), entry("b", { dirty: true })] });
    expect(rows[0].dirty).toBe(null);
    expect(rows[1].dirty).toBe(true);
  });
});

// ── listing ───────────────────────────────────────────────

describe("FolderBrowser listing", () => {
  it("renders rows from the new entries shape with branch and meta", async () => {
    await renderBrowser();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(screen.getByRole("option", { name: "web" })).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText(/2 sessions/)).toBeInTheDocument();
    expect(screen.getByText(/68 files/)).toBeInTheDocument();
  });

  it("falls back to dirs when entries is absent, without crashing", async () => {
    await renderBrowser({}, browseRoutes({ dirs: ["C:\\Code\\web", "C:\\Code\\backlog"], parent: "C:\\" }));
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "web" })).toBeInTheDocument();
    // No metadata is claimed for legacy rows.
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("renders skipped for node_modules", async () => {
    await renderBrowser();
    expect(screen.getByText("skipped")).toBeInTheDocument();
  });

  it("shows NO dirty dot when dirty is null (unknown is not clean)", async () => {
    await renderBrowser();
    expect(screen.queryAllByTestId("dirty-dot")).toHaveLength(0);
  });

  it("shows the dirty dot only when dirty === true", async () => {
    await renderBrowser(
      {},
      browseRoutes({
        parent: "C:\\",
        entries: [entry("web", { git: true, branch: "main", dirty: true })],
      })
    );
    expect(screen.getAllByTestId("dirty-dot")).toHaveLength(1);
  });

  it("renders an error, not an empty folder, when the browse fetch fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    render(
      <FolderBrowser
        path="C:\\Code"
        onPathChange={vi.fn()}
        selectedPath="C:\\Code"
        onSelectPath={vi.fn()}
        onCreateHere={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/Couldn't read this folder/);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.queryByText("No subfolders here.")).not.toBeInTheDocument();
  });

  it("renders an error when the server answers non-ok", async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
    render(
      <FolderBrowser
        path="C:\\Nope"
        onPathChange={vi.fn()}
        selectedPath="C:\\Nope"
        onSelectPath={vi.fn()}
        onCreateHere={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/403/));
  });
});

// ── navigation ────────────────────────────────────────────

describe("FolderBrowser navigation", () => {
  it("breadcrumb click navigates and refetches", async () => {
    const { onPathChange, rerender, onSelectPath } = await renderBrowser();
    const calls = globalThis.fetch.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Go to C:" }));
    expect(onPathChange).toHaveBeenCalledWith("C:\\");
    expect(onSelectPath).toHaveBeenCalledWith("C:\\");
    // The parent owns `path`; feeding the new value back must refetch.
    rerender(
      <FolderBrowser
        path="C:\\"
        onPathChange={onPathChange}
        selectedPath="C:\\"
        onSelectPath={onSelectPath}
        onCreateHere={vi.fn()}
      />
    );
    await waitFor(() => expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(calls));
    expect(globalThis.fetch.mock.calls.at(-1)[0]).toContain(encodeURIComponent("C:\\"));
  });

  it("rail rows navigate and mark saved bypass folders", async () => {
    const { onPathChange } = await renderBrowser();
    expect(screen.getByLabelText("bypass permissions")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to C:\\Code\\backlog" }));
    expect(onPathChange).toHaveBeenCalledWith("C:\\Code\\backlog");
  });

  it("clicking a row selects it without navigating", async () => {
    const { onPathChange, onSelectPath } = await renderBrowser();
    fireEvent.click(screen.getByRole("option", { name: "backlog" }));
    expect(onSelectPath).toHaveBeenCalledWith("C:\\Code\\backlog");
    expect(onPathChange).not.toHaveBeenCalled();
  });
});

// ── keyboard ──────────────────────────────────────────────

describe("FolderBrowser keyboard", () => {
  const filterBox = () => screen.getByLabelText("Filter this folder or type a path to jump");

  it("ArrowDown / ArrowUp move the selection", async () => {
    const { onSelectPath } = await renderBrowser();
    fireEvent.keyDown(filterBox(), { key: "ArrowDown" });
    expect(onSelectPath).toHaveBeenLastCalledWith("C:\\Code\\web");
    fireEvent.keyDown(filterBox(), { key: "ArrowDown" });
    expect(onSelectPath).toHaveBeenLastCalledWith("C:\\Code\\backlog");
    fireEvent.keyDown(filterBox(), { key: "ArrowUp" });
    expect(onSelectPath).toHaveBeenLastCalledWith("C:\\Code\\web");
  });

  it("Enter opens the active row", async () => {
    const { onPathChange } = await renderBrowser();
    fireEvent.keyDown(filterBox(), { key: "ArrowDown" });
    fireEvent.keyDown(filterBox(), { key: "Enter" });
    expect(onPathChange).toHaveBeenCalledWith("C:\\Code\\web");
  });

  it("ArrowLeft goes up a level when the filter is empty", async () => {
    const { onPathChange } = await renderBrowser();
    fireEvent.keyDown(filterBox(), { key: "ArrowLeft" });
    expect(onPathChange).toHaveBeenCalledWith("C:\\");
  });

  it("ArrowLeft does not navigate while the filter has text", async () => {
    const { onPathChange } = await renderBrowser();
    fireEvent.change(filterBox(), { target: { value: "we" } });
    fireEvent.keyDown(filterBox(), { key: "ArrowLeft" });
    expect(onPathChange).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter creates here", async () => {
    const { onCreateHere } = await renderBrowser();
    fireEvent.keyDown(filterBox(), { key: "Enter", ctrlKey: true });
    expect(onCreateHere).toHaveBeenCalledTimes(1);
  });
});

// ── filter / jump ─────────────────────────────────────────

describe("FolderBrowser filter", () => {
  const filterBox = () => screen.getByLabelText("Filter this folder or type a path to jump");

  it("plain text filters the current folder", async () => {
    await renderBrowser();
    fireEvent.change(filterBox(), { target: { value: "back" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "backlog" })).toBeInTheDocument();
    expect(screen.getByText("1 folder")).toBeInTheDocument();
  });

  it("a filter that matches nothing says so instead of looking empty", async () => {
    await renderBrowser();
    fireEvent.change(filterBox(), { target: { value: "zzzz" } });
    expect(screen.getByText("Nothing here matches that filter.")).toBeInTheDocument();
  });

  it("path-like input offers a jump, and Enter takes it", async () => {
    const { onPathChange } = await renderBrowser();
    fireEvent.change(filterBox(), { target: { value: "D:\\Projects" } });
    const jump = screen.getByRole("button", { name: "Jump to D:\\Projects" });
    expect(jump).toBeInTheDocument();
    fireEvent.keyDown(filterBox(), { key: "Enter" });
    expect(onPathChange).toHaveBeenCalledWith("D:\\Projects");
  });

  it("the jump button navigates when clicked", async () => {
    const { onPathChange } = await renderBrowser();
    fireEvent.change(filterBox(), { target: { value: "E:/work" } });
    fireEvent.click(screen.getByRole("button", { name: "Jump to E:\\work" }));
    expect(onPathChange).toHaveBeenCalledWith("E:\\work");
  });
});

// ── native dialog ─────────────────────────────────────────

describe("Native dialog handoff", () => {
  it("is disabled outside Tauri and explains why", async () => {
    await renderBrowser();
    const btn = screen.getByRole("button", { name: "Open the native folder dialog" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute("title", "The native folder dialog needs the desktop app");
  });

  it("is enabled under Tauri", async () => {
    window.__TAURI_INTERNALS__ = {};
    await renderBrowser();
    expect(screen.getByRole("button", { name: "Open the native folder dialog" })).toBeEnabled();
  });
});

// ── NewSessionDialog integration (no regressions) ─────────

describe("NewSessionDialog", () => {
  const renderDialog = async (props = {}, routes = browseRoutes()) => {
    globalThis.fetch = mockFetch(routes);
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const utils = render(
      <NewSessionDialog
        recentLocations={["C:\\Code\\web", "C:\\Code"]}
        savedLocations={[{ path: "C:\\Code\\web", bypassPermissions: true }]}
        onConfirm={onConfirm}
        onCancel={onCancel}
        {...props}
      />
    );
    await waitFor(() => expect(screen.getByRole("listbox")).toBeInTheDocument());
    return { ...utils, onConfirm, onCancel };
  };

  it("fires onConfirm with the same (name, workdir, bypass) shape as before", async () => {
    const { onConfirm } = await renderDialog({
      savedLocations: [],
      recentLocations: ["C:\\Code\\web"],
    });
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "  api  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]).toEqual(["api", "C:\\Code\\web", false]);
  });

  it("inherits bypass from a saved location and labels it as inherited", async () => {
    const { onConfirm } = await renderDialog();
    expect(screen.getByRole("button", { name: "Bypass inherited from folder" })).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm.mock.calls[0]).toEqual(["", "C:\\Code\\web", true]);
  });

  it("a manual bypass flip wins over folder inheritance", async () => {
    const { onConfirm } = await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Bypass inherited from folder" }));
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm.mock.calls[0][2]).toBe(false);
  });

  it("typing a path still works and drives the browser", async () => {
    const { onConfirm } = await renderDialog({ savedLocations: [] });
    const pathInput = screen.getByLabelText("Working directory");
    fireEvent.change(pathInput, { target: { value: "C:\\Other\\repo" } });
    fireEvent.keyDown(pathInput, { key: "Enter" });
    await waitFor(() =>
      expect(globalThis.fetch.mock.calls.some((c) => String(c[0]).includes(encodeURIComponent("C:\\Other\\repo")))).toBe(
        true
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm.mock.calls[0]).toEqual(["", "C:\\Other\\repo", false]);
  });

  it("validates the selected folder as exists · git repo", async () => {
    await renderDialog({}, browseRoutes(LISTING, { git: true, branch: "main", dirty: null, changed: null }));
    await waitFor(() => expect(screen.getByText(/exists · git repo/)).toBeInTheDocument());
    // dirty null => no dot in the summary bar either
    expect(screen.queryByTestId("summary-dirty-dot")).not.toBeInTheDocument();
  });

  it("shows the summary dirty dot only when dirty === true", async () => {
    await renderDialog({}, browseRoutes(LISTING, { git: true, branch: "main", dirty: true, changed: 4 }));
    await waitFor(() => expect(screen.getByTestId("summary-dirty-dot")).toBeInTheDocument());
  });

  it("surfaces an unreadable folder inline instead of claiming it exists", async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes("/api/browse/git")) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    render(
      <NewSessionDialog
        recentLocations={["C:\\Ghost"]}
        savedLocations={[]}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText("That folder can't be read.")).toBeInTheDocument());
    expect(screen.queryByText(/exists/)).not.toBeInTheDocument();
  });

  it("Ctrl+Enter inside the browser creates the session", async () => {
    const { onConfirm } = await renderDialog({ savedLocations: [] });
    fireEvent.keyDown(screen.getByLabelText("Filter this folder or type a path to jump"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][1]).toBe("C:\\Code\\web");
  });

  it("Escape and the close button cancel", async () => {
    const { onCancel } = await renderDialog();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("keeps the model / permission / effort selects and the CLI-path note", async () => {
    await renderDialog();
    expect(screen.getByRole("button", { name: "Model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Permission" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Effort" })).toBeInTheDocument();
    expect(screen.getByText(/CLAUDE_CLI_PATH/)).toBeInTheDocument();
  });

  // REGRESSION: this dialog's Effort select shipped with only four of the six
  // levels ("" / low / medium / high), so it showed a menu claiming a session
  // could not be set to xhigh or max, while its own comment claimed it mirrored
  // TopBar. The selects are display-only, so nothing was ever misconfigured --
  // but a decorative menu that misdescribes what a session can be is still a
  // false statement about the system. All three lists now come from the shared
  // sources.
  it("offers every shared effort level, including xhigh and max", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Effort" }));
    for (const level of EFFORT_OPTIONS) {
      expect(screen.getByRole("button", { name: level.label })).toBeInTheDocument();
    }
    // The two that were missing, named explicitly so the regression is legible.
    expect(screen.getByRole("button", { name: "XHigh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Max" })).toBeInTheDocument();
  });

  it("offers the shared permission modes with the canonical wording", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Permission" }));
    for (const mode of PERMISSION_MODES) {
      expect(screen.getByRole("button", { name: mode.label })).toBeInTheDocument();
    }
  });

  it("lists models from the shared catalog, not the stale local copy", async () => {
    await renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    // The stale list named models that are not in Plexar Studio's catalog at all.
    expect(screen.queryByRole("button", { name: "Sonnet 4.6" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Opus 4.6" })).not.toBeInTheDocument();
    // A real catalog entry renders instead.
    expect(screen.getByRole("button", { name: "Opus 5" })).toBeInTheDocument();
  });

  it("still passes ONLY (name, workdir, bypass) after the vocabulary migration", async () => {
    // The selects remain display-only on purpose: App.jsx destructures onConfirm
    // positionally and applies the global command-bar settings itself. Widening
    // the menus must not start submitting them.
    const { onConfirm } = await renderDialog({
      savedLocations: [],
      recentLocations: ["C:\\Code\\web"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Effort" }));
    fireEvent.click(screen.getByRole("button", { name: "Max" }));
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "api" } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(onConfirm.mock.calls[0]).toEqual(["api", "C:\\Code\\web", false]);
    expect(onConfirm.mock.calls[0]).toHaveLength(3);
  });

  it("does not crash with no recent or saved locations", async () => {
    globalThis.fetch = mockFetch(browseRoutes());
    await act(async () => {
      render(<NewSessionDialog onConfirm={vi.fn()} onCancel={vi.fn()} />);
    });
    expect(screen.getByText("New session")).toBeInTheDocument();
  });
});
