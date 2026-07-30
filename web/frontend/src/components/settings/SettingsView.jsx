/* eslint-disable react-refresh/only-export-components -- middleEllipsize is a
   pure string helper for this header's path label and is exported only so the
   test suite can pin its behaviour; splitting it into its own module would
   scatter one 6-line function away from its single call site. */
/**
 * SettingsView — the Settings section frame (nav + page header + content pane).
 *
 * Fills the whole content area to the right of the Rail, exactly like FleetView
 * and LocalBrokerView do (`flex: 1`), so App.jsx renders it in place of the
 * Workspace panes + Inspector.
 *
 * Settings is INTENT: this frame owns the single useSettings() instance and
 * hands `get` / `setField` / `isDirty` down to whichever content page is
 * mounted. Four sections have real pages: `providers`, `tokens`, `reporting`
 * (spend guardrails) and `pricing` (read-only). Every other section renders an
 * honest "Not built yet" panel that names what will live there and where the
 * setting lives TODAY. Nothing here fakes a control.
 *
 * `pricing` takes no draft props on purpose — it owns no editable state, and
 * handing it `setField` would imply an editor that has no endpoint behind it.
 */
import { useState } from "react";
import { FolderOpen } from "lucide-react";
import useSettings from "../../hooks/useSettings.js";
import SettingsNav, {
  SETTINGS_SECTION_LABELS,
  DEFAULT_SETTINGS_SECTION,
} from "./SettingsNav.jsx";
import ProvidersSettings from "./ProvidersSettings.jsx";
import TokensSettings from "./TokensSettings.jsx";
import SpendGuardrails from "./SpendGuardrails.jsx";
import PricingSettings from "./PricingSettings.jsx";

/** Page title + one-line description per section id (11px description line). */
const PAGE_META = {
  general: {
    title: "General & startup",
    description: "Workspace root, what Cockpit does on launch, and machine-wide behaviour.",
  },
  providers: {
    title: "Providers & Endpoints",
    description: "Every model endpoint Cockpit can reach, its scope, and its health.",
  },
  "claude-cli": {
    title: "Claude CLI",
    description: "How Cockpit invokes the claude harness for every session it spawns.",
  },
  keys: {
    title: "Keys & secrets",
    description: "API keys and tokens. Values stay server-side; the browser only sees whether one is set.",
  },
  "session-defaults": {
    title: "Defaults & models",
    description: "The model, effort, and fast-mode a brand-new session starts with.",
  },
  permissions: {
    title: "Permissions & safety",
    description: "Default permission mode and the guardrails applied to new sessions.",
  },
  layout: {
    title: "Layout & panes",
    description: "Pane grid, sidebar width, and which shell panels open by default.",
  },
  terminal: {
    title: "Terminal",
    description: "Font, scrollback, renderer, and key handling inside each terminal pane.",
  },
  theme: {
    title: "Theme & glow",
    description: "Palette, dark/light variant, and the activity glow intensity.",
  },
  tokens: {
    title: "Design tokens",
    description: "The raw --cc-* values every surface in Cockpit is built from.",
  },
  reporting: {
    title: "Reporting & retention",
    description: "How long usage history is kept and what gets recorded.",
  },
  pricing: {
    title: "Pricing table",
    description: "Per-model input/output rates used to turn tokens into dollars.",
  },
  keybindings: {
    title: "Keybindings",
    description: "Shortcuts for the palette, pane focus, and session actions.",
  },
  updates: {
    title: "Updates",
    description: "Update channel and whether Cockpit checks GitHub Releases on launch.",
  },
  diagnostics: {
    title: "Diagnostics & logs",
    description: "Log level, log location, and the bundles you attach to a bug report.",
  },
};

/**
 * What each unbuilt page will hold, and where that setting lives TODAY.
 * `today: null` means it genuinely has no home yet — say so rather than invent one.
 */
