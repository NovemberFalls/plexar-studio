/**
 * FleetView — full-screen overlay showing all sessions at once with live usage stats.
 *
 * Pure presentational component; all data is supplied via props (no fetching here).
 *
 * Props:
 *   sessions            — array of session objects ({ id, terminalId, name, model, status, activityState, ... })
 *   usageByTerminal      — object keyed by terminalId -> usage summary (see usage_tracker.session_summary + tokensPerSec + effort)
 *   dailyUsage           — { day, est_cost_usd, by_model: { model: { est_cost_usd, input_tokens, output_tokens } }, ... }
 *   workflowsByTerminal  — object keyed by terminalId -> { count, inProgressCount, ... }
 *   onClose              — () => void
 */

import { X, LayoutGrid, Zap, GitBranch } from "lucide-react";

const MAX_SESSIONS = 8;

// Model-tint sequence used for the spend-by-model stacked bar + legend swatches.
const MODEL_TINTS = [
  "var(--cc-working, var(--accent))",
  "var(--cc-idle, #5bbf9f)",
  "var(--cc-waiting, #e0b060)",
  "var(--cc-thinking, #7cc7ff)",
  "var(--cc-error, #e0698a)",
  "var(--cc-macro, #c497d6)",
];

/** Format a token count compactly: 1.2M / 45.3k / 812 */
function fmtTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return `${num}`;
}

function fmtCost(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "$0.00";
  return `$${num.toFixed(2)}`;
}

/** Format a token count with thousands separators (used in the summary row to
 * avoid colliding with the compact per-card token text in queries/snapshots). */
function fmtTokensFull(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("en-US");
}

/** Map an activityState/status value to the shared focus-glow state vocabulary. */
function mapState(state) {
  switch (state) {
    case "busy":
      return "working";
    case "working":
    case "thinking":
    case "waiting":
    case "error":
      return state;
    default:
      return "idle";
  }
}

const STATE_LABEL = {
  working: "WORKING",
  thinking: "THINKING",
  waiting: "WAITING",
  idle: "IDLE",
  error: "ERROR",
};

const STATE_COLOR_VAR = {
  working: "var(--cc-working, var(--accent))",
  thinking: "var(--cc-thinking, #7cc7ff)",
  waiting: "var(--cc-waiting, #e0b060)",
  idle: "var(--cc-idle, #5bbf9f)",
  error: "var(--cc-error, #e0698a)",
};

