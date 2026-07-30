/**
 * EngineLive — Engine ▸ Live (screen 2b). What the engine is doing RIGHT NOW.
 *
 * Four cards: the loaded model + its memory, the live lane, routing & spill, and
 * the in-flight/queued table (shared with Engine ▸ Requests).
 *
 * Every number here comes from an endpoint that exists. Where the platform does
 * not report a value the card says so in words — VRAM is the honest example: no
 * Cockpit or provider endpoint reports it, so its meter draws no fill and names
 * the gap. Filling it with a plausible number would make the whole screen
 * untrustworthy, which defeats the point of a live view.
 *
 * All lane arithmetic is imported from utils/laneMath.js. It is deliberately not
 * reimplemented: the spill threshold in Settings and the pressure shown here
 * only mean something if both sides do the same sum.
 */
import { useState } from "react";
import { Cpu, Gauge, Route, RefreshCw } from "lucide-react";

import { laneLive, fmtEta, pressureFraction, predictedWaitSeconds } from "../../utils/laneMath.js";
import { QueueTable } from "./EngineRequests.jsx";
import {
  Bar,
  Badge,
  Btn,
  Card,
  CardTitle,
  Note,
  Sparkline,
  Stat,
  UNKNOWN,
  fmtInt,
  fmtNum,
  fmtPct,
  tint,
} from "./ui.jsx";

const VRAM_UNKNOWN =
  "No endpoint reports VRAM. vLLM's /metrics exposes KV-cache utilisation but not device memory, " +
  "and Cockpit has no GPU probe for the serving process.";

const RESTART_ONLY_VLLM =
  "Restart is vLLM-only: POST /api/local/{provider}/restart recreates the managed container. " +
  "This backend exposes no restart route.";

const SWAP_UNAVAILABLE =
  "This backend does not declare the model-control capability, so Cockpit has no load/unload or " +
  "restart route to swap with.";

/** Fields the broker's /config/spill echo carries (broker.py::_serve_spill_config). */
function spillThreshold(spill, cls) {
  const map = spill && spill.reachable !== false ? spill.spill_thresholds_s : null;
  if (!map || !(cls in map)) return undefined; // unknown
  return map[cls]; // number | null (null = spill disabled for the class)
}

/** The engine identity line: label plus whatever endpoint the server is willing
 *  to name. Provider URLs are server-side by design (SSRF stance), so an absent
 *  hint is expected and gets said out loud rather than guessed. */
function endpointLine(provider, status) {
  if (provider?.endpoint_hint) return provider.endpoint_hint;
  if (provider?.capabilities?.includes("queue") && status?.url) return status.url;
  return "endpoint kept server-side";
}

function loadedModelName(models, metrics) {
  const list = Array.isArray(models?.models) ? models.models : [];
  const loaded = list.find((m) => m.state === "loaded");
  if (loaded) return loaded.name || loaded.id || UNKNOWN;
  const served = metrics && metrics.reachable !== false ? metrics.served_model : null;
  return served || null;
}

/**
 * Loaded model card. `Swap model…` reveals an inline picker rather than opening a
 * dialog, and both writes are confirm-gated: a restart tears down in-flight
 * inference, which is destructive even though it is routine.
 */
