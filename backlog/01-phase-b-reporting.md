# Backlog 01 — Phase B: Routing & Reporting view

**Status: 6/6 built — code gate GREEN, live screenshot pending services.**
Foundation + all 9 sections + the W6 container now landed. Remaining: the LIVE
browser screenshot against a running broker (LM Studio + broker not up in this
session). Nothing committed yet.

## W6 landed (uncommitted, on `feat/local-broker-panel`)
- `web/frontend/src/components/RoutingReportingView.jsx` — the container. Owns
  view state (window/lead/hiddenBackends/refModel), drives `useReportingData`,
  composes the 9 sections via CSS `order` lead-with (AlertBanner 0 · HeroStrip 1
  pinned · six content sections 2..7 reordered per lead). Header (Cpu · title ·
  live badge → settings popover · window pills · close X) + toolbar (Lead-with ·
  backend chips generated from `by_provider[]`+API, colors mirror
  `BackendComparison`/`seriesColor` · record count).
- `LocalBrokerView.jsx` — now a thin shell: mounts `RoutingReportingView` and
  passes Connection + Provider as the header settings-popover content. Old
  two-column config/reporting body removed.
- `App.jsx` — mount passes `selectedProvider` + `onToast`; dropped the now-unused
  `localSpill`/`setMetricsWindow` bindings.
- Tests: 3 `LocalBrokerView` tests rewritten for the new structure.
- **Gate GREEN:** `npm run lint` (0 errors, 2 pre-existing ThroughputChart
  warnings) · `npm test` 265/265 · `npm run build` clean.
- **TODO:** live browser screenshot once `lms server start` + broker (:1235) are up.

## History

## Done (uncommitted, on `feat/local-broker-panel`)
- `web/frontend/src/components/localReporting/` — 11 files: `format.js`,
  `useReportingData.js`, `AlertBanner`, `HeroStrip`, `RoutingTimeline`,
  `BackendComparison`, `ThroughputChart`, `LatencyBudget`, `SpillControl`,
  `PerModelAgent`, `Ledger`. Props contract: `export default fn({ data, view, actions })`.
  eslint clean (2 non-blocking warnings in ThroughputChart).
- `LocalMetricsPanel.jsx` — rebuilt into Overview / API-detail tabs with savings hero
  (verified live earlier). Tests in `__tests__/LocalBrokerPanel.test.jsx`.
- Backend (Phase A, done + gated GREEN, 435 tests): broker metrics v2
  (ttft_ms, decode_tokens_per_sec, queue_wait_ms, errors, by_model, /metrics/timeseries,
  /spills, predicted_wait_s_by_class); server routes `/api/local/{provider}/metrics/timeseries`,
  `/spills`, `/api/usage/summary`, `/api/pricing/models`, `/api/models` (live OAuth list);
  `usage_tracker.summary(window)`; `pricing_models.json`; `pty_manager` drift-proof model validator.

## TODO — W6 (re-dispatch fresh; prior run was interrupted, don't build on partial)
1. Create `web/frontend/src/components/RoutingReportingView.jsx` — container composing
   the 9 sections via CSS `order` lead-with system (spec: design_handoff README below).
2. Migrate `LocalBrokerView.jsx` to mount the new view (it has a partial/incomplete
   W6 edit — reconcile or revert it).
3. Mount in `App.jsx` (ActivityRail Cpu icon → full-page overlay, FleetView-style).
4. Tests + final gate: eslint + full vitest + **LIVE browser screenshot against real endpoints**.

## Binding spec
`C:\Users\lenbo\AppData\Local\Temp\claude\...\scratchpad\facelift\design_handoff_local_reporting\README.md`
(768 lines — the ported broker-team design handoff).

## Gate before commit
`cd web/frontend && npm run lint && npm test`, then live screenshot. Nothing committed yet.
