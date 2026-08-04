/**
 * EngineView — the Engine section frame (44px header + tab routing + polling).
 *
 * SCOPE (the organising rule for the whole facelift): Settings owns INTENT,
 * Reports owns the PAST, Engine owns NOW. So this view holds engine lifecycle,
 * the loaded model, the live lane and the HTTP surface. S26 moved the request
 * tree to Reports ▸ Traces and the log tab to Reports ▸ Logs — both are the
 * PAST, and Reports owns the past. Neither was deleted.
 * It holds no configuration form and no history chart — the two header links
 * hand those off to their real owners rather than duplicating them here.
 *
 * Replaces LocalBrokerView.jsx, which mixed all three concerns. That file is
 * deliberately left in place; App.jsx retires it when it wires this frame, so
 * the `engine` route is never broken mid-flight.
 *
 * POLLING: every read is best-effort and gated on `active`. When Engine is not
 * the visible section the intervals are torn down entirely — eight live
 * terminals plus a background poll loop is real load, and a section nobody is
 * looking at has no business spending it. Fast reads (queue, metrics) run at 3s
 * because Live's sparkline is a 60s window of 3s samples; slow reads (models,
 * traces, health) run at 10s.
 *
 * Props:
 *   active            — Engine is the visible section; false tears down polling
 *   provider          — selected provider {id,label,kind,scope,capabilities}
 *   status            — GET /api/local/status (identity fingerprint), or null
 *   tab / onSelectTab — optional controlled tab; falls back to internal state
 *   onNavigate(section, subsection) — REQUIRED for the two hand-off links to
 *     work. Without it they render disabled with a title saying so: a dead-end
 *     link is worse than no link.
 *   localEnabled / setLocalEnabled — the master local-inference flag (App owns
 *     the localStorage persistence). Without the setter the toggle is inert.
 *   onToast(message, kind) — user-facing errors; never console.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { OctagonX, SlidersHorizontal, History } from "lucide-react";

import EngineLive from "./EngineLive.jsx";
import EngineModels from "./EngineModels.jsx";
import EngineApi from "./EngineApi.jsx";
import { Btn, ENGINE_TABS, DEFAULT_ENGINE_TAB, Pill, safeGet, tint } from "./ui.jsx";
import useLocalModels from "../../hooks/useLocalModels.js";

/** 60s of Live sparkline at the 3s fast-poll cadence. */
export const SPARK_POINTS = 20;
const FAST_MS = 3000;
const SLOW_MS = 10000;

/** There is no stop endpoint. `POST /api/local/{id}/restart` is the only
 *  lifecycle write Plexar Studio exposes, and it is vLLM-only. */
const STOP_DISABLED_TITLE =
  "No stop endpoint exists yet — Plexar Studio exposes POST /api/local/{provider}/restart only. " +
  "Stop the engine from its own process/container until a stop route lands.";

/**
 * Poll the provider's read endpoints while Engine is visible.
 *
 * Capability-gated: a provider that does not declare `queue` is never asked for
 * one (the route would 404 and the UI would render that as "offline", which is
 * a different and false claim). Missing capability leaves the slot `undefined`
 * = "not offered"; a failed fetch leaves it `null` = "offered but unreachable".
 */
