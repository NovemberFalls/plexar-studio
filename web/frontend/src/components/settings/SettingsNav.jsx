/* eslint-disable react-refresh/only-export-components -- SETTINGS_GROUPS is the
   single source of truth for the section ids AND their labels; the breadcrumb
   map and the label filter are derived from it. Keeping them beside the nav that
   renders them is the whole point (mirrors TopBar.jsx's MODEL_GROUPS). */
/**
 * SettingsNav — the 214px left nav of the Settings section.
 *
 * The item ids ARE the deep-link values (`settingsSection`) — do not rename
 * them. Purely presentational: selection state and the import/export action
 * are owned by the caller.
 */

/** Groups and items exactly as specified by the redesign handoff (section 6). */
export const SETTINGS_GROUPS = [
  {
    label: "Machine",
    items: [
      /* "General & startup" REMOVED 2026-08-04, owner ruling: *"General &
         Startup Remove it."* It was genuine empty scaffolding -- `PAGES.general`
         was `null`, so the pane only ever rendered NotBuiltPanel -- and every
         value it advertised (COCKPIT_MANAGED_BROKER, COCKPIT_MANAGED_VLLM,
         MAX_SESSIONS) is server-side environment, not a settings key, so the
         page could not have been built as drawn without changing what the
         server reads.
         ⚠ IT WAS ALSO `DEFAULT_SETTINGS_SECTION`. See the constant below. */
      { id: "providers", label: "Providers & Endpoints" },
      { id: "claude-cli", label: "Claude CLI" },
      { id: "keys", label: "Keys & secrets" },
    ],
  },
  {
    label: "Sessions",
    items: [
      { id: "session-defaults", label: "Defaults & models" },
      /* "Permissions & safety" REMOVED 2026-08-04, owner ruling: *"Permissions
         & Safety remove it."* Same category as General: `PAGES.permissions` was
         `null` and the pane rendered NotBuiltPanel only. The stronger reason is
         the one the pane's own copy conceded -- permission mode is ALREADY
         owned by three shipped surfaces (the DEFAULTS pill in the command bar,
         the per-session Inspector, and Defaults & models). A fourth page would
         have been a second source of truth for a value you set in three places
         already, which is the same argument that retired "Layout & panes". */
      /* "Layout & panes" REMOVED, owner-confirmed. Pane count, sidebar width and
         which panels are open are all set by direct manipulation in the shell and
         already persist. A settings page for them would be a second source of
         truth for values you set by dragging -- it could only ever disagree with
         what is on screen. The two bits that genuinely belong to startup (default
         pane count, inspector-open-on-launch) go to General & startup instead. */
      { id: "terminal", label: "Terminal" },
    ],
  },
  {
    label: "Appearance",
    items: [
      { id: "theme", label: "Theme & glow" },
      { id: "tokens", label: "Design tokens" },
    ],
  },
  {
    label: "Data",
    items: [
      { id: "reporting", label: "Reporting & retention" },
      { id: "pricing", label: "Pricing table" },
    ],
  },
  {
    label: "System",
    items: [
      { id: "keybindings", label: "Keybindings" },
      { id: "updates", label: "Updates" },
      { id: "diagnostics", label: "Diagnostics & logs" },
    ],
  },
];

/** Flat id -> label map so the header breadcrumb and content pages agree. */
export const SETTINGS_SECTION_LABELS = SETTINGS_GROUPS.reduce((acc, group) => {
  for (const item of group.items) acc[item.id] = item.label;
  return acc;
}, {});

/**
 * The section Settings opens on, and the fallback for an unknown one.
 *
 * ⚠ THIS WAS `"general"`, AND `general` WAS DELETED ABOVE. Re-pointed in the
 * SAME commit, because the failure mode is silent rather than loud:
 * `SettingsView` resolves an unknown section BY FALLING BACK TO THIS CONSTANT,
 * so a default naming a deleted section makes the fallback point at nothing
 * too. Settings would open on an untitled, unlisted, un-highlighted frame every
 * single launch and never throw.
 *
 * `providers` is the replacement because it is the first Machine item, it is a
 * real built page, and it is the page the owner actually opens.
 *
 * PINNED BY `SettingsNav.defaultSection.test.jsx`, which was WATCHED TO FAIL
 * 4/5 against this constant still reading `"general"`. It asserts the default
 * resolves, NOT that it equals `providers` -- re-point it at any other deleted
 * id and that file goes red again.
 */
export const DEFAULT_SETTINGS_SECTION = "providers";

/** Case-insensitive label filter; groups with no surviving item are dropped. */
export function filterSettingsGroups(query) {
  const q = (query || "").trim().toLowerCase();
  if (!q) return SETTINGS_GROUPS;
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) => item.label.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)
    ),
  })).filter((group) => group.items.length > 0);
}

function NavItem({ item, active, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect?.(item.id)}
      aria-current={active ? "page" : undefined}
      className={active ? "" : "hover-bg-surface"}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 10px",
        borderRadius: 7,
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: active ? 700 : 400,
        color: active ? "var(--cc-fg)" : "var(--cc-muted)",
        background: active
          ? "color-mix(in srgb, var(--cc-accent) 12%, transparent)"
          : "transparent",
        border: "none",
        borderLeft: active ? "2px solid var(--cc-accent)" : "2px solid transparent",
        cursor: "pointer",
      }}
    >
      {item.label}
    </button>
  );
}

export default function SettingsNav({ section, onSelectSection, query, onImportExport }) {
  const groups = filterSettingsGroups(query);

  return (
    <nav
      aria-label="Settings sections"
      style={{
        width: 214,
        flexShrink: 0,
        background: "var(--cc-bg2)",
        borderRight: "1px solid var(--cc-border)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      <div style={{ flex: 1, padding: "12px 10px" }}>
        {groups.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--cc-muted)", padding: "4px 2px" }}>
            No settings match that search.
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label} style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                  color: "var(--cc-muted)",
                  padding: "0 8px",
                  marginBottom: 5,
                }}
              >
                {group.label}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {group.items.map((item) => (
                  <NavItem
                    key={item.id}
                    item={item}
                    active={item.id === section}
                    onSelect={onSelectSection}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      <div style={{ padding: 10, borderTop: "1px solid var(--cc-line)", flexShrink: 0 }}>
        <button
          type="button"
          onClick={onImportExport}
          disabled={!onImportExport}
          title="Import / export settings…"
          className="hover-bg-elevated"
          style={{
            width: "100%",
            height: 26,
            borderRadius: 8,
            background: "var(--cc-surface)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-dim)",
            fontFamily: "inherit",
            fontSize: 10,
            fontWeight: 600,
            cursor: onImportExport ? "pointer" : "not-allowed",
            opacity: onImportExport ? 1 : 0.5,
          }}
        >
          Import / export settings…
        </button>
      </div>
    </nav>
  );
}
