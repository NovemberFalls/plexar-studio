import { Plus, X, FolderOpen, ChevronRight, ChevronDown, GitBranch, ShieldOff, Save, Trash2, Play, LifeBuoy, Search, Monitor } from "lucide-react";
import OrchestratorsList from "./OrchestratorsList";
import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { groupWorkers } from "../subsessions.js";
import { describePeerStatus, peerDragData, peersApi } from "../utils/peers";

/** Open a URL in the system's default browser (Tauri-safe), falling back to a new tab. */
function openExternal(url) {
  fetch("/api/open-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) })
    .catch(() => window.open(url, "_blank"));
}

/** Normalize path separators to backslash for comparison */
function norm(dir) {
  return dir.replace(/\//g, "\\").replace(/\\$/, "");
}

/** Get the last segment of a path */
function shortPath(dir) {
  if (!dir) return "";
  const parts = norm(dir).split("\\").filter(Boolean);
  return parts[parts.length - 1] || dir;
}

/** Map a session's activity state/status to a --cc-* state color token */
const STATE_COLOR = {
  busy: "var(--cc-working)",
  working: "var(--cc-working)",
  thinking: "var(--cc-thinking)",
  waiting: "var(--cc-waiting)",
  idle: "var(--cc-idle)",
  running: "var(--cc-idle)",
  error: "var(--cc-error)",
  starting: "var(--cc-muted)",
  history: "var(--cc-muted)",
};
function getStateColor(state) {
  return STATE_COLOR[state] || STATE_COLOR.idle;
}
function isPulseState(state) {
  return state === "busy" || state === "working" || state === "thinking";
}

/**
 * Build a location tree from a flat list of location objects.
 * Each node: { path, name, bypassPermissions, children: [] }
 */
function buildLocationTree(locations) {
  const sorted = [...locations].sort((a, b) => norm(a.path).localeCompare(norm(b.path)));
  const roots = [];
  const nodes = new Map();

  for (const loc of sorted) {
    const n = norm(loc.path);
    const node = { path: loc.path, name: shortPath(loc.path), bypassPermissions: loc.bypassPermissions || false, children: [] };
    nodes.set(n, node);

    let placed = false;
    const parts = n.split("\\");
    for (let i = parts.length - 1; i > 0; i--) {
      const parentPath = parts.slice(0, i).join("\\");
      if (nodes.has(parentPath)) {
        nodes.get(parentPath).children.push(node);
        placed = true;
        break;
      }
    }
    if (!placed) roots.push(node);
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Context menu for location nodes
// ---------------------------------------------------------------------------

function LocationContextMenu({ x, y, path, isBypass, onExpand, onNewAt, onRemove, onToggleBypass, onClose }) {
  const menuRef = useCallback((el) => {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (x + rect.width > window.innerWidth) el.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (y + rect.height > window.innerHeight) el.style.top = `${window.innerHeight - rect.height - 4}px`;
  }, [x, y]);

  useEffect(() => {
    const handler = (e) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target)
      ) onClose();
    };
    const handleKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, menuRef]);

  const itemStyle = {
    padding: "6px 12px",
    fontSize: "12px",
    cursor: "pointer",
    color: "var(--cc-dim)",
    whiteSpace: "nowrap",
  };

  return (
    <div
      ref={menuRef}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 1000,
        backgroundColor: "var(--cc-surface)",
        border: "1px solid var(--cc-border)",
        borderRadius: "8px",
        padding: "4px 0",
        boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
        minWidth: "150px",
        fontFamily: "inherit",
      }}
    >
      <div
        style={itemStyle}
        className="hover-bg-elevated"
        onClick={() => { navigator.clipboard.writeText(path); onClose(); }}
      >
        Copy path
      </div>
      <div
        style={itemStyle}
        className="hover-bg-elevated"
        onClick={() => { onExpand(path); onClose(); }}
      >
        Expand 1 layer
      </div>
      <div
        style={itemStyle}
        className="hover-bg-elevated"
        onClick={() => { onNewAt(path); onClose(); }}
      >
        Open session here
      </div>
      <div
        style={{ ...itemStyle, color: isBypass ? "var(--cc-waiting)" : "var(--cc-dim)" }}
        className="hover-bg-elevated"
        onClick={() => { onToggleBypass(path); onClose(); }}
      >
        {isBypass ? "Disable bypass" : "Enable bypass"}
      </div>
      <div
        style={{ height: "1px", backgroundColor: "var(--cc-border)", margin: "4px 0" }}
      />
      <div
        style={{ ...itemStyle, color: "var(--cc-error)" }}
        className="hover-bg-elevated"
        onClick={() => { onRemove(path); onClose(); }}
      >
        Remove
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session list components
// ---------------------------------------------------------------------------

function SessionItem({ session, isActive, onSelect, onDelete }) {
  const state = session.activityState || session.status;
  const color = getStateColor(state);
  const pulsing = isPulseState(state);

  return (
    <div
      className="group flex items-center"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `session:${session.id}`);
      }}
      style={{
        height: "24px",
        borderRadius: "6px",
        backgroundColor: isActive ? "color-mix(in srgb, var(--cc-accent) 10%, transparent)" : "transparent",
        borderLeft: isActive ? "2px solid var(--cc-accent)" : "2px solid transparent",
      }}
    >
      <button
        onClick={() => onSelect(session.id)}
        className={`flex items-center gap-1.5 flex-1 text-left h-full min-w-0 ${!isActive ? "hover-bg-surface" : ""}`}
        style={{
          paddingLeft: "6px",
          paddingRight: "4px",
          borderRadius: "6px",
        }}
      >
        <span
          data-glowdot
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "999px",
            backgroundColor: color,
            boxShadow: `0 0 6px ${color}`,
            flexShrink: 0,
            animation: pulsing ? "cc-pulse 1.5s infinite" : "none",
          }}
        />
        <span
          className="text-xs truncate flex-1"
          style={{ color: isActive ? "var(--cc-fg)" : "var(--cc-dim)", fontWeight: isActive ? 700 : 400 }}
        >
          {session.name}
        </span>
        {session.fromPhone && (
          <span className="text-[9px] flex-shrink-0" style={{ color: "var(--cc-muted)" }} title="Started from the phone">phone</span>
        )}
        {session.harness === "shell" && (
          <span className="text-[9px] flex-shrink-0" style={{ color: "var(--cc-muted)" }} title="Shell worker">sh</span>
        )}
        {session.bypassPermissions && (
          <ShieldOff
            size={10}
            style={{ color: "var(--cc-waiting)", flexShrink: 0 }}
            title="Permissions bypassed"
          />
        )}
        {session.tokensPerSec > 0 && (
          <span className="text-[9px] flex-shrink-0" style={{ color: "var(--cc-fn)" }}>
            {Math.round(session.tokensPerSec)}t/s
          </span>
        )}
      </button>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(session.id); }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded transition-all flex-shrink-0 mr-1 hover-color-red"
        style={{ color: "var(--cc-muted)" }}
        title="Close session"
      >
        <X size={12} />
      </button>
    </div>
  );
}

