/* eslint-disable react-refresh/only-export-components -- effectiveValue,
   isTranslucent and parseImportedTheme are pure helpers exported ONLY so the
   test suite can pin them (import validation in particular must be provable in
   isolation). They belong beside their single call site; a separate module would
   scatter three small functions away from the page that defines their meaning. */
/**
 * TokensSettings — the Settings ▸ Design tokens page (Phase 5, spec §7).
 *
 * The raw `--cc-*` custom properties every surface in Cockpit is built from,
 * editable by hand with a live-painting preview.
 *
 * TWO WRITES PER EDIT — the rule this whole file is organised around:
 *   1. `setTokenOverride(name, value)` from useTheme() → paints the DOM NOW, so
 *      the app recolors as the user drags the picker.
 *   2. `setField("appearance.token_overrides", <COMPLETE MAP>)` → the Settings
 *      shell's `Save changes` persists it.
 *
 * The second write MUST carry the whole map. `appearance.token_overrides` is a
 * WHOLE_DICT_PATH (see hooks/useSettings.js): the backend REPLACES it rather
 * than deep-merging, because a free-form map has to allow deletion. A narrow
 * leaf write such as `appearance.token_overrides.--cc-bg` would therefore wipe
 * every other override the user had saved. So every mutation here rebuilds the
 * full map — `{...tokenOverrides, [name]: value}` to set, and the map with the
 * key OMITTED to clear. The same rule governs `appearance.user_palettes`.
 *
 * Read-only BY DESIGN (documented, not disabled-and-silent):
 *   - the radius scale (4 · 7 · 9 · 12 · 999) and the mono font stack. They are
 *     real design decisions but they are not in OVERRIDABLE_TOKENS, so there is
 *     nothing to write them to. Shown as reference rather than dead inputs.
 *   - the xterm ANSI palette note: it is built in TerminalPane from the base
 *     theme OBJECT, not from the CSS custom properties, so token overrides do
 *     NOT reach it today. Said plainly instead of implied.
 *
 * Props (pinned by the Settings shell, same semantics as ProvidersSettings):
 *   get(dottedPath, fallback) → current DRAFT value
 *   setField(dottedPath, value) → record an unsaved edit
 *   isDirty(dottedPath) → bool (prefix-aware); true groups highlight --cc-waiting
 *   deleteField(dottedPath) → optional; removes a key outright (used by Reset all)
 */

