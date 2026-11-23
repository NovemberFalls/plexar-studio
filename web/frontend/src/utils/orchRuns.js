/**
 * Pure helpers for the Orchestrators list and the run dock. A "run" is one row of
 * `GET /api/framework/orch-runs` (open runs only); a "session" is a Studio session
 * whose `terminalId` the framework recorded as `orchestrator_session_id`.
 */

const STAGE_LABELS = {
  prompt: "Prompt",
  build: "Build",
  workers: "Workers",
  gate: "Gate",
  validate: "Validate",
  final: "Final",
  ship: "Ship",
};

/** Known stages get a label; anything else renders verbatim, never a neighbour's. */
export function stageLabel(stage) {
  if (typeof stage !== "string" || !stage) return "";
  return Object.prototype.hasOwnProperty.call(STAGE_LABELS, stage) ? STAGE_LABELS[stage] : stage;
}

function stamp(run) {
  const t = Date.parse(run?.updated_at || run?.started_at || "");
  return Number.isFinite(t) ? t : 0;
}

/** One row per open run, newest update first: `{ run, session | null }`. */
export function orchestratorRows(runs, sessions) {
  const list = Array.isArray(runs) ? runs : [];
  const all = Array.isArray(sessions) ? sessions : [];
  return list
    .filter((run) => run && run.run_id)
    .map((run) => ({
      run,
      session: run.orchestrator_session_id
        ? all.find((s) => s.terminalId === run.orchestrator_session_id) || null
        : null,
    }))
    .sort((a, b) => stamp(b.run) - stamp(a.run));
}

/** The open run a terminal orchestrates, or null. */
export function runForSession(runs, terminalId) {
  if (!terminalId || !Array.isArray(runs)) return null;
  return runs.find((r) => r.orchestrator_session_id === terminalId) || null;
}

/** Folder name of a run's cwd, for a run with no Studio session. */
export function cwdFolderName(cwd) {
  if (typeof cwd !== "string") return "";
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

// The framework's worker statuses are WAITING | DISPATCHED | REPORTED | DONE |
// FAILED | BLOCKED | LADDER_EXHAUSTED. Only DISPATCHED is out working.
const ACTIVE_WORKER = new Set(["DISPATCHED"]);

/** Workers still running (not yet reported). */
export function runningWorkerCount(run) {
  const ws = Array.isArray(run?.workers) ? run.workers : [];
  return ws.filter((w) => ACTIVE_WORKER.has(String(w?.status || "").toUpperCase())).length;
}

/**
 * The one place the dock's frame URL is built, so an embed parameter can be added
 * later. The framework serves /embed for framing; /app refuses it, so there is no
 * fallback to /app.
 */
export function embedUrl(base, runId) {
  return `${String(base || "").replace(/\/+$/, "")}/embed?run=${encodeURIComponent(runId)}`;
}

/** The embed that follows one session: its newest open run, and later ones as they start. */
export function embedSessionUrl(base, sessionId) {
  return `${String(base || "").replace(/\/+$/, "")}/embed?session=${encodeURIComponent(sessionId)}`;
}

/** Origin of the framework base, or null when it is not a URL. */
export function originOf(base) {
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}
