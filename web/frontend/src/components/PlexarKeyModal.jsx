import { useState, useRef, useEffect, useCallback } from "react";
import { X, Eye, EyeOff, Loader } from "lucide-react";

// ---------------------------------------------------------------------------
// PlexarKeyModal — point Plexar Studio at a Plexar-LLM rig: a URL and a key.
//
// DELIBERATELY THE SAME SHAPE AS OpenRouterModal. A Plexar-LLM rig is reached
// exactly the way OpenRouter is — an address plus a bearer token — so the two
// must not feel like different features. The one addition is the URL field:
// OpenRouter has a single well-known endpoint and Plexar does not.
//
// Backend contract (already shipped, see server.py):
//   GET    /api/settings/plexar -> {base_url, configured, source, masked, cf_configured}
//   POST   /api/settings/plexar -> {ok, base_url, configured, source, masked}
//                                  body may carry "key", "base_url", or both
//   DELETE /api/settings/plexar -> {ok, configured, source} | {ok:false, error}
//                                  (an env-var key cannot be removed from here)
//
// The full key is never returned by any of them — only a mask. The input field
// is never seeded from the server and only ever holds what is being typed.
//
// NO SAVE-TIME VALIDATION PROBE, unlike OpenRouter. OpenRouter has a free
// /credits endpoint; a Plexar rig's equivalent is /api/me, and a rig that is
// merely asleep, restarting or behind a tunnel that is still warming up would
// fail that probe and get a perfectly good key rejected at the point of entry.
// The save therefore reports only that the value was STORED, and the picker's
// own `authorized` state is what says whether the rig accepted it — the same
// "configured is not accepted" separation the GET route's docstring insists on.
// ---------------------------------------------------------------------------

function statusText(configured, source, masked, baseUrl) {
  const where = baseUrl ? ` at ${baseUrl}` : "";
  if (!configured || !source) {
    return `No key configured${where}. A loopback rig that requires no credential works as-is.`;
  }
  if (source === "ui") return `Key saved${masked ? ` — ${masked}` : ""}${where}`;
  return `Using environment key${masked ? ` ${masked}` : ""}${where}`;
}

