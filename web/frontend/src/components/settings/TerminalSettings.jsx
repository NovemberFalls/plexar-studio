/* eslint-disable react-refresh/only-export-components -- DEFAULT_MONO_STACK /
   FONT_PRESETS / CURSOR_STYLES / the scrollback bounds are exported so the tests
   assert against the page's real values rather than a duplicated fixture (a
   fixture would pass while the page drifted). Same accommodation TopBar.jsx
   makes for its MODELS re-export. */
/**
 * TerminalSettings — the Settings ▸ Terminal page.
 *
 * ANSWERS THE OWNER'S QUESTION ON SCREEN ("Does Claude Code permit us to change
 * this?"): yes, entirely. Font, size, scrollback, cursor and the copy/paste key
 * handling are **xterm.js** options owned by TerminalPane.jsx. They are a
 * property of the emulator Cockpit draws in the browser, not of the `claude`
 * CLI — Claude Code neither knows nor controls them, and there is no permission
 * to ask. The card copy says so.
 *
 * INTENT, NOT A DASHBOARD. Every value is written through
 * `setField(dottedPath, value)`; nothing lives in local component state or
 * localStorage, and the page renders no save button. The ONE exception is the
 * per-field "invalid text you are currently typing" buffer in NumberField, which
 * is not a value — a rejected number is never written anywhere (see its header).
 *
 * Paths written: terminal.font_family · terminal.font_size · terminal.scrollback
 * · terminal.cursor_style · terminal.cursor_blink.
 *
 * Read-only by necessity, not by choice: the Ctrl+C / paste section. Those
 * behaviours live in TerminalPane's `attachCustomKeyEventHandler` and its
 * capture-phase `paste` listener as hard-coded logic. There is no setting they
 * read, so a switch here would be a switch that changes nothing. The current
 * behaviour is described instead.
 *
 * HONESTY, twice over:
 *   - `not-read-terminal`: TerminalPane hard-codes fontSize (from the live zoom
 *     stepper), fontFamily, scrollback: 10000, cursorStyle: "bar" and
 *     cursorBlink: true at construction. It does not read settings.json, so a
 *     saved value here changes nothing yet.
 *   - `terminal-section-new`: settings_store.DEFAULT_SETTINGS has no `terminal`
 *     section today, and PUT /api/settings rejects an unknown top-level section
 *     outright ("unknown settings section 'terminal'"), all-or-nothing. Until
 *     that section is added server-side, saving this page fails with that
 *     message. Saying so beats letting the user discover it as a mystery 400.
 *
 * Props (pinned by the Settings shell):
 *   get(dottedPath, fallback) → current DRAFT value
 *   setField(dottedPath, value) → record an unsaved edit
 *   isDirty(dottedPath) → bool; true fields highlight in --cc-waiting
 */

import { useState } from "react";
import { Clipboard, Info, Terminal, TriangleAlert, Type } from "lucide-react";
// The live zoom stepper's bounds. Imported rather than retyped so the font-size
// field cannot disagree with the Ctrl+/Ctrl- control about what is a legal size.
import { DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM } from "../../utils/terminalFit";

// ── tokens / shared style fragments (mirrors ProvidersSettings) ────────────
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const DIRTY = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

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

const FIELD_GRID = {
  display: "grid",
  gridTemplateColumns: "200px 1fr 108px",
  gap: 8,
  alignItems: "center",
  padding: "6px 0",
};

/** The stack index.css and TerminalPane actually use, verbatim. */
export const DEFAULT_MONO_STACK =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace";

/** Presets offered by the font dropdown. "custom" hands over to the text field. */
export const FONT_PRESETS = [
  { value: DEFAULT_MONO_STACK, label: "Cockpit default (JetBrains Mono → Fira Code → …)" },
  { value: "'Cascadia Code', 'Consolas', monospace", label: "Cascadia Code" },
  { value: "'Consolas', monospace", label: "Consolas" },
  { value: "'Fira Code', monospace", label: "Fira Code" },
  { value: "'JetBrains Mono', monospace", label: "JetBrains Mono" },
  { value: "'SF Mono', 'Menlo', monospace", label: "SF Mono / Menlo" },
  { value: "monospace", label: "System monospace" },
];

export const CURSOR_STYLES = [
  { value: "bar", label: "Bar (Cockpit default)" },
  { value: "block", label: "Block" },
  { value: "underline", label: "Underline" },
];