function useEngineData(providerId, capabilities, active, fastTab) {
  const [data, setData] = useState({});
  const [series, setSeries] = useState([]);
  // Capabilities arrive as a fresh array each poll in App; a string key keeps
  // the effect from resubscribing on every parent render.
  const capKey = useMemo(
    () => (Array.isArray(capabilities) ? capabilities.slice().sort().join(",") : ""),
    [capabilities]
  );

  useEffect(() => {
    if (!active || !providerId) return undefined;
    let cancelled = false;
    const caps = new Set(capKey ? capKey.split(",") : []);
    const id = encodeURIComponent(providerId);
    const ask = (cap, path) => (caps.has(cap) ? safeGet(`/api/local/${id}${path}`) : Promise.resolve(undefined));

    const fast = async () => {
      const [queue, metrics] = await Promise.all([
        ask("queue", "/queue"),
        ask("metrics", "/metrics?window=session"),
      ]);
      if (cancelled) return;
      setData((prev) => ({ ...prev, queue, metrics }));
      // Only accumulate the sparkline while Live is on screen — a hidden chart
      // does not need a 60s buffer, and sampling it would imply a continuity
      // the samples do not have.
      if (fastTab) {
        const s =
          metrics && metrics.reachable !== false
            ? metrics.decode_tokens_per_sec?.avg ?? metrics.tokens_per_sec?.avg ?? null
            : null;
        setSeries((prev) => [...prev, s].slice(-SPARK_POINTS));
      }
    };

    // NOTE: /models is deliberately absent. It is owned by the shared
    // useLocalModels store (App drives the single poller) because App needed the
    // same read for the model-load busy marker — two owners meant two identical
    // requests every 10s whenever Engine was open.
    const slow = async () => {
      const [traces, health] = await Promise.all([
        ask("traces", "/traces?limit=20"),
        ask("health", "/health"),
      ]);
      if (cancelled) return;
      setData((prev) => ({ ...prev, traces, health }));
    };

    fast();
    slow();
    const f = setInterval(fast, FAST_MS);
    const s = setInterval(slow, SLOW_MS);
    return () => {
      cancelled = true;
      clearInterval(f);
      clearInterval(s);
    };
  }, [active, providerId, capKey, fastTab]);

  return { data, series };
}

