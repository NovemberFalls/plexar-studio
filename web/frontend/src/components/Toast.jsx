/* eslint-disable react-refresh/only-export-components */
import { useState, useCallback, useRef } from "react";
import { CheckCircle, CircleX, Info, TriangleAlert } from "lucide-react";

let toastId = 0;

export function useToast() {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const toast = useCallback((message, type = "info", duration = 4000, action = null) => {
    const id = ++toastId;
    setToasts((prev) => [...prev, { id, message, type, action }]);
    if (duration > 0) {
      timers.current[id] = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        delete timers.current[id];
      }, duration);
    }
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    if (timers.current[id]) {
      clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  return { toasts, toast, dismiss };
}

export function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null;

  return (
    <div style={{
      position: "fixed",
      bottom: "40px",
      right: "16px",
      zIndex: 9999,
      display: "flex",
      flexDirection: "column-reverse",
      gap: "8px",
      maxWidth: "400px",
    }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => !t.action && onDismiss?.(t.id)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "10px",
            padding: "10px 16px",
            borderRadius: "8px",
            backgroundColor: "var(--bg-elevated, #1a1a2e)",
            border: "1px solid var(--border-color, rgba(255,255,255,0.15))",
            color: "var(--text-primary, #e0e0e0)",
            fontSize: "13px",
            fontFamily: "'JetBrains Mono', monospace",
            cursor: t.action ? "default" : "pointer",
            animation: "toast-in 0.2s ease-out",
            boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          }}
        >
          {t.type === "error" ? (
            <CircleX size={16} style={{ color: "#ff6b6b", flexShrink: 0 }} />
          ) : t.type === "warning" ? (
            // Not an error and not a success. A mailbox bridge pausing at its
            // round cap is the case this exists for: the run is fine and is
            // waiting on the user. Without this branch it fell through to the
            // green tick, which reads as "done".
            <TriangleAlert size={16} style={{ color: "var(--cc-waiting, #e0b060)", flexShrink: 0 }} />
          ) : t.type === "info" ? (
            <Info size={16} style={{ color: "var(--accent, #4dabf7)", flexShrink: 0 }} />
          ) : (
            <CheckCircle size={16} style={{ color: "#51cf66", flexShrink: 0 }} />
          )}
          <span style={{ flex: 1 }}>{t.message}</span>
          {t.action && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                t.action.onClick();
                onDismiss?.(t.id);
              }}
              style={{
                background: "var(--accent, #4dabf7)",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                padding: "4px 10px",
                fontSize: "11px",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {t.action.label}
            </button>
          )}
          {(t.action || !t.action) && (
            <CircleX
              size={14}
              style={{ color: "var(--text-muted)", flexShrink: 0, cursor: "pointer" }}
              onClick={(e) => { e.stopPropagation(); onDismiss?.(t.id); }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
