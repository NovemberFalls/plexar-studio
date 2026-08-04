/* eslint-disable react-refresh/only-export-components -- SPEND (the pinned
   dotted-path map) and the four pure validators are exported ONLY so the test
   suite can pin them: the contract paths and the reject-nonsense rules are the
   load-bearing behaviour of this page and must be provable in isolation. They
   belong beside their single call site; a separate module would scatter five
   tiny declarations away from the page that defines their meaning. Same
   arrangement, and same reason, as TokensSettings.jsx. */
/**
 * SpendGuardrails — the Settings ▸ Reporting & retention spend section.
 *
 * THE ONE IDEA THIS FILE IS BUILT AROUND: display and enforcement are different
 * things, and conflating them produces a guardrail that blocks free work.
 *
 * Plexar Studio reports API-EQUIVALENT cost — tokens multiplied by recorded prices.
 * That is the right number to SHOW in both billing modes. It is the wrong number
 * to ENFORCE on while the owner is on the Claude monthly subscription, because
 * the marginal cost of another Claude turn under a subscription is zero. A hard
 * cap on an equivalent figure would stop work that costs nothing.
 *
 * Real money, meanwhile, already flows: OpenRouter and any direct API key are
 * billed per token today regardless of the subscription. Local models are $0.
 *
 * So there are two caps and they are deliberately NOT symmetric:
 *   spend.caps.real_usd        — money actually billed. OpenRouter and direct API
 *                                keys always; native Anthropic spend ONLY when
 *                                mode == "api", because under a subscription an
 *                                Anthropic turn is not money billed and lands in
 *                                `equivalent` alone. Blockable in BOTH modes.
 *   spend.caps.equivalent_usd  — includes subscription Claude turns. Alerts in
 *                                both modes; BLOCKING is only offered when
 *                                spend.mode === "api". Under "subscription" the
 *                                block switch is disabled with the reason in its
 *                                title rather than silently ignored server-side.
 *
 * Alerting and blocking are separate switches on purpose. Wanting to know is not
 * the same as wanting to be stopped, and bundling them forces one to buy the
 * other.
 *
 * THESE SETTINGS ARE LIVE. spend_guard.py reads spend.* and enforces at bridge /
 * channel start (409), at each turn boundary, and at session create when
 * enforce_on.new_sessions is on. Interactive typing is never blocked.
 *
 * THE FAILURE MODE THIS PAGE EXISTS TO PREVENT, and it is not the obvious one:
 * the backend DOWNGRADES a hard block to an alert when the pricing behind a cap
 * is not trustworthy, and reports that as `enforcement_available: false` (top
 * level and per class) plus a human-written line in `caveats`. A user who turns
 * "hard stop" on and sees no warning would believe they are protected when they
 * are not — for a spend cap that is the worst possible failure, because the
 * false sense of safety invites exactly the unattended overspend the toggle
 * appears to prevent. So a block that is configured but cannot currently fire is
 * marked NOT ENFORCING in --cc-waiting, and the caveats are rendered VERBATIM.
 * The toggle stays operable throughout: the setting is legitimate and starts
 * enforcing the moment pricing becomes trustworthy. This is a status indicator,
 * never a permission change.
 *
 * `percent: null` from the status endpoint means NO CAP, and is rendered as an
 * explicit no-cap state. It must never become a 0% bar: an empty bar reads as
 * "plenty of headroom", which is a materially different claim from "unbounded".
 *
 * `null` cap = no cap, and it is an explicit visible state (a switch plus the
 * words "No cap") rather than an empty text box, which is indistinguishable from
 * a field the user forgot to fill in.
 *
 * Every value goes through the shell's `setField` (draft + `Save changes`) — this
 * page keeps NOTHING in component state except transient validation messages and
 * the read-only status snapshot. Invalid numerics are rejected inline and never
 * written, so a bad keystroke cannot become a saved cap.
 *
 * GET /api/spend/status is read ONCE on mount, best-effort. Settings are intent,
 * not a dashboard: there is no interval here, and a 404 (the endpoint may not
 * exist yet) renders an honest "status unavailable" line while every control
 * above it keeps working.
 *
 * Props (same contract as every other Settings page):
 *   get(dottedPath, fallback) → current DRAFT value
 *   setField(dottedPath, value) → record an unsaved edit
 *   isDirty(dottedPath) → bool, prefix-aware
 */

import { useCallback, useEffect, useState } from "react";
import { TriangleAlert } from "lucide-react";

const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-segment foreground
const DIRTY = "var(--cc-waiting)";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

