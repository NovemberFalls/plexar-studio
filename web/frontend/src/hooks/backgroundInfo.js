// What the background layer knows about the current image, shared with the
// Settings card so its Speed slider can be honest. `type` is the server's
// content type; `animated` is null until a decode has answered (it can only be
// known by decoding), then true or false.
import { useSyncExternalStore } from "react";

let state = { type: null, animated: null };
const listeners = new Set();

export function setBackgroundInfo(patch) {
  const next = { ...state, ...patch };
  if (next.type === state.type && next.animated === state.animated) return;
  state = next;
  listeners.forEach((l) => l());
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const snapshot = () => state;

export function useBackgroundInfo() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
