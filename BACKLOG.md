# Backlog

Outstanding work, most-actionable first. Delete items as they land.

## Local Model Broker (branch `feat/local-broker-panel`)

Foundation shipped on the branch (commits `0d9ed3b`, `ec5e759`): read-only queue +
metrics panels and per-class spill control, all against the confirmed broker
contract. Everything below is *not yet done*.

### Ship / release
- [x] **Verify against a LIVE broker** — done 2026-07-24: identity green
  (`lane-broker` via /queue shape), queue/spill/metrics all answering through
  the cockpit proxy. (First attempt hit LM Studio directly → spawned the
  identity middleware. Broker now runs detached + Startup-folder supervised,
  broker-team side.)
- [x] **`/queue` field shape pinned** (broker.py::_queue_state, 2026-07-24):
  `{shadow, in_flight: {class, elapsed_s, predicted_remaining_s, model,
  client_id} | null, queued: [{class, position, predicted_wall_s, waiting_s,
  model, client_id}], estimated_clear_seconds}`. Defensive alias-guessing
  removed; spill counters read from `/config/spill` (`spilled_total`), not
  `/queue`.
- [ ] **Vitest cache corruption after Tauri/PyInstaller builds** (seen twice):
  full suite dies with bogus `expect is not defined` / only ~73 tests collected.
  Fix is `rm -rf node_modules/.vite` — consider automating in the build skill.
- [x] **Port the broker INTO Cockpit** (owner decision 2026-07-24): vendored at
  `web/lane_broker/`, runs in-process at startup unless an external broker
  answers (double-bind guard) or `COCKPIT_MANAGED_BROKER=0`. Shadow mode
  default; state at `~/.claude-cockpit/lane-broker/`. Spec hiddenimports
  pinned. Once installed, the team-repo Startup-folder launcher becomes
  redundant on this machine (remove it or keep it — external wins either way).
- [ ] **Rebuild the desktop installer as v1.4.1** — deliberately deferred until
  the managed-broker port (above) landed; now unblocked. Bump version first.
- [ ] **Open PR** for `feat/local-broker-panel` → `master`.
- [ ] **Version bump** to 1.4.1+ before shipping. Same-version respins never
  trigger the auto-updater (see the v1.3.9 lesson).
- [ ] **Update the top-level `README.md`** — this feature is documented in
  `CLAUDE.md` but has no user-facing README section yet.

### Foundation / follow-ups
- [x] **Provider registry.** Module-level `_PROVIDERS` + optional
  `COCKPIT_PROVIDERS_FILE` override. `GET /api/local/providers` surfaces metadata
  (id, label, kind, scope, capabilities) to the frontend; ProviderPicker
  persists selection to localStorage. URLs and auth stay server-side (SSRF
  stance). Shipped 2026-07-24.
- [x] **Surface broker config in the UI.** `ProviderPicker.jsx` in the drawer
  (shows all registered providers, remote-scope entries tagged). Capability gating
  via `GET /api/local/providers` — panels render only when their cap exists.
  Spill sliders only when cap `spill` AND `scope=="local"`. Shipped 2026-07-24.
- [ ] **Remote sharing (the expansion target):** Cloudflare Tunnel + Access
  (owner-controlled auth — Access policies/service tokens; cockpit proxies with
  `CF-Access-Client-Id`/`CF-Access-Client-Secret` headers via registry
  `auth: {type: 'cf-access'}`, secrets server-side only). Registry
  `scope:"remote"` entry + broker `--readonly-remote` flag; writes stay
  owner-only regardless of auth.
- [ ] **Decouple metrics polling cadence.** Queue + metrics + spill all poll at 3s;
  metrics change slowly and could poll less often.
- [ ] (Optional) **FleetView integration** — surface local queue depth / tps
  alongside the per-session usage tiles.

### Broker-side (owned by broker team, tracked here for the handoff)
- [x] Spill-control endpoint (`PUT /config/spill`) — shipped; Cockpit wired.
- [ ] Nothing outstanding on Cockpit's behalf. `/queue` key names (above) are the
  only open contract question.