import { useMemo, useRef, useState } from "react";
import { Download, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { useTheme } from "../../hooks/useTheme.jsx";
import { TOKEN_GROUPS, OVERRIDABLE_TOKENS } from "../../themes/themeData.js";

// ── tokens / shared style fragments ───────────────────────
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const DIRTY = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const TOKENS_PATH = "appearance.token_overrides";
const PALETTES_PATH = "appearance.user_palettes";
const GLOW_SIZE_PATH = "appearance.glow_size";
const ACCENT_PATH = "appearance.accent";

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

const LABEL = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

/**
 * Alpha has to be VISIBLE — several real tokens are rgba() (--cc-border is
 * rgba(255,255,255,.08)), and painting one on an opaque tile makes it read as a
 * solid mid-grey. Every swatch therefore sits on a checkerboard built from the
 * foreground token, so translucency looks translucent.
 */
const CHECKER = `repeating-conic-gradient(${tint("var(--cc-fg)", 22)} 0% 25%, transparent 0% 50%) 50% / 8px 8px`;

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const TRANSLUCENT = /rgba|hsla|color-mix|transparent|^#[0-9a-fA-F]{8}$/i;

/** Which key on a theme object backs each token (for the un-overridden value). */
const THEME_KEY = {
  "--cc-bg": "bg", "--cc-bg2": "bg2", "--cc-surface": "surface", "--cc-elev": "elev",
  "--cc-term": "term", "--cc-border": "border", "--cc-line": "line", "--cc-accent": "accent",
  "--cc-fg": "fg", "--cc-dim": "dim", "--cc-muted": "muted", "--cc-fn": "fn",
  "--cc-working": "working", "--cc-thinking": "thinking", "--cc-waiting": "waiting",
  "--cc-idle": "idle", "--cc-error": "error", "--cc-ok": "ok",
  "--cc-type": "type", "--cc-macro": "macro", "--cc-num": "num",
};

/**
 * WHERE EACH TOKEN IS USED — derived by grepping this repo for `--cc-<name>`
 * across src/**.jsx and src/**.js on 2026-07-30, excluding index.css, the theme
 * data module, and tests. `files` is the number of component modules that
 * reference the token; `surfaces` names them in the shell's own vocabulary.
 *
 * Nothing here is estimated. A token whose consumers could not be enumerated
 * would carry `files: null` and render "used broadly" instead of a number.
 * Every token listed here has at least one real consumer: --cc-kw used to be
 * the honest edge case (zero consumers, only this page's own preview) and was
 * removed from the token system outright rather than kept as decoration.
 */
const TOKEN_USAGE = {
  "--cc-bg": { files: 8, surfaces: ["Shell", "Command bar", "Lane strip", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-bg2": { files: 7, surfaces: ["Rail", "Status strip", "Inspector", "Sidebar", "Settings", "Engine"] },
  "--cc-surface": { files: 24, surfaces: ["Shell", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-elev": { files: 14, surfaces: ["Rail", "Command bar", "Inspector", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-term": { files: 5, surfaces: ["Workspace panes", "Fleet", "Dialogs"] },
  "--cc-border": { files: 29, surfaces: ["Shell", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-line": { files: 15, surfaces: ["Command bar", "Inspector", "Workspace panes", "Settings", "Engine", "Dialogs"] },
  "--cc-accent": { files: 21, surfaces: ["Rail", "Shell", "Inspector", "Sidebar", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-fg": { files: 24, surfaces: ["Shell", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-dim": { files: 26, surfaces: ["Shell", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-muted": { files: 27, surfaces: ["Shell", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-fn": { files: 8, surfaces: ["Rail", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet"] },
  "--cc-working": { files: 5, surfaces: ["Lane strip", "Inspector", "Sidebar", "Fleet", "Dialogs"] },
  "--cc-thinking": { files: 7, surfaces: ["Lane strip", "Inspector", "Sidebar", "Fleet", "Engine"] },
  "--cc-waiting": { files: 19, surfaces: ["Rail", "Lane strip", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet", "Dialogs"] },
  "--cc-idle": { files: 7, surfaces: ["Lane strip", "Workspace panes", "Inspector", "Sidebar", "Settings", "Fleet"] },
  "--cc-error": { files: 11, surfaces: ["Rail", "Status strip", "Lane strip", "Workspace panes", "Inspector", "Sidebar", "Settings", "Engine", "Fleet"] },
  "--cc-ok": { files: 9, surfaces: ["Rail", "Status strip", "Inspector", "Settings", "Engine"] },
  "--cc-type": { files: 3, surfaces: ["Settings", "Engine"] },
  "--cc-macro": { files: 6, surfaces: ["Settings", "Engine", "Fleet"] },
  "--cc-num": { files: 2, surfaces: ["Settings", "Engine"] },
};

/** The radius + font decisions the shell uses. Reference only — see header. */
const RADIUS_SCALE = [
  { value: 4, use: "hairline chips, progress fills" },
  { value: 7, use: "inputs, buttons, small badges" },
  { value: 9, use: "token cards, callouts" },
  { value: 12, use: "settings cards, panels" },
  { value: 999, use: "pills and state chips" },
];
const MONO_STACK = 'var(--font-mono, ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace)';

const STATE_CHIPS = [
  { id: "working", label: "working" },
  { id: "thinking", label: "thinking" },
  { id: "waiting", label: "waiting" },
  { id: "idle", label: "idle" },
  { id: "error", label: "error" },
];

// ── pure helpers (exported for the test suite) ────────────

/** The value a token resolves to right now: override → accent → base theme. */
export function effectiveValue(token, overrides, theme, accent) {
  const ov = overrides && overrides[token];
  if (typeof ov === "string" && ov.length > 0) return ov;
  if ((token === "--cc-accent" || token === "--cc-working") && accent) return accent;
  const key = THEME_KEY[token];
  const base = key && theme ? theme[key] : null;
  return typeof base === "string" && base.length > 0 ? base : "unset";
}

/** True when a value carries alpha, so its swatch needs the checkerboard read. */
export function isTranslucent(value) {
  return typeof value === "string" && TRANSLUCENT.test(value);
}

/**
 * Validate an imported theme document. Returns {ok, overrides, base} or
 * {ok: false, error}. Unknown token keys are REJECTED (not silently dropped) —
 * silently discarding half a paste looks like it worked.
 */
export function parseImportedTheme(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, error: "That is not valid JSON." };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "Expected a JSON object with an \"overrides\" map." };
  }
  const raw = doc.overrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "Missing an \"overrides\" object." };
  }
  const allowed = new Set(OVERRIDABLE_TOKENS);
  const unknown = Object.keys(raw).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `Unknown token${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Only Cockpit's --cc-* tokens can be imported.`,
    };
  }
  const bad = Object.entries(raw).filter(([, v]) => typeof v !== "string" || v.length === 0);
  if (bad.length > 0) {
    return { ok: false, error: `Not a color string: ${bad.map(([k]) => k).join(", ")}.` };
  }
  return {
    ok: true,
    base: typeof doc.base === "string" ? doc.base : null,
    overrides: { ...raw },
  };
}

// ── primitives ────────────────────────────────────────────

function GroupHeader({ label, note, dirty }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...LABEL, fontSize: 10, fontWeight: 700, color: "var(--cc-fg)" }}>
          {label}
        </span>
        {dirty && (
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".08em", color: DIRTY }}>
            UNSAVED
          </span>
        )}
        <span style={{ flex: 1, height: 1, background: "var(--cc-line)" }} aria-hidden="true" />
      </div>
      {note && (
        <div style={{ fontSize: 11, color: "var(--cc-muted)", marginTop: 4, lineHeight: 1.5 }}>
          {note}
        </div>
      )}
    </div>
  );
}

/** A color tile over a checkerboard, so alpha reads as alpha. */
function Swatch({ token, value, size = 26 }) {
  return (
    <span
      data-testid={`swatch-${token}`}
      data-value={value}
      data-alpha={isTranslucent(value) ? "true" : "false"}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: 7,
        border: "1px solid var(--cc-border)",
        background: CHECKER,
        flexShrink: 0,
        overflow: "hidden",
        display: "inline-block",
      }}
    >
      <span
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          background: value === "unset" ? "transparent" : value,
        }}
      />
    </span>
  );
}

