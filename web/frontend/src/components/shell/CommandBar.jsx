import { useState } from "react";
import { Search } from "lucide-react";
import UsageLimitsPill from "../UsageLimitsPill";

// Presentational-only command bar for the Workspace shell. All click handlers
// (palette open, defaults popover open) are owned by the caller (App.jsx);
// this component just renders the 44px bar per the redesign handoff.
//
// Exception: the usage pill's popover open/closed is local view state, not app
// state — nothing outside this bar reacts to it, so threading it through
// App.jsx would be ceremony. The pill belongs HERE rather than in TopBar
// because TopBar only renders inside the DEFAULTS dropdown; anything placed
// there is invisible until the user opens that popover, which defeats the
// point of an at-a-glance quota readout.

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

export default function CommandBar({
  title,
  workspaceName,
  onOpenPalette,
  // The session controls (model, permission mode, effort, fast, engine, key,
  // avatar, panel toggles) rendered inline. Previously these lived in a TopBar
  // that only appeared as a DROP-DOWN under a "DEFAULTS" pill -- so the bar
  // showed `claude-opus-5[1m] bypassPermissions low` as dead text while the
  // controls that set them were hidden one click away. One bar, one copy of
  // each control.
  controls,
}) {
  const [limitsOpen, setLimitsOpen] = useState(false);

  return (
    <div
      style={{
        height: 46,
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

      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
        {/* Real 5-hour / weekly subscription utilization — the same figures the
            CLI shows under /status ▸ Usage. */}
        <UsageLimitsPill
          open={limitsOpen}
          onToggle={() => setLimitsOpen((v) => !v)}
          onClose={() => setLimitsOpen(false)}
        />
        {controls}
      </div>
    </div>
  );
}
