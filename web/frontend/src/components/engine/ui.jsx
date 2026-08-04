/* eslint-disable react-refresh/only-export-components -- Engine-internal
   furniture: the style tokens live beside the primitives that consume them.
   None of these are routes, so fast-refresh granularity is irrelevant, and
   splitting six 3-line constants into a second module would scatter them away
   from their only call sites. */
/**
 * Shared Engine primitives — cards, pills, stats, bars, buttons, notes.
 *
 * Matches the Phase 4 facelift idiom established by settings/ProvidersSettings:
 * radius 12 cards on --cc-surface with a 1px --cc-border and 16px padding,
 * `role="note"` callouts, `hover-bg-*` classes (never JS mouse handlers), real
 * <button type="button"> with an aria-label.
 *
 * HONESTY CONTRACT: every renderer here accepts `null`/`undefined` as "unknown"
 * and renders an em dash, NOT a zero. A 0 in this UI must always mean "measured
 * zero" — the whole point of Engine ▸ Live is that the operator can trust the
 * numbers. `Bar` refuses to draw a fill when the fraction is unknown, for the
 * same reason (an empty bar reads as "0%", which is a claim).
 */

/** The one permitted literal: accent-button foreground. */
export const ACCENT_FG = "#0f1216";

export const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

export const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

export const LABEL = {
  fontSize: 9,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

export const UNKNOWN = "—";

/** The Engine tab vocabulary. Ids are deep-link values — renaming one is breaking. */
/* S26 (2026-08-03): Engine keeps Live / Models / API and nothing else.
   `requests` and `logs` moved to Reports ▸ Traces and Reports ▸ Logs. Engine owns
   NOW; a completed request tree and a log tail are both the PAST, which is
   Reports' job. NOTHING WAS DELETED — both panels render, at their new address. */
export const ENGINE_TABS = [
  { id: "live", label: "Live" },
  { id: "models", label: "Models" },
  { id: "api", label: "API" },
];

export const DEFAULT_ENGINE_TAB = "live";

/** Best-effort JSON GET. Returns null on any failure — callers render offline
 *  state. Silent by convention: no console noise for background reads. */
export async function safeGet(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function fmtInt(n) {
  if (typeof n !== "number" || !isFinite(n)) return UNKNOWN;
  return String(Math.round(n));
}

export function fmtNum(n, digits = 1) {
  if (typeof n !== "number" || !isFinite(n)) return UNKNOWN;
  return n.toFixed(digits);
}

/** Elapsed seconds as a compact readout: 0.9s / 12.4s / 3m 05s. */
export function fmtElapsed(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return UNKNOWN;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function fmtPct(n) {
  if (typeof n !== "number" || !isFinite(n)) return UNKNOWN;
  return `${Math.round(n)}%`;
}

// ── primitives ────────────────────────────────────────────

export function Card({ title, right, children, style, testId, subtitle }) {
  return (
    <div data-testid={testId} style={{ ...CARD, minWidth: 0, display: "flex", flexDirection: "column", ...style }}>
      {(title || right) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingBottom: 10,
            marginBottom: 10,
            borderBottom: "1px solid var(--cc-line, var(--cc-border))",
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>{title}</span>
          <span style={{ flex: 1 }} />
          {right}
        </div>
      )}
      {subtitle && (
        <div style={{ fontSize: 10, color: "var(--cc-muted)", marginTop: -4, marginBottom: 8, lineHeight: 1.5 }}>
          {subtitle}
        </div>
      )}
      {children}
    </div>
  );
}

/** Card title text + optional leading icon. */
export function CardTitle({ icon: Icon, token = "var(--cc-accent)", children }) {
  return (
    <>
      {Icon && (
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: token,
            background: tint(token, 8),
            border: `1px solid ${tint(token, 30)}`,
            flexShrink: 0,
          }}
        >
          <Icon size={12} />
        </span>
      )}
      <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>{children}</span>
    </>
  );
}

/** Status pill: dot + 9px/800 uppercase text, tinted by a state token. */
export function Pill({ token, children, title, testId }) {
  return (
    <span
      data-testid={testId}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 18,
        padding: "0 8px",
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: token, flexShrink: 0 }} />
      {children}
    </span>
  );
}

