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
import { useState, useEffect } from "react";
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

function DirectProviderConnectionCard({ localEnabled, setLocalEnabled, provider, localModels, onToast }) {
  const reachable = localModels?.reachable === true;
  const label = provider?.label || "Provider";
  const hint = provider?.endpoint_hint || null;
  const [endpointInput, setEndpointInput] = useState(hint || "");
  const [savedHint, setSavedHint] = useState(hint || null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEndpointInput(hint || "");
    setSavedHint(hint || null);
  }, [hint]);

  const displayHint = savedHint || hint;

  const handleSaveEndpoint = async () => {
    const raw = (endpointInput || "").trim();
    const idx = raw.lastIndexOf(":");
    const host = idx > 0 ? raw.slice(0, idx).trim() : "";
    const portStr = idx > 0 ? raw.slice(idx + 1).trim() : "";
    const port = Number(portStr);
    if (!host || !portStr || !Number.isFinite(port) || !Number.isInteger(port)) {
      onToast?.("Enter endpoint as host:port", "error");
      return;
    }
    if (!provider?.id) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/local/${provider.id}/endpoint`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok) {
        setSavedHint(data.endpoint_hint || raw);
        onToast?.(`vLLM endpoint set to ${data.endpoint_hint || raw}`, "success");
      } else {
        onToast?.(data?.error || "Failed to set endpoint", "error");
      }
    } catch {
      onToast?.("Failed to set endpoint", "error");
    } finally {
      setSaving(false);
    }
  };

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
                  : reachable
                    ? "var(--green, #46a758)"
                    : "var(--text-muted)",
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                {!localEnabled
                  ? "Disabled"
                  : reachable
                    ? `${label} connected`
                    : `${label}${displayHint ? ` · ${displayHint}` : ""} · offline`}
              </div>
              {reachable && displayHint && (
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {displayHint}
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

        {localEnabled && !reachable && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 10, lineHeight: 1.5 }}>
            Start your vLLM server — Cockpit polls this endpoint and connects automatically.
          </div>
        )}

        {localEnabled && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
            <input
              type="text"
              value={endpointInput}
              onChange={(e) => setEndpointInput(e.target.value)}
              placeholder="127.0.0.1:8001"
              className="hover-border-accent"
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 12,
                padding: "5px 8px",
                borderRadius: 6,
                border: "1px solid var(--cc-border, var(--border-color))",
                background: "var(--bg-surface)",
                color: "var(--text-primary)",
              }}
            />
            <button
              onClick={handleSaveEndpoint}
              disabled={saving}
              className="text-[11px] px-3 py-1 rounded-full transition-colors hover-bg-surface"
              style={{
                flexShrink: 0,
                color: "var(--accent)",
                border: "1px solid var(--accent)",
                background: "var(--bg-surface)",
                opacity: saving ? 0.6 : 1,
              }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </div>
    </Card>
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
  localModels,
  onSpillChange,
  onToast,
  onClose,
  children, // extra provider panels (picker / models / traces) from App
}) {
  const compatible = localStatus?.compatible === true;
  const isDirectProvider =
    !!selectedProvider && !selectedProvider?.capabilities?.includes("queue");

  // Connection + Provider live in the dashboard header's settings popover —
  // read-at-setup, not read-at-a-glance.
  const settings = (
    <>
      {isDirectProvider ? (
        <DirectProviderConnectionCard
          localEnabled={localEnabled}
          setLocalEnabled={setLocalEnabled}
          provider={selectedProvider}
          localModels={localModels}
          onToast={onToast}
        />
      ) : (
        <ConnectionCard
          localEnabled={localEnabled}
          setLocalEnabled={setLocalEnabled}
          status={localStatus}
        />
      )}
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