// ── pinned setting paths ──────────────────────────────────
export const SPEND = {
  mode: "spend.mode",
  period: "spend.period",
  resetDay: "spend.monthly_reset_day",
  capReal: "spend.caps.real_usd",
  capEquivalent: "spend.caps.equivalent_usd",
  alertPercent: "spend.alert_at_percent",
  blockReal: "spend.block.real",
  blockEquivalent: "spend.block.equivalent",
  enforceBridges: "spend.enforce_on.bridges",
  enforceNewSessions: "spend.enforce_on.new_sessions",
};

const MODES = [
  { key: "subscription", label: "Subscription" },
  { key: "api", label: "API billing" },
];

const PERIODS = [
  { key: "daily", label: "Daily" },
  { key: "weekly", label: "Weekly" },
  { key: "monthly", label: "Monthly" },
];

const DEFAULT_ALERT_PERCENT = 80;
const MAX_RESET_DAY = 28;
const CAP_MAX = 1000000;
/** Fallback when a cap is switched on and there is no earlier value to restore. */
const CAP_SEED = { real: 20, equivalent: 100 };

const EQUIVALENT_BLOCK_DISABLED_TITLE =
  "Not available on the subscription. A hard stop here would refuse work that costs nothing extra — another Claude turn on a monthly plan has no marginal price. Switch the billing mode to API billing to make this cap enforceable; it can still alert.";

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

/** Which token paints a status state. Unknown states fall back to neutral. */
const STATE_TOKEN = {
  ok: "var(--cc-ok)",
  alert: "var(--cc-waiting)",
  over: "var(--cc-error)",
};

// ── pure helpers (exported so the suite can pin them) ─────

/** A finite number, or null. Never NaN, never a string. */
export function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return null;
}

/**
 * Validate a typed cap. Returns {ok:true, value} or {ok:false, error}.
 * Rejects blanks, negatives, zero and nonsense outright — the way to express
 * "no limit" is the No-cap switch, not an empty or zero field.
 */
export function validateCap(raw) {
  if (raw === "" || raw === null || raw === undefined) {
    return { ok: false, error: "Enter a dollar amount, or turn the cap off to remove it." };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: "That is not a number." };
  if (n <= 0) {
    return { ok: false, error: "A cap must be more than $0. Turn the cap off to remove it entirely." };
  }
  if (n > CAP_MAX) return { ok: false, error: `A cap cannot exceed $${CAP_MAX.toLocaleString()}.` };
  return { ok: true, value: n };
}

/** Validate the alert threshold. 1..100, integers only. */
export function validatePercent(raw) {
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) return { ok: false, error: "Enter a percentage between 1 and 100." };
  if (!Number.isInteger(n)) return { ok: false, error: "Use a whole percentage." };
  if (n < 1 || n > 100) return { ok: false, error: "The alert threshold must be between 1 and 100 percent." };
  return { ok: true, value: n };
}

/** Validate the monthly reset day. 1..28 so every month has one. */
export function validateResetDay(raw) {
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n)) return { ok: false, error: "Enter a day between 1 and 28." };
  if (!Number.isInteger(n)) return { ok: false, error: "Use a whole day of the month." };
  if (n < 1 || n > MAX_RESET_DAY) {
    return {
      ok: false,
      error: `Use a day between 1 and ${MAX_RESET_DAY} — later days do not exist in every month.`,
    };
  }
  return { ok: true, value: n };
}

/** spent/cap as a 0..1 fraction, or null when either side is unknown. */
export function usedFraction(spent, cap) {
  const s = asNumber(spent);
  const c = asNumber(cap);
  if (s == null || c == null || c <= 0) return null;
  return Math.max(0, Math.min(1, s / c));
}

/**
 * How one class's meter should read. Three OUTCOMES, never conflated:
 *   "nocap"   — cap is null / percent is null. There is no bar, because a 0%
 *               bar would claim headroom where the truth is "unbounded".
 *   "unknown" — a cap exists but the fraction cannot be computed. Hatched.
 *   "bar"     — a real fraction. Prefers the server's own `percent` so Plexar Studio
 *               and the backend can never disagree on the same number.
 */
export function meterRead(data) {
  const cap = asNumber(data?.cap);
  const percent = asNumber(data?.percent);
  if (cap == null || percent == null) return { kind: "nocap", fraction: null };
  const fraction = Math.max(0, Math.min(1, percent / 100));
  if (!Number.isFinite(fraction)) {
    const derived = usedFraction(data?.spent, cap);
    return derived == null ? { kind: "unknown", fraction: null } : { kind: "bar", fraction: derived };
  }
  return { kind: "bar", fraction };
}

/** True when a block is configured but the backend cannot currently fire it. */
export function isConfiguredNotEnforcing(blockOn, classStatus) {
  return Boolean(blockOn) && classStatus?.enforcement_available === false;
}

