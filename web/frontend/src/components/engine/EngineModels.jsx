/**
 * EngineModels — Engine ▸ Models. Reuses the shipped LocalModelsPanel rather
 * than restating its rendering; this file only supplies the card frame, the
 * capability gate, and the load/unload writes.
 *
 * Model FILES and folders are configuration and live in Settings ▸ Providers.
 * What is loaded right now is engine state, so it lives here.
 */
import { useState } from "react";
import { Boxes } from "lucide-react";

import LocalModelsPanel from "../LocalModelsPanel.jsx";
import useLocalModels, { setLocalModelBusy } from "../../hooks/useLocalModels.js";
import { Card, CardTitle, Note, OfflinePanel, Badge } from "./ui.jsx";

/**
 * `model-discovery` WITHOUT `model-control` is browse-only: Cockpit can enumerate
 * what is on disk but cannot switch to any of it. Saying so is the difference
 * between an honest inventory and a picker that leads nowhere.
 */
function browseOnlyReason(provider) {
  if (provider?.kind === "vllm") {
    return (
      "Browse only. Cockpit can list the models it can see on disk, but it cannot switch to one: " +
      "vLLM serves the single model given to --model at launch, and this vLLM is not managed by " +
      "Cockpit (COCKPIT_MANAGED_VLLM is off), so Cockpit cannot restart it onto a different model. " +
      "Pick one from this list and start vLLM with it yourself."
    );
  }
  return (
    "Browse only. This backend publishes a model list but does not declare model-control, so " +
    "Cockpit can show you what exists and cannot load or unload any of it."
  );
}

export default function EngineModels({ provider, caps, data, onToast, onNavigate, busyModelId, onWriteModel }) {
  // A 404 from load/unload means the capability is not available after all — the
  // buttons should not have been there. Retract them rather than red-toasting.
  const [controlLost, setControlLost] = useState(false);
  // Busy state is app-wide, not local: a load kicked off from the TopBar picker
  // must spin the row here too, and vice versa. Both surfaces mark the same
  // model through the shared store, and the same /models poll clears it.
  const store = useLocalModels();
  const busy = busyModelId !== undefined ? busyModelId : store.busyModelId;
  // EngineView already merges the shared list into `data`; the fallback keeps
  // this card correct when it is mounted without that frame.
  const models = data?.models !== undefined ? data.models : store.models;
  const controlEnabled = Boolean(caps?.has("model-control")) && !controlLost;
  const browseOnly = !controlEnabled && Boolean(caps?.has("model-discovery"));

  /**
   * The write. Deliberately NOT the shared store's `writeModel`: that one reports
   * every non-OK status as an error toast, so a 404 "capability not available"
   * surfaced as a scary red failure about a perfectly healthy backend. Busy state
   * still goes through the shared marker, so the TopBar picker spins too.
   */
  const write = async (modelId, action) => {
    if (!provider?.id || !modelId) return;
    if (typeof onWriteModel === "function") {
      onWriteModel(provider.id, modelId, action, onToast);
      return;
    }
    const url = `/api/local/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(modelId)}/${action}`;
    setLocalModelBusy(modelId);
    try {
      const res = await fetch(url, { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setControlLost(true);
        return;
      }
      if (!res.ok || payload?.ok === false) {
        // 409 and friends now carry actionable text — pass it through verbatim.
        onToast?.(payload?.error || `Could not ${action} ${modelId}`, "error");
        return;
      }
      onToast?.(`${action === "load" ? "Loading" : "Unloading"} ${modelId}…`, "info");
    } catch {
      onToast?.(`Could not reach Cockpit to ${action} the model`, "error");
    } finally {
      setLocalModelBusy(null);
    }
  };

  if (!caps?.has("models")) {
    return (
      <div style={{ padding: "16px 18px" }}>
        <OfflinePanel
          testId="models-not-offered"
          title="This backend does not expose a model list"
          body="The models capability is not declared for the selected provider, so Cockpit has no /models endpoint to read. Nothing is hidden — there is nothing to ask."
        />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", minWidth: 0 }}>
      <Card
        testId="engine-models-card"
        title={<CardTitle icon={Boxes} token="var(--cc-type)">Models</CardTitle>}
        right={
          controlEnabled ? (
            <Badge token="var(--cc-accent)">load / unload</Badge>
          ) : browseOnly ? (
            <Badge token="var(--cc-waiting)" testId="models-browse-only-badge">
              browse only
            </Badge>
          ) : (
            <Badge>read-only</Badge>
          )
        }
      >
        <LocalModelsPanel
          models={models}
          providerKind={provider?.kind}
          controlEnabled={controlEnabled}
          busyModelId={busy}
          onLoad={(id) => write(id, "load")}
          onUnload={(id) => write(id, "unload")}
        />
        {browseOnly ? (
          <Note testId="models-browse-only-note" token="var(--cc-waiting)" tinted>
            {browseOnlyReason(provider)}
          </Note>
        ) : !controlEnabled ? (
          <Note testId="models-readonly-note">
            This backend does not declare model-control, so Cockpit cannot load or unload for you.
            For LM Studio that usually means the <code>lms</code> CLI is not on the server&rsquo;s PATH.
          </Note>
        ) : null}
        <Note testId="models-folder-note">
          Where models are found on disk is configuration — it lives in Settings ▸ Providers &amp;
          Endpoints.
          {typeof onNavigate === "function" && (
            <>
              {" "}
              <button
                type="button"
                data-testid="models-goto-settings"
                onClick={() => onNavigate("settings", "providers")}
                aria-label="Open model folders in Settings"
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
    </div>
  );
}
