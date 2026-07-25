/**
 * LocalBrokerView — the Local Broker section shell.
 *
 * Opened from the ActivityRail (Cpu icon), mirroring the FleetView overlay
 * pattern. As of W6 (design_handoff_local_reporting) the body is the full-width
 * RoutingReportingView dashboard; this shell only supplies the read-at-setup
 * Connection + Provider panels, rendered inside the dashboard header's settings
 * popover so the enable toggle, identity line, and provider picker stay
 * reachable without taking screen real estate from the reporting layer.
 *
 * Props:
 *   localEnabled / setLocalEnabled — feature flag (localStorage-backed in App)
 *   localStatus  — GET /api/local/status result or null
 *   localQueue   — GET /api/local/queue result or null (for the badge shadow state)
 *   selectedProvider — the picked provider ({ id, capabilities, ... }) or null
 *   onSpillChange — (cls, seconds|null) => void
 *   onToast — (message, kind) => void
 *   onClose — () => void
 *   children — extra provider panels (picker / models / traces) from App
 */
import RoutingReportingView from "./RoutingReportingView.jsx";

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
  selectedProvider,
  onSpillChange,
  onToast,
  onClose,
  children, // extra provider panels (picker / models / traces) from App
}) {
  const compatible = localStatus?.compatible === true;

  // Connection + Provider live in the dashboard header's settings popover —
  // read-at-setup, not read-at-a-glance.
  const settings = (
    <>
      <ConnectionCard
        localEnabled={localEnabled}
        setLocalEnabled={setLocalEnabled}
        status={localStatus}
      />
      {localEnabled && children && <Card title="Provider">{children}</Card>}
    </>
  );

  return (
    <RoutingReportingView
      providerId={selectedProvider?.id}
      enabled={!!localEnabled && compatible}
      status={localStatus}
      queueShadow={localQueue?.shadow}
      onSpillChange={onSpillChange}
      onToast={onToast}
      settings={settings}
      onClose={onClose}
    />
  );
}
