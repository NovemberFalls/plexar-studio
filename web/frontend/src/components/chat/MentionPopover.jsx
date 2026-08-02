/**
 * MentionPopover — the @-mention menu.
 *
 * Deliberately small: it lists the conversation's OWN attachments (already
 * fetched for the Artifacts rail — no new endpoint, no new poll) plus lets
 * the user type a path by hand. Picking one inserts the path into the draft
 * at the cursor. An empty list says so plainly rather than rendering an
 * empty box.
 */

import { useEffect, useRef, useState } from "react";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export default function MentionPopover({ open, onClose, attachments, onInsert }) {
  const [manualPath, setManualPath] = useState("");
  const boxRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Mention a file"
      style={{
        position: "absolute", bottom: 30, left: 0, width: 260, zIndex: 20,
        padding: 10, borderRadius: 8, background: "var(--cc-elev)",
        border: "1px solid var(--cc-border)", fontSize: 11.5,
      }}
    >
      {(!attachments || attachments.length === 0) ? (
        <p style={{ margin: 0, color: "var(--cc-muted)", lineHeight: 1.5 }}>
          No attachments in this conversation yet. Attach a file with the
          paperclip or image icon first, or type a path below.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: "0 0 8px", padding: 0,
                     maxHeight: 160, overflowY: "auto" }}>
          {attachments.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => onInsert(a.path)}
                className="hover-bg-surface"
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  border: "none", background: "transparent", cursor: "pointer",
                  padding: "5px 6px", borderRadius: 5,
                  color: "var(--cc-fg)", fontFamily: MONO, fontSize: 11,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}
                title={a.path}
              >
                {a.filename}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (manualPath.trim()) onInsert(manualPath.trim());
        }}
        style={{ display: "flex", gap: 6 }}
      >
        <input
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          placeholder="or type a path…"
          aria-label="Path to mention"
          style={{
            flex: 1, fontFamily: MONO, fontSize: 10.5, padding: "4px 6px",
            borderRadius: 5, border: "1px solid var(--cc-border)",
            background: "var(--cc-surface)", color: "var(--cc-fg)", outline: "none",
          }}
        />
        <button
          type="submit"
          disabled={!manualPath.trim()}
          aria-label="Insert path"
          style={{
            border: "none", background: "transparent", cursor: "pointer",
            color: "var(--cc-dim)", fontSize: 10.5, padding: "0 4px",
          }}
        >
          Insert
        </button>
      </form>
    </div>
  );
}
