/**
 * PerModelAgent — "Per model" / "Per agent · seat & backend mix" (design
 * handoff §9). Two-up grid: left is a per-model table sorted by tokens
 * descending (cap 8, "+N more" footer, mirroring LocalMetricsPanel.jsx's
 * BREAKDOWN_CAP); right is per-agent rows with a derived "seat" badge and a
 * backend-mix bar.
 *
 * Seat derivation (documented per the handoff — "an unexplained taxonomy is
 * worse than none"): priority order per agent row is (1) an explicit
 * `row.seat` if the broker ever attaches one (future X-Seat header support),
 * (2) lane class `batch` -> seat `batch`, (3) an embeddings endpoint shape
 * (`row.endpoint` containing "embed") -> seat `embedding`, (4) `agent loop`
 * when the row's runs carry a `trace_parent` (child of an orchestrating
 * trace), else `context window` when they are trace roots. None of today's
 * broker breakdown rows carry trace_parent/endpoint/class per agent, so in
 * practice this currently falls through to `context window` until the
 * broker adds that attribution — it never falls back to guessing from the
 * agent's name.
 */
import { useState } from "react";
import { fmtInt, fmtTokens, fmtUsd, seriesColor } from "./format";

const CAP = 8;
const REPO_CAP = 5;

// Badge color per provider — anthropic/openrouter/local. "anthropic" is a
// reserved series color (see format.js); openrouter/local cycle by fixed
// index so they stay visually distinct and stable across renders.
const PROVIDER_COLOR = {
  anthropic: seriesColor("anthropic"),
  openrouter: seriesColor("openrouter", 0),
  local: seriesColor("local", 1),
};

function providerColor(provider) {
  return PROVIDER_COLOR[provider] || seriesColor(provider, 2);
}

// tokens:null means "not reported" (streaming client didn't send usage), NOT
// zero — never collapse the two per the reporting-honesty convention.
function fmtTokensReport(n) {
  return n == null ? "not reported" : fmtTokens(n);
}

// cost_usd:null means "not applicable/unknown" (e.g. local models), NOT free
// — never render "$0.00" for a null cost.
function fmtCostReport(n) {
  return n == null ? "n/a" : fmtUsd(n);
}

function rowKey(row, i) {
  return `${row.provider || "?"}:${row.provider_id || ""}:${row.model || i}`;
}

