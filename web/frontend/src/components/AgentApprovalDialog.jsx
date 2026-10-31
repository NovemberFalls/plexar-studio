/**
 * AgentApprovalDialog — an agent asks for something only the user may grant.
 *
 * Two kinds (agent_api.py "Approvals"): `adopt` (a session asks to make another
 * session one of its workers, gaining prompt, keys, clear and close over it) and
 * `self_refresh` (a session asks to clear its own conversation and restart on a
 * boot line). Pending requests arrive on the /api/terminals poll; App passes the
 * oldest one here.
 *
 * In-app on purpose (native dialogs are banned), and it does what a native confirm
 * cannot: it AWAITS the answer, so a refusal (the request expired, the session
 * closed, the target gained workers meanwhile) is shown here instead of the dialog
 * having already closed. Escape and the backdrop dismiss WITHOUT answering: the
 * request stays pending and comes back on the next poll, so nothing is decided by
 * accident.
 *
 * App keys it by request id, so busy/error state never carries over to the next one.
 *
 * props: { request, onAnswer(id, approve) -> Promise<{ok, error?}>, onDismiss }
 */
import { useEffect, useState } from "react";

const BUTTON = { padding: "6px 12px", fontSize: 12, borderRadius: 8, cursor: "pointer" };

export default function AgentApprovalDialog({ request, onAnswer, onDismiss }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!request) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request, onDismiss]);

  if (!request) return null;

  const adopt = request.kind === "adopt";
  const title = adopt
    ? `${request.caller_name} wants to take over ${request.target_name}`
    : `${request.caller_name} wants to clear its own context`;

  const answer = async (approve) => {
    setBusy(true);
    setError(null);
    const res = await onAnswer(request.id, approve);
    if (!res.ok) {
      setError(res.error || "The request could not be answered.");
      setBusy(false);
    }
  };

  return (
    <div className="cc-modal-backdrop fixed inset-0 z-50 flex items-center justify-center" onClick={onDismiss}>
      <div
        className="cc-modal cc-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: 480, maxWidth: "94vw", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 24px 64px rgba(0,0,0,.55)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--cc-line)", fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>
          {title}
        </div>
        <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--cc-muted)", display: "flex", flexDirection: "column", gap: 8 }}>
          {adopt ? (
            <span>
              {request.target_name} becomes one of {request.caller_name}&apos;s workers. {request.caller_name} will be
              able to prompt it, send it keys, clear its conversation and close it. Nothing is restarted.
            </span>
          ) : (
            <>
              <span>
                When its current turn ends, {request.caller_name}&apos;s conversation is cleared and it restarts on
                this prompt. Its pane, name and workers stay as they are.
              </span>
              <pre style={{ margin: 0, padding: 8, maxHeight: 160, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 11, color: "var(--cc-fg)", background: "var(--cc-surface)", border: "1px solid var(--cc-line)", borderRadius: 6 }}>
                {request.prompt}
              </pre>
            </>
          )}
          {error && (
            <span role="alert" style={{ color: "var(--cc-red, #e5534b)" }}>
              {error}
            </span>
          )}
        </div>
        <div className="flex items-center justify-end" style={{ gap: 8, padding: "10px 16px", borderTop: "1px solid var(--cc-line)" }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => answer(false)}
            className="hover-bg-surface"
            style={{ ...BUTTON, color: "var(--cc-muted)", background: "none", border: "1px solid var(--cc-line)" }}
          >
            Deny
          </button>
          <button
            type="button"
            disabled={busy}
            autoFocus
            onClick={() => answer(true)}
            style={{ ...BUTTON, fontWeight: 700, color: "#0f1216", background: "var(--cc-accent)", border: "none" }}
          >
            {adopt ? "Allow takeover" : "Allow refresh"}
          </button>
        </div>
      </div>
    </div>
  );
}