const NOT_BUILT = {
  general: {
    will: "Default workspace folder, restore-sessions-on-launch, max concurrent sessions, and the managed-service toggles (lane broker, vLLM).",
    today: "environment variables on the server (COCKPIT_MANAGED_BROKER, COCKPIT_MANAGED_VLLM, MAX_SESSIONS).",
  },
  "claude-cli": {
    will: "Path to the claude executable, extra CLI flags, and the environment overrides applied to every spawned session.",
    today: "hard-coded in pty_manager.py — not user-configurable.",
  },
  keys: {
    will: "Set / clear the Anthropic and OpenRouter keys, with a set/not-set indicator only — key values are never sent to the browser.",
    today: "the OpenRouter key dialog in the top bar, plus the ANTHROPIC_API_KEY environment variable.",
  },
  "session-defaults": {
    will: "Default model, effort level, and fast mode for new sessions, per provider.",
    today: "the DEFAULTS pill in the command bar.",
  },
  permissions: {
    will: "Default permission mode for new sessions and which modes are allowed at all.",
    today: "the DEFAULTS pill in the command bar and the per-session Inspector.",
  },
  layout: {
    will: "Default pane count, lane strip visibility, inspector-open-by-default, and sidebar width.",
    today: "adjusted directly in the shell and remembered in browser storage.",
  },
  terminal: {
    will: "Font family and size, scrollback length, cursor style, and Ctrl+C / paste behaviour.",
    today: "hard-coded in TerminalPane.jsx.",
  },
  theme: {
    will: "Palette choice, dark/light variant, and glow size as a first-class setting.",
    today: "the palette popover in the rail.",
  },
  /* `tokens`, `reporting` and `pricing` are BUILT — their entries were removed
     rather than left here as unreachable copy. Note the old `pricing` entry
     promised "an editable per-model price table"; there is no price-editing
     endpoint, so the real page states plainly that it is read-only. */
  keybindings: {
    will: "A remappable list of every Cockpit shortcut with conflict detection.",
    today: null,
  },
  updates: {
    will: "Update channel, check-on-launch toggle, and a manual check with the current version.",
    today: "automatic on launch in the desktop app; there is no control.",
  },
  diagnostics: {
    will: "Log level, a reveal-logs action, and a diagnostics bundle for bug reports.",
    today: "log files under the Cockpit data directory.",
  },
};

