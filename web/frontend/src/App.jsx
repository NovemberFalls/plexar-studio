import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader, ExternalLink } from "lucide-react";
import TopBar, { getModelProvider, MODELS } from "./components/TopBar";
import { parseLocalModelId } from "./modelCatalog";
import Sidebar from "./components/Sidebar";
import TerminalPane from "./components/TerminalPane";
import NewSessionDialog from "./components/NewSessionDialog";
import { useToast, ToastContainer } from "./components/Toast";
import OnboardingModal from "./components/OnboardingModal";
import BridgeModal from "./components/BridgeModal";
import FleetView from "./components/FleetView";
import ProviderPicker from "./components/ProviderPicker";
import EngineView from "./components/engine/EngineView";
import ReportsView from "./components/reports/ReportsView";
import { ZOOM_STORAGE_KEY, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, DEFAULT_SPAWN_COLS, DEFAULT_SPAWN_ROWS } from "./utils/terminalFit";
import { computeEndEvents, formatEndEventToast, buildBusyTerminalIds, BRIDGE_KIND, CHANNEL_KIND } from "./utils/bridgeEvents";
// Redesigned shell chrome (design handoff "Workspace — the approved shell").
import Rail from "./components/shell/Rail";
import CommandBar from "./components/shell/CommandBar";
import LaneStrip from "./components/shell/LaneStrip";
import Inspector from "./components/shell/Inspector";
import StatusStrip from "./components/shell/StatusStrip";
import SettingsView from "./components/settings/SettingsView";
import { DEFAULT_SETTINGS_SECTION } from "./components/settings/SettingsNav";
import { laneLive, predictedWaitSeconds, pressureFraction } from "./utils/laneMath";
import { useLocalModelsPoller } from "./hooks/useLocalModels";

const LOCATIONS_KEY = "cockpit-locations";
const RECENTS_KEY = "cockpit-recent-locations";
const SESSIONS_KEY = "cockpit-sessions";
const ONBOARDING_KEY = "cockpit-onboarding-suppressed";
const WORKSPACES_KEY = "cockpit-workspaces";
const MODEL_KEY = "cockpit-model";
const PERMISSION_MODE_KEY = "cockpit-permission-mode";
const EFFORT_KEY = "cockpit-effort";
const FAST_KEY = "cockpit-fast";
const LAYOUT_KEY = "cockpit-layout";
const FLIP_KEY = "cockpit-flip";

/** Canonical key for a working directory in path-keyed maps (`gitStatuses`).
 *  Backslash-normalized with any trailing separator stripped. Both the writer
 *  and every reader MUST go through this — indexing such a map with a raw
 *  `workdir` silently misses whenever the path uses forward slashes or ends in a
 *  separator, which is how the Inspector lost its git row while the sidebar kept
 *  showing one for the same folder. */
