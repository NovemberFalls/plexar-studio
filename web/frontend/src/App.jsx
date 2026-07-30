import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Loader, ExternalLink } from "lucide-react";
import TopBar, { getModelProvider } from "./components/TopBar";
import { parseLocalModelId } from "./modelCatalog";
import Sidebar from "./components/Sidebar";
import ActivityRail from "./components/ActivityRail";
import TerminalPane from "./components/TerminalPane";
import StatusBar from "./components/StatusBar";
import NewSessionDialog from "./components/NewSessionDialog";
import { useToast, ToastContainer } from "./components/Toast";
import OnboardingModal from "./components/OnboardingModal";
import BridgeModal from "./components/BridgeModal";
import FleetView from "./components/FleetView";
import ProviderPicker from "./components/ProviderPicker";
import LocalModelsPanel from "./components/LocalModelsPanel";
import TracesPanel from "./components/TracesPanel";
import LocalBrokerView from "./components/LocalBrokerView.jsx";
import { ZOOM_STORAGE_KEY, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, DEFAULT_SPAWN_COLS, DEFAULT_SPAWN_ROWS } from "./utils/terminalFit";
import { computeEndEvents, formatEndEventToast, buildBusyTerminalIds, BRIDGE_KIND, CHANNEL_KIND } from "./utils/bridgeEvents";

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
  const [poppedOutIds, setPoppedOutIds] = useState(new Set()); // session IDs whose terminals are in a separate window
  const [workflowsByTerminal, setWorkflowsByTerminal] = useState({}); // { [terminalId]: { count, inProgressCount, items } }
  const [usageByTerminal, setUsageByTerminal] = useState({}); // { [terminalId]: { ...session_summary, effort, tokensPerSec } }
  const [dailyUsage, setDailyUsage] = useState(null); // usage_tracker.daily_summary() shape
  const [showFleetView, setShowFleetView] = useState(false);
  // Local model broker (machine-global): queue + metrics. Polling is gated on
  // localEnabled so a disabled feature does zero background work.
  const [localEnabled, setLocalEnabled] = useState(() => {
    try { return localStorage.getItem("cockpit-local-enabled") === "true"; } catch (_) { return false; }
  });
  const [localQueue, setLocalQueue] = useState(null);   // GET /api/local/queue, or null/offline
  const [localMetrics, setLocalMetrics] = useState(null); // GET /api/local/metrics
  const [, setLocalSpill] = useState(null);   // GET /api/local/spill (per-class thresholds + counters)
  const [localStatus, setLocalStatus] = useState(null); // GET /api/local/status — what's actually connected
  const [showLocalBroker, setShowLocalBroker] = useState(false); // full-page Local Broker section (rail-opened)
  const [metricsWindow] = useState("lifetime"); // lifetime | 24h | session (legacy TopBar quick-glance poller)
  // Provider registry (ProviderPicker owns the fetch + localStorage selection;
  // this mirrors the full selected provider object back up so App can gate
  // per-capability polling and panel rendering).
  const [selectedProvider, setSelectedProvider] = useState(null); // {id,label,kind,scope,capabilities} | null
  const [localModels, setLocalModels] = useState(null); // GET /api/local/{id}/models
  const [localTraces, setLocalTraces] = useState(null); // GET /api/local/{id}/traces
  const [localBusyModelId, setLocalBusyModelId] = useState(null); // model id loading/unloading, or null
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

    // Poll for Tauri IPC bridge (may not be injected immediately on remote URLs)
    const waitForTauri = () => new Promise((resolve) => {
      const isTauri = () => !!(window.__TAURI_INTERNALS__ || window.__TAURI__);
      if (isTauri()) return resolve(true);
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (isTauri()) { clearInterval(interval); resolve(true); }
        else if (attempts >= 20) { clearInterval(interval); resolve(false); } // 2s max
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
    return () => { cancelled = true; };
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
            const normPath = dir.replace(/\//g, "\\").replace(/\\$/, "");
            results[normPath] = data;
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

  // Poll the selected provider's models + traces every 10s — only when the
  // capability is present (mirrors the queue/metrics gating above). Renders
  // nothing (panel omitted) when the capability is absent for this provider.
  useEffect(() => {
    if (!backendReady || !localEnabled || !selectedProvider) {
      setLocalModels(null);
      setLocalTraces(null);
      return;
    }
    const providerId = selectedProvider.id;
    const caps = selectedProvider.capabilities || [];
    const controller = new AbortController();
    const { signal } = controller;

    const fetchModelsAndTraces = async () => {
      if (caps.includes("models")) {
        try {
          const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/models`, { signal });
          setLocalModels(res.ok ? await res.json() : { reachable: false });
        } catch (_) {
          // swallow — best-effort
        }
      } else {
        setLocalModels(null);
      }
      if (caps.includes("traces")) {
        try {
          const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/traces`, { signal });
          setLocalTraces(res.ok ? await res.json() : { reachable: false });
        } catch (_) {
          // swallow — best-effort
        }
      } else {
        setLocalTraces(null);
      }
    };

    fetchModelsAndTraces();
    // Poll fast (2s) while a load/unload is in flight so the progress bar
    // resolves promptly once the model's state flips; back to 10s when idle.
    const id = setInterval(fetchModelsAndTraces, localBusyModelId ? 2000 : 10000);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [backendReady, localEnabled, selectedProvider, localBusyModelId]);

  // Clear the busy marker once the /models poll shows the target model has
  // settled (LM Studio reports no progress %, so state transition IS the signal).
  useEffect(() => {
    if (!localBusyModelId) return;
    const list = Array.isArray(localModels?.models) ? localModels.models : [];
    const m = list.find((x) => x.id === localBusyModelId);
    // Busy clears when the model appears loaded (a load completed) or is gone /
    // not-loaded after an unload — either way its steady state is reached.
    if (m && m.state === "loaded") setLocalBusyModelId(null);
  }, [localModels, localBusyModelId]);

  // Load / unload a local model (LM Studio hot-swap via the model-control API).
  const loadLocalModel = useCallback(async (modelId) => {
    if (!selectedProvider) return;
    setLocalBusyModelId(modelId);
    try {
      const res = await fetch(
        `/api/local/${encodeURIComponent(selectedProvider.id)}/models/${encodeURIComponent(modelId)}/load`,
        { method: "POST" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast(data.error || "Could not load model", "error");
        setLocalBusyModelId(null);
      }
    } catch (_) {
      toast("Provider unreachable — model not loaded", "error");
      setLocalBusyModelId(null);
    }
  }, [toast, selectedProvider]);

  // Load a local model from the TopBar picker, where the target provider may
  // differ from the LocalBrokerView's currently `selectedProvider`. Dispatches
  // by API behavior rather than needing a fetched provider-capability lookup:
  // LM Studio's /load endpoint succeeds directly; vLLM's /load 409s (it can
  // only serve one model per container), so a 409 falls through to /restart.
  const loadOrRestartLocalModel = useCallback(async (providerId, modelId) => {
    if (!providerId || !modelId) return;
    setLocalBusyModelId(modelId);
    try {
      const res = await fetch(
        `/api/local/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/load`,
        { method: "POST" },
      );
      if (res.ok) return;
      if (res.status === 409) {
        const rres = await fetch(`/api/local/${encodeURIComponent(providerId)}/restart`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelId }),
        });
        const rdata = await rres.json().catch(() => ({}));
        if (!rres.ok || !rdata?.ok) {
          toast(rdata?.error || "Could not start model", "error");
        } else {
          toast(`Restarting with ${modelId}…`, "info");
        }
        return;
      }
      const data = await res.json().catch(() => ({}));
      toast(data.error || "This provider doesn't support loading models", "error");
    } catch (_) {
      toast("Provider unreachable — model not loaded", "error");
    } finally {
      setLocalBusyModelId(null);
    }
  }, [toast]);

  const unloadLocalModel = useCallback(async (modelId) => {
    if (!selectedProvider) return;
    setLocalBusyModelId(modelId);
    try {
      const res = await fetch(
        `/api/local/${encodeURIComponent(selectedProvider.id)}/models/${encodeURIComponent(modelId)}/unload`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast(data.error || "Could not unload model", "error");
    } catch (_) {
      toast("Provider unreachable — model not unloaded", "error");
    } finally {
      // An unload has no "loaded" target for the effect above to key on, so
      // clear the marker here once the request settles; the next poll refreshes state.
      setLocalBusyModelId(null);
    }
  }, [toast, selectedProvider]);

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

  useEffect(() => {
    const handler = (e) => {
      if (e.ctrlKey && e.shiftKey && e.key === "N") {
        e.preventDefault();
        setShowNewDialog(true);
      }
      if (e.ctrlKey && e.shiftKey && e.key === "B") {
        e.preventDefault();
        setSidebarOpen((p) => !p);
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
  }, [createSession, activeIds, layout, zoomIn, zoomOut, zoomReset]);

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
        <div className="relative z-10 flex flex-col h-full">
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
            showFleetView={showFleetView}
            setShowFleetView={setShowFleetView}
            localEnabled={localEnabled}
            setLocalEnabled={setLocalEnabled}
            localLaunchEnabled={localEnabled}
            localQueue={localQueue}
            localMetrics={localMetrics}
            localStatus={localStatus}
            onOpenLocalBroker={() => { setShowLocalBroker(true); setShowFleetView(false); }}
            onLoadLocalModel={loadOrRestartLocalModel}
            localBusyModelId={localBusyModelId}
          />

          <div className="flex flex-1 min-h-0">
            <ActivityRail
              onNew={() => setShowNewDialog(true)}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={() => setSidebarOpen((p) => !p)}
              showFleetView={showFleetView}
              onToggleFleet={() => { setShowFleetView((v) => !v); setShowLocalBroker(false); }}
              onSearch={() => {
                setSidebarOpen(true);
                // Focus the sidebar filter input if the Sidebar exposes one.
                requestAnimationFrame(() => {
                  const el = document.querySelector("[data-sidebar-filter]");
                  if (el) el.focus();
                });
              }}
              showLocalBroker={showLocalBroker}
              onToggleLocalBroker={() => { setShowLocalBroker((v) => !v); setShowFleetView(false); }}
            />
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
                onClose={() => setShowFleetView(false)}
              />
            )}
            {showLocalBroker && (
              <LocalBrokerView
                localEnabled={localEnabled}
                setLocalEnabled={setLocalEnabled}
                localStatus={localStatus}
                localQueue={localQueue}
                selectedProvider={selectedProvider}
                localModels={localModels}
                onSpillChange={commitSpill}
                onToast={toast}
                onModelsRefresh={setLocalModels}
                onClose={() => setShowLocalBroker(false)}
              >
                {/* Provider panels render inside the view's Provider card —
                    each renders nothing when its capability is absent. */}
                <ProviderPicker enabled={localEnabled} onSelect={setSelectedProvider} />
                {selectedProvider?.capabilities?.includes("models") && (
                  <LocalModelsPanel
                    models={localModels}
                    providerKind={selectedProvider?.kind}
                    controlEnabled={selectedProvider?.capabilities?.includes("model-control")}
                    busyModelId={localBusyModelId}
                    onLoad={loadLocalModel}
                    onUnload={unloadLocalModel}
                  />
                )}
                {selectedProvider?.capabilities?.includes("traces") && (
                  <TracesPanel traces={localTraces} providerId={selectedProvider.id} />
                )}
              </LocalBrokerView>
            )}

            {/* Pane grid — always mounted, terminals never unmount. Hidden
                (NOT unmounted — xterm/WS must survive) while a view is open. */}
            <main
              className="flex-1 min-w-0"
              style={{
                display: showFleetView || showLocalBroker ? "none" : "grid",
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


          </div>

          <StatusBar
            layout={layout}
            setLayout={setLayout}
            flipLayout={flipLayout}
            setFlipLayout={setFlipLayout}
            sessions={sessions}
            connected={sessions.some((s) => s.status === "running")}
            terminalZoom={terminalZoom}
            onZoomIn={zoomIn}
            onZoomOut={zoomOut}
            onZoomReset={zoomReset}
            systemStats={systemStats}
            onShowOnboarding={() => setShowOnboarding(true)}
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
