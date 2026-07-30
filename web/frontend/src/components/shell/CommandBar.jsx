import { Search, ChevronDown } from "lucide-react";

// Presentational-only command bar for the Workspace shell. All click handlers
// (palette open, defaults popover open) are owned by the caller (App.jsx);
// this component just renders the 44px bar per the redesign handoff.

function PaletteTrigger({ onOpenPalette }) {
  return (
    <button
      type="button"
      className="hover-bg-elevated"
      onClick={onOpenPalette}
      title="Search sessions, run a command… (Ctrl K)"
      aria-label="Open command palette"
      aria-keyshortcuts="Control+K"
      style={{
        width: 320,
        height: 28,
        borderRadius: 8,
        background: "var(--cc-surface)",
        border: "1px solid var(--cc-border)",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 8px",
        cursor: "pointer",
        color: "var(--cc-dim)",
        fontFamily: "inherit",
      }}
    >
      <Search size={12} style={{ flexShrink: 0 }} />
      <span
        style={{
          flex: 1,
          textAlign: "left",
          fontSize: 11,
          color: "var(--cc-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        Search sessions, run a command…
      </span>
      <span
        style={{
          flexShrink: 0,
          fontSize: 9,
          borderRadius: 4,
          background: "var(--cc-elev)",
          color: "var(--cc-muted)",
          padding: "2px 5px",
          fontWeight: 700,
        }}
      >
        Ctrl K
      </span>
    </button>
  );
}

function DefaultsPill({ model, permissionMode, effort, onOpenDefaults }) {
  return (
    <button
      type="button"
      className="hover-bg-elevated"
      onClick={onOpenDefaults}
      title={`Session defaults — ${model} · ${permissionMode} · ${effort}`}
      aria-label="Open session defaults"
      style={{
        height: 26,
        borderRadius: 8,
        background: "var(--cc-surface)",
        border: "1px solid var(--cc-border)",
        display: "flex",
        alignItems: "center",
        cursor: "pointer",
        color: "var(--cc-fg)",
        fontFamily: "inherit",
        padding: 0,
        overflow: "hidden",
      }}
    >
      <span
        style={{
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: ".06em",
          color: "var(--cc-muted)",
          padding: "0 8px",
        }}
      >
        DEFAULTS
      </span>
      <span style={{ width: 1, alignSelf: "stretch", background: "var(--cc-line)" }} />
      <span style={{ fontSize: 11, color: "var(--cc-fg)", padding: "0 8px", whiteSpace: "nowrap" }}>
        {model}
      </span>
      <span style={{ width: 1, alignSelf: "stretch", background: "var(--cc-line)" }} />
      <span style={{ fontSize: 11, color: "var(--cc-accent)", padding: "0 8px", whiteSpace: "nowrap" }}>
        {permissionMode}
      </span>
      <span style={{ width: 1, alignSelf: "stretch", background: "var(--cc-line)" }} />
      <span style={{ fontSize: 11, color: "var(--cc-fg)", padding: "0 8px", whiteSpace: "nowrap" }}>
        {effort}
      </span>
      <span style={{ width: 1, alignSelf: "stretch", background: "var(--cc-line)" }} />
      <span style={{ padding: "0 7px", display: "flex", alignItems: "center", color: "var(--cc-muted)" }}>
        <ChevronDown size={12} />
      </span>
    </button>
  );
}

export default function CommandBar({
  title,
  workspaceName,
  onOpenPalette,
  model,
  permissionMode,
  effort,
  onOpenDefaults,
}) {
  return (
    <div
      style={{
        height: 44,
        flexShrink: 0,
        padding: "0 12px 0 14px",
        display: "flex",
        alignItems: "center",
        background: "var(--cc-bg)",
        borderBottom: "1px solid var(--cc-border)",
      }}
    >
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: 800,
            color: "var(--cc-fg)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        {workspaceName && (
          <span
            style={{
              fontSize: 11,
              color: "var(--cc-muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {workspaceName}
          </span>
        )}
      </div>

      <PaletteTrigger onOpenPalette={onOpenPalette} />

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
        <DefaultsPill
          model={model}
          permissionMode={permissionMode}
          effort={effort}
          onOpenDefaults={onOpenDefaults}
        />
      </div>
    </div>
  );
}
