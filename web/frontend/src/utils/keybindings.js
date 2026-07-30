/**
 * keybindings.js — the single source of truth for Cockpit's keyboard shortcuts.
 *
 * WHY THIS FILE EXISTS: Cockpit has had these shortcuts since the facelift and
 * NONE of them were discoverable anywhere in the UI. The owner asked "do we have
 * key bindings???" — which is the whole problem in one question. This module is
 * the answer, and Settings ▸ Keybindings renders it.
 *
 * TRANSCRIPTION RULE — every entry below was read out of the source that
 * actually handles the key, not out of a spec or a summary:
 *   - global bindings: the `keydown` handler in App.jsx (the `useEffect` around
 *     lines 1445-1518 on branch feature/local-model-picker)
 *   - terminal-scoped bindings: `term.attachCustomKeyEventHandler` in
 *     TerminalPane.jsx (~line 413) and its twin in PopoutTerminal.jsx
 *   - dialog Escape: the per-dialog handlers in NewSessionDialog, BridgeModal,
 *     OpenRouterModal, OnboardingModal and PaneActionsMenu
 *
 * A shortcut list that lies is worse than no list: the user presses the key,
 * nothing happens, and they conclude the app is broken. So anything that could
 * not be confirmed in the source is ABSENT rather than guessed. Notably there is
 * NO global Escape-to-interrupt binding — Escape only closes dialogs — and the
 * Ctrl+K "command palette" today focuses the Projects filter rather than opening
 * a palette, which is what its `note` says.
 *
 * SHAPE
 *   id       stable identifier, `group.action` (also the future settings key)
 *   keys     the canonical chord, "+"-separated for chip rendering
 *   alsoKeys additional chords the SAME handler answers (not aliases we wish for)
 *   label    plain-English description of the effect
 *   group    one of KEYBINDING_GROUPS' ids
 *   scope    "Global" | "Terminal" | "Dialog" — where the key is listened for
 *   note     an honest caveat when the binding is conditional or partial
 *
 * REMAPPING IS NOT WIRED. Do not add a writer for `system.keybindings` without
 * reading the trap first: keybinding ids contain dots, so useSettings' dotted
 * leaf addressing is ambiguous with a nested object and degrades to a no-op.
 * `system.keybindings` is a REPLACE-not-merge leaf, so a remapping UI must write
 * the WHOLE dict in one call:
 *   setField("system.keybindings", { ...get("system.keybindings", {}), [id]: chord })
 * A narrow write like `system.keybindings.pane.next` silently destroys every
 * sibling binding, or is dropped entirely. Until that is built, the Keybindings
 * page writes NOTHING.
 */

export const KEYBINDING_GROUPS = [
  { id: "sessions", label: "Sessions" },
  { id: "navigation", label: "Navigation" },
  { id: "layout", label: "Layout" },
  { id: "focus", label: "Pane focus" },
  { id: "zoom", label: "Terminal zoom" },
  { id: "terminal", label: "Terminal" },
  { id: "dialogs", label: "Dialogs" },
];

/**
 * Ctrl+Shift+<digit> arrives as a SHIFTED PUNCTUATION `event.key`, never as the
 * digit — App.jsx matches "!" for layout 1, "@" for 2, and so on. The chord is
 * still shown to the user as Ctrl+Shift+1, because that is the key they press.
 */
const SHIFTED_DIGITS = ["!", "@", "#", "$", "%", "^", "&", "*"];

const LAYOUT_BINDINGS = SHIFTED_DIGITS.map((punct, i) => ({
  id: `layout.${i + 1}`,
  keys: `Ctrl+Shift+${i + 1}`,
  label: `Show ${i + 1} pane${i === 0 ? "" : "s"}`,
  group: "layout",
  scope: "Global",
  note: `Matched as Ctrl+Shift+${punct} — the shifted digit is what the browser reports.`,
}));

const FOCUS_BINDINGS = Array.from({ length: 8 }, (_, i) => ({
  id: `pane.focus.${i + 1}`,
  keys: `Ctrl+${i + 1}`,
  label: `Focus pane ${i + 1}`,
  group: "focus",
  scope: "Global",
  note: `Only fires when the current layout has a pane ${i + 1} and a session is in it.`,
}));

