/**
 * NewSessionDialog — Phase 9 (screen 3b): the typed-path field is replaced by a
 * real folder browser, but every capability of the previous dialog survives.
 *
 * THE CONFIG SELECTS ARE WIRED (changed — they used to be decorative).
 *   This header previously asserted that Model / Permission / Effort were
 *   "deliberately NOT passed to onConfirm so the contract stays byte-identical".
 *   That was a defect wearing a design's clothes: a user who picked "Opus 5"
 *   here got whatever the TopBar happened to be set to, and the dialog said
 *   nothing about it. A control that does not control is a lie in the same
 *   class as a pill naming a model the session will not spawn on.
 *
 *   · props ADD: { defaultModel, defaultPermissionMode, defaultEffort,
 *                  defaultHarness } — the TopBar's current settings, so the
 *     dialog OPENS on them and a user who changes nothing gets exactly what the
 *     command bar already showed. They are NOT catalog[0]: substituting a
 *     plausible first entry is the very defect this wiring removes.
 *   · callback: onConfirm(name.trim(), workdir.trim(), bypassPermissions,
 *                         { model, permissionMode, effort, harness })
 *     App.jsx treats the 4th argument as per-session OVERRIDES; any key it
 *     omits falls back to the global setting.
 *   · A Harness select (Claude Code | Codex) now sits beside Model, so a Codex
 *     session can be created from here at all — previously impossible. Harness
 *     and model are ORTHOGONAL to provider; the Model list is narrowed by
 *     groupsForHarness() exactly as the TopBar picker narrows it.
 *
 * WHAT DID NOT CHANGE:
 *   · props: { recentLocations, savedLocations, onConfirm, onCancel }
 *   · The first three onConfirm arguments, in order and meaning.
 *   · Escape cancels; backdrop click cancels.
 *   · Typing a path STILL WORKS — the working-directory summary bar holds a live
 *     editable path input (Enter navigates the browser there), and the browser's
 *     filter box also accepts path-like text and offers a jump.
 *   · Bypass still resolves from savedLocations by normalised path, with the
 *     same one-way `manualBypassOverride` latch: once the user flips the toggle
 *     themselves, folder changes no longer overwrite their choice.
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

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
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
// Shared vocabularies — see sessionVocabulary.js / modelCatalog.js. Now that
// these selects actually drive the spawn, a list that is a subset of what a
// session supports is not merely a menu that lies, it is a capability the user
// cannot reach; hence the shared sources, never a local copy.
import { PERMISSION_MODES, EFFORT_OPTIONS } from "../sessionVocabulary";
import {
  useModelCatalog,
  HARNESSES,
  DEFAULT_HARNESS,
  groupsForHarness,
  reconcileModelForHarness,
} from "../modelCatalog";
import { normPath, baseName, parentOf } from "./folderPath";
import { computeSelectPlacement, PANEL_MAX } from "./selectPlacement";

const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

/**
 * All four lists come from shared sources, and that mattered even while these
 * selects were decorative: the local copies they replaced were WRONG. The
 * effort list stopped at "high", offering four of the six levels; the model
 * list still named "Sonnet 4.6" / "Opus 4.6", which are not in Plexar Studio's
 * catalog at all. Now that the selects drive the spawn, a stale local copy
 * would not just misdescribe a session — it would create the wrong one.
 *
 * PERMISSION_OPTIONS is imported under the canonical name; the local alias is
 * kept so the JSX below is untouched.
 */
const PERMISSION_OPTIONS = PERMISSION_MODES;

/** A third harness choice, local to this dialog only (not added to the shared
 *  HARNESSES list in modelCatalog.js — that list also drives the TopBar pill,
 *  which has no Plexar Harness support yet). Selecting it routes session
 *  creation through /api/harness/sessions instead of /api/terminals; see
 *  App.jsx's createSession. */
const PLEXAR_HARNESS_ID = "plexar-harness";
const HARNESS_OPTIONS = [...HARNESSES, { id: PLEXAR_HARNESS_ID, label: "Plexar Harness" }];

