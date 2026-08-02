/**
 * SpillPolicy — screen 4a, the per-lane-class spill trigger control.
 *
 * SPILL, PRECISELY: the broker stores ONE number per lane class — the seconds of
 * PREDICTED WAIT above which a new request is refused locally (503
 * {spill:true}) so the caller can escalate to the paid API. Pinned from
 * broker.py::_queued_forward, the comparison is strictly greater: a predicted
 * wait exactly equal to the trigger still runs locally. `null` disables spill
 * for that class entirely.
 *
 * Queue depth is NOT the stored unit. It is offered here as an input convenience
 * because "two requests ahead of me" is what an operator can actually picture —
 * every depth entered is converted to seconds (via utils/laneMath) before it is
 * written, and the seconds field always shows what will actually be sent.
 *
 * HONESTY LEDGER — everything on this screen that is not fully live says so:
 *   1. `Either` trigger mode is DISABLED. The broker accepts a single wait
 *      threshold; there is no wire representation of "spill on wait OR depth",
 *      and faking it by writing the tighter of the two would be indistinguishable
 *      from a plain wait threshold while silently degrading to wait-only whenever
 *      p50 is unmeasured. A disabled segment with a reason is the truthful option.
 *   2. Cooldown / min headroom / estimator window / spill target model have NO
 *      broker endpoint and no enforcement anywhere. They are rendered disabled
 *      with a title naming the gap rather than persisted into settings.json,
 *      where they would become dead keys the user believes are doing something.
 *   3. Shadow mode is the broker's real `--shadow` flag but is START-TIME ONLY;
 *      its live value is shown read-only from /queue.
 *   4. spills.jsonl logging is unconditional in the broker — shown as a fact,
 *      not a switch.
 *   5. Thresholds are SESSION-ONLY on the broker (`persisted: false`) and reset
 *      on broker restart. Stated on the card, not buried.
 *   6. Spill counters are since the broker STARTED (in-memory Counter); the
 *      lifetime figure comes from spills.jsonl via /spills. Labelled as such
 *      instead of the mock's "today", which the data cannot support. No cost
 *      figure is rendered because nothing tracks spilled-request cost.
 *   7. PUT is 403 for remote-scope providers, so a remote provider disables the
 *      whole control up front rather than failing after an edit.
 *
 * Live reads are best-effort and happen ONCE per provider change plus after an
 * Apply — Settings is intent, not a dashboard, so this installs no interval.
 *
 * Props:
 *   provider — the provider descriptor declaring the `spill` capability, or null
 *   loading  — true while the parent has not finished reading /api/local/providers
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import {
  depthEquivalent,
  pressureFraction,
  predictedWaitSeconds,
  waitEquivalent,
} from "../../utils/laneMath";
import DepthWaitPanel from "./DepthWaitPanel";

const ACCENT_FG = "#0f1216"; // the one permitted literal: accent-segment foreground
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

/** Broker lane classes, in priority order (CLASS_RANK in broker.py). */
const CLASSES = [
  { key: "interactive", label: "interactive", audience: "your panes" },
  { key: "worker", label: "worker", audience: "bridges, channels" },
  { key: "batch", label: "batch", audience: "background jobs" },
];

/** Broker CLI defaults (broker.py main): interactive 30s, worker 300s, batch off. */
const DEFAULT_SECONDS = { interactive: 30, worker: 300, batch: 600 };

/** Server-side clamp on a threshold (_SPILL_MAX_S). */
const MAX_SECONDS = 86400;

const TRIGGER_UNITS = [
  { key: "wait", label: "Wait time" },
  { key: "depth", label: "Queue depth" },
  { key: "either", label: "Either" },
];

const EITHER_TITLE =
  "Not available — the broker stores a single wait threshold per lane class. There is no way to express \"wait OR depth\" on the wire, so Cockpit will not pretend to write one.";

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

