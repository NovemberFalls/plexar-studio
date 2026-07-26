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

/** Build a backend-comparison row from one provider's /metrics response. */
function backendRow(id, label, m) {
  return {
    id,
    label: label ?? id,
    model: m.served_model ?? null,
    context_length: m.context_length ?? null,
    runs_total: m.runs_total,
    tokens_total: m.tokens_total,
    ttft_ms: m.ttft_ms,
    decode_tokens_per_sec: m.decode_tokens_per_sec,
    queue_wait_ms: m.queue_wait_ms,
    run_time_ms: m.run_time_ms,
    errors_total: m.errors_total,
    attempts_total: m.attempts_total,
    spilled_out: m.spilled_out,
    engine: m.engine ?? null,
    context: m.context ?? null,
  };
}

/**
 * assembleReportingMetrics(primary, providers) — assemble ALL used local
 * providers into a broker-shaped metrics object so every one shows as its own
 * backend column and counts toward the local totals. This is a reporting tool:
 * it must surface every backend that served traffic, not just one.
 *
 * `primary` is the selected provider's /metrics (kept at top level so the hero
 * strip / queue / spill sections still read the selected backend's broker-side
 * fields). `providers` is [{id, label, metrics}] for EVERY metrics-capable
 * provider, primary included. A provider earns a row when its /metrics is
 * reachable AND it actually ran something (runs_total > 0) — idle/unreachable
 * backends are omitted, matching "show all USED providers". Pure; exported for
 * testing.
 */
export function assembleReportingMetrics(primary, providers) {
  const rows = (Array.isArray(providers) ? providers : [])
    .filter(
      (p) =>
        p && p.metrics && p.metrics.reachable !== false &&
        typeof p.metrics.runs_total === "number" && p.metrics.runs_total > 0,
    )
    .map((p) => backendRow(p.id, p.label, p.metrics));
  if (!rows.length) return primary;

  const primaryOk = primary && primary.reachable !== false;
  const base = primaryOk ? primary : {};
  return {
    ...base,
    reachable: true,
    by_provider: rows,
    runs_total: rows.reduce((s, r) => s + (r.runs_total || 0), 0),
    tokens_total: {
      prompt: rows.reduce((s, r) => s + (r.tokens_total?.prompt || 0), 0),
      completion: rows.reduce((s, r) => s + (r.tokens_total?.completion || 0), 0),
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
 * Polls /metrics for a DYNAMIC list of providers in a single tick (Promise.all),
 * returning a { [providerId]: metricsJson | {reachable:false} } map. A React
 * hook can't call usePolledEndpoint in a loop, so this batches the whole list;
 * the effect re-subscribes only when the set of ids (not their order) changes.
 */
function useMultiMetrics(providers, win, enabled) {
  const [byId, setById] = useState({});
  const inFlightRef = useRef(false);
  const ids = (Array.isArray(providers) ? providers : []).map((p) => p.id).sort().join(",");

  useEffect(() => {
    const list = Array.isArray(providers) ? providers : [];
    if (!enabled || !list.length) {
      setById({});
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();

    const tick = async () => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const pairs = await Promise.all(
          list.map(async (p) => {
            try {
              const res = await fetch(
                `/api/local/${encodeURIComponent(p.id)}/metrics?window=${encodeURIComponent(win)}`,
                { signal: controller.signal },
              );
              return [p.id, res.ok ? await res.json() : { reachable: false }];
            } catch (_) {
              return [p.id, { reachable: false }];
            }
          }),
        );
        if (!cancelled) setById(Object.fromEntries(pairs));
      } finally {
        inFlightRef.current = false;
      }
    };

    tick();
    const id = setInterval(tick, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, win, enabled]);

  return byId;
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

  // A reporting tool must show EVERY used backend. Direct-served providers
  // (e.g. vLLM) bypass the broker, so the primary's /metrics never sees them —
  // discover every metrics-capable provider EXCEPT the primary and poll them
  // all together, then assemble one column per used backend.
  const providersList = usePolledEndpoint(enabled ? "/api/local/providers" : null, 60000, enabled);
  const allProviders = useMemo(() => {
    const list = Array.isArray(providersList?.providers) ? providersList.providers : [];
    return list.filter((p) => p && Array.isArray(p.capabilities) && p.capabilities.includes("metrics"));
  }, [providersList]);
  const secondaries = useMemo(
    () => allProviders.filter((p) => p.id !== providerId),
    [allProviders, providerId],
  );
  const secondaryMetrics = useMultiMetrics(secondaries, win, enabled);
  const primaryLabel = useMemo(
    () => allProviders.find((p) => p.id === providerId)?.label ?? providerId,
    [allProviders, providerId],
  );

  const metrics = useMemo(() => {
    const rows = [];
    if (providerId) rows.push({ id: providerId, label: primaryLabel, metrics: primaryMetrics });
    for (const s of secondaries) rows.push({ id: s.id, label: s.label, metrics: secondaryMetrics[s.id] });
    return assembleReportingMetrics(primaryMetrics, rows);
  }, [primaryMetrics, secondaries, secondaryMetrics, providerId, primaryLabel]);

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
