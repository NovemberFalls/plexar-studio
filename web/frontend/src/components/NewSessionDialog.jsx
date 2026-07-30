/**
 * NewSessionDialog — Phase 9 (screen 3b): the typed-path field is replaced by a
 * real folder browser, but every capability of the previous dialog survives.
 *
 * WHAT DID NOT CHANGE (drop-in for App.jsx, which is untouched):
 *   · props: { recentLocations, savedLocations, onConfirm, onCancel }
 *   · callback: onConfirm(name.trim(), workdir.trim(), bypassPermissions)
 *   · Escape cancels; backdrop click cancels.
 *   · Typing a path STILL WORKS — the working-directory summary bar holds a live
 *     editable path input (Enter navigates the browser there), and the browser's
 *     filter box also accepts path-like text and offers a jump.
 *   · Bypass still resolves from savedLocations by normalised path, with the
 *     same one-way `manualBypassOverride` latch: once the user flips the toggle
 *     themselves, folder changes no longer overwrite their choice.
 *   · Model / Permission / Effort selects remain display-only (App.jsx applies
 *     the global TopBar settings) — deliberately NOT wired into onConfirm so the
 *     contract stays byte-identical.
 *   · The CLAUDE_CLI_PATH escape-hatch note is retained.
 *
 * WHAT CHANGED: the dialog is 880px, hosts <FolderBrowser/>, and the bypass
 * control now reads "Bypass inherited from folder" when the selected folder is a
 * saved location that carries bypass — presentation only, identical behaviour.
 *
 * Validation for the SELECTED folder only (per the pinned contract): existence
 * via /api/browse and git state via /api/browse/git. `dirty: null` is UNKNOWN,
 * never rendered as clean.
 */

import { useState, useRef, useEffect, useCallback } from "react";
import {
  X,
  FolderOpen,
  ShieldOff,
  ArrowRight,
  ChevronDown,
  Check,
  TriangleAlert,
  GitBranch,
} from "lucide-react";
import FolderBrowser from "./FolderBrowser";
// Shared vocabularies — see sessionVocabulary.js / modelCatalog.js. These lists
// are display-only here, but a decorative select that lists a smaller set of
// effort levels than a session actually supports is still a menu that lies.
import { PERMISSION_MODES, EFFORT_OPTIONS } from "../sessionVocabulary";
import { useModelCatalog } from "../modelCatalog";
import { normPath, baseName, parentOf } from "./folderPath";

const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

/**
 * The Model / Permission / Effort selects are display-only: App.jsx applies the
 * global command-bar settings, and these are NOT passed to onConfirm, so the
 * (name, workdir, bypassPermissions) contract stays byte-identical. That is
 * deliberate and unchanged — see the file header.
 *
 * What DID change: all three lists used to be local copies, and two of them were
 * wrong. The effort list stopped at "high", offering four of the six levels, so
 * this dialog showed a menu claiming a session could not be set to `xhigh` or
 * `max`. The model list still named "Sonnet 4.6" / "Opus 4.6", which are not in
 * Cockpit's catalog at all. Both now come from the shared sources
 * (sessionVocabulary.js, modelCatalog.js) so a decorative select cannot go on
 * misdescribing what a session can be.
 *
 * PERMISSION_OPTIONS is imported under the canonical name; the local alias is
 * kept so the JSX below is untouched.
 */
const PERMISSION_OPTIONS = PERMISSION_MODES;