function EditedPill() {
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".1em",
        textTransform: "uppercase",
        color: DIRTY,
        background: tint(DIRTY, 8),
        border: `1px solid ${tint(DIRTY, 35)}`,
        borderRadius: 4,
        padding: "1px 4px",
        flexShrink: 0,
      }}
    >
      Edited
    </span>
  );
}

/** One token card in the 4-up grid. Clicking it selects the token for editing. */
function TokenCard({ token, value, overridden, selected, onSelect }) {
  return (
    <button
      type="button"
      data-testid={`token-card-${token}`}
      data-overridden={overridden ? "true" : "false"}
      onClick={() => onSelect(token)}
      aria-pressed={selected}
      aria-label={`Edit ${token}, currently ${value}`}
      className="transition-colors hover-bg-elevated"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        textAlign: "left",
        padding: 8,
        borderRadius: 9,
        background: "var(--cc-surface)",
        border: `1px solid ${selected ? "var(--cc-accent)" : overridden ? tint(DIRTY, 45) : "var(--cc-border)"}`,
        color: "var(--cc-fg)",
        fontFamily: "inherit",
        cursor: "pointer",
        minWidth: 0,
      }}
    >
      <Swatch token={token} value={value} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {token}
          </span>
          {overridden && <EditedPill />}
        </span>
        <span
          style={{
            display: "block",
            fontSize: 10,
            color: "var(--cc-muted)",
            fontFamily: MONO_STACK,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {value}
        </span>
      </span>
    </button>
  );
}

/** A pill-shaped button used for palettes and small actions. */
function PillButton({ children, onClick, active, testId, label, accent, icon: Icon }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-pressed={active === undefined ? undefined : Boolean(active)}
      aria-label={label}
      title={label}
      className="transition-colors hover-bg-elevated"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 24,
        padding: "0 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        fontFamily: "inherit",
        background: active ? "var(--cc-accent)" : accent ? tint("var(--cc-accent)", 10) : "var(--cc-elev)",
        color: active ? ACCENT_FG : "var(--cc-fg)",
        border: `1px solid ${active ? "transparent" : "var(--cc-border)"}`,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {Icon && <Icon size={11} />}
      {children}
    </button>
  );
}

