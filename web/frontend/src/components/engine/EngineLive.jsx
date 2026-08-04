/**
 * EngineLive — Engine ▸ Live (screen 2b). What the engine is doing RIGHT NOW.
 *
 * Four cards: the loaded model + its memory, the live lane, routing, and the
 * in-flight/queued table (from the engine's own scheduler counters).
 *
 * Every number here comes from an endpoint that exists. Where the platform does
 * not report a value the card says so in words — VRAM is the honest example: no
 * Plexar Studio or provider endpoint reports it, so its meter draws no fill and names
 * the gap. Filling it with a plausible number would make the whole screen
 * untrustworthy, which defeats the point of a live view.
 *
 * All lane arithmetic is imported from utils/laneMath.js. It is deliberately not
 * reimplemented: the strip, the TopBar pill and this screen only agree if they
 * do the same sum.
 *
 * SPILL WAS REMOVED 2026-08-03. This card used to show the interactive
 * threshold, a pressure bar measuring the distance to it, and a "Spilled"
 * counter. All three are gone rather than zeroed -- a counter pinned at 0 for a
 * mechanism that no longer exists still claims the mechanism exists.
 */
import { useState } from "react";
import { Cpu, Gauge, Route, RefreshCw } from "lucide-react";

import { laneLive, fmtEta } from "../../utils/laneMath.js";
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
  "and Plexar Studio has no GPU probe for the serving process.";

const RESTART_ONLY_VLLM =
  "Restart is vLLM-only: POST /api/local/{provider}/restart recreates the managed container. " +
  "This backend exposes no restart route.";

/**
 * Why there is no control here, said BEFORE the click.
 *
 * The bug this replaces: the buttons rendered regardless, the user clicked
 * Restart on an external vLLM, and the server correctly refused with a red
 * toast. A control that can NEVER work is the defect — the refusal was the
 * symptom. `managed` (new on GET /api/local/providers) is the same determination
 * the server refuses on, so the explanation and the refusal cannot disagree.
 */
function controlUnavailableReason(provider) {
  const isVllm = provider?.kind === "vllm";
  const managed = provider?.managed === true;
  if (isVllm && !managed) {
    return (
      "vLLM has no model hot-swap API — one process serves the single model given to --model at " +
      "launch, so changing model means restarting the process. This vLLM is running outside " +
      "Plexar Studio (COCKPIT_MANAGED_VLLM is off), so Plexar Studio cannot restart it. Restart it where you " +
      "started it, with the model you want."
    );
  }
  if (isVllm) {
    return (
      "Plexar Studio owns this container, but the backend is not declaring the model-control capability " +
      "right now, so there is no restart route to swap with."
    );
  }
  return (
    "This backend does not declare the model-control capability, so Plexar Studio has no load/unload or " +
    "restart route to swap with. For LM Studio that usually means the lms CLI is not on the " +
    "server's PATH."
  );
}

/** The engine identity line: label plus whatever endpoint the server is willing
 *  to name. Provider URLs are server-side by design (SSRF stance), so an absent
 *  hint is expected and gets said out loud rather than guessed. */