/** Plain-English scope of enforcement, built from spend.enforce_on. */
export function enforcementScopeSentence(bridges, newSessions) {
  const targets = [];
  if (bridges) targets.push("autonomous bridges and channels");
  if (newSessions) targets.push("opening a new session");
  if (targets.length === 0) {
    return "A hard stop is not allowed to refuse anything right now — every enforcement target below is unchecked, so the caps can only alert. Interactive typing is never blocked.";
  }
  return `A hard stop can refuse ${targets.join(" and ")}. Nothing else is blocked — in particular, typing in a session you already have open is never interrupted.`;
}

/** Dollars for display. Unknown renders "—", never a fabricated 0. */
function usd(value) {
  const n = asNumber(value);
  if (n == null) return "—";
  return `$${n.toFixed(2)}`;
}

// ── primitives ────────────────────────────────────────────

function Switch({ on, onChange, label, disabled, testId, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={Boolean(on)}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      title={title || label}
      onClick={() => onChange(!on)}
      style={{
        width: 30,
        height: 16,
        borderRadius: 999,
        flexShrink: 0,
        position: "relative",
        border: "1px solid var(--cc-border)",
        background: on && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 1,
          left: on ? 15 : 1,
          width: 12,
          height: 12,
          borderRadius: 999,
          background: on && !disabled ? ACCENT_FG : "var(--cc-muted)",
          transition: "left .15s ease",
        }}
      />
    </button>
  );
}