/** Middle-ellipsize a long path so both the start and the filename stay legible. */
export function middleEllipsize(text, max = 46) {
  const s = typeof text === "string" ? text : "";
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function NotBuiltPanel({ sectionId }) {
  const meta = NOT_BUILT[sectionId];
  const label = SETTINGS_SECTION_LABELS[sectionId] || sectionId;
  return (
    <div
      className="cc-card"
      style={{
        borderRadius: 12,
        border: "1px dashed var(--cc-border)",
        background: "color-mix(in srgb, var(--cc-surface) 40%, transparent)",
        padding: 18,
        maxWidth: 620,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
        {label} is not built yet
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", margin: 0 }}>
        {meta?.will || "This page has not been designed yet."}
      </p>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: "8px 0 0" }}>
        {meta?.today
          ? `Today this lives in ${meta.today}`
          : "There is no existing place to change this yet."}
      </p>
    </div>
  );
}

/** Honest fallback for the one section whose page is mid-flight. */
function ProvidersUnavailablePanel() {
  return (
    <div
      className="cc-card"
      style={{
        borderRadius: 12,
        border: "1px dashed var(--cc-border)",
        background: "color-mix(in srgb, var(--cc-surface) 40%, transparent)",
        padding: 18,
        maxWidth: 620,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
        Providers page is not loaded
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: 0 }}>
        components/settings/ProvidersSettings.jsx is missing from this build. Endpoint
        configuration currently lives in the Engine view&rsquo;s connection card.
      </p>
    </div>
  );
}

export default function SettingsView({
  section,
  onSelectSection,
  onTestAll,
  onImportExport,
  // Test seam only — App.jsx never passes this; the real page binds statically above.
  providersPage: ProvidersPage = ProvidersSettings,
}) {
  const [query, setQuery] = useState("");
  const {
    path,
    loading,
    error,
    saving,
    dirty,
    isDirty,
    get,
    setField,
    deleteField,
    save,
    revert,
    reveal,
  } = useSettings();

  const current = PAGE_META[section] ? section : DEFAULT_SETTINGS_SECTION;
  const meta = PAGE_META[current];

  return (
    <div
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--cc-bg)",
        overflow: "hidden",
      }}
    >
      {/* ---- 44px header: breadcrumb · search · storage path · Reveal ---- */}
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 14px",
          borderBottom: "1px solid var(--cc-border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: "var(--cc-fg)" }}>Settings</span>
          <span style={{ fontSize: 13, color: "var(--cc-muted)" }}>/</span>
          <span
            style={{
              fontSize: 12,
              color: "var(--cc-dim)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {meta.title}
          </span>
        </div>

        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search settings…"
          aria-label="Search settings"
          style={{
            width: 200,
            height: 26,
            borderRadius: 8,
            padding: "0 8px",
            fontFamily: "inherit",
            fontSize: 11,
            background: "var(--cc-surface)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
          }}
        />

        <div style={{ flex: 1 }} />

        <span
          title={path || ""}
          style={{ fontSize: 10, color: "var(--cc-dim)", whiteSpace: "nowrap" }}
        >
          {loading ? "loading…" : middleEllipsize(path || "no settings file")}
        </span>
        <button
          type="button"
          onClick={() => reveal()}
          title="Reveal settings.json in your file manager"
          aria-label="Reveal settings file"
          className="hover-bg-elevated"
          style={{
            flexShrink: 0,
            height: 24,
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "0 9px",
            borderRadius: 8,
            background: "var(--cc-surface)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-dim)",
            fontFamily: "inherit",
            fontSize: 10,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <FolderOpen size={11} />
          Reveal
        </button>
      </div>

      {/* ---- body: nav | content ---- */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <SettingsNav
          section={current}
          onSelectSection={onSelectSection}
          query={query}
          onImportExport={onImportExport}
        />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            padding: "18px 22px",
            overflowY: "auto",
          }}
        >
          {/* page header */}
          <div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2
                  style={{
                    fontSize: 17,
                    fontWeight: 700,
                    color: "var(--cc-fg)",
                    margin: 0,
                  }}
                >
                  {meta.title}
                </h2>
                <p style={{ fontSize: 11, color: "var(--cc-muted)", margin: "4px 0 0", lineHeight: 1.5 }}>
                  {meta.description}
                </p>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                {onTestAll && (
                  <button
                    type="button"
                    onClick={onTestAll}
                    title="Test every configured endpoint"
                    className="hover-bg-elevated"
                    style={{
                      height: 26,
                      padding: "0 11px",
                      borderRadius: 8,
                      background: "var(--cc-surface)",
                      border: "1px solid var(--cc-border)",
                      color: "var(--cc-fg)",
                      fontFamily: "inherit",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    Test all
                  </button>
                )}
                {/* Escape hatch: dirtying fields across two sections and then
                    changing your mind otherwise has no exit but a reload.
                    Deliberately quiet so Save stays the primary action. */}
                {dirty && (
                  <button
                    type="button"
                    onClick={revert}
                    disabled={saving}
                    title="Discard all unsaved changes"
                    className="hover-bg-elevated"
                    style={{
                      height: 26,
                      padding: "0 11px",
                      borderRadius: 8,
                      background: "var(--cc-surface)",
                      border: "1px solid var(--cc-border)",
                      color: "var(--cc-dim)",
                      fontFamily: "inherit",
                      fontSize: 11,
                      fontWeight: 600,
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    Discard
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => save()}
                  disabled={!dirty || saving}
                  title={dirty ? "Save changed settings" : "No unsaved changes"}
                  style={{
                    height: 26,
                    padding: "0 12px",
                    borderRadius: 8,
                    background: dirty && !saving ? "var(--cc-accent)" : "var(--cc-surface)",
                    border: `1px solid ${dirty && !saving ? "var(--cc-accent)" : "var(--cc-border)"}`,
                    color: dirty && !saving ? "#0f1216" : "var(--cc-muted)",
                    fontFamily: "inherit",
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: dirty && !saving ? "pointer" : "not-allowed",
                    opacity: dirty ? 1 : 0.6,
                  }}
                >
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                style={{ fontSize: 11, color: "var(--cc-error)", marginTop: 8, lineHeight: 1.5 }}
              >
                {error}
              </div>
            )}
          </div>

          {/* page content */}
          {current === "providers" ? (
            ProvidersPage ? (
              <ProvidersPage get={get} setField={setField} isDirty={isDirty} />
            ) : (
              <ProvidersUnavailablePanel />
            )
          ) : current === "tokens" ? (
            <TokensSettings
              get={get}
              setField={setField}
              isDirty={isDirty}
              deleteField={deleteField}
            />
          ) : current === "pricing" ? (
            <PricingSettings />
          ) : current === "reporting" ? (
            <SpendGuardrails get={get} setField={setField} isDirty={isDirty} />
          ) : (
            <NotBuiltPanel sectionId={current} />
          )}
        </div>
      </div>
    </div>
  );
}
