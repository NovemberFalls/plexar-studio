/**
 * localReporting/useReportingData.js — polling data layer for the Routing &
 * Reporting view (design handoff: design_handoff_local_reporting/README.md,
 * "State Management" + "Polling"). Mirrors App.jsx's existing poller shape
 * (async fn in a useEffect, `cancelled` flag on cleanup, in-flight guard so a
 * slow tick never stacks, `reachable:false` envelope on failure) but scoped
 * to this view only — nothing here runs when `enabled` is false.
 *
 * Broker endpoints are provider-keyed (/api/local/{providerId}/...);
 * /api/usage/summary and /api/pricing/models are global (not provider-keyed).
 */
import { useEffect, useRef, useState } from "react";

// window -> timeseries bucket size, per the handoff's bucket table.
function bucketForWindow(window) {
  if (window === "session") return "5m";
  if (window === "24h") return "1h";
  // "7d" and "lifetime" both bucket daily.
  return "1d";
}

/**
 * One polling slot: fetches `url` (or skips when `url` is null) on the given
 * interval, storing the JSON (or `{reachable:false}` on any failure) into
 * state. Skips a tick if the previous request for this slot is still in
 * flight. All polling stops when `enabled` is false or `url` is null.
 */
function usePolledEndpoint(url, intervalMs, enabled) {
  const [data, setData] = useState(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled || !url) {
      setData(null);
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const res = await fetch(url, { signal: controller.signal });
        if (cancelled) return;
        setData(res.ok ? await res.json() : { reachable: false });
      } catch (_) {
        if (!cancelled) setData({ reachable: false });
      } finally {
        inFlightRef.current = false;
      }
    };

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
      controller.abort();
    };
  }, [url, intervalMs, enabled]);

  return data;
}

/**
 * useReportingData(providerId, { enabled, window })
 *
 * Returns { metrics, timeseries, queue, spillConfig, spills, models,
 * apiUsage, pricing } — each null until its first fetch resolves, each
 * carrying reachable:false on failure. All polling pauses when `enabled` is
 * false (view not mounted / local broker disabled) or `providerId` is falsy
 * for provider-keyed endpoints.
 */
export default function useReportingData(providerId, { enabled = false, window = "lifetime" } = {}) {
  const pid = providerId ? encodeURIComponent(providerId) : null;
  const providerEnabled = enabled && !!pid;
  const bucket = bucketForWindow(window);
  const win = encodeURIComponent(window);

  const queue = usePolledEndpoint(
    providerEnabled ? `/api/local/${pid}/queue` : null,
    2000,
    providerEnabled,
  );

  const metrics = usePolledEndpoint(
    providerEnabled ? `/api/local/${pid}/metrics?window=${win}` : null,
    10000,
    providerEnabled,
  );

  const timeseries = usePolledEndpoint(
    providerEnabled ? `/api/local/${pid}/metrics/timeseries?window=${win}&bucket=${bucket}` : null,
    60000,
    providerEnabled,
  );

  const spillConfig = usePolledEndpoint(
    providerEnabled ? `/api/local/${pid}/spill` : null,
    10000,
    providerEnabled,
  );

  const spills = usePolledEndpoint(
    providerEnabled ? `/api/local/${pid}/spills?limit=50` : null,
    30000,
    providerEnabled,
  );

  const models = usePolledEndpoint(
    providerEnabled ? `/api/local/${pid}/models` : null,
    60000,
    providerEnabled,
  );

  // Global (not provider-keyed) — still gated by `enabled` so the view stays
  // fully paused when closed, but not by provider selection.
  const apiUsage = usePolledEndpoint(
    enabled ? `/api/usage/summary?window=${win}` : null,
    60000,
    enabled,
  );

  // Fetch once, then refresh hourly — pricing is a checked-in JSON table,
  // not a live feed.
  const pricing = usePolledEndpoint(
    enabled ? "/api/pricing/models" : null,
    3600000,
    enabled,
  );

  return { metrics, timeseries, queue, spillConfig, spills, models, apiUsage, pricing };
}
