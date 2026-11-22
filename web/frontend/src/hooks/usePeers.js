/**
 * Paired machines ("other machines"): one module-scoped store, so Settings >
 * Remote, the sidebar and the New session dialog all read the same list, and a
 * machine added in Settings appears in the sidebar without a reload.
 *
 * `usePeersPoller` is called ONCE, from App. Per peer it polls the session list
 * every PEER_POLL_MS while the peer answers. The first failure carrying a reason
 * (unreachable, unauthorized, an Access refusal) STOPS that poll: the sidebar
 * then shows the reason, and only the cheap /status check runs, every
 * PEER_RECHECK_MS, until it reports the peer working again.
 */
import { useEffect, useSyncExternalStore } from "react";
import { peersApi } from "../utils/peers";

export const PEER_POLL_MS = 5000;
export const PEER_RECHECK_MS = 30000;

let state = { peers: [], loaded: false, error: null, live: {} };
const listeners = new Set();

function emit(next) {
  state = next;
  for (const l of listeners) l();
}
function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}
const getSnapshot = () => state;

function setLive(id, patch) {
  emit({ ...state, live: { ...state.live, [id]: { ...(state.live[id] || {}), ...patch } } });
}

/** Re-read GET /api/peers. Resolves to the call result so a caller can show its error. */
export async function refreshPeers() {
  const r = await peersApi.list();
  if (r.ok) {
    const peers = Array.isArray(r.data?.peers) ? r.data.peers : [];
    const ids = new Set(peers.map((p) => p.id));
    const live = Object.fromEntries(Object.entries(state.live).filter(([id]) => ids.has(id)));
    emit({ ...state, peers, loaded: true, error: null, live });
  } else {
    emit({ ...state, loaded: true, error: r.error });
  }
  return r;
}

/** Ask one peer's status now (Settings shows it per machine). */
export async function checkPeerStatus(id) {
  const r = await peersApi.status(id);
  const status = r.ok ? r.data : { reachable: false, authorized: null, reason: r.reason || "unexpected" };
  setLive(id, { status });
  return status;
}

/** Test hook: reset the module store. */
export function __resetPeersStore() {
  state = { peers: [], loaded: false, error: null, live: {} };
}

export default function usePeers() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function statusOk(s) {
  return !!s && !s.reason && s.reachable && s.authorized;
}

export function usePeersPoller(enabled) {
  const { peers } = usePeers();
  useEffect(() => {
    if (enabled) refreshPeers();
  }, [enabled]);

  const key = peers.map((p) => p.id).join("|");
  useEffect(() => {
    if (!enabled || !key) return undefined;
    let cancelled = false;
    const timers = [];
    for (const id of key.split("|")) {
      let polling = false;
      const tick = async () => {
        if (cancelled) return;
        if (!polling) {
          const s = await checkPeerStatus(id);
          if (cancelled) return;
          if (!statusOk(s)) { timers.push(setTimeout(tick, PEER_RECHECK_MS)); return; }
          polling = true;
        }
        const r = await peersApi.sessions(id);
        if (cancelled) return;
        if (r.ok) {
          const sessions = Array.isArray(r.data?.sessions) ? r.data.sessions : [];
          setLive(id, { sessions, error: null, status: { reachable: true, authorized: true, reason: null } });
          timers.push(setTimeout(tick, PEER_POLL_MS));
        } else if (r.reason || r.status === 0) {
          // Stop polling the list; the reason stands until /status says otherwise.
          polling = false;
          setLive(id, {
            error: r.error,
            status: { reachable: r.reason !== "unreachable", authorized: r.reason === "unauthorized" ? false : null, reason: r.reason || "unreachable" },
          });
          timers.push(setTimeout(tick, PEER_RECHECK_MS));
        } else {
          setLive(id, { error: r.error });
          timers.push(setTimeout(tick, PEER_POLL_MS));
        }
      };
      tick();
    }
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [enabled, key]);
}
