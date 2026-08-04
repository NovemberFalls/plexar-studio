/**
 * useLocalModels — the ONE owner of `GET /api/local/{provider}/models`.
 *
 * WHY A MODULE STORE INSTEAD OF A PLAIN HOOK: this endpoint had THREE
 * independent owners — App.jsx's busy-marker poller (10s, selected provider),
 * EngineView's slow poll (10s, selected provider), and ModelCatalogProvider's
 * picker poll (20s, EVERY provider). A plain hook would not have fixed that:
 * each call site would still start its own interval. State, the timer and the
 * per-provider cache therefore live at module scope, so "one request per
 * provider per tick" is structural rather than a convention someone has to
 * remember.
 *
 * THREE ENTRY POINTS:
 *   useLocalModelsPoller({...})  — call ONCE (App.jsx). Declares the SELECTED
 *                                  provider and whether anyone is watching it.
 *   useLocalModelsCatalog()      — call ONCE (ModelCatalogProvider). Discovers
 *                                  every provider for the model picker.
 *   useLocalModels(providerId?)  — read-only subscriber for anyone else
 *                                  (EngineView / EngineModels). Never fetches.
 *
 * `models` is deliberately tri-state, matching what Engine already renders:
 *   undefined — not offered (no `models` capability) or nothing read yet
 *   null      — offered but the read failed outright
 *   object    — the response ({reachable:false} when the provider is down)
 *
 * CAPABILITY GATE (load-bearing, not hygiene): a provider whose `capabilities`
 * omits `models` is NEVER asked. That route answers 404 "capability not
 * available", and the old catalog rendered the 404 as `reachable:false` — i.e.
 * it told the user a perfectly healthy backend was OFFLINE. "Cannot answer" and
 * "is not answering" are different claims and only one of them is about health.
 *
 * BUSY MARKER: one marker for the whole app. A load started from the TopBar
 * picker and a load started from Engine ▸ Models light the same spinner, because
 * both writes go through this module. It clears when the polled list reports the
 * target model `state === "loaded"` (LM Studio publishes no progress
 * percentage, so the state transition IS the progress signal) or when the write
 * settles, whichever happens first.
 *
 * CADENCE — one timer, per-provider due times:
 *   selected + watched  : 10s, or 2s while a write is in flight
 *   every other provider: 20s (the picker's original cadence, unchanged)
 * The timer runs at the FASTEST period any provider currently wants and each
 * provider fires only when its own period has elapsed. So a write does not drag
 * N providers up to a 2s cadence — only the one being written to. A provider
 * that is both selected-and-watched AND in the catalog is scheduled ONCE, at the
 * faster of the two periods; that collapse is the dedup.
 *
 * IDLE POLLING: the selected provider is not polled on its own account unless
 * somebody is looking (`watching`) or a write is in flight. A 10s read for a
 * closed picker and a hidden Engine tab is work spent on nobody.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

const IDLE_MS = 10000;
const BUSY_MS = 2000;
/** The model picker's original cadence — local models load/unload often. */
const CATALOG_MS = 20000;

/** Same localStorage flag App.jsx owns; the catalog sits above App. */
const LOCAL_ENABLED_KEY = "cockpit-local-enabled";
function readLocalEnabled() {
  try {
    return localStorage.getItem(LOCAL_ENABLED_KEY) === "true";
  } catch (_) {
    return false;
  }
}

/** True when this provider advertises a model list at all. */
export function offersModels(provider) {
  return Array.isArray(provider?.capabilities) && provider.capabilities.includes("models");
}

/** True when Plexar Studio can load/unload/restart models on this provider. Without
 *  it the provider is browse-only: only the model it is already serving can be
 *  used, and Plexar Studio cannot change which one that is. */
export function offersModelControl(provider) {
  return Array.isArray(provider?.capabilities) && provider.capabilities.includes("model-control");
}

const EMPTY = Object.freeze({});

let snapshot = {
  models: undefined, // the SELECTED provider's list (back-compat single read)
  busyModelId: null,
  byProvider: EMPTY, // { [providerId]: response } — only providers we may ask
  providers: null, // discovered registry, or null before discovery
};
const subscribers = new Set();

/** Non-reactive scheduling config, written by the two owner hooks. */
let config = {
  pollerEnabled: false,
  selectedProvider: null,
  watching: false,
  catalogActive: false,
  catalogEnabled: false,
  catalogProviders: null,
};

/** Set by the poller so module-level writes can surface user-facing errors. */
let toastFn = null;

