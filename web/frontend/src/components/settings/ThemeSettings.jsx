/**
 * ThemeSettings — the Settings ▸ Theme & glow page.
 *
 * This page is the REAL HOME for what the activity rail's ThemePopover does
 * today (owner: "we should move this properly to here"). Everything the popover
 * offers is here: the base palette, the accent presets plus a custom color, the
 * focus-glow toggle and its size slider — and, importantly, the popover's
 * accent-supersession honesty, which is a landed behaviour and must not be lost
 * in the re-homing.
 *
 * TWO WRITES PER EDIT, same rule as TokensSettings:
 *   1. the useTheme() setter → paints the DOM NOW (and mirrors to localStorage),
 *      so the app recolors while the user drags.
 *   2. `setField("appearance.<key>", value)` → the Settings shell's
 *      `Save changes` persists it to settings.json. No appearance setting is
 *      allowed to live in localStorage alone.
 *
 * WHAT THIS PAGE DELIBERATELY DOES NOT RENDER — a dark/light variant control.
 * themeData.js ships exactly TWO palettes, `va-night` and `cockpit-blue`, and
 * BOTH are dark. There are no light variants and never have been. The design
 * handoff promising a variant toggle inherited a wrong theme count from CLAUDE.md;
 * a toggle with one reachable position is a lie about the product, so the page
 * says plainly that both palettes are dark instead.
 *
 * ACCENT SUPERSESSION (carried over verbatim in intent from ThemePopover):
 * applyThemeToDOM resolves the accent as
 * `overrides["--cc-accent"] || accent || theme.accent`. So a `--cc-accent`
 * override set in Settings ▸ Design tokens wins, and the accent control BELOW
 * becomes a control that does nothing on screen. Silence is the bug. When an
 * override is winning we name it, name its value, and offer the one-click way
 * out; `clearTokenOverride` also PUTs settings.json and resolves {ok, error},
 * and a failed PUT is SHOWN — the override still exists on the server and would
 * silently return on the next launch. The same applies to `--cc-working`, which
 * the accent retints: an override there stops the pane glow following the accent.
 *
 * Props (pinned by the Settings shell, same semantics as its siblings):
 *   get(dottedPath, fallback) → current DRAFT value
 *   setField(dottedPath, value) → record an unsaved edit
 *   isDirty(dottedPath) → bool (prefix-aware)
 */

import { useState } from "react";
import { Palette, Sparkles } from "lucide-react";
import { useTheme } from "../../hooks/useTheme.jsx";

// ── tokens / shared style fragments ───────────────────────
const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-button foreground
const DIRTY = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const THEME_PATH = "appearance.theme";
const ACCENT_PATH = "appearance.accent";
const GLOW_ENABLED_PATH = "appearance.glow_enabled";
const GLOW_SIZE_PATH = "appearance.glow_size";

/** Kept identical to ThemePopover's presets so the two surfaces agree. */
const ACCENT_PRESETS = ["#4ea1e8", "#5bbf9f", "#e0b060", "#c497d6"];

const ACCENT_NOTE_ID = "theme-accent-override-note";

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

// ── primitives (module scope, per the project convention) ──

function CardHeader({ icon: Icon, label, note, dirty }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        {Icon && <Icon size={12} color="var(--cc-accent)" aria-hidden="true" />}
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>{label}</span>
        {dirty && (
          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".08em", color: DIRTY }}>
            UNSAVED
          </span>
        )}
      </div>
      {note && (
        <div style={{ fontSize: 11, color: "var(--cc-muted)", marginTop: 5, lineHeight: 1.5 }}>
          {note}
        </div>
      )}
    </div>
  );
}

