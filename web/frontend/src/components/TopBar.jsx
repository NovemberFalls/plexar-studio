/* eslint-disable react-refresh/only-export-components -- MODEL_GROUPS/MODELS/isOpusModel
   are re-exported here so PaneActionsMenu.jsx reuses the exact same model list
   instead of hardcoding a second copy (see CLAUDE.md model list conventions). */
import { useState, useEffect } from "react";
import { PanelLeft, ChevronDown, KeyRound, Cpu } from "lucide-react";
import OpenRouterModal from "./OpenRouterModal.jsx";
import { ThemePopover, LogoMark } from "./ActivityRail.jsx";
import {
  FALLBACK_MODEL_GROUPS,
  useModelCatalog,
  isOpusModel,
  getModelProvider,
} from "../modelCatalog";
// Lane math lives in utils/laneMath.js so the Workspace lane pressure meter,
// this quick-glance pill, Engine > Live and the spill-policy control all read
// the same arithmetic (see the handoff: "Conversions to implement once and
// share"). Do not re-derive these locally.
import { fmtEta, laneLive } from "../utils/laneMath";

// Re-exported for back-compat: PaneActionsMenu and the test suite import the
// static model list from here. The LIVE, account-accurate catalog flows through
// useModelCatalog() (backed by GET /api/models); these constants are the
// fallback shape served when the live fetch is unavailable.
export const MODEL_GROUPS = FALLBACK_MODEL_GROUPS;
export const MODELS = MODEL_GROUPS.flatMap((g) => g.models);
export { isOpusModel, getModelProvider };

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
  // Tier 1: local model groups render in the picker but are not yet
  // launchable — flip this on in the tier that wires up local launch.
  localLaunchEnabled = false,
  // (providerId, modelId) => void — loads/restarts a not-loaded local model
  // straight from the picker row, without selecting/launching it.
  onLoadLocalModel,
  // id of the local model currently loading/restarting, or null — drives the
  // inline "loading…" state on the matching picker row.
  localBusyModelId = null,
}) {
  const [modelOpen, setModelOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [openRouterOpen, setOpenRouterOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  // tri-state: null = not yet checked, true/false = last known GET result
  const [openRouterConfigured, setOpenRouterConfigured] = useState(null);

  // Live, account-accurate catalog (falls back to the static list offline).
  const { groups: modelGroups, models: modelList } = useModelCatalog();
  const currentModel = modelList.find((m) => m.id === model) || modelList[0];
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

  const live = laneLive(localQueue, localMetrics);
  const liveEta = live ? fmtEta(live.etaSec) : null;

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
            {localEnabled && live && (
              <span
                style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                title="running now / queued · decode tok/s · est. time to drain the queue"
              >
                {/* current running ▸ queued */}
                {live.running}
                <span style={{ color: "var(--text-muted)", fontWeight: 400 }}>▸</span>
                {live.queued}
                {typeof live.tps === "number" && live.tps > 0 && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · {Math.round(live.tps)} tps</span>
                )}
                {liveEta && live.total > 0 && (
                  <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> · ~{liveEta}</span>
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
                    Local Broker section (rail icon / button below). Shows the
                    unified live readout (vLLM in-engine depth OR broker queue)
                    whenever there is live data, so a direct-served provider
                    isn't hidden behind the "not the lane broker" note. */}
                {localEnabled && live ? (
                  <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Running now</span>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{live.running}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Queued</span>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{live.queued}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Tokens/sec</span>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                        {typeof live.tps === "number" && live.tps > 0 ? Math.round(live.tps) : "—"}
                      </span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span>Est. time to drain</span>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                        {live.total > 0 && liveEta ? `~${liveEta}` : "idle"}
                      </span>
                    </div>
                  </div>
                ) : localEnabled && localStatus && !localStatus.compatible ? (
                  <div className="text-xs" style={{ color: "var(--text-muted)", padding: "10px 12px", lineHeight: 1.5 }}>
                    {localStatus.reachable
                      ? "The connected service is not the lane broker — open Local Broker for details."
                      : "Nothing answering at the broker URL — open Local Broker for details."}
                  </div>
                ) : localEnabled ? (
                  <div className="text-xs" style={{ color: "var(--text-muted)", padding: "10px 12px" }}>
                    Waiting for the selected provider to report live activity…
                  </div>
                ) : (
                  <div className="text-xs" style={{ color: "var(--text-muted)", padding: "10px 12px" }}>
                    Enable to poll the selected local provider for live queue depth and tokens/sec.
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
                {modelGroups.map((group, gi) => {
                  const isOpenRouterGroup = group.provider === "openrouter";
                  const isLocalGroup = group.provider === "local";
                  const groupDisabled = (isOpenRouterGroup && !openRouterConfigured) || (isLocalGroup && !localLaunchEnabled);
                  // A group may carry its own note — e.g. a local provider that
                  // does not publish a model list. That is NOT an offline claim,
                  // so it must not be phrased or styled as an error.
                  const groupHint = group.note
                    ? group.note
                    : isLocalGroup && !localLaunchEnabled
                      ? "Enable the local broker to launch local models"
                      : groupDisabled
                        ? "Add a key via the key icon to enable"
                        : null;
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
                      {groupHint && (
                        <div
                          className="text-[10px] px-3 pb-1"
                          style={{ color: "var(--text-muted)", fontStyle: "italic" }}
                        >
                          {groupHint}
                        </div>
                      )}
                      {group.models.map((m) => {
                        const disabled = (isOpenRouterGroup && !openRouterConfigured) || (isLocalGroup && !localLaunchEnabled);
                        const showLoad = isLocalGroup && localLaunchEnabled && m.loaded === false && onLoadLocalModel;
                        const loading = showLoad && localBusyModelId === m.localModelId;
                        return (
                          <div
                            key={m.id}
                            className="flex items-center hover-bg-surface"
                            style={{ opacity: disabled ? 0.45 : 1 }}
                          >
                            <button
                              role="option"
                              aria-selected={m.id === model}
                              aria-disabled={disabled || undefined}
                              disabled={disabled}
                              onClick={() => { if (disabled) return; setModel(m.id); setModelOpen(false); }}
                              className="block flex-1 min-w-0 text-left text-xs px-3 py-1.5 transition-colors"
                              style={{
                                color: disabled ? "var(--text-muted)" : m.id === model ? "var(--accent)" : "var(--text-secondary)",
                                fontWeight: m.id === model ? 600 : 400,
                                cursor: disabled ? "not-allowed" : "pointer",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}
                              title={groupHint || undefined}
                            >
                              {m.label}
                            </button>
                            {showLoad && (
                              <button
                                type="button"
                                disabled={loading}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onLoadLocalModel(m.localProviderId, m.localModelId);
                                }}
                                className="text-[10px] transition-colors hover-bg-elevated"
                                style={{
                                  flexShrink: 0,
                                  marginRight: 6,
                                  padding: "2px 7px",
                                  borderRadius: 4,
                                  border: "1px solid var(--border-color)",
                                  color: "var(--accent)",
                                  background: "var(--bg-surface)",
                                  cursor: loading ? "default" : "pointer",
                                  opacity: loading ? 0.6 : 1,
                                }}
                                aria-label={`Load ${m.localModelId}`}
                                title={loading ? "Loading…" : "Load this model"}
                              >
                                {loading ? "…" : "Load"}
                              </button>
                            )}
                          </div>
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