export default function PlexarKeyModal({ open, onClose, onToast }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [urlInput, setUrlInput] = useState("");
  const [configured, setConfigured] = useState(false);
  const [source, setSource] = useState(null);
  const [masked, setMasked] = useState(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [statusError, setStatusError] = useState(null);

  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [inlineError, setInlineError] = useState(null);

  const cardRef = useRef(null);
  const firstFieldRef = useRef(null);

  const busy = saving || removing;

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    setStatusError(null);
    try {
      const res = await fetch("/api/settings/plexar");
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setBaseUrl(data.base_url || "");
        setUrlInput(data.base_url || "");
        setConfigured(Boolean(data.configured));
        setSource(data.source ?? null);
        setMasked(data.masked ?? null);
      } else {
        setStatusError(data.error || "Failed to load Plexar status");
      }
    } catch (err) {
      setStatusError(`Could not reach the server: ${err.message}`);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setKeyInput("");
    setShowKey(false);
    setInlineError(null);
    fetchStatus();
  }, [open, fetchStatus]);

  useEffect(() => {
    if (open) firstFieldRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, busy, onClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (cardRef.current && !cardRef.current.contains(e.target) && !busy) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, busy, onClose]);

  const handleSave = async () => {
    if (busy) return;
    setInlineError(null);

    const url = urlInput.trim();
    // An EMPTY url is meaningful and must reach the server: it clears the
    // override and falls back to the environment, then loopback. Refusing it
    // here would make a stored address impossible to undo from this dialog.
    if (url && !/^https?:\/\//i.test(url)) {
      setInlineError("The URL must start with http:// or https://");
      return;
    }
    const key = keyInput;
    if (key && /\s/.test(key)) {
      setInlineError("Key cannot contain whitespace.");
      return;
    }
    if (!key && url === baseUrl) {
      setInlineError("Nothing to save — change the URL or paste a key.");
      return;
    }

    const body = { base_url: url };
    if (key) body.key = key;

    setSaving(true);
    try {
      const res = await fetch("/api/settings/plexar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setBaseUrl(data.base_url || "");
        setUrlInput(data.base_url || "");
        setConfigured(Boolean(data.configured));
        setSource(data.source ?? null);
        setMasked(data.masked ?? null);
        setKeyInput("");
        onToast?.("Plexar-LLM settings saved", "success");
      } else {
        const errMsg = data.error || "Failed to save";
        setInlineError(errMsg);
        onToast?.(errMsg, "error");
      }
    } catch (err) {
      const errMsg = `Could not reach the server: ${err.message}`;
      setInlineError(errMsg);
      onToast?.(errMsg, "error");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    if (busy) return;
    setInlineError(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/settings/plexar", { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        setConfigured(Boolean(data.configured));
        setSource(data.source ?? null);
        setMasked(null);
        onToast?.("Plexar key removed", "info");
      } else {
        // The env-var case answers ok:false WITH an explanation, and saying so
        // beats reporting a success that left the key in force.
        const errMsg = data.error || "Failed to remove the key";
        setInlineError(errMsg);
        onToast?.(errMsg, "error");
      }
    } catch (err) {
      const errMsg = `Could not reach the server: ${err.message}`;
      setInlineError(errMsg);
      onToast?.(errMsg, "error");
    } finally {
      setRemoving(false);
    }
  };

  if (!open) return null;

  const INPUT = {
    backgroundColor: "var(--bg-surface)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-color)",
    fontFamily: "inherit",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
      aria-modal="true"
      role="dialog"
      aria-label="Plexar-LLM settings"
    >
      <div
        ref={cardRef}
        className="rounded-lg flex flex-col"
        style={{
          width: "100%",
          maxWidth: "440px",
          maxHeight: "90vh",
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
          padding: "20px",
          overflowY: "auto",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Plexar-LLM Settings
          </h3>
          <button
            type="button"
            aria-label="Close modal"
            onClick={onClose}
            className="p-0.5 rounded hover-color-red"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={14} />
          </button>
        </div>

        <p className="text-xs mb-4" style={{ color: "var(--text-muted)", lineHeight: 1.6 }}>
          Point Plexar Studio at a Plexar-LLM rig. Its models then appear in the model
          picker and can be selected for a session, the same as OpenRouter.
        </p>

        <div
          className="mb-4 px-3 py-2 rounded text-xs"
          style={{
            border: "1px solid var(--border-color)",
            backgroundColor: "var(--bg-surface)",
            color: "var(--text-secondary)",
          }}
        >
          {loadingStatus ? (
            <span className="flex items-center gap-2" style={{ color: "var(--text-muted)" }}>
              <Loader size={12} className="state-icon-spin" style={{ color: "var(--accent)" }} />
              Checking status...
            </span>
          ) : statusError ? (
            <span style={{ color: "var(--red)" }}>{statusError}</span>
          ) : (
            <div data-testid="plexar-status">{statusText(configured, source, masked, baseUrl)}</div>
          )}
        </div>

        <div className="mb-3">
          <label
            htmlFor="plexar-url-input"
            className="block text-[11px] uppercase tracking-wider font-medium mb-1"
            style={{ color: "var(--text-muted)" }}
          >
            Gateway URL
          </label>
          <input
            id="plexar-url-input"
            ref={firstFieldRef}
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            value={urlInput}
            onChange={(e) => {
              setUrlInput(e.target.value);
              setInlineError(null);
            }}
            placeholder="http://127.0.0.1:8760"
            className="w-full px-3 py-1.5 rounded text-xs outline-none"
            style={INPUT}
          />
          <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
            Leave empty to fall back to COCKPIT_PLEXAR_URL, then loopback.
          </p>
        </div>

        <div className="mb-3">
          <label
            htmlFor="plexar-key-input"
            className="block text-[11px] uppercase tracking-wider font-medium mb-1"
            style={{ color: "var(--text-muted)" }}
          >
            API key
          </label>
          <div className="flex items-center gap-1.5">
            <input
              id="plexar-key-input"
              type={showKey ? "text" : "password"}
              autoComplete="off"
              disabled={busy}
              value={keyInput}
              onChange={(e) => {
                setKeyInput(e.target.value);
                setInlineError(null);
              }}
              placeholder="plx-..."
              className="flex-1 min-w-0 px-3 py-1.5 rounded text-xs outline-none"
              style={INPUT}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "Hide key" : "Show key"}
              aria-pressed={showKey}
              className="p-1.5 rounded transition-colors hover-bg-surface"
              style={{ color: "var(--text-muted)", flexShrink: 0 }}
            >
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <p className="text-[11px] mt-1" style={{ color: "var(--text-muted)" }}>
            {source === "ui"
              ? "Saving a new key replaces the current one."
              : "A rig on loopback that is not behind a tunnel needs no key."}
          </p>
        </div>

        {inlineError && (
          <div
            className="mb-3 px-3 py-2 rounded text-xs"
            style={{
              border: "1px solid var(--red, #ff0033)",
              color: "var(--red, #ff0033)",
              backgroundColor: "rgba(255,0,51,0.08)",
            }}
            role="alert"
          >
            {inlineError}
          </div>
        )}

        <div className="flex justify-between items-center gap-2">
          {source === "ui" ? (
            <button
              type="button"
              disabled={busy}
              onClick={handleRemove}
              className="px-3 py-1.5 rounded text-xs transition-colors hover-color-red"
              style={{
                color: busy ? "var(--text-muted)" : "var(--red)",
                border: "1px solid var(--border-color)",
                cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              {removing ? (
                <span className="flex items-center gap-1.5">
                  <Loader size={11} className="state-icon-spin" />
                  Removing...
                </span>
              ) : (
                "Remove key"
              )}
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            disabled={busy}
            onClick={handleSave}
            className="px-3 py-1.5 rounded text-xs font-medium transition-colors"
            style={{
              backgroundColor: busy ? "var(--bg-surface)" : "var(--accent)",
              color: busy ? "var(--text-muted)" : "var(--bg)",
              cursor: busy ? "not-allowed" : "pointer",
              border: busy ? "1px solid var(--border-color)" : "none",
            }}
          >
            {saving ? (
              <span className="flex items-center gap-1.5">
                <Loader size={11} className="state-icon-spin" />
                Saving...
              </span>
            ) : (
              "Save"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