function UnifiedModelTable({ report }) {
  const [expanded, setExpanded] = useState({});
  const rows = Array.isArray(report?.models) ? report.models : [];
  const shown = rows.slice(0, CAP);
  const extra = rows.length - shown.length;
  const cols = "minmax(0,1.7fr) 88px 55px 74px 68px 16px";

  const toggle = (key) => setExpanded((e) => ({ ...e, [key]: !e[key] }));

  return (
    <div style={{ border: "1px solid var(--cc-border)", borderRadius: 12, background: "var(--cc-surface)", overflow: "hidden" }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
        }}
      >
        <span className="text-[11px] uppercase" style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)" }}>
          Per model
        </span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
          {report?.totals?.runs != null ? `${fmtInt(report.totals.runs)} runs total` : "unified · anthropic + openrouter + local"}
        </span>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: cols,
          padding: "7px 16px",
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--cc-muted)",
          borderBottom: "1px solid var(--cc-line)",
        }}
      >
        <span>model</span>
        <span>provider</span>
        <span style={{ textAlign: "right" }}>runs</span>
        <span style={{ textAlign: "right" }}>tokens</span>
        <span style={{ textAlign: "right" }}>cost</span>
        <span />
      </div>

      {shown.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "12px 16px" }}>
          No model activity for this window.
        </div>
      ) : (
        shown.map((row, i) => {
          const key = rowKey(row, i);
          const isOpen = !!expanded[key];
          const byRepo = Array.isArray(row.by_repo) ? row.by_repo : [];
          const repoShown = byRepo.slice(0, REPO_CAP);
          const repoExtra = byRepo.length - repoShown.length;
          const color = providerColor(row.provider);
          return (
            <div key={key} style={{ borderBottom: "1px solid color-mix(in srgb, var(--cc-fg) 4.5%, transparent)" }}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => toggle(key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle(key);
                  }
                }}
                className="hover-bg-surface"
                style={{
                  display: "grid",
                  gridTemplateColumns: cols,
                  alignItems: "center",
                  padding: "9px 16px",
                  fontSize: 11.5,
                  cursor: "pointer",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <span style={{ width: 7, height: 7, borderRadius: 999, background: color, flexShrink: 0 }} />
                  <span style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 11.5,
                        fontWeight: 600,
                        color: "var(--cc-fg)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {row.model || "(untagged)"}
                    </div>
                    <div style={{ fontSize: 9.5, color: "var(--cc-muted)" }}>{row.family || "Other"}</div>
                  </span>
                </span>
                <span
                  className="tabular-nums"
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: ".04em",
                    textTransform: "uppercase",
                    color,
                    justifySelf: "start",
                    padding: "1px 6px",
                    borderRadius: 3,
                    background: "var(--cc-elev)",
                    border: "1px solid var(--cc-border)",
                  }}
                >
                  {row.provider || "unknown"}
                </span>
                <span className="tabular-nums" style={{ textAlign: "right", color: "var(--cc-dim)" }}>{fmtInt(row.runs)}</span>
                <span className="tabular-nums" style={{ textAlign: "right", color: "var(--cc-dim)" }}>{fmtTokensReport(row.tokens)}</span>
                <span className="tabular-nums" style={{ textAlign: "right", fontWeight: 700, color: "var(--cc-fg)" }}>
                  {fmtCostReport(row.cost_usd)}
                </span>
                <span style={{ textAlign: "right", color: "var(--cc-muted)", fontSize: 10 }}>{isOpen ? "▾" : "▸"}</span>
              </div>

              {isOpen && (
                <div style={{ padding: "0 16px 10px 33px" }}>
                  {repoShown.length === 0 ? (
                    <div style={{ fontSize: 10.5, color: "var(--cc-muted)", padding: "4px 0" }}>No per-repo attribution.</div>
                  ) : (
                    repoShown.map((r, ri) => (
                      <div
                        key={r.repo || ri}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          fontSize: 10.5,
                          padding: "3px 0",
                          color: "var(--cc-dim)",
                        }}
                        className="tabular-nums"
                      >
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                          {r.repo || "(unknown repo)"}
                        </span>
                        <span style={{ flexShrink: 0, marginLeft: 10 }}>
                          {fmtInt(r.runs)} runs · {fmtTokensReport(r.tokens)}
                        </span>
                      </div>
                    ))
                  )}
                  {repoExtra > 0 && (
                    <div style={{ fontSize: 10, color: "var(--cc-muted)", padding: "3px 0" }}>+{repoExtra} more repos</div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      {extra > 0 && (
        <div style={{ padding: "8px 16px", fontSize: 10.5, color: "var(--cc-muted)" }}>+{extra} more</div>
      )}
    </div>
  );
}

const SEAT_META = {
  "context window": { color: "var(--cc-thinking)" },
  "agent loop": { color: "var(--cc-type)" },
  batch: { color: "var(--cc-waiting)" },
  embedding: { color: "var(--cc-macro)" },
};

function deriveSeat(row) {
  if (row.seat) return row.seat;
  if (row.class === "batch" || row.lane_class === "batch") return "batch";
  if (typeof row.endpoint === "string" && row.endpoint.toLowerCase().includes("embed")) return "embedding";
  if (row.trace_parent) return "agent loop";
  return "context window";
}

function BackendMixBar({ mix }) {
  const segs = [
    { key: "lm", color: "var(--cc-accent)" },
    { key: "vllm", color: "var(--cc-type)" },
    { key: "spilled", color: "var(--cc-waiting)" },
    { key: "api", color: "var(--cc-macro)" },
  ];
  const total = segs.reduce((sum, s) => sum + (mix?.[s.key] || 0), 0);
  return (
    <div
      style={{
        display: "flex",
        height: 7,
        borderRadius: 4,
        overflow: "hidden",
        marginTop: 7,
        background: "color-mix(in srgb, var(--cc-fg) 5%, transparent)",
      }}
      title={total > 0 ? segs.map((s) => `${s.key} ${Math.round(((mix[s.key] || 0) / total) * 100)}%`).join(" · ") : "no backend-mix data"}
    >
      {total > 0 &&
        segs.map((s) => {
          const pctv = ((mix[s.key] || 0) / total) * 100;
          return pctv > 0 ? <div key={s.key} style={{ width: `${pctv}%`, background: s.color }} /> : null;
        })}
    </div>
  );
}

function PerAgentTable({ byAgent }) {
  const rows = Array.isArray(byAgent) ? byAgent : [];
  return (
    <div style={{ border: "1px solid var(--cc-border)", borderRadius: 12, background: "var(--cc-surface)", overflow: "hidden" }}>
      <div
        title="Seat is derived, not read from the broker: X-Seat header (future) > lane class 'batch' > embeddings endpoint shape > 'agent loop' when the agent's runs carry a trace_parent (child of an orchestrating trace) else 'context window' for trace roots."
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          padding: "11px 16px 9px",
          borderBottom: "1px solid var(--cc-border)",
        }}
      >
        <span className="text-[11px] uppercase" style={{ fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-dim)" }}>
          Per agent · seat &amp; backend mix
        </span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>X-Agent-Id</span>
      </div>

      {rows.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "12px 16px" }}>
          No agent activity for this window.
        </div>
      ) : (
        rows.map((row, i) => {
          const seat = deriveSeat(row);
          const meta = SEAT_META[seat] || SEAT_META["context window"];
          const embedding = seat === "embedding";
          const tps = row.decode_tokens_per_sec?.avg;
          return (
            <div
              key={row.key || i}
              style={{
                padding: "10px 16px",
                borderBottom: "1px solid color-mix(in srgb, var(--cc-fg) 4.5%, transparent)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: 11.5,
                      fontWeight: 700,
                      color: "var(--cc-fg)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {row.key || "(untagged)"}
                  </span>
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: ".05em",
                      textTransform: "uppercase",
                      padding: "1px 6px",
                      borderRadius: 3,
                      background: "var(--cc-elev)",
                      border: "1px solid var(--cc-border)",
                      color: meta.color,
                      flexShrink: 0,
                    }}
                  >
                    {seat}
                  </span>
                </span>
                <span className="tabular-nums" style={{ fontSize: 11, color: "var(--cc-dim)", flexShrink: 0 }}>
                  {embedding ? "" : `${tps != null ? tps.toFixed(1) : "—"} tok/s · `}
                  {fmtInt(row.runs_total)} runs
                </span>
              </div>
              <BackendMixBar mix={row.backend_mix} />
            </div>
          );
        })
      )}

      <div style={{ padding: "10px 16px", fontSize: 10.5, color: "var(--cc-muted)" }}>
        Speed shown is the agent's blended tok/s across whichever backend served it.
      </div>
    </div>
  );
}

export default function PerModelAgent({ data, view: _view }) {
  const byAgent = data?.metrics?.by_agent;
  return (
    <div
      className="per-model-agent-grid"
      style={{ display: "grid", gridTemplateColumns: "minmax(0,1.15fr) minmax(0,1fr)", gap: 14 }}
    >
      <UnifiedModelTable report={data?.modelsReport} />
      <PerAgentTable byAgent={byAgent} />
    </div>
  );
}
