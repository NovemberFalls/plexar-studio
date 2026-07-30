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
import { Card, CardTitle, Note, OfflinePanel, Badge } from "./ui.jsx";

export default function EngineModels({ provider, caps, data, onToast, onNavigate }) {
  const [busyModelId, setBusyModelId] = useState(null);
  const models = data?.models;
  const controlEnabled = Boolean(caps?.has("model-control"));

  const write = async (modelId, action) => {
    if (!provider?.id || !modelId) return;
    setBusyModelId(modelId);
    try {
      const res = await fetch(
        `/api/local/${encodeURIComponent(provider.id)}/models/${encodeURIComponent(modelId)}/${action}`,
        { method: "POST" }
      );
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok === false) {
        onToast?.(payload?.error || `Could not ${action} ${modelId}`, "error");
      } else {
        onToast?.(`${action === "load" ? "Loading" : "Unloading"} ${modelId}…`, "info");
      }
    } catch {
      onToast?.(`Could not reach Cockpit to ${action} the model`, "error");
    } finally {
      setBusyModelId(null);
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
        right={controlEnabled ? <Badge token="var(--cc-accent)">load / unload</Badge> : <Badge>read-only</Badge>}
      >
        <LocalModelsPanel
          models={models}
          providerKind={provider?.kind}
          controlEnabled={controlEnabled}
          busyModelId={busyModelId}
          onLoad={(id) => write(id, "load")}
          onUnload={(id) => write(id, "unload")}
        />
        {!controlEnabled && (
          <Note testId="models-readonly-note">
            This backend does not declare model-control, so Cockpit cannot load or unload for you.
            For LM Studio that usually means the <code>lms</code> CLI is not on the server&rsquo;s PATH.
          </Note>
        )}
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
