/* eslint-disable react-refresh/only-export-components -- routeId, resolvePath,
   runBlockReason, highlightJson and buildOpenApi are pure functions over the
   route catalogue that lives in this file. They are exported so the test suite
   can pin the honesty rules directly (a blocked Run must stay blocked even if
   the DOM changes), and moving them to their own module would separate them
   from the ROUTES table they exist to interpret. */
/**
 * EngineApi — Engine ▸ API (screen 3c). The broker/Cockpit HTTP surface, made
 * discoverable without reading server.py.
 *
 * THE HONESTY RULES ARE THE FEATURE. This screen invites the operator to fire
 * requests at their own inference stack, so every affordance has to be exactly as
 * capable as it looks:
 *
 *  1. `Run` only ever calls SAME-ORIGIN `/api/...` and `/metrics` paths. The lane
 *     broker's own routes live on a different origin the browser cannot reach
 *     (no CORS headers, and there is no cockpit proxy for every one of them), so
 *     those rows are marked "not runnable from here" with a title explaining
 *     that a cockpit-side proxy is what would be needed. Firing them anyway
 *     would produce an opaque "TypeError: Failed to fetch" that reads as "your
 *     broker is broken".
 *  2. Nothing destructive auto-fires. Every non-GET row needs a second, explicit
 *     Confirm click, and `POST /v1/chat/completions` is never runnable at all —
 *     it would spend real inference to satisfy curiosity.
 *  3. Routes gated on a provider capability render dimmed and unrunnable when the
 *     selected provider does not declare it, because Cockpit answers those with
 *     404 "capability not available" and a 404 in the response pane would look
 *     like a missing route.
 *  4. Routes with a path parameter Cockpit cannot fill from live data are
 *     unrunnable and say which id they need.
 *  5. `Export OpenAPI` emits a real spec of the same-origin routes listed here —
 *     no invented paths, and the cross-origin group is excluded rather than
 *     described under the wrong server.
 *  6. `Watch (1s)` tears its interval down on unmount, on route change, and when
 *     Engine stops being the visible section.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Eye, Play } from "lucide-react";

import { Badge, Btn, Note, tint, UNKNOWN } from "./ui.jsx";

const METHOD_TOKEN = {
  GET: "var(--cc-ok)",
  POST: "var(--cc-fn)",
  PUT: "var(--cc-macro)",
  DELETE: "var(--cc-error)",
};

const GROUPS = [
  {
    id: "broker",
    label: "Lane broker · direct",
    note: "A separate process on its own port. Cockpit proxies some of these; the browser can reach none of them.",
  },
  {
    id: "provider",
    label: "Cockpit · per-provider",
    note: "Same origin as this page. Provider URLs and auth never reach the browser.",
  },
  {
    id: "cockpit",
    label: "Cockpit · usage & sessions",
    note: "Same origin. Read-only reporting and session state.",
  },
];

/**
 * The route catalogue. Every entry was read off lane_broker/broker.py's dispatch
 * table or server.py's decorators — there are no aspirational routes here.
 *
 *   direct    — different origin; unreachable from the browser
 *   cap       — provider capability required (404 without it)
 *   needs     — path parameter Cockpit must fill from live data
 *   body      — requires a request body the explorer does not compose
 *   forbidden — reason this must never be fired from a UI
 */
