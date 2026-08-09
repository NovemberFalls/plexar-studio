import { useState } from "react";
import { useTheme } from "../hooks/useTheme";

const ACCENT_PRESETS = ["#4ea1e8", "#5bbf9f", "#e0b060", "#c497d6"];

const NOTE_ID = "accent-override-note";

const NOTE_TOKEN = "var(--cc-waiting, #e0b060)";

/**
 * A plain-English callout plus the remedy for it. A warning with no way out is
 * only half a fix, so every note here carries at least one clear action.
 * Module scope per the project's sub-component convention.
 */
function OverrideNote({ id, testId, lines, actions, onClear, error }) {
  return (
    <div
      id={id}
      role="note"
      data-testid={testId}
      style={{
        marginBottom: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: NOTE_TOKEN,
        background: `color-mix(in srgb, ${NOTE_TOKEN} 8%, transparent)`,
        border: `1px solid color-mix(in srgb, ${NOTE_TOKEN} 35%, transparent)`,
      }}
    >
      {lines.filter(Boolean).map((line) => (
        <div key={line}>{line}</div>
      ))}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {actions.filter(Boolean).map((a) => (
          <button
            key={a.token}
            type="button"
            data-testid={`clear-override-${a.token}`}
            onClick={() => onClear(a.token)}
            aria-label={a.label}
            className="transition-colors hover-bg-elevated"
            style={{
              height: 22,
              padding: "0 9px",
              borderRadius: 999,
              fontSize: 10,
              fontWeight: 700,
              fontFamily: "inherit",
              color: NOTE_TOKEN,
              background: "transparent",
              border: `1px solid color-mix(in srgb, ${NOTE_TOKEN} 45%, transparent)`,
              cursor: "pointer",
            }}
          >
            {a.text}
          </button>
        ))}
      </div>
      {/* A failed PUT means the override is STILL on the server and will come
          back on restart. Reporting nothing here would recreate the very bug
          this note exists to fix, one layer down. */}
      {error && (
        <div
          role="alert"
          data-testid="clear-override-error"
          style={{
            marginTop: 8,
            paddingTop: 8,
            borderTop: "1px solid color-mix(in srgb, var(--cc-error, #e0698a) 35%, transparent)",
            color: "var(--cc-error, #e0698a)",
            fontSize: 10,
          }}
        >
          Could not clear the override on the server: {error} It is cleared in this
          window only and will reappear when Plexar Studio restarts.
        </div>
      )}
    </div>
  );
}

/**
 * Palette / accent / focus-glow settings popover. Consumes the extended
 * useTheme() API (palette via switchTheme, plus accent / glowEnabled /
 * glowStrength). All setters are optional-chained so the control still
 * renders if the theme foundation has not yet exposed a given lever.
 *
 * ACCENT SUPERSESSION — the reason this file knows about token overrides at
 * all: applyThemeToDOM resolves the accent as
 * `overrides["--cc-accent"] || accent || theme.accent`. That precedence is
 * correct, but it means a user who has set a `--cc-accent` override in
 * Settings ▸ Design tokens can drag the picker below forever with nothing
 * happening on screen. Silence is the bug. So when an override is winning we
 * SAY so and offer a one-click way out (clearTokenOverride) rather than
 * disabling the control with no explanation. The same applies to
 * `--cc-working`, which the accent retints — an override on it stops the pane
 * glow from following the accent.
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
    tokenOverrides,
    clearTokenOverride,
  } = t || {};

  const overrides = tokenOverrides || {};
  const accentOverride = typeof overrides["--cc-accent"] === "string" ? overrides["--cc-accent"] : null;
  const workingOverride = typeof overrides["--cc-working"] === "string" ? overrides["--cc-working"] : null;
  const superseded = Boolean(accentOverride);

  const [clearError, setClearError] = useState(null);

  // clearTokenOverride persists to settings.json and resolves {ok, error}. A
  // failure is SHOWN, never swallowed: the override survives on the server and
  // would silently return on the next launch.
  const handleClear = async (token) => {
    setClearError(null);
    const result = await clearTokenOverride?.(token);
    if (result && result.ok === false) {
      setClearError(result.error || "The change was not saved.");
    }
  };

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

        {superseded && (
          <OverrideNote
            id={NOTE_ID}
            testId="accent-override-note"
            lines={[
              `A design-token override for --cc-accent (${accentOverride}) is currently winning, so this picker has no effect on screen.`,
              workingOverride
                ? `--cc-working is overridden too (${workingOverride}), so the pane glow will not follow the accent either.`
                : null,
            ]}
            actions={[
              { token: "--cc-accent", label: "Clear token override for --cc-accent", text: "Clear token override" },
              workingOverride
                ? { token: "--cc-working", label: "Clear token override for --cc-working", text: "Clear --cc-working too" }
                : null,
            ]}
            onClear={handleClear}
            error={clearError}
          />
        )}

        <div
          data-testid="accent-picker"
          data-superseded={superseded ? "true" : "false"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 14,
            opacity: superseded ? 0.45 : 1,
          }}
        >
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setAccent?.(c)}
              aria-label={`Accent ${c}`}
              aria-disabled={superseded ? "true" : undefined}
              aria-describedby={superseded ? NOTE_ID : undefined}
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
              aria-label="Custom accent color"
              aria-disabled={superseded ? "true" : undefined}
              aria-describedby={superseded ? NOTE_ID : undefined}
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

/**
 * The Plexar mark — the REAL logo (`public/app-icon.png`, the same raster the
 * installer and the window title bar use), not a redrawn one.
 *
 * This was previously a hand-drawn SVG "P" so it could follow the theme accent.
 * The owner ruled that against: an approximation of the brand mark is worse than
 * either the mark itself or nothing at all, so the redrawn glyph is gone. The
 * raster carries its own dark rounded-square field, so callers render it BARE —
 * no gradient badge wrapper behind it, or the mark reads as double-framed.
 */
export function LogoMark({ size = 15 }) {
  return (
    <img
      src="/app-icon.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ display: "block", borderRadius: Math.round(size * 0.28) }}
    />
  );
}

