/**
 * HarnessApprovalDialog — the in-app modal for a "permission" WS frame from
 * /ws/harness. Absolutely not a native browser dialog — the repo bans those
 * and pins the absence with __tests__/NoNativeDialogs.test.jsx.
 *
 * The caller (HarnessView) owns the QUEUE of pending requests and always
 * passes the head of the queue as `request`; this component shows one at a
 * time and calls `onResolve(optionId)` when the user answers, after which
 * the caller advances to the next queued request (or unmounts this dialog).
 */
export default function HarnessApprovalDialog({ request, onResolve }) {
  if (!request) return null;
  const params = request.params || {};
  const toolName = params.tool_name || params.name || "tool";

  return (
    <div
      className="cc-modal-backdrop fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 80 }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Approval requested"
        data-testid="harness-approval-dialog"
        className="cc-modal cc-card"
        style={{
          width: 420,
          maxWidth: "90vw",
          padding: 16,
          background: "var(--cc-surface)",
          border: "1px solid var(--cc-border)",
          borderRadius: 12,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)", marginBottom: 6 }}>
          Approval requested
        </div>
        <div data-testid="harness-approval-tool" style={{ fontSize: 12, color: "var(--cc-fg)", marginBottom: 4 }}>
          {toolName}
        </div>
        <pre
          data-testid="harness-approval-params"
          style={{
            fontSize: 10,
            whiteSpace: "pre-wrap",
            color: "var(--cc-dim)",
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            borderRadius: 8,
            padding: 8,
            maxHeight: 160,
            overflow: "auto",
          }}
        >
          {JSON.stringify(params, null, 2)}
        </pre>
        <div className="flex items-center justify-end gap-2" style={{ marginTop: 12 }}>
          <button
            type="button"
            aria-label="Reject"
            data-testid="harness-approval-reject"
            onClick={() => onResolve("reject-once")}
            className="hover-bg-surface"
            style={{
              height: 30,
              padding: "0 12px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 600,
              background: "none",
              border: "1px solid var(--cc-border)",
              color: "var(--cc-dim)",
              cursor: "pointer",
            }}
          >
            Reject
          </button>
          <button
            type="button"
            aria-label="Allow once"
            data-testid="harness-approval-allow"
            onClick={() => onResolve("allow-once")}
            className="hover-bg-surface"
            style={{
              height: 30,
              padding: "0 12px",
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 700,
              background: "var(--cc-accent)",
              border: "none",
              color: "#0f1216",
              cursor: "pointer",
            }}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
}