/** A session row plus the workers its agent spawned (agent_api.py), nested one
 *  level under it. Module-scope like SessionItem (see CLAUDE.md conventions). The
 *  collapsed row still says how many workers exist and whether one needs attention,
 *  so folding the list never hides a blocked worker. */
/** One of Claude Code's IN-PROCESS subagents (Agent tool), read-only. It has no
 *  terminal, so it is never a pane: the row shows what it is doing and a click shows its
 *  latest text (its report once done). Data: GET /api/subagents (subagent_watch.py). */
function AgentRow({ agent, terminalId, loadReport = null }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(null);
  const color = agent.status === "running" ? "var(--cc-accent)"
    : agent.status === "done" ? "var(--cc-success, #3fb950)" : "var(--cc-muted)";
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        // A machine's agent loads its report through the peer proxy; the local one is unchanged.
        let d;
        if (loadReport) {
          d = await loadReport(agent);
        } else {
          const r = await fetch(`/api/terminals/${terminalId}/subagents/${agent.id}`);
          d = r.ok ? await r.json() : null;
        }
        setText(d?.text || "(no text yet)");
      } catch {
        setText("(could not read this agent)");
      }
    }
  };
  return (
    <div data-testid="agent-row">
      <button
        onClick={toggle}
        className="flex items-center gap-1.5 w-full text-left hover-bg-surface"
        style={{ height: "22px", paddingLeft: "6px", borderRadius: "6px" }}
        title={`${agent.description}\n${agent.agent_type}${agent.model ? ` · ${agent.model}` : ""} · ${agent.status} (Claude Code agent, read-only)`}
        aria-expanded={open}
      >
        <span
          style={{ width: "6px", height: "6px", borderRadius: "999px", backgroundColor: color, flexShrink: 0,
                   animation: agent.status === "running" ? "cc-pulse 1.5s infinite" : "none" }}
        />
        <span className="text-[11px] truncate flex-1" style={{ color: "var(--cc-dim)" }}>{agent.description || agent.agent_type}</span>
        {agent.model && <span className="text-[9px] flex-shrink-0 mr-1" style={{ color: "var(--cc-muted)" }}>{agent.model}</span>}
      </button>
      {open && (
        <div
          className="text-[10px]"
          style={{ margin: "2px 4px 4px 14px", padding: "4px 6px", whiteSpace: "pre-wrap", maxHeight: "160px",
                   overflowY: "auto", color: "var(--cc-dim)", border: "1px solid var(--cc-border)", borderRadius: "6px" }}
        >
          {text ?? "Loading…"}
        </div>
      )}
    </div>
  );
}