function endpointLine(provider) {
  if (provider?.endpoint_hint) return provider.endpoint_hint;
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
function LoadedModelCard({ provider, models, metrics, caps, onToast }) {
  const [swapOpen, setSwapOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [confirm, setConfirm] = useState(null); // "swap" | "restart" | null
  const [busy, setBusy] = useState(false);
  // A 404 from a write means "capability not available" — the affordance should
  // not have been there. Correct the affordance instead of shouting an error.
  const [controlLost, setControlLost] = useState(false);

  const list = Array.isArray(models?.models) ? models.models : [];
  const loadedName = loadedModelName(models, metrics);
  const loaded = list.find((m) => m.state === "loaded") || null;
  const engine = metrics && metrics.reachable !== false ? metrics.engine : null;
  const kvPct = typeof engine?.kv_cache_pct === "number" ? engine.kv_cache_pct : null;

  const isVllm = provider?.kind === "vllm";
  const canControl = Boolean(caps?.has("model-control")) && !controlLost;
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
      // 404 = "capability not available". Not a failure to report: the control
      // should never have been offered, so retract it and explain in place.
      if (res.status === 404) {
        setControlLost(true);
        setSwapOpen(false);
        setConfirm(null);
        return false;
      }
      if (!res.ok || payload?.ok === false) {
        // 409 now carries actionable text (it names COCKPIT_MANAGED_VLLM and what
        // to do). Surface it verbatim — a generic string would throw that away.
        onToast?.(payload?.error || "The engine refused that request", "error");
        return false;
      }
      return true;
    } catch {
      onToast?.("Could not reach Plexar Studio to change the engine", "error");
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
      right={<Badge testId="engine-endpoint">{endpointLine(provider)}</Badge>}
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

      {!canControl ? (
        /* No control exists. Render the reason where the buttons would have been
           rather than a button whose only outcome is a refusal toast. */
        <Note testId="engine-model-control-note" token="var(--cc-waiting)" tinted>
          {controlUnavailableReason(provider)}
        </Note>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, marginTop: 12, flexWrap: "wrap" }}>
            <Btn
              label="Swap model…"
              testId="engine-swap"
              disabled={busy}
              onClick={() => {
                setTarget(currentTarget);
                setSwapOpen((v) => !v);
                setConfirm(null);
              }}
              title="Choose a different model for this backend"
            />
            {!isVllm ? null : confirm === "restart" ? (
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
                disabled={busy}
                onClick={() => setConfirm("restart")}
                title="Recreate the engine with the current model"
              />
            )}
          </div>
          {!isVllm && (
            <Note testId="engine-restart-not-offered" token="var(--cc-waiting)">
              {RESTART_ONLY_VLLM}
            </Note>
          )}
        </>
      )}

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
function LaneCard({ metrics, series }) {
  const unread = metrics === undefined;
  const live = laneLive(metrics);
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
          The engine metrics are not answering, so Plexar Studio cannot say what is
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
 * Routing. The local-inference master switch plus what the lane actually
 * served. There is nothing to configure here any more: the spill policy that
 * this card used to report was removed 2026-08-03, and Plexar Studio does not
 * replace a removed control with a placeholder for one.
 */
function RoutingCard({ metrics, localEnabled, setLocalEnabled }) {
  const runs = metrics && metrics.reachable !== false ? metrics.runs_total : null;
  const canToggle = typeof setLocalEnabled === "function";

  return (
    <Card
      testId="engine-routing-card"
      style={{ flex: 1 }}
      title={<CardTitle icon={Route} token="var(--cc-macro)">Routing</CardTitle>}
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
      <div style={{ fontSize: 11, color: "var(--cc-fg)", lineHeight: 1.55 }}>
        Every request on this lane is served locally. Plexar Studio has no rule that
        sends work anywhere else.
      </div>
      <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap" }}>
        <Stat testId="count-local" label="Served local" value={fmtInt(runs)} token="var(--cc-ok)" />
        <Stat
          testId="count-rejected"
          label="Rejected"
          value={UNKNOWN}
          title="Neither the broker nor Plexar Studio counts rejections today, so this cannot be reported."
        />
      </div>
      <Note testId="routing-counter-window">
        Counters are totals since the broker started, not this hour — the broker exposes no
        windowed counters, and rejections are not counted at all.
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
      {item("uptime", UNKNOWN, "No engine uptime is reported. Plexar Studio's own /health uptime is a different clock and would be misleading here.")}
      {item("requests served", fmtInt(runs), "runs_total from the engine metrics, since the engine started")}
      {item("failures", UNKNOWN, "Neither the broker nor vLLM's adapter reports a failure count to Plexar Studio.")}
      {item("last restart", UNKNOWN, "Plexar Studio does not record why or when the engine last restarted.")}
    </div>
  );
}

export default function EngineLive({
  provider,
  caps,
  data,
  series,
  localEnabled,
  setLocalEnabled,
  onToast,
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", minWidth: 0 }}>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", minWidth: 0 }}>
        <LoadedModelCard
          provider={provider}
          models={data?.models}
          metrics={data?.metrics}
          caps={caps}
          onToast={onToast}
        />
        <LaneCard metrics={data?.metrics} series={series} />
      </div>

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", minWidth: 0 }}>
        <RoutingCard
          metrics={data?.metrics}
          localEnabled={localEnabled}
          setLocalEnabled={setLocalEnabled}
        />
        {/* QueueTable is GONE (T11). It rendered ONE ROW PER QUEUED JOB from
            the lane broker's /queue payload -- the broker was the only thing
            that ever knew about individual jobs. The engine's own scheduler
            reports COUNTS (running/waiting) and no per-job identity, so there
            is nothing to put in a table; those counts are already the Lane
            card's stats above. */}
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <LaneFooter metrics={data?.metrics} />
        </div>
      </div>
    </div>
  );
}