function Callout({ token = "var(--cc-muted)", children, testId, role = "note", id }) {
  return (
    <div
      id={id}
      data-testid={testId}
      role={role}
      style={{
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      {children}
    </div>
  );
}

/** One base-palette tile. Both palettes are dark; the tile says so. */
function PaletteTile({ palette, active, dirty, onSelect }) {
  return (
    <button
      type="button"
      data-testid={`palette-${palette.id}`}
      onClick={() => onSelect(palette.id)}
      aria-pressed={active}
      aria-label={`Use the ${palette.label} palette`}
      className="transition-colors hover-bg-elevated"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        textAlign: "left",
        flex: 1,
        minWidth: 0,
        padding: 10,
        borderRadius: 9,
        background: active ? tint("var(--cc-accent)", 10) : "var(--cc-elev)",
        border: `1px solid ${active ? "var(--cc-accent)" : dirty ? tint(DIRTY, 45) : "var(--cc-border)"}`,
        color: "var(--cc-fg)",
        fontFamily: "inherit",
        cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: active ? 700 : 600 }}>{palette.label}</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: "var(--cc-muted)",
          }}
        >
          dark
        </span>
      </span>
      {/* A swatch strip so the two palettes are distinguishable at a glance. */}
      <span style={{ display: "flex", gap: 3 }} aria-hidden="true">
        {["bg", "surface", "accent", "fn", "ok", "error"].map((key) => (
          <span
            key={key}
            data-testid={`palette-swatch-${palette.id}-${key}`}
            style={{
              width: 18,
              height: 12,
              borderRadius: 4,
              background: palette[key] || "transparent",
              border: "1px solid var(--cc-border)",
            }}
          />
        ))}
      </span>
    </button>
  );
}

/** The pill toggle used for focus glow. Mirrors ThemePopover's switch. */
function Toggle({ on, onToggle, label, testId, dirty }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onToggle}
      aria-pressed={Boolean(on)}
      aria-label={label}
      style={{
        width: 34,
        height: 18,
        borderRadius: 999,
        position: "relative",
        flexShrink: 0,
        cursor: "pointer",
        border: `1px solid ${dirty ? DIRTY : "var(--cc-border)"}`,
        background: on ? "var(--cc-accent)" : "var(--cc-surface)",
        transition: "background .15s",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 1,
          left: on ? 17 : 1,
          width: 14,
          height: 14,
          borderRadius: 999,
          background: on ? ACCENT_FG : "var(--cc-dim)",
          transition: "left .15s",
        }}
      />
    </button>
  );
}

/**
 * The supersession note plus its remedy. A warning with no way out is only half
 * a fix, so every line here carries an action.
 */