function SessionWithWorkers({ session, workers = [], agents = [], activeIds, onSelect, onDelete }) {
  const [open, setOpen] = useState(true);
  if (workers.length === 0 && agents.length === 0) {
    return <SessionItem session={session} isActive={activeIds.includes(session.id)} onSelect={onSelect} onDelete={onDelete} />;
  }
  const waiting = workers.filter((w) => (w.activityState || w.status) === "waiting").length;
  const busy = workers.filter((w) => (w.activityState || w.status) === "busy").length;
  const agentsRunning = agents.filter((a) => a.status === "running").length;
  return (
    <div data-testid="session-with-workers">
      <div className="flex items-center">
        <button
          onClick={() => setOpen(!open)}
          className="p-0.5 flex-shrink-0"
          style={{ color: "var(--cc-muted)", marginLeft: "-14px" }}
          aria-label={open ? "Collapse workers" : "Expand workers"}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        </button>
        <div className="flex-1 min-w-0">
          <SessionItem session={session} isActive={activeIds.includes(session.id)} onSelect={onSelect} onDelete={onDelete} />
        </div>
        <span
          className="text-[9px] flex-shrink-0 mr-1"
          style={{ color: waiting ? "var(--cc-waiting)" : "var(--cc-muted)" }}
          title={`${workers.length} worker${workers.length === 1 ? "" : "s"}: ${busy} working, ${waiting} waiting on you`
            + (agents.length ? ` · ${agents.length} Claude agent${agents.length === 1 ? "" : "s"}, ${agentsRunning} running` : "")}
        >
          {waiting ? `${waiting}!` : ""}{workers.length ? `${workers.length}w` : ""}
          {agents.length ? `${workers.length ? " " : ""}${agentsRunning}/${agents.length}a` : ""}
        </span>
      </div>
      {open && (
        <div
          data-testid="worker-list"
          style={{ marginLeft: "8px", paddingLeft: "6px", borderLeft: "1px solid var(--cc-border)",
                   display: "flex", flexDirection: "column", gap: "1px" }}
        >
          {workers.map((w) => (
            <SessionItem key={w.id} session={w} isActive={activeIds.includes(w.id)} onSelect={onSelect} onDelete={onDelete} />
          ))}
          {agents.map((a) => (
            <AgentRow key={a.id} agent={a} terminalId={session.terminalId} />
          ))}
        </div>
      )}
    </div>
  );
}

