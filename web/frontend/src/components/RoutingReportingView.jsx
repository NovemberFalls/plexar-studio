/**
 * RoutingReportingView — the full-width Routing & Reporting dashboard (design
 * handoff: design_handoff_local_reporting/README.md). W6 container: it owns the
 * view-local state (window / lead / hiddenBackends / refModel), drives the
 * scoped poller (useReportingData), and composes the nine frozen section
 * components from ./localReporting via a CSS `order` lead-with system.
 *
 * Section markup is written once; the "Lead with" control only rewrites the
 * `order` of each flex child, per the handoff ("section markup is written once
 * and never duplicated per mode"). AlertBanner is order:0 and HeroStrip order:1,
 * both pinned; the six content sections take order 2..7 in a lead-dependent
 * sequence.
 *
 * Connection + Provider settings (read-at-setup, not at-a-glance) live in a
 * popover off the header's live badge — passed in as `settings` so this view
 * stays a pure composition of the reporting layer.
 *
 * Props:
 *   providerId   — selected provider id (drives provider-keyed endpoints)
 *   enabled      — poll only when the local broker is enabled AND compatible
 *   status       — GET /api/local/status (for the live badge state)
 *   queueShadow  — broker running in shadow mode (badge → "shadow mode")
 *   onSpillChange — (laneClass, seconds|null) => Promise, the one mutation
 *   onToast      — (message, kind) => void
 *   settings     — node rendered in the header settings popover (connection + provider)
 *   onClose      — () => void
 */
import { useEffect, useMemo, useState } from "react";
import { Cpu, X, Settings } from "lucide-react";

import { seriesColor } from "./localReporting/format";
import AlertBanner from "./localReporting/AlertBanner.jsx";
import HeroStrip from "./localReporting/HeroStrip.jsx";
import RoutingTimeline from "./localReporting/RoutingTimeline.jsx";
import BackendComparison from "./localReporting/BackendComparison.jsx";
import ThroughputChart from "./localReporting/ThroughputChart.jsx";
import LatencyBudget from "./localReporting/LatencyBudget.jsx";
import SpillControl from "./localReporting/SpillControl.jsx";
import PerModelAgent from "./localReporting/PerModelAgent.jsx";
import Ledger from "./localReporting/Ledger.jsx";
import useReportingData from "./localReporting/useReportingData.js";