const ROUTES = [
  // ── lane broker, direct ────────────────────────────────
  { group: "broker", method: "GET", path: "/queue", desc: "in-flight job, queued jobs, predicted clear", direct: true },
  { group: "broker", method: "GET", path: "/metrics", desc: "run/prompt/token counters + percentiles", direct: true },
  { group: "broker", method: "GET", path: "/metrics/timeseries", desc: "recomputed buckets (5m/1h/1d)", direct: true },
  { group: "broker", method: "GET", path: "/spills", desc: "per-spill event log", direct: true },
  { group: "broker", method: "GET", path: "/config/spill", desc: "per-class thresholds + counters", direct: true },
  { group: "broker", method: "PUT", path: "/config/spill", desc: "set thresholds (session-only)", direct: true },
  { group: "broker", method: "GET", path: "/traces", desc: "recent trace roots", direct: true },
  { group: "broker", method: "GET", path: "/trace/{trace_id}", desc: "one trace closure: nodes + edges", direct: true },
  { group: "broker", method: "GET", path: "/v1/models", desc: "passed through to the upstream server", direct: true },
  {
    group: "broker",
    method: "POST",
    path: "/v1/chat/completions",
    desc: "the lane itself — queued, then forwarded",
    direct: true,
    forbidden: "This spends real inference. Cockpit will not fire it from a UI button.",
  },

  // ── cockpit, per provider ──────────────────────────────
  { group: "provider", method: "GET", path: "/api/local/providers", desc: "registry: id, label, kind, scope, capabilities" },
  { group: "provider", method: "GET", path: "/api/local/status", desc: "identity fingerprint of what is listening" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/health", desc: "concurrent broker + management probe", cap: "health" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/queue", desc: "proxied queue snapshot", cap: "queue" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/metrics", desc: "proxied metrics (window=lifetime|24h|session)", cap: "metrics" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/metrics/timeseries", desc: "proxied buckets; empty for vLLM", cap: "metrics" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/models", desc: "management model list (+ disk scan for vLLM)", cap: "models" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/spill", desc: "thresholds + spill counters", cap: "spill" },
  {
    group: "provider",
    method: "PUT",
    path: "/api/local/{provider_id}/spill",
    desc: "set thresholds; local scope only",
    cap: "spill",
    body: "a {class: seconds|null} map",
  },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/spills", desc: "proxied spill event log", cap: "spill" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/traces", desc: "recent traces (limit 1..100)", cap: "traces" },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/trace/{trace_id}", desc: "one trace closure", cap: "traces", needs: "trace_id" },
  {
    group: "provider",
    method: "POST",
    path: "/api/local/{provider_id}/models/{model_id}/load",
    desc: "load a model on the backend",
    cap: "model-control",
    needs: "model_id",
  },
  {
    group: "provider",
    method: "POST",
    path: "/api/local/{provider_id}/models/{model_id}/unload",
    desc: "unload a model on the backend",
    cap: "model-control",
    needs: "model_id",
  },
  {
    group: "provider",
    method: "POST",
    path: "/api/local/{provider_id}/restart",
    desc: "recreate the managed vLLM container",
    cap: "model-control",
    body: "{\"model\": \"<path>\"}",
  },
  { group: "provider", method: "GET", path: "/api/local/{provider_id}/models-dir", desc: "configured models folder + mount/scan paths", cap: "model-discovery" },
  {
    group: "provider",
    method: "PUT",
    path: "/api/local/{provider_id}/models-dir",
    desc: "set the models folder",
    cap: "model-discovery",
    body: "{\"path\": \"<folder>\"}",
  },
  {
    group: "provider",
    method: "POST",
    path: "/api/local/{provider_id}/endpoint",
    desc: "point a direct provider at host:port",
    body: "{\"host\": \"…\", \"port\": 8001}",
  },

  // ── cockpit, usage & sessions ──────────────────────────
  { group: "cockpit", method: "GET", path: "/api/usage/summary", desc: "API-side tokens + cost (session|24h|7d|lifetime)" },
  { group: "cockpit", method: "GET", path: "/api/usage/daily", desc: "per-day usage rows" },
  { group: "cockpit", method: "GET", path: "/api/reporting/models", desc: "per-model reporting rollup" },
  { group: "cockpit", method: "GET", path: "/api/pricing/models", desc: "reference $/Mtok table" },
  { group: "cockpit", method: "GET", path: "/api/terminals", desc: "live sessions Cockpit is managing" },
  { group: "cockpit", method: "GET", path: "/api/terminals/{terminal_id}/usage", desc: "one session's token + cost totals", needs: "terminal_id" },
  { group: "cockpit", method: "GET", path: "/api/history", desc: "past Claude Code conversations on disk" },
  { group: "cockpit", method: "GET", path: "/api/tsdb/status", desc: "whether a metrics store is attached" },
  { group: "cockpit", method: "GET", path: "/api/system", desc: "host CPU / memory / GPU snapshot" },
  { group: "cockpit", method: "GET", path: "/api/platform", desc: "PTY backend + OS build detection" },
  { group: "cockpit", method: "GET", path: "/api/models", desc: "model catalogue offered to new sessions" },
  { group: "cockpit", method: "GET", path: "/health", desc: "Cockpit liveness + its own uptime" },
  { group: "cockpit", method: "GET", path: "/metrics", desc: "Cockpit's Prometheus exposition (text, not JSON)", text: true },
];