function LoadedModelCard({ provider, status, models, metrics, caps, onToast }) {
  const [swapOpen, setSwapOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState(null); // "swap" | "restart" | null
  const [busy, setBusy] = useState(false);

  const list = Array.isArray(models?.models) ? models.models : [];
  const loadedName = loadedModelName(models, metrics);
  const loaded = list.find((m) => m.state === "loaded") || null;
  const engine = metrics && metrics.reachable !== false ? metrics.engine : null;
  const kvPct = typeof engine?.kv_cache_pct === "number" ? engine.kv_cache_pct : null;

  const isVllm = provider?.kind === "vllm";
  const canControl = Boolean(caps?.has("model-control"));
  const canRestart = canControl && isVllm;
  const currentTarget = loaded ? loaded.container_path || loaded.id : "";

  const post = async (url, body) => {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok === false) {
        onToast?.(payload?.error || "The engine refused that request", "error");
        return false;
      }
      return true;
    } catch {
      onToast?.("Could not reach Cockpit to change the engine", "error");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const doRestart = async (model) => {
    const id = encodeURIComponent(provider.id);
    const chosen = (model || currentTarget || "").trim();
    if (!chosen) {
      onToast?.("Pick a model first — restart needs a model path", "error");
      return;
    }
    if (await post(`/api/local/${id}/restart`, { model: chosen })) {
      onToast?.(`Engine restarting with ${chosen}…`, "info");
      setSwapOpen(false);
    }
  };

  const doLoad = async (model) => {
    const id = encodeURIComponent(provider.id);
    if (!model) {
      onToast?.("Pick a model to load", "error");
      return;
    }
    if (await post(`/api/local/${id}/models/${encodeURIComponent(model)}/load`)) {
      onToast?.(`Loading ${model}…`, "info");
      setSwapOpen(false);
    }
  };

  const applySwap = () => {
    setConfirm(null);
    if (isVllm) doRestart(target);
    else doLoad(target);
  };

  return (
    <Card
      testId="engine-model-card"
      style={{ flex: 1 }}
      title={<CardTitle icon={Cpu} token="var(--cc-accent)">{provider?.label || "Engine"}</CardTitle>}
      right={<Badge testId="engine-endpoint">{endpointLine(provider, status)}</Badge>}
    >
      <div
        data-testid="engine-loaded-model"
        style={{
          fontSize: 15,
          fontWeight: 700,
          color: loadedName ? "var(--cc-fg)" : "var(--cc-muted)",
          wordBreak: "break-all",
          lineHeight: 1.35,
        }}
      >
        {loadedName || "No model loaded"}
      </div>
      {loaded && (
        <div style={{ fontSize: 10, color: "var(--cc-dim)", marginTop: 4 }}>
          {[loaded.arch, loaded.quantization].filter(Boolean).join(" · ") || "details not reported"}
        </div>
      )}

      <Bar
        testId="engine-vram-bar"
        label="VRAM"
        fraction={null}
        token="var(--cc-accent)"
        unknownNote={VRAM_UNKNOWN}
      />
      <Bar
        testId="engine-kv-bar"
        label="KV cache"
        fraction={kvPct == null ? null : kvPct / 100}
        readout={fmtPct(kvPct)}
        token="var(--cc-type)"
        unknownNote="KV-cache utilisation comes from the engine's own /metrics; this backend is not reporting it."
      />

      <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
        <Btn
          label="Swap model…"
          testId="engine-swap"
          disabled={!canControl || busy}
          onClick={() => {
            setTarget(currentTarget);
            setSwapOpen((v) => !v);
            setConfirm(null);
          }}
          title={canControl ? "Choose a different model for this backend" : SWAP_UNAVAILABLE}
        />
        {confirm === "restart" ? (
          <>
            <Btn
              label="Confirm restart"
              accent
              testId="engine-restart-confirm"
              disabled={busy}
              onClick={() => {
                setConfirm(null);
                doRestart(currentTarget);
              }}
              title="Restart now — in-flight requests are lost"
            />
            <Btn label="Cancel restart" testId="engine-restart-cancel" onClick={() => setConfirm(null)} />
          </>
        ) : (
          <Btn
            label="Restart"
            icon={RefreshCw}
            testId="engine-restart"
            disabled={!canRestart || busy}
            onClick={() => setConfirm("restart")}
            title={canRestart ? "Recreate the engine with the current model" : RESTART_ONLY_VLLM}
          />
        )}
      </div>

      {swapOpen && canControl && (
        <div style={{ marginTop: 10, display: "flex", gap: 6, alignItems: "center" }}>
          <select
            aria-label="Model to swap to"
            data-testid="engine-swap-select"
            value={target}
            onChange={(e) => {
              setTarget(e.target.value);
              setConfirm(null);
            }}
            className="hover-bg-elevated"
            style={{
              flex: 1,
              minWidth: 0,
              height: 24,
              borderRadius: 7,
              padding: "0 6px",
              fontFamily: "inherit",
              fontSize: 10,
              background: "var(--cc-elev)",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-fg)",
            }}
          >
            <option value="">Select a model…</option>
            {list.map((m) => {
              const value = m.container_path || m.id;
              return (
                <option key={value || m.id} value={value}>
                  {`${m.name || m.id || value}${m.state === "loaded" ? " · loaded" : ""}`}
                </option>
              );
            })}
          </select>
          {confirm === "swap" ? (
            <>
              <Btn label="Confirm swap" accent testId="engine-swap-confirm" disabled={busy} onClick={applySwap} />
              <Btn label="Cancel swap" testId="engine-swap-cancel" onClick={() => setConfirm(null)} />
            </>
          ) : (
            <Btn
              label="Apply"
              testId="engine-swap-apply"
              disabled={!target || busy}
              onClick={() => setConfirm("swap")}
              title={
                isVllm
                  ? "vLLM serves one model per container — applying restarts it"
                  : "Load this model on the backend"
              }
            />
          )}
        </div>
      )}
      {isVllm && canControl && (
        <Note>vLLM serves one model per container, so swapping restarts the engine.</Note>
      )}
    </Card>
  );
}

