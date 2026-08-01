/**
 * Tool-call strip — CHAT.md §6.
 *
 * "One bordered group ... Reads as a quiet log, never as a set of coloured
 * cards." That sentence is the whole design: this is the surface most likely to
 * drift into 5a, because a tool call feels like it wants a status colour. It
 * does not get one. A 4px dot carries the state, in `--cc-dim` when the call is
 * simply done and `--cc-fg` when it wants attention — brightness, not hue.
 *
 * What is shown is the verb and what it TOUCHED, never the arguments: a tool
 * input can carry an entire file, and the strip is meant to be scannable. The
 * runner already truncates to targets; this must not undo that by rendering
 * anything it is handed.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

export default function ToolStrip({ calls }) {
  // Collapsed by default (§6). A run with a dozen reads should not push the
  // answer off the screen.
  const [open, setOpen] = useState(false);
  if (!calls || calls.length === 0) return null;

  const failed = calls.filter((c) => c.is_error).length;

  return (
    <div style={{ borderRadius: 8, border: "1px solid var(--cc-line)",
                  overflow: "hidden", maxWidth: 620 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${calls.length} tool call${calls.length === 1 ? "" : "s"}`}
        style={{
          width: "100%", height: 28, display: "flex", alignItems: "center",
          gap: 7, padding: "0 10px", background: "transparent", border: "none",
          cursor: "pointer", fontFamily: MONO, fontSize: 11,
          color: "var(--cc-dim)",
        }}
      >
        <ChevronRight
          size={11}
          style={{ transform: open ? "rotate(90deg)" : "none", flexShrink: 0 }}
        />
        <span>
          {calls.length} tool call{calls.length === 1 ? "" : "s"}
        </span>
        {/* A failure count is worth surfacing collapsed — it is the one thing
            you would want to know without expanding. Still no colour. */}
        {failed > 0 && (
          <span style={{ color: "var(--cc-fg)" }}>· {failed} failed</span>
        )}
      </button>

      {open && calls.map((c, i) => (
        <div
          key={c.id || i}
          style={{
            height: 28, display: "flex", alignItems: "center", gap: 8,
            padding: "0 10px", borderTop: "1px solid var(--cc-line)",
            fontFamily: MONO, fontSize: 11,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 4, height: 4, borderRadius: "50%", flexShrink: 0,
              // Brightness encodes state. `--cc-fg` means it wants you.
              background: c.is_error ? "var(--cc-fg)" : "var(--cc-dim)",
            }}
          />
          <span style={{ color: "var(--cc-dim)" }}>{c.verb}</span>
          <span style={{
            color: "var(--cc-muted)", overflow: "hidden",
            textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1,
          }}>
            {(c.targets || []).join(" · ")}
          </span>
          {c.is_error && (
            <span style={{ color: "var(--cc-fg)", flexShrink: 0 }}>failed</span>
          )}
        </div>
      ))}
    </div>
  );
}