function Callout({ token = "var(--cc-muted)", children, testId, role = "note" }) {
  return (
    <div
      data-testid={testId}
      role={role}
      style={{
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      {children}
    </div>
  );
}

/** The per-token editor: native picker + free-text CSS color + Reset. */
function TokenEditor({ token, value, overridden, onCommit, onClear, onClose }) {
  const hexish = HEX6.test(value) ? value : "#000000";
  const alpha = isTranslucent(value);
  return (
    <div style={{ ...CARD, borderColor: "var(--cc-accent)" }} data-testid="token-editor">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Swatch token={`editor-${token}`} value={value} size={26} />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>{token}</span>
        {overridden && <EditedPill />}
        <span style={{ flex: 1 }} />
        <PillButton
          testId="token-editor-reset"
          label={`Reset ${token} to the palette value`}
          onClick={() => onClear(token)}
          icon={RotateCcw}
        >
          Reset
        </PillButton>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close token editor"
          className="rounded transition-colors hover-bg-elevated"
          style={{
            width: 24,
            height: 24,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 7,
            background: "none",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-muted)",
            cursor: "pointer",
          }}
        >
          <X size={12} />
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <input
          type="color"
          value={hexish}
          onChange={(e) => onCommit(token, e.target.value)}
          aria-label={`${token} color picker`}
          data-testid={`picker-${token}`}
          style={{
            width: 44,
            height: 26,
            padding: 0,
            borderRadius: 7,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        />
        <input
          type="text"
          value={value === "unset" ? "" : value}
          onChange={(e) => onCommit(token, e.target.value)}
          spellCheck={false}
          autoComplete="off"
          placeholder="#4ea1e8 · rgba(255,255,255,.08) · color-mix(…)"
          aria-label={`${token} value`}
          data-testid={`field-${TOKENS_PATH}.${token}`}
          data-dirty={overridden ? "true" : "false"}
          style={{
            flex: 1,
            minWidth: 0,
            height: 26,
            padding: "0 8px",
            fontSize: 11,
            fontFamily: MONO_STACK,
            borderRadius: 7,
            background: "var(--cc-elev)",
            border: `1px solid ${overridden ? DIRTY : "var(--cc-border)"}`,
            color: overridden ? DIRTY : "var(--cc-fg)",
            outline: "none",
          }}
        />
      </div>

      <div style={{ fontSize: 11, color: "var(--cc-muted)", marginTop: 8, lineHeight: 1.5 }}>
        {alpha
          ? "This value carries alpha, so the picker cannot represent it — type rgba() or color-mix() into the text field to keep the transparency."
          : "The picker writes 6-digit hex. The text field accepts any CSS color, including rgba() and color-mix()."}
        {token === "--cc-accent" && " Editing the accent also retints --cc-working, the pane glow."}
      </div>

      {/* Symmetry with ThemePopover: whichever surface you are on tells you the
          truth about the other. An override here OUTRANKS the rail's accent
          picker (applyThemeToDOM resolves overrides first), so the picker goes
          inert until this override is reset — say it here rather than let the
          user discover it by dragging a dead control. */}
      {token === "--cc-accent" && overridden && (
        <div style={{ marginTop: 10 }}>
          <Callout token={DIRTY} testId="accent-supersedes-picker">
            While <code>--cc-accent</code> is overridden here, it supersedes the accent
            picker in the rail&rsquo;s theme popover — that picker will have no visible
            effect until you Reset this token.
          </Callout>
        </div>
      )}
    </div>
  );
}

// ── right rail ────────────────────────────────────────────

function PreviewPane({ glowStrength }) {
  return (
    <div style={{ ...CARD, padding: 0, overflow: "hidden" }} data-testid="preview-pane">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: 28,
          padding: "0 9px",
          background: "var(--cc-surface)",
          borderBottom: "1px solid var(--cc-line)",
        }}
      >
        <span
          className="cc-chip"
          data-state="working"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            height: 16,
            padding: "0 6px",
            borderRadius: 999,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--cc-working)",
            background: tint("var(--cc-working)", 10),
            border: `1px solid ${tint("var(--cc-working)", 35)}`,
          }}
        >
          working
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--cc-fg)" }}>worker-3</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: "var(--cc-dim)", fontFamily: MONO_STACK }}>42 tok/s</span>
      </div>
      <div
        style={{
          padding: 10,
          background: "var(--cc-term)",
          fontFamily: MONO_STACK,
          fontSize: 11,
          lineHeight: 1.7,
          // The real glow treatment, so --cc-glow-size is visibly doing something.
          boxShadow: `inset 0 0 var(--cc-glow-size) ${tint("var(--cc-working)", 30)}`,
        }}
      >
        <div>
          <span style={{ color: "var(--cc-macro)" }}>async def</span>{" "}
          <span style={{ color: "var(--cc-fn)" }}>relay</span>
          <span style={{ color: "var(--cc-dim)" }}>(</span>
          <span style={{ color: "var(--cc-type)" }}>Session</span>
          <span style={{ color: "var(--cc-dim)" }}>, n=</span>
          <span style={{ color: "var(--cc-num)" }}>2048</span>
          <span style={{ color: "var(--cc-dim)" }}>)</span>
        </div>
        <div>
          <span style={{ color: "var(--cc-macro)" }}>@bridge</span>{" "}
          <span style={{ color: "var(--cc-ok)" }}>ok</span>{" "}
          <span style={{ color: "var(--cc-muted)" }}># injected to peer</span>
        </div>
        <div style={{ color: "var(--cc-fg)" }}>
          glow size <span style={{ color: "var(--cc-accent)" }}>{glowStrength}px</span>
        </div>
      </div>
    </div>
  );
}

