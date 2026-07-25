/**
 * LocalMetricsPanel — the local-lane reporting dashboard.
 *
 * Two layers, provider-agnostic (it reports whatever the selected provider is
 * pushing):
 *   - OVERVIEW (default): at-a-glance insight into local work — a savings hero
 *     (local tokens valued at what an API model would have cost), throughput,
 *     request count, queue depth + ETA, session count, and which sessions spawn
 *     the most. This is the "what are we pushing locally" view.
 *   - API DETAIL (tab): the raw, de-noised ledger — by-session / by-agent /
 *     by-lane-class breakdowns + run-time distribution + verbatim broker
 *     definitions. The "lower layer" for when you want the wire truth.
 *
 * All numbers come from GET /api/local/metrics (+ /queue for live depth/ETA);
 * savings is computed here from token totals × reference-model API pricing.
 *
 * Props:
 *   metrics   — GET /api/local/metrics result, or null when offline/loading
 *   queue     — GET /api/local/queue result, or null (live depth + ETA)
 *   window    — "lifetime" | "24h" | "session"
 *   setWindow — (w:string) => void
 */
import { useState } from "react";

const WINDOWS = [
  { id: "lifetime", label: "Lifetime" },
  { id: "24h", label: "24h" },
  { id: "session", label: "Session" },
];

// Reference API models the local tokens are valued against, $/1M tokens
// (verified pricing, claude-api skill). Savings = "what you'd have paid if this
// had gone to the API instead of the local lane."
const REFERENCE_MODELS = [
  { id: "sonnet", label: "Sonnet 5", input: 3, output: 15 },
  { id: "opus", label: "Opus 5", input: 5, output: 25 },
  { id: "haiku", label: "Haiku 4.5", input: 1, output: 5 },
];

// Broker-team definitional contract — rendered verbatim in the detail tab.
const DEFINITIONS = [
  { term: "run", def: "one completion call to a lane (one jobs.jsonl record)" },
  { term: "prompt", def: "one client dispatch identified by distinct X-Trace-Id (untagged runs count as one prompt each, so runs==prompts for untagged clients)" },
  { term: "session", def: "X-Client-Id" },
  { term: "agent", def: "X-Agent-Id" },
  { term: "tokens/sec", def: "completion tokens ÷ wall clock (includes prompt-processing) — a floor on true decode speed, not LM Studio's stats number" },
];

function fmtInt(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toLocaleString();
}
function fmtTokens(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}
function fmtMs(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  return Math.round(n) + "ms";
}
function fmtNum(n, digits = 1) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  return n.toFixed(digits);
}
function fmtUsd(n) {
  if (typeof n !== "number" || !isFinite(n)) return "$0.00";
  if (n >= 1000) return "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toFixed(4);
}
function fmtEta(seconds) {
  if (typeof seconds !== "number" || !isFinite(seconds) || seconds <= 0) return "clear";
  if (seconds >= 60) return `~${Math.round(seconds / 60)}m to clear`;
  return `~${Math.round(seconds)}s to clear`;
}

const rowTokens = (r) => {
  const t = r?.tokens_total || {};
  return (t.prompt || 0) + (t.completion || 0);
};

/** Live queue depth = in-flight (0/1) + queued length (pinned broker fields). */
function queueDepth(q) {
  if (!q || q.reachable === false) return 0;
  return (q.in_flight ? 1 : 0) + (Array.isArray(q.queued) ? q.queued.length : 0);
}

// ── Overview building blocks ─────────────────────────────