/** Live lane: four stats, a 60s decode sparkline, and the drain estimate. */
function LaneCard({ queue, metrics, series }) {
  const unread = queue === undefined && metrics === undefined;
  const live = laneLive(queue, metrics);
  const eta = live?.etaSec ?? null;
  const drain = fmtEta(eta);

  return (
    <Card
      testId="engine-lane-card"
      style={{ flex: 1.4 }}
      title={<CardTitle icon={Gauge} token="var(--cc-working)">Lane</CardTitle>}
      right={
        <span style={{ fontSize: 10, color: drain ? "var(--cc-dim)" : "var(--cc-muted)" }}>
          {unread
            ? "reading…"
            : live == null
              ? "lane state unknown"
              : drain
              ? `drains in ~${drain}`
              : "drain time unknown"}
        </span>
      }
    >
      {unread ? (
        <Note testId="lane-loading">Reading the lane…</Note>
      ) : live == null ? (
        <Note testId="lane-offline">
          Neither the lane queue nor the engine metrics are answering, so Cockpit cannot say what is
          in flight. Nothing here is zero — it is unread.
        </Note>
      ) : (
        <>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
            <Stat testId="lane-inflight" label="In flight" value={fmtInt(live.running)} token="var(--cc-working)" />
            <Stat testId="lane-queued" label="Queued" value={fmtInt(live.queued)} token="var(--cc-waiting)" />
            <Stat
              testId="lane-tps"
              label="Decode tok/s"
              value={live.tps == null ? UNKNOWN : fmtNum(live.tps, 1)}
              token="var(--cc-fn)"
              title={live.tps == null ? "The engine is not reporting a decode rate" : undefined}
            />
            <Stat
              testId="lane-p50"
              label="p50 wall"
              value={live.p50WallSeconds == null ? UNKNOWN : `${fmtNum(live.p50WallSeconds, 1)}s`}
              token="var(--cc-fg)"
            />
          </div>
          <div style={{ marginTop: 14 }}>
            <Sparkline
              testId="lane-sparkline"
              samples={series}
              caption="decode tok/s · last 60s (sampled every 3s; gaps mean not reported)"
            />
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * Routing & spill. READ-ONLY on purpose: thresholds are intent and now live in
 * Settings ▸ Providers, so this card reports the live effect of that intent and
 * links to the owner instead of shipping a second set of sliders that could
 * disagree with the first.
 */
function RoutingCard({ caps, spill, metrics, queue, localEnabled, setLocalEnabled, onNavigate }) {
  const offered = Boolean(caps?.has("spill"));
  const interactive = spillThreshold(spill, "interactive");
  const live = laneLive(queue, metrics);
  const wait = predictedWaitSeconds(live?.running, live?.queued, live?.p50WallSeconds);
  const fraction =
    typeof interactive === "number" ? pressureFraction(wait, interactive) : null;

  const runs = metrics && metrics.reachable !== false ? metrics.runs_total : null;
  const spilledTotal = spill && spill.reachable !== false ? spill.spilled_total : null;
  const canToggle = typeof setLocalEnabled === "function";

  return (
    <Card
      testId="engine-routing-card"
      style={{ flex: 1 }}
      title={<CardTitle icon={Route} token="var(--cc-macro)">Routing &amp; spill</CardTitle>}
      right={
        <button
          type="button"
          data-testid="engine-live-toggle"
          onClick={canToggle ? () => setLocalEnabled((v) => !v) : undefined}
          disabled={!canToggle}
          aria-pressed={Boolean(localEnabled)}
          aria-label="Local inference master switch"
          title={
            canToggle
              ? "Turn local inference reads and routing on or off"
              : "The shell owns this flag and did not pass a setter, so it is read-only here."
          }
          className="hover-bg-elevated"
          style={{
            height: 20,
            padding: "0 9px",
            borderRadius: 999,
            fontFamily: "inherit",
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: ".08em",
            textTransform: "uppercase",
            color: localEnabled ? "var(--cc-ok)" : "var(--cc-muted)",
            background: localEnabled ? tint("var(--cc-ok)", 8) : "var(--cc-elev)",
            border: `1px solid ${localEnabled ? tint("var(--cc-ok)", 35) : "var(--cc-border)"}`,
            cursor: canToggle ? "pointer" : "not-allowed",
            opacity: canToggle ? 1 : 0.6,
          }}
        >
          {localEnabled ? "live" : "off"}
        </button>
      }
    >
      {offered && spill === undefined ? (
        /* Not yet asked. Saying "not reported" before the first poll would be a
           claim about the broker we have not earned. */
        <Note testId="spill-loading">Reading the spill policy…</Note>
      ) : !offered ? (
        <Note testId="spill-not-offered">
          This backend is served directly and has no spill policy — spill is a lane-broker
          behaviour, and the broker is not in front of it.
        </Note>
      ) : spill === null ? (
        <Note testId="spill-offline">
          The broker is not answering /config/spill, so the current thresholds are unknown.
        </Note>
      ) : (
        <>
          <div style={{ fontSize: 11, color: "var(--cc-fg)", lineHeight: 1.55 }}>
            {interactive === undefined
              ? "Interactive threshold not reported by the broker."
              : interactive === null
                ? "Spill is disabled for interactive — every request stays local however long the wait."
                : `Spill when predicted wait > ${interactive}s (interactive).`}
          </div>
          <Bar
            testId="spill-pressure"
            label="Interactive pressure"
            fraction={fraction}
            readout={
              wait == null || typeof interactive !== "number"
                ? UNKNOWN
                : `${fmtNum(wait, 1)}s / ${interactive}s`
            }
            token="var(--cc-waiting)"
            unknownNote={
              typeof interactive !== "number"
                ? "No active threshold to measure against."
                : "Predicted wait needs a measured p50 run time; none has been recorded yet."
            }
          />
          <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap" }}>
            <Stat testId="count-local" label="Served local" value={fmtInt(runs)} token="var(--cc-ok)" />
            <Stat testId="count-spilled" label="Spilled" value={fmtInt(spilledTotal)} token="var(--cc-macro)" />
            <Stat
              testId="count-rejected"
              label="Rejected"
              value={UNKNOWN}
              title="Neither the broker nor Cockpit counts rejections today, so this cannot be reported."
            />
          </div>
          <Note testId="spill-counter-window">
            Counters are totals since the broker started, not this hour — the broker exposes no
            windowed counters, and rejections are not counted at all.
          </Note>
        </>
      )}
      <Note testId="spill-owner">
        Thresholds are set in Settings ▸ Providers &amp; Endpoints.
        {typeof onNavigate === "function" && (
          <>
            {" "}
            <button
              type="button"
              data-testid="spill-goto-settings"
              onClick={() => onNavigate("settings", "providers")}
              aria-label="Open spill policy in Settings"
              style={{
                background: "none",
                border: "none",
                padding: 0,
                font: "inherit",
                color: "var(--cc-accent)",
                cursor: "pointer",
                textDecoration: "underline",
              }}
            >
              Open it
            </button>
          </>
        )}
      </Note>
    </Card>
  );
}

/** Footer facts. Three of the four are honestly unavailable today. */
function LaneFooter({ metrics }) {
  const runs = metrics && metrics.reachable !== false ? metrics.runs_total : null;
  const item = (label, value, title) => (
    <span title={title} style={{ fontSize: 10, color: "var(--cc-muted)", whiteSpace: "nowrap" }}>
      {label}{" "}
      <span style={{ color: value === UNKNOWN ? "var(--cc-muted)" : "var(--cc-fg)", fontWeight: 700 }}>{value}</span>
    </span>
  );
  return (
    <div
      data-testid="engine-live-footer"
      style={{
        display: "flex",
        gap: 16,
        flexWrap: "wrap",
        padding: "10px 2px 0",
        borderTop: "1px solid var(--cc-line, var(--cc-border))",
      }}
    >
      {item("uptime", UNKNOWN, "No engine uptime is reported. Cockpit's own /health uptime is a different clock and would be misleading here.")}
      {item("requests served", fmtInt(runs), "runs_total from the engine metrics, since the engine started")}
      {item("failures", UNKNOWN, "Neither the broker nor vLLM's adapter reports a failure count to Cockpit.")}
      {item("last restart", UNKNOWN, "Cockpit does not record why or when the engine last restarted.")}
    </div>
  );
}

export default function EngineLive({
  provider,
  status,
  caps,
  data,
  series,
  localEnabled,
  setLocalEnabled,
  onNavigate,
  onToast,
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", minWidth: 0 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", minWidth: 0 }}>
        <LoadedModelCard
          provider={provider}
          status={status}
          models={data?.models}
          metrics={data?.metrics}
          caps={caps}
          onToast={onToast}
        />
        <LaneCard queue={data?.queue} metrics={data?.metrics} series={series} />
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", minWidth: 0 }}>
        <RoutingCard
          caps={caps}
          spill={data?.spill}
          metrics={data?.metrics}
          queue={data?.queue}
          localEnabled={localEnabled}
          setLocalEnabled={setLocalEnabled}
          onNavigate={onNavigate}
        />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <QueueTable queue={data?.queue} caps={caps} metrics={data?.metrics} compact style={{ flex: 1 }} />
          <LaneFooter metrics={data?.metrics} />
        </div>
      </div>
    </div>
  );
}