function ConfigSelect({ label, value, options, onChange }) {
  const [open, setOpen] = useState(false);
  // The model options now come from the shared catalog rather than a literal, so
  // an empty list is reachable (a caller supplying an empty catalog). Falling
  // back to a placeholder keeps the dialog open instead of crashing it on
  // `current.label` — this modal is the only way to create a session.
  const current = options.find((o) => o.id === value) || options[0] || { id: "", label: "—" };
  return (
    <div className="flex flex-col gap-1 flex-1 relative">
      <span className="cc-label" style={{ paddingLeft: 2 }}>{label}</span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-expanded={open}
        className="flex items-center justify-between rounded-lg"
        style={{
          height: 34,
          padding: "0 11px",
          fontSize: 12,
          fontWeight: 600,
          color: "var(--cc-fg)",
          background: "var(--cc-elev)",
          border: "1px solid var(--cc-border)",
          cursor: "pointer",
        }}
      >
        {current.label}
        <ChevronDown size={10} style={{ color: "var(--cc-muted)" }} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            className="absolute z-50 rounded-lg overflow-hidden"
            style={{
              bottom: "100%",
              left: 0,
              right: 0,
              marginBottom: 4,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            }}
          >
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => { onChange(o.id); setOpen(false); }}
                className="w-full text-left"
                style={{
                  fontSize: 12,
                  fontWeight: o.id === value ? 600 : 400,
                  padding: "6px 11px",
                  color: o.id === value ? "var(--cc-accent)" : "var(--cc-dim)",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function NewSessionDialog({
  recentLocations = [],
  savedLocations = [],
  onConfirm,
  onCancel,
}) {
  const initialDir = recentLocations[0] || "C:\\Code";
  const [workdir, setWorkdir] = useState(initialDir);
  const [browsePath, setBrowsePath] = useState(() => parentOf(initialDir) || initialDir);
  const [pathDraft, setPathDraft] = useState(initialDir);
  const [name, setName] = useState("");
  const initialBypass =
    savedLocations.find((l) => normPath(l.path) === normPath(initialDir))?.bypassPermissions || false;
  const [bypassPermissions, setBypassPermissions] = useState(initialBypass);
  const [manualBypassOverride, setManualBypassOverride] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  // The live catalog when the app provides one (main.jsx wraps everything in
  // ModelCatalogProvider), the static shared fallback otherwise — the same list
  // the command bar's model picker shows, never a fifth hand-written copy.
  const catalog = useModelCatalog();
  const modelOptions =
    catalog?.models?.length > 0
      ? catalog.models.map((m) => ({ id: m.id, label: m.label || m.id }))
      : [];
  const [modelSel, setModelSel] = useState(catalog?.models?.[0]?.id ?? "");
  const [permissionSel, setPermissionSel] = useState(PERMISSION_OPTIONS[0].id);
  const [effortSel, setEffortSel] = useState(EFFORT_OPTIONS[0].id);
  const [validation, setValidation] = useState({ state: "unknown", error: "" });
  const [git, setGit] = useState(null);
  const pathInputRef = useRef(null);
  const valReqRef = useRef(0);

  const savedMatch = savedLocations.find((l) => normPath(l.path) === normPath(workdir));
  const inheritedBypass = !!savedMatch?.bypassPermissions;

  // Keep the editable path field in step with the selection.
  useEffect(() => { setPathDraft(workdir); }, [workdir]);

  /**
   * Bypass follows the folder unless the user has taken manual control —
   * identical to the pre-Phase-9 behaviour, just driven by the selected folder
   * instead of the typed field.
   */
  useEffect(() => {
    if (manualBypassOverride) return;
    const match = savedLocations.find((l) => normPath(l.path) === normPath(workdir));
    if (match) setBypassPermissions(!!match.bypassPermissions);
  }, [workdir, savedLocations, manualBypassOverride]);

  // Validate + read git state for the SELECTED folder only.
  useEffect(() => {
    const target = workdir.trim();
    if (!target) {
      setValidation({ state: "invalid", error: "Pick a folder first." });
      setGit(null);
      return;
    }
    const req = ++valReqRef.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/browse?path=${encodeURIComponent(target)}`);
        if (valReqRef.current !== req) return;
        if (!res.ok) {
          setValidation({ state: "invalid", error: "That folder can't be read." });
          setGit(null);
          return;
        }
        setValidation({ state: "valid", error: "" });
      } catch {
        if (valReqRef.current !== req) return;
        setValidation({ state: "invalid", error: "That folder can't be read." });
        setGit(null);
        return;
      }
      try {
        const gres = await fetch(`/api/browse/git?path=${encodeURIComponent(target)}`);
        if (valReqRef.current !== req) return;
        setGit(gres.ok ? await gres.json() : null);
      } catch {
        if (valReqRef.current === req) setGit(null);
      }
    }, 180);
    return () => clearTimeout(timer);
  }, [workdir]);

  const handleSubmit = useCallback(
    (e) => {
      e?.preventDefault?.();
      onConfirm(name.trim(), workdir.trim(), bypassPermissions);
    },
    [bypassPermissions, name, onConfirm, workdir]
  );

  const handleKeyDown = (e) => {
    if (e.key === "Escape") onCancel();
  };

  const commitPathDraft = () => {
    const next = pathDraft.trim();
    if (!next) return;
    setWorkdir(next);
    setBrowsePath(next);
  };

  const toggleBypass = () => {
    setBypassPermissions((v) => !v);
    setManualBypassOverride(true);
  };

  const focusPathInput = () => {
    pathInputRef.current?.focus();
    pathInputRef.current?.select();
  };

  const ok = validation.state === "valid";
  const isRepo = git?.git === true;
  // dirty === null is UNKNOWN (timed out / failed), never "clean".
  const dirtyKnown = git?.dirty === true;

  return (
    <div
      className="cc-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        className="cc-modal cc-card"
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        style={{
          width: 880,
          maxWidth: "94vw",
          maxHeight: "92vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,.55)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── header 46px ── */}
        <div
          className="flex items-center justify-between"
          style={{ height: 46, padding: "0 14px", borderBottom: "1px solid var(--cc-line)", flexShrink: 0 }}
        >
          <div className="flex items-center gap-2">
            <FolderOpen size={14} style={{ color: "var(--cc-accent)" }} aria-hidden="true" />
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>New session</span>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="hover-bg-surface flex rounded-lg"
            style={{ padding: 5, color: "var(--cc-muted)", background: "none", border: "none", cursor: "pointer" }}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}
        >
          <FolderBrowser
            path={browsePath}
            onPathChange={setBrowsePath}
            selectedPath={workdir}
            onSelectPath={setWorkdir}
            onCreateHere={handleSubmit}
            recentLocations={recentLocations}
            savedLocations={savedLocations}
            selectedGit={git}
            onPastePath={focusPathInput}
          />

          {/* ── confirm block ── */}
          <div className="flex flex-col" style={{ padding: 14, gap: 12, overflowY: "auto" }}>
            {/* working-dir summary bar */}
            <div
              className="flex items-center gap-2"
              style={{
                minHeight: 38,
                padding: "0 11px",
                borderRadius: 9,
                background: "var(--cc-elev)",
                border: `1px solid ${ok ? "var(--cc-border)" : tint("var(--cc-error)", 45)}`,
              }}
            >
              <FolderOpen size={13} style={{ color: "var(--cc-accent)", flexShrink: 0 }} aria-hidden="true" />
              <input
                ref={pathInputRef}
                type="text"
                value={pathDraft}
                onChange={(e) => setPathDraft(e.target.value)}
                onBlur={commitPathDraft}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.stopPropagation();
                    commitPathDraft();
                  }
                }}
                aria-label="Working directory"
                placeholder="C:\Code"
                className="flex-1 outline-none"
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--cc-fg)",
                  fontSize: 12,
                  fontFamily: "inherit",
                  minWidth: 0,
                }}
              />
              {ok ? (
                <span className="flex items-center gap-1" style={{ flexShrink: 0, color: "var(--cc-ok)", fontSize: 11 }}>
                  <Check size={11} aria-hidden="true" />
                  exists{isRepo ? " · git repo" : ""}
                </span>
              ) : validation.state === "invalid" ? (
                <span className="flex items-center gap-1" style={{ flexShrink: 0, color: "var(--cc-error)", fontSize: 11 }}>
                  <TriangleAlert size={11} aria-hidden="true" />
                  {validation.error}
                </span>
              ) : null}
              {isRepo && git?.branch && (
                <span className="flex items-center gap-1" style={{ flexShrink: 0, fontSize: 10, color: "var(--cc-muted)" }}>
                  <GitBranch size={10} aria-hidden="true" />
                  {git.branch}
                </span>
              )}
              {dirtyKnown && (
                <span
                  data-testid="summary-dirty-dot"
                  aria-label="uncommitted changes"
                  style={{ width: 5, height: 5, borderRadius: 999, background: "var(--cc-waiting)", flexShrink: 0 }}
                />
              )}
            </div>

            {/* bypass — inherited from the folder when the folder is saved with it */}
            <button
              type="button"
              onClick={toggleBypass}
              className="flex items-center gap-2.5 text-left"
              aria-pressed={bypassPermissions}
              aria-label={inheritedBypass ? "Bypass inherited from folder" : "Bypass permissions"}
              title="Skip all permission prompts (--dangerously-skip-permissions)"
              style={{
                padding: "9px 11px",
                borderRadius: 9,
                background: bypassPermissions ? tint("var(--cc-waiting)", 8) : "var(--cc-elev)",
                border: `1px solid ${bypassPermissions ? tint("var(--cc-waiting)", 45) : "var(--cc-border)"}`,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <ShieldOff
                size={15}
                style={{ color: bypassPermissions ? "var(--cc-waiting)" : "var(--cc-muted)", flexShrink: 0 }}
                aria-hidden="true"
              />
              <div className="flex-1 flex flex-col" style={{ gap: 1 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: bypassPermissions ? "var(--cc-waiting)" : "var(--cc-fg)",
                  }}
                >
                  {inheritedBypass ? "Bypass inherited from folder" : "Bypass permissions"}
                </span>
                <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
                  {inheritedBypass
                    ? `${baseName(workdir)} is saved with bypass on — Claude runs without approval prompts.`
                    : "Claude runs fully autonomously — no approval prompts"}
                </span>
              </div>
              <div
                style={{
                  width: 38,
                  height: 22,
                  borderRadius: 999,
                  background: bypassPermissions ? "var(--cc-waiting)" : tint("var(--cc-fg)", 20),
                  position: "relative",
                  transition: "background .15s",
                  flexShrink: 0,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 2,
                    left: bypassPermissions ? 18 : 2,
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    background: "var(--cc-surface)",
                    transition: "left .15s",
                  }}
                />
              </div>
            </button>

            {/* name + config */}
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1" style={{ flex: 1, minWidth: 0 }}>
                <span className="cc-label" style={{ paddingLeft: 2 }}>
                  Name <span style={{ fontWeight: 400, opacity: 0.7 }}>— optional</span>
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onFocus={() => setNameFocused(true)}
                  onBlur={() => setNameFocused(false)}
                  aria-label="Session name"
                  placeholder={`${baseName(workdir)} session`}
                  style={{
                    height: 34,
                    padding: "0 11px",
                    borderRadius: 9,
                    background: "var(--cc-elev)",
                    color: "var(--cc-fg)",
                    border: `1px solid ${nameFocused ? "var(--cc-accent)" : "var(--cc-border)"}`,
                    outline: "none",
                    fontFamily: "inherit",
                    fontSize: 12,
                  }}
                />
              </div>
              <ConfigSelect label="Model" value={modelSel} options={modelOptions} onChange={setModelSel} />
              <ConfigSelect
                label="Permission"
                value={permissionSel}
                options={PERMISSION_OPTIONS}
                onChange={setPermissionSel}
              />
              <ConfigSelect label="Effort" value={effortSel} options={EFFORT_OPTIONS} onChange={setEffortSel} />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col" style={{ gap: 3 }}>
                <span role="note" style={{ fontSize: 10, color: "var(--cc-muted)" }}>
                  Opens in the next free pane.
                </span>
                {/* CLI-path callout: the `claude` binary is discovered off PATH.
                    If it lives somewhere nonstandard, CLAUDE_CLI_PATH overrides —
                    surfaced here so users learn the escape hatch before a spawn
                    fails (the spawn error names it too). */}
                <span role="note" style={{ fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.4 }}>
                  Can&apos;t find <code style={{ fontFamily: "var(--cc-mono, monospace)" }}>claude</code>? Set{" "}
                  <code style={{ fontFamily: "var(--cc-mono, monospace)", color: "var(--cc-dim)" }}>CLAUDE_CLI_PATH</code>{" "}
                  before launching Cockpit.
                </span>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={onCancel}
                  aria-label="Cancel"
                  className="hover-bg-surface"
                  style={{
                    height: 34,
                    padding: "0 15px",
                    borderRadius: 9,
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: "inherit",
                    color: "var(--cc-dim)",
                    background: "none",
                    border: "1px solid var(--cc-border)",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  aria-label="Create session"
                  className="flex items-center gap-2"
                  style={{
                    height: 34,
                    padding: "0 17px",
                    borderRadius: 9,
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: "inherit",
                    color: "#0f1216",
                    background: "var(--cc-accent)",
                    border: "none",
                    cursor: "pointer",
                  }}
                >
                  Create
                  <ArrowRight size={13} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
