import {
  PanelLeft,
  FolderOpen,
  GitBranch,
  Merge,
  OctagonX,
  GitFork,
  ExternalLink,
} from "lucide-react";
// sessionVocabulary.js is the single source for the permission-mode and effort
// vocabularies. Imported rather than re-declared so adding a level in one place
// cannot leave this panel offering a different set — this panel drives LIVE
// sessions, so a divergence here means a session configured with something the
// rest of the UI cannot express. A plain module, deliberately: importing these
// from TopBar dragged a whole UI tree into this file's tests.
import {
  PERMISSION_MODES,
  EFFORT_OPTIONS as SHARED_EFFORT_OPTIONS,
} from "../../sessionVocabulary";

/** Map a session's activity state/status to a --cc-* state color token (mirrors Sidebar.jsx STATE_COLOR). */
const STATE_COLOR = {
  busy: "var(--cc-working)",
  working: "var(--cc-working)",
  thinking: "var(--cc-thinking)",
  waiting: "var(--cc-waiting)",
  idle: "var(--cc-idle)",
  running: "var(--cc-idle)",
  error: "var(--cc-error)",
  starting: "var(--cc-muted)",
  history: "var(--cc-muted)",
};
function getStateColor(state) {
  return STATE_COLOR[state] || STATE_COLOR.idle;
}