export const KEYBINDINGS = [
  {
    id: "session.new",
    keys: "Ctrl+Shift+N",
    label: "New session",
    group: "sessions",
    scope: "Global",
  },
  {
    id: "projects.toggle",
    keys: "Ctrl+Shift+E",
    alsoKeys: ["Ctrl+Shift+B"],
    label: "Toggle the Projects drawer",
    group: "navigation",
    scope: "Global",
    note: "Ctrl+Shift+B is the legacy chord and still works — it was kept rather than breaking muscle memory.",
  },
  {
    id: "palette.open",
    keys: "Ctrl+K",
    label: "Open the command palette",
    group: "navigation",
    scope: "Global",
    note: "The palette itself is not built yet: today this opens the Projects drawer and focuses its filter box.",
  },
  ...LAYOUT_BINDINGS,
  ...FOCUS_BINDINGS,
  {
    id: "zoom.in",
    keys: "Ctrl+=",
    alsoKeys: ["Ctrl++"],
    label: "Increase terminal font size",
    group: "zoom",
    scope: "Global",
    note: "Ctrl and the mouse wheel does the same thing.",
  },
  {
    id: "zoom.out",
    keys: "Ctrl+-",
    label: "Decrease terminal font size",
    group: "zoom",
    scope: "Global",
    note: "Ctrl and the mouse wheel does the same thing.",
  },
  {
    id: "zoom.reset",
    keys: "Ctrl+0",
    label: "Reset terminal font size",
    group: "zoom",
    scope: "Global",
  },
  {
    id: "terminal.search",
    keys: "Ctrl+Shift+F",
    label: "Toggle search in the focused terminal",
    group: "terminal",
    scope: "Terminal",
  },
  {
    id: "terminal.copyOrInterrupt",
    keys: "Ctrl+C",
    label: "Copy the selection, or interrupt when nothing is selected",
    group: "terminal",
    scope: "Terminal",
    note: "With text selected this copies and sends nothing; with no selection it sends the interrupt to Claude.",
  },
  {
    id: "terminal.copy",
    keys: "Ctrl+Shift+C",
    label: "Copy the selection, never interrupt",
    group: "terminal",
    scope: "Terminal",
  },
  {
    id: "terminal.paste",
    keys: "Ctrl+V",
    alsoKeys: ["Ctrl+Shift+V"],
    label: "Paste text, or upload a clipboard image and paste its path",
    group: "terminal",
    scope: "Terminal",
  },
  {
    id: "terminal.pasteImage",
    keys: "Alt+V",
    label: "Upload a clipboard image and paste its path",
    group: "terminal",
    scope: "Terminal",
    note: "Claude Code's own image-paste chord. Cockpit intercepts it because the terminal process cannot reach the system clipboard.",
  },
  {
    id: "dialog.close",
    keys: "Esc",
    label: "Close the open dialog, menu or inline rename",
    group: "dialogs",
    scope: "Dialog",
    note: "Escape is handled per dialog. There is no global Escape binding, so it does NOT interrupt a running session.",
  },
];

/** KEYBINDINGS bucketed into KEYBINDING_GROUPS order; empty groups dropped. */
export function groupedKeybindings(bindings = KEYBINDINGS) {
  return KEYBINDING_GROUPS.map((group) => ({
    ...group,
    bindings: bindings.filter((b) => b.group === group.id),
  })).filter((g) => g.bindings.length > 0);
}

/** "Ctrl+Shift+N" → ["Ctrl", "Shift", "N"]. "Ctrl++" keeps its trailing "+". */
export function splitChord(chord) {
  if (typeof chord !== "string" || chord.length === 0) return [];
  const parts = [];
  let buf = "";
  for (const ch of chord) {
    if (ch === "+" && buf.length > 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0) parts.push(buf);
  else parts.push("+"); // chord ended on the separator, e.g. "Ctrl++"
  return parts;
}
