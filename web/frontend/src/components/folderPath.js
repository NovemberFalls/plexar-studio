/**
 * folderPath — pure path helpers shared by FolderBrowser.jsx and
 * NewSessionDialog.jsx (Phase 9, screen 3b).
 *
 * These live in their own module because the eslint react-refresh rule requires
 * component files to export components only. No React, no DOM, no fetch — every
 * function here is a pure string transform and is unit-tested directly.
 *
 * Windows is the primary platform (see CLAUDE.md → Key Constraints), so the
 * canonical form is backslash-separated with no trailing separator; POSIX roots
 * are tolerated so the browser does not break on Linux/macOS.
 */

/** Normalise to backslash form with no trailing separator. */
export function normPath(dir) {
  return String(dir || "").replace(/\//g, "\\").replace(/\\+$/, "");
}

/** Trailing folder name, for display. */
export function baseName(fullPath) {
  const parts = normPath(fullPath).split("\\");
  return parts[parts.length - 1] || String(fullPath || "");
}

/** Drive / root chip for the breadcrumb, e.g. "C:" or "/". */
export function driveOf(fullPath) {
  const p = String(fullPath || "");
  const m = p.match(/^([A-Za-z]:)/);
  if (m) return m[1];
  return p.startsWith("/") || p.startsWith("\\") ? "/" : "";
}

/** Path segments after the drive chip. */
export function segmentsOf(fullPath) {
  const p = normPath(fullPath);
  const drive = driveOf(p);
  const rest = drive && drive !== "/" ? p.slice(drive.length) : p;
  return rest.split("\\").filter(Boolean);
}

/** One level up, or null at the root. */
export function parentOf(fullPath) {
  const p = normPath(fullPath);
  const segs = segmentsOf(p);
  if (segs.length === 0) return null;
  const drive = driveOf(p);
  const head = segs.slice(0, -1);
  if (drive === "/") return "/" + head.join("\\");
  return head.length ? `${drive}\\${head.join("\\")}` : `${drive}\\`;
}

/**
 * Text that "looks like a path": contains a separator, or is a bare drive
 * letter. Such input offers a jump instead of merely filtering the folder.
 */
export function looksLikePath(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return /[\\/]/.test(t) || /^[A-Za-z]:$/.test(t);
}

/** Same Tauri detection App.jsx and PopoutTerminal.jsx use. */
export function isTauriRuntime() {
  return !!(
    typeof window !== "undefined" &&
    (window.__TAURI_INTERNALS__ || window.__TAURI__)
  );
}

/**
 * Older servers answer /api/browse with `dirs` only. Normalise both shapes to
 * one row shape; `hasMeta` records whether metadata is real or merely absent,
 * so we never imply "not a repo" when we simply don't know.
 *
 * `dirty` is collapsed to `true | null` on purpose: anything that is not
 * literally `true` is UNKNOWN, never "clean".
 */
export function normaliseEntries(data) {
  const entries = Array.isArray(data?.entries) ? data.entries : null;
  if (entries) {
    return entries
      .filter((e) => e && (e.path || e.name))
      .map((e) => ({
        name: e.name || baseName(e.path),
        path: e.path || e.name,
        git: e.git === true,
        branch: e.branch ?? null,
        dirty: e.dirty === true ? true : null,
        sessionCount: Number.isFinite(e.session_count) ? e.session_count : 0,
        entryCount: Number.isFinite(e.entry_count) ? e.entry_count : null,
        skipped: e.skipped === true,
        hasMeta: true,
      }));
  }
  const dirs = Array.isArray(data?.dirs) ? data.dirs : [];
  return dirs.map((d) => ({
    name: baseName(d),
    path: d,
    git: false,
    branch: null,
    dirty: null,
    sessionCount: 0,
    entryCount: null,
    skipped: false,
    hasMeta: false,
  }));
}
