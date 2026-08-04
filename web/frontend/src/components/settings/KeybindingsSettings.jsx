/**
 * KeybindingsSettings — the Settings ▸ Keybindings page.
 *
 * THE PROBLEM THIS SOLVES IS DISCOVERABILITY, NOT REMAPPING. Plexar Studio already
 * ships 20+ shortcuts and not one of them appeared anywhere in the UI, which is
 * why the owner had to ask whether we have keybindings at all. So this page is
 * the reference card first: the real chords, grouped, with the honest caveats
 * (Ctrl+K does not open a palette yet; Escape closes dialogs and does NOT
 * interrupt a session; Ctrl+Shift+<digit> is matched as the shifted punctuation).
 *
 * READ-ONLY, ON PURPOSE. There is no consumer of `system.keybindings` anywhere:
 * App.jsx's handler compares against literal strings. Rendering rebind inputs
 * would let the user "change" a shortcut and then watch the old one keep firing,
 * which is a worse experience than a plain list. So the list is a list, and a
 * note says so.
 *
 * THIS PAGE WRITES NOTHING — `setField` is never called, deliberately.
 * `system.keybindings` is a REPLACE-not-merge leaf AND its keys contain dots
 * ("pane.focus.1"), so useSettings' dotted-leaf addressing is ambiguous with a
 * nested object and degrades to a no-op. Whoever wires remapping must write the
 * WHOLE dict in a single call:
 *
 *   setField("system.keybindings", { ...get("system.keybindings", {}), [id]: chord })
 *
 * A narrow write such as `setField("system.keybindings.pane.focus.1", chord)` is
 * either dropped or destroys every sibling binding. Until a real consumer exists,
 * writing nothing is the only correct behaviour.
 *
 * Props (pinned by the Settings shell, same semantics as its siblings). `get`,
 * `setField` and `isDirty` are accepted for shell symmetry and intentionally
 * unused — see above.
 */

import { Keyboard } from "lucide-react";
import { KEYBINDINGS, groupedKeybindings, splitChord } from "../../utils/keybindings.js";

// ── shared style fragments ────────────────────────────────
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

const MONO_STACK =
  'var(--font-mono, ui-monospace, "JetBrains Mono", "Cascadia Code", Consolas, monospace)';

/** Where a chord is listened for. Shown so "why did nothing happen" is answerable. */
const SCOPE_TOKEN = {
  Global: "var(--cc-accent)",
  Terminal: "var(--cc-ok)",
  Dialog: "var(--cc-thinking)",
};

// ── primitives (module scope, per the project convention) ──

/** A single key cap. Semantic <kbd>, not a styled span. */
function KeyCap({ children }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: 18,
        height: 20,
        padding: "0 6px",
        borderRadius: 5,
        fontSize: 10,
        fontWeight: 700,
        fontFamily: MONO_STACK,
        color: "var(--cc-fg)",
        background: "var(--cc-elev)",
        border: "1px solid var(--cc-border)",
        borderBottomWidth: 2,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </kbd>
  );
}

/** A whole chord: caps joined by thin separators. */
function Chord({ chord, testId }) {
  const parts = splitChord(chord);
  return (
    <span
      data-testid={testId}
      aria-label={chord}
      style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}
    >
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
          {i > 0 && (
            <span aria-hidden="true" style={{ fontSize: 9, color: "var(--cc-muted)" }}>
              +
            </span>
          )}
          <KeyCap>{part}</KeyCap>
        </span>
      ))}
    </span>
  );
}

function ScopeBadge({ scope }) {
  const token = SCOPE_TOKEN[scope] || "var(--cc-muted)";
  return (
    <span
      data-testid={`scope-${scope}`}
      style={{
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        padding: "1px 6px",
        borderRadius: 999,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
        flexShrink: 0,
      }}
    >
      {scope}
    </span>
  );
}

function BindingRow({ binding }) {
  const { id, keys, alsoKeys, label, scope, note } = binding;
  return (
    <div
      data-testid={`binding-${id}`}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        padding: "8px 0",
        borderTop: "1px solid var(--cc-line)",
        minWidth: 0,
      }}
    >
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--cc-fg)" }}>{label}</span>
          <ScopeBadge scope={scope} />
        </span>
        {note && (
          <span
            data-testid={`binding-note-${id}`}
            style={{
              display: "block",
              fontSize: 11,
              color: "var(--cc-muted)",
              marginTop: 3,
              lineHeight: 1.5,
            }}
          >
            {note}
          </span>
        )}
      </span>
      <span
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
          justifyContent: "flex-end",
          paddingTop: 1,
        }}
      >
        <Chord chord={keys} testId={`chord-${id}`} />
        {(alsoKeys || []).map((alt) => (
          <span key={alt} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>or</span>
            <Chord chord={alt} testId={`chord-${id}-alt-${alt}`} />
          </span>
        ))}
      </span>
    </div>
  );
}

function BindingGroup({ group }) {
  return (
    <div style={CARD} data-testid={`keybinding-group-${group.id}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>{group.label}</span>
        <span style={{ ...LABEL, fontSize: 9 }}>
          {group.bindings.length} shortcut{group.bindings.length === 1 ? "" : "s"}
        </span>
      </div>
      {group.bindings.map((b) => (
        <BindingRow key={b.id} binding={b} />
      ))}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function KeybindingsSettings() {
  const groups = groupedKeybindings();

  return (
    <div
      data-testid="keybindings-settings"
      style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Keyboard size={13} color="var(--cc-accent)" aria-hidden="true" />
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>
          {KEYBINDINGS.length} shortcuts
        </span>
        <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>
          transcribed from the handlers that actually run them
        </span>
      </div>

      <div
        role="note"
        data-testid="readonly-note"
        style={{
          padding: "8px 10px",
          borderRadius: 9,
          fontSize: 11,
          lineHeight: 1.5,
          color: "var(--cc-waiting)",
          background: tint("var(--cc-waiting)", 8),
          border: `1px solid ${tint("var(--cc-waiting)", 35)}`,
        }}
      >
        These shortcuts are fixed in this build and remapping is not available yet —
        nothing in Plexar Studio reads a custom binding, so an editor here would let you
        change a chord and then watch the old one keep firing. This page is a
        reference card until remapping is wired.
      </div>

      {groups.map((group) => (
        <BindingGroup key={group.id} group={group} />
      ))}

      <div
        role="note"
        data-testid="scope-note"
        style={{
          padding: "8px 10px",
          borderRadius: 9,
          fontSize: 11,
          lineHeight: 1.5,
          color: "var(--cc-muted)",
          background: tint("var(--cc-muted)", 8),
          border: `1px solid ${tint("var(--cc-muted)", 35)}`,
        }}
      >
        <strong>Global</strong> chords work anywhere in the window.{" "}
        <strong>Terminal</strong> chords are handled by the focused terminal, so they
        need a pane focused first. <strong>Dialog</strong> chords only apply while a
        dialog or menu is open. Holding Ctrl and scrolling the mouse wheel zooms the
        terminals as well — it is a gesture rather than a chord, so it is not listed
        above.
      </div>
    </div>
  );
}
