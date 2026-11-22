/**
 * useOrchRuns -- the ONE owner of `GET /api/framework/orch-runs`.
 *
 * Module store + useSyncExternalStore, like useLocalModels, so one poller app-wide
 * is structural. `useOrchRunsPoller()` is called once from App; everyone else reads
 * with `useOrchRuns()`. The page never fetches the framework's own port: it sends no
 * CORS headers, so Studio's backend reads it.
 */
import { useEffect, useSyncExternalStore } from "react";

const POLL_MS = 4000;
const EMPTY = Object.freeze({ up: false, base: null, runs: Object.freeze([]), loaded: false });

let state = EMPTY;
const listeners = new Set();
let timer = null;
let pollers = 0;

function publish(next) {
  state = next;
  listeners.forEach((l) => l());
}

async function readOnce() {
  try {
    const res = await fetch("/api/framework/orch-runs");
    if (!res.ok) return;
    const data = await res.json();
    if (!data || data.up !== true || !Array.isArray(data.runs)) {
      // Down or an older framework: no runs, but keep the last base so a frame
      // already on screen is not reloaded by a blip.
      publish({ up: false, base: data?.base || state.base, runs: EMPTY.runs, loaded: true });
      return;
    }
    publish({ up: true, base: data.base || null, runs: data.runs, loaded: true });
  } catch {
    /* best-effort; the previous reading is left in place */
  }
}

function start() {
  if (timer) return;
  readOnce();
  timer = setInterval(readOnce, POLL_MS);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const getSnapshot = () => state;

/** Call ONCE, from App. */
export function useOrchRunsPoller() {
  useEffect(() => {
    pollers += 1;
    start();
    return () => {
      pollers -= 1;
      if (pollers <= 0) stop();
    };
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Read-only subscriber; never fetches. */
export function useOrchRuns() {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Test seam. */
export function _resetOrchRunsForTests() {
  stop();
  pollers = 0;
  state = EMPTY;
  listeners.forEach((l) => l());
}
