# Backlog

Outstanding work, most-actionable first. Delete items as they land.

## Local Model Broker (branch `feat/local-broker-panel`)

Foundation shipped on the branch (commits `0d9ed3b`, `ec5e759`): read-only queue +
metrics panels, all against the confirmed broker
contract. Everything below is *not yet done*.

### Ship / release
- [x] **Verify against a LIVE broker** — done 2026-07-24: identity green
  (`lane-broker` via /queue shape), queue/metrics all answering through
  the cockpit proxy. (First attempt hit LM Studio directly → spawned the
  identity middleware. Broker now runs detached + Startup-folder supervised,
  broker-team side.)
- [x] **`/queue` field shape pinned** (broker.py::_queue_state, 2026-07-24):
  `{shadow, in_flight: {class, elapsed_s, predicted_remaining_s, model,
  client_id} | null, queued: [{class, position, predicted_wall_s, waiting_s,
  model, client_id}], estimated_clear_seconds}`. Defensive alias-guessing
  removed; (spill counters went with the feature, 2026-08-03) not
  `/queue`.
- [x] **Vitest cache corruption after Tauri/PyInstaller builds** — automated:
  `/build-cockpit` (step 6) now clears `node_modules/.vite` after every build.
- [x] **Port the broker INTO Cockpit** (owner decision 2026-07-24): vendored at
  `web/lane_broker/`, runs in-process at startup unless an external broker
  answers (double-bind guard) or `COCKPIT_MANAGED_BROKER=0`. Shadow mode
  default; state at `~/.claude-cockpit/lane-broker/`. Spec hiddenimports
  pinned. Once installed, the team-repo Startup-folder launcher becomes
  redundant on this machine (remove it or keep it — external wins either way).
- [x] **v1.4.1 built** (2026-07-24, commit `c27f850`): version bumped
  (package.json is the single source; tauri.conf.json inherits), signed
  installer + updater zip in `releases/` and Downloads. Self-contained —
  managed broker verified present in the sidecar bundle. NOT yet published
  to GitHub Releases (no latest.json) — that's `/push-cockpit`.
- [ ] **Publish**: merge/PR `feat/local-broker-panel` → `master`, then
  `/push-cockpit` (builds latest.json, uploads to GitHub Releases so the
  auto-updater sees 1.4.1).
- [ ] **Update the top-level `README.md`** — this feature is documented in
  `CLAUDE.md` but has no user-facing README section yet. Do before/with publish.

### UX QA sweep (2026-07-24, owner-driven)
- [x] In-area views: FleetView + LocalBrokerView no longer full-screen overlays;
  rail/sidebar/top bar stay visible, rail icons toggle in/out (commit 8a7cf34).
- [x] Rail Search (magnifying glass) was dead — missing `data-sidebar-filter`
  attr; fixed + regression test (commit b783018).
- [x] **Broadcast removed** (owner decision 2026-07-24: "I don't think we will
  ever do that"). Rail button, StatusBar toggle, input bar, Ctrl+Shift+Enter
  binding, and sendBroadcast all deleted. The Bridge/Channel features remain
  the multi-session coordination tools.
- [ ] **Fresh installer after QA sweep concludes** — commits 8a7cf34/b783018
  and whatever the Broadcast decision produces are newer than the last build
  in Downloads (`_in-area-nav` has 8a7cf34 but not b783018).

### Foundation / follow-ups
- [x] **Provider registry.** Module-level `_PROVIDERS` + optional
  `COCKPIT_PROVIDERS_FILE` override. `GET /api/local/providers` surfaces metadata
  (id, label, kind, scope, capabilities) to the frontend; ProviderPicker
  persists selection to localStorage. URLs and auth stay server-side (SSRF
  stance). Shipped 2026-07-24.
- [x] **Surface broker config in the UI.** `ProviderPicker.jsx` in the drawer
  (shows all registered providers, remote-scope entries tagged). Capability gating
  via `GET /api/local/providers` — panels render only when their cap exists.
  Spill sliders shipped 2026-07-24; REMOVED WITH THE FEATURE 2026-08-03.
- [ ] **Remote sharing (the expansion target):** Cloudflare Tunnel + Access
  (owner-controlled auth — Access policies/service tokens; cockpit proxies with
  `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers via registry
  `auth: {type: 'cf-access'}`, secrets server-side only). Registry
  `scope:"remote"` entry + broker `--readonly-remote` flag; writes stay
  owner-only regardless of auth.
- [ ] **Decouple metrics polling cadence.** Queue + metrics both poll at 3s;
  metrics change slowly and could poll less often.
- [ ] (Optional) **FleetView integration** — surface local queue depth / tps
  alongside the per-session usage tiles.

### Team-side (no Cockpit work — panels populate automatically when these land)
- [x] ~~Spill-control endpoint (`PUT /config/spill`)~~ — shipped 2026-07, REMOVED 2026-08-03 (owner's ruling; see CLAUDE.md "Spill — REMOVED ENTIRELY").
- [x] `/queue` contract pinned; broker supervised; lane-broker branch merged to
  team master (upstream source of truth for the vendored copy).
- [x] `local-lanes.json` endpoint flip to `:1235` — done 2026-07-24 (both lanes
  now route through the broker; forward path verified via /v1/models). Note:
  the profile lives in a bench WORKTREE — should graduate to team master like
  the broker did.
- [ ] Client tagging: `X-Client-Id`/`X-Agent-Id`/`X-Trace-Id` +
  `stream_options.include_usage` on bench/swarm clients. Until then: traces
  empty, by-agent "(untagged)", tokens "not reported" — data absence, not a bug.