/** One header tab. Active gets the 2px accent underline. */
function Tab({ id, label, active, onSelect }) {
  return (
    <button
      type="button"
      data-testid={`engine-tab-${id}`}
      onClick={() => onSelect(id)}
      aria-label={`Engine ${label}`}
      aria-current={active ? "page" : undefined}
      className="hover-bg-elevated"
      style={{
        height: 28,
        padding: "0 9px",
        background: "none",
        border: "none",
        borderBottom: `2px solid ${active ? "var(--cc-accent)" : "transparent"}`,
        color: active ? "var(--cc-fg)" : "var(--cc-muted)",
        fontFamily: "inherit",
        fontSize: 11,
        fontWeight: active ? 700 : 600,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      {label}
    </button>
  );
}

/**
 * A hand-off link. Engine deliberately does not own configuration or history,
 * so these must actually navigate. When the shell gives us no navigator we
 * disable the button and say why instead of rendering a dead end.
 */
function HandoffLink({ label, icon, section, subsection, onNavigate, testId }) {
  const can = typeof onNavigate === "function";
  return (
    <Btn
      label={label}
      icon={icon}
      testId={testId}
      disabled={!can}
      onClick={can ? () => onNavigate(section, subsection) : undefined}
      title={
        can
          ? `Open ${label.toLowerCase()}`
          : "The shell did not supply a navigator, so this link would go nowhere."
      }
    />
  );
}

export default function EngineView({
  active = true,
  provider = null,
  status = null,
  tab,
  onSelectTab,
  onNavigate,
  localEnabled = true,
  setLocalEnabled,
  onToast,
}) {
  const [internalTab, setInternalTab] = useState(DEFAULT_ENGINE_TAB);
  const current = ENGINE_TABS.some((t) => t.id === tab) ? tab : internalTab;
  const selectTab = useCallback(
    (next) => {
      setInternalTab(next);
      onSelectTab?.(next);
    },
    [onSelectTab]
  );

  const caps = useMemo(
    () => new Set(Array.isArray(provider?.capabilities) ? provider.capabilities : []),
    [provider]
  );

  const { data: polled, series } = useEngineData(
    provider?.id,
    provider?.capabilities,
    active && localEnabled,
    current === "live"
  );

  // The models list comes from the shared store, not from this view's poll.
  // App drives the only poller; Engine just subscribes, and the busy marker is
  // app-wide so a load started in the TopBar picker shows its spinner here too.
  // The write is NOT taken from the store here: the store's writeModel reports any
  // non-OK status as an error toast, and a 404 "capability not available" must
  // retract the control instead of shouting. EngineModels owns that write.
  const { models: sharedModels, busyModelId } = useLocalModels();
  const data = useMemo(() => ({ ...polled, models: sharedModels }), [polled, sharedModels]);

  // Serving state. health is authoritative when offered; otherwise fall back to
  // whether the models list or the queue snapshot actually came back.
  const serving = useMemo(() => {
    if (!localEnabled) return "off";
    if (data.health) return data.health.provider?.reachable ? "serving" : "down";
    if (data.health === null) return "down";
    if (data.models !== undefined) return data.models?.reachable === true ? "serving" : "down";
    if (data.queue !== undefined) return data.queue ? "serving" : "down";
    return "checking";
  }, [localEnabled, data.health, data.models, data.queue]);

  const servingToken =
    serving === "serving"
      ? "var(--cc-ok)"
      : serving === "down"
        ? "var(--cc-error)"
        : "var(--cc-muted)";
  const servingLabel =
    serving === "serving"
      ? "serving"
      : serving === "down"
        ? "not serving"
        : serving === "off"
          ? "disabled"
          : "checking";

  const shared = {
    provider,
    status,
    caps,
    data,
    onToast,
    onNavigate,
    localEnabled,
    busyModelId,
  };

  return (
    <div
      data-testid="engine-view"
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--cc-bg)",
        overflow: "hidden",
      }}
    >
      {/* ---- 44px header ---- */}
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 14px",
          borderBottom: "1px solid var(--cc-border)",
        }}
      >
        <span style={{ fontSize: 13, fontWeight: 800, color: "var(--cc-fg)", flexShrink: 0 }}>Engine</span>
        <Pill token={servingToken} testId="engine-serving-pill" title={status?.detail || undefined}>
          {servingLabel}
        </Pill>
        {provider?.label && (
          <span
            style={{
              fontSize: 10,
              color: "var(--cc-dim)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 160,
            }}
            title={provider.label}
          >
            {provider.label}
          </span>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 6, minWidth: 0 }}>
          {ENGINE_TABS.map((t) => (
            <Tab key={t.id} id={t.id} label={t.label} active={current === t.id} onSelect={selectTab} />
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <HandoffLink
          label="Configure in Settings"
          icon={SlidersHorizontal}
          section="settings"
          subsection="providers"
          onNavigate={onNavigate}
          testId="engine-goto-settings"
        />
        <HandoffLink
          label="History in Reports"
          icon={History}
          section="reports"
          subsection="history"
          onNavigate={onNavigate}
          testId="engine-goto-reports"
        />
        <Btn
          label="Stop engine"
          icon={OctagonX}
          danger
          disabled
          testId="engine-stop"
          title={STOP_DISABLED_TITLE}
        />
      </div>

      {/* ---- body ---- */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
        {!provider ? (
          <div style={{ padding: "16px 18px" }}>
            <div
              role="note"
              style={{
                borderRadius: 12,
                border: "1px dashed var(--cc-border)",
                background: tint("var(--cc-surface)", 40),
                padding: 18,
                maxWidth: 620,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 8 }}>
                No provider selected
              </div>
              <p style={{ fontSize: 11, lineHeight: 1.6, color: "var(--cc-muted)", margin: 0 }}>
                Engine reads one backend at a time. Pick one in Settings ▸ Providers &amp; Endpoints —
                Plexar Studio registers providers server-side, so the browser never learns their URLs.
              </p>
            </div>
          </div>
        ) : current === "live" ? (
          <EngineLive
            {...shared}
            series={series}
            setLocalEnabled={setLocalEnabled}
            active={active}
            onOpenTab={selectTab}
          />
        ) : current === "models" ? (
          <EngineModels {...shared} />
        ) : (
          <EngineApi {...shared} active={active} />
        )}
      </div>
    </div>
  );
}
