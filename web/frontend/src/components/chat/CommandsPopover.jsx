/**
 * CommandsPopover — the /-commands menu.
 *
 * Only lists handlers that ALREADY EXIST and already work in ChatView — no
 * new backend calls invented for this menu. A menu entry that errors is
 * worse than a shorter menu, so `commands` is built by the caller from its
 * own real functions and passed straight through.
 */

import { useEffect } from "react";

export default function CommandsPopover({ open, onClose, commands }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Commands"
      style={{
        position: "absolute", bottom: 30, left: 0, width: 220, zIndex: 20,
        padding: 6, borderRadius: 8, background: "var(--cc-elev)",
        border: "1px solid var(--cc-border)", fontSize: 11.5,
      }}
    >
      {commands.map((c) => (
        <button
          key={c.label}
          type="button"
          onClick={c.run}
          disabled={c.disabled}
          className="hover-bg-surface"
          style={{
            display: "block", width: "100%", textAlign: "left",
            border: "none", background: "transparent",
            cursor: c.disabled ? "default" : "pointer",
            opacity: c.disabled ? 0.4 : 1,
            padding: "6px 8px", borderRadius: 5, color: "var(--cc-fg)",
          }}
        >
          /{c.label}
        </button>
      ))}
    </div>
  );
}
