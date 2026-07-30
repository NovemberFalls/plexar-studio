/**
 * LocalModelsPanel — list of models known to the selected provider's
 * management API.
 *
 * Renders GET /api/local/{provider}/models: id, quantization, arch, max
 * context length, and loaded state. Loaded models are highlighted. Offline
 * state mirrors LaneQueuePanel.
 *
 * Props:
 *   models — object from GET /api/local/{provider}/models, or null when offline/loading
 *   controlEnabled — when true, render per-row Load/Unload buttons (provider has
 *     the "model-control" capability). Progress is INFERRED: while busyModelId
 *     matches a row an indeterminate bar shows until the /models poll flips its
 *     state (LM Studio reports no load percentage).
 *   busyModelId — id of the model currently loading/unloading, or null
 *   onLoad(modelId) / onUnload(modelId) — control handlers
 */

function fmtCtx(n) {
  if (typeof n !== "number" || !isFinite(n)) return "—";
  if (n >= 1000) return (n % 1000 === 0 ? n / 1000 : (n / 1000).toFixed(1)) + "k";
  return String(n);
}

export default function LocalModelsPanel({
  models,
  providerKind,
  controlEnabled = false,
  busyModelId = null,
  onLoad,
  onUnload,
}) {
  const list = Array.isArray(models?.models) ? models.models : [];
  // vLLM can return HTTP 200 with reachable:false when the server is down but
  // its models folder scanned fine — those disk-only entries are still worth
  // showing so the user can start one. Only treat this as a true "no data"
  // offline state when there's nothing to list either.
  const offline = (!models || models.reachable === false) && list.length === 0;
  const reason = models?.reason || null;

  if (offline) {
    let message = "Provider offline — no models data.";
    if (reason === "unreachable") {
      message = providerKind === "vllm"
        ? "vLLM container isn't running — start it to see models."
        : "Local server isn't running — start it with `lms server start`.";
    }
    return (
      <div style={{ padding: "10px 12px" }}>
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
          Models
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {message}
        </div>
      </div>
    );
  }

  const unreachableWithModels = models?.reachable === false && list.length > 0;
  const diskOnlyMessage = reason === "server_offline_disk_only"
    ? "Server offline — these models were found on disk."
    : "Provider offline — models found on disk.";

  return (
    <div style={{ padding: "10px 12px" }}>
      <div className="text-[10px] uppercase tracking-wider" style={{ color: "var(--text-muted)", marginBottom: 6 }}>
        Models
      </div>
      {unreachableWithModels && (
        <div className="text-xs" style={{ color: "var(--text-muted)", marginBottom: 6, fontStyle: "italic" }}>
          {diskOnlyMessage}
        </div>
      )}
      {list.length === 0 ? (
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>no models reported</div>
      ) : (
        list.map((m, i) => {
          const loaded = m.state === "loaded";
          const busy = controlEnabled && busyModelId != null && busyModelId === m.id;
          return (
            <div key={m.id || i} style={{ padding: "4px 0" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  opacity: loaded ? 1 : 0.7,
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 999,
                    flexShrink: 0,
                    background: loaded ? "var(--accent)" : "var(--text-muted)",
                  }}
                />
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: loaded ? 600 : 400,
                    color: "var(--text-primary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    maxWidth: controlEnabled ? 120 : 150,
                  }}
                  title={m.id || ""}
                >
                  {m.id || "—"}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: "auto", flexShrink: 0, textAlign: "right" }}>
                  {[m.arch, m.quantization].filter(Boolean).join(" · ") || "—"}
                </span>
                <span style={{ fontSize: 10, color: "var(--text-secondary)", flexShrink: 0, minWidth: 60, textAlign: "right" }}>
                  {fmtCtx(m.loaded_context_length)} / {fmtCtx(m.max_context_length)}
                </span>
                {controlEnabled && (
                  <button
                    type="button"
                    disabled={busy || !m.id}
                    onClick={() => (loaded ? onUnload?.(m.id) : onLoad?.(m.id))}
                    className="hover-bg-surface"
                    style={{
                      fontSize: 10,
                      padding: "2px 8px",
                      borderRadius: 4,
                      flexShrink: 0,
                      border: "1px solid var(--border)",
                      color: "var(--text-secondary)",
                      background: "transparent",
                      cursor: busy ? "default" : "pointer",
                      opacity: busy ? 0.5 : 1,
                    }}
                    title={loaded ? "Unload this model" : "Load this model"}
                    /* The visible text is just "Load"/"Unload", so a screen
                       reader would otherwise hear no model name at all — in a
                       list of eight rows that is an unusable control. The busy
                       state is announced too, since the label becomes "…". */
                    aria-label={
                      busy
                        ? `${loaded ? "Unloading" : "Loading"} ${m.id || "model"}`
                        : `${loaded ? "Unload" : "Load"} ${m.id || "model"}`
                    }
                    aria-busy={busy || undefined}
                  >
                    {busy ? "…" : loaded ? "Unload" : "Load"}
                  </button>
                )}
              </div>
              {busy && (
                <div
                  style={{
                    height: 2,
                    marginTop: 4,
                    borderRadius: 999,
                    overflow: "hidden",
                    background: "var(--border)",
                  }}
                >
                  <div className="local-progress-indeterminate" />
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
