/* eslint-disable react-refresh/only-export-components -- MODEL_GROUPS/MODELS/isOpusModel
   are re-exported here so PaneActionsMenu.jsx reuses the exact same model list
   instead of hardcoding a second copy (see CLAUDE.md model list conventions).
   PERMISSION_MODES/EFFORT_OPTIONS are exported for the same reason: this file is
   the single source for the model, permission-mode and effort vocabularies a
   session can be configured with. */
import { useState, useEffect } from "react";
import { PanelLeft, PanelRight, ChevronDown, KeyRound, Cpu, LayoutGrid, Rows3, StretchHorizontal } from "lucide-react";
import OpenRouterModal from "./OpenRouterModal.jsx";
import PlexarKeyModal from "./PlexarKeyModal.jsx";
import { ThemePopover, LogoMark } from "./ActivityRail.jsx";
import {
  FALLBACK_MODEL_GROUPS,
  useModelCatalog,
  isOpusModel,
  getModelProvider,
  isUnservedSelection,
  UNSERVED_ROW_TAG,
  HARNESSES,
  DEFAULT_HARNESS,
  groupsForHarness,
  resolveModelSelection,
} from "../modelCatalog";
// Lane math lives in utils/laneMath.js so the Workspace lane meter, this
// quick-glance pill and Engine > Live all read the same arithmetic (see the
// handoff: "Conversions to implement once and share"). Do not re-derive these
// locally. The spill-policy control was the fourth reader until 2026-08-03.
import { fmtEta, laneLive } from "../utils/laneMath";
// Permission modes + effort levels live in a plain module for the same reason
// the model list lives in modelCatalog: four files had forked them and two had
// drifted. See sessionVocabulary.js for the full history.
import { PERMISSION_MODES, EFFORT_OPTIONS, resolveVocabChoice } from "../sessionVocabulary";

// Re-exported for back-compat: PaneActionsMenu and the test suite import the
// static model list from here. The LIVE, account-accurate catalog flows through
// useModelCatalog() (backed by GET /api/models); these constants are the
// fallback shape served when the live fetch is unavailable.
export const MODEL_GROUPS = FALLBACK_MODEL_GROUPS;
export const MODELS = MODEL_GROUPS.flatMap((g) => g.models);
export { isOpusModel, getModelProvider };

// Re-exported for back-compat, exactly like MODELS above: the permission-mode
// and effort vocabularies are DEFINED in sessionVocabulary.js (a plain module,
// so a consumer — or a test that module-mocks this component — can import them
// without pulling in the TopBar tree). New consumers should import from
// sessionVocabulary directly; these names stay so existing imports keep working.
export { PERMISSION_MODES, EFFORT_OPTIONS };

/** Title for a pill whose model id is in no catalog, for any harness. It states
 *  the one fact that matters — the id is passed through VERBATIM — rather than
 *  implying the selection is broken: an id newer than this build is unknown here
 *  and perfectly launchable, and the pill has no way to tell those apart. What
 *  it must never do is show a different model's name, which is what the old
 *  `|| modelList[0]` fallback did. */
export const MODEL_UNKNOWN_TITLE =
  "This id is not in the model catalog. A new session will be spawned on it exactly as written.";

