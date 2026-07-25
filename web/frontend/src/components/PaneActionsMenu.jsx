import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { Pencil, PackageMinus, Eraser, Download, Cpu, Zap, ChevronRight, ChevronDown } from "lucide-react";
import { useModelCatalog, isOpusModel } from "../modelCatalog";

const BUSY_TITLE = "Session is busy — try again when it's idle.";

/** A single row in the popover — icon + label, disabled state with title tooltip. */
const MenuButton = forwardRef(function MenuButton(
  { icon: Icon, label, onClick, disabled, title, danger },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title}
      onClick={onClick}
      className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors hover-bg-surface"
      style={{
        color: disabled ? "var(--text-muted)" : danger ? "var(--red)" : "var(--text-secondary)",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
        background: "none",
        border: "none",
      }}
    >
      {Icon && <Icon size={12} style={{ flexShrink: 0 }} />}
      {label}
    </button>
  );
});

/**
 * PaneActionsMenu — "More actions" popover for a terminal pane header.
 *
 * Renders: Rename…, Compact context, Clear conversation… (two-step confirm),
 * Export transcript, a Model submenu (reuses TopBar's MODEL_GROUPS constant —
 * see CLAUDE.md conventions: never hardcode a second model list), and Fast mode.
 *
 * Command-injecting rows (Compact / Clear / Model / Fast) POST through
 * /api/terminals/{id}/command, which the backend 409s with
 * {"ok": false, "error": "Session is busy"} while the session is generating.
 * Those rows are pre-emptively disabled via the `busy` prop AND handle the
 * 409 defensively (race between render and click) by surfacing a Toast.
 *
 * Rename and Export are NOT gated on `busy` — neither injects a command into
 * the session's input stream (PATCH rename / GET export), so there is no
 * 409 busy-path for either on the backend contract.
 *
 * Props:
 *   session        — { terminalId, name, model }
 *   busy           — boolean, true while the session is actively generating
 *   toast          — (msg, type) => void
 *   onClose        — () => void, called on outside click / Escape / after an action
 *   onStartRename  — () => void, tells the parent pane to switch its header
 *                     name into an inline rename input
 */
