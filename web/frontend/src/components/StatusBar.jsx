import { Info, Minus, Plus, FlipHorizontal2 } from "lucide-react";
import { version } from "../../package.json";

const GLOW_LEGEND = [
  { label: "Working", color: "var(--cc-working, var(--accent))" },
  { label: "Thinking", color: "var(--cc-thinking, var(--cyan))" },
  { label: "Waiting", color: "var(--cc-waiting, var(--yellow))" },
  { label: "Idle", color: "var(--cc-idle, var(--green))" },
];

const FLIPPABLE = new Set([3, 5, 7]);

export default function StatusBar({
  layout,
  setLayout,
  flipLayout,
  setFlipLayout,
  sessions,
  connected,
  terminalZoom = 13,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  systemStats,
  onShowOnboarding,
}) {
  const runningCount = sessions.filter((s) => s.status === "running").length;
  const flippable = FLIPPABLE.has(layout);

  return (
    <footer
      className="flex items-center justify-between flex-shrink-0"
      style={{
        padding: "0 16px",
        height: 30,
        borderTop: "1px solid var(--cc-border, var(--border-color))",
        color: "var(--cc-muted, var(--text-muted))",
        fontSize: 11,
      }}
    >
      {/* Left cluster */}
      <div className="flex items-center" style={{ gap: 15 }}>
        <span className="flex items-center" style={{ gap: 5, color: connected ? "var(--cc-ok, var(--green))" : "var(--cc-error, var(--red))" }}>
          <span
            style={{
              width: 6, height: 6, borderRadius: 999,
              background: connected ? "var(--cc-ok, var(--green))" : "var(--cc-error, var(--red))",
              boxShadow: connected ? "0 0 6px var(--cc-ok, var(--green))" : "none",
            }}
          />
          {connected ? "Connected" : "Disconnected"}
        </span>
        <span>{sessions.length} session{sessions.length !== 1 ? "s" : ""}</span>
        {runningCount > 0 && (
          <span style={{ color: "var(--cc-ok, var(--green))" }}>{runningCount} running</span>
        )}
        {systemStats && (
          <span>
            CPU {systemStats.cpu_percent}% · {systemStats.ram_used_gb}/{systemStats.ram_total_gb}GB
            {systemStats.gpu_percent !== null && systemStats.gpu_percent !== undefined && (
              <> · GPU {systemStats.gpu_percent}%</>
            )}
          </span>
        )}
        <span style={{ opacity: 0.5 }}>v{version}</span>
      </div>

      {/* Right cluster */}
      <div className="flex items-center" style={{ gap: 12 }}>
        {/* GLOW legend */}
        <div
          className="flex items-center"
          style={{ gap: 9, paddingRight: 12, borderRight: "1px solid var(--cc-border, var(--border-color))" }}
        >
          <span className="cc-label" style={{ fontSize: 9, fontWeight: 700, letterSpacing: ".1em", color: "var(--cc-muted, var(--text-muted))" }}>GLOW</span>
          {GLOW_LEGEND.map((g) => (
            <span key={g.label} className="flex items-center" style={{ gap: 3, fontSize: 10, color: "var(--cc-dim, var(--text-secondary))" }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: g.color }} />
              {g.label}
            </span>
          ))}
        </div>

        {/* Info → Onboarding */}
        <button
          onClick={() => onShowOnboarding?.()}
          title="Getting started"
          className="flex p-1 rounded transition-colors"
          style={{ color: "var(--cc-muted, var(--text-muted))" }}
        >
          <Info size={14} />
        </button>

        {/* Zoom stepper */}
        <div
          className="flex items-center"
          style={{ gap: 2, background: "color-mix(in srgb, var(--cc-surface, var(--bg-surface)) 70%, transparent)", borderRadius: 7, padding: 2 }}
        >
          <button onClick={onZoomOut} title="Zoom out (Ctrl+-)" className="flex" style={{ padding: "3px 5px", color: "var(--cc-muted, var(--text-muted))" }}>
            <Minus size={12} />
          </button>
          <button
            onClick={onZoomReset}
            title="Reset zoom (Ctrl+0)"
            style={{ fontSize: 10, fontWeight: 600, padding: "0 3px", minWidth: 30, textAlign: "center", color: terminalZoom !== 13 ? "var(--cc-accent, var(--accent))" : "var(--cc-dim, var(--text-secondary))" }}
          >
            {terminalZoom}px
          </button>
          <button onClick={onZoomIn} title="Zoom in (Ctrl+=)" className="flex" style={{ padding: "3px 5px", color: "var(--cc-muted, var(--text-muted))" }}>
            <Plus size={12} />
          </button>
        </div>

        {/* Layout switcher 1–8 + Flip */}
        <div className="flex items-center" style={{ gap: 6 }} data-tour="layout-switcher">
          <div
            className="flex items-center"
            style={{ gap: 2, background: "color-mix(in srgb, var(--cc-surface, var(--bg-surface)) 70%, transparent)", borderRadius: 7, padding: 2 }}
          >
            {Array.from({ length: 8 }).map((_, i) => {
              const n = i + 1;
              const on = layout === n;
              return (
                <button
                  key={n}
                  onClick={() => setLayout(n)}
                  title={`${n} pane${n > 1 ? "s" : ""}`}
                  style={{
                    width: 21, height: 22, borderRadius: 5, fontSize: 11, fontWeight: 700,
                    fontFamily: "inherit", cursor: "pointer", border: "none",
                    color: on ? "#0f1216" : "var(--cc-dim, var(--text-secondary))",
                    background: on ? "var(--cc-accent, var(--accent))" : "transparent",
                  }}
                >
                  {n}
                </button>
              );
            })}
          </div>
          <button
            onClick={() => { if (flippable) setFlipLayout?.(!flipLayout); }}
            disabled={!flippable}
            title={flippable ? "Flip featured pane" : "Flip available for 3 / 5 / 7 layouts"}
            className="flex items-center"
            style={{
              padding: 4, borderRadius: 6, border: "none",
              cursor: flippable ? "pointer" : "not-allowed",
              color: flippable ? (flipLayout ? "var(--cc-accent, var(--accent))" : "var(--cc-dim, var(--text-secondary))") : "var(--cc-muted, var(--text-muted))",
              background: flippable && flipLayout ? "color-mix(in srgb, var(--cc-accent, #4ea1e8) 12%, transparent)" : "transparent",
              opacity: flippable ? 1 : 0.5,
            }}
          >
            <FlipHorizontal2 size={14} />
          </button>
        </div>
      </div>
    </footer>
  );
}