const WINDOWS = [
  { key: "session", label: "Session" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
  { key: "lifetime", label: "Lifetime" },
];

const LEADS = [
  { key: "routing", label: "ROUTING" },
  { key: "performance", label: "PERFORMANCE" },
  { key: "ledger", label: "LEDGER" },
];

// Content-section order per lead mode. AlertBanner (0) + HeroStrip (1) are
// pinned above; these six take order 2..7 in the listed sequence.
const SECTION_SEQUENCE = {
  routing: ["routing", "backend", "perf", "spill", "models", "ledger"],
  performance: ["perf", "backend", "routing", "spill", "models", "ledger"],
  ledger: ["ledger", "models", "backend", "routing", "perf", "spill"],
};

function readStored(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

/** A window/lead pill. */
function Pill({ active, onClick, children, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: 11,
        padding: "2px 9px",
        borderRadius: 999,
        background: "var(--cc-surface)",
        border: `1px solid ${active ? "var(--cc-accent)" : "var(--cc-border)"}`,
        color: active ? "var(--cc-accent)" : "var(--cc-dim)",
        fontWeight: active ? 600 : 400,
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export default function RoutingReportingView({
  providerId,
  enabled = false,
  status,
  queueShadow,
  onSpillChange,
  onToast,
  settings,
  onClose,
}) {
  const [window, setWindow] = useState(() => readStored("cockpit-reporting-window", "lifetime"));
  const [lead, setLead] = useState(() => {
    const v = readStored("cockpit-reporting-lead", "routing");
    return SECTION_SEQUENCE[v] ? v : "routing";
  });
  const [hiddenBackends, setHiddenBackends] = useState({}); // session only
  const [refModel, setRefModel] = useState(() => readStored("cockpit-reporting-ref", null));
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("cockpit-reporting-window", window); } catch (_) { /* ignore */ }
  }, [window]);
  useEffect(() => {
    try { localStorage.setItem("cockpit-reporting-lead", lead); } catch (_) { /* ignore */ }
  }, [lead]);
  useEffect(() => {
    try {
      if (refModel == null) localStorage.removeItem("cockpit-reporting-ref");
      else localStorage.setItem("cockpit-reporting-ref", refModel);
    } catch (_) { /* ignore */ }
  }, [refModel]);

  const data = useReportingData(providerId, { enabled, window });

  const view = useMemo(() => ({ lead, hiddenBackends, refModel }), [lead, hiddenBackends, refModel]);
  const actions = useMemo(
    () => ({ onSpillChange, onToast, setRefModel }),
    [onSpillChange, onToast],
  );

  // Backend chips — generated from by_provider[] + the API row, never
  // hardcoded. Keys and colors mirror BackendComparison.buildProviders exactly
  // (id = p.id ?? p.key, API row keyed "api") so a chip toggles the same
  // series everywhere.
  const chips = useMemo(() => {
    const out = [];
    const localRows = Array.isArray(data.metrics?.by_provider) ? data.metrics.by_provider : [];
    localRows.forEach((p, i) => {
      if (!p) return;
      const id = p.id ?? p.key ?? `local-${i}`;
      out.push({ id, label: p.label ?? p.id ?? p.key ?? `Backend ${i + 1}`, color: seriesColor(p.id ?? p.key, i) });
    });
    if (data.apiUsage && data.apiUsage.reachable !== false) {
      out.push({ id: "api", label: "Anthropic API", color: seriesColor("api") });
    }
    return out;
  }, [data.metrics, data.apiUsage]);

  const toggleBackend = (id) =>
    setHiddenBackends((h) => ({ ...h, [id]: !h[id] }));

  const runsTotal = data.metrics?.runs_total;
  const persisted = data.metrics?.persisted;

  // Live badge state: offline / shadow / live.
  const compatible = status?.compatible === true;
  const reachable = status?.reachable === true;
  const badge = !enabled || !reachable
    ? { text: "broker offline", color: "var(--cc-error)" }
    : queueShadow
      ? { text: "shadow mode", color: "var(--cc-waiting)" }
      : compatible
        ? { text: "broker live", color: "var(--cc-ok)" }
        : { text: "broker offline", color: "var(--cc-error)" };

  // Ordered content sections (order 2..7 by lead).
  const seq = SECTION_SEQUENCE[lead] || SECTION_SEQUENCE.routing;
  const orderOf = (key) => 2 + seq.indexOf(key);

  const perfSection = (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1.35fr) minmax(0,1fr)",
        gap: 14,
      }}
    >
      <ThroughputChart data={data} view={view} />
      <LatencyBudget data={data} view={view} />
    </div>
  );

  const contentSections = {
    routing: <RoutingTimeline data={data} view={view} actions={actions} />,
    backend: <BackendComparison data={data} view={view} actions={actions} />,
    perf: perfSection,
    spill: <SpillControl data={data} actions={actions} />,
    models: <PerModelAgent data={data} view={view} />,
    ledger: <Ledger data={data} view={view} actions={actions} />,
  };

  return (
    <div
      role="region"
      aria-label="Routing & Reporting"
      className="flex-1 min-w-0"
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        backgroundColor: "var(--cc-bg, var(--bg-primary))",
        color: "var(--cc-fg, var(--text-primary))",
      }}
    >
      {/* View header (52px) */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 22px",
          height: 52,
          borderBottom: "1px solid var(--cc-border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Cpu size={17} style={{ color: "var(--cc-accent)" }} />
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".08em" }}>
            ROUTING &amp; REPORTING
          </span>
          {settings != null && (
            <button
              type="button"
              onClick={() => setSettingsOpen((o) => !o)}
              aria-pressed={settingsOpen}
              aria-label="Connection & provider settings"
              className="transition-colors hover-bg-surface"
              title="Connection & provider settings"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 7px",
                borderRadius: 4,
                background: "var(--cc-elev)",
                border: "1px solid var(--cc-border)",
                color: badge.color,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".06em",
                textTransform: "uppercase",
              }}
            >
              {badge.text}
              <Settings size={11} style={{ color: "var(--cc-dim)" }} />
            </button>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {WINDOWS.map((w) => (
            <Pill key={w.key} active={window === w.key} onClick={() => setWindow(w.key)}>
              {w.label}
            </Pill>
          ))}
          <span style={{ width: 1, height: 18, background: "var(--cc-border)" }} />
          <button
            type="button"
            onClick={onClose}
            className="transition-colors hover-bg-surface"
            style={{ display: "flex", padding: 6, borderRadius: 7, color: "var(--cc-dim)" }}
            aria-label="Close Routing & Reporting view"
          >
            <X size={17} />
          </button>
        </div>

        {settingsOpen && settings != null && (
          <div
            style={{
              position: "absolute",
              top: 50,
              left: 22,
              zIndex: 40,
              width: 380,
              maxWidth: "calc(100vw - 44px)",
              maxHeight: "70vh",
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              padding: 14,
              borderRadius: 12,
              background: "var(--cc-surface)",
              border: "1px solid var(--cc-border)",
              boxShadow: "0 8px 30px rgba(0,0,0,.45)",
            }}
          >
            {settings}
          </div>
        )}
      </div>

      {/* Toolbar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "9px 22px",
          borderBottom: "1px solid var(--cc-line)",
          flexShrink: 0,
          flexWrap: "wrap",
        }}
      >
        {/* Lead with */}
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <span
            className="cc-label"
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--cc-muted)" }}
          >
            Lead with
          </span>
          <div style={{ display: "flex", gap: 3, background: "var(--cc-bg2)", borderRadius: 8, padding: 2 }}>
            {LEADS.map((l) => {
              const active = lead === l.key;
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => setLead(l.key)}
                  aria-pressed={active}
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: ".04em",
                    padding: "4px 12px",
                    borderRadius: 6,
                    border: "none",
                    background: active ? "var(--cc-accent)" : "transparent",
                    color: active ? "#0f1216" : "var(--cc-dim)",
                  }}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Backend chips + record count */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            className="cc-label"
            style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--cc-muted)" }}
          >
            Backends
          </span>
          {chips.map((c) => {
            const on = !hiddenBackends[c.id];
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggleBackend(c.id)}
                aria-pressed={on}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  padding: "3px 10px",
                  borderRadius: 999,
                  background: "var(--cc-surface)",
                  border: `1px solid ${on ? "rgba(255,255,255,.16)" : "var(--cc-border)"}`,
                  color: on ? "var(--cc-fg)" : "var(--cc-muted)",
                  opacity: on ? 1 : 0.5,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: 999, background: c.color, flexShrink: 0 }} />
                {c.label}
              </button>
            );
          })}
          {runsTotal != null && (
            <>
              <span style={{ width: 1, height: 14, background: "var(--cc-border)" }} />
              <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
                {persisted ? "persisted" : "since broker start"} · {runsTotal} runs
              </span>
            </>
          )}
        </div>
      </div>

      {/* Body — section stack, reordered by `order`. */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px 24px" }}>
        {!enabled ? (
          <div className="text-xs" style={{ color: "var(--cc-muted)", padding: "8px 2px", lineHeight: 1.5 }}>
            {reachable && !compatible
              ? "The whole reporting layer needs the lane broker in front of the model server. Open the settings above for guidance."
              : "Enable the local broker to start polling routing and reporting metrics."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ order: 0 }}>
              <AlertBanner data={data} view={view} actions={actions} />
            </div>
            <div style={{ order: 1 }}>
              <HeroStrip data={data} view={view} actions={actions} />
            </div>
            {seq.map((key) => (
              <div key={key} style={{ order: orderOf(key) }}>
                {contentSections[key]}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