// ---------------------------------------------------------------- store plumbing

function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

function getSnapshot() {
  return snapshot;
}

function publish(patch) {
  const next = { ...snapshot, ...patch };
  // The selected provider's list is DERIVED from the map, so a single read and a
  // catalog read of the same provider can never disagree.
  const sel = config.selectedProvider;
  next.models = sel && offersModels(sel) ? next.byProvider[sel.id] : undefined;
  let changed = false;
  for (const k of Object.keys(next)) {
    if (next[k] !== snapshot[k]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  snapshot = next;
  for (const cb of Array.from(subscribers)) cb();
}

function toast(message, kind) {
  if (typeof toastFn === "function") toastFn(message, kind);
}

// ------------------------------------------------------------------- the writes

/** Marks a model busy for every surface at once. */
export function setLocalModelBusy(modelId) {
  publish({ busyModelId: modelId || null });
  // The busy marker changes the selected provider's cadence (10s -> 2s).
  syncScheduler();
}

/**
 * What to say when a provider answers 404 to a load — i.e. Plexar Studio does not own
 * it and cannot switch its model. vLLM is named when the provider is one,
 * because "restart vLLM with --model X" is a command the user can actually run;
 * for anything else we state the same shape without inventing a flag.
 */
export function unswitchableModelMessage(providerId) {
  if (/vllm/i.test(String(providerId || ""))) {
    return (
      "vLLM serves one model, fixed by --model when it starts, and this one runs outside Plexar Studio. " +
      "To use a different model, restart vLLM with it."
    );
  }
  return (
    "This engine serves one model, fixed when it starts, and runs outside Plexar Studio. " +
    "To use a different model, restart the engine with it."
  );
}

/**
 * Load a model, restarting the provider when it can only serve one.
 *
 * Dispatches by API behaviour rather than a capability lookup:
 *   200 — LM Studio loaded it directly.
 *   409 — a MANAGED vLLM cannot hot-load (one model per container), so fall
 *         through to /restart, which is the only mechanism that works.
 *   404 — the provider does not declare `model-control` at all, so this control
 *         should not have been offered. That is NOT a failure: an EXTERNAL vLLM
 *         answers 404 here because Plexar Studio does not own its container. Report it
 *         as information and point at the surface that explains it in full,
 *         rather than a red "doesn't support loading models" alarm about a
 *         perfectly healthy backend.
 */
export async function loadOrRestartLocalModel(providerId, modelId) {
  if (!providerId || !modelId) return;
  setLocalModelBusy(modelId);
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
    if (res.status === 404) {
      // Not offered, not broken. See the docstring: an external vLLM lands here.
      // The message must carry the ACTION, not a pointer to another screen: the
      // owner followed "see Engine ▸ Models" and still ended up asking where the
      // model is changed. Say what to do, here, in one sentence.
      toast(unswitchableModelMessage(providerId), "info");
      return;
    }
    toast(data.error || "Could not load model", "error");
  } catch (_) {
    toast("Provider unreachable — model not loaded", "error");
  } finally {
    setLocalModelBusy(null);
  }
}

/**
 * The plain load/unload write used by Engine ▸ Models, where the provider is
 * known to declare `model-control` and no restart fallback is wanted.
 */
export async function writeLocalModel(providerId, modelId, action, onToast) {
  if (!providerId || !modelId) return;
  // The caller may own a nearer toast channel (Engine passes its own prop); fall
  // back to the shell's when it does not.
  const say = typeof onToast === "function" ? onToast : toast;
  setLocalModelBusy(modelId);
  try {
    const res = await fetch(
      `/api/local/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}/${action}`,
      { method: "POST" },
    );
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload?.ok === false) {
      say(payload?.error || `Could not ${action} ${modelId}`, "error");
    } else {
      say(`${action === "load" ? "Loading" : "Unloading"} ${modelId}…`, "info");
    }
  } catch (_) {
    say(`Could not reach Plexar Studio to ${action} the model`, "error");
  } finally {
    setLocalModelBusy(null);
  }
}

// --------------------------------------------------------------- the ONE poller

let timer = null;
let timerPeriod = 0;
/** Virtual clock advanced BY the timer, so due times need no wall clock. */
let elapsed = 0;
/**
 * providerId -> the `elapsed` at which we last READ it. Deliberately the last
 * read and not a precomputed due time: when a provider's period SHORTENS
 * (10s -> 2s the instant a write starts) a stored due time would still be
 * 10s out and the fast cadence would never fire, so the spinner would hang
 * until the slow tick came round.
 */
