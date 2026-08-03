import React, { useEffect, useRef } from "react";

/**
 * Right-click menu for the chat list. There were ZERO `onContextMenu` handlers
 * on this surface before 2026-08-03.
 *
 * Len: *"I cannot drag chats into the folders, I have no right click context
 * menu in app (studio)."* Group creation existed only as a toolbar button, so
 * the capability was real and no interaction reached it — the same
 * "capability exists, no path to it" shape reported twice in one day.
 *
 * S20'S LESSON APPLIES TO THE NEW CONTROLS TOO: every item carries a hover
 * class. Shipping a menu whose items give no feedback into the surface that was
 * just made legible would be this row undoing the previous one.
 *
 * DESTRUCTIVE ITEMS ARE MARKED AND SORTED LAST, and separated, so "delete" is
 * never adjacent to the item a user reaches for by muscle memory.
 */
export default function ChatContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    // Any click elsewhere, Escape, or a scroll dismisses. A context menu that
    // outlives its context is a floating control with no owner.
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const key = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Kept inside the viewport. A menu opened near the right or bottom edge that
  // renders off-screen is indistinguishable from one that never opened.
  const W = 180;
  const H = Math.max(items.length * 30 + 8, 40);
  const left = typeof window !== "undefined" ? Math.min(x, Math.max(0, window.innerWidth - W - 8)) : x;
  const top = typeof window !== "undefined" ? Math.min(y, Math.max(0, window.innerHeight - H - 8)) : y;

  return (
    <div
      ref={ref}
      role="menu"
      data-testid="chat-context-menu"
      style={{
        position: "fixed", left, top, width: W, zIndex: 60,
        background: "var(--cc-surface)", border: "1px solid var(--cc-border)",
        borderRadius: 8, padding: 4, display: "flex", flexDirection: "column",
        boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
      }}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} style={{ height: 1, background: "var(--cc-line)", margin: "4px 2px" }} />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            className={item.danger ? "hover-color-red" : "hover-bg-elevated"}
            data-testid={`ctx-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
            disabled={item.disabled}
            onClick={() => { onClose(); item.run(); }}
            style={{
              textAlign: "left", fontSize: 12, padding: "6px 8px", borderRadius: 5,
              border: "none", background: "transparent", cursor: item.disabled ? "default" : "pointer",
              color: item.disabled ? "var(--cc-muted)" : (item.danger ? "var(--cc-error)" : "var(--cc-fg)"),
              opacity: item.disabled ? 0.5 : 1,
            }}
          >
            {item.label}
          </button>
        )
      )}
    </div>
  );
}
