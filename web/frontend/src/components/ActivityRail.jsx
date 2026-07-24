import { useState } from "react";
import { Plus, List, LayoutGrid, Search, Settings, Cpu } from "lucide-react";
import { useTheme } from "../hooks/useTheme";

const ACCENT_PRESETS = ["#4ea1e8", "#5bbf9f", "#e0b060", "#c497d6"];

/**
 * Palette / accent / focus-glow settings popover. Consumes the extended
 * useTheme() API (palette via switchTheme, plus accent / glowEnabled /
 * glowStrength). All setters are optional-chained so the control still
 * renders if the theme foundation has not yet exposed a given lever.
 */
export function ThemePopover({ onClose, align = "right" }) {
  const t = useTheme();
  const {
    themeId,
    themes = [],
    switchTheme,
    accent,
    setAccent,
    glowEnabled = true,
    setGlowEnabled,
    glowStrength = 30,
    setGlowStrength,
  } = t || {};

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-label="Theme settings"
        className="absolute mt-1 z-50"
        style={{
          [align === "left" ? "left" : "right"]: 0,
          width: 240,
          backgroundColor: "var(--cc-elev, var(--bg-elevated))",
          border: "1px solid var(--cc-border, var(--border-color))",
          borderRadius: 12,
          padding: 14,
          boxShadow: "0 12px 32px rgba(0,0,0,0.4)",
        }}
      >
        {/* Palette */}
        <div className="cc-label" style={{ marginBottom: 8 }}>Palette</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 14 }}>
          {themes.map((th) => (
            <button
              key={th.id}
              onClick={() => switchTheme?.(th.id)}
              className="text-left"
              style={{
                fontSize: 12,
                fontWeight: th.id === themeId ? 700 : 500,
                color: th.id === themeId ? "var(--cc-accent, var(--accent))" : "var(--cc-dim, var(--text-secondary))",
                background: th.id === themeId ? "color-mix(in srgb, var(--cc-accent, #4ea1e8) 12%, transparent)" : "transparent",
                border: "1px solid var(--cc-border, var(--border-color))",
                borderRadius: 7,
                padding: "6px 10px",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {th.label}
            </button>
          ))}
        </div>

        {/* Accent */}
        <div className="cc-label" style={{ marginBottom: 8 }}>Accent</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              onClick={() => setAccent?.(c)}
              aria-label={`Accent ${c}`}
              style={{
                width: 22, height: 22, borderRadius: 999, background: c, cursor: "pointer",
                border: (accent || "").toLowerCase() === c.toLowerCase()
                  ? "2px solid var(--cc-fg, var(--text-primary))"
                  : "2px solid transparent",
              }}
            />
          ))}
          <label style={{ marginLeft: "auto", display: "flex", cursor: "pointer" }} title="Custom accent">
            <input
              type="color"
              value={accent || "#4ea1e8"}
              onChange={(e) => setAccent?.(e.target.value)}
              style={{ width: 24, height: 24, padding: 0, border: "none", background: "transparent", cursor: "pointer" }}
            />
          </label>
        </div>

        {/* Focus glow */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <span className="cc-label">Focus glow</span>
          <button
            onClick={() => setGlowEnabled?.(!glowEnabled)}
            aria-pressed={glowEnabled}
            style={{
              width: 34, height: 18, borderRadius: 999, position: "relative", cursor: "pointer",
              border: "1px solid var(--cc-border, var(--border-color))",
              background: glowEnabled ? "var(--cc-accent, var(--accent))" : "var(--cc-surface, var(--bg-surface))",
              transition: "background .15s",
            }}
          >
            <span
              style={{
                position: "absolute", top: 1, left: glowEnabled ? 17 : 1, width: 14, height: 14,
                borderRadius: 999, background: "#fff", transition: "left .15s",
              }}
            />
          </button>
        </div>

        {/* Glow strength */}
        <div style={{ opacity: glowEnabled ? 1 : 0.4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span className="cc-label">Glow strength</span>
            <span style={{ fontSize: 10, color: "var(--cc-dim, var(--text-secondary))" }}>{glowStrength}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={48}
            step={2}
            value={glowStrength}
            disabled={!glowEnabled}
            onChange={(e) => setGlowStrength?.(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--cc-accent, var(--accent))" }}
          />
        </div>
      </div>
    </>
  );
}

/** Aperture logo mark (blue ring + gold center dot). */
export function LogoMark({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="7" stroke="var(--cc-accent, var(--accent))" strokeWidth="2" />
      <circle cx="12" cy="12" r="2.4" fill="var(--cc-fn, #ffc66d)" />
    </svg>
  );
}

function RailButton({ icon: Icon, label, active, accentFill, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 32, height: 32, borderRadius: 8, cursor: "pointer",
        fontFamily: "inherit",
        color: accentFill
          ? "var(--cc-accent, var(--accent))"
          : active ? "var(--cc-fg, var(--text-primary))" : "var(--cc-muted, var(--text-muted))",
        background: accentFill
          ? "color-mix(in srgb, var(--cc-accent, #4ea1e8) 15%, transparent)"
          : active ? "rgba(255,255,255,.06)" : "transparent",
        border: accentFill
          ? "1px solid color-mix(in srgb, var(--cc-accent, #4ea1e8) 35%, transparent)"
          : "1px solid transparent",
      }}
    >
      <Icon size={16} strokeWidth={2} />
    </button>
  );
}

/**
 * 48px vertical activity rail. Buttons reuse existing App handlers:
 * new session, toggle sidebar, fleet, search (focus sidebar filter),
 * and a bottom settings/theme popover.
 */
export default function ActivityRail({
  onNew,
  sidebarOpen,
  onToggleSidebar,
  showFleetView,
  onToggleFleet,
  onSearch,
  showLocalBroker,
  onToggleLocalBroker,
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div
      style={{
        width: 48,
        flexShrink: 0,
        borderRight: "1px solid var(--cc-border, var(--border-color))",
        background: "color-mix(in srgb, var(--cc-bg2, var(--bg-surface)) 60%, transparent)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "10px 0",
        gap: 6,
      }}
    >
      <RailButton icon={Plus} label="New session (Ctrl+Shift+N)" accentFill onClick={onNew} />
      <RailButton icon={List} label="Toggle sidebar (Ctrl+Shift+B)" active={sidebarOpen} onClick={onToggleSidebar} />
      <RailButton icon={LayoutGrid} label="Fleet view" active={showFleetView} onClick={onToggleFleet} />
      <RailButton icon={Search} label="Search sessions" onClick={onSearch} />
      {onToggleLocalBroker && (
        <RailButton icon={Cpu} label="Local Broker — config & reporting" active={showLocalBroker} onClick={onToggleLocalBroker} />
      )}

      <div style={{ flex: 1 }} />

      <div style={{ position: "relative" }}>
        <RailButton icon={Settings} label="Theme settings" active={settingsOpen} onClick={() => setSettingsOpen((v) => !v)} />
        {settingsOpen && (
          <div style={{ position: "absolute", bottom: 0, left: 40 }}>
            <ThemePopover align="left" onClose={() => setSettingsOpen(false)} />
          </div>
        )}
      </div>
    </div>
  );
}
