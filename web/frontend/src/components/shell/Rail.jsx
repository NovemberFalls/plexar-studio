import { LayoutGrid, FolderOpen, List, Cpu, ChartColumn, Settings, MessageSquare } from "lucide-react";
import { LogoMark } from "../ActivityRail";

const SECTIONS = [
  // Chat sits ABOVE Work deliberately: it is the surface you arrive at to ask
  // something, where Work is the surface you go to in order to run something.
  { id: "chat", label: "CHAT", icon: MessageSquare },
  { id: "work", label: "WORK", icon: LayoutGrid },
  { id: "projects", label: "PROJECTS", icon: FolderOpen },
  { id: "fleet", label: "FLEET", icon: List },
  { id: "engine", label: "ENGINE", icon: Cpu },
  { id: "reports", label: "REPORTS", icon: ChartColumn },
];

const ENGINE_STATUS_COLOR = {
  serving: "var(--cc-ok)",
  pressure: "var(--cc-waiting)",
  down: "var(--cc-error)",
};

/** Single rail item: 52px wide, icon above an 8px/800 label. */
function RailItem({ id, label, icon: Icon, active, onClick, statusDot }) {
  return (
    <button
      onClick={() => onClick(id)}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className="hover-bg-elevated"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        width: 52,
        padding: "7px 0",
        borderRadius: 9,
        cursor: "pointer",
        fontFamily: "inherit",
        background: active
          ? "color-mix(in srgb, var(--cc-accent) 14%, transparent)"
          : "transparent",
        border: active
          ? "1px solid color-mix(in srgb, var(--cc-accent) 32%, transparent)"
          : "1px solid transparent",
        color: active ? "var(--cc-accent)" : "var(--cc-muted)",
      }}
    >
      <Icon size={16} strokeWidth={2} />
      <span style={{ fontSize: 8, fontWeight: 800, letterSpacing: ".06em" }}>{label}</span>
      {statusDot && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: 5,
            right: 7,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: statusDot,
            boxShadow: "0 0 6px currentColor",
            color: statusDot,
          }}
        />
      )}
    </button>
  );
}

/**
 * 64px vertical shell rail: logo, primary section nav, settings pinned to
 * the bottom, and a user avatar. Presentational only — all state and
 * navigation live in the parent (App.jsx).
 */
export default function Rail({ activeSection, onSelectSection, engineStatus, user, projectsDrawerOpen = false }) {
  const initial = user?.name ? user.name.trim().charAt(0).toUpperCase() || "?" : "?";
  // PROJECTS is a DRAWER toggle, not a destination — it overlays Workspace
  // rather than replacing the content area, so `activeSection` never becomes
  // "projects". Its lit state tracks the drawer instead, which is why it cannot
  // just fall out of the activeSection comparison below. Two items can therefore
  // be lit at once (e.g. WORK + PROJECTS), and that is correct: you are in
  // Workspace with the tree open.
  const isActive = (id) => (id === "projects" ? Boolean(projectsDrawerOpen) : activeSection === id);

  return (
    <div
      style={{
        width: 64,
        flexShrink: 0,
        background: "var(--cc-bg2)",
        borderRight: "1px solid var(--cc-border)",
        padding: "10px 0",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: "linear-gradient(140deg,#2a2f2a,#131311)",
          border: "1px solid color-mix(in srgb, var(--cc-accent) 35%, transparent)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <LogoMark size={16} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
        {SECTIONS.map((s) => (
          <RailItem
            key={s.id}
            id={s.id}
            label={s.label}
            icon={s.icon}
            active={isActive(s.id)}
            onClick={onSelectSection}
            statusDot={s.id === "engine" && engineStatus ? ENGINE_STATUS_COLOR[engineStatus] : null}
          />
        ))}
      </div>

      <div style={{ flex: 1 }} />

      <RailItem
        id="settings"
        label="SETTINGS"
        icon={Settings}
        active={activeSection === "settings"}
        onClick={onSelectSection}
      />

      <div
        title={user?.name || "No user"}
        aria-label={user?.name ? `Signed in as ${user.name}` : "No user signed in"}
        style={{
          width: 26,
          height: 26,
          borderRadius: 999,
          background: "var(--cc-elev)",
          border: "1px solid var(--cc-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 700,
          color: "var(--cc-fg)",
          flexShrink: 0,
        }}
      >
        {initial}
      </div>
    </div>
  );
}
