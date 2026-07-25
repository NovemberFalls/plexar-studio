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
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * mergeDirectBackends(base, directs) — fold direct-served providers (e.g. vLLM,
 * which bypasses the broker) into a broker-shaped metrics object so they appear
 * as backend columns AND count toward the local totals.
 *
 * `base` is the primary provider's /metrics (broker-shaped, may be
 * {reachable:false}/null). `directs` is [{id, label, metrics}] where metrics is
 * a per-provider /metrics response (top-level runs_total/tokens_total/etc.).
 * Returns a new metrics object; pure, no side effects. Exported for testing.
 */
export function mergeDirectBackends(base, directs) {
  const rows = (Array.isArray(directs) ? directs : [])
    .filter((d) => d && d.metrics && d.metrics.reachable !== false && typeof d.metrics.runs_total === "number")
    .map((d) => ({
      id: d.id,
      label: d.label ?? d.id,
      model: d.metrics.served_model ?? null,
      context_length: d.metrics.context_length ?? null,
      runs_total: d.metrics.runs_total,
      tokens_total: d.metrics.tokens_total,
      ttft_ms: d.metrics.ttft_ms,
      decode_tokens_per_sec: d.metrics.decode_tokens_per_sec,
      queue_wait_ms: d.metrics.queue_wait_ms,
      run_time_ms: d.metrics.run_time_ms,
      errors_total: d.metrics.errors_total,
    }));
  if (!rows.length) return base;

  const baseOk = base && base.reachable !== false;
  const start = baseOk
    ? base
    : { reachable: true, runs_total: 0, tokens_total: { prompt: 0, completion: 0 }, by_provider: [] };
  const existing = Array.isArray(start.by_provider) ? start.by_provider : [];
  const addRuns = rows.reduce((s, r) => s + (r.runs_total || 0), 0);
  const addPrompt = rows.reduce((s, r) => s + (r.tokens_total?.prompt || 0), 0);
  const addCompletion = rows.reduce((s, r) => s + (r.tokens_total?.completion || 0), 0);

  return {
    ...start,
    reachable: true,
    by_provider: [...existing, ...rows],
    runs_total: (typeof start.runs_total === "number" ? start.runs_total : 0) + addRuns,
    tokens_total: {
      prompt: (start.tokens_total?.prompt || 0) + addPrompt,
      completion: (start.tokens_total?.completion || 0) + addCompletion,
    },
  };
}

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

  const primaryMetrics = usePolledEndpoint(
    providerEnabled ? `/api/local/${pid}/metrics?window=${win}` : null,
    10000,
    providerEnabled,
  );

  // Direct-served backends (e.g. vLLM) bypass the broker, so the primary
  // provider's /metrics never sees them. Discover the first metrics-capable
  // provider that ISN'T the primary and poll it so it shows as its own backend
  // column + counts toward local share. (One secondary today = vLLM; extend the
  // list here if a second direct backend is ever added.)
  const providersList = usePolledEndpoint(enabled ? "/api/local/providers" : null, 60000, enabled);
  const secondary = useMemo(() => {
    const list = Array.isArray(providersList?.providers) ? providersList.providers : [];
    return (
      list.find(
        (p) => p && p.id !== providerId && Array.isArray(p.capabilities) && p.capabilities.includes("metrics"),
      ) || null
    );
  }, [providersList, providerId]);
  const secId = secondary ? encodeURIComponent(secondary.id) : null;
  const secondaryMetrics = usePolledEndpoint(
    enabled && secId ? `/api/local/${secId}/metrics?window=${win}` : null,
    10000,
    enabled && !!secId,
  );

  const metrics = useMemo(
    () =>
      secondary
        ? mergeDirectBackends(primaryMetrics, [
            { id: secondary.id, label: secondary.label, metrics: secondaryMetrics },
          ])
        : primaryMetrics,
    [primaryMetrics, secondary, secondaryMetrics],
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