function normalizeWorkdir(dir) {
  if (typeof dir !== "string" || !dir) return "";
  return dir.replace(/\//g, "\\").replace(/\\$/, "");
}

/** Command-bar title per rail destination. "projects" is absent by design — it
 *  opens the drawer over Workspace rather than replacing the content area. */
const SECTION_TITLES = {
  work: "Workspace",
  fleet: "Fleet",
  engine: "Engine",
  reports: "Reports",
  settings: "Settings",
};

/** Shown in the status strip. Sourced from the Vite-injected package version so
 *  it cannot drift from the installer the user actually ran. */
const APP_VERSION = import.meta.env?.VITE_APP_VERSION || null;

/** Spill threshold for the interactive class, in SECONDS of predicted wait (not
 *  queue depth — see utils/laneMath.js). Mirrors the broker's own
 *  `--spill-interactive 30.0` default, used until /config/spill reports back. */
const DEFAULT_INTERACTIVE_SPILL_SECONDS = 30;

/**
 * Adaptive layout engine (README "Adaptive Layout Engine" table).
 * Returns { cols, rows, areas: [{ col, row }] } where col/row are
 * CSS grid-column / grid-row shorthand strings. `flip` mirrors the
 * featured column for n ∈ {3,5,7}.
 */
function computeLayout(n, flip) {
  const A = (col, row) => ({ col, row });
  switch (n) {
    case 1:
      return { cols: "1fr", rows: "1fr", areas: [A("1 / 2", "1 / 2")] };
    case 2:
      return { cols: "1fr 1fr", rows: "1fr", areas: [A("1 / 2", "1 / 2"), A("2 / 3", "1 / 2")] };
    case 3: {
      const fc = flip ? "2 / 3" : "1 / 2", sc = flip ? "1 / 2" : "2 / 3";
      return { cols: "1fr 1fr", rows: "1fr 1fr", areas: [A(fc, "1 / 3"), A(sc, "1 / 2"), A(sc, "2 / 3")] };
    }
    case 4:
      return {
        cols: "1fr 1fr", rows: "1fr 1fr",
        areas: [A("1 / 2", "1 / 2"), A("2 / 3", "1 / 2"), A("1 / 2", "2 / 3"), A("2 / 3", "2 / 3")],
      };
    case 5: {
      const fc = flip ? "2 / 3" : "1 / 2", sc = flip ? "1 / 2" : "2 / 3";
      const a = [A(fc, "1 / 5")];
      for (let i = 0; i < 4; i++) a.push(A(sc, (i + 1) + " / " + (i + 2)));
      return { cols: flip ? "1fr 1.5fr" : "1.5fr 1fr", rows: "repeat(4,1fr)", areas: a };
    }
    case 6: {
      const a = [];
      for (let i = 0; i < 6; i++) { const c = (i % 3) + 1, r = Math.floor(i / 3) + 1; a.push(A(c + " / " + (c + 1), r + " / " + (r + 1))); }
      return { cols: "repeat(3,1fr)", rows: "1fr 1fr", areas: a };
    }
    case 7: {
      const fc = flip ? "3 / 4" : "1 / 2";
      const others = flip ? ["1 / 2", "2 / 3"] : ["2 / 3", "3 / 4"];
      const a = [A(fc, "1 / 4")];
      for (let k = 0; k < 6; k++) { const r = Math.floor(k / 2) + 1; a.push(A(others[k % 2], r + " / " + (r + 1))); }
      return { cols: flip ? "1fr 1fr 1.5fr" : "1.5fr 1fr 1fr", rows: "repeat(3,1fr)", areas: a };
    }
    case 8:
    default: {
      const a = [];
      const count = 8;
      for (let i = 0; i < count; i++) { const c = (i % 4) + 1, r = Math.floor(i / 4) + 1; a.push(A(c + " / " + (c + 1), r + " / " + (r + 1))); }
      return { cols: "repeat(4,1fr)", rows: "1fr 1fr", areas: a };
    }
  }
}

/** Layouts with a distinct featured cell that flip supports. */
const FEATURED_LAYOUTS = new Set([3, 5, 7]);

/** Safe localStorage helpers — silently swallow quota/security errors */
function lsLoad(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
  catch (_) { return fallback; }
}
function lsSave(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
}

function loadSavedLocations() {
  const raw = lsLoad(LOCATIONS_KEY);
  return raw.map((item) =>
    typeof item === "string" ? { path: item, bypassPermissions: false } : item
  );
}

function loadSavedSessions() { return lsLoad(SESSIONS_KEY); }

function saveSessions(sessions) {
  const toSave = sessions
    .filter((s) => s.status !== "error" && s.status !== "history")
    .map(({ name, model, workdir }) => ({ name, model, workdir }));
  lsSave(SESSIONS_KEY, toSave);
}

/** Send a desktop notification if the window is not focused */
function notifyActivityChange(name, terminalId, prevState, currState) {
  if (!("Notification" in window) || Notification.permission !== "granted" || document.hasFocus()) return;
  if (!prevState || !currState) return;
  if (currState === "waiting" && prevState !== "waiting") {
    new Notification("Action Required", { body: `${name} is waiting for approval`, tag: `cockpit-${terminalId}` });
  } else if (currState === "idle" && prevState === "busy") {
    new Notification("Task Complete", { body: `${name} has finished`, tag: `cockpit-${terminalId}` });
  }
}

// ZOOM_STORAGE_KEY/DEFAULT_ZOOM/MIN_ZOOM/MAX_ZOOM imported from utils/terminalFit —
// PopoutTerminal.jsx (a separate window/document) reads the same constants
// directly from localStorage, so both must stay in lockstep.

let nextLocalId = 1;

// Find the first empty (null/undefined) slot within the visible layout range
function findEmptySlot(ids, maxSlots) {
  for (let i = 0; i < maxSlots; i++) {
    if (i >= ids.length || ids[i] == null) return i;
  }
  return -1;
}

export default function App() {
  const { toasts, toast, dismiss: dismissToast } = useToast();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const v = parseInt(localStorage.getItem("cockpit-sidebar-width") || "", 10);
    return Number.isFinite(v) ? Math.min(520, Math.max(236, v)) : 236;
  });
  const startSidebarResize = useCallback((e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev) => {
      const w = Math.min(520, Math.max(236, startW + (ev.clientX - startX)));
      setSidebarWidth(w);
    };
    const onUp = (ev) => {
      const w = Math.min(520, Math.max(236, startW + (ev.clientX - startX)));
      localStorage.setItem("cockpit-sidebar-width", String(w));
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth]);
  const [terminalZoom, setTerminalZoom] = useState(() => {
    const saved = lsLoad(ZOOM_STORAGE_KEY, DEFAULT_ZOOM);
    return (saved >= MIN_ZOOM && saved <= MAX_ZOOM) ? saved : DEFAULT_ZOOM;
  });
  const [zoomToast, setZoomToast] = useState(null);
  const zoomToastTimer = useRef(null);
  const [model, setModel] = useState(() => lsLoad(MODEL_KEY, "sonnet"));
  useEffect(() => { lsSave(MODEL_KEY, model); }, [model]);
  const [permissionMode, setPermissionMode] = useState(() => lsLoad(PERMISSION_MODE_KEY, "default"));
  useEffect(() => { lsSave(PERMISSION_MODE_KEY, permissionMode); }, [permissionMode]);
  const [effort, setEffort] = useState(() => lsLoad(EFFORT_KEY, ""));
  useEffect(() => { lsSave(EFFORT_KEY, effort); }, [effort]);
  const [fast, setFast] = useState(() => lsLoad(FAST_KEY, false));
  useEffect(() => { lsSave(FAST_KEY, fast); }, [fast]);
  const [layout, setLayout] = useState(() => {
    const v = lsLoad(LAYOUT_KEY, 4);
    return typeof v === "number" && v >= 1 && v <= 8 ? v : 4;
  });
  useEffect(() => { lsSave(LAYOUT_KEY, layout); }, [layout]);
  const [flipLayout, setFlipLayout] = useState(() => lsLoad(FLIP_KEY, false) === true);
  useEffect(() => { lsSave(FLIP_KEY, flipLayout); }, [flipLayout]);
  // Featured pane = currently-focused pane index (drives 3/5/7 featured slot)
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [user, setUser] = useState(null);
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState(false);

  // Sessions: { id (local), name, terminalId (backend), model, status, workdir }
  const [sessions, setSessions] = useState([]);
  const [activeIds, setActiveIds] = useState([]);
  const [savedLocations, setSavedLocations] = useState(loadSavedLocations);
  const [recentLocations, setRecentLocations] = useState(() => lsLoad(RECENTS_KEY));
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [gitStatuses, setGitStatuses] = useState({});
  const [bridgeModal, setBridgeModal] = useState({ open: false, fromSessionId: null });
  const [activeBridges, setActiveBridges] = useState([]); // array of bridge dicts from /api/bridge
  const [channels, setChannels] = useState([]); // array of channel dicts from /api/bridge/channel
  // Set of TERMINAL IDs (backend strings), NOT local session ids. The comment
  // here used to say "session IDs", which is how a consumer came to call
  // .has(session.id) — always false, since session.id is a local number. Every
  // read must use session.terminalId.
  const [poppedOutIds, setPoppedOutIds] = useState(new Set());
  const [workflowsByTerminal, setWorkflowsByTerminal] = useState({}); // { [terminalId]: { count, inProgressCount, items } }
  const [usageByTerminal, setUsageByTerminal] = useState({}); // { [terminalId]: { ...session_summary, effort, tokensPerSec } }
  const [dailyUsage, setDailyUsage] = useState(null); // usage_tracker.daily_summary() shape
  // ── Shell navigation ──────────────────────────────────────────────────────
  // ONE source of truth for which destination is showing. The legacy
  // showFleetView / showLocalBroker booleans are DERIVED from it below, so
  // every existing call site keeps working while the rail gains Projects /
  // Reports / Settings. Two independent booleans is what previously allowed
  // Fleet and Broker to both be "open" at once, each clearing the other by
  // hand at every call site.
  const [activeSection, setActiveSection] = useState("work"); // work|projects|fleet|engine|reports|settings
  // Which Settings page is showing. Kept in App rather than inside SettingsView
  // so it survives navigating away to Workspace and back, and so a future
  // command-palette deep link ("go to Settings > Design tokens") can set it.
  const [settingsSection, setSettingsSection] = useState(DEFAULT_SETTINGS_SECTION);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // Engine's selected tab (Live|Models|Requests|API|Logs). Held here so it
  // survives leaving and re-entering the section.
  const [engineTab, setEngineTab] = useState("live");
  // terminal_id → live activity state, so Reports can put a state dot on rows
  // for sessions that are still running. Historical rows have no live state and
  // are left undotted rather than shown as idle — "not running now" and "idle"
  // are different facts.
  const reportsStatusByTerminal = useMemo(() => {
    const map = {};
    for (const s of sessions) {
      if (s.terminalId) map[s.terminalId] = s.activityState || s.status || null;
    }
    return map;
  }, [sessions]);
  // Last pane slot each session occupied, so activating a session from
  // Projects/Fleet/palette focuses its own pane instead of reshuffling the grid.
  const [paneSlotBySession, setPaneSlotBySession] = useState(() => new Map());
  const showFleetView = activeSection === "fleet";
  const showLocalBroker = activeSection === "engine";
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  // Local model broker (machine-global): queue + metrics. Polling is gated on
  // localEnabled so a disabled feature does zero background work.
  const [localEnabled, setLocalEnabled] = useState(() => {
    try { return localStorage.getItem("cockpit-local-enabled") === "true"; } catch (_) { return false; }
  });
  const [localQueue, setLocalQueue] = useState(null);   // GET /api/local/queue, or null/offline
  const [localMetrics, setLocalMetrics] = useState(null); // GET /api/local/metrics
  // GET /api/local/spill (per-class thresholds + counters). The VALUE is now
  // read (the lane strip's trigger and toggle come from it) — it used to be
  // write-only, which is why the meter had no real threshold to measure against.
  const [localSpill, setLocalSpill] = useState(null);
  const [localStatus, setLocalStatus] = useState(null); // GET /api/local/status — what's actually connected
  const [metricsWindow] = useState("lifetime"); // lifetime | 24h | session (legacy TopBar quick-glance poller)
  // Provider registry (ProviderPicker owns the fetch + localStorage selection;
  // this mirrors the full selected provider object back up so App can gate
  // per-capability polling and panel rendering).
  const [selectedProvider, setSelectedProvider] = useState(null); // {id,label,kind,scope,capabilities} | null
  // GET /api/local/{id}/models and the load/unload busy marker live in the
  // shared useLocalModels store (one poller, every surface reads it) — see the
  // useLocalModelsPoller call below.
  // Drag-and-drop state for pane reordering
  const [dragSource, setDragSource] = useState(null);   // pane index being dragged
  const [dragOverSlot, setDragOverSlot] = useState(null); // slot index being hovered
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_KEY) !== "true"; } catch (_) { return true; }
  });
  const [workspacePresets, setWorkspacePresets] = useState(() => lsLoad(WORKSPACES_KEY, []));
  const paneRefs = useRef([]);
  const prevStatesRef = useRef({});
  // Bridge/channel end-event tracking (see utils/bridgeEvents.js) — last-seen
  // record per id + a permanent "already toasted" set, so a bridge/channel
  // ending fires exactly one Toast regardless of how many more polls observe
  // its terminal state before the backend's TTL prunes it.
  const prevBridgeStatesRef = useRef(new Map());
  const seenBridgeIdsRef = useRef(new Set());
  const prevChannelStatesRef = useRef(new Map());
  const seenChannelIdsRef = useRef(new Set());

  // System stats (polled from /api/system every 5s)
  const [systemStats, setSystemStats] = useState(null);

  // Auto-update check (Tauri desktop only)
  useEffect(() => {
    let cancelled = false;
    // Held outside the promise so cleanup can actually STOP the poll. Previously
    // only the `cancelled` flag was set on unmount, which gated the async
    // continuation but left this interval running for up to 2s — and its callback
    // touches `window`, so an unmount mid-poll threw "window is not defined"
    // after teardown. Harmless in the browser, but it makes tests flaky and
    // would leak a timer on any future remount.
    let tauriPoll = null;

    // Poll for Tauri IPC bridge (may not be injected immediately on remote URLs)
    const waitForTauri = () => new Promise((resolve) => {
      const isTauri = () => !!(
        typeof window !== "undefined" && (window.__TAURI_INTERNALS__ || window.__TAURI__)
      );
      if (isTauri()) return resolve(true);
      let attempts = 0;
      tauriPoll = setInterval(() => {
        attempts++;
        if (cancelled) { clearInterval(tauriPoll); resolve(false); return; }
        if (isTauri()) { clearInterval(tauriPoll); resolve(true); }
        else if (attempts >= 20) { clearInterval(tauriPoll); resolve(false); } // 2s max
      }, 100);
    });

    (async () => {
      const hasTauri = await waitForTauri();
      console.log("[updater] IPC bridge:", hasTauri ? "available" : "not found (browser mode)");
      if (!hasTauri || cancelled) return;
      try {
        console.log("[updater] Checking for updates...");
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        console.log("[updater] Result:", update ? `v${update.version} available` : "up to date");
        if (cancelled || !update) return;
        toast(
          `Update available: v${update.version}`,
          "info",
          0, // persistent until dismissed
          {
            label: "Install & Restart",
            onClick: async () => {
              try {
                toast("Downloading update...", "info", 0);
                // Shut down the backend sidecar before the NSIS installer runs.
                // Without this, Windows locks the sidecar exe and the installer
                // cannot replace it, leaving the old version running after restart.
                try { await fetch("/api/shutdown", { method: "POST" }); } catch (_) {}
                await new Promise((r) => setTimeout(r, 800)); // wait for process exit
                await update.downloadAndInstall();
                const { relaunch } = await import("@tauri-apps/plugin-process");
                await relaunch();
              } catch (err) {
                toast(`Update failed: ${err.message}`, "error");
              }
            },
          }
        );
      } catch (err) {
        console.error("[updater] check failed:", err);
      }
    })();
    return () => { cancelled = true; if (tauriPoll) clearInterval(tauriPoll); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- toast is stable (useCallback with empty deps); adding it would not cause re-runs but the rule can't verify stability across files
  }, []);


  // Health-check polling: wait for backend to be ready (re-runs on crash recovery)
  useEffect(() => {
    if (backendReady) return; // Already connected, nothing to do
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 60; // 30s at 500ms intervals (longer for crash recovery)

    const check = async () => {
      while (!cancelled && attempts < maxAttempts) {
        try {
          const res = await fetch("/api/me");
          if (res.ok) {
            const data = await res.json();
            if (!cancelled) {
              setBackendReady(true);
              setBackendError(false);
              setUser(data);
            }
            return;
          }
        } catch (_) {
          // Backend not up yet
        }
        attempts++;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!cancelled) setBackendError(true);
    };

    check();
    return () => { cancelled = true; };
  }, [backendReady]);

  // Add locations to the curated list (deduped by path, no cap)
  /** Update savedLocations with a transform and persist */
  const updateLocations = useCallback((fn) => {
    setSavedLocations((prev) => {
      const next = fn(prev);
      lsSave(LOCATIONS_KEY, next);
      return next;
    });
  }, []);

  const addLocations = useCallback((dirs) => {
    updateLocations((prev) => {
      const byPath = new Map(prev.map((loc) => [loc.path, loc]));
      dirs.forEach((d) => {
        if (d && !byPath.has(d)) byPath.set(d, { path: d, bypassPermissions: false });
      });
      return [...byPath.values()];
    });
  }, [updateLocations]);

  const removeLocation = useCallback((dir) => {
    updateLocations((prev) => prev.filter((l) => l.path !== dir));
  }, [updateLocations]);

  const toggleLocationBypass = useCallback((dir) => {
    updateLocations((prev) =>
      prev.map((l) => l.path === dir ? { ...l, bypassPermissions: !l.bypassPermissions } : l)
    );
  }, [updateLocations]);

  // Check if a location has bypass enabled
  const getLocationBypass = useCallback((dir) => {
    return savedLocations.find((l) => l.path === dir)?.bypassPermissions || false;
  }, [savedLocations]);

  // Create a new terminal session
  const createSession = useCallback(async (name, workdir, sessionModel, options = {}) => {
    const localId = nextLocalId++;
    const sessionName = name || `Session ${localId}`;
    const dir = workdir || "C:\\Code";
    const useModel = sessionModel || model;

    addLocations([dir]);

    setRecentLocations((prev) => {
      const next = [dir, ...prev.filter((l) => l !== dir)].slice(0, 5);
      lsSave(RECENTS_KEY, next);
      return next;
    });

    const newSession = {
      id: localId,
      name: sessionName,
      terminalId: null,
      model: useModel,
      status: "starting",
      workdir: dir,
      bypassPermissions: !!options.bypassPermissions,
    };
    setSessions((prev) => [...prev, newSession]);
    setActiveIds((prev) => {
      const slot = findEmptySlot(prev, layout);
      if (slot === -1) return prev; // all panes full — user drags from sidebar to place
      const next = [...prev];
      while (next.length <= slot) next.push(null);
      next[slot] = localId;
      return next;
    });

    try {
      const isOpus = (
        useModel === "opus" ||
        useModel === "claude-opus-4-6[1m]" ||
        useModel === "claude-opus-4-7" ||
        useModel === "claude-opus-4-7[1m]" ||
        useModel === "claude-opus-4-8" ||
        useModel === "claude-opus-4-8[1m]"
      );
      const body = {
        name: sessionName,
        model: useModel,
        workdir: dir,
        // No mounted pane to measure yet at this point (see DEFAULT_SPAWN_COLS
        // doc comment in terminalFit.js) — TerminalPane's first safeFit()
        // corrects this immediately after mount.
        cols: DEFAULT_SPAWN_COLS,
        rows: DEFAULT_SPAWN_ROWS,
        permissionMode,
        effort,
        fast: isOpus && fast,
        ...(getModelProvider(useModel) === "openrouter"
          ? { provider: "openrouter", providerModel: useModel }
          : {}),
        ...(getModelProvider(useModel) === "local"
          ? (() => {
              const parsed = parseLocalModelId(useModel);
              return parsed
                ? { provider: "local", providerModel: `${parsed.providerId}::${parsed.modelId}` }
                : {};
            })()
          : {}),
        ...(options.continueSession ? { continue: true } : {}),
        ...(options.bypassPermissions ? { bypassPermissions: true } : {}),
        ...(options.resumeSessionId ? { resume_session_id: options.resumeSessionId } : {}),
      };

      const res = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (data.error) {
        toast(data.error, "error");
        setSessions((prev) =>
          prev.map((s) => s.id === localId ? { ...s, status: "error" } : s)
        );
        return;
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === localId ? { ...s, terminalId: data.id, status: "running" } : s
        )
      );
    } catch (_err) {
      toast("Failed to create session", "error");
      setSessions((prev) =>
        prev.map((s) => s.id === localId ? { ...s, status: "error" } : s)
      );
    }
  }, [model, permissionMode, effort, fast, layout, addLocations, toast]);

  // Remove a session (kills terminal on server) with 12s undo window.
  // Undo resumes via claude_session_id (exact session) if available, or
  // continueSession: true (most-recent session in workdir) as a fallback.
  // Note: claude_session_id is populated by the polling loop from /api/terminals
  // if the backend exposes that field. If it doesn't, undo falls back to
  // continueSession: true, which resumes the most-recent session in the workdir.
  const removeSession = useCallback(async (localId) => {
    const session = sessions.find((s) => s.id === localId);
    if (!session) return;

    // Kill backend terminal (best-effort — same behavior as before)
    if (session.terminalId) {
      fetch(`/api/terminals/${session.terminalId}`, { method: "DELETE" })
        .catch(() => toast("Failed to kill session on server", "error"));
    }

    // Remove from local state
    setSessions((prev) => prev.filter((s) => s.id !== localId));
    setActiveIds((prev) => prev.map((id) => id === localId ? null : id));

    // Quick Resume: 12s undo window. Skip the offer if the session never
    // produced any meaningful state (status was 'starting' or 'error' and
    // there is no claude_session_id to resume from).
    const canResume = session.terminalId && (
      !!session.claude_session_id || session.status === "running"
    );
    if (!canResume) return;

    toast(
      `Closed "${session.name}"`,
      "info",
      12000,
      {
        label: "Undo",
        onClick: () => {
          createSession(
            session.name,
            session.workdir,
            session.model,
            session.claude_session_id
              ? { resumeSessionId: session.claude_session_id, bypassPermissions: session.bypassPermissions }
              : { continueSession: true, bypassPermissions: session.bypassPermissions }
          );
        },
      }
    );
  }, [sessions, toast, createSession]);

  // Select a session: fill an empty pane slot if available, never auto-rearrange
  const selectSession = useCallback((id) => {
    setActiveIds((prev) => {
      // Check if already in a visible slot
      for (let i = 0; i < layout && i < prev.length; i++) {
        if (prev[i] === id) return prev;
      }
      const slot = findEmptySlot(prev, layout);
      if (slot === -1) return prev; // all panes full — user drags to place
      const next = [...prev];
      while (next.length <= slot) next.push(null);
      next[slot] = id;
      return next;
    });
  }, [layout]);

  // Explicitly place a session into a specific pane slot index
  const placeSession = useCallback((sessionId, slotIndex) => {
    setActiveIds((prev) => {
      const from = prev.indexOf(sessionId);
      if (from === slotIndex) return prev;
      const next = [...prev];
      while (next.length <= slotIndex) next.push(null);
      if (from !== -1) {
        // Already in activeIds: swap positions (target may be null = empty slot)
        const tmp = next[slotIndex];
        next[slotIndex] = sessionId;
        next[from] = tmp;
      } else {
        // Not in activeIds: place directly into target slot
        next[slotIndex] = sessionId;
      }
      return next;
    });
  }, []);

  // Persist sessions to localStorage
  const sessionCountRef = useRef(0);
  useEffect(() => {
    if (sessions.length !== sessionCountRef.current) {
      sessionCountRef.current = sessions.length;
      if (sessions.length > 0) saveSessions(sessions);
      else { try { localStorage.removeItem(SESSIONS_KEY); } catch (_) {} }
    }
  }, [sessions]);

  // Restore saved sessions once backend is ready.
  // Reattaches to surviving backend terminals by name match instead of spawning
  // new processes (which caused duplicate "ghost" sessions).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!backendReady || restoredRef.current) return;
    restoredRef.current = true;

    (async () => {
      const saved = loadSavedSessions();
      if (!saved.length) return;

      try {
        const res = await fetch("/api/terminals");
        const data = await res.json();
        const backendTerminals = data.terminals || [];

        if (backendTerminals.length === 0) {
          // Backend restarted — old sessions are gone. Clear stale data.
          console.log("[cockpit] Backend has no terminals — clearing stale saved sessions");
          localStorage.removeItem(SESSIONS_KEY);
          return;
        }

        // Match saved sessions to surviving backend terminals by name.
        // Reattach instead of creating new processes to avoid duplicates.
        // Unmatched backend terminals will be picked up by the polling loop.
        const claimed = new Set();
        const reattached = [];
        for (const s of saved) {
          const match = backendTerminals.find(
            (t) => t.alive && !claimed.has(t.id) && t.name === s.name
          );
          if (match) {
            claimed.add(match.id);
            reattached.push({
              id: nextLocalId++,
              name: s.name,
              terminalId: match.id,
              model: s.model || match.model || "sonnet",
              status: "running",
              workdir: s.workdir || match.working_dir || "",
              bypassPermissions: match.bypass_permissions || false,
              activityState: match.activity_state,
              tokens: match.tokens || 0,
              cost: match.cost || 0,
              context_percent: match.context_percent ?? null,
              // claude_session_id allows precise --resume on close/undo.
              // If the backend doesn't expose this field yet, it will be undefined
              // and removeSession will fall back to continueSession: true.
              claude_session_id: match.claude_session_id || null,
            });
          }
        }

        if (reattached.length > 0) {
          console.log(`[cockpit] Reattached ${reattached.length} session(s) to surviving backend terminals`);
          setSessions(reattached);
          setActiveIds(reattached.map((s) => s.id).slice(0, layout));
          addLocations(reattached.map((s) => s.workdir).filter(Boolean));
        } else {
          // No saved sessions matched surviving terminals — stale data
          console.log("[cockpit] No saved sessions matched surviving terminals — clearing");
          localStorage.removeItem(SESSIONS_KEY);
        }
      } catch (_) {
        // Backend unreachable — don't restore, don't clear
        return;
      }
    })();
  }, [backendReady, layout, addLocations]);

  // Request notification permission
  const notifRequested = useRef(false);
  useEffect(() => {
    if (sessions.length > 0 && !notifRequested.current && "Notification" in window) {
      notifRequested.current = true;
      if (Notification.permission === "default") {
        Notification.requestPermission();
      }
    }
  }, [sessions.length]);

  // Poll /api/terminals every 3s — detect backend death and trigger recovery
  const pollFailCount = useRef(0);
  useEffect(() => {
    if (!backendReady) return;
    pollFailCount.current = 0;
    const poll = async () => {
      try {
        const res = await fetch("/api/terminals");
        if (!res.ok) throw new Error("not ok");
        pollFailCount.current = 0; // Reset on success
        const data = await res.json();
        const termMap = {};
        for (const t of data.terminals) {
          termMap[t.id] = t;
        }

        setSessions((prev) => {
            let changed = false;

            const updated = prev.map((s) => {
              if (!s.terminalId || !termMap[s.terminalId]) return s;
              const t = termMap[s.terminalId];
              const newState = t.activity_state;
              const newTokens = t.tokens || 0;
              const newCost = t.cost || 0;
              const newContextPercent = t.context_percent ?? null;
              const newClaudeSessionId = t.claude_session_id || null;
              if (
                s.activityState === newState &&
                s.tokens === newTokens &&
                s.cost === newCost &&
                s.context_percent === newContextPercent &&
                s.claude_session_id === newClaudeSessionId
              ) {
                return s;
              }
              changed = true;
              return { ...s, activityState: newState, tokens: newTokens, cost: newCost, context_percent: newContextPercent, claude_session_id: newClaudeSessionId };
            });

            const result = changed ? updated : prev;

            for (const s of result) {
              if (!s.terminalId) continue;
              notifyActivityChange(s.name, s.terminalId, prevStatesRef.current[s.terminalId], s.activityState);
              prevStatesRef.current[s.terminalId] = s.activityState;
            }

            return result;
          });
      } catch (_) {
        pollFailCount.current++;
        // After 3 consecutive failures (~9s), backend is dead — trigger recovery
        if (pollFailCount.current >= 3) {
          console.warn("[cockpit] Backend unreachable — entering recovery mode");
          setBackendReady(false);
          restoredRef.current = false; // Allow session restore on reconnect
        }
      }
    };
    const id = setInterval(poll, 3000);
    poll();
    return () => clearInterval(id);
  }, [backendReady]);

  // Poll git status (local mode only)
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const savedLocationsRef = useRef(savedLocations);
  savedLocationsRef.current = savedLocations;

  useEffect(() => {
    if (!backendReady) return;
    const fetchGit = async () => {
      const dirs = new Set([
        ...sessionsRef.current.map((s) => s.workdir).filter(Boolean),
        ...savedLocationsRef.current.map((l) => l.path),
      ]);
      if (dirs.size === 0) return;
      const results = {};
      const entries = [...dirs];
      const fetches = entries.map(async (dir) => {
        try {
          const url = `/api/git/status?path=${encodeURIComponent(dir)}`;
          const res = await fetch(url);
          if (res.ok) {
            const data = await res.json();
            results[normalizeWorkdir(dir)] = data;
          }
        } catch (_) { /* skip */ }
      });
      await Promise.all(fetches);
      setGitStatuses(results);
    };
    fetchGit();
    const id = setInterval(fetchGit, 30000);
    return () => clearInterval(id);
  }, [backendReady]);

  // Poll /api/system every 5s for CPU/RAM/GPU stats
  useEffect(() => {
    if (!backendReady) return;
    const fetchStats = async () => {
      try {
        const res = await fetch("/api/system");
        if (!res.ok) return;
        const data = await res.json();
        setSystemStats(data);
      } catch (_) {
        // leave systemStats unchanged on error
      }
    };
    fetchStats();
    const id = setInterval(fetchStats, 5000);
    return () => clearInterval(id);
  }, [backendReady]);

  // Poll /api/bridge every 3s to track active bridges for the indicator overlay.
  // Also detects active -> ended transitions (or TTL-prune vanish) and toasts
  // the reason — see utils/bridgeEvents.js.
  useEffect(() => {
    if (!backendReady) return;
    const fetchBridges = async () => {
      try {
        const res = await fetch("/api/bridge");
        if (!res.ok) return;
        const data = await res.json();
        const bridges = data.bridges || [];
        setActiveBridges(bridges);
        const events = computeEndEvents(BRIDGE_KIND, bridges, prevBridgeStatesRef.current, seenBridgeIdsRef.current);
        events.forEach((evt) => {
          const { message, type } = formatEndEventToast(evt);
          toast(message, type);
        });
      } catch (_) {
        // soft-fail — stale bridge state is not critical
      }
    };
    fetchBridges();
    const id = setInterval(fetchBridges, 3000);
    return () => clearInterval(id);
  }, [backendReady, toast]);

  // Poll /api/bridge/channel every 3s to track active channels. Also detects
  // active -> ended transitions (or TTL-prune vanish) and toasts the reason.
  useEffect(() => {
    if (!backendReady) return;
    const fetchChannels = async () => {
      try {
        const res = await fetch("/api/bridge/channel");
        if (!res.ok) return;
        const data = await res.json();
        const channelList = data.channels || [];
        setChannels(channelList);
        const events = computeEndEvents(CHANNEL_KIND, channelList, prevChannelStatesRef.current, seenChannelIdsRef.current);
        events.forEach((evt) => {
          const { message, type } = formatEndEventToast(evt);
          toast(message, type);
        });
      } catch (_) {
        // soft-fail — stale channel state is not critical
      }
    };
    fetchChannels();
    const id = setInterval(fetchChannels, 3000);
    return () => clearInterval(id);
  }, [backendReady, toast]);

  // Poll /api/terminals/{id}/workflows every 3s — best-effort background polling
  const sessionsForWorkflows = useRef(sessions);
  sessionsForWorkflows.current = sessions;
  useEffect(() => {
    if (!backendReady) return;
    const controller = new AbortController();
    const { signal } = controller;

    const fetchWorkflows = async () => {
      const activeSessions = sessionsForWorkflows.current.filter((s) => s.terminalId);
      await Promise.all(
        activeSessions.map(async (s) => {
          try {
            const res = await fetch(`/api/terminals/${s.terminalId}/workflows`, { signal });
            if (!res.ok) return;
            const data = await res.json();
            const items = data.workflows || [];
            const inProgressCount = items.filter((w) => w.status === "in_progress").length;
            setWorkflowsByTerminal((prev) => {
              const next = { ...prev, [s.terminalId]: { count: items.length, inProgressCount, items } };
              return next;
            });
          } catch (_) {
            // silently swallow — workflow polling is best-effort
          }
        })
      );
    };

    fetchWorkflows();
    const id = setInterval(fetchWorkflows, 3000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [backendReady]);

  // Poll /api/terminals/{id}/usage + /api/usage/daily every 3s — best-effort background polling
  const sessionsForUsage = useRef(sessions);
  sessionsForUsage.current = sessions;
  const usageSamplesRef = useRef({}); // { [terminalId]: { output_tokens, t } } — previous sample for client-side tok/s
  useEffect(() => {
    if (!backendReady) return;
    const controller = new AbortController();
    const { signal } = controller;

    const fetchUsage = async () => {
      const activeSessions = sessionsForUsage.current.filter((s) => s.terminalId);
      await Promise.all(
        activeSessions.map(async (s) => {
          try {
            const res = await fetch(`/api/terminals/${s.terminalId}/usage`, { signal });
            if (!res.ok) return;
            const data = await res.json();
            const now = performance.now();
            const prevSample = usageSamplesRef.current[s.terminalId];
            let tokensPerSec = 0;
            if (prevSample) {
              const dt = (now - prevSample.t) / 1000;
              if (dt > 0) {
                tokensPerSec = Math.round(
                  Math.max(0, (data.output_tokens - prevSample.output_tokens) / dt)
                );
              }
            }
            usageSamplesRef.current[s.terminalId] = { output_tokens: data.output_tokens, t: now };
            setUsageByTerminal((prev) => ({ ...prev, [s.terminalId]: { ...data, tokensPerSec } }));
          } catch (_) {
            // silently swallow — usage polling is best-effort
          }
        })
      );
      try {
        const res = await fetch("/api/usage/daily", { signal });
        if (res.ok) {
          const data = await res.json();
          setDailyUsage(data);
        }
      } catch (_) {
        // silently swallow — daily usage polling is best-effort
      }
    };

    fetchUsage();
    const id = setInterval(fetchUsage, 3000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [backendReady]);

  // Persist the local-broker enable flag.
  useEffect(() => {
    try { localStorage.setItem("cockpit-local-enabled", String(localEnabled)); } catch (_) { /* ignore */ }
  }, [localEnabled]);

  // Poll the local broker's status (unaffected by provider selection — a
  // machine-global compatibility probe) every 3s while enabled.
  useEffect(() => {
    if (!backendReady || !localEnabled) {
      setLocalStatus(null);
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/local/status", { signal });
        if (res.ok) setLocalStatus(await res.json());
      } catch (_) {
        // swallow — best-effort
      }
    };
    fetchStatus();
    const id = setInterval(fetchStatus, 3000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [backendReady, localEnabled]);

  // Poll the selected provider's queue (3s) and metrics + spill (10s) — gated
  // so a disabled feature or unselected provider costs nothing. Best-effort:
  // errors/offline are swallowed and surfaced as a null (offline) state the
  // panels render as "broker offline". Each fetch is additionally gated on
  // the provider actually listing that capability; spill also requires
  // scope=="local" (PUT is 403 for remote providers, so the read-only sliders
  // are withheld there too) — spillConfig === null tells LaneQueuePanel to
  // omit the section entirely rather than show a false "offline" state.
  useEffect(() => {
    if (!backendReady || !localEnabled || !selectedProvider) {
      setLocalQueue(null);
      setLocalMetrics(null);
      setLocalSpill(null);
      return;
    }
    const providerId = selectedProvider.id;
    const caps = selectedProvider.capabilities || [];
    const controller = new AbortController();
    const { signal } = controller;

    const fetchQueue = async () => {
      if (!caps.includes("queue")) { setLocalQueue(null); return; }
      try {
        const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/queue`, { signal });
        setLocalQueue(res.ok ? await res.json() : { reachable: false });
      } catch (_) {
        // swallow — best-effort; leave prior state
      }
    };

    const fetchMetricsAndSpill = async () => {
      if (caps.includes("metrics")) {
        try {
          const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/metrics?window=${encodeURIComponent(metricsWindow)}`, { signal });
          setLocalMetrics(res.ok ? await res.json() : { reachable: false });
        } catch (_) {
          // swallow — best-effort
        }
      } else {
        setLocalMetrics(null);
      }
      if (caps.includes("spill") && selectedProvider.scope === "local") {
        try {
          const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/spill`, { signal });
          setLocalSpill(res.ok ? await res.json() : { reachable: false });
        } catch (_) {
          // swallow — best-effort
        }
      } else {
        setLocalSpill(null);
      }
    };

    fetchQueue();
    fetchMetricsAndSpill();
    const queueId = setInterval(fetchQueue, 3000);
    const slowId = setInterval(fetchMetricsAndSpill, 10000);
    return () => {
      clearInterval(queueId);
      clearInterval(slowId);
      controller.abort();
    };
  }, [backendReady, localEnabled, selectedProvider, metricsWindow]);

  // `/api/local/{provider}/models` has exactly ONE poller app-wide, and it lives
  // in useLocalModels — App and Engine used to each run their own, asking the
  // same question twice every 10s whenever Engine was open. `watching` is the
  // "is anyone actually looking" gate: Engine visible, or the Defaults drop-down
  // (which hosts the TopBar model picker) open. When neither is true and no load
  // is in flight nothing is polled at all — strictly less traffic than before,
  // and the marker's own 2s cadence keeps the spinner prompt regardless.
  const {
    busyModelId: localBusyModelId,
    loadOrRestartModel: loadOrRestartLocalModel,
  } = useLocalModelsPoller({
    enabled: backendReady && localEnabled,
    provider: selectedProvider,
    watching: showLocalBroker || defaultsOpen,
    onToast: toast,
  });

  // Commit a single lane-class spill threshold (seconds, or null to disable),
  // scoped to the selected provider. PUTs the partial map and applies the
  // broker's echoed full state.
  const commitSpill = useCallback(async (cls, value) => {
    if (!selectedProvider) return;
    try {
      const res = await fetch(`/api/local/${encodeURIComponent(selectedProvider.id)}/spill`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [cls]: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error || "Could not update spill threshold", "error");
        return;
      }
      setLocalSpill(data);
    } catch (_) {
      toast("Broker unreachable — spill threshold not changed", "error");
    }
  }, [toast, selectedProvider]);

  // Bridge modal handlers
  const handleOpenBridge = useCallback((sessionId) => {
    setBridgeModal({ open: true, fromSessionId: sessionId });
  }, []);

  const handleCloseBridge = useCallback(() => {
    setBridgeModal({ open: false, fromSessionId: null });
  }, []);

  const fetchLatestAssistant = useCallback(async (terminalId) => {
    try {
      const res = await fetch(`/api/terminals/${terminalId}/latest-assistant`);
      if (!res.ok) return null;
      const data = await res.json();
      return data.text || null;
    } catch (_) {
      return null;
    }
  }, []);

  const handleSendManual = useCallback(async ({ to, text, prefix }) => {
    // 'to' is a local sessionId; look up terminalIds for both sides
    const fromSession = sessions.find((s) => s.id === bridgeModal.fromSessionId);
    const toSession = sessions.find((s) => s.id === to);
    if (!fromSession?.terminalId || !toSession?.terminalId) {
      toast("Session not running", "error");
      return;
    }
    try {
      const res = await fetch("/api/bridge/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_terminal_id: fromSession.terminalId,
          to_terminal_id: toSession.terminalId,
          message: text,
          prefix,
        }),
      });
      const data = await res.json();
      if (data.ok) toast(`Bridged to "${toSession.name}"`, "success");
      else toast(`Bridge failed: ${data.error || "unknown"}`, "error");
    } catch (err) {
      toast(`Bridge failed: ${err.message}`, "error");
    }
    handleCloseBridge();
  }, [sessions, bridgeModal.fromSessionId, toast, handleCloseBridge]);

  const handleStartAuto = useCallback(async ({ to, prompt, maxTurns }) => {
    const fromSession = sessions.find((s) => s.id === bridgeModal.fromSessionId);
    const toSession = sessions.find((s) => s.id === to);
    if (!fromSession?.terminalId || !toSession?.terminalId) {
      toast("Session not running", "error");
      return;
    }
    try {
      const res = await fetch("/api/bridge/auto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_terminal_id: fromSession.terminalId,
          to_terminal_id: toSession.terminalId,
          kickoff_prompt: prompt,
          max_turns: maxTurns,
        }),
      });
      const data = await res.json();
      if (data.ok) toast(`Auto-bridge started (${data.bridge_id})`, "info");
      else toast(`Bridge failed: ${data.error || "unknown"}`, "error");
    } catch (err) {
      toast(`Bridge failed: ${err.message}`, "error");
    }
    handleCloseBridge();
  }, [sessions, bridgeModal.fromSessionId, toast, handleCloseBridge]);

  const handleEndBridge = useCallback(async (bridgeId) => {
    try {
      await fetch(`/api/bridge/${bridgeId}`, { method: "DELETE" });
      toast("Bridge ended", "info");
      // Optimistically remove; next poll will reconcile
      setActiveBridges((prev) => prev.filter((b) => b.bridge_id !== bridgeId));
    } catch (err) {
      toast(`Failed to end bridge: ${err.message}`, "error");
    }
  }, [toast]);

  const handleStartChannel = useCallback(async ({ leadId, workerIds, prompt, maxTurns }) => {
    // leadId and workerIds are local session ids — resolve to terminalIds
    const leadSession = sessions.find((s) => s.id === leadId);
    const workerSessions = workerIds.map((id) => sessions.find((s) => s.id === id)).filter(Boolean);
    if (!leadSession?.terminalId || workerSessions.some((s) => !s.terminalId)) {
      toast("One or more selected sessions are not running", "error");
      return "One or more selected sessions are not running";
    }
    try {
      const res = await fetch("/api/bridge/channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lead_id: leadSession.terminalId,
          worker_ids: workerSessions.map((s) => s.terminalId),
          kickoff_prompt: prompt,
          max_turns: maxTurns,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        toast(`Channel started (${data.channel_id})`, "info");
        return null; // no error
      } else {
        const msg = `Channel failed: ${data.error || "unknown"}`;
        toast(msg, "error");
        return msg;
      }
    } catch (err) {
      const msg = `Channel failed: ${err.message}`;
      toast(msg, "error");
      return msg;
    }
  }, [sessions, toast]);

  const handleEndChannel = useCallback(async (channelId) => {
    try {
      await fetch(`/api/bridge/channel/${channelId}`, { method: "DELETE" });
      toast("Channel ended", "info");
      // Optimistically remove; next poll will reconcile
      setChannels((prev) => prev.filter((c) => c.channel_id !== channelId));
    } catch (err) {
      toast(`Failed to end channel: ${err.message}`, "error");
    }
  }, [toast]);

  /** Given a terminalId, find whether it is in an active channel.
   *  Returns { channel_id, isLead, turns_used, max_turns } or null. */
  const getChannelForTerminal = useCallback((terminalId) => {
    if (!terminalId) return null;
    for (const ch of channels) {
      if (ch.state !== "active") continue;
      if (ch.lead_id === terminalId) {
        return { channel_id: ch.channel_id, isLead: true, turns_used: ch.turns_used, max_turns: ch.max_turns };
      }
      if (ch.worker_ids && ch.worker_ids.includes(terminalId)) {
        return { channel_id: ch.channel_id, isLead: false, turns_used: ch.turns_used, max_turns: ch.max_turns };
      }
    }
    return null;
  }, [channels]);

  /** Map of terminalId -> "bridge" | "channel" for every session taking part in
   *  an active bridge or channel. Passed to BridgeModal so its session pickers
   *  can disable already-busy sessions instead of letting the user hit a 409 on
   *  Send. Built by the shared helper (which documents why it must be a Map and
   *  not a Set) so App and its tests exercise the same code. */
  const busyTerminalIds = useMemo(
    () => buildBusyTerminalIds(activeBridges, channels),
    [activeBridges, channels],
  );

  // BroadcastChannel: receive CLOSED from popout windows to clear their placeholder
  useEffect(() => {
    const bc = new BroadcastChannel("cockpit-popout");
    bc.onmessage = (event) => {
      if (event.data?.type === "CLOSED") {
        setPoppedOutIds((prev) => {
          const next = new Set(prev);
          next.delete(event.data.terminalId);
          return next;
        });
      }
    };
    return () => bc.close();
  }, []);

  const handlePopout = useCallback(async (session) => {
    const terminalId = session.terminalId;
    const url = `/?popout=${encodeURIComponent(terminalId)}&name=${encodeURIComponent(session.name)}&model=${encodeURIComponent(session.model)}`;

    setPoppedOutIds((prev) => new Set([...prev, terminalId]));

    if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
      try {
        const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
        const label = `popout-${terminalId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
        const webview = new WebviewWindow(label, {
          url,
          title: `${session.name} — Claude Cockpit`,
          width: 900,
          height: 700,
          minWidth: 600,
          minHeight: 400,
          center: true,
          dragDropEnabled: false,
        });
        webview.once("tauri://error", () => {
          setPoppedOutIds((prev) => { const next = new Set(prev); next.delete(terminalId); return next; });
        });
      } catch {
        window.open(url, `popout-${terminalId}`, "width=900,height=700,menubar=no,toolbar=no,location=no");
      }
    } else {
      window.open(url, `popout-${terminalId}`, "width=900,height=700,menubar=no,toolbar=no,location=no");
    }
  }, []);

  // Fork a session: create a new session in the same workdir with continue
  const forkSession = useCallback((sessionId) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    createSession(
      `${session.name} (fork)`,
      session.workdir,
      session.model,
      { continueSession: true, bypassPermissions: session.bypassPermissions }
    );
  }, [sessions, createSession]);

  // Rename a session — PATCH /api/terminals/{id} always commits the Cockpit-side
  // name first; sync_claude best-effort injects /rename into the live session
  // and may report claude_synced: false without the whole request failing.
  // Owns the sessions-state mutation here (not in TerminalPane) so the sidebar
  // name updates immediately alongside the pane header.
  // Optimistic: the new name is shown before the PATCH resolves — with
  // sync_claude the request blocks up to ~5s waiting for the session to go
  // idle, and the header showing the stale name that whole time reads as a
  // hang. Rolled back if the server rejects the rename.
  const renameSession = useCallback(async (localId, newName, syncClaude) => {
    const session = sessions.find((s) => s.id === localId);
    if (!session?.terminalId) return;
    const prevName = session.name;
    setSessions((prev) =>
      prev.map((s) => (s.id === localId ? { ...s, name: newName } : s))
    );
    const rollback = () =>
      setSessions((prev) =>
        prev.map((s) => (s.id === localId ? { ...s, name: prevName } : s))
      );
    try {
      const res = await fetch(`/api/terminals/${session.terminalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName, sync_claude: syncClaude }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        rollback();
        toast(data.error || "Rename failed", "error");
        return;
      }
      if (syncClaude && data.claude_synced === false) {
        toast(`Renamed to "${newName}" — Claude session sync did not go through`, "info");
      }
    } catch (err) {
      rollback();
      toast(`Rename failed: ${err.message}`, "error");
    }
  }, [sessions, toast]);

  // Workspace preset management
  const saveWorkspace = useCallback((name) => {
    const preset = {
      name,
      layout,
      sessions: sessions
        .filter((s) => s.status === "running")
        .map(({ name, model, workdir }) => ({ name, model, workdir })),
      activeIds: activeIds.slice(0, layout).map((id) => {
        if (id == null) return null;
        const s = sessions.find((s) => s.id === id);
        return s ? sessions.filter((x) => x.status === "running").indexOf(s) : null;
      }),
    };
    setWorkspacePresets((prev) => {
      const next = [...prev.filter((p) => p.name !== name), preset];
      lsSave(WORKSPACES_KEY, next);
      return next;
    });
    toast(`Workspace "${name}" saved`, "success");
  }, [layout, sessions, activeIds, toast]);

  const loadWorkspace = useCallback(async (preset) => {
    setLayout(preset.layout);
    // Create sessions from preset
    for (const s of preset.sessions) {
      await createSession(s.name, s.workdir, s.model);
    }
    toast(`Workspace "${preset.name}" loaded`, "success");
  }, [createSession, toast]);

  const deleteWorkspace = useCallback((name) => {
    setWorkspacePresets((prev) => {
      const next = prev.filter((p) => p.name !== name);
      lsSave(WORKSPACES_KEY, next);
      return next;
    });
  }, []);

  /** Apply a zoom level: persist, show toast, update state */
  const applyZoom = useCallback((value) => {
    setTerminalZoom(value);
    lsSave(ZOOM_STORAGE_KEY, value);
    clearTimeout(zoomToastTimer.current);
    setZoomToast(value);
    zoomToastTimer.current = setTimeout(() => setZoomToast(null), 1200);
  }, []);

  const zoomIn = useCallback(() => {
    setTerminalZoom((prev) => { const next = Math.min(prev + 1, MAX_ZOOM); applyZoom(next); return next; });
  }, [applyZoom]);

  const zoomOut = useCallback(() => {
    setTerminalZoom((prev) => { const next = Math.max(prev - 1, MIN_ZOOM); applyZoom(next); return next; });
  }, [applyZoom]);

  const zoomReset = useCallback(() => applyZoom(DEFAULT_ZOOM), [applyZoom]);

  /** Ctrl+K command palette. The palette itself is a later phase; for now this
   *  focuses the Projects filter, which is the searchable surface that exists. */
  const openPalette = useCallback(() => {
    setSidebarOpen(true);
    requestAnimationFrame(() => {
      const el = document.querySelector("[data-sidebar-filter]");
      if (el) el.focus();
    });
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === "N") {
        e.preventDefault();
        setShowNewDialog(true);
      }
      // Ctrl+Shift+B (legacy) and Ctrl+Shift+E (redesign) both toggle the
      // Projects drawer — the spec renames the shortcut but the old one is
      // muscle memory, so both are kept rather than breaking it.
      if (e.ctrlKey && e.shiftKey && (e.key === "B" || e.key === "E")) {
        e.preventDefault();
        setSidebarOpen((p) => !p);
      }
      // Ctrl+K opens the command palette.
      if (e.ctrlKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        openPalette();
      }
      if (e.ctrlKey && e.shiftKey && e.key === "!") {
        e.preventDefault();
        setLayout(1);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "@") {
        e.preventDefault();
        setLayout(2);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "#") {
        e.preventDefault();
        setLayout(3);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "$") {
        e.preventDefault();
        setLayout(4);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "%") {
        e.preventDefault();
        setLayout(5);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "^") {
        e.preventDefault();
        setLayout(6);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "&") {
        e.preventDefault();
        setLayout(7);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "*") {
        e.preventDefault();
        setLayout(8);
      }
      if (e.ctrlKey && !e.shiftKey && e.key >= "1" && e.key <= "8") {
        const i = parseInt(e.key) - 1;
        if (i < layout && activeIds[i] != null) {
          e.preventDefault();
          paneRefs.current[i]?.focus();
        }
      }
      // Zoom: Ctrl+= / Ctrl+- / Ctrl+0
      if (e.ctrlKey && !e.shiftKey && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomIn();
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "-") {
        e.preventDefault();
        zoomOut();
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "0") {
        e.preventDefault();
        zoomReset();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [createSession, activeIds, layout, zoomIn, zoomOut, zoomReset, openPalette]);

  // Ctrl+MouseWheel zoom
  useEffect(() => {
    const handler = (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else if (e.deltaY > 0) zoomOut();
    };
    window.addEventListener("wheel", handler, { passive: false });
    return () => window.removeEventListener("wheel", handler);
  }, [zoomIn, zoomOut]);

  const swapPanes = useCallback((fromIdx, toIdx) => {
    setActiveIds((prev) => {
      const next = [...prev];
      while (next.length <= Math.max(fromIdx, toIdx)) next.push(null);
      const tmp = next[fromIdx];
      next[fromIdx] = next[toIdx];
      next[toIdx] = tmp;
      return next;
    });
  }, []);

  const gridLayout = computeLayout(layout, flipLayout);
  // Featured layouts (3/5/7) put the focused pane in the featured cell.
  // Build a slot-render order: featured slot first, then the rest in order.
  const paneOrder = useMemo(() => {
    const order = [];
    if (FEATURED_LAYOUTS.has(layout)) {
      const f = focusedIndex >= 0 && focusedIndex < layout ? focusedIndex : 0;
      order.push(f);
      for (let i = 0; i < layout; i++) if (i !== f) order.push(i);
    } else {
      for (let i = 0; i < layout; i++) order.push(i);
    }
    return order;
  }, [layout, focusedIndex]);

  // ── Shell derivations ─────────────────────────────────────────────────────
  // Everything the redesigned chrome renders is DERIVED from state that already
  // existed; the shell restructure adds no new polling and no duplicate stores.

  /** Switch destination. Selecting the section you are already in returns to
   *  Workspace, preserving the old rail's toggle feel. "projects" opens the
   *  drawer rather than a full-area section — the tree overlays the panes. */
  const selectSection = useCallback((section) => {
    if (section === "projects") {
      setSidebarOpen((v) => !v);
      return;
    }
    // Close the DEFAULTS drop-down on any destination change. It is the Phase-1
    // TopBar scaffold rendered as an absolutely-positioned overlay, so leaving it
    // open while navigating to Engine/Reports/Settings drops a full-width bar on
    // top of that view's own header -- it reads as the app double-rendering its
    // chrome. The panel belongs to Workspace's defaults, so it should not
    // survive leaving Workspace.
    setDefaultsOpen(false);
    setActiveSection((prev) => (prev === section ? "work" : section));
  }, []);

  // Spill trigger for the interactive class, in seconds of predicted wait.
  // `null` in the broker payload means spill is DISABLED for the class — which
  // is why the toggle reads presence, not truthiness of a number.
  const spillThresholdSeconds = useMemo(() => {
    const t = localSpill?.spill_thresholds_s?.interactive;
    if (t === null) return null;
    return typeof t === "number" ? t : DEFAULT_INTERACTIVE_SPILL_SECONDS;
  }, [localSpill]);
  const spillEnabled = spillThresholdSeconds != null;

  /** Master spill switch for the interactive lane. Turning it off sends null
   *  (the broker's "disabled" sentinel); turning it back on restores the
   *  default trigger. This is the same key the Engine view and Settings write —
   *  three surfaces, one PUT, per the handoff. */
  const toggleSpillEnabled = useCallback((next) => {
    commitSpill({ interactive: next ? DEFAULT_INTERACTIVE_SPILL_SECONDS : null });
  }, [commitSpill]);

  /** Per-session override. Phase 1 writes the WORKSPACE default (the existing
   *  behaviour) — true per-session overrides need a backend hop to re-spawn or
   *  re-key a live session, which is Phase 3. Keeping it honest here rather
   *  than silently no-oping the control. */
  const applySessionOverride = useCallback((key, value) => {
    if (key === "model") setModel(value);
    else if (key === "permissionMode") setPermissionMode(value);
    else if (key === "effort") setEffort(value);
    else if (key === "fast") setFast(value);
  }, []);

  const inspectorModelOptions = useMemo(
    () => MODELS.map((m) => ({ value: m.id, label: m.label })),
    [],
  );

  const activeWorkspaceName = useMemo(() => {
    const active = workspacePresets.find((w) => w?.active);
    return active?.name || null;
  }, [workspacePresets]);


  const focusedSessionId = focusedIndex >= 0 && focusedIndex < activeIds.length ? activeIds[focusedIndex] : null;
  const focusedSession = focusedSessionId != null ? sessions.find((s) => s.id === focusedSessionId) || null : null;

  // Track which slot each session last occupied so activating it from
  // Projects/Fleet/palette focuses ITS pane instead of reshuffling the grid.
  // RECONCILES, not just inserts: a session evicted from its slot must LOSE its
  // badge, otherwise its chip keeps advertising a pane that now belongs to
  // someone else (and the map grows unbounded over a long uptime). Returning
  // `prev` unchanged when nothing moved avoids a pointless extra App re-render on
  // every activation.
  useEffect(() => {
    setPaneSlotBySession((prev) => {
      const next = new Map();
      activeIds.forEach((id, idx) => { if (id != null) next.set(id, idx + 1); });
      if (next.size === prev.size && [...next].every(([id, slot]) => prev.get(id) === slot)) {
        return prev;
      }
      return next;
    });
  }, [activeIds]);

  // Lane pressure, from the shared math (utils/laneMath.js) so the strip, the
  // TopBar pill and Engine > Live cannot disagree.
  const laneStripData = useMemo(() => {
    const live = laneLive(localQueue, localMetrics);
    if (!live) return null;
    return {
      inFlight: live.running,
      queued: live.queued,
      predictedWaitSeconds: predictedWaitSeconds(live.running, live.queued, live.p50WallSeconds),
      thresholdSeconds: spillThresholdSeconds,
      estimatedClearSeconds: live.etaSec,
    };
  }, [localQueue, localMetrics, spillThresholdSeconds]);

  /** Engine rail dot: down when something is configured but unreachable,
   *  pressure when the lane is backed up past its trigger, else serving.
   *  null (no dot) when the local engine is switched off entirely. */
  const engineStatus = useMemo(() => {
    if (!localEnabled) return null;
    // Field names pinned to GET /api/local/status, which returns
    // {reachable, compatible, service, detail, url, managed} — there is NO `ok`
    // key here (that belongs to /api/local/{id}/health). Reading `ok` made the
    // "down" branch dead code, so killing LM Studio still painted a green
    // "serving" dot — the one thing this indicator exists to rule out.
    // `compatible: false` is also down for our purposes: something is answering,
    // but not the broker contract, so it cannot serve us.
    if (localStatus && (localStatus.reachable === false || localStatus.compatible === false)) return "down";
    const frac = pressureFraction(laneStripData?.predictedWaitSeconds, laneStripData?.thresholdSeconds);
    if (frac != null && frac >= 1) return "pressure";
    return "serving";
  }, [localEnabled, localStatus, laneStripData]);

  const bridgeCount = useMemo(
    () => activeBridges.filter((b) => b?.state === "active").length
      + channels.filter((c) => c?.state === "active").length,
    [activeBridges, channels],
  );

  /** The focused session's bridge/channel role, for the Inspector card. */
  const inspectorBridge = useMemo(() => {
    if (!focusedSession) return null;
    const tid = focusedSession.terminalId;
    const b = activeBridges.find((x) => x?.state === "active" && (x.from_id === tid || x.to_id === tid));
    if (b) {
      const isSender = b.from_id === tid;
      return {
        role: isSender ? "sender" : "receiver",
        kind: "bridge",
        peerName: isSender ? b.to_name : b.from_name,
        turn: b.turns_used,
        maxTurns: b.max_turns,
        id: b.bridge_id,
      };
    }
    const ch = channels.find(
      (x) => x?.state === "active" && (x.lead_id === tid || (Array.isArray(x.worker_ids) && x.worker_ids.includes(tid))),
    );
    if (ch) {
      const isLead = ch.lead_id === tid;
      return {
        role: isLead ? "lead" : "worker",
        kind: "channel",
        peerName: isLead ? `${(ch.worker_ids || []).length} workers` : ch.lead_name,
        turn: ch.turns_used,
        maxTurns: ch.max_turns,
        id: ch.channel_id,
      };
    }
    return null;
  }, [focusedSession, activeBridges, channels]);

  const endFocusedBridge = useCallback(() => {
    if (!inspectorBridge?.id) return;
    if (inspectorBridge.kind === "channel") handleEndChannel(inspectorBridge.id);
    else handleEndBridge(inspectorBridge.id);
  }, [inspectorBridge, handleEndChannel, handleEndBridge]);

  /** Today's total tokens for the status strip. Keys pinned to
   *  usage_tracker.daily_summary(): input_tokens / output_tokens /
   *  cache_read_tokens / cache_creation_tokens and est_cost_usd — there is no
   *  `total_tokens` field, so the total is summed here. Stays null (rendered
   *  "—") when no rollup has arrived, rather than reporting a fabricated 0. */
  const todayTokens = useMemo(() => {
    if (!dailyUsage) return null;
    const parts = [
      dailyUsage.input_tokens,
      dailyUsage.output_tokens,
      dailyUsage.cache_read_tokens,
      dailyUsage.cache_creation_tokens,
    ].filter((n) => typeof n === "number" && isFinite(n));
    return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }, [dailyUsage]);

  /**
   * Adapt the git payload for the Inspector, and normalize the LOOKUP KEY.
   *
   * `gitStatuses` is keyed by a normalized path (forward slashes converted to
   * backslashes, trailing separator stripped — see where setGitStatuses builds
   * `normPath`), and Sidebar goes through the same normalization. Indexing with a
   * raw `workdir` silently missed for any session whose path carried forward
   * slashes or a trailing separator, so the Inspector showed no git row while the
   * sidebar showed one for the very same folder.
   *
   * The endpoint returns `files_changed`; the component's contract is
   * `changedCount`, so translate rather than teaching the component the API name.
   */
  const inspectorGit = useMemo(() => {
    const wd = focusedSession?.workdir;
    if (!wd) return null;
    const g = gitStatuses[normalizeWorkdir(wd)];
    if (!g) return null;
    return { branch: g.branch, dirty: g.dirty, changedCount: g.files_changed };
  }, [focusedSession, gitStatuses]);

  /**
   * Adapt GET /api/system to the StatusStrip contract. The endpoint speaks
   * snake_case (cpu_percent / ram_used_gb / ram_total_gb / gpu_percent); the old
   * StatusBar read those correctly, so passing the raw object to a camelCase
   * component was a live regression that read "CPU — RAM — GPU —" on a healthy
   * machine. VRAM is deliberately absent: no endpoint reports it, so there is
   * nothing honest to show.
   */
  const stripSystemStats = useMemo(() => {
    if (!systemStats) return null;
    return {
      cpu: systemStats.cpu_percent,
      ramUsed: systemStats.ram_used_gb,
      ramTotal: systemStats.ram_total_gb,
      gpu: systemStats.gpu_percent,
    };
  }, [systemStats]);

  /**
   * Adapt the backend's usage payload to the Inspector's prop contract.
   *
   * The API speaks snake_case (usage_tracker.session_summary(): input_tokens,
   * output_tokens, cache_creation_tokens, cache_read_tokens, est_cost_usd) while
   * the presentational component takes camelCase. Translating HERE, at the
   * integration boundary, keeps the component free of backend field names and
   * means there is exactly one place to look when the payload changes.
   *
   * Context is NOT in that payload at all — it rides on the session object as
   * `context_percent`, so the ring is fed a percentage directly rather than the
   * used/max pair the payload never had.
   *
   * Missing values stay undefined and render "n/a": a 0 here would claim "no
   * tokens used", which is a different and false statement.
   *
   * `hasTurns` is the honesty discriminator the Inspector needs. It keys off
   * `last_event_ts`, which session_summary() sets to null ONLY when the terminal
   * has no usage_events rows whatsoever. Without it, a freshly-spawned session
   * (real zeros) and a failed lookup (unknown) both rendered n/a, so a working
   * system looked broken while the status strip showed large global totals.
   */
  const inspectorUsage = useMemo(() => {
    if (!focusedSession) return null;
    const u = usageByTerminal[focusedSession.terminalId];
    const pct = focusedSession.context_percent;
    const haveCtx = typeof pct === "number" && isFinite(pct);
    if (!u && !haveCtx) return null;
    return {
      contextUsed: haveCtx ? pct : undefined,
      contextMax: haveCtx ? 100 : undefined,
      inputTokens: u?.input_tokens,
      outputTokens: u?.output_tokens,
      cacheRead: u?.cache_read_tokens,
      cacheWrite: u?.cache_creation_tokens,
      costUsd: u?.est_cost_usd,
      // undefined when we have no payload at all -- only a payload can testify
      // about whether turns exist.
      hasTurns: u ? u.last_event_ts != null : undefined,
    };
  }, [focusedSession, usageByTerminal]);
  const inspectorWorkflows = focusedSession
    ? workflowsByTerminal[focusedSession.terminalId]?.items || []
    : [];

  /** Interrupt = ESC to the focused pane's PTY, via the pane's imperative
   *  handle so it travels the same WebSocket as a keystroke. */
  const interruptSession = useCallback((sessionId) => {
    const idx = activeIds.indexOf(sessionId);
    if (idx < 0) return;
    const pane = paneRefs.current[idx];
    // Three outcomes, and they must be distinguished: no pane mounted (the
    // session is popped out, so its TerminalPane lives in the other window),
    // socket closed (returns false), or sent (true). Treating only `false` as
    // failure made Interrupt a completely silent no-op on a popped-out pane —
    // no ESC, no toast, no clue.
    if (!pane?.interrupt) {
      toast("This session is popped out — interrupt it from its own window", "info");
      return;
    }
    if (pane.interrupt() === false) {
      toast("Session is not connected — nothing to interrupt", "error");
    }
  }, [activeIds, toast]);

  const popOutSession = useCallback((sessionId) => {
    const s = sessions.find((x) => x.id === sessionId);
    if (s) handlePopout(s);
  }, [sessions, handlePopout]);

  // Splash screen while waiting for backend
  if (!backendReady) {
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden relative" style={{ background: "var(--cc-bg)" }}>
        <div className="relative z-10 flex items-center justify-center h-full">
          <div className="text-center" style={{ color: "var(--text-secondary)" }}>
            {backendError ? (
              <>
                <p className="text-lg mb-4" style={{ color: "var(--text-primary)" }}>
                  Failed to connect to backend server
                </p>
                <button
                  onClick={() => {
                    setBackendError(false);
                    setBackendReady(false);
                    window.location.reload();
                  }}
                  className="px-4 py-2 rounded-md text-sm"
                  style={{
                    border: "1px solid var(--border-color)",
                    color: "var(--text-primary)",
                  }}
                >
                  Retry
                </button>
              </>
            ) : (
              <>
                <Loader size={24} className="state-icon-spin" style={{ color: "var(--accent)", margin: "0 auto 12px" }} />
                <p className="text-lg mb-2" style={{ color: "var(--text-primary)" }}>
                  Connecting...
                </p>
                <p className="text-sm">Waiting for connection</p>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden relative" style={{ background: "var(--cc-bg)" }}>
        {/* The rail is now FULL HEIGHT and the command bar / status strip live
            inside the content column to its right — the redesigned shell. */}
        <div className="relative z-10 flex h-full min-h-0">
          <Rail
            activeSection={activeSection}
            onSelectSection={selectSection}
            engineStatus={engineStatus}
            user={user}
            projectsDrawerOpen={sidebarOpen}
          />

          {/* Content column: command bar 44 -> lane strip 40 -> panes+inspector -> status strip 24 */}
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            <CommandBar
              title={SECTION_TITLES[activeSection] || "Workspace"}
              workspaceName={activeWorkspaceName}
              onOpenPalette={openPalette}
              model={model}
              permissionMode={permissionMode}
              effort={effort}
              onOpenDefaults={() => setDefaultsOpen((v) => !v)}
            />

            {/* PHASE-1 SCAFFOLD: the Defaults pill opens the existing TopBar as a
                drop-down so every picker it owns (model, permission, effort,
                fast, OpenRouter key, local-engine pill) keeps working unchanged.
                Phase 4 dissolves TopBar into Settings + a purpose-built popover;
                until then this is how those controls stay reachable rather than
                being dropped on the floor by the shell restructure. */}
            {/* ABSOLUTELY POSITIONED on purpose. As an in-flow block this row
                changed the height available to the pane grid, so every xterm in
                every pane refit on each open AND close — visibly reflowing
                output in up to 8 terminals to show a picker. */}
            {defaultsOpen && (
              <div style={{ position: "relative", zIndex: 40 }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, background: "var(--cc-bg2)", borderBottom: "1px solid var(--cc-border)", boxShadow: "0 12px 32px rgba(0,0,0,.45)" }}>
              <TopBar
                model={model}
                setModel={setModel}
                permissionMode={permissionMode}
                setPermissionMode={setPermissionMode}
                effort={effort}
                setEffort={setEffort}
                fast={fast}
                setFast={setFast}
                sidebarOpen={sidebarOpen}
                setSidebarOpen={setSidebarOpen}
                user={user}
                onToast={toast}
                localEnabled={localEnabled}
                setLocalEnabled={setLocalEnabled}
                localLaunchEnabled={localEnabled}
                localQueue={localQueue}
                localMetrics={localMetrics}
                localStatus={localStatus}
                onOpenLocalBroker={() => setActiveSection("engine")}
                onLoadLocalModel={loadOrRestartLocalModel}
                localBusyModelId={localBusyModelId}
              />
                </div>
              </div>
            )}

            <LaneStrip
              sessions={sessions}
              paneSlotById={paneSlotBySession}
              focusedSessionId={focusedSessionId}
              poppedOutIds={poppedOutIds}
              onSelectSession={selectSession}
              onNew={() => setShowNewDialog(true)}
              onChipDragStart={(e, sessionId) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", `session:${sessionId}`);
              }}
              lane={laneStripData}
              spillEnabled={spillEnabled}
              onToggleSpill={toggleSpillEnabled}
              onOpenSpillDetails={() => setActiveSection("engine")}
            />

          <div className="flex flex-1 min-h-0">
            {sidebarOpen && (
              <div
                className="flex flex-shrink-0"
                style={{
                  width: sidebarWidth,
                  borderRight: "1px solid var(--border-color)",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <Sidebar
                  sessions={sessions}
                  activeIds={activeIds.slice(0, layout).filter((id) => id != null)}
                  onSelect={selectSession}
                  onNew={() => setShowNewDialog(true)}
                  onNewAt={(dir) => createSession("", dir, undefined, { bypassPermissions: getLocationBypass(dir) })}
                  onToggleLocationBypass={toggleLocationBypass}
                  onDelete={removeSession}
                  open={sidebarOpen}
                  savedLocations={savedLocations}
                  onAddLocations={addLocations}
                  onRemoveLocation={removeLocation}
                  gitStatuses={gitStatuses}
                  backendReady={backendReady}
                  workspacePresets={workspacePresets}
                  onSaveWorkspace={saveWorkspace}
                  onLoadWorkspace={loadWorkspace}
                  onDeleteWorkspace={deleteWorkspace}
                />
                <div
                  onMouseDown={startSidebarResize}
                  title="Drag to resize sidebar"
                  style={{
                    position: "absolute", top: 0, right: 0, bottom: 0, width: 5,
                    cursor: "col-resize", zIndex: 5,
                  }}
                  className="hover-bg-surface"
                />
              </div>
            )}

            {/* Full-area views render IN the content area — the rail, sidebar,
                and top bar stay visible so navigation never disappears. The
                rail icons are the way in AND out (toggles, mutually exclusive). */}
            {showFleetView && (
              <FleetView
                sessions={sessions}
                usageByTerminal={usageByTerminal}
                dailyUsage={dailyUsage}
                workflowsByTerminal={workflowsByTerminal}
                onClose={() => setActiveSection("work")}
              />
            )}
            {/* ENGINE owns "now" (Phase 6). Replaces LocalBrokerView, whose
                config moved to Settings and whose reporting moved to Reports.
                The ProviderPicker rides ABOVE the view on purpose: it used to
                live inside the broker view, and it is the only thing that sets
                `selectedProvider` — dropping it would silently kill every
                /api/local poll in App. "Which provider am I looking at" is a
                machine-now question, so Engine is its right home. */}
            {showLocalBroker && (
              <div className="flex-1 min-w-0 flex flex-col" style={{ background: "var(--cc-bg)" }}>
                <div
                  style={{
                    height: 34,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    padding: "0 18px",
                    borderBottom: "1px solid var(--cc-line)",
                  }}
                >
                  <ProviderPicker enabled={localEnabled} onSelect={setSelectedProvider} />
                </div>
                <EngineView
                  active={showLocalBroker}
                  provider={selectedProvider}
                  status={localStatus}
                  tab={engineTab}
                  onSelectTab={setEngineTab}
                  localEnabled={localEnabled}
                  setLocalEnabled={setLocalEnabled}
                  onToast={toast}
                  /* Engine hands off rather than dead-ending. The subsection IS
                     honoured for Settings, where it is a real settings section id
                     (e.g. "providers"): dropping it landed every "Thresholds are
                     set in Settings > Providers" link on General & startup, which
                     is worse than no link because it looks like the page moved.
                     Reports names its tabs differently, so its subsection is not
                     a settings id and is ignored rather than guessed at. */
                  onNavigate={(section, subsection) => {
                    setActiveSection(section);
                    if (section === "settings" && subsection) setSettingsSection(subsection);
                  }}
                />
              </div>
            )}

            {/* Pane grid — always mounted, terminals never unmount. Hidden
                (NOT unmounted — xterm/WS must survive) while a view is open. */}
            <main
              className="flex-1 min-w-0"
              style={{
                display: activeSection === "work" ? "grid" : "none",
                gridTemplateColumns: gridLayout.cols,
                gridTemplateRows: gridLayout.rows,
                gap: 14,
                padding: 14,
                background: "var(--cc-bg)",
              }}
              onDragEnd={() => { setDragSource(null); setDragOverSlot(null); }}
            >
              {/* Slot-based rendering: each slot is either a session pane or an empty placeholder */}
              {Array.from({ length: layout }).map((_, idx) => {
                const sessionId = idx < activeIds.length ? activeIds[idx] : null;
                const session = sessionId != null ? sessions.find((s) => s.id === sessionId) : null;
                // Grid placement from the adaptive layout engine. In featured
                // layouts (3/5/7) the focused pane takes the featured cell.
                const area = gridLayout.areas[paneOrder.indexOf(idx)] || gridLayout.areas[idx] || { col: "auto", row: "auto" };
                const slotPlacement = { gridColumn: area.col, gridRow: area.row };

                // Shared drop handlers for all slots
                const dndHandlers = {
                  onDragOver: (e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragOverSlot !== idx) setDragOverSlot(idx);
                  },
                  onDragLeave: (e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) {
                      setDragOverSlot(null);
                    }
                  },
                  onDrop: (e) => {
                    e.preventDefault();
                    setDragOverSlot(null);
                    setDragSource(null);
                    const data = e.dataTransfer.getData("text/plain");
                    if (data.startsWith("session:")) {
                      placeSession(parseInt(data.slice(8), 10), idx);
                    } else if (data.startsWith("pane:")) {
                      const from = parseInt(data.slice(5), 10);
                      if (!isNaN(from) && from !== idx) swapPanes(from, idx);
                    }
                  },
                };

                // Drop target overlay (shared between filled and empty slots)
                const dropOverlay = dragOverSlot === idx && dragSource !== idx && (
                  <div
                    style={{
                      position: "absolute",
                      inset: 4,
                      border: "2px dashed var(--accent)",
                      borderRadius: 8,
                      backgroundColor: "rgba(122, 162, 247, 0.08)",
                      animation: "drop-target-pulse 1.5s ease-in-out infinite",
                      zIndex: 10,
                      pointerEvents: "none",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <span
                      className="text-xs font-semibold px-3 py-1.5 rounded-full"
                      style={{
                        backgroundColor: "var(--bg-elevated)",
                        color: "var(--accent)",
                        border: "1px solid var(--accent)",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
                      }}
                    >
                      {dragSource != null ? "Drop to swap" : "Drop here"}
                    </span>
                  </div>
                );

                if (session) {
                  const isPopped = poppedOutIds.has(session.terminalId);

                  // Find an active bridge involving this session's terminalId
                  const activeBridge = session.terminalId
                    ? activeBridges.find(
                        (b) =>
                          b.state === "active" &&
                          (b.from_id === session.terminalId || b.to_id === session.terminalId)
                      ) || null
                    : null;

                  // Find an active channel involving this session's terminalId
                  const activeChannel = getChannelForTerminal(session.terminalId);

                  // Glow state lives on the SLOT wrapper, not inside TerminalPane:
                  // the slot's overflow:hidden clips any child's outer box-shadow,
                  // but an element's own overflow never clips its own shadow.
                  const actState = session.activityState || (session.status === "running" ? "idle" : session.status);
                  const glowState =
                    actState === "busy" ? "working"
                    : ["thinking", "waiting", "error"].includes(actState) ? actState
                    : "idle";

                  return (
                    <div
                      key={session.id}
                      data-glowable
                      data-state={glowState}
                      onFocusCapture={() => setFocusedIndex(idx)}
                      onMouseDownCapture={() => setFocusedIndex(idx)}
                      style={{
                        borderRadius: 10,
                        overflow: "hidden",
                        minHeight: 0,
                        minWidth: 0,
                        position: "relative",
                        ...slotPlacement,
                        opacity: dragSource === idx ? 0.4 : 1,
                        transition: "opacity 0.2s ease",
                      }}
                      {...dndHandlers}
                    >
                      {dropOverlay}
                      {isPopped ? (
                        <div className="popout-placeholder">
                          <ExternalLink size={20} style={{ color: "var(--text-muted)" }} />
                          <span className="popout-placeholder-name">{session.name}</span>
                          <span className="popout-placeholder-label">Terminal open in separate window</span>
                          <button
                            type="button"
                            className="popout-reclaim-btn"
                            onClick={async () => {
                              // Post RECLAIM so the popout window can self-close (browser path)
                              const bc = new BroadcastChannel("cockpit-popout");
                              bc.postMessage({ type: "RECLAIM", terminalId: session.terminalId });
                              bc.close();
                              // Optimistically clear the placeholder immediately
                              setPoppedOutIds((prev) => { const next = new Set(prev); next.delete(session.terminalId); return next; });
                              // Under Tauri, window.close() in a WebviewWindow has no effect —
                              // close the popout window directly via the Tauri window API.
                              if (window.__TAURI_INTERNALS__ || window.__TAURI__) {
                                try {
                                  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                                  const label = `popout-${session.terminalId.replace(/[^a-zA-Z0-9-]/g, "-")}`;
                                  const w = await WebviewWindow.getByLabel(label);
                                  await w?.close();
                                } catch {
                                  // fall back: BroadcastChannel RECLAIM already posted above
                                }
                              }
                            }}
                          >
                            Reclaim
                          </button>
                        </div>
                      ) : (
                        <TerminalPane
                          ref={(el) => { paneRefs.current[idx] = el; }}
                          session={session}
                          onClose={() => removeSession(session.id)}
                          paneIndex={idx}
                          onSwap={layout > 1 ? swapPanes : undefined}
                          onDragSourceChange={layout > 1 ? setDragSource : undefined}
                          terminalZoom={terminalZoom}
                          toast={toast}
                          onFork={() => forkSession(session.id)}
                          onOpenBridge={() => handleOpenBridge(session.id)}
                          activeBridge={activeBridge}
                          onEndBridge={handleEndBridge}
                          onPopout={session.terminalId ? handlePopout : undefined}
                          workflowSummary={workflowsByTerminal[session.terminalId] || null}
                          usage={usageByTerminal[session.terminalId] || null}
                          onRenameSession={(newName, syncClaude) => renameSession(session.id, newName, syncClaude)}
                        />
                      )}
                      {/* Channel overlay — shown when pane is part of an active channel */}
                      {activeChannel && (
                        <div
                          className="channel-active-glow"
                          style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "4px 10px",
                            backgroundColor: "rgba(255, 140, 0, 0.12)",
                            borderBottom: "1px solid rgba(255, 140, 0, 0.5)",
                            zIndex: 5,
                            pointerEvents: "none",
                          }}
                        >
                          <span
                            style={{
                              fontSize: "10px",
                              fontWeight: 700,
                              letterSpacing: "0.06em",
                              color: "#ff8c00",
                              textShadow: "0 0 8px rgba(255,140,0,0.7)",
                            }}
                          >
                            {activeChannel.isLead ? "CHANNEL LEAD" : "CHANNEL WORKER"} &middot; turn {activeChannel.turns_used}/{activeChannel.max_turns}
                          </span>
                          <button
                            type="button"
                            style={{
                              pointerEvents: "all",
                              fontSize: "10px",
                              fontWeight: 600,
                              color: "#ff8c00",
                              border: "1px solid rgba(255,140,0,0.6)",
                              borderRadius: 4,
                              padding: "1px 7px",
                              backgroundColor: "rgba(255,140,0,0.15)",
                              cursor: "pointer",
                            }}
                            onClick={() => handleEndChannel(activeChannel.channel_id)}
                          >
                            Stop
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }

                return (
                  <div
                    key={`empty-${idx}`}
                    className="flex items-center justify-center"
                    style={{
                      color: "var(--cc-muted, var(--text-muted))",
                      position: "relative",
                      ...slotPlacement,
                      borderRadius: 12,
                      border: "1px dashed var(--cc-border, var(--border-color))",
                      background: "color-mix(in srgb, var(--cc-surface, var(--bg-surface)) 40%, transparent)",
                    }}
                    {...dndHandlers}
                  >
                    {dropOverlay}
                    <button
                      onClick={() => setShowNewDialog(true)}
                      className="text-sm px-4 py-2 rounded-md transition-colors hover-bg-surface"
                      style={{ border: "1px solid var(--cc-border, var(--border-color))" }}
                    >
                      + New Session
                    </button>
                  </div>
                );
              })}
            </main>

            {/* Settings owns INTENT (Phase 4). It renders instead of the panes +
                Inspector, but the pane grid above is only display:none'd — the
                terminals stay mounted so xterm and every WebSocket survive the
                trip through Settings. */}
            {activeSection === "settings" && (
              <SettingsView
                section={settingsSection}
                onSelectSection={setSettingsSection}
              />
            )}

            {/* REPORTS owns "the past" (Phase 7). Clicking a session row obeys
                the handoff's navigation rule — go to Workspace and focus that
                session — rather than opening a trace view that does not exist. */}
            {activeSection === "reports" && (
              <ReportsView
                statusByTerminalId={reportsStatusByTerminal}
                onOpenTrace={(terminalId) => {
                  const s = sessions.find((x) => x.terminalId === terminalId);
                  if (!s) return;
                  setActiveSection("work");
                  selectSession(s.id);
                }}
              />
            )}

            {/* Inspector follows pane focus. Only in Workspace — the full-area
                sections own the whole content width. */}
            {inspectorOpen && activeSection === "work" && (
              <Inspector
                session={focusedSession}
                git={inspectorGit}
                usage={inspectorUsage}
                bridge={inspectorBridge}
                workflows={inspectorWorkflows}
                overrides={{ model, permissionMode, effort, fast }}
                onOverrideChange={applySessionOverride}
                modelOptions={inspectorModelOptions}
                onInterrupt={() => focusedSession && interruptSession(focusedSession.id)}
                onFork={() => focusedSession && forkSession(focusedSession.id)}
                onBridge={() => focusedSession && setBridgeModal({ open: true, fromSessionId: focusedSession.id })}
                onPopOut={() => focusedSession && popOutSession(focusedSession.id)}
                onEndBridge={endFocusedBridge}
                onOpenTranscript={null}
                onCollapse={() => setInspectorOpen(false)}
              />
            )}
          </div>

          <StatusStrip
            connected={sessions.some((s) => s.status === "running")}
            brokerLabel={localStatus?.reachable ? (localStatus.service || "Broker") : "no engine"}
            /* The Claude CLI version is not reported by any endpoint yet —
               resolving the CLI binary + detected version is Settings > Claude
               CLI (backlog 03, Phase 4). Passing null so the strip honestly
               renders "—" rather than reading a field that does not exist on
               /api/local/status. */
            cliVersion={null}
            appVersion={APP_VERSION}
            systemStats={stripSystemStats}
            bridgeCount={bridgeCount}
            todayTokens={todayTokens}
            todayCost={dailyUsage?.est_cost_usd ?? null}
            zoom={terminalZoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            layout={layout}
            onLayoutChange={setLayout}
            onFlip={() => setFlipLayout((v) => !v)}
          />

          {/* Zoom toast */}
          {zoomToast !== null && (
            <div
              style={{
                position: "fixed",
                bottom: 48,
                left: "50%",
                transform: "translateX(-50%)",
                backgroundColor: "var(--bg-elevated)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                padding: "4px 14px",
                fontSize: 13,
                fontWeight: 600,
                zIndex: 200,
                pointerEvents: "none",
                opacity: 0.95,
                boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              }}
            >
              {zoomToast}px
            </div>
          )}
          </div>
        </div>

        {showNewDialog && (
          <NewSessionDialog
            recentLocations={recentLocations}
            savedLocations={savedLocations}
            onConfirm={(name, workdir, bypassPermissions) => {
              setShowNewDialog(false);
              createSession(name, workdir, undefined, { bypassPermissions });
            }}
            onCancel={() => setShowNewDialog(false)}
          />
        )}

        {bridgeModal.open && (() => {
          const fromSession = sessions.find((s) => s.id === bridgeModal.fromSessionId);
          if (!fromSession) return null;
          return (
            <BridgeModal
              open={true}
              fromSession={fromSession}
              allSessions={sessions}
              busyTerminalIds={busyTerminalIds}
              onSendManual={handleSendManual}
              onStartAuto={handleStartAuto}
              onStartChannel={handleStartChannel}
              onClose={handleCloseBridge}
              fetchLatestAssistant={fetchLatestAssistant}
            />
          );
        })()}

        {showOnboarding && <OnboardingModal onDismiss={() => setShowOnboarding(false)} />}
        <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      </div>
  );
}