function LocationNode({ node, depth = 0, sessionsByDir, workersOf = {}, agentsOf = {}, activeIds, onSelect, onDelete, gitStatuses, onNewAt, onContextMenu, onFocusFolder, visibleFolder }) {
  const sessionsHere = sessionsByDir[norm(node.path)] || [];
  const hasChildren = node.children.length > 0 || sessionsHere.length > 0;
  const [expanded, setExpanded] = useState(true);

  const git = gitStatuses[norm(node.path)];

  return (
    <div>
      <div
        className="group flex items-center gap-1 cursor-pointer rounded-md transition-colors hover-bg-surface"
        style={{
          height: "23px",
          color: "var(--cc-dim)",
          paddingLeft: `${depth * 12 + 6}px`,
          paddingRight: "6px",
          background: visibleFolder === norm(node.path) ? "color-mix(in srgb, var(--cc-accent) 14%, transparent)" : undefined,
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, node.path);
        }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
            className="p-0.5 flex-shrink-0"
            style={{ color: "var(--cc-muted)" }}
          >
            {expanded
              ? <ChevronDown size={10} />
              : <ChevronRight size={10} />
            }
          </button>
        ) : (
          <span className="w-[15px] flex-shrink-0" />
        )}

        <button
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
          onClick={() => {
            // In scroll mode a folder click means "take me to those panes".
            // onFocusFolder returns false when it did nothing (grid mode, or no
            // sessions in this folder) -- then fall back to expand/collapse, so
            // the control never feels dead.
            if (sessionsHere.length && onFocusFolder?.(node.path)) return;
            setExpanded(!expanded);
          }}
          onDoubleClick={() => onNewAt(node.path)}
          title={node.path}
          aria-current={visibleFolder === norm(node.path) ? "location" : undefined}
        >
          <FolderOpen size={12} style={{ color: "var(--cc-accent)", flexShrink: 0 }} />
          <span className="text-xs truncate" style={{ color: "var(--cc-fg)", fontWeight: 700 }}>{node.name}</span>
          {node.bypassPermissions && (
            <ShieldOff size={10} style={{ color: "var(--cc-waiting)", flexShrink: 0 }} title="Bypass permissions enabled" />
          )}
        </button>

        {git?.git && (
          <span
            className="flex items-center gap-0.5 flex-shrink-0"
            title={`${git.branch}${git.dirty ? ` (${git.files_changed} changed)` : ""}`}
          >
            <GitBranch size={9} style={{ color: "var(--cc-muted)" }} />
            <span className="text-[8px]" style={{ color: "var(--cc-muted)" }}>
              {git.branch.length > 12 ? git.branch.slice(0, 12) + "…" : git.branch}
            </span>
            {git.dirty && (
              <span
                className="w-[5px] h-[5px] rounded-full flex-shrink-0"
                style={{ backgroundColor: "var(--cc-waiting)" }}
              />
            )}
          </span>
        )}

        {sessionsHere.length > 0 && (
          <span
            className="text-[9px] flex-shrink-0"
            style={{ color: "var(--cc-muted)" }}
          >
            {sessionsHere.length}
          </span>
        )}

        <Plus
          size={13}
          className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 cursor-pointer"
          style={{ color: "var(--cc-accent)" }}
          onClick={(e) => { e.stopPropagation(); onNewAt(node.path); }}
        />
      </div>

      {expanded && (
        <>
          {sessionsHere.length > 0 && (
            <div style={{ paddingLeft: `${depth * 12 + 20}px`, display: "flex", flexDirection: "column", gap: "1px" }}>
              {sessionsHere.map((s) => (
                <SessionWithWorkers key={s.id} session={s} workers={workersOf[s.terminalId]} agents={agentsOf[s.terminalId]} activeIds={activeIds} onSelect={onSelect} onDelete={onDelete} />
              ))}
            </div>
          )}
          {node.children.map((child) => (
            <LocationNode key={child.path} node={child} depth={depth + 1} sessionsByDir={sessionsByDir} workersOf={workersOf} agentsOf={agentsOf} activeIds={activeIds} onSelect={onSelect} onDelete={onDelete} gitStatuses={gitStatuses} onNewAt={onNewAt} onContextMenu={onContextMenu} onFocusFolder={onFocusFolder} visibleFolder={visibleFolder} />
          ))}
        </>
      )}
    </div>
  );
}

/** One session on another machine. Module-scope like SessionItem; a click or a
 *  drag places it in the grid exactly like a local row. The End control sits
 *  beside the row (a button cannot nest in a button): the first click asks, the
 *  second ends; leaving the row, losing focus or Escape cancels. */