function Stat({ label, value, sub, accent }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-color)",
        borderRadius: 10,
        padding: "10px 12px",
        background: "var(--bg-surface)",
        minWidth: 0,
      }}
    >
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 700, color: accent || "var(--text-primary)", marginTop: 3, lineHeight: 1.1 }}>
        {value}
      </div>
      {sub != null && <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function SavingsHero({ tokTot, refModel, setRefModel }) {
  const promptTok = tokTot.prompt || 0;
  const completionTok = tokTot.completion || 0;
  const totalTok = promptTok + completionTok;
  const saved = (promptTok / 1e6) * refModel.input + (completionTok / 1e6) * refModel.output;
  return (
    <div
      style={{
        border: "1px solid var(--border-color)",
        borderRadius: 12,
        padding: "14px 16px",
        background: "var(--bg-surface)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "space-between",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
          Saved vs API
        </div>
        {/* Hero figure — the one big number the view leads with. */}
        <div style={{ fontSize: 48, fontWeight: 800, color: "var(--green, #46a758)", lineHeight: 1.05, marginTop: 2 }}>
          {fmtUsd(saved)}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 4 }}>
          {fmtTokens(totalTok)} tokens run locally — what they'd have cost on{" "}
          <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{refModel.label}</span>.
          Local tokens are free.
        </div>
      </div>
      <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
        {REFERENCE_MODELS.map((m) => (
          <button
            key={m.id}
            onClick={() => setRefModel(m)}
            className="text-[10px] px-2 py-0.5 rounded-full transition-colors"
            style={{
              color: m.id === refModel.id ? "var(--accent)" : "var(--text-secondary)",
              border: `1px solid ${m.id === refModel.id ? "var(--accent)" : "var(--border-color)"}`,
              background: "var(--bg-elevated)",
              fontWeight: m.id === refModel.id ? 600 : 400,
            }}
            aria-pressed={m.id === refModel.id}
            title={`Value local tokens at ${m.label} API rates ($${m.input}/$${m.output} per 1M)`}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function TopSessions({ rows }) {
  // "Which session spawns the most" — rank by prompts (queries), single-series
  // magnitude bars in the accent hue, value at the tip.
  const ranked = [...(rows || [])]
    .sort((a, b) => (b.prompts_total || 0) - (a.prompts_total || 0) || rowTokens(b) - rowTokens(a))
    .slice(0, 5);
  if (ranked.length === 0) return null;
  const max = Math.max(...ranked.map((r) => r.prompts_total || 0), 1);
  return (
    <div style={{ marginTop: 12 }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
        Busiest sessions (by queries)
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ranked.map((r) => {
          const q = r.prompts_total || 0;
          const pct = Math.max(4, (q / max) * 100);
          return (
            <div key={r.key ?? r.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div
                title={String(r.key ?? r.id)}
                style={{
                  width: 130,
                  flexShrink: 0,
                  fontSize: 11,
                  color: "var(--text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {String(r.key ?? r.id)}
              </div>
              <div style={{ flex: 1, minWidth: 0, height: 14, position: "relative" }}>
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    background: "var(--accent)",
                    borderRadius: "3px 4px 4px 3px",
                    opacity: 0.85,
                  }}
                />
              </div>
              <div style={{ width: 78, flexShrink: 0, textAlign: "right", fontSize: 11, color: "var(--text-primary)", fontVariantNumeric: "tabular-nums" }}>
                {fmtInt(q)}q · {fmtTokens(rowTokens(r))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── API-detail (lower-layer) breakdown table ─────────────

const BREAKDOWN_CAP = 8;

function Breakdown({ title, rows, keyLabel }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const ranked = [...rows].sort(
    (a, b) => rowTokens(b) - rowTokens(a) || (b.runs_total || 0) - (a.runs_total || 0),
  );
  const shown = ranked.slice(0, BREAKDOWN_CAP);
  const hidden = ranked.length - shown.length;
  return (
    <div style={{ marginTop: 10 }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 4 }}>
        {title}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "right" }}>
              <th style={{ textAlign: "left", padding: "2px 6px 2px 0", fontWeight: 500 }}>{keyLabel}</th>
              <th style={{ padding: "2px 6px", fontWeight: 500 }}>runs</th>
              <th style={{ padding: "2px 6px", fontWeight: 500 }}>prompts</th>
              <th style={{ padding: "2px 0 2px 6px", fontWeight: 500 }}>tokens</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => {
              const key = r.key ?? r.id ?? r.name ?? `#${i + 1}`;
              return (
                <tr key={key} style={{ color: "var(--text-secondary)", textAlign: "right" }}>
                  <td
                    style={{
                      textAlign: "left", padding: "2px 6px 2px 0", color: "var(--text-primary)",
                      maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}
                    title={String(key)}
                  >
                    {String(key)}
                  </td>
                  <td style={{ padding: "2px 6px", fontVariantNumeric: "tabular-nums" }}>{fmtInt(r.runs_total)}</td>
                  <td style={{ padding: "2px 6px", fontVariantNumeric: "tabular-nums" }}>{fmtInt(r.prompts_total)}</td>
                  <td style={{ padding: "2px 0 2px 6px", fontVariantNumeric: "tabular-nums" }}>{fmtTokens(rowTokens(r))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {hidden > 0 && (
        <div className="text-[10px]" style={{ color: "var(--text-muted)", marginTop: 3 }}>
          +{hidden} more (lower token counts — likely probes)
        </div>
      )}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────

export default function LocalMetricsPanel({ metrics, queue, window, setWindow }) {
  const [tab, setTab] = useState("overview");
  const [refModel, setRefModel] = useState(REFERENCE_MODELS[0]);
  const offline = !metrics || metrics.reachable === false;

  const runs = metrics?.runs_total;
  const prompts = metrics?.prompts_total;
  const tokTot = metrics?.tokens_total || {};
  const totalTokens = (tokTot.prompt || 0) + (tokTot.completion || 0);
  const tps = metrics?.tokens_per_sec || {};
  const rt = metrics?.run_time_ms || {};
  const bySession = metrics?.by_session || [];

  // "Real" work = token-bearing sessions/runs; the rest is probe/health noise.
  const realSessions = bySession.filter((r) => rowTokens(r) > 0);
  const realRuns = realSessions.reduce((n, r) => n + (r.runs_total || 0), 0);
  const realQueries = realSessions.reduce((n, r) => n + (r.prompts_total || 0), 0);
  const qPerSession = realSessions.length > 0 ? realQueries / realSessions.length : 0;
  const depth = queueDepth(queue);
  const eta = queue?.estimated_clear_seconds;

  return (
    <div style={{ padding: "10px 12px" }}>
      {/* Window + layer tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
        {WINDOWS.map((w) => (
          <button
            key={w.id}
            onClick={() => setWindow(w.id)}
            className="text-[11px] px-2 py-0.5 rounded-full transition-colors"
            style={{
              color: w.id === window ? "var(--accent)" : "var(--text-secondary)",
              border: `1px solid ${w.id === window ? "var(--accent)" : "var(--border-color)"}`,
              background: "var(--bg-surface)",
              fontWeight: w.id === window ? 600 : 400,
            }}
            aria-pressed={w.id === window}
          >
            {w.label}
          </button>
        ))}
        <div style={{ width: 1, height: 16, background: "var(--border-color)", margin: "0 4px" }} />
        {[{ id: "overview", label: "Overview" }, { id: "detail", label: "API detail" }].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="text-[11px] px-2 py-0.5 rounded-full transition-colors"
            style={{
              color: t.id === tab ? "var(--accent)" : "var(--text-secondary)",
              border: `1px solid ${t.id === tab ? "var(--accent)" : "var(--border-color)"}`,
              background: "var(--bg-surface)",
              fontWeight: t.id === tab ? 600 : 400,
            }}
            aria-pressed={t.id === tab}
          >
            {t.label}
          </button>
        ))}
        {metrics?.persisted != null && (
          <span
            style={{ marginLeft: "auto", alignSelf: "center", fontSize: 10, color: "var(--text-muted)" }}
            title={metrics.persisted ? "Recomputed from jobs.jsonl — survives broker restart" : "Since broker start — resets on broker restart"}
          >
            {metrics.persisted ? "persisted" : "since broker start"}
          </span>
        )}
      </div>

      {offline ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          Broker offline — no metrics for this window.
        </div>
      ) : tab === "overview" ? (
        <>
          <SavingsHero tokTot={tokTot} refModel={refModel} setRefModel={setRefModel} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 10 }}>
            <Stat
              label="Throughput"
              value={`${fmtNum(tps.current, 0)} tok/s`}
              sub={`avg ${fmtNum(tps.avg, 1)} · ${fmtTokens(totalTokens)} total`}
            />
            <Stat
              label="Requests"
              value={fmtInt(realRuns)}
              sub={typeof runs === "number" && runs > realRuns ? `${fmtInt(runs)} incl. probes` : "real, token-bearing"}
            />
            <Stat
              label="Queue"
              value={depth === 0 ? "idle" : `${depth} deep`}
              sub={depth === 0 ? "nothing queued" : fmtEta(eta)}
              accent={depth > 0 ? "var(--accent)" : undefined}
            />
            <Stat
              label="Sessions"
              value={fmtInt(realSessions.length)}
              sub={realSessions.length > 0 ? `${fmtNum(qPerSession, 1)} queries/session` : "no local sessions yet"}
            />
          </div>

          <TopSessions rows={realSessions} />

          {typeof runs === "number" && runs > 0 && totalTokens === 0 && (
            <div className="text-[11px]" style={{ color: "var(--text-muted)", marginTop: 10, lineHeight: 1.5 }}>
              Runs happened but no tokens were reported — streaming clients must send
              <code style={{ color: "var(--text-secondary)" }}> stream_options.include_usage</code> for the broker to see usage.
            </div>
          )}
        </>
      ) : (
        <>
          {/* API DETAIL — the raw, de-noised ledger. */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <Stat label="Runs" value={fmtInt(runs)} sub={runs > realRuns ? `${fmtInt(realRuns)} token-bearing` : null} />
            <Stat label="Prompts" value={fmtInt(prompts)} />
          </div>
          <div style={{ marginTop: 8 }}>
            <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 4 }}>
              Run time per prompt
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-secondary)", gap: 6 }}>
              <span>min {fmtMs(rt.min)}</span>
              <span>avg {fmtMs(rt.avg)}</span>
              <span>p50 {fmtMs(rt.p50)}</span>
              <span>p95 {fmtMs(rt.p95)}</span>
              <span>max {fmtMs(rt.max)}</span>
            </div>
          </div>

          <Breakdown title="By session" rows={metrics?.by_session} keyLabel="session" />
          <Breakdown title="By agent" rows={metrics?.by_agent} keyLabel="agent" />
          <Breakdown title="By lane class" rows={metrics?.by_lane_class} keyLabel="lane" />

          <details style={{ marginTop: 10 }}>
            <summary className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", cursor: "pointer" }}>
              What these words mean
            </summary>
            <dl style={{ margin: "8px 0 0" }}>
              {DEFINITIONS.map((d) => (
                <div key={d.term} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "baseline" }}>
                  <dt style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)", minWidth: 68, flexShrink: 0, textAlign: "right" }}>
                    {d.term}
                  </dt>
                  <dd style={{ fontSize: 11, color: "var(--text-secondary)", margin: 0, lineHeight: 1.45 }}>
                    {d.def}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </>
      )}
    </div>
  );
}
