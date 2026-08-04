import { useState, useRef, useEffect, useCallback } from "react";
import { X, Eye, EyeOff, Loader } from "lucide-react";

// ---------------------------------------------------------------------------
// OpenRouterModal — lets a user save/replace/remove their OpenRouter API key.
//
// Backend contract (Tier 1, finalized — see CLAUDE.md / task brief):
//   GET    /api/settings/openrouter    -> {configured, source: "ui"|"env"|null, masked}
//   POST   /api/settings/openrouter    -> {ok:true, masked, credits_remaining} |
//                                          {ok:false, error} (400 bad key / 502 unreachable)
//   DELETE /api/settings/openrouter    -> {ok:true, configured, source}  (state AFTER removal)
//
// The full key is never returned by any endpoint — only a masked preview
// (e.g. "sk-or-v1…338d"). The input field never displays a fetched/masked
// value; it only ever holds what the user is currently typing.
// ---------------------------------------------------------------------------

function statusText(configured, source, masked) {
    if (!configured || !source) return "Not configured";
    if (source === "ui") {
        return masked ? `Connected — UI key ${masked}` : "Connected — UI key";
    }
    // source === "env"
    return masked ? `Using environment key ${masked}` : "Using environment key";
}

export default function OpenRouterModal({ open, onClose, onToast }) {
    // ---- status (from GET, refreshed after POST/DELETE) ----
    const [configured, setConfigured] = useState(false);
    const [source, setSource] = useState(null);
    const [masked, setMasked] = useState(null);
    const [loadingStatus, setLoadingStatus] = useState(false);
    const [statusError, setStatusError] = useState(null);

    // ---- new-key input ----
    const [keyInput, setKeyInput] = useState("");
    const [showKey, setShowKey] = useState(false);

    // ---- in-flight / result state ----
    const [validating, setValidating] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [inlineError, setInlineError] = useState(null);
    const [creditsRemaining, setCreditsRemaining] = useState(null);

    const cardRef = useRef(null);
    const firstFieldRef = useRef(null);

    const busy = validating || removing;

    // ---- fetch current status ----
    const fetchStatus = useCallback(async () => {
        setLoadingStatus(true);
        setStatusError(null);
        try {
            const res = await fetch("/api/settings/openrouter");
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                setConfigured(Boolean(data.configured));
                setSource(data.source ?? null);
                setMasked(data.masked ?? null);
            } else {
                setStatusError(data.error || "Failed to load OpenRouter status");
            }
        } catch (err) {
            setStatusError(`Could not reach the server: ${err.message}`);
        } finally {
            setLoadingStatus(false);
        }
    }, []);

    // ---- reset transient state + fetch status whenever the modal opens ----
    useEffect(() => {
        if (!open) return;
        setKeyInput("");
        setShowKey(false);
        setInlineError(null);
        setCreditsRemaining(null);
        fetchStatus();
    }, [open, fetchStatus]);

    // ---- focus management ----
    useEffect(() => {
        if (open) {
            firstFieldRef.current?.focus();
        }
    }, [open]);

    // ---- escape key ----
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (e.key === "Escape" && !busy) {
                onClose();
            }
        };
        document.addEventListener("keydown", handler);
        return () => document.removeEventListener("keydown", handler);
    }, [open, busy, onClose]);

    // ---- click-outside to close ----
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (cardRef.current && !cardRef.current.contains(e.target)) {
                if (!busy) onClose();
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [open, busy, onClose]);

    // ---- save & test ----
    const handleSave = async () => {
        if (busy) return;
        setInlineError(null);
        setCreditsRemaining(null);

        // Client-side quick check — empty or whitespace-containing key never
        // reaches the network. A real OpenRouter key has no whitespace, and an
        // accidental leading/trailing space is the most common paste mistake.
        if (!keyInput || /\s/.test(keyInput)) {
            setInlineError("Key cannot be empty or contain whitespace.");
            return;
        }

        setValidating(true);
        try {
            const res = await fetch("/api/settings/openrouter", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ key: keyInput }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
                setConfigured(true);
                setSource("ui");
                setMasked(data.masked ?? null);
                setCreditsRemaining(
                    typeof data.credits_remaining === "number" ? data.credits_remaining : null
                );
                setKeyInput("");
                onToast?.(
                    `OpenRouter key saved${data.masked ? ` — ${data.masked}` : ""}`,
                    "success"
                );
            } else {
                const errMsg = data.error || "Failed to save the key";
                setInlineError(errMsg);
                onToast?.(errMsg, "error");
            }
        } catch (err) {
            const errMsg = `Could not reach the server: ${err.message}`;
            setInlineError(errMsg);
            onToast?.(errMsg, "error");
        } finally {
            setValidating(false);
        }
    };

    // ---- remove key ----
    const handleRemove = async () => {
        if (busy) return;
        setInlineError(null);
        setRemoving(true);
        try {
            const res = await fetch("/api/settings/openrouter", { method: "DELETE" });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data.ok) {
                setConfigured(Boolean(data.configured));
                setSource(data.source ?? null);
                setMasked(data.masked ?? null);
                setCreditsRemaining(null);
                onToast?.("OpenRouter key removed", "info");
            } else {
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

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center"
            style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
            aria-modal="true"
            role="dialog"
            aria-label="OpenRouter settings"
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
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                    <h3
                        className="text-sm font-semibold"
                        style={{ color: "var(--text-primary)" }}
                    >
                        OpenRouter Settings
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

                {/* Intro + help link */}
                <p
                    className="text-xs mb-4"
                    style={{ color: "var(--text-muted)", lineHeight: 1.6 }}
                >
                    Save an OpenRouter API key so Plexar Studio can route requests through
                    OpenRouter on your behalf.{" "}
                    <a
                        href="https://openrouter.ai/settings/keys"
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: "var(--accent)" }}
                    >
                        Get a key at openrouter.ai/settings/keys
                    </a>
                </p>

                {/* Status */}
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
                        <>
                            <div data-testid="openrouter-status">
                                {statusText(configured, source, masked)}
                            </div>
                            {creditsRemaining != null && (
                                <div className="mt-1 font-medium" style={{ color: "var(--accent)" }}>
                                    {`$${creditsRemaining.toFixed(2)} remaining`}
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* New key input */}
                <div className="mb-3">
                    <label
                        htmlFor="openrouter-key-input"
                        className="block text-[11px] uppercase tracking-wider font-medium mb-1"
                        style={{ color: "var(--text-muted)" }}
                    >
                        API key
                    </label>
                    <div className="flex items-center gap-1.5">
                        <input
                            id="openrouter-key-input"
                            ref={firstFieldRef}
                            type={showKey ? "text" : "password"}
                            autoComplete="off"
                            disabled={busy}
                            value={keyInput}
                            onChange={(e) => {
                                setKeyInput(e.target.value);
                                setInlineError(null);
                            }}
                            placeholder="sk-or-v1-..."
                            className="flex-1 min-w-0 px-3 py-1.5 rounded text-xs outline-none"
                            style={{
                                backgroundColor: "var(--bg-surface)",
                                color: "var(--text-primary)",
                                border: "1px solid var(--border-color)",
                                fontFamily: "inherit",
                            }}
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
                    {source === "ui" && (
                        <p
                            className="text-[11px] mt-1"
                            style={{ color: "var(--text-muted)" }}
                        >
                            Saving a new key replaces the current one.
                        </p>
                    )}
                </div>

                {/* Inline error */}
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

                {/* Footer buttons */}
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
                        {validating ? (
                            <span className="flex items-center gap-1.5">
                                <Loader size={11} className="state-icon-spin" />
                                Validating...
                            </span>
                        ) : (
                            "Save & Test"
                        )}
                    </button>
                </div>
            </div>
        </div>
    );
}
