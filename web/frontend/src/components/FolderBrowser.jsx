/**
 * FolderBrowser — the real folder picker behind New session (Phase 9, screen 3b).
 *
 * Replaces the single typed-path field with breadcrumb + recents/saved rail +
 * a filterable folder list that shows which folders are git repos, how dirty
 * they are, and whether sessions already run there.
 *
 * BACKEND CONTRACT (pinned):
 *   GET /api/browse?path=  → { dirs: [absPath], parent, entries: [{
 *       name, path, git, branch, dirty, session_count, entry_count, skipped }] }
 *     · `dirs` is retained for backward compatibility. If `entries` is absent
 *       (older server) we fall back to `dirs` and render rows WITHOUT metadata
 *       rather than crashing.
 *     · `dirty` is ALWAYS null in the listing — a per-row `git status` would be
 *       far too slow. Only the SELECTED row gets real dirty state, fetched by
 *       the parent via GET /api/browse/git and handed back as `selectedGit`.
 *
 * UNKNOWN IS NOT CLEAN. `dirty: null` means we could not find out (timeout or
 * failure). We render that as ABSENT — no dot at all. Telling someone their
 * repo is clean when we don't know is worse than saying nothing, so the 5px
 * --cc-waiting dot appears if and only if `dirty === true`.
 *
 * NATIVE DIALOG. `Native dialog…` hands off to the OS picker and is enabled
 * only when actually running under Tauri (see `isTauriRuntime`). In a browser
 * it is disabled with an explanatory title. Note that this build's Tauri shell
 * does not register tauri-plugin-dialog yet, so the handoff surfaces an inline
 * error instead of throwing — never a console error, never a silent no-op.
 *
 * SELECTION MODEL. `path` is the folder being LISTED; `selectedPath` is the
 * candidate working directory. Clicking a row selects it; Enter / double-click
 * navigates into it (and selects it). The parent owns both.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRight,
  ClipboardPaste,
  CornerDownLeft,
  Folder,
  GitBranch,
  HardDrive,
  Loader,
  MonitorUp,
  Search,
  ShieldOff,
  TriangleAlert,
} from "lucide-react";
import {
  baseName,
  driveOf,
  isTauriRuntime,
  looksLikePath,
  normPath,
  normaliseEntries,
  parentOf,
  segmentsOf,
} from "./folderPath";

const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const LABEL = {
  fontSize: 9,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

// ── breadcrumb ────────────────────────────────────────────

function Crumb({ label, current, onClick, ariaLabel }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={current ? "" : "hover-bg-surface"}
      aria-label={ariaLabel}
      aria-current={current ? "location" : undefined}
      style={{
        height: 20,
        padding: "0 7px",
        borderRadius: 5,
        fontSize: 11,
        fontWeight: current ? 700 : 500,
        fontFamily: "inherit",
        whiteSpace: "nowrap",
        color: current ? "var(--cc-accent)" : "var(--cc-dim)",
        background: current ? tint("var(--cc-accent)", 12) : "transparent",
        border: "none",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

// ── rail ──────────────────────────────────────────────────

function RailRow({ label, title, active, bypass, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`Go to ${title}`}
      aria-current={active ? "true" : undefined}
      className="hover-bg-surface flex items-center gap-1.5 text-left w-full"
      style={{
        height: 26,
        padding: "0 8px",
        borderRadius: 5,
        fontSize: 11,
        fontFamily: "inherit",
        color: active ? "var(--cc-accent)" : "var(--cc-dim)",
        background: active ? tint("var(--cc-accent)", 12) : "transparent",
        border: "none",
        cursor: "pointer",
      }}
    >
      <Folder size={11} style={{ flexShrink: 0, color: active ? "var(--cc-accent)" : "var(--cc-muted)" }} />
      <span className="truncate flex-1">{label}</span>
      {bypass && (
        <ShieldOff
          size={11}
          aria-label="bypass permissions"
          style={{ flexShrink: 0, color: "var(--cc-waiting)" }}
        />
      )}
    </button>
  );
}

// ── folder row ────────────────────────────────────────────

function FolderRow({ entry, selected, dirty, rowId, onSelect, onOpen }) {
  const notable = entry.git || entry.sessionCount > 0;
  const meta = [];
  if (entry.skipped) meta.push("skipped");
  else {
    if (entry.sessionCount > 0) {
      meta.push(entry.sessionCount === 1 ? "1 session" : `${entry.sessionCount} sessions`);
    }
    if (Number.isFinite(entry.entryCount)) {
      meta.push(entry.entryCount === 1 ? "1 file" : `${entry.entryCount} files`);
    }
  }
  return (
    <div
      id={rowId}
      role="option"
      aria-selected={selected}
      aria-label={entry.name}
      onClick={() => onSelect(entry)}
      onDoubleClick={() => onOpen(entry)}
      className={selected ? "flex items-center gap-2" : "hover-bg-surface flex items-center gap-2"}
      style={{
        height: 30,
        padding: "0 8px",
        borderRadius: 5,
        cursor: "pointer",
        background: selected ? tint("var(--cc-accent)", 12) : "transparent",
        border: `1px solid ${selected ? tint("var(--cc-accent)", 40) : "transparent"}`,
        opacity: entry.skipped ? 0.6 : 1,
      }}
    >
      <Folder
        size={13}
        style={{ flexShrink: 0, color: notable ? "var(--cc-accent)" : "var(--cc-muted)" }}
      />
      <span
        className="truncate"
        style={{ fontSize: 12, fontWeight: 600, color: selected ? "var(--cc-fg)" : "var(--cc-dim)" }}
      >
        {entry.name}
      </span>
      {entry.git && (
        <span className="flex items-center gap-1" style={{ flexShrink: 0 }}>
          <GitBranch size={11} style={{ color: "var(--cc-muted)" }} aria-hidden="true" />
          <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>{entry.branch || "git"}</span>
        </span>
      )}
      {/* dirty === true only. null means UNKNOWN and renders nothing. */}
      {dirty === true && (
        <span
          data-testid="dirty-dot"
          aria-label="uncommitted changes"
          title="Uncommitted changes"
          style={{
            width: 5,
            height: 5,
            borderRadius: 999,
            background: "var(--cc-waiting)",
            flexShrink: 0,
          }}
        />
      )}
      <span
        className="ml-auto truncate"
        style={{ fontSize: 10, color: "var(--cc-muted)", flexShrink: 0 }}
      >
        {meta.join(" · ")}
      </span>
      <ChevronRight size={11} style={{ color: "var(--cc-muted)", flexShrink: 0 }} aria-hidden="true" />
    </div>
  );
}