/** Seconds → compact duration. Unknown renders "—", never a fabricated 0. */
function fmt(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

/** Best-effort JSON GET; null on any failure (callers render an offline state). */
async function safeGet(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // silent by convention — no console noise for background reads
  }
}

// ── primitives ────────────────────────────────────────────

function Pill({ token, children, title, testId }) {
  return (
    <span
      data-testid={testId}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        height: 20,
        padding: "0 8px",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: 999, background: token }} />
      {children}
    </span>
  );
}

function FooterButton({ label, onClick, disabled, accent, title, testId }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      className="rounded transition-colors hover-bg-elevated"
      style={{
        height: 26,
        minWidth: 76,
        padding: "0 12px",
        fontSize: 11,
        fontWeight: 700,
        borderRadius: 7,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: accent && !disabled ? ACCENT_FG : "var(--cc-fg)",
        border: `1px solid ${accent && !disabled ? "transparent" : "var(--cc-border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

/** Two-state switch. Used for the master and per-class enables. */
function Switch({ on, onChange, label, disabled, testId, title }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
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
        background: on ? "var(--cc-accent)" : "var(--cc-elev)",
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
          background: on ? ACCENT_FG : "var(--cc-muted)",
          transition: "left .15s ease",
        }}
      />
    </button>
  );
}

/** Trigger-unit segmented control. `Either` is present but inert — see the
 *  honesty ledger at the top of this file. */
function UnitSegments({ cls, unit, onUnit, depthDisabled, disabled }) {
  return (
    <div
      role="radiogroup"
      aria-label={`${cls} trigger unit`}
      data-testid={`unit-${cls}`}
      style={{
        display: "inline-flex",
        overflow: "hidden",
        borderRadius: 5,
        background: "var(--cc-elev)",
        border: "1px solid var(--cc-border)",
        flexShrink: 0,
      }}
    >
      {TRIGGER_UNITS.map((u) => {
        const active = u.key === unit;
        const inert =
          disabled || u.key === "either" || (u.key === "depth" && depthDisabled);
        return (
          <button
            key={u.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`${cls} trigger unit: ${u.label}`}
            data-testid={`unit-${cls}-${u.key}`}
            disabled={inert}
            onClick={() => onUnit(u.key)}
            className="transition-colors hover-bg-surface"
            title={
              u.key === "either"
                ? EITHER_TITLE
                : u.key === "depth" && depthDisabled
                  ? "Not available yet — no run has completed, so Cockpit cannot convert a queue depth into the seconds the broker stores."
                  : `Set the ${cls} trigger in ${u.label.toLowerCase()}`
            }
            style={{
              height: 22,
              padding: "0 8px",
              fontSize: 10,
              fontWeight: 700,
              border: "none",
              background: active ? "var(--cc-accent)" : "transparent",
              color: active ? ACCENT_FG : "var(--cc-dim)",
              opacity: inert && !active ? 0.45 : 1,
              cursor: inert ? "not-allowed" : "pointer",
            }}
          >
            {u.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One 74px number field. `derived` fields are read-only and prefixed "≈"; a
 * derived value that cannot be computed shows "≈?" with the reason in a title —
 * never a fabricated number.
 */
function NumberField({ cls, kind, value, derived, unknown, onChange, disabled, suffix }) {
  const readOnly = derived || disabled;
  const label = `${cls} spill trigger in ${kind === "seconds" ? "seconds" : "queued requests"}`;

  if (derived) {
    return (
      <div
        data-testid={`field-${cls}-${kind}`}
        data-derived="true"
        aria-label={`${label} (derived)`}
        title={
          unknown
            ? "No measured median wall time yet, so this equivalence is unknown. It appears once a run completes."
            : `Derived from the value you set — ${label}`
        }
        style={{
          width: 74,
          height: 26,
          padding: "0 8px",
          display: "flex",
          alignItems: "center",
          fontSize: 11,
          borderRadius: 7,
          background: "var(--cc-elev)",
          border: "1px solid var(--cc-border)",
          color: "var(--cc-muted)",
          flexShrink: 0,
        }}
      >
        {unknown ? "≈?" : `≈${value}${suffix || ""}`}
      </div>
    );
  }

  return (
    <input
      type="number"
      min={0}
      max={kind === "seconds" ? MAX_SECONDS : 9999}
      step={1}
      value={value === null || value === undefined ? "" : value}
      readOnly={readOnly}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
      data-testid={`field-${cls}-${kind}`}
      data-derived="false"
      className="rounded"
      style={{
        width: 74,
        height: 26,
        padding: "0 8px",
        fontSize: 11,
        borderRadius: 7,
        background: "var(--cc-elev)",
        border: `1px solid ${disabled ? "var(--cc-border)" : "var(--cc-accent)"}`,
        color: disabled ? "var(--cc-muted)" : "var(--cc-fg)",
        outline: "none",
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    />
  );
}

/** Inline callout. Never console.* — the user must be able to see the failure. */
function Callout({ token = "var(--cc-waiting)", children, testId }) {
  return (
    <div
      data-testid={testId}
      role="note"
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      <TriangleAlert size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

/** An Advanced control with no endpoint behind it. Disabled, with the gap named. */
function InertAdvanced({ name, label, hint, value, why }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={LABEL}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
        <input
          type="text"
          value={value}
          readOnly
          disabled
          aria-label={label}
          data-testid={`adv-${name}`}
          title={why}
          className="rounded"
          style={{
            width: 96,
            height: 26,
            padding: "0 8px",
            fontSize: 11,
            borderRadius: 7,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-muted)",
            opacity: 0.5,
            cursor: "not-allowed",
            flexShrink: 0,
          }}
        />
        <span style={{ fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.5, minWidth: 0 }}>{hint}</span>
      </div>
    </div>
  );
}

// ── per-class block ───────────────────────────────────────

function ClassBlock({
  cls,
  seconds,
  unit,
  onUnit,
  onSeconds,
  onEnabled,
  p50,
  nowWait,
  queuedCount,
  spilled,
  nearest,
  selected,
  onSelect,
  disabled,
}) {
  const enabled = seconds != null;
  const depthShown = depthEquivalent(seconds, p50);
  const derivedDepthUnknown = enabled && depthShown === null;
  // In depth mode the operator edits a count; the value written is still seconds.
  const depthValue = unit === "depth" ? depthEquivalent(seconds, p50) : depthShown;
  const fraction = pressureFraction(nowWait, seconds);
  const headroom = enabled && nowWait != null ? seconds - nowWait : null;

  const sentence = !enabled
    ? `Spill is off for ${cls.key} — these requests always wait for the local lane, however deep the queue gets.`
    : nowWait == null
      ? `Trigger is ${fmt(seconds)} of predicted wait. There is no live wait reading right now, so current headroom is unknown.`
      : `Spills when ${depthShown == null ? "the predicted wait passes the trigger" : `${depthShown} ${depthShown === 1 ? "request is" : "requests are"} already ahead of you`}. ${
          headroom > 0 ? `${fmt(headroom)} of headroom left.` : "Over the trigger — new requests are spilling now."
        }`;

  return (
    <div
      data-testid={`class-${cls.key}`}
      data-nearest={nearest ? "true" : "false"}
      style={{
        padding: 12,
        borderRadius: 10,
        background: "var(--cc-bg2)",
        border: `1px solid ${nearest ? "var(--cc-waiting)" : "var(--cc-line)"}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => onSelect(cls.key)}
          aria-pressed={selected}
          aria-label={`Show the wait translation for the ${cls.key} lane`}
          title={`Show the wait translation for the ${cls.key} lane`}
          className="transition-colors hover-bg-surface"
          style={{
            width: 96,
            flexShrink: 0,
            textAlign: "left",
            fontSize: 12,
            fontWeight: 700,
            padding: "2px 4px",
            borderRadius: 6,
            background: selected ? tint("var(--cc-accent)", 10) : "transparent",
            border: "none",
            color: selected ? "var(--cc-accent)" : "var(--cc-fg)",
            cursor: "pointer",
          }}
        >
          {cls.label}
        </button>
        <span style={{ width: 130, flexShrink: 0, fontSize: 10, color: "var(--cc-muted)" }}>
          {cls.audience}
        </span>

        <UnitSegments
          cls={cls.key}
          unit={unit}
          onUnit={(u) => onUnit(cls.key, u)}
          depthDisabled={p50 == null}
          disabled={disabled || !enabled}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <NumberField
            cls={cls.key}
            kind="seconds"
            value={seconds}
            derived={unit === "depth"}
            unknown={unit === "depth" && seconds == null}
            onChange={(raw) => onSeconds(cls.key, raw, "seconds")}
            disabled={disabled || !enabled}
            suffix="s"
          />
          <span style={{ fontSize: 9, color: "var(--cc-muted)", width: 14 }}>s</span>
          <NumberField
            cls={cls.key}
            kind="depth"
            value={depthValue}
            derived={unit !== "depth"}
            unknown={unit !== "depth" && derivedDepthUnknown}
            onChange={(raw) => onSeconds(cls.key, raw, "depth")}
            disabled={disabled || !enabled}
          />
          <span style={{ fontSize: 9, color: "var(--cc-muted)", width: 26 }}>deep</span>
        </div>

        <Switch
          on={enabled}
          onChange={(next) => onEnabled(cls.key, next)}
          label={`Spill for the ${cls.key} lane`}
          testId={`enable-${cls.key}`}
          disabled={disabled}
          title={
            enabled
              ? `Turn spill off for ${cls.key} — requests will always wait locally`
              : `Turn spill on for ${cls.key}`
          }
        />
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginTop: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            aria-hidden="true"
            style={{ height: 6, borderRadius: 999, background: "var(--cc-elev)", overflow: "hidden" }}
          >
            {fraction == null ? (
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
                style={{
                  width: `${fraction * 100}%`,
                  height: "100%",
                  background: fraction >= 1 ? "var(--cc-error)" : "var(--cc-waiting)",
                }}
              />
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
            <span data-testid={`now-${cls.key}`} style={{ fontSize: 10, color: "var(--cc-dim)" }}>
              now · {nowWait == null ? "wait unknown" : `${fmt(nowWait)} wait`} ·{" "}
              {queuedCount == null ? "queue unknown" : `${queuedCount} queued`}
            </span>
            <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
              {enabled ? `trigger · ${fmt(seconds)} wait` : "no trigger · spill off"}
              {spilled > 0 ? ` · ${spilled} spilled` : ""}
            </span>
          </div>
        </div>
        <div
          data-testid={`sentence-${cls.key}`}
          style={{ width: 230, flexShrink: 0, fontSize: 11, lineHeight: 1.5, color: "var(--cc-fg)" }}
        >
          {sentence}
        </div>
      </div>
    </div>
  );
}

// ── page section ──────────────────────────────────────────

export default function SpillPolicy({ provider, loading }) {
  const [spill, setSpill] = useState(undefined); // undefined = not read, null = unreachable
  const [queue, setQueue] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [spillLog, setSpillLog] = useState(null);
  const [drafts, setDrafts] = useState({}); // cls -> seconds|null (unapplied)
  const [units, setUnits] = useState({ interactive: "wait", worker: "wait", batch: "wait" });
  const [selected, setSelected] = useState("interactive");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Remembers the last enabled value per class so the enable toggle (and the
  // master) can restore what the user had rather than inventing a number.
  const lastEnabled = useRef({});

  const providerId = provider?.id ?? null;
  const isRemote = provider != null && provider.scope !== "local";
  const hasSpill = Boolean(provider?.capabilities?.includes?.("spill"));

  const load = useCallback(async () => {
    if (!providerId) return;
    const base = `/api/local/${providerId}`;
    const [s, q, m, log] = await Promise.all([
      safeGet(`${base}/spill`),
      safeGet(`${base}/queue`),
      safeGet(`${base}/metrics?window=lifetime`),
      safeGet(`${base}/spills?limit=1`),
    ]);
    setSpill(s ?? null);
    setQueue(q);
    setMetrics(m);
    setSpillLog(log);
  }, [providerId]);

  useEffect(() => {
    load();
  }, [load]);

  const brokerThresholds = useMemo(() => {
    const t = spill && spill.reachable !== false ? spill.spill_thresholds_s : null;
    return t && typeof t === "object" ? t : {};
  }, [spill]);

  /** Effective (draft-over-broker) threshold for a class. */
  const effective = useCallback(
    (key) => {
      if (key in drafts) return drafts[key];
      const v = brokerThresholds[key];
      return typeof v === "number" && isFinite(v) ? v : null;
    },
    [drafts, brokerThresholds]
  );

  const p50 = useMemo(() => {
    const ms = metrics && metrics.reachable !== false ? metrics.run_time_ms?.p50 : null;
    return typeof ms === "number" && ms > 0 ? ms / 1000 : null;
  }, [metrics]);

  const queueLive = useMemo(() => {
    const q = queue && queue.reachable !== false ? queue : null;
    const inFlight = q?.in_flight ? 1 : 0;
    const queued = Array.isArray(q?.queued) ? q.queued.length : null;
    const byClass = q?.predicted_wait_s_by_class;
    return { ok: Boolean(q), inFlight, queued, byClass, shadow: q?.shadow };
  }, [queue]);

  /** Live predicted wait for a class. Prefers the broker's own per-class
   *  figure; falls back to the shared conversion so the two never disagree. */
  const nowWaitFor = useCallback(
    (key) => {
      const v = queueLive.byClass?.[key];
      if (typeof v === "number" && isFinite(v) && v >= 0) return v;
      if (!queueLive.ok) return null;
      return predictedWaitSeconds(queueLive.inFlight, queueLive.queued ?? 0, p50);
    },
    [queueLive, p50]
  );

  // The class closest to tripping gets the --cc-waiting border.
  const nearestKey = useMemo(() => {
    let best = null;
    let bestFrac = -1;
    for (const c of CLASSES) {
      const f = pressureFraction(nowWaitFor(c.key), effective(c.key));
      if (f != null && f > bestFrac) {
        bestFrac = f;
        best = c.key;
      }
    }
    return best;
  }, [nowWaitFor, effective]);

  // The broker publishes `shadow` on /queue; read it rather than inferring it
  // from an empty queue, which is also what a healthy idle lane looks like.
  // In shadow, `_queued_forward` never runs, so `record_spill` never runs, so
  // no threshold on this card can ever fire -- offering editable, live-looking
  // controls for it is the same false claim as an empty queue with no note.
  const isShadow = queue?.shadow === true;
  const controlsDisabled = busy || isRemote || !hasSpill || spill == null || isShadow;

  const setDraft = useCallback((key, value) => {
    if (value != null) lastEnabled.current[key] = value;
    setDrafts((prev) => ({ ...prev, [key]: value }));
    setError(null);
  }, []);

  const handleUnit = useCallback((key, unit) => {
    setUnits((prev) => ({ ...prev, [key]: unit }));
  }, []);

  /** A typed value in either unit, normalised to the seconds the broker stores. */
  const handleNumber = useCallback(
    (key, raw, kind) => {
      const n = Number(raw);
      if (raw === "" || !isFinite(n) || n < 0) {
        setError("A spill trigger must be zero or a positive number.");
        return;
      }
      if (kind === "seconds") {
        if (n > MAX_SECONDS) {
          setError(`A wait trigger cannot exceed ${MAX_SECONDS} seconds.`);
          return;
        }
        setDraft(key, n);
        return;
      }
      const seconds = waitEquivalent(Math.floor(n), p50);
      if (seconds == null) {
        setError("No measured median wall time yet — a queue depth cannot be converted to seconds.");
        return;
      }
      setDraft(key, Math.min(MAX_SECONDS, seconds));
    },
    [p50, setDraft]
  );

  const handleEnabled = useCallback(
    (key, next) => {
      if (!next) {
        setDraft(key, null);
        return;
      }
      const restore =
        lastEnabled.current[key] ??
        (typeof brokerThresholds[key] === "number" ? brokerThresholds[key] : null) ??
        DEFAULT_SECONDS[key];
      setDraft(key, restore);
    },
    [brokerThresholds, setDraft]
  );

  const masterOn = CLASSES.some((c) => effective(c.key) != null);

  const handleMaster = useCallback(
    (next) => {
      const patch = {};
      for (const c of CLASSES) {
        patch[c.key] = next
          ? (lastEnabled.current[c.key] ??
            (typeof brokerThresholds[c.key] === "number" ? brokerThresholds[c.key] : null) ??
            DEFAULT_SECONDS[c.key])
          : null;
        if (patch[c.key] != null) lastEnabled.current[c.key] = patch[c.key];
      }
      setDrafts(patch);
      setError(null);
    },
    [brokerThresholds]
  );

  const dirtyKeys = CLASSES.map((c) => c.key).filter((key) => {
    if (!(key in drafts)) return false;
    const broker = typeof brokerThresholds[key] === "number" ? brokerThresholds[key] : null;
    return drafts[key] !== broker;
  });

  const revert = useCallback(() => {
    setDrafts({});
    setError(null);
  }, []);

  const apply = useCallback(async () => {
    if (!providerId || dirtyKeys.length === 0) return;
    const body = {};
    for (const key of dirtyKeys) body[key] = drafts[key];
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/local/${providerId}/spill`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(
          data?.error ||
            (res.status === 403
              ? "This provider is remote — Cockpit will not write to it."
              : "The broker refused the change; nothing was applied.")
        );
        return;
      }
      // The broker echoes its whole spill state (thresholds + counters); that
      // echo — not our draft — becomes the displayed truth. A response that is
      // not spill-shaped means the write did NOT take, and the server turns
      // that into a 502, handled above. No re-GET: it would race the echo and
      // could quietly show a stale value as if the write had failed.
      setSpill(data);
      setDrafts({});
    } catch (err) {
      setError(`Could not reach Cockpit: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }, [providerId, dirtyKeys, drafts]);

  // ── states where there is nothing to control ────────────
  if (loading) {
    return (
      <div style={CARD} data-testid="card-spill">
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>Spill policy</div>
        <div style={{ fontSize: 11, color: "var(--cc-muted)", paddingTop: 6 }}>
          Reading which backends offer spill control…
        </div>
      </div>
    );
  }

  if (!provider || !hasSpill) {
    return (
      <div style={CARD} data-testid="card-spill">
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>Spill policy</div>
        <Callout token="var(--cc-muted)" testId="spill-no-capability">
          No registered backend declares the <code>spill</code> capability, so there are no
          thresholds to set. Spill is a lane-broker feature — a backend served direct (vLLM) has
          no queue to spill out of.
        </Callout>
      </div>
    );
  }

  const spilledSinceStart =
    spill && spill.reachable !== false && typeof spill.spilled_total === "number"
      ? spill.spilled_total
      : null;
  const spilledLifetime = typeof spillLog?.count === "number" ? spillLog.count : null;

  return (
    <div style={{ display: "flex", gap: 16, alignItems: "flex-start", minWidth: 0 }}>
      <div style={{ ...CARD, width: 880, flexShrink: 0, minWidth: 0 }} data-testid="card-spill">
        {/* header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
            paddingBottom: 10,
            marginBottom: 12,
            borderBottom: "1px solid var(--cc-line)",
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>Spill policy</span>
          <Pill
            token={spill == null ? "var(--cc-error)" : masterOn ? "var(--cc-idle)" : "var(--cc-muted)"}
            testId="spill-state-pill"
            title={
              spill == null
                ? "Cockpit could not read the broker's spill configuration"
                : masterOn
                  ? "At least one lane class has a trigger set"
                  : "Every lane class has spill disabled"
            }
          >
            {spill == null ? "offline" : masterOn ? "Active" : "All off"}
          </Pill>
          <span data-testid="spill-context" style={{ fontSize: 11, color: "var(--cc-dim)" }}>
            {p50 == null ? "median wall not measured yet" : `measured p50 wall ${fmt(p50)}`}
            {` · in flight ${queueLive.ok ? queueLive.inFlight : "?"}`}
            {` · queued ${queueLive.queued == null ? "?" : queueLive.queued}`}
          </span>
          <span style={{ marginLeft: "auto" }} />
          <span style={{ ...LABEL, fontSize: 10 }}>Master</span>
          <Switch
            on={masterOn}
            onChange={handleMaster}
            label="Master spill switch"
            testId="spill-master"
            disabled={controlsDisabled}
            title="Sets all three lane classes at once — the broker has no separate master switch, so this simply stages every class on or off."
          />
        </div>

        {isRemote && (
          <Callout testId="spill-remote">
            <strong>{provider.label || provider.id}</strong> is a remote backend. Cockpit refuses
            spill writes to anything it does not own (the endpoint answers 403), so these controls
            are read-only here. Change the thresholds where that broker runs.
          </Callout>
        )}

        {isShadow && (
          <Callout testId="spill-shadow">
            <strong>These thresholds cannot fire on this build.</strong> The lane broker is
            running in <strong>shadow mode</strong>: it forwards and logs every request but never
            queues one, and spill is only evaluated on the queued path. The values below are the
            broker's real stored configuration — they are shown, not guessed — but nothing will
            act on them until queueing is on. Set <code>COCKPIT_BROKER_SHADOW=0</code> and restart
            to enable queueing.
          </Callout>
        )}

        {spill == null && (
          <Callout testId="spill-offline">
            The broker did not answer, so its current thresholds are unknown and nothing can be
            changed. The values below are not being shown as guesses — the fields are empty.
          </Callout>
        )}

        {/* per-class blocks */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {CLASSES.map((cls) => (
            <ClassBlock
              key={cls.key}
              cls={cls}
              seconds={effective(cls.key)}
              unit={units[cls.key]}
              onUnit={handleUnit}
              onSeconds={handleNumber}
              onEnabled={handleEnabled}
              p50={p50}
              nowWait={nowWaitFor(cls.key)}
              queuedCount={queueLive.queued}
              spilled={
                (spill && spill.reachable !== false && spill.spilled_by_class?.[cls.key]) || 0
              }
              nearest={nearestKey === cls.key}
              selected={selected === cls.key}
              onSelect={setSelected}
              disabled={controlsDisabled}
            />
          ))}
        </div>

        {/* session-only warning — the trap this card must not spring */}
        <div
          data-testid="spill-session-only"
          role="note"
          style={{ fontSize: 11, lineHeight: 1.5, color: "var(--cc-muted)", paddingTop: 10 }}
        >
          These thresholds are <strong>session-only on the broker</strong> — it reports{" "}
          <code>persisted: false</code>. They apply the moment you click Apply and are discarded
          when the broker restarts, which returns every class to its command-line default. Nothing
          here is written to disk.
        </div>

        {/* Advanced — no endpoint behind any of it */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--cc-line)" }}>
          <div style={{ ...LABEL, marginBottom: 8 }}>Advanced</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, minWidth: 0 }}>
            <InertAdvanced
              name="cooldown"
              label="Cooldown after a spill (s)"
              value=""
              hint="No broker endpoint — the broker re-evaluates every request independently."
              why="Disabled: the lane broker has no cooldown setting. Saving a value here would change nothing."
            />
            <InertAdvanced
              name="headroom"
              label="Min local headroom (requests)"
              value=""
              hint="No broker endpoint — spill is decided purely on predicted wait."
              why="Disabled: the lane broker has no headroom setting. Saving a value here would change nothing."
            />
            <InertAdvanced
              name="estimator"
              label="Wait estimator window"
              value={p50 == null ? "" : `p50 · ${fmt(p50)}`}
              hint="Read-only. The broker's estimator window is fixed and not exposed for tuning."
              why="Disabled: the broker's wait estimator is not configurable over its HTTP contract."
            />
            <InertAdvanced
              name="target"
              label="Spill target model"
              value=""
              hint="No broker endpoint — a spilled request is refused (503) and the caller chooses where to go."
              why="Disabled: the broker does not forward spilled requests, so it has no target to set."
            />
            <div style={{ minWidth: 0 }}>
              <div style={LABEL}>Shadow mode</div>
              <div
                data-testid="adv-shadow"
                style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}
              >
                <Pill
                  token={queueLive.shadow ? "var(--cc-waiting)" : "var(--cc-idle)"}
                  title="Read live from the broker's /queue snapshot"
                >
                  {queueLive.shadow === undefined ? "unknown" : queueLive.shadow ? "shadow" : "enforcing"}
                </Pill>
                <span style={{ fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.5 }}>
                  Start-time only (the broker's <code>--shadow</code> flag). It cannot be toggled
                  while the broker is running, so there is no switch here.
                </span>
              </div>
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={LABEL}>Spill event log</div>
              <div
                data-testid="adv-spilllog"
                style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}
              >
                <Pill token="var(--cc-idle)" title="The broker always appends spill events">
                  always on
                </Pill>
                <span style={{ fontSize: 10, color: "var(--cc-muted)", lineHeight: 1.5 }}>
                  Every spill is appended to <code>spills.jsonl</code> unconditionally — not a
                  setting, so it is shown as a fact.
                </span>
              </div>
            </div>
          </div>
        </div>

        {error && <Callout token="var(--cc-error)" testId="spill-error">{error}</Callout>}

        {/* footer */}
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
          <TriangleAlert size={13} style={{ color: "var(--cc-waiting)", flexShrink: 0 }} />
          <span data-testid="spill-billing" style={{ fontSize: 11, color: "var(--cc-fg)", lineHeight: 1.5 }}>
            Spilled requests are refused locally and billed to whichever paid API the caller falls
            back to.{" "}
            {spilledSinceStart == null
              ? "Spill counts are unavailable while the broker is unreachable."
              : `${spilledSinceStart} since the broker started`}
            {spilledLifetime == null ? "" : `, ${spilledLifetime} recorded in total`}. Cockpit does
            not track what those requests cost, so no dollar figure is shown.
          </span>
          <span style={{ marginLeft: "auto" }} />
          <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
            {dirtyKeys.length === 0
              ? "No pending changes"
              : `Applies immediately to ${dirtyKeys.length} ${dirtyKeys.length === 1 ? "class" : "classes"}`}
          </span>
          <FooterButton
            label="Revert"
            testId="spill-revert"
            onClick={revert}
            disabled={dirtyKeys.length === 0 || busy}
            title="Discard the pending changes and go back to the broker's current thresholds"
          />
          <FooterButton
            label={busy ? "Applying…" : "Apply"}
            testId="spill-apply"
            accent
            onClick={apply}
            disabled={controlsDisabled || dirtyKeys.length === 0}
            title="Write these thresholds to the broker now (session-only — lost on broker restart)"
          />
        </div>
      </div>

      <DepthWaitPanel
        laneClass={selected}
        p50WallSeconds={p50}
        thresholdSeconds={effective(selected)}
        pending={dirtyKeys.includes(selected)}
      />
    </div>
  );
}