/** Shown beside Model / Permission / Effort when Plexar Harness is selected —
 *  those three selects were built for the Claude Code / Codex launch path and
 *  do not apply here, so they are rendered visibly disabled with this reason
 *  rather than silently inert (the UNSERVED_MODEL_REASON /
 *  CODEX_LOCAL_UNSUPPORTED_NOTE pattern this file already follows elsewhere). */
const PLEXAR_HARNESS_CONFIG_REASON =
  "Plexar Harness sessions don't use a model, permission mode or effort level here — " +
  "pick the model and reasoning effort from the session's own header once it opens.";

/**
 * ConfigSelect — a listbox-ish dropdown that is reachable in every position.
 *
 * Three things were wrong and all three are fixed here:
 *   1. it always opened upward regardless of available space;
 *   2. it had no max-height and no scrolling, so a six-option list overflowed;
 *   3. it was CLIPPED by an ancestor — the confirm block sets `overflowY: auto`
 *      (and the modal + form both set `overflow: hidden`), all of which the
 *      layout genuinely needs. So the panel is PORTALLED to document.body and
 *      positioned from the trigger's rect; no ancestor can clip it, and
 *      flipping direction becomes trivial.
 *
 * The options stay `<button>` elements rather than `role="option"` inside a
 * `role="listbox"`: the dialog's existing regression suite addresses them by
 * button role, and swapping the role would break those assertions for a purely
 * nominal gain. Selection is conveyed with `aria-current`, which is valid on a
 * button (`aria-selected` is not).
 */
