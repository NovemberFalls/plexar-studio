/**
 * LocalEnginePanel — the Reports ▸ Local engine tab, sourced from Plexar.
 *
 * This tab was a "not built yet" placeholder whose stated blocker was that
 * Reports owns the PAST and no stored history of engine metrics existed.
 * Plexar supplies exactly that: range-scoped reporting whose lifetime totals
 * survive container restarts, so the tab is now buildable without mirroring a
 * live panel.
 *
 * TWO SOURCES, NEVER CONFLATED — this is Plexar's rule and the reason this
 * panel groups rather than merges:
 *
 *   gateway-requests   what CONSUMERS experienced. Exact, supports real time
 *                      windows, backend-agnostic.
 *   vllm-prometheus    what the GPU was doing. Cumulative since engine start,
 *                      so a window is only exact for lifetime.
 *
 * The same integer means different things depending on which produced it, so
 * every figure renders under its source with its own `window_exact` flag. A
 * merged single column would be indefensible, which is why there isn't one.
 *
 * This does NOT replace Cockpit's own reporting. Cockpit knows sessions,
 * tokens and cost; Plexar knows the gateway and the GPU. They sit side by side
 * in the same view, each labelled.
 *
 * Honesty rules inherited from format.js: a null NEVER renders as 0. An
 * unreachable Plexar renders its reason, not an empty table — "we could not
 * read this" and "everything was zero" look identical and mean opposite
 * things.
 */

import { useEffect, useState } from "react";

import { DASH, fmtInt, isMissing, toPlexarRange } from "./format.js";

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  minWidth: 0,
};

/** Human wording for each source, shown once per group rather than per row. */
const SOURCE_META = {
  "gateway-requests": {
    label: "Gateway requests",
    blurb: "What consumers experienced. Exact, and honours the selected range.",
  },
  "vllm-prometheus": {
    label: "vLLM engine",
    blurb:
      "What the GPU was doing. Prometheus counters are cumulative since engine start, so only the lifetime range is exact.",
  },
};

/** Engine states that can actually take a request. */
const SERVABLE = new Set(["serving", "degraded"]);

/**
 * What each series plots, per source. Deliberately a per-source list rather
 * than one shared set: the two sources do not measure the same things, and a
 * chart that put them on one axis would be the merge this panel exists to
 * refuse.
 *
 * `kind` decides how a missing value reads:
 *   count — a bar. Zero is a real measurement and is drawn as zero height.
 *   gauge — a line. A null BREAKS the line into a gap, because "nothing was
 *           measured" must not slope through the axis as if it were low.
 */
const SERIES_SPECS = {
  "gateway-requests": [
    { key: "requests", label: "Requests", kind: "count", pick: (b) => b.requests },
    { key: "errors", label: "Errors", kind: "count", pick: (b) => b.errors },
    {
      key: "ttft_p95",
      label: "TTFT p95",
      kind: "gauge",
      unit: "ms",
      pick: (b) => b.ttft_ms?.p95 ?? null,
    },
  ],
  "vllm-prometheus": [
    { key: "tps_avg", label: "Tokens/sec", kind: "gauge", pick: (b) => b.tps_avg },
    {
      key: "kv",
      label: "KV cache",
      kind: "gauge",
      unit: "%",
      pick: (b) => b.kv_cache_pct?.mean ?? null,
    },
  ],
};

const CHART_W = 260;
const CHART_H = 34;

/**
 * One metric over time. Nulls are holes, not zeroes.
 *
 * Plexar emits EVERY bucket in the window, including empty ones, precisely so
 * a client never has to guess whether a gap is "no traffic" or "no data". That
 * only pays off if the renderer honours the difference, which is the entire
 * job of the null handling below.
 */