/** Segmented radiogroup. Used for the billing mode and the period. */
function Segments({ groupLabel, options, value, onChange, testId, titleFor }) {
  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      data-testid={testId}
      style={{
        display: "inline-flex",
        overflow: "hidden",
        borderRadius: 5,
        background: "var(--cc-elev)",
        border: "1px solid var(--cc-border)",
        flexShrink: 0,
      }}
    >
      {options.map((o) => {
        const active = o.key === value;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${groupLabel}: ${o.label}`}
            data-testid={`${testId}-${o.key}`}
            title={titleFor ? titleFor(o) : `${groupLabel}: ${o.label}`}
            onClick={() => onChange(o.key)}
            className="transition-colors hover-bg-surface"
            style={{
              height: 22,
              padding: "0 10px",
              fontSize: 10,
              fontWeight: 700,
              border: "none",
              background: active ? "var(--cc-accent)" : "transparent",
              color: active ? ACCENT_FG : "var(--cc-dim)",
              fontFamily: "inherit",
              cursor: "pointer",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Callout({ token = "var(--cc-muted)", children, testId, icon }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      {icon && <TriangleAlert size={13} style={{ flexShrink: 0, marginTop: 1 }} />}
      <span>{children}</span>
    </div>
  );
}

function FieldError({ message, testId }) {
  if (!message) return null;
  return (
    <div
      data-testid={testId}
      role="alert"
      style={{ fontSize: 10, color: "var(--cc-error)", lineHeight: 1.5, marginTop: 4 }}
    >
      {message}
    </div>
  );
}

function SectionHeader({ label, note }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>{label}</span>
        <span style={{ flex: 1, height: 1, background: "var(--cc-line)" }} aria-hidden="true" />
      </div>
      {note && (
        <div style={{ fontSize: 11, color: "var(--cc-muted)", marginTop: 4, lineHeight: 1.5 }}>
          {note}
        </div>
      )}
    </div>
  );
}

/**
 * One cap row: name, plain-English scope, the dollar field, a No-cap switch and
 * a hard-block switch. The block switch is where the interlock lives.
 */
function CapRow({
  kind,
  title,
  scope,
  cap,
  onCap,
  onCapEnabled,
  blockOn,
  onBlock,
  blockDisabled,
  blockTitle,
  blockFootnote,
  notEnforcing,
  error,
  dirty,
}) {
  const enabled = cap != null;
  return (
    <div
      data-testid={`cap-row-${kind}`}
      style={{
        padding: 12,
        borderRadius: 9,
        background: "var(--cc-bg2)",
        border: `1px solid ${dirty ? DIRTY : "var(--cc-line)"}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)", width: 150, flexShrink: 0 }}>
          {title}
        </span>

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>$</span>
          {enabled ? (
            <input
              type="number"
              min={0}
              max={CAP_MAX}
              step="0.01"
              value={cap}
              onChange={(e) => onCap(e.target.value)}
              aria-label={`${title} in US dollars per period`}
              data-testid={`field-${kind === "real" ? SPEND.capReal : SPEND.capEquivalent}`}
              data-dirty={dirty ? "true" : "false"}
              style={{
                width: 92,
                height: 26,
                padding: "0 8px",
                fontSize: 11,
                fontFamily: "inherit",
                borderRadius: 7,
                background: "var(--cc-elev)",
                border: `1px solid ${error ? "var(--cc-error)" : dirty ? DIRTY : "var(--cc-accent)"}`,
                color: "var(--cc-fg)",
                outline: "none",
              }}
            />
          ) : (
            /* "No cap" is SAID, not implied by an empty box — an empty field is
               indistinguishable from one the user meant to fill in. */
            <span
              data-testid={`nocap-${kind}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 26,
                padding: "0 10px",
                borderRadius: 999,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".06em",
                textTransform: "uppercase",
                color: "var(--cc-muted)",
                background: tint("var(--cc-muted)", 8),
                border: `1px solid ${tint("var(--cc-muted)", 35)}`,
              }}
            >
              No cap
            </span>
          )}
        </div>

        <Switch
          on={enabled}
          onChange={onCapEnabled}
          label={`${title} enabled`}
          testId={`cap-enabled-${kind}`}
          title={
            enabled
              ? `Turn this cap off — spending in this class becomes unlimited`
              : `Turn this cap on`
          }
        />

        <span style={{ marginLeft: "auto" }} />

        {/* A block that is switched on but cannot fire is the dangerous state:
            it LOOKS like protection. Marked here, at the switch, as well as on
            the meter below — the user's eye is on the toggle they just flipped. */}
        {notEnforcing && (
          <span
            data-testid={`cap-not-enforcing-${kind}`}
            title="Saved, but not currently enforcing — Plexar Studio does not have trustworthy prices for this class yet, so this cap can only alert. See the notes in This period below."
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              height: 16,
              padding: "0 7px",
              borderRadius: 999,
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: DIRTY,
              background: tint(DIRTY, 8),
              border: `1px solid ${tint(DIRTY, 35)}`,
            }}
          >
            <TriangleAlert size={9} aria-hidden="true" />
            Not enforcing
          </span>
        )}

        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>Hard stop</span>
        <Switch
          on={blockOn}
          onChange={onBlock}
          label={`Hard stop when the ${kind === "real" ? "real spend" : "API-equivalent"} cap is reached`}
          testId={`block-${kind}`}
          disabled={blockDisabled}
          title={blockTitle}
        />
      </div>

      <div style={{ fontSize: 11, color: "var(--cc-dim)", marginTop: 8, lineHeight: 1.5 }}>
        {scope}
      </div>
      {blockFootnote && (
        <div
          data-testid={`block-footnote-${kind}`}
          role="note"
          style={{ fontSize: 10, color: "var(--cc-muted)", marginTop: 6, lineHeight: 1.5 }}
        >
          {blockFootnote}
        </div>
      )}
      <FieldError message={error} testId={`cap-error-${kind}`} />
    </div>
  );
}

/**
 * One class's live figures: spent vs cap, a 6px bar, the state colour, and — when
 * a block is switched on that cannot currently fire — the NOT ENFORCING marker.
 */
function StatusMeter({ kind, label, data, blockOn }) {
  const state = data && typeof data.state === "string" ? data.state : null;
  const token = STATE_TOKEN[state] || "var(--cc-muted)";
  const cap = asNumber(data?.cap);
  const read = meterRead(data);
  const notEnforcing = isConfiguredNotEnforcing(blockOn, data);

  return (
    <div
      data-testid={`status-meter-${kind}`}
      data-state={state || "unknown"}
      data-meter={read.kind}
      style={{ minWidth: 0 }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "var(--cc-fg)" }}>{label}</span>
        <span style={{ fontSize: 11, color: "var(--cc-dim)" }}>
          {usd(data?.spent)} {cap == null ? "· no cap set" : `of ${usd(cap)}`}
        </span>
        {notEnforcing && (
          <span
            data-testid={`not-enforcing-${kind}`}
            title="This hard stop is saved and will start working on its own once Plexar Studio has trustworthy prices for it. Right now it cannot fire, so it is not protecting you — see the notes below."
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              height: 16,
              padding: "0 7px",
              borderRadius: 999,
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: ".08em",
              textTransform: "uppercase",
              color: DIRTY,
              background: tint(DIRTY, 8),
              border: `1px solid ${tint(DIRTY, 35)}`,
            }}
          >
            <TriangleAlert size={9} aria-hidden="true" />
            Hard stop not enforcing
          </span>
        )}
        <span style={{ marginLeft: "auto" }} />
        <span style={{ fontSize: 10, fontWeight: 700, color: token }}>
          {state ? state.toUpperCase() : "UNKNOWN"}
        </span>
      </div>

      {/* No cap gets NO bar. An empty bar would read as "plenty of headroom",
          which is a different claim from "there is no limit at all". */}
      {read.kind === "nocap" ? (
        <div
          data-testid={`status-nocap-${kind}`}
          style={{ fontSize: 10, color: "var(--cc-muted)", marginTop: 5, lineHeight: 1.5 }}
        >
          No cap set for this class, so there is no progress to show — spending here is unbounded.
        </div>
      ) : (
        <div
          aria-hidden="true"
          style={{
            height: 6,
            marginTop: 5,
            borderRadius: 4,
            background: "var(--cc-elev)",
            overflow: "hidden",
          }}
        >
          {read.kind === "unknown" ? (
            <div
              style={{
                width: "100%",
                height: "100%",
                background:
                  "repeating-linear-gradient(45deg, color-mix(in srgb, var(--cc-muted) 35%, transparent) 0 3px, transparent 3px 6px)",
              }}
            />
          ) : (
            <div
              data-testid={`status-bar-${kind}`}
              style={{ width: `${read.fraction * 100}%`, height: "100%", background: token }}
            />
          )}
        </div>
      )}

      {notEnforcing && (
        <div
          data-testid={`not-enforcing-note-${kind}`}
          role="note"
          style={{ fontSize: 10, color: DIRTY, marginTop: 5, lineHeight: 1.5 }}
        >
          You have the hard stop switched on for this class, but Plexar Studio cannot enforce it at the
          moment, so it will alert instead of blocking. The reason is in the notes below. Leave the
          switch on — it starts enforcing by itself once the pricing behind it is trustworthy.
        </div>
      )}
    </div>
  );
}

// ── page section ──────────────────────────────────────────

export default function SpendGuardrails({ get, setField, isDirty }) {
  // undefined = not read yet, null = unavailable (404 or unreachable)
  const [status, setStatus] = useState(undefined);
  const [errors, setErrors] = useState({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/spend/status");
        if (!res.ok) {
          if (alive) setStatus(null);
          return;
        }
        const data = await res.json();
        if (alive) setStatus(data && typeof data === "object" ? data : null);
      } catch {
        // Best-effort background read. Silent by convention; the card says so.
        if (alive) setStatus(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setError = useCallback((key, message) => {
    setErrors((prev) => {
      if (!message && !(key in prev)) return prev;
      const next = { ...prev };
      if (message) next[key] = message;
      else delete next[key];
      return next;
    });
  }, []);

  const mode = get(SPEND.mode, "subscription") === "api" ? "api" : "subscription";
  const rawPeriod = get(SPEND.period, "monthly");
  const period = PERIODS.some((p) => p.key === rawPeriod) ? rawPeriod : "monthly";
  const resetDay = get(SPEND.resetDay, 1);
  const capReal = asNumber(get(SPEND.capReal, null));
  const capEquivalent = asNumber(get(SPEND.capEquivalent, null));
  const alertPercent = get(SPEND.alertPercent, DEFAULT_ALERT_PERCENT);
  const blockReal = Boolean(get(SPEND.blockReal, false));
  const blockEquivalent = Boolean(get(SPEND.blockEquivalent, false));
  const enforceBridges = get(SPEND.enforceBridges, true) !== false;
  const enforceNewSessions = get(SPEND.enforceNewSessions, false) === true;

  // THE INTERLOCK. Under a subscription the equivalent number is informational,
  // so blocking on it is refused at the control rather than silently dropped.
  const equivalentBlockDisabled = mode === "subscription";

  const commitCap = (path, key, raw) => {
    const result = validateCap(raw);
    if (!result.ok) {
      setError(key, result.error);
      return; // nothing written — a bad keystroke never becomes a saved cap
    }
    setError(key, null);
    setField(path, result.value);
  };

  const toggleCap = (path, key, current, seed, next) => {
    setError(key, null);
    setField(path, next ? (current != null ? current : seed) : null);
  };

  const commitPercent = (raw) => {
    const result = validatePercent(raw);
    if (!result.ok) {
      setError("percent", result.error);
      return;
    }
    setError("percent", null);
    setField(SPEND.alertPercent, result.value);
  };

  const commitResetDay = (raw) => {
    const result = validateResetDay(raw);
    if (!result.ok) {
      setError("resetDay", result.error);
      return;
    }
    setError("resetDay", null);
    setField(SPEND.resetDay, result.value);
  };

  const groupDirty = Boolean(isDirty?.("spend"));
  const periodLabel = typeof status?.period?.label === "string" ? status.period.label : null;
  const reasons = Array.isArray(status?.reasons) ? status.reasons : [];
  // An absent `caveats` key is normal, not an error — it simply means the
  // backend had nothing to qualify. Never let its absence break the card.
  const caveats = Array.isArray(status?.caveats) ? status.caveats : [];

  return (
    <div
      data-testid="spend-guardrails"
      style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 900, minWidth: 0 }}
    >
      {/* ── billing mode ─────────────────────────────── */}
      <div style={CARD} data-testid="card-spend-mode">
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>Spend guardrails</span>
          {groupDirty && (
            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: ".08em", color: DIRTY }}>
              UNSAVED
            </span>
          )}
          <span style={{ marginLeft: "auto" }} />
          <span style={{ ...LABEL }}>Billing mode</span>
          <Segments
            groupLabel="Billing mode"
            testId="spend-mode"
            options={MODES}
            value={mode}
            onChange={(key) => setField(SPEND.mode, key)}
            titleFor={(o) =>
              o.key === "subscription"
                ? "You pay Anthropic a flat monthly fee. Another Claude turn costs nothing extra, so the API-equivalent cap only warns."
                : "You are billed per token for Claude as well, so the API-equivalent cap becomes real money and can enforce."
            }
          />
        </div>

        <div style={{ marginTop: 12 }}>
          <Callout testId="mode-consequence">
            {mode === "subscription" ? (
              <>
                On the <strong>subscription</strong>, Claude turns are already paid for — one more
                turn costs nothing extra. So the API-equivalent cap below can{" "}
                <strong>warn but not block</strong>; a hard stop there would refuse work that is
                free at the margin. The real-money cap still enforces, and on this plan it covers{" "}
                <strong>OpenRouter and direct API keys only</strong> — your Anthropic turns are not
                money billed, so they count toward the API-equivalent figure alone. Local models
                are $0.
              </>
            ) : (
              <>
                On <strong>API billing</strong> every Claude token is invoiced too, so the
                API-equivalent figure IS your bill and its hard stop is available. Anthropic spend
                now also <strong>counts toward the real-money cap</strong>, alongside OpenRouter and
                direct API keys. Local models are $0.
              </>
            )}
          </Callout>
        </div>
      </div>

      {/* ── period ───────────────────────────────────── */}
      <div style={CARD} data-testid="card-spend-period">
        <SectionHeader
          label="Budget period"
          note="The window each cap is measured over. Spending resets when the window rolls."
        />
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Segments
            groupLabel="Budget period"
            testId="spend-period"
            options={PERIODS}
            value={period}
            onChange={(key) => setField(SPEND.period, key)}
          />

          {period === "monthly" && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--cc-dim)" }}>resets on day</span>
              <input
                type="number"
                min={1}
                max={MAX_RESET_DAY}
                step={1}
                value={asNumber(resetDay) ?? 1}
                onChange={(e) => commitResetDay(e.target.value)}
                aria-label="Monthly reset day of month"
                data-testid={`field-${SPEND.resetDay}`}
                data-dirty={isDirty?.(SPEND.resetDay) ? "true" : "false"}
                style={{
                  width: 62,
                  height: 26,
                  padding: "0 8px",
                  fontSize: 11,
                  fontFamily: "inherit",
                  borderRadius: 7,
                  background: "var(--cc-elev)",
                  border: `1px solid ${
                    errors.resetDay ? "var(--cc-error)" : isDirty?.(SPEND.resetDay) ? DIRTY : "var(--cc-accent)"
                  }`,
                  color: "var(--cc-fg)",
                  outline: "none",
                }}
              />
            </div>
          )}

          <span style={{ marginLeft: "auto" }} />
          <span data-testid="period-window" style={{ fontSize: 11, color: "var(--cc-dim)" }}>
            {periodLabel ? `current window · ${periodLabel}` : "current window unknown"}
          </span>
        </div>
        <FieldError message={errors.resetDay} testId="reset-day-error" />

        {period === "monthly" && (
          <div style={{ marginTop: 10 }}>
            <Callout testId="reset-day-note">
              Set this day deliberately: a Claude subscription renews on your{" "}
              <strong>signup anniversary</strong>, while API billing runs on the{" "}
              <strong>calendar month</strong>. If the day here does not match the cycle you are
              actually billed on, a cap will reset in the middle of your billing period. Days 29–31
              are not offered because they do not exist in every month.
            </Callout>
          </div>
        )}
      </div>

      {/* ── caps ─────────────────────────────────────── */}
      <div style={CARD} data-testid="card-spend-caps">
        <SectionHeader
          label="Caps"
          note="Two separate budgets, because they are two different kinds of money. A cap can alert without blocking — those are independent switches."
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <CapRow
            kind="real"
            title="Real spend cap"
            scope={
              mode === "subscription"
                ? "OpenRouter and direct API keys. This is money you are billed for. It does NOT include your Anthropic turns on this plan — those are covered by the subscription, so they count toward the API-equivalent cap instead. Enforces in both billing modes."
                : "OpenRouter, direct API keys, and — because you are on API billing — your Anthropic spend too. This is money you are billed for. Enforces in both billing modes."
            }
            cap={capReal}
            onCap={(raw) => commitCap(SPEND.capReal, "capReal", raw)}
            onCapEnabled={(next) => toggleCap(SPEND.capReal, "capReal", capReal, CAP_SEED.real, next)}
            blockOn={blockReal}
            onBlock={(next) => setField(SPEND.blockReal, next)}
            blockDisabled={false}
            blockTitle="Stop new work once real billed spend reaches this cap. Available in both billing modes — this is money you are actually charged."
            notEnforcing={isConfiguredNotEnforcing(blockReal, status?.real)}
            error={errors.capReal}
            dirty={Boolean(isDirty?.(SPEND.capReal))}
          />

          <CapRow
            kind="equivalent"
            title="API-equivalent cap"
            scope="Everything Plexar Studio records, including Claude turns already covered by your subscription. Priced as if it had run on the API."
            cap={capEquivalent}
            onCap={(raw) => commitCap(SPEND.capEquivalent, "capEquivalent", raw)}
            onCapEnabled={(next) =>
              toggleCap(SPEND.capEquivalent, "capEquivalent", capEquivalent, CAP_SEED.equivalent, next)
            }
            blockOn={blockEquivalent}
            onBlock={(next) => setField(SPEND.blockEquivalent, next)}
            blockDisabled={equivalentBlockDisabled}
            blockTitle={
              equivalentBlockDisabled
                ? EQUIVALENT_BLOCK_DISABLED_TITLE
                : "Stop new work once API-equivalent spend reaches this cap. Available because you are on API billing, where that figure is your actual bill."
            }
            blockFootnote={
              equivalentBlockDisabled
                ? "Alerts only while you are on the subscription — the hard stop is disabled because another Claude turn costs nothing extra. It becomes available under API billing."
                : null
            }
            notEnforcing={isConfiguredNotEnforcing(blockEquivalent, status?.equivalent)}
            error={errors.capEquivalent}
            dirty={Boolean(isDirty?.(SPEND.capEquivalent))}
          />
        </div>

        {/* alert threshold — deliberately separate from the block switches */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginTop: 12,
            paddingTop: 12,
            borderTop: "1px solid var(--cc-line)",
          }}
        >
          <span style={{ ...LABEL }}>Alert at</span>
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={asNumber(alertPercent) ?? DEFAULT_ALERT_PERCENT}
            onChange={(e) => commitPercent(e.target.value)}
            aria-label="Alert threshold as a percentage of the cap"
            data-testid={`field-${SPEND.alertPercent}`}
            data-dirty={isDirty?.(SPEND.alertPercent) ? "true" : "false"}
            style={{
              width: 62,
              height: 26,
              padding: "0 8px",
              fontSize: 11,
              fontFamily: "inherit",
              borderRadius: 7,
              background: "var(--cc-elev)",
              border: `1px solid ${
                errors.percent ? "var(--cc-error)" : isDirty?.(SPEND.alertPercent) ? DIRTY : "var(--cc-accent)"
              }`,
              color: "var(--cc-fg)",
              outline: "none",
            }}
          />
          <span style={{ fontSize: 11, color: "var(--cc-dim)" }}>
            % of a cap · applies to both caps, in both billing modes
          </span>
        </div>
        <FieldError message={errors.percent} testId="percent-error" />
      </div>

      {/* ── where it enforces ────────────────────────── */}
      <div style={CARD} data-testid="card-spend-enforce">
        <SectionHeader
          label="Where it enforces"
          note="Which actions a hard stop is allowed to refuse. With every box unchecked, a cap can only alert."
        />

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label
            style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={enforceBridges}
              onChange={(e) => setField(SPEND.enforceBridges, e.target.checked)}
              aria-label="Enforce caps on autonomous bridges and channels"
              data-testid={`field-${SPEND.enforceBridges}`}
              style={{ marginTop: 2, accentColor: "var(--cc-accent)", cursor: "pointer" }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>
                Autonomous bridges and channels
              </span>
              <span style={{ display: "block", fontSize: 11, color: "var(--cc-muted)", lineHeight: 1.5 }}>
                On by default, and this is the one that matters. A bridge or channel is bounded by a
                turn cap, and a turn cap bounds <strong>turns, not dollars</strong> — one turn can
                be a hundred times more expensive than another. They also run unattended, so nobody
                is watching the number climb.
              </span>
            </span>
          </label>

          <label
            style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
          >
            <input
              type="checkbox"
              checked={enforceNewSessions}
              onChange={(e) => setField(SPEND.enforceNewSessions, e.target.checked)}
              aria-label="Enforce caps on new sessions"
              data-testid={`field-${SPEND.enforceNewSessions}`}
              style={{ marginTop: 2, accentColor: "var(--cc-accent)", cursor: "pointer" }}
            />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>
                Opening a new session
              </span>
              <span style={{ display: "block", fontSize: 11, color: "var(--cc-muted)", lineHeight: 1.5 }}>
                Off by default — you are sitting in front of a session you open yourself, so being
                refused at the door is usually more disruptive than useful.
              </span>
            </span>
          </label>
        </div>
      </div>

      {/* ── live status ──────────────────────────────── */}
      <div style={CARD} data-testid="card-spend-status">
        <SectionHeader
          label="This period"
          note="Read once when this page opened. Settings are intent, not a dashboard — nothing here polls."
        />

        {status === undefined && (
          <div style={{ fontSize: 11, color: "var(--cc-muted)" }}>Reading current spend…</div>
        )}

        {status === null && (
          <Callout token="var(--cc-muted)" testId="status-unavailable">
            Current spend is unavailable — <code>/api/spend/status</code> did not answer. The
            settings above still apply; only the live figures are missing. No numbers are being
            guessed in their place.
          </Callout>
        )}

        {status && typeof status === "object" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
              <span style={{ fontSize: 11, color: "var(--cc-dim)" }}>
                {periodLabel || "period unknown"}
              </span>
              <span style={{ fontSize: 11, color: "var(--cc-muted)" }}>
                · mode {typeof status.mode === "string" ? status.mode : "unknown"}
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <StatusMeter kind="real" label="Real spend" data={status.real} blockOn={blockReal} />
              <StatusMeter
                kind="equivalent"
                label="API-equivalent"
                data={status.equivalent}
                blockOn={blockEquivalent}
              />
            </div>

            {/* What a hard stop actually covers. A guardrail whose scope is
                invisible invites the assumption that it is total. */}
            <div
              data-testid="enforcement-scope"
              role="note"
              style={{
                fontSize: 11,
                color: "var(--cc-dim)",
                lineHeight: 1.5,
                marginTop: 12,
                paddingTop: 12,
                borderTop: "1px solid var(--cc-line)",
              }}
            >
              {enforcementScopeSentence(enforceBridges, enforceNewSessions)}
            </div>

            {status.blocking === true && (
              <div style={{ marginTop: 12 }}>
                <Callout token="var(--cc-error)" testId="status-blocking" icon>
                  <strong>Plexar Studio is blocking new work right now.</strong>
                  {reasons.length > 0 ? (
                    <ul data-testid="status-reasons" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                      {reasons.map((r, i) => (
                        <li key={`${i}-${String(r)}`} style={{ lineHeight: 1.5 }}>
                          {String(r)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span> The server did not say which cap tripped.</span>
                  )}
                </Callout>
              </div>
            )}

            {/* Caveats are written to be read by a human. Rendered VERBATIM —
                paraphrasing them would drop the specifics that make them
                actionable ("203 local model run(s)…", "no OpenRouter price
                snapshots…"), and those specifics are the whole point. */}
            {caveats.length > 0 && (
              <div
                data-testid="status-caveats"
                style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}
              >
                {caveats.map((c, i) => (
                  <div
                    key={`${i}-${String(c)}`}
                    role="note"
                    data-testid={`status-caveat-${i}`}
                    style={{
                      display: "flex",
                      gap: 7,
                      alignItems: "flex-start",
                      fontSize: 11,
                      lineHeight: 1.5,
                      color: DIRTY,
                      background: tint(DIRTY, 8),
                      border: `1px solid ${tint(DIRTY, 35)}`,
                      borderRadius: 9,
                      padding: "7px 10px",
                    }}
                  >
                    <TriangleAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
                    <span>{String(c)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── the honesty note ─────────────────────────── */}
      <Callout testId="spend-honesty" token="var(--cc-muted)">
        Every cost figure in Plexar Studio is <strong>API-equivalent</strong>: recorded tokens multiplied
        by the prices in the pricing table, not an invoice. While you are on the subscription, the
        equivalent number is an estimate of what the same work <em>would</em> have cost on the API —
        it is not money you were charged, and your real bill is the flat monthly fee plus whatever
        OpenRouter and any direct API keys actually billed you.
      </Callout>
    </div>
  );
}
