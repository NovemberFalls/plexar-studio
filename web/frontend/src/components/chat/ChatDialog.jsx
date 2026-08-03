import React, { useEffect, useRef, useState } from "react";

/**
 * In-app prompt / confirm for Chat. Replaces `window.prompt` and
 * `window.confirm`.
 *
 * ── WHY THIS EXISTS, and the report that produced it ───────────────────────
 * Len, on the installed 1.26.0 build: *"it said its creating the folder on
 * local host something something I think 8420."* Hedged, vague, prefaced with
 * "I think" — and **exactly accurate**. WebView2 renders native dialogs with
 * the page ORIGIN prefixed, so clicking "New group" put this on screen:
 *
 *     localhost:8420 says:
 *     Group name
 *
 * **A desktop application must never show the user its own HTTP port.** It
 * makes a native app look like a web page, and here it made a CORRECT feature
 * (creating a group) look like it was writing something to a server. The user
 * described their screen precisely; the imprecision was in how it was read.
 *
 * ── WHAT THIS KEEPS THAT `window.prompt` DID NOT ──────────────────────────
 * `window.prompt` is synchronous and blocking, which is why it was reached for.
 * The cost is that it cannot show a FAILURE: the call returns, the caller does
 * the work, and if that work throws, the dialog is already gone. So this one
 * stays open until its submit RESOLVES, and renders the error if it rejects —
 * the same rule ChatRootPrompt follows, for the same reason.
 */
export default function ChatDialog({
  mode = "prompt",
  title,
  message,
  placeholder = "",
  initialValue = "",
  confirmLabel,
  danger = false,
  onSubmit,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    // Focus the way a native prompt did — losing that would be a regression
    // dressed as an improvement.
    if (mode === "prompt" && inputRef.current) inputRef.current.focus();
  }, [mode]);

  const submit = async () => {
    if (mode === "prompt" && !value.trim()) return;
    setError(null);
    setBusy(true);
    try {
      // AWAITED. The whole reason a native prompt could not do this job.
      await onSubmit(mode === "prompt" ? value.trim() : true);
    } catch (err) {
      setError(err?.message || "That did not work. Nothing was changed.");
      setBusy(false);
      return;                       // stays open, deliberately
    }
    setBusy(false);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    // Escape cancels. Safe here in a way it is NOT in ChatRootPrompt: these
    // dialogs have a real no-op outcome ("do not create", "do not delete"),
    // whereas dismissing a "where should this live?" question leaves the
    // question unanswered and the location unstated.
    if (e.key === "Escape") { e.preventDefault(); if (!busy) onCancel?.(); }
  };

  const isConfirm = mode === "confirm";

  return (
    <div style={S.backdrop} data-testid="chat-dialog" onKeyDown={onKeyDown}>
      <div style={S.panel} role="dialog" aria-modal="true" aria-label={title}>
        <div style={S.title}>{title}</div>
        {message ? <div style={S.body}>{message}</div> : null}

        {!isConfirm ? (
          <input
            ref={inputRef}
            style={S.input}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={title}
            data-testid="chat-dialog-input"
            disabled={busy}
          />
        ) : null}

        {error ? (
          <div style={S.error} data-testid="chat-dialog-error">{error}</div>
        ) : null}

        <div style={S.row}>
          <div style={{ flex: 1 }} />
          <button
            style={S.secondary}
            onClick={() => onCancel?.()}
            disabled={busy}
            data-testid="chat-dialog-cancel"
          >
            Cancel
          </button>
          <button
            style={{
              ...S.primary,
              background: danger ? "var(--cc-error)" : "var(--cc-accent)",
              opacity: busy || (!isConfirm && !value.trim()) ? 0.45 : 1,
            }}
            onClick={submit}
            disabled={busy || (!isConfirm && !value.trim())}
            data-testid="chat-dialog-confirm"
          >
            {busy ? "Working…" : (confirmLabel || (isConfirm ? "Confirm" : "Create"))}
          </button>
        </div>
      </div>
    </div>
  );
}

const S = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 45,
  },
  panel: {
    width: 380, maxWidth: "90%", background: "var(--cc-surface)",
    border: "1px solid var(--cc-border)", borderRadius: 10, padding: 18,
    display: "flex", flexDirection: "column", gap: 8,
  },
  title: { fontSize: 13.5, fontWeight: 600, color: "var(--cc-fg)" },
  body: { fontSize: 12, color: "var(--cc-muted)", lineHeight: 1.5 },
  input: {
    fontSize: 12, color: "var(--cc-fg)", background: "var(--cc-bg2)",
    border: "1px solid var(--cc-border)", borderRadius: 6, padding: "7px 9px",
  },
  error: { fontSize: 11, color: "var(--cc-error)", lineHeight: 1.4 },
  row: { display: "flex", alignItems: "center", gap: 8, marginTop: 10 },
  secondary: {
    fontSize: 11, padding: "6px 10px", borderRadius: 6, cursor: "pointer",
    background: "transparent", color: "var(--cc-muted)",
    border: "1px solid var(--cc-border)",
  },
  primary: {
    fontSize: 11, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
    color: "#0b0b0b", border: "none",
  },
};