const lastAt = new Map();
const inflight = new Map(); // providerId -> AbortController
let retainCount = 0;

function schedulerEnabled() {
  return config.pollerEnabled || (config.catalogActive && config.catalogEnabled);
}

/**
 * How often this provider should be read, or 0 when it should not be read at
 * all. The selected provider wins when both claims apply — one entry, faster
 * period, ONE request.
 */
function periodFor(providerId) {
  if (!schedulerEnabled()) return 0;
  const sel = config.selectedProvider;
  if (
    config.pollerEnabled &&
    sel &&
    sel.id === providerId &&
    offersModels(sel) &&
    (config.watching || snapshot.busyModelId)
  ) {
    return snapshot.busyModelId ? BUSY_MS : IDLE_MS;
  }
  if (config.catalogActive && config.catalogEnabled) {
    const p = (config.catalogProviders || []).find((x) => x && x.id === providerId);
    // The capability gate. A provider without `models` is never asked, and is
    // NOT recorded as unreachable — see the header comment.
    if (p && offersModels(p)) return CATALOG_MS;
  }
  return 0;
}

function scheduledIds() {
  const ids = new Set();
  const sel = config.selectedProvider;
  if (sel?.id) ids.add(sel.id);
  for (const p of config.catalogProviders || []) if (p?.id) ids.add(p.id);
  const out = [];
  for (const id of ids) if (periodFor(id) > 0) out.push(id);
  return out;
}

async function readProvider(providerId) {
  inflight.get(providerId)?.abort();
  const controller = new AbortController();
  inflight.set(providerId, controller);
  try {
    const res = await fetch(`/api/local/${encodeURIComponent(providerId)}/models`, {
      signal: controller.signal,
    });
    // KEEP THE SERVER'S OWN ANSWER. This used to discard the body on any
    // non-2xx and substitute a bare {reachable:false} -- so a rig that was up
    // and refusing the credential arrived at the picker indistinguishable from
    // a rig that was down. The server states `reason` and `action`; throwing
    // them away here is where the distinction was actually lost.
    const parsed = await res.json().catch(() => null);
    const body = parsed ?? { reachable: false, reason: res.ok ? "unreadable" : "unreachable" };
    publish({ byProvider: { ...snapshot.byProvider, [providerId]: body } });
  } catch (_) {
    // swallow — best-effort background read; keep the last good list
  } finally {
    if (inflight.get(providerId) === controller) inflight.delete(providerId);
  }
}

/** Read every provider whose own period has elapsed since its last read. */
function pump() {
  for (const id of scheduledIds()) {
    const at = lastAt.get(id);
    if (at === undefined || elapsed - at >= periodFor(id)) {
      lastAt.set(id, elapsed);
      readProvider(id);
    }
  }
}

function tick() {
  elapsed += timerPeriod;
  pump();
}

function stopTimer() {
  if (timer !== null) clearInterval(timer);
  timer = null;
  timerPeriod = 0;
}

/**
 * Reconcile the single timer with the current config. Runs the timer at the
 * fastest period anyone wants; each provider still fires only on its own.
 */
function syncScheduler() {
  const ids = scheduledIds();

  // Drop state for providers that are no longer scheduled, and abort their reads
  // (this is what makes a provider switch cancel the outgoing request).
  for (const id of Array.from(lastAt.keys())) if (!ids.includes(id)) lastAt.delete(id);
  for (const id of Array.from(inflight.keys())) {
    if (!ids.includes(id)) {
      inflight.get(id).abort();
      inflight.delete(id);
    }
  }

  if (retainCount === 0 || ids.length === 0) {
    stopTimer();
    return;
  }
  const base = Math.min(...ids.map(periodFor));
  if (base !== timerPeriod) {
    stopTimer();
    timerPeriod = base;
    timer = setInterval(tick, base);
  }
  pump();
}

function retain() {
  retainCount += 1;
}

function release() {
  retainCount = Math.max(0, retainCount - 1);
  if (retainCount === 0) {
    stopTimer();
    lastAt.clear();
    for (const c of inflight.values()) c.abort();
    inflight.clear();
  }
}

/** Test seam: drop all state between cases so the module store never leaks. */
export function __resetLocalModelsStore() {
  stopTimer();
  for (const c of inflight.values()) c.abort();
  inflight.clear();
  lastAt.clear();
  elapsed = 0;
  retainCount = 0;
  snapshot = { models: undefined, busyModelId: null, byProvider: EMPTY, providers: null };
  subscribers.clear();
  config = {
    pollerEnabled: false,
    selectedProvider: null,
    watching: false,
    catalogActive: false,
    catalogEnabled: false,
    catalogProviders: null,
  };
  toastFn = null;
}