function PeerSessionItem({ peerId, remote, isActive, onSelect, onEnd }) {
  const [confirming, setConfirming] = useState(false);
  // The confirm appears where the first click landed, so a double-click must
  // not count as both: it only acts a moment after it was shown.
  const armedAt = useRef(0);
  const state = remote.activity_state || (remote.alive === false ? "error" : "idle");
  const color = getStateColor(state);
  return (
    <div
      className="group flex items-center"
      onMouseLeave={() => setConfirming(false)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setConfirming(false); }}
      onKeyDown={(e) => { if (e.key === "Escape" && confirming) { e.stopPropagation(); setConfirming(false); } }}
    >
      <button
        data-testid="peer-session-row"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", peerDragData(peerId, remote.id));
        }}
        onClick={() => onSelect(peerId, remote)}
        className={`flex items-center gap-1.5 flex-1 min-w-0 text-left ${!isActive ? "hover-bg-surface" : ""}`}
        title={remote.working_dir || remote.name}
        style={{
          height: "24px",
          paddingLeft: "6px",
          borderRadius: "6px",
          backgroundColor: isActive ? "color-mix(in srgb, var(--cc-accent) 10%, transparent)" : "transparent",
          borderLeft: isActive ? "2px solid var(--cc-accent)" : "2px solid transparent",
        }}
      >
        <span
          data-glowdot
          style={{
            width: "6px", height: "6px", borderRadius: "999px", backgroundColor: color, boxShadow: `0 0 6px ${color}`,
            flexShrink: 0, animation: isPulseState(state) ? "cc-pulse 1.5s infinite" : "none",
          }}
        />
        <span className="text-xs truncate flex-1" style={{ color: isActive ? "var(--cc-fg)" : "var(--cc-dim)", fontWeight: isActive ? 700 : 400 }}>
          {remote.name || remote.id}
        </span>
        {remote.working_dir && (
          <span className="text-[9px] truncate flex-shrink-0 mr-1" style={{ color: "var(--cc-muted)", maxWidth: "40%" }}>
            {shortPath(remote.working_dir)}
          </span>
        )}
      </button>
      {onEnd && (confirming ? (
        <button
          data-testid="peer-session-end-confirm"
          autoFocus
          onClick={(e) => {
            e.stopPropagation();
            if (Date.now() - armedAt.current < 500) return;
            setConfirming(false);
            onEnd(peerId, remote);
          }}
          className="text-[10px] px-1.5 rounded flex-shrink-0 mr-1 hover-color-red"
          style={{ color: "var(--cc-error)", border: "1px solid var(--cc-border)", height: "18px" }}
          title="End this session on the other machine"
        >
          End?
        </button>
      ) : (
        <button
          data-testid="peer-session-end"
          onClick={(e) => { e.stopPropagation(); armedAt.current = Date.now(); setConfirming(true); }}
          className="opacity-0 group-hover:opacity-100 focus:opacity-100 p-1 rounded transition-all flex-shrink-0 mr-1 hover-color-red"
          style={{ color: "var(--cc-muted)" }}
          title="End session on the other machine"
          aria-label="End session on the other machine"
        >
          <X size={12} />
        </button>
      ))}
    </div>
  );
}