export function Badge({ children, token = "var(--cc-dim)", title, testId }) {
  return (
    <span
      data-testid={testId}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        height: 18,
        padding: "0 7px",
        borderRadius: 7,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 30)}`,
        flexShrink: 0,
      }}
    >
      {children}
    </span>
  );
}

/**
 * Standard Engine button. `danger` paints the --cc-error outline used by
 * Stop engine; `accent` is the single filled variant.
 */
export function Btn({
  label,
  onClick,
  disabled,
  title,
  accent,
  danger,
  icon: Icon,
  testId,
  children,
  width,
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      className="hover-bg-elevated"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        height: 24,
        width,
        padding: "0 9px",
        borderRadius: 7,
        fontFamily: "inherit",
        fontSize: 10,
        fontWeight: 700,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: danger
          ? "var(--cc-error)"
          : accent && !disabled
            ? ACCENT_FG
            : "var(--cc-fg)",
        border: `1px solid ${
          danger
            ? tint("var(--cc-error)", 40)
            : accent && !disabled
              ? "transparent"
              : "var(--cc-border)"
        }`,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
      }}
    >
      {Icon && <Icon size={11} aria-hidden="true" />}
      {children || label}
    </button>
  );
}

/** Inline callout. Always role="note" so screen readers get the caveat. */
export function Note({ children, token = "var(--cc-muted)", icon: Icon, testId, tinted }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        display: "flex",
        gap: 7,
        alignItems: "flex-start",
        fontSize: 10,
        lineHeight: 1.55,
        color: token,
        ...(tinted
          ? {
              marginTop: 8,
              padding: "7px 9px",
              borderRadius: 9,
              background: tint(token, 8),
              border: `1px solid ${tint(token, 35)}`,
            }
          : { marginTop: 6 }),
      }}
    >
      {Icon && <Icon size={12} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}

/** A 20px/700 number over a 9px/800 uppercase label. */
export function Stat({ label, value, token = "var(--cc-fg)", unit, title, testId }) {
  const unknown = value === UNKNOWN || value == null;
  return (
    <div data-testid={testId} title={title} style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 20,
          fontWeight: 700,
          lineHeight: 1.15,
          color: unknown ? "var(--cc-muted)" : token,
          whiteSpace: "nowrap",
        }}
      >
        {unknown ? UNKNOWN : value}
        {!unknown && unit && (
          <span style={{ fontSize: 10, fontWeight: 700, color: "var(--cc-dim)", marginLeft: 3 }}>{unit}</span>
        )}
      </div>
      <div style={{ ...LABEL, marginTop: 3 }}>{label}</div>
    </div>
  );
}

/**
 * 5px meter. `fraction` null = unknown: the track renders with NO fill and the
 * readout says so, because an empty bar would otherwise be read as a measured 0.
 */
export function Bar({ label, fraction, token = "var(--cc-accent)", readout, unknownNote, testId }) {
  const known = typeof fraction === "number" && isFinite(fraction);
  const pct = known ? Math.min(1, Math.max(0, fraction)) * 100 : 0;
  return (
    <div data-testid={testId} style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span style={LABEL}>{label}</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            color: known ? "var(--cc-fg)" : "var(--cc-muted)",
          }}
        >
          {known ? readout : UNKNOWN}
        </span>
      </div>
      <div
        aria-hidden="true"
        style={{
          height: 5,
          marginTop: 5,
          borderRadius: 999,
          background: "var(--cc-elev)",
          overflow: "hidden",
        }}
      >
        {known && <div style={{ width: `${pct}%`, height: "100%", background: token, borderRadius: 999 }} />}
      </div>
      {!known && unknownNote && (
        <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 4, lineHeight: 1.5 }}>{unknownNote}</div>
      )}
    </div>
  );
}

/**
 * Bar sparkline. Renders one 3px-gap column per sample; a null sample renders as
 * a bare track slot rather than a zero-height bar, so "we did not measure this"
 * and "it was zero" stay visually distinct.
 */
export function Sparkline({ samples, token = "var(--cc-working)", height = 34, caption, testId }) {
  const list = Array.isArray(samples) ? samples : [];
  const max = list.reduce((m, v) => (typeof v === "number" && isFinite(v) && v > m ? v : m), 0);
  return (
    <div data-testid={testId}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height, minWidth: 0 }}>
        {list.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--cc-muted)", alignSelf: "center" }}>
            no samples yet
          </span>
        ) : (
          list.map((v, i) => {
            const known = typeof v === "number" && isFinite(v);
            const h = known && max > 0 ? Math.max(2, (v / max) * height) : 2;
            return (
              <div
                key={i}
                title={known ? `${v} tok/s` : "not reported"}
                style={{
                  flex: 1,
                  minWidth: 2,
                  height: h,
                  borderRadius: 4,
                  background: known ? token : "var(--cc-elev)",
                  opacity: known ? 0.75 : 1,
                }}
              />
            );
          })
        )}
      </div>
      {caption && (
        <div style={{ fontSize: 9, color: "var(--cc-muted)", marginTop: 5, letterSpacing: ".04em" }}>{caption}</div>
      )}
    </div>
  );
}

/**
 * The single offline renderer for the whole Engine section. Inline, never a
 * toast, and it never substitutes zeros for missing data.
 */
export function OfflinePanel({ title, body, testId }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        borderRadius: 12,
        border: "1px dashed var(--cc-border)",
        background: tint("var(--cc-surface)", 40),
        padding: 18,
        maxWidth: 620,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>{title}</div>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: 0 }}>{body}</p>
    </div>
  );
}