function SummaryCard({ label, value, valueColor, sub, subColor, children }) {
  return (
    <div
      className="cc-card flex flex-col"
      style={{
        borderRadius: 12,
        background: "var(--cc-surface, var(--bg-elevated))",
        border: "1px solid var(--cc-border, var(--border-color))",
        padding: "14px 16px",
        gap: 6,
      }}
    >
      <span
        className="cc-label"
        style={{ color: "var(--cc-muted, var(--text-muted))" }}
      >
        {label}
      </span>
      {value != null && (
        <span
          style={{
            fontSize: 26,
            fontWeight: 800,
            letterSpacing: "-.01em",
            color: valueColor || "var(--cc-fg, var(--text-primary))",
            lineHeight: 1,
          }}
        >
          {value}
        </span>
      )}
      {children}
      {sub && (
        <span style={{ fontSize: 10, color: subColor || "var(--cc-muted, var(--text-muted))" }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function SpendByModelCard({ byModel }) {
  const entries = Object.entries(byModel || {});
  const total = entries.reduce((sum, [, stats]) => sum + (Number(stats?.est_cost_usd) || 0), 0);

  return (
    <div
      className="cc-card flex flex-col"
      style={{
        borderRadius: 12,
        background: "var(--cc-surface, var(--bg-elevated))",
        border: "1px solid var(--cc-border, var(--border-color))",
        padding: "14px 16px",
        gap: 9,
      }}
    >
      <span className="cc-label" style={{ color: "var(--cc-muted, var(--text-muted))" }}>
        Spend by model
      </span>
      {entries.length === 0 ? (
        <div className="text-xs py-2" style={{ color: "var(--cc-muted, var(--text-muted))" }}>
          No usage recorded today.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              height: 10,
              borderRadius: 999,
              overflow: "hidden",
              gap: 2,
              background: "var(--cc-term, var(--bg-surface))",
            }}
          >
            {entries.map(([model, stats], i) => {
              const cost = Number(stats?.est_cost_usd) || 0;
              const pct = total > 0 ? (cost / total) * 100 : 0;
              return (
                <div
                  key={model}
                  title={`${model}: ${fmtCost(cost)}`}
                  style={{
                    width: `${pct}%`,
                    background: MODEL_TINTS[i % MODEL_TINTS.length],
                    borderRadius: 999,
                  }}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap" style={{ gap: 14 }}>
            {entries.map(([model, stats], i) => (
              <span
                key={model}
                className="flex items-center"
                style={{ gap: 5, fontSize: 10, color: "var(--cc-dim, var(--text-secondary))" }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: MODEL_TINTS[i % MODEL_TINTS.length],
                  }}
                />
                {model}{" "}
                <span style={{ color: "var(--cc-fg, var(--text-primary))", fontWeight: 600 }}>
                  {fmtCost(stats?.est_cost_usd)}
                </span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ContextRing({ percent }) {
  const r = 7;
  const circumference = 2 * Math.PI * r;
  const dash = circumference * (1 - Math.min(100, Math.max(0, percent)) / 100);
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="2.5" />
      <circle
        cx="10"
        cy="10"
        r={r}
        fill="none"
        stroke="var(--cc-idle, #5bbf9f)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference.toFixed(1)}
        strokeDashoffset={dash.toFixed(1)}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

function SessionCard({ session, usage, workflowSummary }) {
  const rawState = session.activityState || session.status || "idle";
  const state = mapState(rawState);
  const glowable = state === "working" || state === "thinking" || state === "waiting";
  const stateColor = STATE_COLOR_VAR[state] || STATE_COLOR_VAR.idle;

  const totalTokens = usage?.total_tokens ?? 0;
  const estCost = usage?.est_cost_usd ?? 0;
  const tokensPerSec = usage?.tokensPerSec ?? 0;
  const effort = usage?.effort;
  const inProgressCount = workflowSummary?.inProgressCount ?? workflowSummary?.count ?? 0;
  const contextPercent =
    usage?.context_percent ?? usage?.contextPercent ?? session?.context_percent ?? null;

  return (
    <div
      data-glowable={glowable ? "" : undefined}
      data-state={glowable ? state : undefined}
      className="cc-card flex flex-col"
      style={{
        borderRadius: 12,
        background: "var(--cc-surface, var(--bg-elevated))",
        border: `1px solid ${
          glowable ? `color-mix(in srgb, ${stateColor} 35%, transparent)` : "var(--cc-border, var(--border-color))"
        }`,
        padding: 14,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
        <div className="flex items-center" style={{ gap: 7, minWidth: 0 }}>
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: stateColor,
              boxShadow: `0 0 7px ${stateColor}`,
              flexShrink: 0,
            }}
          />
          <span
            className="truncate"
            style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg, var(--text-primary))" }}
            title={session.name}
          >
            {session.name || "Untitled session"}
          </span>
        </div>
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: ".04em",
            color: stateColor,
            background: `color-mix(in srgb, ${stateColor} 15%, transparent)`,
            borderRadius: 4,
            padding: "2px 6px",
            flexShrink: 0,
          }}
        >
          {STATE_LABEL[state]}
        </span>
      </div>

      <div className="flex items-end justify-between" style={{ marginBottom: 10, gap: 8 }}>
        <div className="flex flex-col" style={{ gap: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: 24,
              fontWeight: 800,
              letterSpacing: "-.02em",
              lineHeight: 1,
              color: "var(--cc-fg, var(--text-primary))",
            }}
          >
            {fmtCost(estCost)}
          </span>
          <span style={{ fontSize: 10, color: "var(--cc-muted, var(--text-muted))" }}>
            {fmtTokens(totalTokens)} tokens
          </span>
        </div>
        {session.model && (
          <span
            className="truncate"
            style={{
              fontSize: 10,
              color: "var(--cc-muted, var(--text-muted))",
              border: "1px solid var(--cc-border, var(--border-color))",
              borderRadius: 5,
              padding: "2px 7px",
              flexShrink: 0,
            }}
          >
            {session.model}
          </span>
        )}
      </div>

      {effort && (
        <div style={{ marginBottom: 8 }}>
          <span
            className="text-[10px]"
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              backgroundColor: "var(--cc-term, var(--bg-surface))",
              color: "var(--cc-dim, var(--text-secondary))",
              border: "1px solid var(--cc-border, var(--border-color))",
            }}
          >
            {effort}
          </span>
        </div>
      )}

      <div className="flex items-center" style={{ gap: 12, marginTop: "auto" }}>
        {tokensPerSec > 0 && (
          <span
            className="flex items-center"
            style={{ gap: 4, fontSize: 11, color: "var(--cc-fn, var(--accent))", fontWeight: 600 }}
          >
            <Zap size={11} />
            {tokensPerSec} t/s
          </span>
        )}
        {contextPercent != null && (
          <span className="flex items-center" style={{ gap: 5 }}>
            <ContextRing percent={contextPercent} />
            <span style={{ fontSize: 11, color: "var(--cc-dim, var(--text-secondary))" }}>
              {contextPercent}% ctx
            </span>
          </span>
        )}
        {inProgressCount > 0 && (
          <span
            className="flex items-center"
            style={{ gap: 4, fontSize: 11, color: "var(--cc-dim, var(--text-secondary))" }}
          >
            <GitBranch size={11} />
            {inProgressCount}
          </span>
        )}
      </div>

      {contextPercent != null && (
        <div
          style={{
            height: 3,
            borderRadius: 999,
            background: "var(--cc-term, var(--bg-surface))",
            marginTop: 12,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.min(100, Math.max(0, contextPercent))}%`,
              background: stateColor,
              borderRadius: 999,
            }}
          />
        </div>
      )}
    </div>
  );
}

export default function FleetView({
  sessions,
  usageByTerminal,
  dailyUsage,
  workflowsByTerminal,
  onClose,
}) {
  const safeSessions = Array.isArray(sessions) ? sessions : [];
  const safeUsageByTerminal = usageByTerminal || {};
  const safeWorkflowsByTerminal = workflowsByTerminal || {};
  const todayCost = dailyUsage?.est_cost_usd;

  // ---- summary metrics (derived, no new fetching) ----
  const usageEntries = Object.values(safeUsageByTerminal);
  const totalTokens = usageEntries.reduce((sum, u) => sum + (Number(u?.total_tokens) || 0), 0);
  const totalThroughput = usageEntries.reduce((sum, u) => sum + (Number(u?.tokensPerSec) || 0), 0);

  const byModelEntries = Object.entries(dailyUsage?.by_model || {});
  const totalInTokens = byModelEntries.reduce((sum, [, s]) => sum + (Number(s?.input_tokens) || 0), 0);
  const totalOutTokens = byModelEntries.reduce((sum, [, s]) => sum + (Number(s?.output_tokens) || 0), 0);

  const stateCounts = safeSessions.reduce((acc, s) => {
    const state = mapState(s.activityState || s.status || "idle");
    acc[state] = (acc[state] || 0) + 1;
    return acc;
  }, {});
  const activeCount =
    (stateCounts.working || 0) + (stateCounts.thinking || 0) + (stateCounts.waiting || 0);
  const activeBreakdown = ["working", "thinking", "waiting"]
    .filter((k) => stateCounts[k])
    .map((k) => `${stateCounts[k]} ${k}`)
    .join(" · ");

  return (
    <div
      role="region"
      aria-label="Fleet view"
      className="flex-1 min-w-0"
      style={{
        // In-area view: fills the terminal region only — rail/sidebar/top bar
        // stay visible, so the rail icon is the natural way in and out.
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        backgroundColor: "var(--cc-bg, var(--bg-primary))",
        color: "var(--cc-fg, var(--text-primary))",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 22px",
          height: 56,
          flexShrink: 0,
          borderBottom: "1px solid var(--cc-border, var(--border-color))",
        }}
      >
        <div className="flex items-center" style={{ gap: 11 }}>
          <div
            className="flex items-center justify-center"
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: "color-mix(in srgb, var(--cc-accent, var(--accent)) 15%, transparent)",
              border: "1px solid color-mix(in srgb, var(--cc-accent, var(--accent)) 35%, transparent)",
              color: "var(--cc-accent, var(--accent))",
            }}
          >
            <LayoutGrid size={16} />
          </div>
          <div className="flex flex-col" style={{ lineHeight: 1.15 }}>
            <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: ".02em" }}>Fleet</span>
            <span style={{ fontSize: 11, color: "var(--cc-muted, var(--text-muted))" }}>
              Today: {fmtCost(todayCost)}
            </span>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close fleet view"
          className="hover-bg-surface flex items-center justify-center"
          style={{
            gap: 7,
            height: 34,
            padding: "0 14px",
            borderRadius: 9,
            fontSize: 12,
            fontWeight: 600,
            color: "var(--cc-dim, var(--text-secondary))",
            background: "var(--cc-elev, var(--bg-surface))",
            border: "1px solid var(--cc-border, var(--border-color))",
            cursor: "pointer",
          }}
        >
          <X size={14} style={{ marginRight: 6 }} />
          Close
        </button>
      </div>

      {/* Body */}
      <div
        className="flex flex-col"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 22px", gap: 18 }}
      >
        {/* Summary row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, 1fr) 1.6fr",
            gap: 14,
            flexShrink: 0,
          }}
        >
          <SummaryCard label="Spend today" value={fmtCost(todayCost)} />
          <SummaryCard
            label="Tokens"
            value={fmtTokensFull(totalTokens || totalInTokens + totalOutTokens)}
            sub={
              totalInTokens || totalOutTokens
                ? `${fmtTokens(totalInTokens)} in · ${fmtTokens(totalOutTokens)} out`
                : undefined
            }
          />
          <SummaryCard
            label="Active"
            value={
              <>
                {activeCount}
                <span style={{ fontSize: 15, color: "var(--cc-muted, var(--text-muted))", fontWeight: 600 }}>
                  {" "}
                  / {MAX_SESSIONS}
                </span>
              </>
            }
            valueColor="var(--cc-fg, var(--text-primary))"
            sub={activeBreakdown || undefined}
            subColor="var(--cc-working, var(--accent))"
          />
          <SummaryCard
            label="Throughput"
            value={
              <>
                {totalThroughput}
                <span style={{ fontSize: 14, color: "var(--cc-muted, var(--text-muted))", fontWeight: 600 }}>
                  {" "}
                  t/s
                </span>
              </>
            }
            valueColor="var(--cc-fn, #ffc66d)"
            sub="summed output rate"
          />
          <SpendByModelCard byModel={dailyUsage?.by_model} />
        </div>

        {/* Session grid */}
        {safeSessions.length === 0 ? (
          <div className="text-xs" style={{ color: "var(--cc-muted, var(--text-muted))" }}>
            No sessions yet.
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              minHeight: 0,
              display: "grid",
              gridTemplateColumns: "repeat(4, minmax(200px, 1fr))",
              gridAutoRows: "minmax(150px, 1fr)",
              gap: 14,
            }}
          >
            {safeSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                usage={session.terminalId != null ? safeUsageByTerminal[session.terminalId] : undefined}
                workflowSummary={
                  session.terminalId != null ? safeWorkflowsByTerminal[session.terminalId] : undefined
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
