/**
 * Why a surface is empty, and where the information lives today.
 *
 * Exported so a test can hold the prose to account. Copy that names a
 * destination which does not exist is worse than no copy: it sends the reader
 * somewhere, they find nothing, and they conclude the whole feature is missing.
 * That is exactly what happened here — the Traces entry once said
 * "Engine ▸ Traces" and Engine has never had a Traces tab.
 *
 * S26 (2026-08-03) moved the real trace renderer into Reports ▸ Traces, so
 * Traces is no longer a "not built" tab at all. THE EXPLANATION SURVIVED THE
 * MOVE, and that is the point of this file now: the panel the reader lands on
 * is EMPTY, and it is empty for reasons they cannot see from the screen.
 * Consolidation moved a panel; it did not turn a recorder on.
 */

/**
 * MEASURED 2026-08-03, and the distinction is the whole finding: the trace
 * RENDERER is built and the trace RECORDER is off. Two stacking causes, both
 * verified at the wire:
 *   GET /api/local/lmstudio-local/traces -> {"traces":[],"count":0}
 *   GET /api/local/plexar-vllm/traces    -> 404 capability not available
 */
export const TRACES_EMPTY_WHY =
  "This list is empty, and that is a switch rather than a gap. The lane broker is the only backend " +
  "that publishes traces, and it runs in shadow mode by default — it forwards without ever queueing " +
  "a job, and a trace is written per queued job. Plexar, the backend actually serving models here, " +
  "does not publish traces at all. There is also no per-session trace endpoint for Claude API turns " +
  "yet, so this tab covers local inference only.";

/** What a fully-recorded Traces tab will show once something records. */
export const TRACES_WILL =
  "One row per prompt, expandable into the runs it fanned out into, with tokens and wall time per node.";

/** Tabs that genuinely have no implementation. Empty today — kept because the
 *  panel that renders it is still the right shape for the next one. */
export const NOT_BUILT_TABS = {};
