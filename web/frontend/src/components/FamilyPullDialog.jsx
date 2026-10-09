/**
 * FamilyPullDialog — "open this parent's workers too?"
 *
 * Shown after a parent session is dropped onto a pane slot while some of its
 * agent workers are not on screen. In-app on purpose: native browser dialogs
 * are banned (WebView2 prefixes them with the page origin), and unlike one this
 * is plain controlled UI. Every dependency arrives via props; the pull itself
 * happens in App, so cancelling leaves the placement the drop already made.
 *
 * props: { open, parentName, count, onConfirm, onCancel }
 */
import { useEffect } from "react";

export default function FamilyPullDialog({ open, parentName, count, onConfirm, onCancel }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const title = `Open ${parentName}'s ${count} worker${count === 1 ? "" : "s"} too?`;

  return (
    <div
      className="cc-modal-backdrop fixed inset-0 z-50 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="cc-modal cc-card"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          width: 440,
          maxWidth: "94vw",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          boxShadow: "0 24px 64px rgba(0,0,0,.55)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{ padding: "14px 16px", borderBottom: "1px solid var(--cc-line)", fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}
        >
          {title}
        </div>
        <div style={{ padding: "12px 16px", fontSize: 12, color: "var(--cc-muted)" }}>
          They go into the next empty panes, onto later pages if this one is full. Nothing already on screen moves.
        </div>
        <div
          className="flex items-center justify-end"
          style={{ gap: 8, padding: "10px 16px", borderTop: "1px solid var(--cc-line)" }}
        >
          <button
            type="button"
            onClick={onCancel}
            className="hover-bg-surface rounded-lg"
            style={{ padding: "6px 12px", fontSize: 12, color: "var(--cc-muted)", background: "none", border: "1px solid var(--cc-line)", cursor: "pointer" }}
          >
            Just this session
          </button>
          <button
            type="button"
            autoFocus
            onClick={onConfirm}
            className="rounded-lg"
            style={{ padding: "6px 12px", fontSize: 12, fontWeight: 700, color: "#0f1216", background: "var(--cc-accent)", border: "none", cursor: "pointer" }}
          >
            {`Open all ${count}`}
          </button>
        </div>
      </div>
    </div>
  );
}