export function routeId(r) {
  return `${r.method} ${r.path}`;
}

/** Fill {provider_id} and any `needs` parameter from live data, or report the gap. */
export function resolvePath(route, ctx) {
  let path = route.path;
  if (path.includes("{provider_id}")) {
    if (!ctx.providerId) return { path: null, missing: "provider_id" };
    path = path.replace("{provider_id}", encodeURIComponent(ctx.providerId));
  }
  if (route.needs === "trace_id") {
    if (!ctx.traceId) return { path: null, missing: "trace_id" };
    path = path.replace("{trace_id}", encodeURIComponent(ctx.traceId));
  }
  if (route.needs === "model_id") {
    if (!ctx.modelId) return { path: null, missing: "model_id" };
    path = path.replace("{model_id}", encodeURIComponent(ctx.modelId));
  }
  if (route.needs === "terminal_id") return { path: null, missing: "terminal_id" };
  return { path, missing: null };
}

/**
 * Why a row cannot be run, or null when it can. Order matters: the hardest
 * reason wins, so a cross-origin chat/completions reads as "spends inference"
 * rather than "wrong origin".
 */
export function runBlockReason(route, ctx) {
  if (route.forbidden) return route.forbidden;
  if (route.direct) {
    return (
      "Not runnable from here: this is the lane broker's own origin, which the browser cannot call " +
      "(no CORS, and Cockpit does not proxy every broker path). Use the /api/local equivalent, or " +
      "curl it from a shell."
    );
  }
  if (route.body) {
    return `Needs a request body (${route.body}). This explorer sends none, so the call would 400. Use the owning screen instead.`;
  }
  if (route.cap && !ctx.caps?.has(route.cap)) {
    return `The selected provider does not declare the "${route.cap}" capability — Cockpit answers this with 404 "capability not available".`;
  }
  const { missing } = resolvePath(route, ctx);
  if (missing === "provider_id") return "Select a provider first — this path is provider-keyed.";
  if (missing) return `Needs a {${missing}} Cockpit cannot fill from what is on screen right now.`;
  return null;
}

/** Minimal JSON tokeniser for the response pane. */
const JSON_RE = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;

export function highlightJson(text) {
  const out = [];
  let last = 0;
  let m;
  JSON_RE.lastIndex = 0;
  while ((m = JSON_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), token: null });
    if (m[1] !== undefined) {
      out.push({ text: m[1], token: m[2] ? "key" : "string" });
      if (m[2]) out.push({ text: m[2], token: null });
    } else if (m[3] !== undefined) {
      out.push({ text: m[3], token: "number" });
    } else {
      out.push({ text: m[4], token: m[4] === "null" ? "null" : "bool" });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), token: null });
  return out;
}

const TOKEN_COLOR = {
  key: "var(--cc-type)",
  string: "var(--cc-ok)",
  number: "var(--cc-num)",
  null: "var(--cc-macro)",
  bool: "var(--cc-fn)",
};