export default function TopBar({
  // Which CLI a new session is spawned against ("claude-code" | "codex"). The
  // harness decides which model groups are even offerable, so it sits to the
  // LEFT of the model pill — you pick the harness, then a model it can run.
  harness = DEFAULT_HARNESS,
  setHarness,
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
  // The Inspector (right panel) had a collapse button and NO way back — a
  // one-way door that only a reload undid. This toggle is the way back, and it
  // is deliberately the mirror of the sidebar's: same icon family, same header.
  inspectorOpen,
  setInspectorOpen,
  // "grid" | "scroll". Optional: hosts that render no pane area omit it.
  layoutMode,
  setLayoutMode,
  // Scroll mode only: whether each folder's panes divide the full width.
  fillWidth,
  setFillWidth,
  // Render as a bare control cluster for the command bar to host inline,
  // instead of as a standalone <header>. See the note above the return.
  embedded = false,
  // (bool) => void. Fires when the MODEL picker opens or closes. The local
  // model list polls faster while a user is looking at it; when TopBar lived
  // inside a drop-down the host could infer that from the drop-down's own
  // state, but the controls are always mounted now, so the picker has to say.
  onPickerOpenChange,
  user,
  onToast,
  localEnabled,
  setLocalEnabled,
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
  const [harnessOpen, setHarnessOpen] = useState(false);
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [openRouterOpen, setOpenRouterOpen] = useState(false);
  const [plexarOpen, setPlexarOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  // tri-state: null = not yet checked, true/false = last known GET result
  const [openRouterConfigured, setOpenRouterConfigured] = useState(null);

  // Plexar Harness model/effort pickers. Persisted locally like the other
  // launch levers on this bar; the model list itself is fetched, never
  // hardcoded, from GET /api/harness/models (see harness_manager.list_models).
  const [harnessModelOpen, setHarnessModelOpen] = useState(false);
  const [harnessEffortOpen, setHarnessEffortOpen] = useState(false);
  const [harnessModels, setHarnessModels] = useState([]);
  const [harnessModelsSource, setHarnessModelsSource] = useState(null);
  const [harnessModelsError, setHarnessModelsError] = useState(null);
  const [harnessModelsLoading, setHarnessModelsLoading] = useState(false);
  const [harnessModel, setHarnessModelState] = useState(() => {
    try { return localStorage.getItem("cockpit-harness-model") || ""; } catch { return ""; }
  });
  // "" means nothing stored yet; stored-but-invalid-for-this-model must render
  // verbatim rather than silently substitute, so this is not conflated with "".
  const [harnessEffort, setHarnessEffortState] = useState(() => {
    try { return localStorage.getItem("cockpit-harness-effort") ?? ""; } catch { return ""; }
  });
  const [harnessEffortStored, setHarnessEffortStored] = useState(() => {
    try { return localStorage.getItem("cockpit-harness-effort") !== null; } catch { return false; }
  });

  const setHarnessModel = (id) => {
    setHarnessModelState(id);
    try { localStorage.setItem("cockpit-harness-model", id); } catch { /* per-viewer convenience only */ }
  };
  const setHarnessEffort = (id) => {
    setHarnessEffortState(id);
    setHarnessEffortStored(true);
    try { localStorage.setItem("cockpit-harness-effort", id); } catch { /* per-viewer convenience only */ }
  };

  const fetchHarnessModels = () => {
    setHarnessModelsLoading(true);
    setHarnessModelsError(null);
    fetch("/api/harness/models")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("bad status"))))
      .then((data) => {
        const models = Array.isArray(data.models) ? data.models : [];
        setHarnessModels(models);
        setHarnessModelsSource(data.source ?? null);
      })
      .catch(() => {
        setHarnessModelsSource(null);
        setHarnessModelsError("Could not load Plexar Harness models");
      })
      .finally(() => setHarnessModelsLoading(false));
  };

  // Fetched when the harness pill is selected (isPlexarHarness true), and
  // again whenever the model dropdown itself is opened.
  useEffect(() => {
    if (harness === "plexar-harness") fetchHarnessModels();
  }, [harness]);

  // Unset ("") is fine to default to the first offering — that is not the
  // banned `|| list[0]` shape, which only ever applies to a SET value.
  useEffect(() => {
    if (harnessModel === "" && harnessModels.length > 0) setHarnessModel(harnessModels[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessModels]);

  const harnessModelsSourceNone = harnessModelsSource === "none";
  const selectedHarnessModelRow = harnessModels.find((m) => m.id === harnessModel) || null;
  // `efforts` distinguishes null (genuinely unknown/unobserved for this
  // model) from [] (observed — this model has no effort control at all).
  // Never collapse the two: they render distinctly below.
  const harnessModelEffortsRaw = selectedHarnessModelRow ? selectedHarnessModelRow.efforts : undefined;
  const harnessEffortsUnknown = selectedHarnessModelRow != null && harnessModelEffortsRaw == null;
  const harnessModelEfforts = Array.isArray(harnessModelEffortsRaw) ? harnessModelEffortsRaw : [];
  const harnessHasEfforts = harnessModelEfforts.length > 0;
  // Only fall back to the model's first effort when NOTHING is stored at
  // all. A stored-but-invalid value for THIS model is rendered verbatim and
  // marked unavailable instead — never silently substituted.
  const effectiveHarnessEffort = !harnessEffortStored && harnessHasEfforts
    ? harnessModelEfforts[0]
    : harnessEffort;
  const harnessEffortUnavailable = Boolean(
    harnessHasEfforts && harnessEffortStored && !harnessModelEfforts.includes(harnessEffort)
  );

  // Live, account-accurate catalog (falls back to the static list offline).
  const { groups: modelGroups } = useModelCatalog();
  // The picker only OFFERS what the selected harness can run, but the pill's
  // label is looked up against the FULL list: a selection the harness cannot
  // run must still render its own name rather than silently reading as the
  // first model in the filtered list, which is a different session entirely.
  const visibleGroups = groupsForHarness(modelGroups, harness);
  // Same rule as the model pill below, for the same measured reason (R-169):
  // never render a DIFFERENT entry for an id we do not recognise. These three
  // all come from localStorage, and the permission vocabulary genuinely drifts
  // -- pty_manager accepts `auto`/`dontAsk`, which PERMISSION_MODES omits.
  const currentHarness = resolveVocabChoice(harness, HARNESSES);
  const isCodexHarness = harness === "codex";
  const isPlexarHarness = harness === "plexar-harness";
  // NOT `modelList.find(...) || modelList[0]`. That fallback rendered the first
  // catalog entry ("Opus 5") whenever the id was unrecognized — which the bare
  // alias "sonnet" always is, since /api/models returns only dated ids — so the
  // pill named a model the session was NOT spawning on. resolveModelSelection
  // searches every harness (Codex ids are excluded from modelList by design) and
  // otherwise reports the id AS ITSELF with known:false. See modelCatalog.
  const modelSelection = resolveModelSelection(model, modelGroups);
  const currentModel = modelSelection.entry;
  const modelUnknown = !modelSelection.known;
  const currentPermission = resolveVocabChoice(permissionMode, PERMISSION_MODES);
  const currentEffort = resolveVocabChoice(effort, EFFORT_OPTIONS);
  // The selected default names a local model the engine is not serving. Any
  // session spawned on it fails at request time, so the pill has to say so
  // where the selection lives — a neutral "· not loaded" suffix reads as trivia.
  // Keys off the resolved ENTRY: a null entry means "not in the catalog", which
  // is a different statement from "in the catalog and not being served".
  const selectionUnserved = isUnservedSelection(currentModel);
  // Both states get the same warning treatment on the pill: something about
  // this selection needs the user's eye before they spawn on it.
  const modelFlagged = selectionUnserved || modelUnknown;
  const modelProvider = getModelProvider(model);
  const isOpenRouterModel = modelProvider === "openrouter";
  // Codex exposes no fast mode at all, so the toggle is dead there for the same
  // reason it is dead on OpenRouter: the backend has nothing to send.
  const fastEligible = isOpusModel(model) && !isOpenRouterModel && !isCodexHarness;

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
    setHarnessOpen(false);
    setPermissionOpen(false);
    setEffortOpen(false);
    setThemeOpen(false);
    setLocalOpen(false);
    setKeysOpen(false);
    setHarnessModelOpen(false);
    setHarnessEffortOpen(false);
  }

  // Report model-picker visibility upward (see onPickerOpenChange).
  useEffect(() => {
    onPickerOpenChange?.(modelOpen);
  }, [modelOpen, onPickerOpenChange]);

  const live = laneLive(localMetrics);
  const liveEta = live ? fmtEta(live.etaSec) : null;

  // Rendered two ways. `embedded` is the real one: a single control cluster the
  // command bar hosts inline, so Studio has ONE bar. The standalone <header>
  // stays for tests and for any host rendering TopBar alone -- it is not a
  // second shipped surface.
  const sidebarToggle = (
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className="transition-colors hover-bg-surface"
        style={{ display: "flex", padding: 5, borderRadius: 7, color: "var(--cc-dim, var(--text-secondary))" }}
        title="Toggle sidebar (Ctrl+Shift+B)"
        aria-label="Toggle sidebar"
      >
        <PanelLeft size={17} />
      </button>
  );

  // Layout mode. Optional: a host that renders no pane area omits setLayoutMode
  // and gets no toggle rather than a control that would do nothing.
  const layoutToggle = !setLayoutMode ? null : (
        <div
          role="group"
          aria-label="Layout mode"
          style={{
            display: "flex", gap: 2, padding: 2, borderRadius: 999,
            background: "var(--cc-bg2, var(--bg-surface))",
            border: "1px solid var(--cc-border, var(--border-color))",
          }}
        >
          {[
            { id: "grid", Icon: LayoutGrid, label: "Grid layout" },
            { id: "scroll", Icon: Rows3, label: "Scrolling layout, grouped by folder" },
          ].map(({ id, Icon, label }) => (
            <button
              key={id}
              onClick={() => setLayoutMode(id)}
              className="transition-colors hover-bg-surface"
              style={{
                display: "flex", padding: 4, borderRadius: 999,
                color: layoutMode === id ? "var(--cc-accent, var(--accent))" : "var(--cc-dim, var(--text-secondary))",
                background: layoutMode === id
                  ? "color-mix(in srgb, var(--cc-accent, #4ea1e8) 18%, transparent)"
                  : "transparent",
              }}
              title={label}
              aria-label={label}
              aria-pressed={layoutMode === id}
            >
              <Icon size={15} />
            </button>
          ))}
        </div>
  );

  // Only meaningful in scroll mode -- the grid has fixed cells, so there is no
  // short row for a group to fill. Hidden rather than disabled: a permanently
  // dead control in the main bar is worse than no control.
  const fillToggle = !setFillWidth || layoutMode !== "scroll" ? null : (
    <button
      onClick={() => setFillWidth((v) => !v)}
      className="transition-colors hover-bg-surface"
      style={{
        display: "flex",
        padding: 4,
        borderRadius: 999,
        color: fillWidth ? "var(--cc-accent, var(--accent))" : "var(--cc-dim, var(--text-secondary))",
        background: fillWidth
          ? "color-mix(in srgb, var(--cc-accent, #4ea1e8) 18%, transparent)"
          : "transparent",
        border: "1px solid var(--cc-border, var(--border-color))",
      }}
      title={
        fillWidth
          ? "Each folder fills the width — a folder with one session gets the whole row"
          : "Every folder shares one column rhythm, so short folders leave a gap"
      }
      aria-label="Fill width per folder"
      aria-pressed={Boolean(fillWidth)}
    >
      <StretchHorizontal size={15} />
    </button>
  );

  const controls = (
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

      {/* Provider keys. There is more than one credentialed provider now
          (OpenRouter, and a Plexar-LLM rig reached the same way — an address
          and a bearer token), so the key icon opens a chooser rather than one
          provider's dialog. The model picker's disabled-group hints point
          here by name, so this control must stay the single place a user goes
          to make a provider group light up. */}
      <div className="relative">
        <button
          onClick={() => { const wasOpen = keysOpen; closeAll(); setKeysOpen(!wasOpen); }}
          className="transition-colors hover-bg-surface"
          style={{ display: "flex", padding: 5, borderRadius: 7, color: "var(--cc-dim, var(--text-secondary))" }}
          title="Provider keys"
          aria-label="Provider keys"
          aria-expanded={keysOpen}
          aria-haspopup="menu"
        >
          <KeyRound size={16} />
        </button>
        {keysOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setKeysOpen(false)} aria-hidden="true" />
            <div
              role="menu"
              aria-label="Provider keys"
              className="absolute right-0 mt-1 rounded-lg py-1 z-50"
              style={{
                minWidth: 190,
                backgroundColor: "var(--bg-elevated)",
                border: "1px solid var(--border-color)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              }}
            >
              <button
                role="menuitem"
                onClick={() => { setKeysOpen(false); setOpenRouterOpen(true); }}
                className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                style={{ color: "var(--text-primary)" }}
              >
                OpenRouter
              </button>
              <button
                role="menuitem"
                onClick={() => { setKeysOpen(false); setPlexarOpen(true); }}
                className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                style={{ color: "var(--text-primary)" }}
              >
                Plexar-LLM
              </button>
            </div>
          </>
        )}
      </div>

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

      {/* Harness picker — sits left of the model pill because it constrains it */}
      <div className="relative">
        <button
          onClick={() => { closeAll(); setHarnessOpen((v) => !v); }}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
          style={{
            color: "var(--text-secondary)",
            border: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-surface)",
          }}
          aria-label={`Harness: ${currentHarness.label}`}
          aria-expanded={harnessOpen}
          aria-haspopup="listbox"
          title="CLI new sessions are spawned against"
        >
          {currentHarness.label}
          <ChevronDown size={10} />
        </button>
        {harnessOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setHarnessOpen(false)} aria-hidden="true" />
            <div
              role="listbox"
              aria-label="Harness"
              className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[140px]"
              style={{
                backgroundColor: "var(--bg-elevated)",
                border: "1px solid var(--border-color)",
                boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
              }}
            >
              {HARNESSES.map((h) => (
                <button
                  key={h.id}
                  role="option"
                  aria-selected={h.id === harness}
                  onClick={() => { setHarness?.(h.id); setHarnessOpen(false); }}
                  className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                  style={{
                    color: h.id === harness ? "var(--accent)" : "var(--text-secondary)",
                    fontWeight: h.id === harness ? 600 : 400,
                  }}
                >
                  {h.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Plexar Harness sessions take model, effort and approvals from the harness
          itself (set inside each session's header), so the Claude/Codex launch pills
          do not apply. Shown as a visible reason, never as silently inert controls.
          The stored Claude model is kept untouched for when the user switches back. */}
      {isPlexarHarness ? (
        harnessModelsSourceNone && !harnessModelsLoading && !harnessModelsError ? (
          <>
            {/* No configOptions have ever been observed (source "none") --
                neither this process nor a prior one has started a Plexar
                Harness session, so there is nothing to pick from yet. */}
            <span
              className="text-xs px-3 py-1 rounded-full"
              style={{ color: "var(--text-secondary)", border: "1px solid var(--border-color)" }}
              data-testid="harness-model-pill"
              title="No Plexar Harness session has started yet; the model will be the harness's own default"
            >
              Model: harness default
            </span>
            <span
              className="text-xs px-3 py-1"
              style={{ color: "var(--text-muted)" }}
              title="This model's effort choices are not known until the harness session starts"
            >
              effort set after start
            </span>
          </>
        ) : (
        <>
          {/* Plexar Harness model picker */}
          <div className="relative">
            <button
              onClick={() => { closeAll(); setHarnessModelOpen((v) => !v); if (!harnessModelOpen) fetchHarnessModels(); }}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
              style={{
                color: harnessModelsError ? "var(--cc-error, var(--text-secondary))" : "var(--text-secondary)",
                border: "1px solid var(--border-color)",
                backgroundColor: "var(--bg-surface)",
              }}
              aria-label={
                harnessModelsLoading
                  ? "Plexar Harness model: loading"
                  : harnessModelsError
                    ? `Plexar Harness model: ${harnessModelsError}`
                    : `Plexar Harness model: ${selectedHarnessModelRow?.label || harnessModel || "none selected"}`
              }
              aria-expanded={harnessModelOpen}
              aria-haspopup="listbox"
              data-testid="harness-model-pill"
            >
              {harnessModelsLoading
                ? "Loading…"
                : harnessModelsError
                  ? "Model: unavailable"
                  : selectedHarnessModelRow?.label || harnessModel || "Select model"}
              <ChevronDown size={10} />
            </button>
            {harnessModelOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setHarnessModelOpen(false)} aria-hidden="true" />
                <div
                  role="listbox"
                  aria-label="Plexar Harness model"
                  className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[170px]"
                  style={{
                    backgroundColor: "var(--bg-elevated)",
                    border: "1px solid var(--border-color)",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                  }}
                >
                  {harnessModelsError && (
                    <div role="alert" className="text-[11px] px-3 py-1.5" style={{ color: "var(--cc-error, var(--text-muted))" }}>
                      {harnessModelsError}
                    </div>
                  )}
                  {!harnessModelsError && harnessModels.length === 0 && !harnessModelsLoading && (
                    <div className="text-[11px] px-3 py-1.5" style={{ color: "var(--text-muted)" }}>
                      No models available
                    </div>
                  )}
                  {harnessModels.map((m) => (
                    <button
                      key={m.id}
                      role="option"
                      aria-selected={m.id === harnessModel}
                      onClick={() => { setHarnessModel(m.id); setHarnessModelOpen(false); }}
                      className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                      style={{
                        color: m.id === harnessModel ? "var(--accent)" : "var(--text-secondary)",
                        fontWeight: m.id === harnessModel ? 600 : 400,
                      }}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Plexar Harness effort picker — follows the SELECTED model's own
              effort list (never a global list). `efforts: null` (genuinely
              unknown for this model) renders the "effort set after start"
              label; `efforts: []` (observed — this model has no effort
              control at all) renders NEITHER control nor label. The two must
              never collapse into one rendering. */}
          {harnessHasEfforts ? (
            <div className="relative">
              <button
                onClick={() => { closeAll(); setHarnessEffortOpen((v) => !v); }}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
                style={{
                  color: harnessEffortUnavailable ? "var(--cc-error, var(--text-secondary))" : "var(--text-secondary)",
                  border: "1px solid var(--border-color)",
                  backgroundColor: "var(--bg-surface)",
                }}
                aria-label={
                  harnessEffortUnavailable
                    ? `Plexar Harness effort: ${effectiveHarnessEffort} — not available for this model`
                    : `Plexar Harness effort: ${effectiveHarnessEffort || "provider default"}`
                }
                title={harnessEffortUnavailable ? "Not offered for this model" : undefined}
                aria-expanded={harnessEffortOpen}
                aria-haspopup="listbox"
                data-testid="harness-effort-pill"
              >
                {effectiveHarnessEffort || "default"}
                <ChevronDown size={10} />
              </button>
              {harnessEffortOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setHarnessEffortOpen(false)} aria-hidden="true" />
                  <div
                    role="listbox"
                    aria-label="Plexar Harness effort"
                    className="absolute right-0 mt-1 rounded-lg py-1 z-50 min-w-[110px]"
                    style={{
                      backgroundColor: "var(--bg-elevated)",
                      border: "1px solid var(--border-color)",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
                    }}
                  >
                    {harnessModelEfforts.map((eid) => (
                      <button
                        key={eid}
                        role="option"
                        aria-selected={eid === effectiveHarnessEffort}
                        onClick={() => { setHarnessEffort(eid); setHarnessEffortOpen(false); }}
                        className="block w-full text-left text-xs px-3 py-1.5 transition-colors hover-bg-surface"
                        style={{
                          color: eid === effectiveHarnessEffort ? "var(--accent)" : "var(--text-secondary)",
                          fontWeight: eid === effectiveHarnessEffort ? 600 : 400,
                        }}
                      >
                        {eid || "provider default"}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ) : harnessEffortsUnknown ? (
            <span
              className="text-xs px-3 py-1"
              style={{ color: "var(--text-muted)" }}
              title="This model's effort choices are not known until the harness session starts"
            >
              effort set after start
            </span>
          ) : null}
        </>
        )
      ) : (
      <>
      {/* Model picker */}
      <div className="relative">
        <button
          onClick={() => { closeAll(); setModelOpen((v) => !v); }}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1 rounded-full transition-colors hover-bg-elevated"
          style={{
            color: modelFlagged ? "var(--cc-waiting, var(--text-secondary))" : "var(--text-secondary)",
            border: `1px solid ${modelFlagged ? "var(--cc-waiting, var(--border-color))" : "var(--border-color)"}`,
            backgroundColor: modelFlagged
              ? "color-mix(in srgb, var(--cc-waiting, #0f1216) 12%, var(--bg-surface))"
              : "var(--bg-surface)",
          }}
          aria-label={
            selectionUnserved
              ? `Model: ${modelSelection.label} — not being served, sessions will fail`
              : modelUnknown
                ? `Model: ${modelSelection.label} — not in the model catalog`
                : `Model: ${modelSelection.label}`
          }
          title={
            selectionUnserved
              ? "The engine is not serving this model — a new session on it will fail. Pick the served model, or restart the engine with this one."
              : modelUnknown
                ? MODEL_UNKNOWN_TITLE
                : undefined
          }
          aria-expanded={modelOpen}
          aria-haspopup="listbox"
        >
          {modelSelection.label}
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
              {visibleGroups.map((group, gi) => {
                const isOpenRouterGroup = group.provider === "openrouter";
                const isLocalGroup = group.provider === "local";
                // A local group the user configured by hand (URL + key) is
                // live on that basis alone — the master local-inference flag
                // is an Engine-page toggle, and requiring it as well means a
                // correctly-configured rig still reads as unavailable.
                const localUsable = localLaunchEnabled || group.configured === true;
                const groupDisabled = (isOpenRouterGroup && !openRouterConfigured) || (isLocalGroup && !localUsable);
                // A group may carry its own note — e.g. a local provider that
                // does not publish a model list. That is NOT an offline claim,
                // so it must not be phrased or styled as an error.
                const groupHint = group.note
                  ? group.note
                  : isLocalGroup && !localUsable
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
                        role="note"
                        className="text-[10px] px-3 pb-1"
                        style={{ color: "var(--text-muted)", fontStyle: "italic" }}
                      >
                        {groupHint}
                      </div>
                    )}
                    {group.models.map((m) => {
                      // A local model the engine is not serving, on a provider
                      // Plexar Studio cannot load into. Picking it would point the
                      // session at something unservable — so it is not
                      // pickable at all. It stays VISIBLE (the list doubles as
                      // "what is on disk"), just never selectable.
                      const unservable = isLocalGroup && m.selectable === false;
                      const disabled =
                        (isOpenRouterGroup && !openRouterConfigured) ||
                        (isLocalGroup && !localUsable) ||
                        unservable;
                      const showLoad =
                        isLocalGroup &&
                        localUsable &&
                        m.loaded === false &&
                        m.canLoad !== false &&
                        onLoadLocalModel;
                      const loading = showLoad && localBusyModelId === m.localModelId;
                      const rowReason = unservable ? m.unavailableReason || groupHint : groupHint;
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
                            title={rowReason || undefined}
                          >
                            {m.label}
                          </button>
                          {unservable && (
                            <span
                              role="note"
                              aria-label={`${m.localModelId}: ${m.unavailableReason || UNSERVED_ROW_TAG}`}
                              title={m.unavailableReason || undefined}
                              className="text-[10px]"
                              style={{
                                flexShrink: 0,
                                marginRight: 6,
                                padding: "1px 6px",
                                borderRadius: 4,
                                whiteSpace: "nowrap",
                                color: "var(--cc-waiting, var(--text-muted))",
                                border: "1px solid color-mix(in srgb, var(--cc-waiting, #0f1216) 45%, transparent)",
                              }}
                            >
                              {UNSERVED_ROW_TAG}
                            </span>
                          )}
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
        aria-label={
          fastEligible
            ? (fast ? "Fast mode on" : "Fast mode off")
            : isCodexHarness
              ? "Fast mode (not available for Codex)"
              : "Fast mode (Opus models only)"
        }
        aria-pressed={fastEligible && fast}
        disabled={!fastEligible}
        title={
          isCodexHarness
            ? "Not available for Codex"
            : isOpenRouterModel
            ? "Not available for OpenRouter models"
            : fastEligible
              ? "Toggle fast mode for new sessions"
              : "Fast mode is only available for Opus models"
        }
      >
        Fast
      </button>
      </>
      )}

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
  );

  // The Inspector had a collapse button and NO way back -- a one-way door only
  // a reload undid. This is the way back, and it pairs with the sidebar toggle
  // so both panels are reopened from the same place.
  const inspectorToggle = !setInspectorOpen ? null : (
    <button
      onClick={() => setInspectorOpen((v) => !v)}
      className="transition-colors hover-bg-surface"
      style={{
        display: "flex",
        padding: 5,
        borderRadius: 7,
        color: inspectorOpen
          ? "var(--cc-accent, var(--accent))"
          : "var(--cc-dim, var(--text-secondary))",
      }}
      title={inspectorOpen ? "Hide inspector" : "Show inspector"}
      aria-label="Toggle inspector"
      aria-pressed={Boolean(inspectorOpen)}
    >
      <PanelRight size={17} />
    </button>
  );

  const modal = (
    <>
      <OpenRouterModal
        open={openRouterOpen}
        onClose={() => setOpenRouterOpen(false)}
        onToast={onToast}
      />
      <PlexarKeyModal
        open={plexarOpen}
        onClose={() => setPlexarOpen(false)}
        onToast={onToast}
      />
    </>
  );

  if (embedded) {
    // View toggles sit at the FAR RIGHT as a pair, the way editors group panel
    // toggles. The command bar's left is the workspace's identity; interleaving
    // controls there would bury the title.
    return (
      <div className="flex items-center relative" style={{ gap: 7 }}>
        {layoutToggle}
        {fillToggle}
        {controls}
        {sidebarToggle}
        {inspectorToggle}
        {modal}
      </div>
    );
  }

  return (
    <header
      className="flex items-center justify-between flex-shrink-0 relative z-30"
      style={{ padding: "0 16px", height: 48, borderBottom: "1px solid var(--cc-border, var(--border-color))" }}
    >
      <div className="flex items-center" style={{ gap: 11 }}>
        {sidebarToggle}
        {layoutToggle}
        {fillToggle}
        <LogoMark size={25} />
      </div>
      <div className="flex items-center" style={{ gap: 7 }}>{controls}{inspectorToggle}</div>
      {modal}
    </header>
  );
}