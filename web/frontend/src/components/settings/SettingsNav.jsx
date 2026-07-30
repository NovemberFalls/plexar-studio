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
      { id: "general", label: "General & startup" },
      { id: "providers", label: "Providers & Endpoints" },
      { id: "claude-cli", label: "Claude CLI" },
      { id: "keys", label: "Keys & secrets" },
    ],
  },
  {
    label: "Sessions",
    items: [
      { id: "session-defaults", label: "Defaults & models" },
      { id: "permissions", label: "Permissions & safety" },
      { id: "layout", label: "Layout & panes" },
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

export const DEFAULT_SETTINGS_SECTION = "general";

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