function SupersessionNote({ accentOverride, workingOverride, onClear, error }) {
  const actions = [
    accentOverride
      ? { token: "--cc-accent", text: "Clear token override", label: "Clear token override for --cc-accent" }
      : null,
    workingOverride
      ? { token: "--cc-working", text: "Clear --cc-working too", label: "Clear token override for --cc-working" }
      : null,
  ].filter(Boolean);

  return (
    <div
      id={ACCENT_NOTE_ID}
      role="note"
      data-testid="accent-override-note"
      style={{
        marginBottom: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: DIRTY,
        background: tint(DIRTY, 8),
        border: `1px solid ${tint(DIRTY, 35)}`,
      }}
    >
      {accentOverride && (
        <div>
          A design-token override for <code>--cc-accent</code> ({accentOverride}) is
          currently winning, so the accent control below has no effect on screen.
        </div>
      )}
      {workingOverride && (
        <div>
          <code>--cc-working</code> is overridden too ({workingOverride}), so the pane
          glow will not follow the accent either.
        </div>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
        {actions.map((a) => (
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
              color: DIRTY,
              background: "transparent",
              border: `1px solid ${tint(DIRTY, 45)}`,
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
            borderTop: `1px solid ${tint("var(--cc-error)", 35)}`,
            color: "var(--cc-error)",
            fontSize: 10,
          }}
        >
          Could not clear the override on the server: {error} It is cleared in this
          window only and will reappear when Cockpit restarts.
        </div>
      )}
    </div>
  );
}

// ── page ──────────────────────────────────────────────────

export default function ThemeSettings({ get, setField, isDirty }) {
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
  } = useTheme() || {};

  const overrides = tokenOverrides || {};
  const accentOverride =
    typeof overrides["--cc-accent"] === "string" ? overrides["--cc-accent"] : null;
  const workingOverride =
    typeof overrides["--cc-working"] === "string" ? overrides["--cc-working"] : null;
  const superseded = Boolean(accentOverride);

  const [clearError, setClearError] = useState(null);

  const paletteDirty = Boolean(isDirty?.(THEME_PATH));
  const accentDirty = Boolean(isDirty?.(ACCENT_PATH));
  const glowDirty = Boolean(isDirty?.(GLOW_ENABLED_PATH) || isDirty?.(GLOW_SIZE_PATH));

  // ── the dual writes ─────────────────────────────────────
  const handlePalette = (id) => {
    switchTheme?.(id);
    setField(THEME_PATH, id);
  };

  const handleAccent = (value) => {
    setAccent?.(value);
    setField(ACCENT_PATH, value);
  };

  const handleGlowEnabled = () => {
    const next = !glowValue;
    setGlowEnabled?.(next);
    setField(GLOW_ENABLED_PATH, next);
  };

  const handleGlowSize = (raw) => {
    const n = Number(raw);
    if (Number.isNaN(n)) return;
    setGlowStrength?.(n);
    setField(GLOW_SIZE_PATH, n);
  };

  // clearTokenOverride persists to settings.json and resolves {ok, error}. A
  // failure is SHOWN, never swallowed.
  const handleClear = async (token) => {
    setClearError(null);
    const result = await clearTokenOverride?.(token);
    if (result && result.ok === false) {
      setClearError(result.error || "The change was not saved.");
    }
  };

  // The live theme context is authoritative for what is on screen; the draft is
  // the fallback so a fresh page still reflects an unsaved edit.
  const glowValue =
    typeof glowEnabled === "boolean" ? glowEnabled : Boolean(get(GLOW_ENABLED_PATH, true));
  const sizeValue =
    typeof glowStrength === "number" && !Number.isNaN(glowStrength)
      ? glowStrength
      : Number(get(GLOW_SIZE_PATH, 30)) || 30;
  const accentValue = typeof accent === "string" && accent.length > 0 ? accent : null;

  return (
    <div
      data-testid="theme-settings"
      style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16, minWidth: 0 }}
    >
      {/* ── base palette ───────────────────────────── */}
      <div style={CARD} data-testid="palette-card">
        <CardHeader
          icon={Palette}
          label="Base palette"
          dirty={paletteDirty}
          note="Cockpit ships two palettes and both of them are dark — there is no light variant to switch to, so this page does not offer one. Everything else on this page layers on top of whichever base you pick."
        />
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {themes.map((t) => (
            <PaletteTile
              key={t.id}
              palette={t}
              active={t.id === themeId}
              dirty={paletteDirty}
              onSelect={handlePalette}
            />
          ))}
        </div>
      </div>

      {/* ── accent ─────────────────────────────────── */}
      <div style={CARD} data-testid="accent-card">
        <CardHeader
          label="Accent"
          dirty={accentDirty}
          note="The accent tints focus rings, active pills and the pane glow. Leave it unset to use the palette's own accent."
        />

        {superseded && (
          <SupersessionNote
            accentOverride={accentOverride}
            workingOverride={workingOverride}
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
            gap: 8,
            flexWrap: "wrap",
            opacity: superseded ? 0.45 : 1,
          }}
        >
          {ACCENT_PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              data-testid={`accent-preset-${c}`}
              onClick={() => handleAccent(c)}
              aria-label={`Accent ${c}`}
              aria-pressed={(accentValue || "").toLowerCase() === c.toLowerCase()}
              aria-disabled={superseded ? "true" : undefined}
              aria-describedby={superseded ? ACCENT_NOTE_ID : undefined}
              style={{
                width: 22,
                height: 22,
                borderRadius: 999,
                padding: 0,
                background: c,
                cursor: "pointer",
                border:
                  (accentValue || "").toLowerCase() === c.toLowerCase()
                    ? "2px solid var(--cc-fg)"
                    : "2px solid transparent",
              }}
            />
          ))}

          <span style={{ width: 1, height: 20, background: "var(--cc-line)" }} aria-hidden="true" />

          <input
            type="color"
            value={accentValue || "#4ea1e8"}
            onChange={(e) => handleAccent(e.target.value)}
            aria-label="Custom accent color"
            aria-describedby={superseded ? ACCENT_NOTE_ID : undefined}
            data-testid={`field-${ACCENT_PATH}`}
            data-dirty={accentDirty ? "true" : "false"}
            style={{
              width: 44,
              height: 26,
              padding: 0,
              borderRadius: 7,
              background: "var(--cc-elev)",
              border: `1px solid ${accentDirty ? DIRTY : "var(--cc-border)"}`,
              cursor: "pointer",
              flexShrink: 0,
            }}
          />
          <span
            data-testid="accent-value"
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: accentDirty ? DIRTY : "var(--cc-dim)",
            }}
          >
            {accentValue || "palette default"}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="accent-reset"
            onClick={() => handleAccent(null)}
            aria-label="Use the palette's own accent"
            className="transition-colors hover-bg-elevated"
            style={{
              height: 24,
              padding: "0 10px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              fontFamily: "inherit",
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
              cursor: "pointer",
            }}
          >
            Use palette accent
          </button>
        </div>
      </div>

      {/* ── focus glow ─────────────────────────────── */}
      <div style={CARD} data-testid="glow-card">
        <CardHeader
          icon={Sparkles}
          label="Focus glow"
          dirty={glowDirty}
          note="The coloured halo on the focused pane, and the state glow on bridged or channelled panes. Size 0 turns the halo off while leaving the glow enabled."
        />

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <Toggle
            on={glowValue}
            onToggle={handleGlowEnabled}
            label={glowValue ? "Disable the focus glow" : "Enable the focus glow"}
            testId={`field-${GLOW_ENABLED_PATH}`}
            dirty={Boolean(isDirty?.(GLOW_ENABLED_PATH))}
          />
          <span
            data-testid="glow-enabled-value"
            style={{
              fontSize: 12,
              fontWeight: 700,
              color: isDirty?.(GLOW_ENABLED_PATH) ? DIRTY : "var(--cc-fg)",
            }}
          >
            {glowValue ? "Enabled" : "Disabled"}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, opacity: glowValue ? 1 : 0.45 }}>
          <span style={{ ...LABEL, width: 76, flexShrink: 0 }}>Glow size</span>
          <input
            type="range"
            min={0}
            max={48}
            step={2}
            value={sizeValue}
            disabled={!glowValue}
            onChange={(e) => handleGlowSize(e.target.value)}
            aria-label="Glow size in pixels"
            data-testid={`field-${GLOW_SIZE_PATH}`}
            data-dirty={isDirty?.(GLOW_SIZE_PATH) ? "true" : "false"}
            style={{
              flex: 1,
              minWidth: 0,
              accentColor: isDirty?.(GLOW_SIZE_PATH) ? DIRTY : "var(--cc-accent)",
            }}
          />
          <span
            data-testid="glow-size-value"
            style={{
              fontSize: 12,
              fontWeight: 700,
              minWidth: 44,
              textAlign: "right",
              color: isDirty?.(GLOW_SIZE_PATH) ? DIRTY : "var(--cc-fg)",
            }}
          >
            {sizeValue}px
          </span>
        </div>
      </div>

      {/* ── relationship to the tokens page ────────── */}
      <Callout testId="tokens-pointer">
        This page sets the three levers most people want. For per-property control —
        every <code>--cc-*</code> custom property, import/export and named palettes —
        use <strong>Settings ▸ Design tokens</strong>. A token override there OUTRANKS
        the accent chosen here, which is why this page tells you when one is winning.
      </Callout>
    </div>
  );
}