// ── main ──────────────────────────────────────────────────

export default function FolderBrowser({
  path,
  onPathChange,
  selectedPath,
  onSelectPath,
  onCreateHere,
  recentLocations = [],
  savedLocations = [],
  selectedGit = null,
  onPastePath,
}) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [activeIdx, setActiveIdx] = useState(-1);
  const [nativeError, setNativeError] = useState("");
  const listRef = useRef(null);
  const filterRef = useRef(null);
  const reqRef = useRef(0);

  const tauri = isTauriRuntime();

  // Fetch the listing whenever the browsed folder changes.
  useEffect(() => {
    if (!path) return;
    const req = ++reqRef.current;
    setLoading(true);
    setError("");
    (async () => {
      try {
        const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
        if (!res.ok) throw new Error(`server returned ${res.status}`);
        const data = await res.json();
        if (reqRef.current !== req) return;
        setEntries(normaliseEntries(data));
      } catch (err) {
        if (reqRef.current !== req) return;
        // Explicit failure state — never an empty list that reads as a
        // legitimately empty folder.
        setEntries([]);
        setError(err?.message || "could not read this folder");
      } finally {
        if (reqRef.current === req) setLoading(false);
      }
    })();
  }, [path]);

  // A new folder resets the filter and the keyboard cursor.
  useEffect(() => {
    setFilter("");
    setActiveIdx(-1);
    setNativeError("");
  }, [path]);

  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  const jumpTarget = looksLikePath(filter) ? normPath(filter) : "";

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || jumpTarget) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  }, [entries, filter, jumpTarget]);

  // Keep the keyboard cursor inside the filtered list.
  useEffect(() => {
    setActiveIdx((i) => (i >= visible.length ? visible.length - 1 : i));
  }, [visible.length]);

  const goTo = useCallback(
    (dir) => {
      if (!dir) return;
      onSelectPath(dir);
      onPathChange(dir);
    },
    [onPathChange, onSelectPath]
  );

  const openEntry = useCallback((entry) => goTo(entry.path), [goTo]);

  const doJump = useCallback(() => {
    if (jumpTarget) goTo(jumpTarget);
  }, [goTo, jumpTarget]);

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        onCreateHere?.();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => {
          const next = Math.min(i + 1, visible.length - 1);
          if (visible[next]) onSelectPath(visible[next].path);
          return next;
        });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => {
          const next = Math.max(i - 1, 0);
          if (visible[next]) onSelectPath(visible[next].path);
          return next;
        });
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (jumpTarget) {
          doJump();
        } else if (visible[activeIdx]) {
          openEntry(visible[activeIdx]);
        } else if (visible.length === 1) {
          openEntry(visible[0]);
        }
        return;
      }
      // ArrowLeft goes up a level only when the filter box is empty, so it
      // still moves the caret while the user is editing text.
      if (e.key === "ArrowLeft" && filter === "") {
        const up = parentOf(path);
        if (up) {
          e.preventDefault();
          goTo(up);
        }
      }
    },
    [activeIdx, doJump, filter, goTo, jumpTarget, onCreateHere, onSelectPath, openEntry, path, visible]
  );

  // Scroll the keyboard cursor into view.
  useEffect(() => {
    if (activeIdx < 0 || !listRef.current) return;
    const row = listRef.current.children[activeIdx];
    // jsdom has no scrollIntoView; guard rather than crash the whole list.
    if (typeof row?.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const handleNativeDialog = useCallback(async () => {
    setNativeError("");
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const picked = await invoke("plugin:dialog|open", {
        options: { directory: true, multiple: false, defaultPath: path },
      });
      const dir = Array.isArray(picked) ? picked[0] : picked;
      if (dir) goTo(normPath(dir));
    } catch {
      setNativeError("The native picker isn't available in this build — paste a path instead.");
    }
  }, [goTo, path]);

  const drive = driveOf(path);
  const segs = segmentsOf(path);
  const saved = savedLocations.filter((l) => l && l.path);
  const savedSet = new Set(saved.map((l) => normPath(l.path)));
  const recents = recentLocations.filter((r) => r && !savedSet.has(normPath(r)));
  const selNorm = normPath(selectedPath);

  return (
    <div onKeyDown={handleKeyDown}>
      {/* ── breadcrumb row ── */}
      <div
        className="flex items-center gap-1.5"
        style={{ padding: "0 12px", height: 34, borderBottom: "1px solid var(--cc-line)" }}
      >
        <HardDrive size={12} style={{ color: "var(--cc-muted)", flexShrink: 0 }} aria-hidden="true" />
        <nav
          aria-label="Folder path"
          className="flex items-center gap-0.5 flex-1 overflow-x-auto"
          style={{ scrollbarWidth: "none" }}
        >
          {drive && (
            <Crumb
              label={drive}
              ariaLabel={`Go to ${drive}`}
              current={segs.length === 0}
              onClick={() => goTo(drive === "/" ? "/" : `${drive}\\`)}
            />
          )}
          {segs.map((seg, i) => {
            const upto =
              drive === "/"
                ? "/" + segs.slice(0, i + 1).join("\\")
                : `${drive}\\${segs.slice(0, i + 1).join("\\")}`;
            return (
              <span key={upto} className="flex items-center gap-0.5">
                <ChevronRight size={10} style={{ color: "var(--cc-muted)" }} aria-hidden="true" />
                <Crumb
                  label={seg}
                  ariaLabel={`Go to ${upto}`}
                  current={i === segs.length - 1}
                  onClick={() => goTo(upto)}
                />
              </span>
            );
          })}
        </nav>
        <button
          type="button"
          onClick={() => onPastePath?.()}
          className="hover-bg-surface flex items-center gap-1"
          aria-label="Paste a path"
          title="Type or paste a full path"
          style={{
            height: 22,
            padding: "0 8px",
            borderRadius: 5,
            fontSize: 10,
            fontFamily: "inherit",
            fontWeight: 600,
            color: "var(--cc-dim)",
            background: "transparent",
            border: "1px solid var(--cc-border)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <ClipboardPaste size={10} />
          Paste path
        </button>
        <button
          type="button"
          onClick={handleNativeDialog}
          disabled={!tauri}
          className={tauri ? "hover-bg-surface flex items-center gap-1" : "flex items-center gap-1"}
          aria-label="Open the native folder dialog"
          title={
            tauri
              ? "Pick a folder with the operating system dialog"
              : "The native folder dialog needs the desktop app"
          }
          style={{
            height: 22,
            padding: "0 8px",
            borderRadius: 5,
            fontSize: 10,
            fontFamily: "inherit",
            fontWeight: 600,
            color: tauri ? "var(--cc-dim)" : "var(--cc-muted)",
            background: "transparent",
            border: "1px solid var(--cc-border)",
            cursor: tauri ? "pointer" : "not-allowed",
            opacity: tauri ? 1 : 0.55,
            flexShrink: 0,
          }}
        >
          <MonitorUp size={10} />
          Native dialog…
        </button>
      </div>

      {nativeError && (
        <div
          role="note"
          style={{
            padding: "6px 12px",
            fontSize: 11,
            color: "var(--cc-error)",
            borderBottom: "1px solid var(--cc-line)",
          }}
        >
          {nativeError}
        </div>
      )}

      {/* ── body ── */}
      <div style={{ display: "flex", height: 330, minHeight: 0 }}>
        {/* rail */}
        <div
          style={{
            width: 210,
            flexShrink: 0,
            borderRight: "1px solid var(--cc-line)",
            overflowY: "auto",
            padding: "8px 6px",
          }}
        >
          {saved.length > 0 && (
            <>
              <div style={{ ...LABEL, padding: "2px 8px 4px" }}>Saved</div>
              {saved.map((l) => (
                <RailRow
                  key={`s:${l.path}`}
                  label={baseName(l.path)}
                  title={l.path}
                  active={normPath(l.path) === normPath(path)}
                  bypass={!!l.bypassPermissions}
                  onClick={() => goTo(l.path)}
                />
              ))}
            </>
          )}
          {recents.length > 0 && (
            <>
              <div style={{ ...LABEL, padding: saved.length ? "10px 8px 4px" : "2px 8px 4px" }}>
                Recent
              </div>
              {recents.map((r) => (
                <RailRow
                  key={`r:${r}`}
                  label={baseName(r)}
                  title={r}
                  active={normPath(r) === normPath(path)}
                  onClick={() => goTo(r)}
                />
              ))}
            </>
          )}
          {saved.length === 0 && recents.length === 0 && (
            <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--cc-muted)" }}>
              No saved or recent folders yet.
            </div>
          )}
        </div>

        {/* list */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div
            className="flex items-center gap-2"
            style={{ height: 32, padding: "0 10px", borderBottom: "1px solid var(--cc-line)" }}
          >
            <Search size={11} style={{ color: "var(--cc-muted)", flexShrink: 0 }} aria-hidden="true" />
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter this folder or type a path to jump"
              aria-controls="cc-folder-list"
              placeholder="Type to filter this folder — or start typing a path to jump"
              className="flex-1 outline-none"
              style={{
                background: "none",
                border: "none",
                color: "var(--cc-fg)",
                fontSize: 11,
                fontFamily: "inherit",
                minWidth: 0,
              }}
            />
            {loading ? (
              <Loader size={11} style={{ color: "var(--cc-muted)", flexShrink: 0 }} aria-label="Loading folder" />
            ) : (
              <span style={{ fontSize: 10, color: "var(--cc-muted)", flexShrink: 0 }}>
                {visible.length === 1 ? "1 folder" : `${visible.length} folders`}
              </span>
            )}
          </div>

          {jumpTarget && (
            <button
              type="button"
              onClick={doJump}
              className="hover-bg-surface flex items-center gap-2 text-left"
              aria-label={`Jump to ${jumpTarget}`}
              style={{
                height: 30,
                margin: "6px 6px 0",
                padding: "0 8px",
                borderRadius: 5,
                fontSize: 11,
                fontFamily: "inherit",
                color: "var(--cc-accent)",
                background: tint("var(--cc-accent)", 10),
                border: `1px solid ${tint("var(--cc-accent)", 35)}`,
                cursor: "pointer",
              }}
            >
              <CornerDownLeft size={11} />
              <span className="truncate">Jump to {jumpTarget}</span>
            </button>
          )}

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2"
              style={{ padding: 12, fontSize: 11, color: "var(--cc-error)", lineHeight: 1.5 }}
            >
              <TriangleAlert size={12} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
              <span>Couldn&apos;t read this folder — {error}. Check the path or pick another folder.</span>
            </div>
          ) : (
            <div
              id="cc-folder-list"
              ref={listRef}
              role="listbox"
              aria-label={`Folders in ${path}`}
              aria-activedescendant={activeIdx >= 0 && visible[activeIdx] ? `cc-folder-${activeIdx}` : undefined}
              style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 6 }}
            >
              {visible.map((entry, i) => (
                <FolderRow
                  key={entry.path}
                  rowId={`cc-folder-${i}`}
                  entry={entry}
                  selected={normPath(entry.path) === selNorm || i === activeIdx}
                  dirty={
                    normPath(entry.path) === selNorm && selectedGit?.dirty === true
                      ? true
                      : entry.dirty
                  }
                  onSelect={(en) => {
                    setActiveIdx(i);
                    onSelectPath(en.path);
                  }}
                  onOpen={openEntry}
                />
              ))}
              {!loading && visible.length === 0 && (
                <div style={{ padding: "8px 8px", fontSize: 11, color: "var(--cc-muted)" }}>
                  {filter ? "Nothing here matches that filter." : "No subfolders here."}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── footer hints ── */}
      <div
        className="flex items-center gap-3"
        style={{
          height: 28,
          padding: "0 12px",
          borderTop: "1px solid var(--cc-line)",
          borderBottom: "1px solid var(--cc-line)",
          fontSize: 10,
          color: "var(--cc-muted)",
        }}
      >
        <span className="flex items-center gap-1">
          <CornerDownLeft size={10} aria-hidden="true" />
          Enter open
        </span>
        <span>↑ ↓ move</span>
        <span>← up a level</span>
        <span>Ctrl+Enter create here</span>
      </div>
    </div>
  );
}