// -------------------------------------------------------------------- consumers

/**
 * Read-only subscriber. Returns the shared snapshot plus the write actions, so a
 * consumer never needs the endpoint, the provider list, or its own interval.
 *
 * @param providerId optional — read a SPECIFIC provider instead of the selected
 *                   one. Omit it for the original single-provider behaviour.
 */
export default function useLocalModels(providerId) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const models = providerId ? snap.byProvider[providerId] : snap.models;
  return {
    models,
    byProvider: snap.byProvider,
    providers: snap.providers,
    busyModelId: snap.busyModelId,
    loadOrRestartModel: loadOrRestartLocalModel,
    writeModel: writeLocalModel,
  };
}

/**
 * The selected-provider owner. Call once, from the shell.
 *
 * @param enabled  master local-inference flag AND backend readiness
 * @param provider selected provider {id, capabilities} or null
 * @param watching true when a surface is actually displaying models (Engine
 *                 visible, or the TopBar picker open). False means no idle poll.
 * @param onToast  (message, kind) => void for the write paths
 */
export function useLocalModelsPoller({ enabled = false, provider = null, watching = false, onToast } = {}) {
  const store = useLocalModels();
  const { busyModelId } = store;

  useEffect(() => {
    toastFn = typeof onToast === "function" ? onToast : null;
  }, [onToast]);

  const providerId = provider?.id || null;
  const offers = offersModels(provider);

  useEffect(() => {
    retain();
    return release;
  }, []);

  useEffect(() => {
    config = {
      ...config,
      pollerEnabled: Boolean(enabled),
      // Rebuilt from the primitives this effect depends on, so a fresh
      // capabilities array each parent render does not resubscribe anything.
      selectedProvider: providerId ? { id: providerId, capabilities: offers ? ["models"] : [] } : null,
      watching: Boolean(watching),
    };
    // The derived `models` follows the selection, not just the map.
    publish({});
    syncScheduler();
  }, [enabled, providerId, offers, watching, busyModelId]);

  // Early clear: the moment the polled list says the target model is loaded, the
  // spinner goes away — we do not wait for the (much slower) write to return.
  const models = store.models;
  useEffect(() => {
    if (!busyModelId) return;
    const list = Array.isArray(models?.models) ? models.models : [];
    const m = list.find((x) => x && x.id === busyModelId);
    if (m && m.state === "loaded") setLocalModelBusy(null);
  }, [models, busyModelId]);

  const refresh = useCallback(() => {
    if (!enabled || !providerId || !offers) return;
    lastAt.delete(providerId);
    pump();
  }, [enabled, providerId, offers]);

  return { ...store, refresh };
}

/**
 * The model-picker owner (ModelCatalogProvider). Discovers the registry and
 * declares every provider a candidate for the 20s catalog cadence; the actual
 * /models reads go through the same scheduler as the selected provider, so a
 * provider that is both is read ONCE.
 *
 * Discovery re-reads the localStorage enable flag on every tick (not just on
 * mount) so switching local inference off clears the picker without a remount.
 */
export function useLocalModelsCatalog({ pollMs = CATALOG_MS } = {}) {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    retain();
    config = { ...config, catalogActive: true };
    return () => {
      config = { ...config, catalogActive: false, catalogProviders: null, catalogEnabled: false };
      release();
      syncScheduler();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const discover = async () => {
      if (!readLocalEnabled()) {
        if (cancelled) return;
        config = { ...config, catalogEnabled: false, catalogProviders: null };
        publish({ providers: null, byProvider: EMPTY });
        syncScheduler();
        return;
      }
      let list = null;
      try {
        const res = await fetch("/api/local/providers");
        if (res.ok) {
          const data = await res.json();
          list = Array.isArray(data?.providers) ? data.providers : [];
        }
      } catch (_) {
        // swallow — keep whatever registry we had; the picker still works
      }
      if (cancelled || list === null) return;
      config = { ...config, catalogEnabled: true, catalogProviders: list };
      publish({ providers: list });
      syncScheduler();
    };

    discover();
    const id = setInterval(discover, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pollMs]);

  return useMemo(
    () => ({ providers: snap.providers, byProvider: snap.byProvider }),
    [snap.providers, snap.byProvider]
  );
}