/**
 * Scrollback bounds. The ceiling is deliberate: xterm holds every retained line
 * in memory per terminal, so the cost is multiplied by however many panes are
 * open (up to 8 by default). 200k lines × 8 panes is not a setting, it is an
 * out-of-memory tab.
 */
export const SCROLLBACK_MIN = 100;
export const SCROLLBACK_MAX = 100000;
export const SCROLLBACK_DEFAULT = 10000;

// ── primitives ────────────────────────────────────────────

function SectionTitle({ children, note }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
      <span style={{ ...LABEL, fontSize: 10, color: "var(--cc-fg)" }}>{children}</span>
      {note && <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>{note}</span>}
    </div>
  );
}

function CardHeader({ icon: Icon, token, name, children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        paddingBottom: 10,
        marginBottom: 4,
        borderBottom: "1px solid var(--cc-line)",
      }}
    >
      {Icon && (
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: token,
            background: tint(token, 8),
            border: `1px solid ${tint(token, 30)}`,
            flexShrink: 0,
          }}
        >
          <Icon size={12} />
        </span>
      )}
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>{name}</span>
      {children}
    </div>
  );
}

function Badge({ children, token = "var(--cc-dim)", testId }) {
  return (
    <span
      data-testid={testId}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 18,
        padding: "0 7px",
        borderRadius: 7,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 30)}`,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

function FieldRow({ label, hint, action, children }) {
  return (
    <div style={FIELD_GRID}>
      <div style={{ minWidth: 0 }}>
        <div style={LABEL}>{label}</div>
        {hint && <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 2 }}>{hint}</div>}
      </div>
      <div style={{ minWidth: 0 }}>{children}</div>
      <div>{action ?? null}</div>
    </div>
  );
}

function Callout({ token = DIRTY, icon: Icon = TriangleAlert, children, testId }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      <Icon size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

function SettingSelect({ label, path, get, setField, isDirty, options, fallback = "", hint, action }) {
  const dirty = Boolean(isDirty?.(path));
  const raw = get(path, fallback);
  const value = raw === null || raw === undefined ? fallback : raw;
  return (
    <FieldRow label={label} hint={hint} action={action}>
      <select
        value={value}
        onChange={(e) => setField(path, e.target.value)}
        aria-label={label}
        data-testid={`field-${path}`}
        data-dirty={dirty ? "true" : "false"}
        className="w-full rounded"
        style={{
          width: "100%",
          height: 26,
          padding: "0 6px",
          fontSize: 11,
          borderRadius: 7,
          background: "var(--cc-elev)",
          border: `1px solid ${dirty ? DIRTY : "var(--cc-border)"}`,
          color: dirty ? DIRTY : "var(--cc-fg)",
          outline: "none",
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

/** `testId` is explicit here because two controls write the same path (the font
 *  dropdown and this free-text override), and two identical test ids would make
 *  either one unaddressable. */
function SettingText({ label, path, get, setField, isDirty, placeholder, hint, mono, testId }) {
  const dirty = Boolean(isDirty?.(path));
  return (
    <FieldRow label={label} hint={hint}>
      <input
        type="text"
        value={get(path, "") ?? ""}
        onChange={(e) => setField(path, e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={label}
        data-testid={testId || `field-${path}`}
        data-dirty={dirty ? "true" : "false"}
        className="w-full rounded"
        style={{
          width: "100%",
          height: 26,
          padding: "0 8px",
          fontSize: 11,
          fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
          borderRadius: 7,
          background: "var(--cc-elev)",
          border: `1px solid ${dirty ? DIRTY : "var(--cc-border)"}`,
          color: dirty ? DIRTY : "var(--cc-fg)",
          outline: "none",
        }}
      />
    </FieldRow>
  );
}

function SettingToggle({ label, path, get, setField, isDirty, hint, title, onLabel = "On", offLabel = "Off" }) {
  const dirty = Boolean(isDirty?.(path));
  const on = Boolean(get(path, false));
  const segment = (active, text, next) => (
    <button
      key={text}
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={`${label}: ${text}`}
      onClick={() => setField(path, next)}
      className="transition-colors hover-bg-surface"
      style={{
        height: 22,
        padding: "0 10px",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        border: "none",
        background: active ? "var(--cc-accent)" : "transparent",
        color: active ? ACCENT_FG : "var(--cc-dim)",
        cursor: "pointer",
      }}
    >
      {text}
    </button>
  );
  return (
    <FieldRow label={label} hint={hint}>
      <div
        role="radiogroup"
        aria-label={label}
        title={title}
        data-testid={`field-${path}`}
        data-dirty={dirty ? "true" : "false"}
        style={{
          display: "inline-flex",
          overflow: "hidden",
          borderRadius: 8,
          background: "var(--cc-elev)",
          border: `1px solid ${dirty ? DIRTY : "var(--cc-border)"}`,
        }}
      >
        {segment(!on, offLabel, false)}
        {segment(on, onLabel, true)}
      </div>
    </FieldRow>
  );
}

/**
 * Bounded integer field that REFUSES out-of-range input instead of storing it.
 *
 * The only local state is `typed` — the raw string while it is not a legal value.
 * It is a validation buffer, not a value: `setField` is called only for an
 * in-range integer, so an out-of-range or non-numeric entry is never written to
 * the draft and can never reach settings.json. Blur discards the buffer and the
 * field snaps back to the stored value, so the page cannot be left displaying a
 * number it did not save.
 */
function NumberField({ label, path, get, setField, isDirty, min, max, fallback, unit, hint }) {
  const dirty = Boolean(isDirty?.(path));
  const stored = get(path, null);
  const storedValue = typeof stored === "number" && Number.isFinite(stored) ? stored : fallback;
  const [typed, setTyped] = useState(null); // null = show the stored value

  const problem = (() => {
    if (typed === null) return null;
    if (typed.trim() === "") return "Enter a number.";
    if (!/^-?\d+$/.test(typed.trim())) return "Whole numbers only.";
    const n = Number(typed);
    if (n < min || n > max) return `Must be between ${min} and ${max}.`;
    return null;
  })();

  const onChange = (e) => {
    const next = e.target.value;
    const n = Number(next);
    if (/^\d+$/.test(next.trim()) && Number.isInteger(n) && n >= min && n <= max) {
      setTyped(null);
      setField(path, n);
      return;
    }
    setTyped(next); // held for display + the inline alert; NOT written anywhere
  };

  return (
    <>
      <FieldRow label={label} hint={hint}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            step={1}
            value={typed === null ? storedValue : typed}
            onChange={onChange}
            onBlur={() => setTyped(null)}
            aria-label={label}
            aria-invalid={problem ? "true" : "false"}
            data-testid={`field-${path}`}
            data-dirty={dirty ? "true" : "false"}
            className="rounded"
            style={{
              width: 110,
              height: 26,
              padding: "0 8px",
              fontSize: 11,
              borderRadius: 7,
              background: "var(--cc-elev)",
              border: `1px solid ${problem ? "var(--cc-error)" : dirty ? DIRTY : "var(--cc-border)"}`,
              color: problem ? "var(--cc-error)" : dirty ? DIRTY : "var(--cc-fg)",
              outline: "none",
            }}
          />
          <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
            {unit} · {min}–{max}
          </span>
        </div>
      </FieldRow>
      {problem && (
        <div
          role="alert"
          data-testid={`invalid-${path}`}
          style={{
            display: "flex",
            gap: 6,
            alignItems: "flex-start",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--cc-error)",
            paddingBottom: 4,
          }}
        >
          <TriangleAlert size={12} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{problem} Not saved — the stored value is unchanged.</span>
        </div>
      )}
    </>
  );
}

/** One line of read-only behaviour description. */
function BehaviourRow({ keys, children, testId }) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "grid",
        gridTemplateColumns: "200px 1fr",
        gap: 8,
        alignItems: "baseline",
        padding: "5px 0",
      }}
    >
      <code
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--cc-accent)",
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        {keys}
      </code>
      <span style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)" }}>{children}</span>
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function TerminalSettings({ get, setField, isDirty }) {
  const family = get("terminal.font_family", "") || "";
  // The dropdown shows "Custom…" whenever the stored stack is not one of ours,
  // so a hand-typed stack is never silently misrepresented as a preset.
  const isPreset = FONT_PRESETS.some((p) => p.value === family);
  const scrollback = get("terminal.scrollback", SCROLLBACK_DEFAULT);
  const scrollbackValue =
    typeof scrollback === "number" && Number.isFinite(scrollback) ? scrollback : SCROLLBACK_DEFAULT;
  // 8 panes is the default MAX_SESSIONS. ~1KB/line is a rough but honest order of
  // magnitude for xterm's retained-line cost with styling.
  const estMb = Math.round((scrollbackValue * 8) / 1024);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}>
      <SectionTitle note="xterm.js options, owned by Cockpit">Terminal</SectionTitle>

      {/* Answers "does Claude Code permit this?" before any control. */}
      <Callout token="var(--cc-accent)" icon={Info} testId="who-owns-this">
        Everything on this page belongs to <strong>Cockpit&apos;s terminal emulator</strong>{" "}
        (xterm.js), not to Claude Code. Font, size, scrollback, cursor and the copy/paste key
        handling are options Cockpit passes when it builds each pane. The <code>claude</code> CLI
        never sees them and cannot restrict them — there is no permission to ask for.
      </Callout>

      {/* ── Font ──────────────────────────────────────── */}
      <div style={CARD} data-testid="card-terminal-font">
        <CardHeader icon={Type} token="var(--cc-type)" name="Font">
          <Badge testId="font-source">{isPreset || !family ? "preset" : "custom stack"}</Badge>
        </CardHeader>

        <SettingSelect
          label="Font stack"
          path="terminal.font_family"
          get={get}
          setField={setField}
          isDirty={isDirty}
          fallback=""
          hint="Falls back left to right"
          options={[
            { value: "", label: "Not set — use Cockpit's built-in stack" },
            ...FONT_PRESETS,
            ...(isPreset || !family ? [] : [{ value: family, label: `Custom… (${family})` }]),
          ]}
        />
        <SettingText
          label="Custom stack"
          path="terminal.font_family"
          get={get}
          setField={setField}
          isDirty={isDirty}
          placeholder={DEFAULT_MONO_STACK}
          hint="Overrides the dropdown — same setting"
          testId="field-terminal.font_family-custom"
          mono
        />
        <div
          role="note"
          data-testid="font-stack-note"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 2 }}
        >
          The dropdown and the text field are the <strong>same value</strong> — the field is there
          so you can type a stack Cockpit does not list. A font the machine does not have installed
          is skipped, and the next one in the list is used; end with <code>monospace</code> so
          there is always something left. Cockpit&apos;s built-in stack is{" "}
          <code>{DEFAULT_MONO_STACK}</code>.
        </div>

        <NumberField
          label="Font size"
          path="terminal.font_size"
          get={get}
          setField={setField}
          isDirty={isDirty}
          min={MIN_ZOOM}
          max={MAX_ZOOM}
          fallback={DEFAULT_ZOOM}
          unit="px"
          hint="Starting size for a pane"
        />
        <div
          role="note"
          data-testid="zoom-relation"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 2 }}
        >
          Cockpit also has a live zoom stepper (Ctrl + / Ctrl −) that changes the font size of the
          panes on screen straight away and remembers it for this workspace. The two are the same
          number with different lifetimes: the stepper is the size you are looking at now, this
          field is the size a pane should <em>start</em> at. They share the same
          {" "}{MIN_ZOOM}–{MAX_ZOOM}px range, and zooming will keep winning for the current
          workspace.
        </div>
      </div>

      {/* ── Scrollback + cursor ───────────────────────── */}
      <div style={CARD} data-testid="card-terminal-buffer">
        <CardHeader icon={Terminal} token="var(--cc-accent)" name="Scrollback &amp; cursor">
          <Badge testId="scrollback-estimate">{`~${estMb} MB across 8 panes`}</Badge>
        </CardHeader>

        <NumberField
          label="Scrollback"
          path="terminal.scrollback"
          get={get}
          setField={setField}
          isDirty={isDirty}
          min={SCROLLBACK_MIN}
          max={SCROLLBACK_MAX}
          fallback={SCROLLBACK_DEFAULT}
          unit="lines"
          hint="History kept per pane"
        />
        <div
          role="note"
          data-testid="scrollback-cost"
          style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", paddingTop: 2 }}
        >
          Every retained line is held <strong>in memory, per pane</strong>. Cockpit runs up to 8
          sessions at once, so this number is paid eight times over: {scrollbackValue.toLocaleString()}{" "}
          lines works out around <strong>{estMb} MB</strong> of terminal history with all 8 panes
          full — roughly, at about a kilobyte per styled line. Cockpit&apos;s built-in value is{" "}
          {SCROLLBACK_DEFAULT.toLocaleString()} lines. Pushing it toward{" "}
          {SCROLLBACK_MAX.toLocaleString()} is a real memory decision, not a free one.
        </div>

        <SettingSelect
          label="Cursor style"
          path="terminal.cursor_style"
          get={get}
          setField={setField}
          isDirty={isDirty}
          fallback=""
          hint="Shape of the caret"
          options={[
            { value: "", label: "Not set — use Cockpit's default (bar)" },
            ...CURSOR_STYLES,
          ]}
        />
        <SettingToggle
          label="Cursor blink"
          path="terminal.cursor_blink"
          get={get}
          setField={setField}
          isDirty={isDirty}
          hint="Cockpit's default is on"
        />
      </div>

      {/* ── Copy / paste: described, not configurable ── */}
      <div style={CARD} data-testid="card-terminal-clipboard">
        <CardHeader icon={Clipboard} token="var(--cc-macro)" name="Copy &amp; paste">
          <Badge testId="clipboard-readonly">read-only</Badge>
        </CardHeader>

        <div
          role="note"
          data-testid="clipboard-readonly-note"
          style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", padding: "6px 0 4px" }}
        >
          These are <strong>not settings</strong> — there is no switch behind them. Cockpit
          hard-codes this key handling in the terminal pane, so the honest thing to show is what it
          actually does today rather than a toggle that would change nothing:
        </div>

        <BehaviourRow keys="Ctrl+C" testId="behaviour-ctrl-c">
          <strong>Copies when text is selected.</strong> With a selection, Ctrl+C copies it to the
          clipboard and the interrupt is <em>not</em> sent. With no selection, Ctrl+C sends the
          interrupt (<code>\x03</code>) to the running command, exactly as a terminal should. This
          is why Ctrl+C sometimes does not stop Claude: clear the selection first.
        </BehaviourRow>
        <BehaviourRow keys="Ctrl+Shift+C" testId="behaviour-ctrl-shift-c">
          Always copies the selection and never sends an interrupt — the unambiguous copy, by
          terminal convention.
        </BehaviourRow>
        <BehaviourRow keys="Ctrl+V" testId="behaviour-ctrl-v">
          Cockpit handles the paste itself, before xterm sees it, so text arrives once rather than
          twice and is not auto-submitted. Pasted text is wrapped as a bracketed paste, which is
          what stops a multi-line paste from being read as a series of Enter presses.
        </BehaviourRow>
        <BehaviourRow keys="Paste an image" testId="behaviour-paste-image">
          An image on the clipboard is uploaded to Cockpit (<code>/api/upload</code>) and the saved
          file&apos;s path is pasted into the prompt for you, so Claude can read it.
        </BehaviourRow>
        <BehaviourRow keys="Drop a file" testId="behaviour-drop-file">
          Dropping files on a pane uploads them the same way and pastes their paths.
        </BehaviourRow>

        <Callout token="var(--cc-muted)" icon={Info} testId="clipboard-no-toggle">
          If you want any of this to be configurable, that is a change to the terminal pane&apos;s
          key handling, not a value to store here. Nothing on this card is saved, so nothing on it
          can be out of date.
        </Callout>
      </div>

      {/* ── The two honesty notes ─────────────────────── */}
      <Callout token={DIRTY} icon={Info} testId="not-read-terminal">
        Saved, but <strong>not in force yet</strong>. Each pane is still built with Cockpit&apos;s
        built-in values — the font stack above, {SCROLLBACK_DEFAULT.toLocaleString()} lines of
        scrollback, a blinking bar cursor, and a font size that comes from the live zoom stepper.
        The terminal does not read these stored values yet, so changing them here does not change
        how a pane looks. This note disappears once the terminal reads them.
      </Callout>

      <Callout token={DIRTY} icon={TriangleAlert} testId="terminal-section-new">
        Cockpit&apos;s settings file does not have a <code>terminal</code> section yet, and the
        server rejects a whole save if it contains a section it does not recognise. Until that
        section is added, pressing <em>Save changes</em> with edits on this page will fail with
        &ldquo;unknown settings section&rdquo; and <strong>nothing at all is written</strong> —
        including your edits on other pages. Your other settings are not damaged; the save simply
        does not happen.
      </Callout>
    </div>
  );
}