export function ConfigSelect({ label, value, options, onChange, disabled = false, disabledReason }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);
  // The model options come from the shared catalog rather than a literal, so an
  // empty list is reachable (a caller supplying an empty catalog). Falling back
  // to a placeholder keeps the dialog open instead of crashing it on
  // `current.label` — this modal is the only way to create a session.
  //
  // An id that is SET but not in the list renders AS ITSELF, never as the first
  // option. Substituting a plausible neighbour is exactly the defect that let
  // the TopBar pill read "Opus 5" while the session spawned on something else;
  // now that this select drives the spawn, the same substitution here would put
  // a wrong model name on the button the user is about to click. Only an unset
  // value falls through to options[0], which is a genuine "nothing chosen yet".
  const current =
    options.find((o) => o.id === value) ||
    (value ? { id: value, label: value } : null) ||
    options[0] || { id: "", label: "—" };

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(computeSelectPlacement(rect, window.innerHeight || 0));
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    measure();
    // A portalled panel that stayed put while the page moved would float
    // detached from its trigger, so movement closes it rather than lying.
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, measure]);

  // Roving focus: whatever option is active owns the DOM focus, so screen
  // readers announce it and Enter lands on the right row.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.focus();
  }, [open, activeIndex, pos]);

  const close = (refocus = true) => {
    setOpen(false);
    setActiveIndex(-1);
    if (refocus) triggerRef.current?.focus();
  };

  const openAt = (index) => {
    if (options.length === 0) return;
    setOpen(true);
    setActiveIndex(Math.max(0, Math.min(options.length - 1, index)));
  };

  const onTriggerKeyDown = (e) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (open) setActiveIndex((i) => (e.key === "ArrowDown" ? Math.min(options.length - 1, i + 1) : Math.max(0, i - 1)));
      else openAt(e.key === "ArrowDown" ? 0 : options.length - 1);
    }
  };

  const onOptionKeyDown = (e, index) => {
    // The panel is portalled, but React events still bubble up the REACT tree —
    // straight into the dialog's Escape-cancels handler. Stop them here or
    // closing the menu would close the whole New session dialog.
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex(Math.min(options.length - 1, index + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex(Math.max(0, index - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    } else if (e.key === "Tab") {
      close(false);
    }
  };

  // An option may be present-but-unselectable (a local engine listed under the
  // Codex harness — up, publishing models, and unreachable by that CLI). It is
  // still RENDERED, because omitting it is what "down" looks like and the
  // engine is not down; it just cannot be chosen, and the row says why.
  const select = (o) => {
    if (o.disabled) return;
    onChange(o.id);
    close();
  };

  return (
    <div className="flex flex-col gap-1 flex-1 relative">
      <span className="cc-label" style={{ paddingLeft: 2 }}>{label}</span>
      <button
        ref={triggerRef}
        type="button"
        onClick={() =>
          disabled ? undefined : (open ? close(false) : openAt(Math.max(0, options.findIndex((o) => o.id === value))))
        }
        onKeyDown={disabled ? undefined : onTriggerKeyDown}
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-disabled={disabled ? "true" : undefined}
        title={disabled ? disabledReason : undefined}
        className="flex items-center justify-between rounded-lg"
        style={{
          height: 34,
          padding: "0 11px",
          fontSize: 12,
          fontWeight: 600,
          color: disabled ? "var(--cc-muted)" : "var(--cc-fg)",
          background: "var(--cc-elev)",
          border: "1px solid var(--cc-border)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
      >
        {current.label}
        <ChevronDown size={10} style={{ color: "var(--cc-muted)" }} />
      </button>
      {open && !disabled &&
        createPortal(
          <>
            {/*
              The panel is portalled to document.body, so it is a SIBLING of
              `.cc-modal-backdrop` (z-index 60), not a descendant. Tailwind's
              z-50 therefore put it BEHIND the backdrop's rgba(0,0,0,.55) +
              blur(4px) — the dropdown was drawn, then dimmed and blurred by the
              modal it belongs to. Hence explicit z-indexes above 60 here; a
              class-based z-* cannot be reasoned about across a portal boundary.
            */}
            <div
              className="fixed inset-0"
              style={{ zIndex: 70 }}
              onClick={() => close(false)}
              aria-hidden="true"
            />
            <div
              data-testid={`config-select-panel-${label.toLowerCase()}`}
              data-placement={pos?.placement || "down"}
              aria-label={`${label} options`}
              className="rounded-lg"
              style={{
                ...(pos?.style || { position: "fixed", top: 0, left: 0, maxHeight: PANEL_MAX }),
                zIndex: 71,
                // Bounded height + scrolling is what guarantees the first and
                // last options are reachable no matter how long the list is.
                overflowY: "auto",
                overflowX: "hidden",
                background: "var(--cc-elev)",
                border: "1px solid var(--cc-border)",
                boxShadow: `0 8px 24px ${tint("var(--cc-bg)", 70)}`,
              }}
            >
              {options.map((o, i) => (
                <button
                  key={o.id}
                  ref={(el) => { optionRefs.current[i] = el; }}
                  type="button"
                  onClick={() => select(o)}
                  onKeyDown={(e) => onOptionKeyDown(e, i)}
                  onFocus={() => setActiveIndex(i)}
                  aria-current={o.id === value ? "true" : undefined}
                  aria-disabled={o.disabled ? "true" : undefined}
                  title={o.reason || undefined}
                  className="w-full text-left hover-bg-surface"
                  style={{
                    fontSize: 12,
                    fontWeight: o.id === value ? 600 : 400,
                    padding: "6px 11px",
                    color: o.disabled
                      ? "var(--cc-muted)"
                      : o.id === value
                        ? "var(--cc-accent)"
                        : "var(--cc-dim)",
                    background: "none",
                    border: "none",
                    // `not-allowed` rather than `pointer`: the row is reachable
                    // by keyboard and mouse and answers with its reason, but
                    // clicking it will not change the selection.
                    cursor: o.disabled ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}

export default function NewSessionDialog({
  recentLocations = [],
  savedLocations = [],
  // The TopBar's CURRENT settings. The dialog opens on them so that creating a
  // session without touching these selects produces exactly what the command bar
  // already advertised — the selects are per-session overrides, not a second,
  // competing set of defaults.
  defaultModel,
  defaultPermissionMode,
  defaultEffort,
  defaultHarness,
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
  const [harnessSel, setHarnessSel] = useState(defaultHarness || DEFAULT_HARNESS);
  // NOT `catalog.models[0].id`. That was the same "substitute a plausible
  // model" defect the TopBar pill had: the dialog silently proposed whichever
  // model happened to sort first, and (while these selects were decorative) the
  // session then spawned on something else entirely. The initial value is the
  // caller's actual current model, full stop.
  const [modelSel, setModelSel] = useState(defaultModel || "");
  const [permissionSel, setPermissionSel] = useState(
    defaultPermissionMode || PERMISSION_OPTIONS[0].id
  );
  const [effortSel, setEffortSel] = useState(defaultEffort || EFFORT_OPTIONS[0].id);

  // Narrowed by harness through the SAME pure function the TopBar picker uses,
  // so the two surfaces cannot drift into offering different model lists for
  // one harness. Flattened because ConfigSelect is a flat listbox; a group's
  // `note` rides down onto each of its rows so the reason survives flattening.
  const modelOptions = groupsForHarness(catalog?.groups, harnessSel).flatMap((g) =>
    (g?.models || []).map((m) => ({
      id: m.id,
      label: m.label || m.id,
      disabled: m.selectable === false,
      reason: m.unavailableReason || g?.note,
    }))
  );

  /**
   * Switching harness resets the model ONLY when the current one cannot run on
   * the new harness — reconcileModelForHarness is the single arbiter of that,
   * shared with App.jsx so the dialog and the TopBar cannot drift apart.
   *
   * A blanket reset would stomp a perfectly valid OpenRouter selection, which
   * really is reachable from both CLIs. LOCAL IS NOT, and this comment used to
   * claim it was ("OpenRouter or local ... both CLIs can reach them"): Codex
   * speaks the Responses API, the local engines serve Chat Completions, and
   * create_terminal refuses the pair outright. See getModelHarness.
   */
  const changeHarness = (next) => {
    setHarnessSel(next);
    // Plexar Harness is not in the shared catalog's harness vocabulary —
    // reconcileModelForHarness only knows claude-code/codex/any, so skip it
    // rather than have it "fix" the model to something meaningless for a
    // harness that does not use this dialog's model select at all.
    if (next === PLEXAR_HARNESS_ID) return;
    const { model: fixed, changed } = reconcileModelForHarness(modelSel, next);
    if (changed) setModelSel(fixed);
  };
  const isPlexarHarness = harnessSel === PLEXAR_HARNESS_ID;
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
      // The 4th argument is per-session OVERRIDES. The first three are byte-for
      // -byte what they always were, so any caller that ignores the 4th keeps
      // working — but App.jsx reads it, which is what makes these selects real.
      onConfirm(name.trim(), workdir.trim(), bypassPermissions, {
        model: modelSel,
        permissionMode: permissionSel,
        effort: effortSel,
        harness: harnessSel,
      });
    },
    [bypassPermissions, effortSel, harnessSel, modelSel, name, onConfirm, permissionSel, workdir]
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
              {/* Harness sits LEFT of Model, matching the TopBar's ordering:
                  it decides which CLI runs, and therefore which models the next
                  select may offer. */}
              <ConfigSelect
                label="Harness"
                value={harnessSel}
                options={HARNESS_OPTIONS}
                onChange={changeHarness}
              />
              <ConfigSelect
                label="Model"
                value={modelSel}
                options={modelOptions}
                onChange={setModelSel}
                disabled={isPlexarHarness}
                disabledReason={PLEXAR_HARNESS_CONFIG_REASON}
              />
              <ConfigSelect
                label="Permission"
                value={permissionSel}
                options={PERMISSION_OPTIONS}
                onChange={setPermissionSel}
                disabled={isPlexarHarness}
                disabledReason={PLEXAR_HARNESS_CONFIG_REASON}
              />
              <ConfigSelect
                label="Effort"
                value={effortSel}
                options={EFFORT_OPTIONS}
                onChange={setEffortSel}
                disabled={isPlexarHarness}
                disabledReason={PLEXAR_HARNESS_CONFIG_REASON}
              />
            </div>
            {isPlexarHarness && (
              <span role="note" data-testid="plexar-harness-config-reason" style={{ fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.4 }}>
                {PLEXAR_HARNESS_CONFIG_REASON}
              </span>
            )}

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
                  before launching Plexar Studio.
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
