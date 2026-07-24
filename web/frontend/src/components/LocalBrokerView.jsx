/**
 * LocalBrokerView — the full-page Local Broker section (config + reporting).
 *
 * Opened from the ActivityRail (Cpu icon), mirroring the FleetView overlay
 * pattern. This is where the broker actually lives; the TopBar popover is
 * only a quick glance. Composes:
 *   - Connection card: identity (what's actually answering at the URL),
 *     enable toggle, plain-English guidance when the wrong service answers.
 *   - Queue & spill card: LaneQueuePanel (live queue + per-class spill sliders).
 *   - Reporting card: LocalMetricsPanel (windowed metrics + breakdowns).
 *
 * Props:
 *   localEnabled / setLocalEnabled — feature flag (localStorage-backed in App)
 *   localStatus  — GET /api/local/status result or null
 *   localQueue   — GET /api/local/queue result or null
 *   localSpill   — GET /api/local/spill result or null
 *   localMetrics — GET /api/local/metrics result or null
 *   metricsWindow / setMetricsWindow — lifetime | 24h | session
 *   onSpillChange — (cls, seconds|null) => void
 *   onClose — () => void
 */
import { X, Cpu } from "lucide-react";
import LaneQueuePanel from "./LaneQueuePanel.jsx";
import LocalMetricsPanel from "./LocalMetricsPanel.jsx";

const SERVICE_LABEL = {
  lmstudio: "LM Studio",
  vllm: "vLLM",
  ollama: "Ollama",
  "openai-compatible": "an OpenAI-compatible server",
  unknown: "an unknown service",
};

function Card({ title, children, style }) {
  return (
    <div
      className="cc-card"
      style={{
        borderRadius: 12,
        background: "var(--cc-surface, var(--bg-elevated))",
        border: "1px solid var(--cc-border, var(--border-color))",
        overflow: "hidden",
        ...style,
      }}
    >
      <div
        className="text-[11px] uppercase tracking-wider"
        style={{
          color: "var(--text-muted)",
          padding: "10px 14px 8px",
          borderBottom: "1px solid var(--cc-border, var(--border-color))",
          fontWeight: 600,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function ConnectionCard({ localEnabled, setLocalEnabled, status }) {
  const compatible = status?.compatible === true;
  const reachable = status?.reachable === true;

  return (
    <Card title="Connection">
      <div style={{ padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span
              style={{
                width: 9, height: 9, borderRadius: 999, flexShrink: 0,
                background: !localEnabled
                  ? "var(--text-muted)"
                  : compatible
                    ? "var(--green, #46a758)"
                    : reachable ? "var(--red, #e5484d)" : "var(--text-muted)",
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                {!localEnabled
                  ? "Disabled"
                  : !status
                    ? "Checking…"
                    : compatible
                      ? "Lane broker connected"
                      : reachable
                        ? `${SERVICE_LABEL[status.service] || "An unknown service"} is answering — not the lane broker`
                        : "Nothing answering"}
              </div>
              {status?.url && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {status.url}
                  {status.managed ? " · managed by Cockpit" : status.compatible ? " · external process" : ""}
                  {status.detail ? ` · ${status.detail}` : ""}
                </div>
              )}
            </div>
          </div>
          <button
            onClick={() => setLocalEnabled?.((v) => !v)}
            className="text-[11px] px-3 py-1 rounded-full transition-colors"
            style={{
              flexShrink: 0,
              color: localEnabled ? "var(--accent)" : "var(--text-muted)",
              border: `1px solid ${localEnabled ? "var(--accent)" : "var(--border-color)"}`,
              background: "var(--bg-surface)",
            }}
            aria-pressed={!!localEnabled}
          >
            {localEnabled ? "Enabled" : "Disabled"}
          </button>
        </div>

        {localEnabled && status && !compatible && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
            {reachable
              ? "Queue, metrics, and spill control need the lane broker in front of the model server. Point COCKPIT_BROKER_URL at the broker process, or start it."
              : "Start the lane broker (or check COCKPIT_BROKER_URL) — the URL above is not answering."}
          </div>
        )}
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 10 }}>
          The broker URL is configured server-side via the COCKPIT_BROKER_URL environment
          variable (default http://127.0.0.1:1235) and is never taken from the browser.
        </div>
      </div>
    </Card>
  );
}

export default function LocalBrokerView({
  localEnabled,
  setLocalEnabled,
  localStatus,
  localQueue,
  localSpill,
  localMetrics,
  metricsWindow,
  setMetricsWindow,
  onSpillChange,
  onClose,
}) {
  const compatible = localStatus?.compatible === true;

  return (
    <div
      role="dialog"
      aria-label="Local Broker"
      className="fixed inset-0 z-50"
      style={{
        display: "flex",
        flexDirection: "column",
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
          height: 52,
          borderBottom: "1px solid var(--cc-border, var(--border-color))",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Cpu size={17} style={{ color: "var(--cc-accent, var(--accent))" }} />
          <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".08em" }}>LOCAL BROKER</span>
        </div>
        <button
          onClick={onClose}
          className="transition-colors hover-bg-surface"
          style={{ display: "flex", padding: 6, borderRadius: 7, color: "var(--cc-dim, var(--text-secondary))" }}
          aria-label="Close Local Broker view"
        >
          <X size={17} />
        </button>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: "auto", padding: 18 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(300px, 380px) minmax(360px, 1fr)",
            gap: 14,
            maxWidth: 1100,
            margin: "0 auto",
            alignItems: "start",
          }}
        >
          {/* Left column: connection + queue/spill */}
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <ConnectionCard
              localEnabled={localEnabled}
              setLocalEnabled={setLocalEnabled}
              status={localStatus}
            />
            {localEnabled && compatible && (
              <Card title="Queue & Spill">
                <LaneQueuePanel queue={localQueue} spillConfig={localSpill} onSpillChange={onSpillChange} />
              </Card>
            )}
          </div>

          {/* Right column: reporting */}
          <Card title="Reporting">
            {localEnabled && compatible ? (
              <LocalMetricsPanel
                metrics={localMetrics}
                window={metricsWindow}
                setWindow={setMetricsWindow}
              />
            ) : (
              <div className="text-xs" style={{ color: "var(--text-muted)", padding: "12px 14px", lineHeight: 1.5 }}>
                {localEnabled
                  ? "Reporting appears once the lane broker is connected."
                  : "Enable the local broker to start polling queue and reporting metrics."}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