export default function PaneActionsMenu({ session, busy, toast, onClose, onStartRename }) {
  const menuRef = useRef(null);
  const firstItemRef = useRef(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);

  // Focus management: first item gets focus when the popover opens.
  useEffect(() => {
    firstItemRef.current?.focus();
  }, []);

  // Escape closes; outside mousedown closes (matches BridgeModal / LocationContextMenu pattern)
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    const handleClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  const sendCommand = useCallback(
    async (command) => {
      if (!session.terminalId) return false;
      try {
        const res = await fetch(`/api/terminals/${session.terminalId}/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 409) {
          toast?.(BUSY_TITLE, "error");
          return false;
        }
        if (!res.ok || data.ok === false) {
          toast?.(data.error || "Command failed", "error");
          return false;
        }
        return true;
      } catch (err) {
        toast?.(`Command failed: ${err.message}`, "error");
        return false;
      }
    },
    [session.terminalId, toast]
  );

  const { groups: modelGroups } = useModelCatalog();
  const currentModel = modelGroups.flatMap((g) => g.models).find((m) => m.id === session.model);
  const fastEligible = isOpusModel(session.model);

  // In-session /model switching can only change the model within the current
  // session's provider — it cannot move a running Claude Code process from
  // Anthropic to OpenRouter (or vice versa). That requires spawning a new
  // terminal via TopBar/NewSessionDialog instead, so OpenRouter groups are
  // filtered out of this submenu entirely.
  const switchableModelGroups = modelGroups.filter((g) => g.provider !== "openrouter");

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div
        ref={menuRef}
        role="menu"
        aria-label="Session actions"
        style={{
          position: "absolute",
          right: 0,
          top: "calc(100% + 4px)",
          zIndex: 50,
          minWidth: 220,
          maxWidth: 280,
          backgroundColor: "var(--bg-elevated)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          padding: "4px 0",
        }}
      >
        <MenuButton
          ref={firstItemRef}
          icon={Pencil}
          label="Rename…"
          onClick={() => {
            onStartRename();
            onClose();
          }}
        />

        <MenuButton
          icon={PackageMinus}
          label="Compact context"
          disabled={busy}
          title={busy ? BUSY_TITLE : "Compact conversation context (/compact)"}
          onClick={async () => {
            const ok = await sendCommand("/compact");
            if (ok) toast?.("Compacting context…", "info");
            onClose();
          }}
        />

        {!clearConfirm ? (
          <MenuButton
            icon={Eraser}
            label="Clear conversation…"
            disabled={busy}
            danger
            title={busy ? BUSY_TITLE : "Clear all conversation context (/clear)"}
            onClick={() => setClearConfirm(true)}
          />
        ) : (
          <div className="flex items-center gap-1.5 px-3 py-1.5" role="menuitem">
            <span className="text-xs flex-1" style={{ color: "var(--red)" }}>
              Clear all context?
            </span>
            <button
              type="button"
              className="text-[11px] font-semibold px-2 py-0.5 rounded transition-colors hover-bg-surface"
              style={{ color: "var(--red)", border: "1px solid var(--red)" }}
              onClick={async () => {
                const ok = await sendCommand("/clear");
                setClearConfirm(false);
                if (ok) toast?.("Conversation cleared", "success");
                onClose();
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              className="text-[11px] px-2 py-0.5 rounded transition-colors hover-bg-surface"
              style={{ color: "var(--text-muted)" }}
              onClick={() => setClearConfirm(false)}
            >
              Cancel
            </button>
          </div>
        )}

        {/* Plain <a href download> — same-origin navigation works in both the
            browser dev server and the Tauri webview; no fetch/blob needed. */}
        <a
          role="menuitem"
          href={session.terminalId ? `/api/terminals/${session.terminalId}/export` : undefined}
          download
          onClick={(e) => {
            if (!session.terminalId) e.preventDefault();
            onClose();
          }}
          className="flex items-center gap-2 w-full text-left px-3 py-1.5 text-xs transition-colors hover-bg-surface"
          style={{ color: "var(--text-secondary)", textDecoration: "none" }}
        >
          <Download size={12} style={{ flexShrink: 0 }} />
          Export transcript
        </a>

        <div style={{ height: 1, backgroundColor: "var(--border-color)", margin: "4px 0" }} />

        <button
          type="button"
          role="menuitem"
          aria-expanded={modelOpen}
          aria-label={`Model: ${currentModel?.label || session.model}`}
          onClick={() => setModelOpen((v) => !v)}
          className="flex items-center justify-between w-full text-left px-3 py-1.5 text-xs transition-colors hover-bg-surface"
          style={{ color: "var(--text-secondary)", background: "none", border: "none" }}
        >
          <span className="flex items-center gap-2">
            <Cpu size={12} style={{ flexShrink: 0 }} />
            Model: {currentModel?.label || session.model}
          </span>
          {modelOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {modelOpen && (
          <div role="group" aria-label="Select model" style={{ maxHeight: 180, overflowY: "auto" }}>
            {switchableModelGroups.map((group) => (
              <div key={group.label}>
                <div
                  className="text-[9px] uppercase tracking-wider px-4 pt-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  {group.label}
                </div>
                {group.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={m.id === session.model}
                    disabled={busy}
                    title={busy ? BUSY_TITLE : undefined}
                    onClick={async () => {
                      const ok = await sendCommand(`/model ${m.id}`);
                      if (ok) toast?.(`Model set to ${m.label}`, "success");
                      setModelOpen(false);
                      onClose();
                    }}
                    className="block w-full text-left px-4 py-1 text-xs transition-colors hover-bg-surface"
                    style={{
                      color: m.id === session.model ? "var(--accent)" : "var(--text-secondary)",
                      fontWeight: m.id === session.model ? 600 : 400,
                      opacity: busy ? 0.5 : 1,
                      cursor: busy ? "not-allowed" : "pointer",
                      background: "none",
                      border: "none",
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        <MenuButton
          icon={Zap}
          label="Fast mode"
          disabled={busy || !fastEligible}
          title={
            !fastEligible
              ? "Fast mode is only available for Opus models"
              : busy
                ? BUSY_TITLE
                : "Toggle fast mode (/fast)"
          }
          onClick={async () => {
            const ok = await sendCommand("/fast");
            if (ok) toast?.("Fast mode toggled", "info");
            onClose();
          }}
        />
      </div>
    </>
  );
}