function StateChips() {
  return (
    <div style={CARD} data-testid="state-chips">
      <div style={{ ...LABEL, marginBottom: 8 }}>Session state</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {STATE_CHIPS.map(({ id, label }) => (
          <span
            key={id}
            data-testid={`state-chip-${id}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              height: 20,
              padding: "0 8px",
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: ".06em",
              textTransform: "uppercase",
              color: `var(--cc-${id})`,
              background: tint(`var(--cc-${id})`, 8),
              border: `1px solid ${tint(`var(--cc-${id})`, 35)}`,
            }}
          >
            <span
              aria-hidden="true"
              style={{ width: 5, height: 5, borderRadius: 999, background: `var(--cc-${id})` }}
            />
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function WhereUsed({ token }) {
  const usage = token ? TOKEN_USAGE[token] : null;
  return (
    <div style={CARD} data-testid="where-used">
      <div style={{ ...LABEL, marginBottom: 8 }}>Where this token is used</div>
      {!token && (
        <div style={{ fontSize: 11, color: "var(--cc-muted)", lineHeight: 1.5 }}>
          Pick a token card to see which surfaces consume it.
        </div>
      )}
      {token && !usage && (
        <div style={{ fontSize: 11, color: "var(--cc-muted)", lineHeight: 1.5 }}>
          <code>{token}</code> is used broadly — Cockpit has no verified consumer list for it.
        </div>
      )}
      {token && usage && (
        <>
          <div style={{ fontSize: 11, color: "var(--cc-dim)", marginBottom: 8, lineHeight: 1.5 }}>
            {usage.files === null
              ? `${token} is used broadly — its consumers were not enumerated.`
              : `${token} appears in ${usage.files} component ${usage.files === 1 ? "module" : "modules"}, counted from this repo.`}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
            {usage.surfaces.map((s) => (
              <span
                key={s}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: "2px 7px",
                  borderRadius: 999,
                  color: "var(--cc-dim)",
                  background: "var(--cc-elev)",
                  border: "1px solid var(--cc-border)",
                }}
              >
                {s}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function TokensSettings({ get, setField, isDirty, deleteField }) {
  const {
    themeId,
    theme,
    themes,
    switchTheme,
    accent,
    setAccent,
    glowStrength,
    setGlowStrength,
    tokenOverrides,
    overrideCount,
    setTokenOverride,
    clearTokenOverride,
    resetTokenOverrides,
    userPalettes,
    savePalette,
    applyPalette,
    deletePalette,
  } = useTheme();

  // Memoised so the export payload is not rebuilt on every keystroke.
  const overrides = useMemo(() => tokenOverrides || {}, [tokenOverrides]);
  const palettes = userPalettes || {};
  const count = typeof overrideCount === "number" ? overrideCount : Object.keys(overrides).length;

  const [selected, setSelected] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [paletteName, setPaletteName] = useState("");
  const fileRef = useRef(null);

  const groupDirty = Boolean(isDirty?.(TOKENS_PATH));

  // ── the dual write ──────────────────────────────────────
  // ALWAYS the complete map: the backend replaces appearance.token_overrides
  // wholesale, so a narrow leaf would delete every untouched sibling.
  const commit = (name, value) => {
    setTokenOverride?.(name, value);
    setField(TOKENS_PATH, { ...overrides, [name]: value });
    if (name === "--cc-accent") {
      setAccent?.(value);
      setField(ACCENT_PATH, value);
    }
  };

  const clearOne = (name) => {
    clearTokenOverride?.(name);
    const next = { ...overrides };
    delete next[name]; // omitted, not nulled — the map IS the saved state
    setField(TOKENS_PATH, next);
    if (name === "--cc-accent") {
      setAccent?.(null);
      setField(ACCENT_PATH, null);
    }
  };

  const resetAll = () => {
    resetTokenOverrides?.();
    if (typeof deleteField === "function") deleteField(TOKENS_PATH);
    else setField(TOKENS_PATH, {});
    setAccent?.(null);
    setField(ACCENT_PATH, null);
    setSelected(null);
    setNotice("All token overrides cleared. Save changes to make it stick.");
  };

  const applyOverrideMap = (map, base) => {
    if (base && base !== themeId) switchTheme?.(base);
    // Replace, do not merge: an imported document describes a complete theme.
    Object.keys(overrides).forEach((k) => {
      if (!(k in map)) clearTokenOverride?.(k);
    });
    Object.entries(map).forEach(([k, v]) => setTokenOverride?.(k, v));
    setField(TOKENS_PATH, { ...map });
  };

  // ── export / import ─────────────────────────────────────
  const exportJson = useMemo(
    () => JSON.stringify({ base: themeId, overrides }, null, 2),
    [themeId, overrides]
  );

  const handleExport = () => {
    setImportError(null);
    try {
      const blob = new Blob([exportJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cockpit-theme-${themeId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`Exported ${Object.keys(overrides).length} override(s) as cockpit-theme-${themeId}.json`);
    } catch (err) {
      setImportError(`Could not create the download: ${err.message}`);
    }
  };

  const handleImportApply = (text) => {
    const result = parseImportedTheme(text);
    if (!result.ok) {
      setImportError(result.error);
      setNotice(null);
      return;
    }
    applyOverrideMap(result.overrides, result.base);
    setImportError(null);
    setImportText("");
    setImportOpen(false);
    setNotice(
      `Imported ${Object.keys(result.overrides).length} override(s). Save changes to keep them.`
    );
  };

  const handleFile = async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      setImportText(text);
      handleImportApply(text);
    } catch (err) {
      setImportError(`Could not read that file: ${err.message}`);
    }
  };

  // ── palettes ────────────────────────────────────────────
  const handleSavePalette = () => {
    const name = paletteName.trim();
    if (!name) {
      setImportError("Give the palette a name first.");
      return;
    }
    savePalette?.(name);
    setField(PALETTES_PATH, {
      ...palettes,
      [name]: { base: themeId, overrides: { ...overrides } },
    });
    setPaletteName("");
    setImportError(null);
    setNotice(`Saved palette “${name}”. Save changes to persist it.`);
  };

  const handleDeletePalette = (name) => {
    deletePalette?.(name);
    const next = { ...palettes };
    delete next[name];
    setField(PALETTES_PATH, next);
    setNotice(`Deleted palette “${name}”.`);
  };

  const handleGlow = (value) => {
    const n = Number(value);
    setGlowStrength?.(n);
    setField(GLOW_SIZE_PATH, n);
  };

  const glowValue = typeof glowStrength === "number" && !Number.isNaN(glowStrength)
    ? glowStrength
    : Number(get(GLOW_SIZE_PATH, 30)) || 30;

  const selectedValue = selected ? effectiveValue(selected, overrides, theme, accent) : null;

  return (
    <div style={{ display: "flex", minWidth: 0, alignItems: "flex-start" }}>
      {/* ── content column ──────────────────────────── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
        {/* header actions (the breadcrumb belongs to the shell) */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <PillButton
            testId="import-theme"
            label="Import a theme JSON document"
            icon={Upload}
            onClick={() => {
              setImportOpen((v) => !v);
              setImportError(null);
            }}
            active={importOpen}
          >
            Import theme…
          </PillButton>
          <PillButton
            testId="export-theme"
            label="Export the current base palette and overrides as JSON"
            icon={Download}
            onClick={handleExport}
          >
            Export as JSON
          </PillButton>
          <span style={{ flex: 1 }} />
          <input
            type="text"
            value={paletteName}
            onChange={(e) => setPaletteName(e.target.value)}
            placeholder="palette name"
            aria-label="New palette name"
            data-testid="palette-name"
            style={{
              width: 140,
              height: 24,
              padding: "0 8px",
              fontSize: 11,
              fontFamily: "inherit",
              borderRadius: 7,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
              outline: "none",
            }}
          />
          <PillButton
            testId="save-palette"
            label="Save the current base palette plus overrides as a named palette"
            onClick={handleSavePalette}
            accent
          >
            Save palette
          </PillButton>
        </div>

        {importOpen && (
          <div style={CARD} data-testid="import-panel">
            <div style={{ ...LABEL, marginBottom: 8 }}>Import theme</div>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder={'{\n  "base": "va-night",\n  "overrides": { "--cc-accent": "#4ea1e8" }\n}'}
              aria-label="Theme JSON to import"
              data-testid="import-text"
              style={{
                width: "100%",
                padding: 8,
                fontSize: 11,
                fontFamily: MONO_STACK,
                borderRadius: 7,
                background: "var(--cc-elev)",
                border: `1px solid ${importError ? "var(--cc-error)" : "var(--cc-border)"}`,
                color: "var(--cc-fg)",
                outline: "none",
                resize: "vertical",
              }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
              <PillButton
                testId="import-apply"
                label="Validate and apply the pasted theme"
                onClick={() => handleImportApply(importText)}
                accent
              >
                Apply import
              </PillButton>
              <PillButton
                testId="import-file"
                label="Load a theme JSON file"
                onClick={() => fileRef.current?.click()}
              >
                Load file…
              </PillButton>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                onChange={handleFile}
                aria-label="Theme JSON file"
                data-testid="import-file-input"
                style={{ display: "none" }}
              />
              <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>
                Unknown token names are rejected, not skipped.
              </span>
            </div>
          </div>
        )}

        {importError && (
          <Callout token="var(--cc-error)" testId="tokens-error" role="alert">
            {importError}
          </Callout>
        )}
        {notice && !importError && (
          <Callout token="var(--cc-accent)" testId="tokens-notice">
            {notice}
          </Callout>
        )}

        {/* palette row */}
        <div style={CARD} data-testid="palette-row">
          <div style={{ ...LABEL, marginBottom: 8 }}>Base palette</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {(themes || []).map((t) => (
              <PillButton
                key={t.id}
                testId={`palette-${t.id}`}
                label={`Use the ${t.label} palette`}
                active={t.id === themeId}
                onClick={() => switchTheme?.(t.id)}
              >
                {t.label}
              </PillButton>
            ))}
            {Object.keys(palettes).map((name) => (
              <span
                key={name}
                data-testid={`user-palette-${name}`}
                style={{ display: "inline-flex", alignItems: "center", gap: 2 }}
              >
                <PillButton
                  testId={`apply-palette-${name}`}
                  label={`Apply your saved palette ${name}`}
                  onClick={() => applyPalette?.(name)}
                >
                  {name}
                </PillButton>
                <button
                  type="button"
                  data-testid={`delete-palette-${name}`}
                  onClick={() => handleDeletePalette(name)}
                  aria-label={`Delete saved palette ${name}`}
                  className="rounded transition-colors hover-bg-elevated"
                  style={{
                    width: 22,
                    height: 22,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 7,
                    background: "none",
                    border: "1px solid var(--cc-border)",
                    color: "var(--cc-muted)",
                    cursor: "pointer",
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
            <span style={{ flex: 1 }} />
            {count > 0 && (
              <span
                data-testid="override-count"
                style={{ fontSize: 11, fontWeight: 700, color: DIRTY }}
              >
                {count} override{count === 1 ? "" : "s"}
                {groupDirty ? " · unsaved" : ""}
              </span>
            )}
            <PillButton
              testId="reset-overrides"
              label="Reset every token override back to the base palette"
              icon={RotateCcw}
              onClick={resetAll}
            >
              Reset overrides
            </PillButton>
          </div>
        </div>

        {selected && (
          <TokenEditor
            token={selected}
            value={selectedValue}
            overridden={Boolean(overrides[selected])}
            onCommit={commit}
            onClear={clearOne}
            onClose={() => setSelected(null)}
          />
        )}

        {/* token groups */}
        {TOKEN_GROUPS.map((group) => (
          <div key={group.id} data-testid={`token-group-${group.id}`}>
            <GroupHeader label={group.label} note={group.note} dirty={groupDirty} />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gap: 8,
              }}
            >
              {group.tokens.map((token) => (
                <TokenCard
                  key={token}
                  token={token}
                  value={effectiveValue(token, overrides, theme, accent)}
                  overridden={Boolean(overrides[token])}
                  selected={selected === token}
                  onSelect={(t) => setSelected((prev) => (prev === t ? null : t))}
                />
              ))}
            </div>
          </div>
        ))}

        {/* non-colour tokens */}
        <div data-testid="token-group-scales">
          <GroupHeader
            label="Scale & type"
            note="Glow size is a live token. The radius scale and mono stack are reference — they are not per-token overridable today."
          />
          <div style={CARD}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ ...LABEL, width: 120, flexShrink: 0 }}>--cc-glow-size</span>
              <input
                type="range"
                min={0}
                max={48}
                step={2}
                value={glowValue}
                onChange={(e) => handleGlow(e.target.value)}
                aria-label="Glow size in pixels"
                data-testid={`field-${GLOW_SIZE_PATH}`}
                data-dirty={isDirty?.(GLOW_SIZE_PATH) ? "true" : "false"}
                style={{
                  flex: 1,
                  minWidth: 0,
                  accentColor: isDirty?.(GLOW_SIZE_PATH) ? DIRTY : "var(--cc-accent)",
                }}
              />
              <span
                data-testid="glow-value"
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  minWidth: 44,
                  textAlign: "right",
                  color: isDirty?.(GLOW_SIZE_PATH) ? DIRTY : "var(--cc-fg)",
                }}
              >
                {glowValue}px
              </span>
            </div>

            <div style={{ height: 1, background: "var(--cc-line)", margin: "12px 0" }} aria-hidden="true" />

            <div style={{ ...LABEL, marginBottom: 6 }}>Radius scale · reference</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {RADIUS_SCALE.map((r) => (
                <span
                  key={r.value}
                  data-testid={`radius-${r.value}`}
                  title={r.use}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "3px 8px",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--cc-dim)",
                    background: "var(--cc-elev)",
                    border: "1px solid var(--cc-border)",
                    borderRadius: r.value,
                  }}
                >
                  {r.value}
                  <span style={{ fontWeight: 400, color: "var(--cc-muted)" }}>{r.use}</span>
                </span>
              ))}
            </div>

            <div style={{ ...LABEL, margin: "12px 0 6px" }}>Mono stack · reference</div>
            <div
              data-testid="mono-stack"
              style={{ fontSize: 11, fontFamily: MONO_STACK, color: "var(--cc-dim)", lineHeight: 1.5 }}
            >
              ui-monospace · JetBrains Mono · Cascadia Code · Consolas · monospace
            </div>
            <div style={{ fontSize: 11, color: "var(--cc-muted)", marginTop: 8, lineHeight: 1.5 }}>
              Radii and the font stack are read-only here by design: they are not in
              OVERRIDABLE_TOKENS, so there is nowhere to save an edit. Showing them as
              documentation is honest; showing them as inputs would not be.
            </div>
          </div>
        </div>
      </div>

      {/* ── right rail ──────────────────────────────── */}
      <div
        data-testid="tokens-rail"
        style={{
          width: 392,
          flexShrink: 0,
          alignSelf: "stretch",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          padding: 16,
          background: "var(--cc-bg2)",
          borderLeft: "1px solid var(--cc-border)",
        }}
      >
        <div style={LABEL}>Live preview</div>
        <PreviewPane glowStrength={glowValue} />
        <StateChips />
        <WhereUsed token={selected} />
        <Callout testId="legacy-alias-note">
          Legacy aliases resolve automatically. <code>--accent</code>,{" "}
          <code>--text-primary</code>, <code>--border-color</code> and friends are declared
          in index.css as <code>var(--cc-*)</code>, so anything still using an old name
          picks your override up with no extra work.
        </Callout>
        <Callout testId="ansi-note">
          The terminal&rsquo;s ANSI palette is built in TerminalPane from the base palette
          OBJECT — not from these CSS variables — so a token override does not repaint
          xterm colors until the terminal is re-themed. Syntax tokens are what the ANSI
          slots are modelled on; wiring the override map through to xterm is still open.
        </Callout>
      </div>
    </div>
  );
}
