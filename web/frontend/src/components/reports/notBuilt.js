/**
 * Why a tab is not built, and where that information lives today.
 *
 * Exported so a test can hold the pointer to account. A "not built" panel that
 * names a destination which does not exist is worse than a blank one: it sends
 * the reader somewhere, they find nothing, and they conclude the whole feature
 * is missing. That is precisely what happened here -- this entry said
 * "Engine ▸ Traces" and there has never been a Traces tab in Engine
 * (ENGINE_TABS is Live, Models, Requests, API, Logs). The trace renderer is
 * real and lives inside Engine ▸ Requests.
 */
export const NOT_BUILT_TABS = {
  traces: {
    will:
      "One row per prompt, expandable into the runs it fanned out into, with tokens and wall time per node.",
    /* MEASURED 2026-08-03, and the distinction is the whole point: the trace
       renderer is BUILT (TracesPanel, mounted in Engine ▸ Requests) and the
       RECORDER is off. Saying only "it lives over there" would send the reader
       to a panel that is empty for reasons they cannot see. Two stacking
       causes, both verified at the wire:
         GET /api/local/lmstudio-local/traces -> {"traces":[],"count":0}
         GET /api/local/plexar-vllm/traces    -> 404 capability not available */
    today:
      "Engine ▸ Requests, which renders the lane broker's trace tree. It is empty right now, and that is a switch rather than a gap: the lane broker is the only backend that publishes traces, and it runs in shadow mode by default, so it forwards without ever queueing a job — and a trace is written per queued job. Plexar, the backend actually serving models here, does not publish traces at all. There is also no per-session trace endpoint for Claude API turns yet.",
  },
};