function MiniChart({ spec, buckets }) {
  const values = buckets.map(spec.pick);
  const known = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (known.length === 0) return null;

  const max = Math.max(...known, spec.kind === "count" ? 1 : 0) || 1;
  const n = values.length;
  const x = (i) => (n === 1 ? 0 : (i / (n - 1)) * CHART_W);
  const y = (v) => CHART_H - (v / max) * (CHART_H - 2) - 1;

  // Contiguous runs of measured points. A gap between runs is a gap on screen.
  const runs = [];
  let run = [];
  values.forEach((v, i) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      run.push([x(i), y(v)]);
    } else if (run.length) {
      runs.push(run);
      run = [];
    }
  });
  if (run.length) runs.push(run);

  const last = [...values].reverse().find((v) => typeof v === "number");

  return (
    <div style={{ padding: "8px 14px", borderTop: "1px solid var(--cc-line)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 10,
          color: "var(--cc-dim)",
          marginBottom: 3,
        }}
      >
        <span>{spec.label}</span>
        <span style={{ color: "var(--cc-muted)" }}>
          peak {fmtInt(Math.round(max))}
          {spec.unit ? ` ${spec.unit}` : ""}
          {typeof last === "number" ? ` · now ${fmtInt(Math.round(last))}` : ""}
        </span>
      </div>
      <svg
        width="100%"
        height={CHART_H}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${spec.label} over time`}
        style={{ display: "block", overflow: "visible" }}
      >
        {spec.kind === "count"
          ? values.map((v, i) =>
              typeof v !== "number" ? null : (
                <rect
                  key={i}
                  x={x(i)}
                  // A measured zero still gets a visible baseline tick — it is
                  // an observation, and drawing nothing there would make it
                  // indistinguishable from a bucket we could not read.
                  y={v === 0 ? CHART_H - 1 : y(v)}
                  width={Math.max(1, CHART_W / n - 1)}
                  height={v === 0 ? 1 : CHART_H - y(v) - 1}
                  fill="var(--cc-accent)"
                  opacity={v === 0 ? 0.35 : 0.75}
                />
              )
            )
          : runs.map((pts, i) => (
              <polyline
                key={i}
                points={pts.map(([px, py]) => `${px},${py}`).join(" ")}
                fill="none"
                stroke="var(--cc-accent)"
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
              />
            ))}
      </svg>
    </div>
  );
}

function StatePill({ state, available }) {
  const tone = SERVABLE.has(state)
    ? "var(--cc-idle)"
    : state === "loading"
      ? "var(--cc-waiting)"
      : "var(--cc-error)";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 800,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: tone,
        border: `1px solid ${tone}`,
        borderRadius: 999,
        padding: "1px 7px",
        whiteSpace: "nowrap",
      }}
      title={available ? "Can take a request now" : "Cannot take a request"}
    >
      {state || "unknown"}
    </span>
  );
}

function Row({ label, value, hint }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 12,
        padding: "6px 14px",
        fontSize: 11,
      }}
    >
      <span style={{ color: "var(--cc-dim)" }} title={hint || undefined}>
        {label}
      </span>
      <span style={{ color: "var(--cc-fg)", fontWeight: 600, whiteSpace: "nowrap" }}>
        {value}
      </span>
    </div>
  );
}

/** A figure's value, respecting the never-fabricate-a-zero rule. */
function figureValue(f) {
  if (isMissing(f.value)) return DASH;
  if (typeof f.value === "number") {
    return f.unit ? `${fmtInt(f.value)} ${f.unit}` : fmtInt(f.value);
  }
  return String(f.value);
}

function Unavailable({ title, reason, action }) {
  return (
    <div style={{ ...CARD, padding: 18, maxWidth: 640 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
        {title}
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-dim)", margin: 0 }}>
        {reason}
      </p>
      {action && (
        <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: "8px 0 0" }}>
          {action}
        </p>
      )}
    </div>
  );
}

export default function LocalEnginePanel({ range }) {
  // ONE state object, written once per load. Separate useStates meant the
  // effect touched React state before its first await, which is a cascading
  // render — and a partially-updated set of three panels is a worse thing to
  // render than a slightly stale complete one.
  const [snap, setSnap] = useState({
    status: "loading", reports: null, instances: null, gpus: null, series: null,
  });

  useEffect(() => {
    let cancelled = false;

    const get = async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    (async () => {
      const [reports, instances, gpus, series] = await Promise.all([
        get(`/api/local/plexar/reports?range=${toPlexarRange(range)}`),
        get("/api/local/plexar/instances"),
        get("/api/local/plexar/gpus"),
        // No `bucket`: Plexar derives it from the range and owns the rule that
        // refuses a series it would have to truncate. Choosing one here would
        // mean re-deriving that rule on the client, badly.
        get(`/api/local/plexar/timeseries?range=${toPlexarRange(range)}`),
      ]);
      // A range change that resolves after unmount (or after a newer range)
      // must not overwrite what is on screen.
      if (!cancelled) setSnap({ status: "ready", reports, instances, gpus, series });
    })();

    return () => {
      cancelled = true;
    };
  }, [range]);

  const { status, reports, instances, gpus, series } = snap;

  if (status === "loading") {
    return <div style={{ fontSize: 11, color: "var(--cc-muted)" }}>Loading engine history…</div>;
  }

  // Plexar absent or unreachable is a legitimate state, not an error: a user
  // with no local engine should read that plainly rather than see a broken tab.
  // Require an EXPLICIT available:true. Every /api/local/plexar/* response
  // carries the envelope, so anything else — a null fetch, an error body, some
  // other endpoint's payload — is not a reading and must not be rendered as
  // one. Checking only `=== false` would let a shapeless 200 fall through into
  // an empty figures table, which reads as "zero engine activity".
  if (reports?.available !== true) {
    return (
      <Unavailable
        title="No local engine history"
        reason={
          reports?.detail ||
          "Plexar is not answering, so there is no local-engine history to show."
        }
        action="Local-engine reporting comes from Plexar. If it is running, check COCKPIT_PLEXAR_URL."
      />
    );
  }

  const figures = reports.figures || [];
  const groups = {};
  for (const f of figures) {
    const key = f.source || "unknown";
    (groups[key] = groups[key] || []).push(f);
  }

  // History, keyed by the SAME source names as the figures — that is what lets
  // a chart sit under the totals it belongs to without either being restated
  // in the other's terms.
  const seriesBySource = (series?.available === true && series.series) || {};

  // A source can have history without a summary figure (or the reverse), so
  // the card list is the union. Driving it from `figures` alone would silently
  // drop a whole chart.
  const sources = [...new Set([...Object.keys(groups), ...Object.keys(seriesBySource)])];

  const inexactHere =
    figures.some((f) => f.window_exact === false) ||
    Object.values(seriesBySource).some((s) => s?.window_exact === false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Engine state — the thing that decides whether any of this is live. */}
      {instances?.available && (
        <div style={CARD}>
          <div
            style={{
              padding: "9px 14px",
              borderBottom: "1px solid var(--cc-border)",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: ".08em",
              color: "var(--cc-muted)",
              textTransform: "uppercase",
            }}
          >
            Engine instances
          </div>
          {(instances.instances || []).map((inst) => (
            <div key={inst.id} style={{ padding: "10px 14px", borderBottom: "1px solid var(--cc-line)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>
                  {inst.served_model_name || inst.id}
                </span>
                <StatePill state={inst.state} available={inst.available} />
                {inst.external && (
                  <span style={{ fontSize: 10, color: "var(--cc-muted)" }} title="Plexar adopted an engine it did not start, so it will not stop it">
                    adopted
                  </span>
                )}
                {/* The container is what a user needs to run `docker logs`, so
                    a wrong name is worse than none. Plexar identifies it from
                    the daemon now; when it cannot, it says why — and an
                    unidentified container is NOT an absent one, so the reason
                    is shown rather than the row silently going blank. */}
                {inst.container ? (
                  <code style={{ fontSize: 10, color: "var(--cc-muted)" }}>{inst.container}</code>
                ) : inst.container_reason ? (
                  <span
                    style={{ fontSize: 10, color: "var(--cc-muted)", fontStyle: "italic" }}
                    title={inst.container_reason}
                  >
                    container not identified
                  </span>
                ) : null}
              </div>
              {/* The reason/action are Plexar's own words — a restarting engine
                  says so, with its ETA, instead of reading as a flat failure. */}
              {inst.reason && (
                <div style={{ fontSize: 11, color: "var(--cc-dim)", lineHeight: 1.5 }}>{inst.reason}</div>
              )}
              {inst.action && !inst.available && (
                <div style={{ fontSize: 11, color: "var(--cc-waiting)", lineHeight: 1.5 }}>
                  {inst.action}
                  {inst.eta_seconds != null ? ` (~${inst.eta_seconds}s)` : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Figures, grouped by source. Never merged into one column. */}
      {sources.map((source) => {
        const rows = groups[source] || [];
        const meta = SOURCE_META[source] || { label: source, blurb: null };
        const buckets = seriesBySource[source]?.buckets || [];
        const specs = SERIES_SPECS[source] || [];
        return (
          <div key={source} style={CARD}>
            <div style={{ padding: "9px 14px", borderBottom: "1px solid var(--cc-border)" }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  letterSpacing: ".08em",
                  color: "var(--cc-muted)",
                  textTransform: "uppercase",
                }}
              >
                {meta.label}
              </div>
              {meta.blurb && (
                <div style={{ fontSize: 10, color: "var(--cc-dim)", marginTop: 3, lineHeight: 1.5 }}>
                  {meta.blurb}
                </div>
              )}
            </div>
            {rows.map((f) => (
              <Row
                key={f.key}
                label={f.key.replace(/_/g, " ")}
                value={figureValue(f)}
                hint={f.note || undefined}
              />
            ))}
            {buckets.length > 0 &&
              specs.map((spec) => (
                <MiniChart key={spec.key} spec={spec} buckets={buckets} />
              ))}
          </div>
        );
      })}

      {series?.truncated && (
        <p style={{ fontSize: 11, color: "var(--cc-muted)", margin: 0, lineHeight: 1.6 }}>
          History reaches only as far back as Plexar&apos;s retention, so this
          range is clipped rather than complete.
        </p>
      )}

      {/* GPUs — physical capacity behind the engine. */}
      {gpus?.available && (gpus.gpus || []).length > 0 && (
        <div style={CARD}>
          <div
            style={{
              padding: "9px 14px",
              borderBottom: "1px solid var(--cc-border)",
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: ".08em",
              color: "var(--cc-muted)",
              textTransform: "uppercase",
            }}
          >
            GPUs
          </div>
          {gpus.gpus.map((g) => (
            <Row
              key={g.uuid}
              label={`${g.name}${g.used_by_display ? " · drives a display" : ""}`}
              value={
                isMissing(g.free_mb) || isMissing(g.total_mb)
                  ? DASH
                  : `${fmtInt(Math.round(g.free_mb))} / ${fmtInt(Math.round(g.total_mb))} MB free`
              }
            />
          ))}
        </div>
      )}

      {reports.engine_unknown && (
        <p style={{ fontSize: 11, color: "var(--cc-waiting)", margin: 0, lineHeight: 1.6 }}>
          Engine counters could not be read for {reports.engine_unknown.instances}{" "}
          instance(s); those figures are absent rather than shown as zero.
        </p>
      )}

      {inexactHere && (
        <p style={{ fontSize: 11, color: "var(--cc-muted)", margin: 0, lineHeight: 1.6 }}>
          Figures marked from the engine are cumulative since it last started, so
          they are not scoped to the selected range. Only the lifetime range is
          exact for those.
        </p>
      )}
    </div>
  );
}
