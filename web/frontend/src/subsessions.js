/**
 * Agent-spawned worker sessions ("Session 3.1 … 3.8").
 *
 * A worker is created by its parent pane through /api/agent/spawn (agent_api.py), so
 * the desktop never POSTed it and has no local record. The /api/terminals poll calls
 * `reconcileWorkers` to adopt it: a live terminal whose `parent_id` names a session we
 * hold becomes a session with `parentTerminalId`. Adopted workers are NOT placed in the
 * grid; the sidebar nests them under their parent and a click places one like any other.
 *
 * A worker whose terminal is gone from the backend is dropped, because nothing local
 * can resume it: its parent spawned it, and its parent decides whether it comes back.
 */

/** @returns the same array when nothing changed, so React can bail out. */
export function reconcileWorkers(prev, terminals, makeId) {
  const byTid = new Map((terminals || []).map((t) => [t.id, t]));
  let changed = false;

  const kept = [];
  for (const s of prev) {
    if (s.parentTerminalId && s.terminalId && !byTid.has(s.terminalId)) {
      changed = true;
      continue;
    }
    // A restored record learns its lineage from the backend.
    const t = s.terminalId ? byTid.get(s.terminalId) : null;
    if (t?.parent_id && s.parentTerminalId !== t.parent_id) {
      kept.push({ ...s, parentTerminalId: t.parent_id });
      changed = true;
    } else {
      kept.push(s);
    }
  }

  const known = new Set(kept.map((s) => s.terminalId).filter(Boolean));
  for (const t of terminals || []) {
    if (!t.alive || !t.parent_id || known.has(t.id) || !known.has(t.parent_id)) continue;
    kept.push({
      id: makeId(),
      name: t.name,
      backendName: t.name,
      terminalId: t.id,
      parentTerminalId: t.parent_id,
      model: t.model,
      harness: t.harness || "claude-code",
      status: "running",
      workdir: t.working_dir || "",
      bypassPermissions: t.bypass_permissions || false,
      activityState: t.activity_state,
      tokens: t.tokens || 0,
      cost: t.cost || 0,
      context_percent: t.context_percent ?? null,
      claude_session_id: t.claude_session_id || null,
    });
    known.add(t.id);
    changed = true;
  }
  return changed ? kept : prev;
}

/** Split a flat session list into top-level rows plus a parent→workers map. A worker
 *  whose parent is not in `sessions` (filtered out, or closed) is shown top-level so it
 *  never disappears from the sidebar. */
export function groupWorkers(sessions) {
  const present = new Set(sessions.map((s) => s.terminalId).filter(Boolean));
  const workersOf = {};
  const top = [];
  for (const s of sessions) {
    if (s.parentTerminalId && present.has(s.parentTerminalId)) {
      (workersOf[s.parentTerminalId] ||= []).push(s);
    } else {
      top.push(s);
    }
  }
  return { top, workersOf };
}