/** A real OpenAPI 3.1 document for the same-origin routes listed above. */
export function buildOpenApi(routes) {
  const paths = {};
  for (const r of routes) {
    if (r.group === "broker") continue; // different origin — excluded on purpose
    const entry = paths[r.path] || (paths[r.path] = {});
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map(([, name]) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    entry[r.method.toLowerCase()] = {
      summary: r.desc,
      tags: [r.group],
      ...(params.length ? { parameters: params } : {}),
      ...(r.body ? { requestBody: { required: true, description: r.body } } : {}),
      responses: {
        200: { description: r.text ? "Prometheus text exposition" : "JSON payload" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Claude Cockpit — local engine HTTP surface",
      version: "1",
      description:
        "Generated from Cockpit's Engine ▸ API route catalogue. Same-origin routes only: the lane " +
        "broker's own endpoints live on a different origin and are documented in the UI, not here.",
    },
    servers: [{ url: "/" }],
    paths,
  };
}

function MethodChip({ method }) {
  const token = METHOD_TOKEN[method] || "var(--cc-muted)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        height: 17,
        padding: "0 6px",
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 800,
        letterSpacing: ".06em",
        color: token,
        background: tint(token, 10),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      {method}
    </span>
  );
}

/** One 30px route row. */
function RouteRow({ route, selected, blocked, latency, confirming, onSelect, onRun, onConfirm, onCancel }) {
  const id = routeId(route);
  return (
    <div
      data-testid={`route-row-${id}`}
      data-blocked={blocked ? "true" : "false"}
      style={{
        display: "grid",
        gridTemplateColumns: "58px 300px 1fr 74px",
        gap: 8,
        alignItems: "center",
        height: 30,
        padding: "0 8px",
        marginBottom: 4,
        borderRadius: 8,
        background: "var(--cc-surface)",
        border: `1px solid ${selected ? tint("var(--cc-accent)", 40) : "var(--cc-border)"}`,
        opacity: blocked ? 0.55 : 1,
      }}
    >
      <MethodChip method={route.method} />
      <button
        type="button"
        data-testid={`route-select-${id}`}
        onClick={() => onSelect(route)}
        aria-label={`Select ${id}`}
        title={id}
        className="hover-bg-elevated"
        style={{
          textAlign: "left",
          background: "none",
          border: "none",
          padding: 0,
          fontFamily: "var(--font-mono, monospace)",
          fontSize: 11,
          fontWeight: 600,
          color: "var(--cc-fg)",
          cursor: "pointer",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
      >
        {route.path}
      </button>
      <span
        style={{
          fontSize: 10,
          color: "var(--cc-dim)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
        }}
        title={route.desc}
      >
        {route.desc}
      </span>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 5 }}>
        <span style={{ fontSize: 9, color: "var(--cc-muted)", whiteSpace: "nowrap" }}>
          {latency == null ? "" : `${latency}ms`}
        </span>
        {confirming ? (
          <>
            <Btn label={`Confirm ${route.method}`} accent testId={`route-confirm-${id}`} onClick={onConfirm}>
              Confirm
            </Btn>
            <Btn label="Cancel" testId={`route-cancel-${id}`} onClick={onCancel}>
              ✕
            </Btn>
          </>
        ) : (
          <Btn
            label={`Run ${id}`}
            testId={`route-run-${id}`}
            disabled={Boolean(blocked)}
            onClick={onRun}
            title={blocked || `Send ${id}`}
          >
            Run
          </Btn>
        )}
      </div>
    </div>
  );
}

export default function EngineApi({ provider, caps, data, onToast, active = true }) {
  const [selectedId, setSelectedId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [latency, setLatency] = useState({});
  const [result, setResult] = useState(null); // { status, ms, body, error }
  const [watching, setWatching] = useState(false);
  const runningRef = useRef(false);

  // The polled payloads are fresh objects every 10s, so the derivation lives
  // INSIDE the memo and the deps are the payloads themselves.
  const ctx = useMemo(() => {
    const modelList = Array.isArray(data?.models?.models) ? data.models.models : [];
    const traceList = Array.isArray(data?.traces?.traces) ? data.traces.traces : [];
    return {
      providerId: provider?.id || null,
      caps,
      modelId: (modelList.find((m) => m.state === "loaded") || modelList[0] || {}).id || null,
      traceId: (traceList[0] || {}).trace_id || null,
    };
  }, [provider?.id, caps, data?.models, data?.traces]);

  const selected = ROUTES.find((r) => routeId(r) === selectedId) || null;
  const selectedBlocked = selected ? runBlockReason(selected, ctx) : null;

  const run = useCallback(
    async (route) => {
      const blocked = runBlockReason(route, ctx);
      if (blocked) return;
      const { path } = resolvePath(route, ctx);
      if (!path) return;
      if (runningRef.current) return;
      runningRef.current = true;
      const id = routeId(route);
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      try {
        const res = await fetch(path, { method: route.method });
        const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
        const ms = Math.max(0, Math.round(t1 - t0));
        let body;
        if (route.text) {
          body = await res.text().catch(() => "");
        } else {
          const raw = await res.text().catch(() => "");
          try {
            body = JSON.stringify(JSON.parse(raw), null, 2);
          } catch {
            body = raw; // a non-JSON body is itself the finding — show it verbatim
          }
        }
        setLatency((prev) => ({ ...prev, [id]: ms }));
        setResult({ id, status: res.status, ms, body, error: null });
      } catch {
        setResult({
          id,
          status: null,
          ms: null,
          body: "",
          error: "The request did not complete. Cockpit itself may be down, or the path is not same-origin.",
        });
      } finally {
        runningRef.current = false;
      }
    },
    [ctx]
  );

  // Watch: 1s re-run of the selected route. Torn down on unmount, on a route
  // change, and whenever Engine stops being the visible section.
  useEffect(() => {
    if (!watching || !active || !selected) return undefined;
    const timer = setInterval(() => {
      run(selected);
    }, 1000);
    return () => clearInterval(timer);
  }, [watching, active, selected, run]);

  const selectRoute = useCallback((route) => {
    setSelectedId(routeId(route));
    setConfirmId(null);
    setWatching(false);
    setResult(null);
  }, []);

  const handleRun = (route) => {
    if (route.method === "GET") {
      selectRoute(route);
      run(route);
      return;
    }
    // Non-GET: never fire on the first click.
    setSelectedId(routeId(route));
    setConfirmId(routeId(route));
  };

  const copy = async (text, what) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast?.(`${what} copied`, "success");
    } catch {
      onToast?.(`Could not copy ${what} — clipboard access was refused`, "error");
    }
  };

  const curlFor = (route) => {
    if (!route) return null;
    const { path } = resolvePath(route, ctx);
    if (route.direct) return null; // no browser-known broker origin to name
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const target = path || route.path;
    const body = route.body ? ` -H 'Content-Type: application/json' --data '${route.body}'` : "";
    return `curl -X ${route.method} '${origin}${target}'${body}`;
  };

  const exportOpenApi = () => {
    const spec = JSON.stringify(buildOpenApi(ROUTES), null, 2);
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
      copy(spec, "OpenAPI spec");
      return;
    }
    const url = URL.createObjectURL(new Blob([spec], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "cockpit-engine-openapi.json";
    a.click();
    URL.revokeObjectURL(url);
    onToast?.("OpenAPI spec exported", "success");
  };

  const curl = curlFor(selected);

  return (
    <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      {/* ---- explorer header ---- */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "12px 18px 0",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--cc-fg)" }}>HTTP surface</span>
        <Badge testId="api-route-count">{`${ROUTES.length} routes`}</Badge>
        <span style={{ flex: 1 }} />
        <Btn
          label="Copy as cURL"
          icon={Copy}
          testId="api-copy-curl"
          disabled={!curl}
          onClick={curl ? () => copy(curl, "cURL command") : undefined}
          title={
            !selected
              ? "Select a route first"
              : !curl
                ? "The broker's origin is server-side only, so Cockpit cannot write a correct URL for you."
                : "Copy a curl command for the selected route"
          }
        />
        <Btn
          label="Export OpenAPI"
          icon={Download}
          testId="api-export-openapi"
          onClick={exportOpenApi}
          title="Download an OpenAPI 3.1 spec of the same-origin routes listed here (the broker's own origin is excluded)"
        />
      </div>

      <div style={{ display: "flex", gap: 14, padding: "12px 18px 16px", minWidth: 0, alignItems: "flex-start" }}>
        {/* ---- left: grouped route rows ---- */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {GROUPS.map((g) => (
            <div key={g.id} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 800,
                    letterSpacing: ".08em",
                    textTransform: "uppercase",
                    color: "var(--cc-fg)",
                  }}
                >
                  {g.label}
                </span>
                <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>{g.note}</span>
              </div>
              {ROUTES.filter((r) => r.group === g.id).map((r) => {
                const id = routeId(r);
                return (
                  <RouteRow
                    key={id}
                    route={r}
                    selected={selectedId === id}
                    blocked={runBlockReason(r, ctx)}
                    latency={latency[id]}
                    confirming={confirmId === id}
                    onSelect={selectRoute}
                    onRun={() => handleRun(r)}
                    onConfirm={() => {
                      setConfirmId(null);
                      run(r);
                    }}
                    onCancel={() => setConfirmId(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* ---- right: response pane ---- */}
        <div
          data-testid="api-response-pane"
          style={{
            width: 392,
            flexShrink: 0,
            borderRadius: 12,
            background: "var(--cc-bg2)",
            border: "1px solid var(--cc-border)",
            padding: 14,
            minWidth: 0,
          }}
        >
          {!selected ? (
            <Note testId="api-no-selection">
              Pick a route on the left to see its response. Nothing is sent until you press Run.
            </Note>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                <MethodChip method={selected.method} />
                <span
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--cc-fg)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    minWidth: 0,
                  }}
                  title={selected.path}
                >
                  {selected.path}
                </span>
              </div>
              <div style={{ fontSize: 10, color: "var(--cc-dim)", marginTop: 6, lineHeight: 1.5 }}>
                {selected.desc}
              </div>

              {selectedBlocked && (
                <Note testId="api-blocked-reason" token="var(--cc-waiting)" tinted>
                  {selectedBlocked}
                </Note>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                <span
                  data-testid="api-status"
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: ".06em",
                    color:
                      result?.error || (result && result.status >= 400)
                        ? "var(--cc-error)"
                        : result
                          ? "var(--cc-ok)"
                          : "var(--cc-muted)",
                  }}
                >
                  {result?.error ? "failed" : result ? `${result.status}` : "not sent"}
                </span>
                <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>
                  {result?.ms == null ? UNKNOWN : `${result.ms}ms`}
                </span>
                <span style={{ flex: 1 }} />
                <Btn
                  label="Copy JSON"
                  testId="api-copy-json"
                  disabled={!result?.body}
                  onClick={() => copy(result.body, "response")}
                  title={result?.body ? "Copy the response body" : "Run the route first"}
                />
                <Btn
                  label={watching ? "Stop watching" : "Watch (1s)"}
                  icon={watching ? Eye : Play}
                  testId="api-watch"
                  disabled={Boolean(selectedBlocked) || selected.method !== "GET"}
                  onClick={() => setWatching((v) => !v)}
                  title={
                    selected.method !== "GET"
                      ? "Only GET routes can be watched — repeating a write on a timer is never what you want."
                      : selectedBlocked
                        ? selectedBlocked
                        : "Re-send this route every second until you stop"
                  }
                >
                  {watching ? "Stop" : "Watch"}
                </Btn>
              </div>

              <pre
                data-testid="api-response-body"
                style={{
                  margin: "10px 0 0",
                  padding: 10,
                  borderRadius: 9,
                  background: "var(--cc-term)",
                  border: "1px solid var(--cc-border)",
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 10,
                  lineHeight: 1.55,
                  color: "var(--cc-fg)",
                  maxHeight: 360,
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {result?.error
                  ? result.error
                  : result?.body
                    ? highlightJson(result.body).map((part, i) => (
                        <span key={i} style={part.token ? { color: TOKEN_COLOR[part.token] } : undefined}>
                          {part.text}
                        </span>
                      ))
                    : "—"}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
