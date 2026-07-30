import { Minus, Plus, FlipHorizontal2 } from "lucide-react";

function fmt(value, suffix = "") {
  return value === null || value === undefined ? "—" : `${value}${suffix}`;
}

function LayoutCell({ n, active, onClick }) {
  return (
    <button
      onClick={() => onClick(n)}
      title={`${n} pane${n > 1 ? "s" : ""}`}
      aria-label={`${n} pane${n > 1 ? "s" : ""}`}
      aria-pressed={active}
      className="hover-bg-elevated"
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        fontSize: 9,
        fontWeight: 700,
        fontFamily: "inherit",
        cursor: "pointer",
        border: "none",
        lineHeight: "16px",
        padding: 0,
        color: active ? "#0f1216" : "var(--cc-dim, var(--text-secondary))",
        background: active ? "var(--cc-accent, var(--accent))" : "transparent",
      }}
    >
      {n}
    </button>
  );
}

export default function StatusStrip({
  connected,
  brokerLabel,
  cliVersion,
  appVersion,
  systemStats,
  bridgeCount = 0,
  todayTokens,
  todayCost,
  zoom,
  onZoomIn,
  onZoomOut,
  layout,
  onLayoutChange,
  onFlip,
}) {
  const cpu = systemStats?.cpu ?? null;
  const ramUsed = systemStats?.ramUsed ?? null;
  const ramTotal = systemStats?.ramTotal ?? null;
  const gpu = systemStats?.gpu ?? null;
  const vramUsed = systemStats?.vramUsed ?? null;
  const vramTotal = systemStats?.vramTotal ?? null;

  const ramLabel = ramUsed !== null && ramTotal !== null ? `${ramUsed}/${ramTotal}GB` : "—";
  const gpuLabel = gpu === null || gpu === undefined ? "—" : `${gpu}%${vramUsed !== null && vramTotal !== null ? ` (${vramUsed}/${vramTotal}GB)` : ""}`;

  return (
    <footer
      className="flex items-center justify-between flex-shrink-0"
      style={{
        height: 24,
        padding: "0 12px",
        fontSize: 10,
        color: "var(--cc-muted)",
        background: "var(--cc-bg2)",
        borderTop: "1px solid var(--cc-border)",
      }}
    >
      {/* Left cluster */}
      <div className="flex items-center" style={{ gap: 10 }}>
        <span className="flex items-center" style={{ gap: 5 }}>
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 999,
              background: connected ? "var(--cc-ok, var(--green))" : "var(--cc-error)",
              boxShadow: connected ? "0 0 6px var(--cc-ok, var(--green))" : "none",
            }}
          />
          <span>
            {brokerLabel || "Broker"} · CLI {fmt(cliVersion)} · v{fmt(appVersion)}
          </span>
        </span>
        <span>CPU {fmt(cpu, "%")}</span>
        <span>RAM {ramLabel}</span>
        <span>GPU {gpuLabel}</span>
        {bridgeCount > 0 && (
          <span style={{ color: "#ff5577" }}>
            {bridgeCount} bridge active
          </span>
        )}
      </div>

      {/* Right cluster */}
      <div className="flex items-center" style={{ gap: 10 }}>
        <span>
          {fmt(todayTokens)} tok · {todayCost === null || todayCost === undefined ? "—" : `$${todayCost.toFixed(2)}`}
        </span>

        {/* Zoom stepper */}
        <div className="flex items-center" style={{ gap: 2 }}>
          <button
            onClick={onZoomOut}
            title="Zoom out"
            aria-label="Zoom out"
            className="flex hover-bg-elevated"
            style={{ padding: 2, color: "var(--cc-muted)", border: "none", background: "transparent" }}
          >
            <Minus size={11} />
          </button>
          {/* px, NOT % — `zoom` is the terminal FONT SIZE (App's terminalZoom),
              which is why the zoom toast renders the same value as "<n>px". */}
          <span style={{ minWidth: 28, textAlign: "center" }}>{fmt(zoom, "px")}</span>
          <button
            onClick={onZoomIn}
            title="Zoom in"
            aria-label="Zoom in"
            className="flex hover-bg-elevated"
            style={{ padding: 2, color: "var(--cc-muted)", border: "none", background: "transparent" }}
          >
            <Plus size={11} />
          </button>
        </div>

        {/* Layout switcher */}
        <div className="flex items-center" style={{ gap: 2 }}>
          {Array.from({ length: 8 }).map((_, i) => {
            const n = i + 1;
            return (
              <LayoutCell key={n} n={n} active={layout === n} onClick={onLayoutChange} />
            );
          })}
        </div>

        <button
          onClick={onFlip}
          title="Flip featured pane"
          aria-label="Flip featured pane"
          className="flex hover-bg-elevated"
          style={{ padding: 2, color: "var(--cc-muted)", border: "none", background: "transparent" }}
        >
          <FlipHorizontal2 size={11} />
        </button>
      </div>
    </footer>
  );
}