/** A peer session row with its nested workers and its read-only Claude agents. */
function PeerSessionBranch({ peerId, remote, workers, agents, activeKeys, onSelect, onEnd }) {
  const loadReport = (sessionId) => async (a) => {
    const r = await peersApi.subagentReport(peerId, sessionId, a.id);
    return r.ok ? r.data : null;
  };
  const nested = (r) => {
    const list = agents?.[r.id] || [];
    return list.length > 0 && (
      <div style={{ marginLeft: "8px", paddingLeft: "6px", borderLeft: "1px solid var(--cc-border)" }}>
        {list.map((a) => <AgentRow key={a.id} agent={a} loadReport={loadReport(r.id)} />)}
      </div>
    );
  };
  return (
    <div>
      <PeerSessionItem peerId={peerId} remote={remote} isActive={activeKeys.has(`${peerId}/${remote.id}`)} onSelect={onSelect} onEnd={onEnd} />
      {nested(remote)}
      {workers.length > 0 && (
        <div data-testid="peer-worker-list" style={{ marginLeft: "8px", paddingLeft: "6px", borderLeft: "1px solid var(--cc-border)", display: "flex", flexDirection: "column", gap: "1px" }}>
          {workers.map((w) => (
            <div key={w.id}>
              <PeerSessionItem peerId={peerId} remote={w} isActive={activeKeys.has(`${peerId}/${w.id}`)} onSelect={onSelect} onEnd={onEnd} />
              {nested(w)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A paired machine's group. An error renders its reason and remedy, never an
 *  empty list that would read as "no sessions there". */
function PeerGroup({ peer, activeKeys, filter, onSelect, onNewSession, onEnd }) {
  const [expanded, setExpanded] = useState(true);
  const d = describePeerStatus(peer.status);
  const failed = peer.status && !d.ok;
  const visible = (peer.sessions || []).filter((r) => r.alive !== false
    && (!filter || (r.name || "").toLowerCase().includes(filter) || (r.working_dir || "").toLowerCase().includes(filter)));
  // Workers nest under their parent; one whose parent is not listed (filtered out,
  // or gone) stays top-level so it never disappears.
  const present = new Set(visible.map((r) => r.id));
  const workersOf = {};
  const sessions = [];
  for (const r of visible) {
    if (r.parent_id && present.has(r.parent_id)) (workersOf[r.parent_id] ||= []).push(r);
    else sessions.push(r);
  }
  return (
    <div data-testid={`peer-group-${peer.id}`}>
      <div className="flex items-center">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left rounded-md hover-bg-surface"
          style={{ height: "23px", paddingLeft: "6px", color: "var(--cc-dim)" }}
          aria-expanded={expanded}
          title={peer.url || peer.label}
        >
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          <Monitor size={12} style={{ color: "var(--cc-accent)", flexShrink: 0 }} />
          <span className="text-xs truncate flex-1" style={{ color: "var(--cc-fg)", fontWeight: 700 }}>{peer.label || peer.id}</span>
          <span className="text-[9px] flex-shrink-0 mr-1" style={{ color: d.token }}>{failed ? d.label : visible.length || ""}</span>
        </button>
        {onNewSession && d.ok && (
          <button
            data-testid={`peer-new-session-${peer.id}`}
            onClick={() => onNewSession(peer.id)}
            className="p-1 rounded flex-shrink-0 mr-1 hover-bg-surface"
            style={{ color: "var(--cc-muted)" }}
            title={`New session on ${peer.label || peer.id}`}
            aria-label={`New session on ${peer.label || peer.id}`}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {expanded && (
        <div style={{ paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "1px" }}>
          {failed ? (
            <p role="note" data-testid="peer-group-reason" data-reason={d.reason} className="text-[10px]" style={{ color: "var(--cc-dim)", padding: "2px 6px", lineHeight: 1.4 }}>
              {d.remedy}
            </p>
          ) : !peer.status || peer.sessions == null ? (
            <p className="text-[10px]" style={{ color: "var(--cc-muted)", padding: "2px 6px" }}>Checking…</p>
          ) : sessions.length === 0 ? (
            <p className="text-[10px]" style={{ color: "var(--cc-muted)", padding: "2px 6px" }}>No sessions on this machine</p>
          ) : (
            sessions.map((r) => (
              <PeerSessionBranch key={r.id} peerId={peer.id} remote={r} workers={workersOf[r.id] || []} agents={peer.subagents} activeKeys={activeKeys} onSelect={onSelect} onEnd={onEnd} />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar — main export
// ---------------------------------------------------------------------------

export default function Sidebar({
  sessions,
  activeIds,
  onSelect,
  onNew,
  onNewAt,
  onDelete,
  // (workdir) => boolean. Scrolls the pane area to that folder's panes and
  // reports whether it actually did; the folder row falls back to
  // expand/collapse when it returns false.
  onFocusFolder,
  visibleFolder = null,
  open,
  savedLocations,
  onAddLocations,
  onRemoveLocation,
  onToggleLocationBypass,
  gitStatuses = {},
  // { [terminalId]: [subagent rows] } -- Claude Code's in-process agents (read-only)
  subagentsByTerminal = {},
  workspacePresets = [],
  onSaveWorkspace,
  onLoadWorkspace,
  onDeleteWorkspace,
  // Paired machines: [{ id, label, url, status, sessions, error }] (hooks/usePeers).
  peers = [],
  // (peerId, remoteSession) => void -- place that machine's session in the grid.
  onSelectPeerSession,
  // (peerId) => void -- open the New session dialog on that machine.
  onNewPeerSession,
  // (peerId, remoteSession) => void -- end that session on its machine.
  onEndPeerSession,
  // Open orchestration runs: rows from utils/orchRuns.orchestratorRows, the run the
  // dock shows, and (run, session|null) => void.
  orchRows = [],
  selectedRunId = null,
  onPickRun,
}) {
  // Context menu state (location tree)
  const [ctxMenu, setCtxMenu] = useState(null);
  // Session filter
  const [sessionFilter, setSessionFilter] = useState("");
  // Workspace save dialog
  const [showSaveWorkspace, setShowSaveWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");

  const locationTree = useMemo(() => buildLocationTree(savedLocations), [savedLocations]);
  const agentsOf = subagentsByTerminal;

  // Filter sessions by search term
  // Sessions on another machine are listed under that machine's group, never in
  // this computer's folder tree (their workdir is a path over there).
  const filteredSessions = useMemo(() => {
    const local = sessions.filter((s) => !s.machine);
    if (!sessionFilter.trim()) return local;
    const q = sessionFilter.toLowerCase();
    return local.filter((s) =>
      s.name.toLowerCase().includes(q) || (s.workdir || "").toLowerCase().includes(q)
    );
  }, [sessions, sessionFilter]);

  // Pre-compute workdir → sessions[] map (O(n) once, not per LocationNode)
  // Workers nest under their parent row, so only top-level rows go in the folder map.
  const { top: topSessions, workersOf } = useMemo(() => groupWorkers(filteredSessions), [filteredSessions]);
  const sessionsByDir = useMemo(() => {
    const map = {};
    for (const s of topSessions) {
      const key = norm(s.workdir);
      if (!map[key]) map[key] = [];
      map[key].push(s);
    }
    return map;
  }, [topSessions]);

  // Expand 1 layer: fetch subdirs from backend and add them
  const handleExpand = useCallback(async (path) => {
    try {
      const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.dirs && data.dirs.length > 0) {
        onAddLocations(data.dirs);
      }
    } catch {
      // silently fail
    }
  }, [onAddLocations]);

  const activePeerKeys = useMemo(() => new Set(
    sessions.filter((s) => s.machine && s.remoteId && activeIds.includes(s.id)).map((s) => `${s.machine}/${s.remoteId}`),
  ), [sessions, activeIds]);

  const handleContextMenu = useCallback((e, path) => {
    const loc = savedLocations.find((l) => l.path === path);
    setCtxMenu({ x: e.clientX, y: e.clientY, path, isBypass: loc?.bypassPermissions || false });
  }, [savedLocations]);

  if (!open) return null;

  return (
    <aside
      data-tour="sidebar"
      className="flex flex-col flex-shrink-0 h-full"
      style={{
        width: "100%",
        overflow: "hidden",
        borderRight: "1px solid var(--cc-border)",
        backgroundColor: "color-mix(in srgb, var(--cc-bg2) 35%, transparent)",
        fontFamily: "inherit",
      }}
    >
      <div
        className="flex flex-col flex-1 overflow-y-auto"
        style={{ padding: "10px 8px 8px" }}
      >
        {/* New button */}
        <button
          data-tour="new-session-btn"
          onClick={onNew}
          className="flex items-center gap-2 text-sm font-medium rounded-md mb-2 transition-colors hover-bg-surface"
          style={{ color: "var(--cc-dim)", padding: "6px 8px" }}
          title="New session (Ctrl+Shift+N)"
        >
          <Plus size={16} />
          <span>New</span>
        </button>

        {/* Session filter */}
        {sessions.length > 0 && (
          <div className="mb-2" style={{ padding: "0 2px" }}>
            <div
              className="flex items-center gap-1.5"
              style={{
                height: "30px",
                padding: "0 10px",
                borderRadius: "8px",
                backgroundColor: "color-mix(in srgb, var(--cc-surface) 70%, transparent)",
                border: "1px solid var(--cc-border)",
              }}
            >
              <Search size={12} style={{ color: "var(--cc-muted)", flexShrink: 0 }} />
              <input
                data-sidebar-filter
                className="w-full text-xs bg-transparent min-w-0"
                style={{ color: "var(--cc-fg)", outline: "none", border: "none" }}
                placeholder="Filter sessions…"
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
              />
            </div>
          </div>
        )}

        <OrchestratorsList rows={orchRows} selectedRunId={selectedRunId} onPick={onPickRun} />

        {/* Workspace presets */}
        <div className="mb-2" style={{ padding: "0 2px" }}>
          <div className="flex items-center justify-between mb-1" style={{ padding: "2px 4px 4px" }}>
            <p className="cc-label">Workspaces</p>
            <button
              onClick={() => setShowSaveWorkspace((v) => !v)}
              className="p-0.5 rounded transition-colors hover-bg-surface"
              style={{ color: "var(--cc-muted)" }}
              title="Save current workspace"
            >
              <Save size={12} />
            </button>
          </div>
          {showSaveWorkspace && (
            <div className="flex items-center gap-1 mb-1">
              <input
                autoFocus
                className="flex-1 text-xs px-2 py-1 rounded"
                style={{
                  backgroundColor: "var(--cc-surface)",
                  color: "var(--cc-fg)",
                  border: "1px solid var(--cc-border)",
                  outline: "none",
                  minWidth: 0,
                }}
                placeholder="Workspace name..."
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && workspaceName.trim()) {
                    onSaveWorkspace?.(workspaceName.trim());
                    setWorkspaceName("");
                    setShowSaveWorkspace(false);
                  }
                  if (e.key === "Escape") {
                    setShowSaveWorkspace(false);
                    setWorkspaceName("");
                  }
                }}
              />
            </div>
          )}
          {workspacePresets.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {workspacePresets.map((preset) => (
                <div
                  key={preset.name}
                  className="group flex items-center gap-1 px-1 py-0.5 rounded-md hover-bg-surface"
                >
                  <button
                    onClick={() => onLoadWorkspace?.(preset)}
                    className="flex items-center gap-1.5 flex-1 text-left min-w-0"
                    title={`Load workspace: ${preset.sessions.length} session(s), layout ${preset.layout}`}
                  >
                    <Play size={10} style={{ color: "var(--cc-accent)", flexShrink: 0 }} />
                    <span className="text-xs truncate" style={{ color: "var(--cc-dim)" }}>
                      {preset.name}
                    </span>
                    <span className="text-[9px]" style={{ color: "var(--cc-muted)" }}>
                      {preset.sessions.length}s
                    </span>
                  </button>
                  <button
                    onClick={() => onDeleteWorkspace?.(preset.name)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 rounded transition-all hover-color-red"
                    style={{ color: "var(--cc-muted)" }}
                    title="Delete workspace"
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}
          {workspacePresets.length === 0 && !showSaveWorkspace && (
            <p className="text-[10px] px-1" style={{ color: "var(--cc-muted)" }}>
              No saved workspaces
            </p>
          )}
        </div>

        {/* Empty state / first-run card */}
        {locationTree.length === 0 && sessions.length === 0 && (
          <div className="py-4" style={{ padding: "0 2px" }}>
            <div
              className="rounded-lg p-4"
              style={{
                backgroundColor: "var(--cc-surface)",
                border: "1px solid var(--cc-border)",
              }}
            >
              <p className="text-xs font-semibold mb-3" style={{ color: "var(--cc-fg)" }}>
                Welcome to Plexar Studio
              </p>
              <ul className="space-y-2 text-xs" style={{ color: "var(--cc-dim)" }}>
                <li>• Run multiple Claude Code sessions side-by-side</li>
                <li>• Organize by project folder with git status</li>
                <li>• Up to 8 sessions, default layout of 4</li>
              </ul>
              <button
                onClick={onNew}
                className="mt-4 w-full py-1.5 rounded-md text-xs font-medium transition-colors hover-bg-surface"
                style={{
                  border: "1px solid var(--cc-border)",
                  color: "var(--cc-accent)",
                }}
              >
                Create your first session →
              </button>
            </div>
          </div>
        )}

        {/* Location tree */}
        {locationTree.length > 0 && (
          <>
            <div className="flex items-center justify-between" style={{ padding: "2px 6px 4px" }}>
              <span className="cc-label">Locations</span>
              <span style={{ fontSize: "9px", color: "var(--cc-muted)" }}>{savedLocations.length}</span>
            </div>
            <div className="flex flex-col" style={{ gap: "1px" }}>
              {locationTree.map((node) => (
                <LocationNode key={node.path} node={node} depth={0} sessionsByDir={sessionsByDir} workersOf={workersOf} agentsOf={agentsOf} activeIds={activeIds} onSelect={onSelect} onDelete={onDelete} gitStatuses={gitStatuses} onNewAt={onNewAt} onContextMenu={handleContextMenu} onFocusFolder={onFocusFolder} visibleFolder={visibleFolder} />
              ))}
            </div>
          </>
        )}

        {/* Other machines (Studio peers) */}
        {peers.length > 0 && (
          <>
            <div className="flex items-center justify-between" style={{ padding: "10px 6px 4px" }}>
              <span className="cc-label">Other machines</span>
              <span style={{ fontSize: "9px", color: "var(--cc-muted)" }}>{peers.length}</span>
            </div>
            <div className="flex flex-col" style={{ gap: "1px" }}>
              {peers.map((p) => (
                <PeerGroup key={p.id} peer={p} activeKeys={activePeerKeys} filter={sessionFilter.trim().toLowerCase()} onSelect={onSelectPeerSession || (() => {})} onNewSession={onNewPeerSession} onEnd={onEndPeerSession} />
              ))}
            </div>
          </>
        )}

        {/* Resources footer */}
        <>
          <div style={{ flex: 1 }} />
          <div
            style={{ borderTop: "1px solid var(--cc-border)", paddingTop: "10px", marginTop: "10px" }}
          >
            <button
              onClick={() => openExternal("https://desk.boord-its.com")}
              className="flex items-center gap-2 text-xs w-full text-left px-3 py-1.5 rounded-md transition-colors hover-bg-surface"
              style={{ color: "var(--cc-dim)" }}
              title="Open the BITS service desk"
            >
              <LifeBuoy size={12} />
              Support
            </button>
          </div>
        </>

        {/* Context menu */}
        {ctxMenu && (
          <LocationContextMenu
            x={ctxMenu.x}
            y={ctxMenu.y}
            path={ctxMenu.path}
            isBypass={ctxMenu.isBypass}
            onExpand={handleExpand}
            onNewAt={onNewAt}
            onRemove={onRemoveLocation}
            onToggleBypass={onToggleLocationBypass}
            onClose={() => setCtxMenu(null)}
          />
        )}
      </div>
    </aside>
  );
}
