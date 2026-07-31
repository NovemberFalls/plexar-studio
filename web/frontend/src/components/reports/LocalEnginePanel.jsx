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
  const [snap, setSnap] = useState({ status: "loading", reports: null, instances: null, gpus: null });

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
      const [reports, instances, gpus] = await Promise.all([
        get(`/api/local/plexar/reports?range=${toPlexarRange(range)}`),
        get("/api/local/plexar/instances"),
        get("/api/local/plexar/gpus"),
      ]);
      // A range change that resolves after unmount (or after a newer range)
      // must not overwrite what is on screen.
      if (!cancelled) setSnap({ status: "ready", reports, instances, gpus });
    })();

    return () => {
      cancelled = true;
    };
  }, [range]);

  const { status, reports, instances, gpus } = snap;

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

  const inexactHere = figures.some((f) => f.window_exact === false);

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
      {Object.entries(groups).map(([source, rows]) => {
        const meta = SOURCE_META[source] || { label: source, blurb: null };
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
          </div>
        );
      })}

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