/** Format a token/usage number honestly — never render a misleading 0 for a missing value. */
function fmtCount(n) {
  if (n === null || n === undefined) return "n/a";
  if (typeof n !== "number" || Number.isNaN(n)) return "n/a";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function fmtCost(n) {
  if (n === null || n === undefined || typeof n !== "number" || Number.isNaN(n)) return "n/a";
  return `$${n.toFixed(2)}`;
}

/** 9px/700 uppercase section label used throughout the Inspector. */
function SectionLabel({ children }) {
  return (
    <div
      className="text-[9px] font-bold uppercase"
      style={{ color: "var(--cc-muted)", letterSpacing: ".08em", marginBottom: 6 }}
    >
      {children}
    </div>
  );
}

/** A single labelled 26px select used in the "This session" 2x2 grid. */
function OverrideSelect({ label, value, options, onChange }) {
  return (
    <label className="flex flex-col gap-0.5" style={{ minWidth: 0 }}>
      <span className="sr-only">{label}</span>
      <select
        aria-label={label}
        title={label}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-[11px] rounded"
        style={{
          height: 26,
          padding: "0 6px",
          background: "var(--cc-elev)",
          border: "1px solid var(--cc-border)",
          color: "var(--cc-fg)",
        }}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Small pill-style action button used in the bottom 2x2 action grid. */
function ActionButton({ icon: Icon, label, onClick, danger, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex items-center justify-center gap-1.5 rounded transition-colors hover-bg-elevated"
      style={{
        height: 30,
        background: "var(--cc-surface)",
        border: `1px solid ${danger ? "color-mix(in srgb, var(--cc-error) 40%, transparent)" : "var(--cc-border)"}`,
        color: danger ? "var(--cc-error)" : "var(--cc-fg)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {Icon && <Icon size={12} style={{ flexShrink: 0 }} />}
      {label}
    </button>
  );
}

const BRIDGE_ROLE_LABEL = {
  sender: "BRIDGE SENDER",
  receiver: "BRIDGE RECEIVER",
  lead: "CHANNEL LEAD",
  worker: "CHANNEL WORKER",
};

/** Bridge/channel card — red for bridge, orange for channel, per design handoff tokens. */
function BridgeCard({ bridge, onEndBridge, onOpenTranscript }) {
  const isChannel = bridge.kind === "channel";
  const accent = isChannel ? "#ff8c00" : "#ff0033";
  const border = isChannel ? "rgba(255,140,0,.4)" : "rgba(255,0,51,.4)";
  const bg = isChannel ? "rgba(255,140,0,.08)" : "rgba(255,0,51,.08)";
  const roleLabel = BRIDGE_ROLE_LABEL[bridge.role] || (isChannel ? "CHANNEL" : "BRIDGE");

  return (
    <div
      style={{
        borderRadius: 9,
        border: `1px solid ${border}`,
        background: bg,
        padding: 10,
        marginBottom: 14,
      }}
    >
      <div className="flex items-center gap-1.5" style={{ marginBottom: 4 }}>
        <Merge size={12} style={{ color: accent, flexShrink: 0 }} />
        <span className="text-[9px] font-bold" style={{ color: accent, letterSpacing: ".06em" }}>
          {roleLabel}
        </span>
      </div>
      <div className="text-[12px] font-semibold" style={{ color: "var(--cc-fg)", marginBottom: 2 }}>
        {bridge.peerName || "unknown peer"}
      </div>
      <div className="text-[10px]" style={{ color: "var(--cc-dim)", marginBottom: 8 }}>
        turn {bridge.turn ?? "n/a"} / {bridge.maxTurns ?? "n/a"}
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onOpenTranscript}
          title="Open transcript"
          aria-label="Open transcript"
          className="flex-1 text-[10px] font-semibold rounded transition-colors hover-bg-elevated"
          style={{ height: 22, background: "var(--cc-surface)", border: "1px solid var(--cc-border)", color: "var(--cc-fg)" }}
        >
          Transcript
        </button>
        <button
          type="button"
          onClick={onEndBridge}
          title="End bridge"
          aria-label="End bridge"
          className="flex-1 text-[10px] font-semibold rounded transition-colors hover-bg-elevated"
          style={{ height: 22, background: "var(--cc-surface)", border: `1px solid ${border}`, color: accent }}
        >
          End bridge
        </button>
      </div>
    </div>
  );
}

/**
 * 38px context-usage ring with a percent label, colored by threshold (mirrors
 * TerminalPane's pane-header ring).
 *
 * THREE distinct states, and they must not look alike:
 *   1. `hasTurns === false` — the session has recorded no assistant turn at all,
 *      so its context really is empty. Renders a true 0% plus "no turns yet".
 *      Previously this showed "n/a", which is the same thing a broken lookup
 *      shows: a brand-new session looked identical to a failure.
 *   2. turns exist but no percentage — `context_percent` is SCRAPED from PTY
 *      text (pty_manager's `context\D{0,30}?(\d{1,3})%` regex) and Claude Code
 *      does not routinely print it, so null here is the common case and means
 *      "not measurable", NOT "zero". Rendering 0% would be a fabrication, so it
 *      stays a dash with "not reported by the session".
 *   3. a percentage is known — render it, colored by threshold.
 */
function ContextRing({ contextUsed, contextMax, hasTurns }) {
  const havePct = typeof contextUsed === "number" && typeof contextMax === "number" && contextMax > 0;
  const noTurns = !havePct && hasTurns === false;
  const pct = havePct ? Math.min(100, Math.max(0, (contextUsed / contextMax) * 100)) : noTurns ? 0 : null;
  const color =
    pct === null
      ? "var(--cc-muted)"
      : pct > 75
        ? "var(--cc-error)"
        : pct > 50
          ? "var(--cc-waiting)"
          : "var(--cc-idle)";
  const r = 15;
  const circumference = 2 * Math.PI * r;
  const offset = pct === null ? circumference : circumference - (circumference * pct) / 100;

  return (
    <div className="flex items-center gap-2.5">
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden="true">
        <circle cx="19" cy="19" r={r} fill="none" stroke="var(--cc-border)" strokeWidth="2.5" />
        <circle
          cx="19"
          cy="19"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference.toFixed(1)}
          strokeDashoffset={offset}
          transform="rotate(-90 19 19)"
        />
      </svg>
      <div>
        <div className="text-[13px] font-bold" style={{ color: "var(--cc-fg)" }}>
          {pct === null ? "—" : `${Math.round(pct)}%`} context
        </div>
        <div className="text-[10px]" style={{ color: "var(--cc-dim)" }}>
          {noTurns
            ? "no turns yet"
            : havePct
              ? `${fmtCount(contextUsed)} / ${fmtCount(contextMax)}`
              : "not reported by the session"}
        </div>
      </div>
    </div>
  );
}

function UsageRow({ label, value }) {
  return (
    <div className="flex items-center justify-between text-[10px]" style={{ padding: "3px 0" }}>
      <span style={{ color: "var(--cc-dim)" }}>{label}</span>
      <span style={{ color: "var(--cc-fg)" }}>{value}</span>
    </div>
  );
}

// Backend never emits status: "error" — it emits status: "completed" |
// "in_progress" plus a SEPARATE is_error boolean (see CLAUDE.md's Workflow
// Status Panel section and WorkflowsPanel.jsx). Error color is driven by
// is_error, not by a nonexistent status value.
const WORKFLOW_STATUS_COLOR = {
  in_progress: "var(--cc-accent)",
  completed: "var(--cc-ok)",
};

function WorkflowRow({ item }) {
  const color = item.is_error ? "var(--cc-error)" : WORKFLOW_STATUS_COLOR[item.status] || "var(--cc-muted)";
  return (
    <div className="flex items-center gap-2 text-[11px]" style={{ padding: "4px 0" }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: color,
          flexShrink: 0,
          boxShadow: item.status === "in_progress" ? `0 0 6px ${color}` : "none",
        }}
        aria-hidden="true"
      />
      <span className="truncate" style={{ color: "var(--cc-fg)" }} title={item.name}>
        {item.name}
      </span>
    </div>
  );
}

/**
 * The canonical permission-mode vocabulary, re-keyed `id` → `value` for
 * OverrideSelect.
 *
 * This panel previously kept its own copy, which had drifted: it labelled
 * `acceptEdits` "Auto-edit" and ordered `plan` last, while the other three
 * surfaces said "Accept Edits" with `plan` second. The ids were always the same
 * four, so no session was ever misconfigured — but the same setting answered to
 * two different names depending on which panel you were in. Resolved in favour
 * of the canonical wording; this panel now shows "Accept Edits" and orders
 * `plan` second.
 */
const PERMISSION_OPTIONS = PERMISSION_MODES.map(({ id, label }) => ({ value: id, label }));

/**
 * The canonical effort vocabulary, re-keyed `id` → `value` for OverrideSelect.
 * This copy was already identical to the canonical list, so importing it is a
 * pure de-duplication with no behavioural change.
 *
 * Auto's value is still the empty string, and still load-bearing: pty_manager's
 * _ALLOWED_EFFORT_LEVELS raises ValueError on anything outside
 * {"", "low","medium","high","xhigh","max"}, so an "auto" string would break
 * session creation for the rest of the workspace's life (it survives restart and
 * has no recovery UI). See sessionVocabulary.js for the full note.
 */
const EFFORT_OPTIONS = SHARED_EFFORT_OPTIONS.map(({ id, label }) => ({ value: id, label }));

const FAST_OPTIONS = [
  { value: "off", label: "Fast off" },
  { value: "on", label: "Fast on" },
];

/**
 * Inspector — right-hand 296px panel of the Workspace shell. Follows pane focus:
 * shows session identity, an active bridge/channel card, per-session overrides,
 * usage/cost, in-flight workflow steps, and the primary pane action grid.
 *
 * Purely presentational — all state and side effects are owned by App.jsx.
 */
export default function Inspector({
  session,
  git,
  usage,
  bridge,
  workflows,
  overrides,
  onOverrideChange,
  modelOptions,
  onInterrupt,
  onFork,
  onBridge,
  onPopOut,
  onEndBridge,
  onOpenTranscript,
  onCollapse,
}) {
  const wf = Array.isArray(workflows) ? workflows : [];
  const safeOverrides = overrides || {};
  const safeModelOptions = Array.isArray(modelOptions) && modelOptions.length > 0
    ? modelOptions
    : [{ value: safeOverrides.model || "", label: safeOverrides.model || "default" }];

  return (
    <div
      style={{
        width: 296,
        flexShrink: 0,
        borderLeft: "1px solid var(--cc-border)",
        background: "var(--cc-bg2)",
        display: "flex",
        flexDirection: "column",
        overflowY: "auto",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between"
        style={{ padding: "10px 12px", borderBottom: "1px solid var(--cc-line)", flexShrink: 0 }}
      >
        <div className="flex items-baseline gap-2" style={{ minWidth: 0 }}>
          <span className="text-[10px] font-bold uppercase" style={{ color: "var(--cc-fg)", letterSpacing: ".08em" }}>
            Inspector
          </span>
          <span className="text-[9px]" style={{ color: "var(--cc-muted)" }}>
            follows focus
          </span>
        </div>
        <button
          type="button"
          onClick={onCollapse}
          title="Collapse inspector"
          aria-label="Collapse inspector"
          className="p-1 rounded transition-colors hover-bg-elevated"
          style={{ color: "var(--cc-dim)", background: "none", border: "none" }}
        >
          <PanelLeft size={14} />
        </button>
      </div>

      {session === null ? (
        <div className="text-[11px]" style={{ padding: 14, color: "var(--cc-muted)" }}>
          No session focused.
        </div>
      ) : (
        <div style={{ padding: 12 }}>
          {/* Session identity */}
          <div className="flex items-center gap-1.5" style={{ marginBottom: 6 }}>
            <span
              aria-hidden="true"
              style={{
                width: 7,
                height: 7,
                borderRadius: 999,
                background: getStateColor(session.status),
                boxShadow: `0 0 6px ${getStateColor(session.status)}`,
                flexShrink: 0,
              }}
            />
            <span className="text-[14px] font-bold truncate" style={{ color: "var(--cc-fg)" }} title={session.name}>
              {session.name || "Untitled session"}
            </span>
          </div>
          <div className="flex items-center gap-1 text-[10px]" style={{ color: "var(--cc-dim)", marginBottom: 3 }}>
            <FolderOpen size={11} style={{ flexShrink: 0 }} />
            <span className="truncate" title={session.workdir || ""}>
              {session.workdir || "n/a"}
            </span>
          </div>
          {git && (
            <div className="flex items-center gap-1 text-[10px]" style={{ color: "var(--cc-dim)", marginBottom: 14 }}>
              <GitBranch size={11} style={{ flexShrink: 0 }} />
              <span className="truncate">{git.branch || "n/a"}</span>
              {git.dirty && (
                <span
                  aria-hidden="true"
                  title="Uncommitted changes"
                  style={{ width: 5, height: 5, borderRadius: 999, background: "var(--cc-waiting)", flexShrink: 0 }}
                />
              )}
              {typeof git.changedCount === "number" && (
                <span style={{ color: "var(--cc-muted)" }}>{git.changedCount}</span>
              )}
            </div>
          )}

          {/* `!= null` (loose) on purpose: it catches BOTH null and undefined.
              A strict `!== null` let an OMITTED bridge prop through, and
              BridgeCard then dereferenced `bridge.kind` and crashed the pane. */}
          {bridge != null && (
            <BridgeCard bridge={bridge} onEndBridge={onEndBridge} onOpenTranscript={onOpenTranscript} />
          )}

          {/* This session overrides */}
          <SectionLabel>This session</SectionLabel>
          <div className="grid grid-cols-2 gap-1.5" style={{ marginBottom: 16 }}>
            <OverrideSelect
              label="Model"
              value={safeOverrides.model}
              options={safeModelOptions}
              onChange={(v) => onOverrideChange?.("model", v)}
            />
            <OverrideSelect
              label="Permission mode"
              value={safeOverrides.permissionMode}
              options={PERMISSION_OPTIONS}
              onChange={(v) => onOverrideChange?.("permissionMode", v)}
            />
            <OverrideSelect
              label="Effort"
              value={safeOverrides.effort}
              options={EFFORT_OPTIONS}
              onChange={(v) => onOverrideChange?.("effort", v)}
            />
            <OverrideSelect
              label="Fast mode"
              value={safeOverrides.fast ? "on" : "off"}
              options={FAST_OPTIONS}
              onChange={(v) => onOverrideChange?.("fast", v === "on")}
            />
          </div>

          {/* Usage */}
          <SectionLabel>Usage</SectionLabel>
          <div style={{ marginBottom: 8 }}>
            <ContextRing
              contextUsed={usage?.contextUsed ?? null}
              contextMax={usage?.contextMax ?? null}
              hasTurns={usage?.hasTurns}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <UsageRow label="Input / output" value={`${fmtCount(usage?.inputTokens)} / ${fmtCount(usage?.outputTokens)}`} />
            <UsageRow label="Cache read / write" value={`${fmtCount(usage?.cacheRead)} / ${fmtCount(usage?.cacheWrite)}`} />
            <div className="flex items-center justify-between text-[10px]" style={{ padding: "3px 0" }}>
              <span style={{ color: "var(--cc-dim)" }}>API-equivalent</span>
              <span style={{ color: "var(--cc-fn)" }}>{fmtCost(usage?.costUsd)}</span>
            </div>
          </div>
          {/* "We have no data" and "the data says zero" must not read alike. A
              null `usage` means the per-session lookup produced nothing at all,
              which is a real caveat about the READING — not a claim that the
              session did no work. Rows above already render n/a; this names why. */}
          {!usage && (
            <div
              role="note"
              className="text-[10px]"
              style={{ color: "var(--cc-waiting)", marginTop: -8, marginBottom: 16 }}
            >
              Usage not available for this session yet.
            </div>
          )}
          {usage?.hasTurns === false && (
            <div
              role="note"
              className="text-[10px]"
              style={{ color: "var(--cc-dim)", marginTop: -8, marginBottom: 16 }}
            >
              No assistant turns recorded yet — these totals are genuinely zero, not missing.
            </div>
          )}

          {/* Workflow */}
          {wf.length > 0 && (
            <>
              <SectionLabel>Workflow</SectionLabel>
              <div style={{ marginBottom: 16 }}>
                {wf.map((w) => (
                  <WorkflowRow key={w.tool_id} item={w} />
                ))}
              </div>
            </>
          )}

          {/* Actions */}
          <div className="grid grid-cols-2 gap-1.5">
            <ActionButton icon={OctagonX} label="Interrupt" onClick={onInterrupt} danger />
            <ActionButton icon={GitFork} label="Fork" onClick={onFork} />
            <ActionButton icon={Merge} label="Bridge…" onClick={onBridge} />
            <ActionButton icon={ExternalLink} label="Pop out" onClick={onPopOut} />
          </div>
        </div>
      )}
    </div>
  );
}
