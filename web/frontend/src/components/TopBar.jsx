/* eslint-disable react-refresh/only-export-components -- MODEL_GROUPS/MODELS/isOpusModel
   are re-exported here so PaneActionsMenu.jsx reuses the exact same model list
   instead of hardcoding a second copy (see CLAUDE.md model list conventions). */
import { useState, useEffect } from "react";
import { PanelLeft, ChevronDown, KeyRound, Cpu } from "lucide-react";
import OpenRouterModal from "./OpenRouterModal.jsx";
import { ThemePopover, LogoMark } from "./ActivityRail.jsx";

/** Queue depth = in-flight (0/1) + queued length. Field names pinned from
 * broker source (broker.py::_queue_state): in_flight (object|null), queued []. */
function queueDepth(q) {
  if (!q || q.reachable === false) return null;
  return (q.in_flight ? 1 : 0) + (Array.isArray(q.queued) ? q.queued.length : 0);
}

export const MODEL_GROUPS = [
  {
    label: "Claude 4.8",
    models: [
      { id: "claude-opus-4-8", label: "Opus 4.8" },
      { id: "claude-opus-4-8[1m]", label: "Opus 4.8 (1M)" },
    ],
  },
  {
    label: "Claude 4.7",
    models: [
      { id: "claude-opus-4-7", label: "Opus 4.7" },
      { id: "claude-opus-4-7[1m]", label: "Opus 4.7 (1M)" },
    ],
  },
  {
    label: "Claude 4.6",
    models: [
      { id: "sonnet", label: "Sonnet 4.6" },
      { id: "claude-sonnet-4-6[1m]", label: "Sonnet 4.6 (1M)" },
      { id: "opus", label: "Opus 4.6" },
      { id: "claude-opus-4-6[1m]", label: "Opus 4.6 (1M)" },
    ],
  },
  {
    label: "Claude 4.5",
    models: [
      { id: "haiku", label: "Haiku 4.5" },
    ],
  },
  {
    label: "Fable",
    models: [{ id: "claude-fable-5", label: "Fable 5" }],
  },
  {
    label: "OpenRouter",
    provider: "openrouter",
    models: [
      { id: "deepseek/deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "openrouter" },
      { id: "qwen/qwen3-coder-next", label: "Qwen3 Coder Next", provider: "openrouter" },
    ],
  },
];
export const MODELS = MODEL_GROUPS.flatMap((g) => g.models);

const PERMISSION_MODES = [
  { id: "default", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "acceptEdits", label: "Accept Edits" },
  { id: "bypassPermissions", label: "Bypass" },
];

const EFFORT_OPTIONS = [
  { id: "", label: "Auto" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "XHigh" },
  { id: "max", label: "Max" },
];

/** Returns true when the given model id is an Opus model (fast toggle eligible). */
export function isOpusModel(modelId) {
  return (
    modelId === "opus" ||
    modelId === "claude-opus-4-6[1m]" ||
    modelId === "claude-opus-4-7" ||
    modelId === "claude-opus-4-7[1m]" ||
    modelId === "claude-opus-4-8" ||
    modelId === "claude-opus-4-8[1m]"
  );
}

/**
 * Returns "openrouter" for model ids that live in the OpenRouter group of
 * MODEL_GROUPS, "anthropic" for everything else (including unrecognized ids —
 * absent `provider` on a model entry is treated as anthropic, per convention).
 */
export function getModelProvider(modelId) {
  const entry = MODELS.find((m) => m.id === modelId);
  return entry?.provider === "openrouter" ? "openrouter" : "anthropic";
}

export default function TopBar({
  model,
  setModel,
  permissionMode,
  setPermissionMode,
  effort,
  setEffort,
  fast,
  setFast,
  sidebarOpen,
  setSidebarOpen,
  user,
  onToast,
  localEnabled,
  setLocalEnabled,
  localQueue,
  localMetrics,
  localStatus,
  onOpenLocalBroker,
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [openRouterOpen, setOpenRouterOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  // tri-state: null = not yet checked, true/false = last known GET result
  const [openRouterConfigured, setOpenRouterConfigured] = useState(null);

  const currentModel = MODELS.find((m) => m.id === model) || MODELS[0];
  const currentPermission = PERMISSION_MODES.find((p) => p.id === permissionMode) || PERMISSION_MODES[0];
  const currentEffort = EFFORT_OPTIONS.find((e) => e.id === effort) || EFFORT_OPTIONS[0];
  const modelProvider = getModelProvider(model);
  const isOpenRouterModel = modelProvider === "openrouter";
  const fastEligible = isOpusModel(model) && !isOpenRouterModel;

  // Check OpenRouter key status on mount, and again every time the
  // OpenRouterModal closes (the key may have just been saved/removed).
  useEffect(() => {
    if (openRouterOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/openrouter");
        const data = await res.json().catch(() => ({}));
        if (!cancelled) setOpenRouterConfigured(Boolean(data.configured));
      } catch (_err) {
        if (!cancelled) setOpenRouterConfigured(false);
      }
    })();
    return () => { cancelled = true; };
  }, [openRouterOpen]);

  // If the key gets removed out from under a selected OpenRouter model, fall
  // back to MODELS[0] and tell the user why (via the toast callback).
  useEffect(() => {
    if (openRouterConfigured === false && isOpenRouterModel) {
      setModel(MODELS[0].id);
      onToast?.(
        `OpenRouter key removed — reverted model selection to ${MODELS[0].label}`,
        "info"
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRouterConfigured, isOpenRouterModel]);

  function closeAll() {
    setModelOpen(false);
    setPermissionOpen(false);
    setEffortOpen(false);
    setThemeOpen(false);
    setLocalOpen(false);
  }

  const localDepth = queueDepth(localQueue);
  const localTps = localMetrics && localMetrics.reachable !== false
    ? localMetrics.tokens_per_sec?.current
    : null;

  return (
    <header
      className="flex items-center justify-between flex-shrink-0 relative z-30"
      style={{ padding: "0 16px", height: 48, borderBottom: "1px solid var(--cc-border, var(--border-color))" }}
    >
      {/* Left */}
      <div className="flex items-center" style={{ gap: 11 }}>
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="transition-colors hover-bg-surface"
          style={{ display: "flex", padding: 5, borderRadius: 7, color: "var(--cc-dim, var(--text-secondary))" }}
          title="Toggle sidebar (Ctrl+Shift+B)"
          aria-label="Toggle sidebar"
        >
          <PanelLeft size={17} />
        </button>
        <div
          style={{
            width: 25, height: 25, borderRadius: 7,
            background: "linear-gradient(140deg,#2a2f2a,#131311)",
            border: "1px solid color-mix(in srgb, var(--cc-accent, #4ea1e8) 35%, transparent)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 12px color-mix(in srgb, var(--cc-accent, #4ea1e8) 25%, transparent)",
          }}
        >
          <LogoMark size={15} />
        </div>
        <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".1em", color: "var(--cc-fg, var(--text-primary))" }}>
          COCKPIT
        </span>
      </div>

      {/* Right */}
      <div className="flex items-center" style={{ gap: 7 }}>
        {/* Fleet view lives in the ActivityRail (left) — deliberately NOT
            duplicated here; the top bar owns session levers + the broker. */}

        {/* Local broker — queue + metrics (machine-global). Compact live
            readout when enabled; dim icon otherwise. Click opens the drawer. */}
        <div className="relative">
          <button
            onClick={() => { const wasOpen = localOpen; closeAll(); setLocalOpen(!wasOpen); }}
            className="flex items-center transition-colors hover-bg-surface"
            style={{
              gap: 5, padding: localEnabled ? "4px 9px" : 5, borderRadius: localEnabled ? 999 : 7,
              color: localEnabled ? "var(--cc-accent, var(--accent))" : "var(--cc-dim, var(--text-secondary))",
              border: localEnabled ? "1px solid var(--border-color)" : "none",
            }}
            title="Local model broker — queue & metrics"
            aria-label="Local broker queue and metrics"
            aria-expanded={localOpen}
            aria-haspopup="dialog"
          >
            <Cpu size={15} />
            {localEnabled && localDepth != null && (
              <span style={{ fontSize: 11, fontWeight: 600 }}>
                {localDepth}
                {typeof localTps === "number" && localTps > 0 && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {Math.round(localTps)} tps</span>
                )}
              </span>
            )}
          </button>
          {localOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setLocalOpen(false)} aria-hidden="true" />
              <div
                role="dialog"
                aria-label="Local broker"
                className="absolute right-0 mt-1 rounded-lg z-50"
                style={{
                  width: 340,
                  maxHeight: "70vh",
                  overflowY: "auto",
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {/* Enable toggle */}
                <div
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "8px 12px", borderBottom: "1px solid var(--border-color)",
                  }}
                >
                  <span className="text-[11px] uppercase tracking-wider" style={{ color: "var(--text-secondary)", fontWeight: 600 }}>
                    Local Broker
                  </span>
                  <button
                    onClick={() => setLocalEnabled?.((v) => !v)}
                    className="text-[11px] px-2 py-0.5 rounded-full transition-colors"
                    style={{
                      color: localEnabled ? "var(--accent)" : "var(--text-muted)",
                      border: `1px solid ${localEnabled ? "var(--accent)" : "var(--border-color)"}`,
                      background: "var(--bg-surface)",
                    }}
                    aria-pressed={!!localEnabled}
                  >
                    {localEnabled ? "Enabled" : "Disabled"}
                  </button>
                </div>

                {/* Connection identity — what is actually answering at the URL. */}
                {localEnabled && localStatus && (
                  <div
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "7px 12px", borderBottom: "1px solid var(--border-color)",
                      fontSize: 11,
                      color: localStatus.compatible ? "var(--text-secondary)" : "var(--red, #e5484d)",
                    }}
                    title={localStatus.detail || ""}
                  >
                    <span
                      style={{
                        width: 7, height: 7, borderRadius: 999, flexShrink: 0,
                        background: localStatus.compatible
                          ? "var(--green, #46a758)"
                          : localStatus.reachable ? "var(--red, #e5484d)" : "var(--text-muted)",
                      }}
                    />
                    {localStatus.compatible ? (
                      <span>lane broker · {localStatus.url}</span>
                    ) : localStatus.reachable ? (
                      <span>
                        {localStatus.service === "lmstudio" ? "LM Studio" :
                         localStatus.service === "vllm" ? "vLLM" :
                         localStatus.service === "ollama" ? "Ollama" :
                         localStatus.service === "openai-compatible" ? "an OpenAI-compatible server" :
                         "an unknown service"}
                        {" at "}{localStatus.url} — not the lane broker
                      </span>
                    ) : (
                      <span>nothing answering at {localStatus.url}</span>
                    )}
                  </div>
                )}

                {/* Quick glance only — config + full reporting live in the
                    Local Broker section (rail icon / button below). */}
                {localEnabled && localStatus && !localStatus.compatible ? (
                  <div className="text-xs" style={{ color: "var(--text-muted)", padding: "10px 12px", lineHeight: 1.5 }}>
                    {localStatus.reachable
                      ? "The connected service is not the lane broker — open Local Broker for details."
                      : "Nothing answering at the broker URL — open Local Broker for details."}
                  </div>
                ) : localEnabled ? (
                  <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Queue</span>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                        {localDepth != null ? localDepth : "—"}
                        {typeof localQueue?.estimated_clear_seconds === "number" && localDepth > 0 &&
                          ` · clears ~${Math.round(localQueue.estimated_clear_seconds)}s`}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Tokens/sec</span>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                        {typeof localTps === "number" && localTps > 0 ? Math.round(localTps) : "—"}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: "var(--text-muted)", padding: "10px 12px" }}>
                    Enable to poll the local-lane broker for live queue depth and tokens/sec.
                  </div>
                )}

                {/* Footer: jump to the full section */}
                {onOpenLocalBroker && (
                  <button
                    onClick={() => { setLocalOpen(false); onOpenLocalBroker(); }}
                    className="text-xs w-full text-left transition-colors hover-bg-surface"
                    style={{
                      padding: "9px 12px",
                      borderTop: "1px solid var(--border-color)",
                      color: "var(--accent)",
                      fontWeight: 600,
                    }}
                  >
                    Open Local Broker — config &amp; reporting →
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* OpenRouter settings */}
        <button
          onClick={() => { closeAll(); setOpenRouterOpen(true); }}
          className="transition-colors hover-bg-surface"
          style={{ display: "flex", padding: 5, borderRadius: 7, color: "var(--cc-dim, var(--text-secondary))" }}
          title="OpenRouter settings"
          aria-label="OpenRouter settings"
        >
          <KeyRound size={16} />
        </button>

        {/* Theme settings (palette / accent / glow) */}
        <div className="relative">
          <button
            onClick={() => { closeAll(); setThemeOpen((v) => !v); }}
            className="flex items-center transition-colors hover-bg-surface"
            style={{
              gap: 4, padding: "4px 9px", borderRadius: 999,
              color: "var(--cc-muted, var(--text-muted))",
              border: "1px solid var(--cc-border, var(--border-color))",
            }}
            aria-label="Theme settings"
            aria-expanded={themeOpen}
            aria-haspopup="dialog"
          >
            <span style={{ width: 10, height: 10, borderRadius: 999, background: "var(--cc-accent, var(--accent))" }} />
            <ChevronDown size={9} />
          </button>
          {themeOpen && <ThemePopover align="right" onClose={() => setThemeOpen(false)} />}
        </div>

        {/* Model picker */}
        <div className="relative">
          <button
            onClick={() => { closeAll(); setModelOpen((v) => !v); }}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
              backgroundColor: "var(--bg-surface)",
            }}
            aria-label={`Model: ${currentModel.label}`}
            aria-expanded={modelOpen}
            aria-haspopup="listbox"
          >
            {currentModel.label}
            <ChevronDown size={10} />
          </button>
          {modelOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setModelOpen(false)} aria-hidden="true" />
              <div
                role="listbox"
                aria-label="Model"
                className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[170px]"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {MODEL_GROUPS.map((group, gi) => {
                  const isOpenRouterGroup = group.provider === "openrouter";
                  const groupDisabled = isOpenRouterGroup && !openRouterConfigured;
                  return (
                    <div key={group.label}>
                      {gi > 0 && (
                        <div style={{ height: 1, backgroundColor: "var(--border-color)", margin: "2px 0" }} />
                      )}
                      <div
                        className="text-[10px] uppercase tracking-wider px-3 pt-1.5 pb-0.5"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {group.label}
                      </div>
                      {groupDisabled && (
                        <div
                          className="text-[10px] px-3 pb-1"
                          style={{ color: "var(--text-muted)", fontStyle: "italic" }}
                        >
                          Add a key via the key icon to enable
                        </div>
                      )}
                      {group.models.map((m) => {
                        const disabled = isOpenRouterGroup && !openRouterConfigured;
                        return (
                          <button
                            key={m.id}
                            role="option"
                            aria-selected={m.id === model}
                            aria-disabled={disabled || undefined}
                            disabled={disabled}
                            onClick={() => { if (disabled) return; setModel(m.id); setModelOpen(false); }}
                            className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                            style={{
                              color: disabled ? "var(--text-muted)" : m.id === model ? "var(--accent)" : "var(--text-secondary)",
                              fontWeight: m.id === model ? 600 : 400,
                              opacity: disabled ? 0.45 : 1,
                              cursor: disabled ? "not-allowed" : "pointer",
                            }}
                            title={disabled ? "Add a key via the key icon to enable" : undefined}
                          >
                            {m.label}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Permission mode picker */}
        <div className="relative">
          <button
            onClick={() => { closeAll(); setPermissionOpen((v) => !v); }}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
            style={{
              color: "var(--accent)",
              border: "1px solid var(--border-color)",
              backgroundColor: "var(--bg-surface)",
            }}
            aria-label={`Permission mode: ${currentPermission.label}`}
            aria-expanded={permissionOpen}
            aria-haspopup="listbox"
            title="Default permission mode for new sessions"
          >
            {currentPermission.label.toUpperCase()}
            <ChevronDown size={10} />
          </button>
          {permissionOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPermissionOpen(false)} aria-hidden="true" />
              <div
                role="listbox"
                aria-label="Permission mode"
                className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[140px]"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {PERMISSION_MODES.map((p) => (
                  <button
                    key={p.id}
                    role="option"
                    aria-selected={p.id === permissionMode}
                    onClick={() => { setPermissionMode(p.id); setPermissionOpen(false); }}
                    className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                    style={{
                      color: p.id === permissionMode ? "var(--accent)" : "var(--text-secondary)",
                      fontWeight: p.id === permissionMode ? 600 : 400,
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Effort picker — not applicable to OpenRouter sessions (backend skips it) */}
        <div className="relative">
          <button
            onClick={() => { if (isOpenRouterModel) return; closeAll(); setEffortOpen((v) => !v); }}
            disabled={isOpenRouterModel}
            className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
            style={{
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
              backgroundColor: "var(--bg-surface)",
              opacity: isOpenRouterModel ? 0.45 : 1,
              cursor: isOpenRouterModel ? "not-allowed" : "pointer",
            }}
            aria-label={`Effort: ${currentEffort.label}`}
            aria-expanded={effortOpen}
            aria-haspopup="listbox"
            title={isOpenRouterModel ? "Not available for OpenRouter models" : "Default thinking effort for new sessions"}
          >
            {currentEffort.label}
            <ChevronDown size={10} />
          </button>
          {effortOpen && !isOpenRouterModel && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setEffortOpen(false)} aria-hidden="true" />
              <div
                role="listbox"
                aria-label="Effort"
                className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[110px]"
                style={{
                  backgroundColor: "var(--bg-elevated)",
                  border: "1px solid var(--border-color)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                }}
              >
                {EFFORT_OPTIONS.map((e) => (
                  <button
                    key={e.id}
                    role="option"
                    aria-selected={e.id === effort}
                    onClick={() => { setEffort(e.id); setEffortOpen(false); }}
                    className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                    style={{
                      color: e.id === effort ? "var(--accent)" : "var(--text-secondary)",
                      fontWeight: e.id === effort ? 600 : 400,
                    }}
                  >
                    {e.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Fast toggle — Opus models only */}
        <button
          onClick={() => { if (fastEligible) setFast((v) => !v); }}
          className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full transition-colors"
          style={{
            color: fastEligible && fast ? "var(--accent)" : "var(--text-muted)",
            backgroundColor: "var(--bg-surface)",
            border: `1px solid ${fastEligible && fast ? "var(--accent)" : "var(--border-color)"}`,
            opacity: fastEligible ? 1 : 0.4,
            cursor: fastEligible ? "pointer" : "not-allowed",
          }}
          aria-label={fastEligible ? (fast ? "Fast mode on" : "Fast mode off") : "Fast mode (Opus models only)"}
          aria-pressed={fastEligible && fast}
          disabled={!fastEligible}
          title={
            isOpenRouterModel
              ? "Not available for OpenRouter models"
              : fastEligible
                ? "Toggle fast mode for new sessions"
                : "Fast mode is only available for Opus models"
          }
        >
          Fast
        </button>

        {/* Avatar */}
        {user?.picture ? (
          <img
            src={user.picture}
            alt=""
            className="w-7 h-7 rounded-full"
            style={{ border: "1px solid var(--border-color)" }}
          />
        ) : (
          <div
            className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium"
            style={{
              backgroundColor: "var(--bg-surface)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border-color)",
            }}
          >
            {(user?.name || "?")[0].toUpperCase()}
          </div>
        )}

      </div>

      <OpenRouterModal
        open={openRouterOpen}
        onClose={() => setOpenRouterOpen(false)}
        onToast={onToast}
      />
    </header>
  );
}
