# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.47] - 2026-09-26

### Added
- **HTTP API docs.** The built-in FastAPI docs at `http://127.0.0.1:8420/docs` now group every route by area and carry the app's real version and a security note. See "HTTP API" in the README.
- The **Tasks** view says what it is: a window onto Plexar Framework, our task framework, which isn't public yet and will be open-sourced when it's ready.

### Changed
- Plexar models are reached at `https://llm.plexar.tech`. The model list shows only chat models: the `plexar-signal` classifier is no longer offered.
- Plexar Harness panes use your own saved sign-in (`plexar-harness login`). Studio no longer requires or passes a shared key unless you save one in Settings.
- The default Chat address is `https://chat.plexar.tech`.

### Fixed
- Plexar Harness panes started with no effort chosen no longer fail every prompt with "unknown reasoning effort".
- The harness model pill and pane headers show the model's name instead of `["plexar","…"]`, and a saved model the rig no longer serves is marked "not offered" instead of silently used.

## [2.1.29] - 2026-09-13

### Changed
- Codex **Conversation history** now shows everything Codex did, not only chat text: each command it ran with its output folded underneath, progress notes versus final answers, and local times. Long output is capped at 12 KB and marked. The first open of a very large Codex log is about twice as fast, and the view waits up to 30 s instead of 10 s.

### Added
- **Plexar Mobile 1.1.0** for Android is attached to this release (arm64 and armv7 APKs).

## [2.1.28] - 2026-09-11

### Fixed
- Terminals no longer disconnect in bulk when the server stalls. Codex session discovery enumerated every open file handle on the machine, which held Python's lock for seconds at a time; it now lists Codex's session folder instead.
- A stall of more than 20 s no longer closes every pane: the WebSocket keepalive now allows 120 s, matching the watchdog.
- The watchdog starts exactly one replacement server, not two.

## [2.1.27] - 2026-09-10

### Fixed
- Installing an update no longer stalls on a locked `plexar-studio-server.exe`: the installer now stops the server by its current name.

## [2.1.26] - 2026-09-10

### Fixed
- Six or more busy sessions no longer starve the server, and the watchdog no longer kills a server that is merely overloaded.

## [2.1.25] - 2026-09-10

### Fixed
- No blocking work runs on the server's event loop any more, so one slow request cannot freeze every pane.

## [2.1.24] - 2026-09-09

### Fixed
- Recovery from a hung server actually starts a replacement, and every recovery is written to a supervisor log.

## [2.1.23] - 2026-09-09

### Fixed
- A server that is running but no longer answering is recovered automatically, without Task Manager.

## [2.1.22] - 2026-09-09

### Fixed
- Image attachments in Codex sessions render in Plexar Mobile's chat view.

## [2.1.21] - 2026-09-09

### Fixed
- Studio no longer leaves its Cloudflare connector running when the server dies uncleanly. Five orphans were measured, one per unclean exit. Identity is proven before anything is terminated: spawning records the connector PID, the owning Studio, and a hash of the argv (never the token), and the sweep acts only when the owner is gone AND the live process is a cloudflared AND its command line hashes equal. `cloudflared` is not a Studio process — another Plexar product runs the same binary.

### Changed
- A failed image paste now reports where its time went, from both ends: the client splits the upload into headers and body and includes the browser's own queueing figure, and the server logs bytes and its own handling time per upload. The server answers a 10 MB upload in under two seconds, so this exists to find the twenty that the client sees.

## [2.1.20] - 2026-09-09

### Fixed
- Stale scratch directories are now swept at STARTUP, not only on graceful shutdown. The three `mkdtemp` families (`cockpit_uploads_*`, `cockpit_relays_*`, `cockpit_mailbox_*`) were removed only on the clean exit path, and the sidecar is designed to outlive its window — so that path is the exception, not the rule (one machine held 280 upload directories, 226 MB, against a log with seven "Startup complete" lines and zero "Shutdown complete"). Startup is the only moment reached however the last process died. **"Not mine" never means "dead":** each directory now carries a `.plexar-owner` marker (PID + executable basename) and is kept unless that PID is gone or the process now running under it is not a Studio sidecar — the same two-part check `instance_guard` makes before it terminates anything. Directories written by older builds carry no marker and are swept only when nothing inside them has changed for 24 h. Our own three directories are excluded by resolved path, symlinks and junctions are never followed, nothing outside the temp folder is touched, the scan is bounded to 2 s so it cannot delay launch, and it logs one line only when something was actually removed. The existing shutdown cleanup is unchanged.
- Studio no longer leaves its Cloudflare connector running after an unclean exit. `TunnelManager.stop()` runs on the graceful shutdown path only, and that path is the exception rather than the rule — one machine held seven `cloudflared.exe` processes at once, five of them Studio connectors orphaned one per unclean server exit, their start times matching the server restarts. The connector is now swept at STARTUP, the only moment reached however the last process died. **`cloudflared.exe` is not a Studio process** (R-185: terminating by process name took down Plexar-LLM's tunnel, which runs the same binary), so Studio terminates only a connector it can PROVE it started: spawning writes an ownership record (`connector-owner.json`, beside the connector log) naming the connector PID, the Studio PID that spawned it, and a SHA-256 of the exact argv — never the token, which a hash cannot give back. The sweep terminates that PID only when the spawning Studio is gone, the live process is a `cloudflared`, **and** the hash of its live command line matches; a PID that now runs anything else is left alone and the record forgotten. `foreign_running` is unchanged — a connector Studio did not start is still reported and never touched. Best-effort throughout: startup cannot fail because of it. A healthy orphan is terminated and respawned rather than adopted, because supervision here means owning the child's stdout pipe and exit code and neither can be reattached to a process we did not spawn.
- The test suite no longer touches the developer's real system temp folder. `tests/test_upload_eviction.py` uses the context-manager form of `TestClient`, which runs the real lifespan — so the new startup sweep ran for real, and one `pytest tests` run took that machine's temp folder from 307 directories to 109 (the age rule held, so nothing live was destroyed, but a suite must not delete files outside its own sandbox). Independently, `bridge_manager` and `mailbox_bridge` call `mkdtemp` at module IMPORT, so every pytest process leaked one directory of each family there forever. Both are fixed at the root rather than by special-casing the sweep: `tests/conftest.py` redirects `tempfile.tempdir` and `TMPDIR`/`TEMP`/`TMP` to a sandbox before any module is imported (import time, because the leak is at import time — an autouse fixture is too late). Production is unchanged: `sweep_stale` with no `temp_root` still defaults to the real temp folder and the lifespan still calls it. `COCKPIT_TESTS_USE_REAL_TEMP=1` opts a run out, and a `real_tempdir` fixture hands the real path to a test that explicitly needs it.

## [2.1.19] - 2026-09-09

### Fixed
- The desktop sidecar supervisor now recovers from a crash that happens late in a session. Its restart budget counted failures for the LIFETIME of the app and was never reset, so a server that ran healthily for hours and then died was counted as the fourth crash and was not restarted — and an external kill (Task Manager) burned an attempt too. The budget now counts CONSECUTIVE rapid failures: a sidecar that stayed up 60s or more clears it before it is read. Retries also back off 2s / 4s / 8s instead of a flat 2s, because a flat retry into a port that is still releasing is what the 2.1.7 bind-loop looked like, and the backoff no longer parks an async runtime worker (it sleeps on the blocking pool).
- When the supervisor does give up, the user is told. Previously the only notice was an `eprintln!` to stderr, which nobody sees in a packaged build, so the panes sat on "waiting for connection" — the wording for a *recoverable* outage — forever. It now shows a dialog ("Plexar Studio server stopped") with **Try again**, which resets the budget and respawns, and **Quit**. The window is never closed and the app never auto-quits, so text in a pane can still be copied out. Exit code 3 (a healthy sidecar already owns 127.0.0.1:8420) still attaches without restarting, unchanged.
- Image paste: the 2.1.18 fix still failed at 15s because its four per-step read budgets (4s each) totalled 16s against the 15s whole-paste timer, so a slow clipboard reliably lost the race before the upload even started. Replaced with exactly two budgets: one 5s deadline shared across every read strategy combined, and a separate 20s upload deadline that starts only when the upload itself begins — a slow read no longer eats into upload time. When every read strategy fails, an actionable reason (e.g. "Focus the local terminal window before pasting") now always wins over a bare "Reading timed out"; a fully-hung read phase reports "Clipboard contains no readable image or text (the window may not have focus; click into the terminal and paste again)" instead. A timeout toast now names the clipboard/upload time split (`clipboard <a>s, upload <b>s`) so a repeat failure is conclusive without another round trip.

### Added
- `GET /.well-known/plexar` — the estate-wide Plexar handshake, so Plexar Mobile can act as a hub across Studio, Chat, LLM and Email without their APIs being forced through one contract. Unauthenticated and always 200 while the process is up: `authenticated` is derived from the device store, so a missing or garbage token answers `false` rather than 401 (a 401 merges "wrong credential" with "server down", whose remedies are opposite). With `remote.enabled` off it still answers 200 with empty `capabilities` and `detail: {"remote_enabled": false}` — the one place the remote surface is not 404-when-disabled, so a hub can say "remote access is off" instead of "unreachable"; every other `/remote/v1/*` route keeps 404-ing. The body carries no secret, filesystem path, hostname or private count.
- The route is the second browser-origin-guard exemption, beside `/remote/v1/*`, and both are now asked through one arbiter (`origin_guard.is_origin_exempt`). The carve-out is exactly one path: a tunnel `Host` reaches the handshake and is still 403 on `/api/terminals`, pinned by a test.

## [2.1.18] - 2026-09-09

### Fixed
- A failed image paste now names its own cause instead of the browser's "signal is aborted without reason". `terminalClipboard.js`'s timeout race let an aborted upload's own `AbortError` win over our timeout message when the two settled in the same tick; our reason now always wins. The 15s timeout message also names the step in flight (e.g. "while uploading the image"), and each clipboard-read fallback (`clipboard.read`, the native reader, `clipboard.readText`) now has its own 4s budget so one hung read strategy no longer consumes the whole paste before the next fallback gets a turn.

## [2.1.17] - 2026-09-09

### Fixed
- The CLI's terminal title is a CHANGE signal, not the session's name. The OSC 0/2 title channel used to adopt the raw value verbatim, including the animating status glyph (`✳`/`◑`/…) prefix and the occasional mojibake read — churning the name and disagreeing between desktop and phone purely by poll timing. `normalize_cli_title` now strips the leading decoration and refuses decode-damaged or bare-binary-name values; the first normalized title is seeded (recorded, not adopted), and only a later, differing title is treated as an active rename. A name adopted before this fix self-repairs once per session.
- A slash-command's leftover `<command-args></command-args>` tag is no longer shown as a session's preview text; any residue that is nothing but tag markup is now skipped as a non-qualifying record.

## [2.1.16] - 2026-09-09

### Fixed
- Studio Remote: the device store no longer rewrites itself on every phone request. Concurrent polls raced the file replacement on Windows and each failure was a server error for the phone. Writes are serialised, last-seen is persisted at most every 30 s, and a failed write is logged, never raised. Failed pairing attempts are now logged with a reason.
- Settings ▸ Remote: "Run when Studio starts" starts the connector immediately when a token is saved, and turning it off stops it.

## [2.1.15] - 2026-09-08

### Added
- Studio runs the Cloudflare connector for you. Settings ▸ Remote gains a **Tunnel connector** card: paste the connector token, press Start, and `cloudflared` runs as a hidden child process that Studio restarts with backoff if it dies, optionally starting with the app. The card shows state, registered connections, restarts, the last error and a log tail. No console window, no Windows service, no scheduled task.
- The connector token is stored with the provider API keys in `config.json`, never in the exportable `settings.json`, is never returned by any route, and is scrubbed out of the ring buffer and `cloudflared.log`.
- A `cloudflared` that Studio did not start is reported as "another connector is already running outside Studio" — Studio never adopts or terminates a process it did not launch.

## [2.1.14] - 2026-09-08

### Changed
- The bundled server now identifies itself: Task Manager shows "Plexar Studio local server (keep running; Studio relaunches it)" with product name and version, and the sidecar binary is `plexar-studio-server` rather than `cockpit-server`. Older names remain recognised by the port guard.

## [2.1.13] - 2026-09-08

### Added
- Studio Remote: sessions carry `branch` (from the working directory's `.git/HEAD`) and `effort` (the live level the CLI reported, else the launch value). A pasted `<image name=... path=...>` tag in a user message is served as an image block; the list preview strips markdown markers.

## [2.1.12] - 2026-09-08

### Added
- Studio Remote: the sessions list carries `updated_at` and a `preview` of the last message (last text turn, tool-only turns and injected system text skipped; the transcript tail is read backward in 64 KB windows, 2 MB cap). Phones show it on the session card.

## [2.1.11] - 2026-09-08

### Added
- Studio Remote: a paired phone can read a session as a conversation (Claude Code and Codex transcripts in one message shape, with tool calls, thinking and pasted images), upload images for a prompt, and fetch images from the upload folder or the session's working directory. Images are served only from those two places, image types only, 10 MB cap.

### Fixed
- A session renamed from inside Claude Code (`/rename`) now renames the Studio session and follows to the phone; the desktop list adopts the new name without clobbering a rename typed in Studio. Codex records no rename, so a Codex rename is followed only when the CLI sets the terminal title.

## [2.1.10] - 2026-09-08

### Fixed
- Studio Remote: the terminal stream now tells a phone the PTY's columns and rows, and sends a resize frame when the desktop pane changes size, so Plexar Mobile can render the mirrored terminal at its true geometry instead of wrapping every line.

## [2.1.9] - 2026-09-08

### Added
- Studio Remote: a paired phone can pick a folder (the desktop's saved folders, live sessions, recent history, or the drive tree), choose the harness, model, permission mode and effort from the desktop's own catalog, start a session, and close one. The desktop publishes its saved folders to the remote gateway in the background.

### Fixed
- Settings > Remote: the Cloudflare tools accept the Public URL as entered instead of answering "invalid hostname", and the public-URL probe identifies itself so Cloudflare's bot rules no longer answer it with 403.

## [2.1.8] - 2026-09-08

### Added
- Studio Remote (opt-in, off by default): Settings > Remote pairs a phone by QR or code, lists and revokes devices, and serves an authenticated `/remote/v1/` surface for Plexar Mobile. The remote stream never displaces the desktop pane. Settings > Remote also generates a `cloudflared` configuration restricted to the remote path, reports `cloudflared` status, and tests the public hostname, with an optional Cloudflare Access flag that tells the phone to sign in first.

## [2.1.7] - 2026-09-08

### Fixed
- Keep the live terminal readable during delayed or failed Codex history requests. Reopening restores cached messages and reading position while checking conversation identity; requests time out with a retry path. Continuing to type during a request prevents history from taking focus or covering input when it arrives.
- Index saved Codex message offsets incrementally so repeated pages do not rescan the entire recording. Separate per-file locks keep a cold history read from blocking another session's cached pages. Capture recording path and native identity together during conversation switches.
- Stop repeatedly scanning retained terminal output on idle replay polls, reducing server event-loop work that can delay typing across long sessions.
- Recover image paste when WebView clipboard events omit image data, using browser clipboard access and a bounded native Windows image fallback. Report upload failures and prevent delayed pastes from entering a changed or reconnected session. Preserve bracketed text paste and require the user to submit prompts.

- Deliver terminal output to the browser as it arrives instead of polling every session's retained replay buffer every 25 ms. On 2.1.3 to 2.1.6 that poll saturated the server's single event loop once several long sessions were open; the owner's log shows every session's PTY read timing out in the same second, and each such timeout silently discarded output already read from the pipe. Idle sessions now cost no server wakeups, a slow read is waited out instead of abandoned, and a reconnect replays retained output in a few large frames instead of one frame per chunk.
- Recover cleanly when a previous Studio still holds port 8420. The sidecar deliberately outlives the window, which is how sessions survive a close; a healthy one is now attached to explicitly, a hung one is terminated so the new instance can start, and a foreign process is named and left alone. uvicorn's own bind errors now reach cockpit.log, and a second launch focuses the existing window instead of starting a second sidecar.
- Report an overlapping paste instead of dropping it silently, and bundle the pricing seed whose absence logged a traceback on every sidecar start.

### Scope
- First access to a recording and pages beyond the bounded index can still require a file scan. Native history contains saved user/assistant messages. Real desktop history, input responsiveness and clipboard acceptance remain pending owner QA.
- Windows installers carry Tauri updater signatures; Windows Authenticode status is reported separately. Existing application identity and preferences remain compatible.

## [2.1.6] - 2026-09-07

### Known follow-up
- Codex history can show a blank loading view; intermittent history failures and interface lag remain reported issues under investigation. Automatic loading and session restoration do not close this usability work.

### Added
- **Codex history through normal scrolling.** Scrolling upward at the terminal boundary opens saved native user and assistant messages; continued scrolling loads older pages while preserving reading position. Scroll down past the newest messages or use **Back to live terminal** to return. Docked and popout sessions keep running throughout.
- **Codex context and usage.** Pane headers show a context ring, observed effort, cumulative token totals and supported API-equivalent estimates. Subscription quota follows the focused session. Unknown and last-known data are labelled instead of appearing as zero usage or another conversation's figures.
- **Retained terminal replay.** Fresh views and reconnects can replay up to 8 MiB of raw PTY output with sequence tracking and a visible truncation notice. Native Codex conversation history remains available separately from the in-memory terminal buffer.
- **Full retained log loading.** Diagnostics **ALL** includes rotated log files within the retention limit, preserving redaction and identifying incomplete reads.

### Fixed
- Preserve Claude/Codex session identity when restoring sessions and resuming native conversations. Reject mismatched model/harness combinations and avoid mixing history after a native conversation switch.
- Keep Codex scrollback through erase-scrollback sequences, retain terminal instances across layout changes, and prevent duplicate or stale socket output during reconnects and popout transitions. Native saved messages remain readable when a CLI redraw or grid resize overwrites the terminal viewport.
- Use independent synchronous Windows ConPTY input/output pipes, matching the API contract; allow output to drain while input writes wait, and cancel blocked writes during cleanup.
- Let Reports tables and Diagnostics logs use the available height; keep folder highlighting synchronized with the scrolling session layout.

### Changed
- Public release consolidating the 2.1.3 and locally tested 2.1.4 fixes under **Plexar Studio** branding. The 2.1.5 draft was held during final Windows paste verification. The application executable is `plexar-studio.exe` and the PyInstaller output is `plexar-studio-server.exe`.
- Preserve the installed application identifier, internal sidecar bundle name and existing configuration/storage keys so upgrades retain application identity and preferences. Tauri signatures authenticate updater archives; they do not constitute Windows Authenticode signing.

### Scope
- Codex and Claude CLI sessions run natively on Windows without WSL. Mobile access and self-hosted remote setup remain backlog work; this release does not deploy a mobile client or hosted relay.
- Native history contains saved user and assistant messages, not every transient terminal/tool display. API estimates are not subscription bills. Raw PTY replay is bounded and does not survive a backend restart.

## Roadmap

### Completed
- [x] Linux/macOS PTY support (`unix_pty.py` via ptyprocess)
- [x] Zoom controls (Ctrl+/-, Ctrl+mousewheel, Ctrl+0 reset)
- [x] Chat UI — built twice, removed twice. A JSONL-powered conversation view arrived in v1.1.0 and was reverted to terminal-only in v1.3.0; a second, fuller Chat destination (`components/chat/`, `/api/chat/*`, its own SQLite store) was built in 2026-07/08 and **removed entirely on 2026-08-03**. Both times for the same reason: Studio is a terminal multiplexer, and an embedded chat is a weaker copy of the terminal beside it.
- [x] History panel for browsing past sessions

### Backlog
- [ ] Code splitting / lazy loading (bundle >500KB warning)
- [ ] Session search / filter
- [ ] Keyboard-driven session switching (Ctrl+Tab)
- [ ] CI matrix: Linux + macOS runners
- [ ] Homebrew formula / apt package
- [ ] Plugin system for custom session types
- [ ] Multi-monitor / detachable panes
- [ ] Session templates / presets

## [2.1.2] - 2026-09-07

### Fixed
- **The desktop app no longer opens on "server could not be reached".** Every cold launch showed WebView2's error page until you hit Refresh. `lib.rs` carried a loop commented *"Wait for the server to be ready before the webview loads"* — it did not do that. Tauri builds every window whose config has `create: true` and only THEN calls the setup hook (tauri-2.10.3 `app.rs:2374` vs `:2380`), so the webview had already navigated to `frontendDist` and already been refused before the wait began. It was a 15-second wait placed after the thing it was meant to prevent, and it lost on essentially every launch: the sidecar needs ~2.0s to answer HTTP when warm — longer cold, while Defender scans the 50MB onefile extraction — against a webview that navigates at ~0ms. Nothing recovered either, because the recovery logic (App.jsx's health-check polling) lives *inside* the page that failed to load.
- The fix is **ordering, not duration**: `create: false` in `tauri.conf.json` stops Tauri's own loop from building the window, and the window is built after the server answers. Raising the timeout would have changed nothing.
- The readiness probe is now an HTTP `GET /api/version` rather than a bare `TcpStream::connect` — a listening socket accepts as soon as it is bound, which is strictly earlier than uvicorn serving routes, so "connected" could still mean "not answering". Written against std rather than adding an HTTP crate; the request satisfies both `origin_guard` clauses (loopback `Host`, absent `Origin` allowed on HTTP).

### Verified — not changed, measured
A live audit ran against the running instance and its real 94MB store (150,879 usage events, 61,105 tool events). All fifteen invariant checks hold, so the following are confirmed working rather than assumed:
- **Usage tracking** — per-session rows carry real input/output/cache/total tokens, turns and cost; `/api/usage/report` agrees with the store exactly; the `(uuid, block_index)` composite key holds with zero duplicate rows.
- **Estimated spend** — cost is a STORED column written at ingest, and none of the six read paths calls `price_for`, so a price change cannot re-price history; `model_prices` carries no UPDATE or DELETE anywhere; `price_source` is honest (`exact` 121,629 / `backfill` 29,188 / `unpriced` 63, and no `unpriced` row carries a cost).
- **Context window** — Claude panes report a real percentage, Codex panes correctly report none; `claude-opus-5` resolves to 200,000 tokens and `claude-opus-5[1m]` to 1,000,000, with long-context-only families resolving long without needing the suffix.
- **Subscription limits** — real server-reported percentages, and the OAuth token never appears in the response body.

### Notes
- Two guards are correct but **unexercised by production data**, which the audit now proves synthetically instead of asserting the corpus exercises them: measured across 40 JSONL files and 29,456 assistant messages, Claude Code never writes two `tool_use` blocks in one message (parallel calls each get their own entry), and every tool-bearing message also carries `usage`. The multi-block and usage-less-turn paths are exercised directly through the real parser.

## [2.1.1] - 2026-09-07

### Fixed
- **The TopBar could show a harness/model pair that cannot spawn.** With the Codex harness selected, the model pill could read an Anthropic model — "Codex · Opus 5" — and the quick-spawn button would then POST `codex -m claude-opus-5`, a session that authenticates and fails on every turn. Both pills were rendering honestly; the *state* was incoherent. `harness` and `model` live behind two independent localStorage keys, and four paths could move one without the other — the harness pill, the model pill, the Inspector's model dropdown, and the mount restore — while only the harness pill checked. A reload therefore brought back yesterday's harness beside yesterday's model with nothing reconciling them.
- The rule now lives in one arbiter (`reconcileModelForHarness`) driven by an effect keyed on `[model, harness]`, not in a guard bolted onto each writer. That form is deliberate: **an effect is the only one that sees the mount restore**, which has no click for a setter wrapper to intercept, and it cannot be bypassed by a writer added later. This is the same lesson R-169 recorded about `|| list[0]` — a rule enforced per call site is a rule the next call site will not have.
- **A local model selected before switching to Codex survived the switch.** `getModelHarness` returned `"any"` for local ids while its own doc comment said local was reachable "via Claude Code" — naming one CLI. `create_terminal` refuses `harness=codex` with `provider=local` outright, so `"any"` was a false claim about the server and the pair spawned a guaranteed failure. OpenRouter is the only genuine `"any"`. A unit test asserted the wrong value, so the suite stayed green while pinning the defect.
- **The server now refuses a Claude model under the Codex harness**, the twin of the existing `provider=local` refusal. `_CODEX_MODEL_RE` is an injection guard, not a namespace check: `claude-opus-5` is alphanumeric, hyphenated and quote-free, so it matched and the command was built. Implemented as a *negative* check (ids beginning `claude-`, plus the bare `sonnet`/`opus`/`haiku` aliases) — a positive allowlist of Codex ids would drift the day OpenAI ships a model, which already happened to the retired `gpt-5.4` entries. It runs before the charset regex so a long-context id like `claude-opus-5[1m]` gets the actionable message rather than "Invalid Codex model", and it is scoped to `provider="anthropic"` so codex-over-OpenRouter — a supported combination — is untouched.
- The Inspector's model list is harness-filtered. It writes straight into the workspace default, so leaving it unfiltered put an unrunnable model one click away and the reconciler would then undo the choice.

### Notes
- Codex panes still show `▲0 · $0.00` and their scrollback still cannot reveal the conversation. Neither is a Studio terminal defect: measured against codex-cli 0.153.4, Codex never enables the alternate screen, repaints the viewport with absolute cursor addressing, emits no carriage returns, and hands the terminal almost nothing — the transcript lives in its own buffer, reachable with `PgUp` and `Ctrl+T`. Codex does write a full transcript to `~/.codex/sessions/**/rollout-*.jsonl`, which Studio does not yet read; wiring that up is what would restore both the history surface and the token/cost figures. See `NOTE-172` on the board.

## [2.0.0] - 2026-08-07

### Fixed — the reason this is a major version
- **The desktop app now ships the frontend it was built with.** The Tauri window is a thin webview over the sidecar's HTTP server (`frontendDist: "http://localhost:8420"`), so the UI a user sees is the copy PyInstaller froze into `cockpit-server.exe` — not `frontend/dist` on disk and nothing inside `claude-cockpit.exe`. The build ran PyInstaller before vite, so **1.32.0 and 1.33.0 both served the previous release's interface.** Every existing check passed: `check-version-sources.mjs` compared package.json, tauri.conf, Cargo.toml, both lockfiles and `dist/`, and all of them genuinely agreed — none of them is the bundle that gets served. Upgrading from 1.x therefore delivers two releases of interface work that never actually shipped.
- `web/verify_sidecar_bundle.py` — extracts `frontend_dist/index.html` back out of the onefile archive and compares **bytes** against `frontend/dist/index.html`. A timestamp check is not a substitute: rebuilding the sidecar makes it newer than `dist/` while still carrying stale contents, so mtime goes green on exactly the broken build. Proven to fail against the known-bad 1.33.0 sidecar before being trusted.

### Security
- **Browser-origin guard over every HTTP route and the terminal WebSocket** (`origin_guard.py`). The server authenticates none of its routes and binds loopback, but loopback is not a trust boundary against a browser — any page a user visits can reach it. Two independent clauses: an Origin allowlist (the drive-by/CSRF case) and a loopback `Host` check, which is the only thing that stops DNS rebinding, because under rebinding the browser believes it is same-origin and sends no `Origin` header at all. The WebSocket uses a stricter rule deliberately — a browser always sends `Origin` on a handshake, so an absent one there means "not the UI" and is refused before `accept()`.
- A refused origin is told apart from a dead backend (`wsDiagnose.js`). Both look identical to a browser (`onclose(1006)`), and the remedies are opposite: waiting fixes a dead backend and never fixes a refused origin.

### Fixed
- **Starting a second server no longer kills the first one's sessions.** PID and child-PID files are now port-scoped; they used to be one fixed path shared by every server started from `web/`, which made the file a cross-instance channel — a dev run or test rig read the live server's tracked child PIDs and `cleanup_orphans()` killed them at startup.

### Changed
- **Renamed: Claude Cockpit → Plexar Studio**, including the repository (`claude-cockpit` → `plexar-studio`) and the Plexar mark across every icon slot.
- Repository slimmed for publication: internal planning, QA and architecture-rationale documents are no longer tracked.

## [Unreleased]

### Removed
- **Chat, entirely.** The embedded Chat destination is gone: `components/chat/` (14 components), `chat_runner.py`, `chat_store.py`, `chat_boundary.py`, `chat_boundary_check.py`, every `/api/chat/*` route, the `chat` rail destination, the `chat.{root, root_choice}` settings keys, and 28 test modules. This is a removal, not a deprecation — no flag and no stub. Chat ran the same `claude` CLI that Studio's terminals run, with a read-only tool set, so it was a strictly weaker version of the surface next to it; the interaction belongs to `plexar-chat`, a separate product with a separate trust model.
- `resolve_chat_model_env` and the picker's `local:<provider>:<model>` id scheme, which existed only to route a Chat turn to a local engine. Terminals are unaffected — `pty_manager` has always used its own `<provider>::<model>` scheme and calls the shared local resolvers directly.

### Preserved deliberately
- **No user data was deleted.** `~/.plexar-studio/chat.sqlite3` and `chat-workspace/` are left exactly where they are. Removing a feature must not remove the record of what was said.
- `app_paths.STUDIO_MARKERS` still names `chat.sqlite3` and `chat-workspace`. Those strings are how the data-directory resolver recognises an existing Studio install; removing them would change which directory a machine's usage and pricing history resolves to.
- The app-wide ban on `window.prompt`/`confirm`/`alert` and its structural test, extracted to `__tests__/NoNativeDialogs.test.jsx`. The rule was pinned in a chat test file but was never chat's.
- `voice_service.py`, `/api/voice/*` and the `voice.*` settings keys — a separate subsystem chat merely called. It now has **no UI renderer**; it is backend-only until something surfaces it.

## [1.31.0] - 2026-08-04

The subtraction release. Two vendored subsystems leave, one live transport is
rewired, and a settings pane that nobody could reach without landing on nothing
gets its default fixed. **Net −6,746 lines across 63 files.**

MINOR, not patch: T11 deletes a vendored subsystem and changes where LM Studio
traffic physically goes. A patch number would understate that.

### Removed
- **The lane broker, entirely.** `web/lane_broker/`, the managed-broker
  lifecycle, the service-identity fingerprint, `GET /api/local/status`,
  `/api/local/{id}/queue`, `/traces`, `/trace/{id}`, `/metrics/timeseries`, the
  legacy `/api/local/queue`, the `queue` and `traces` capabilities, the Engine
  queue table and the Reports ▸ Traces tab. No flag, no stub, no disabled
  control. **Nothing in Studio queues.**
  - **What observation was lost was measured BEFORE deleting, and it was zero
    real data:** `jobs.jsonl` absent in both data homes, `/traces` `{"count":0}`,
    `/metrics?window=lifetime` `runs_total: 1` — and that one run was a test
    fixture. No real LM Studio run was ever recorded through it.
  - Per-run token and cost recording never went through the broker
    (`lmstudio_proxy._record_local_run` → `usage.sqlite3`) and is untouched.
- **Spill, entirely** — the policy, not the broker: `/config/spill`, `/spills`,
  `spills.jsonl`, both `--spill-*` flags, both server proxies, the `spill`
  capability, `SpillPolicy.jsx` and `DepthWaitPanel.jsx`. It was inert three
  ways and nobody ever experienced it working; this is not a fix.
- **Settings ▸ General & startup and ▸ Permissions & safety**, with their nav
  entries and the settings keys they bound. A third candidate pane was
  **refused, not deleted** — it is what a cold open lands on, and removing it
  would have left Settings opening onto nothing.
- The Lane broker card from Settings ▸ Providers, which was drawn as a peer of
  five providers when it was a property of exactly one. All three controls it
  offered were already declared not-enforced against their own values.

### Changed
- **LM Studio talks to LM Studio.** `lmstudio_proxy.py` now posts directly at
  the provider's `management_url` (`:1234`) instead of hopping through the
  broker. The `X-Lane-Class` / `X-Client-Id` / `X-Agent-Id` headers went with
  it — the broker was their only reader. **Attribution is unaffected:** it rides
  the session-scoped URL (`/shim/lmstudio/s/{terminal_id}`), which is what
  `_record_local_run` keys on.
- `DEFAULT_SETTINGS_SECTION` re-points to `providers`, so a cold open with no
  stored pane id resolves to a pane that still exists.
- The `health` route keeps its `broker` key, permanently
  `{applicable: false, reachable: null}`. The shape already said "there is no
  broker here"; dropping the key would be a breaking change to say what it can
  already say.

### Fixed
- **Reports ▸ Tools: the tool list painted into the coverage note.** The defect
  was the CARD's `flex-shrink`, not the rows. The "recorded since <date>" note
  is the load-bearing half — tool events only exist from 2026-07-30, so a
  30d/all range legitimately undercounts — and it was the half being obscured.
- A latent breadcrumb/label bug in the settings `layout` path, made reachable
  by the pane deletion above.
- An unstable effect dependency in the re-sourced health poller that hung
  AppShell. Caught by the suite before commit, not after.

### Preserved deliberately
- `providers.lane_broker.*` stays in `settings.json` AND in `DEFAULT_SETTINGS`.
  Unknown keys survive a read, and removing a persisted setting is a decision
  about the user's file rather than about this code. Nothing reads them.
- `~/.plexar-studio/lane-broker/`, including `jobs.jsonl` and `spills.jsonl`,
  is left on disk untouched. Removing a feature must not remove the record.
- **LM Studio support stays**, as a plain direct provider. Not deprecated, not
  notice-flagged.

### Notes
- Tests were **rewritten to pin the new truth, not deleted to go green.** The
  `plexar-provider` health test was inverted: it used to assert LM Studio went
  not-ok when the broker died; it now asserts health ignores `_broker_get`
  entirely, with the stub still raising to prove it.
- `_broker_get` survives as a fossil NAME on the generic provider-GET helper
  that also reads vLLM and Prometheus. Renaming it is a separate sweep.

## [1.30.0] - 2026-08-03

The rename release, plus a section boundary that finally matches what the
sections claim to own. Seven changes Len has never seen ship together here.

### Changed
- **The product is called Plexar Studio.** 265 renderable sites across 46
  frontend files stop saying "Cockpit". Tiers 1 and 2 of S25.
- **Reports takes the past.** Engine ▸ Requests -> Reports ▸ Traces and
  Engine ▸ Logs -> Reports ▸ Logs. Engine keeps Live / Models / API. The rule
  was already written in Engine's own header — Settings owns intent, Reports
  owns the past, Engine owns now — and two tabs were on the wrong side of it.
  Nothing was deleted; the trace card is exported and shared, so the two
  surfaces cannot drift.
- Providers settings render as three rows of two rather than six stacked
  blocks (S-PAIRS), and every view now resets its own boundary (S21).

### Fixed
- **The Logs tab claimed no log endpoint existed. One always had.**
  `GET /api/logs` tails the rotating file with secrets redacted, and a viewer
  for it already shipped in Settings ▸ Diagnostics. Reports ▸ Logs now renders
  the real tail. An empty state is only honest if the reason it gives is true.
- Reports ▸ Local engine no longer blanks the whole tab when the engine
  refuses a credential (S-CRASH).
- Reports ▸ Tools' long tail was wrong three ways (S-TOOLS), and the Traces
  pointer named an Engine tab that has never existed (S-TRACES).

### Kept honest
- Moving the trace panel MOVES AN EMPTY PANEL. The lane broker ships in shadow
  mode so no job is ever queued, and a trace is written per queued job; Plexar
  does not publish traces at all. The copy explaining that renders WITH the
  panel, and a test fails if it stops. Consolidation did not turn a recorder on.

### Identifiers deliberately UNCHANGED
`com.claude-cockpit.app`, the `cockpit-server` sidecar, 204 `COCKPIT_*` env var
references and 90 `cockpit-*` localStorage keys are compatibility surface with
an existing install and with the updater. Renaming any of them would present as
data loss on first launch. `scripts/gate_s25_rename.py` freezes that census and
fails if it moves in either direction.

## [1.3.9] - 2026-07-12

### Added
- **Support link.** A "Support" button in the sidebar's resources footer opens the BITS service desk (https://desk.boord-its.com) in the default browser. Uses the existing `/api/open-url` external-open path (Tauri-safe), with a `window.open` fallback.

## [1.3.8] - 2026-07-07

### Added
- **OpenRouter integration.** Sessions can now run through [OpenRouter](https://openrouter.ai) instead of the Anthropic subscription:
  - Key management UI: a key icon in the top bar opens the OpenRouter settings modal — paste a key, "Save & Test" live-validates it against OpenRouter (showing remaining credits) before saving, "Remove key" falls back to any `OPENROUTER_API_KEY` environment key. Keys are stored server-side in `~/.claude-cockpit/config.json` (UI key takes precedence over the environment) and are only ever returned masked.
  - New API endpoints: `GET/POST/DELETE /api/settings/openrouter`.
  - Provider spawn lever: `POST /api/terminals` accepts `provider` (`"anthropic"` default / `"openrouter"`) and `providerModel` (an OpenRouter slug). OpenRouter sessions are spawned with the routing environment (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_MODEL`) instead of `--model`; every session object now includes `provider`.
  - Model picker: a new "OpenRouter" group (DeepSeek V4 Pro, Qwen3 Coder Next), disabled with a hint until a key is configured. Effort and Fast controls are disabled for OpenRouter models (the backend skips them). In-session model switching excludes OpenRouter entries (switching can't change provider).
- Pane headers now show the model's display label instead of the raw model id (long OpenRouter slugs no longer overflow the pill), in both docked panes and popout windows.

### Fixed
- Pane rename now applies instantly (optimistic update, rolled back if the server rejects it) instead of the header sitting on the old name for up to 5 seconds while the Claude-side `/rename` sync waited for the session to go idle.

### Security
- Anthropic-provider sessions now strip any inherited `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from the child environment, so a machine-global OpenRouter config can never silently reroute a subscription pane.
- The OpenRouter key never appears unmasked in any API response or log line.
- `node_modules` build caches and the `web/.cockpit-child-pids` runtime file are no longer tracked by git.

## [1.3.7] - 2026-07-01

### Added
- Per-session actions in the terminal pane header: a Stop button (appears while the session is busy, sends Esc to interrupt) and a "More actions" menu with Rename, Compact context, Clear conversation (with confirm), Export transcript (Markdown download), live model switch, and Fast mode.
- Session renaming: double-click the pane header name or use the actions menu; optionally syncs the name into the Claude Code session via `/rename`.
- New API endpoints: `PATCH /api/terminals/{id}` (rename), `POST /api/terminals/{id}/interrupt`, `POST /api/terminals/{id}/command` (allowlisted slash-command injection, idle-gated), `GET /api/terminals/{id}/export` (Markdown transcript).

### Changed
- **BREAKING:** The server now binds `127.0.0.1` (localhost) by default instead of `0.0.0.0`. The server has no authentication, so the old default exposed filesystem browsing, file upload, and process spawning to the local network. To restore network access, set `HOST=0.0.0.0` explicitly — a startup warning is logged when binding a non-loopback address.
- Channel (V3) lead output is now delivered to all workers concurrently; one slow worker no longer delays the others.
- Large-message relay file handoff no longer blocks the event loop.
- Migrated FastAPI startup/shutdown from the deprecated `on_event` API to a lifespan handler.

### Added (continued)
- A toast now announces when a bridge or channel ends, with the reason: turn limit reached (with counts), task completed (BRIDGE-DONE), stopped by user, or failed (error-styled). Previously the pane glow just disappeared silently.

### Fixed
- `_kill_process_tree` no longer crashes with a NameError when psutil is unavailable — the missing-dependency path now degrades gracefully.
- Terminal rendering corruption (interleaved/garbled lines in long sessions): the terminal fit calculation no longer overestimates pane size by the container padding, popped-out windows now respect the zoom level instead of a hardcoded font size (and follow live zoom changes from the main window), zoom-triggered refits are hardened against deferred layout, and minimize/restore triggers a refit. Dimension updates are deduplicated before being sent to the PTY.
- Cockpit-spawned Claude sessions no longer show "Auto-update failed: claude.exe in use" — the auto-updater is disabled per spawned session (`DISABLE_AUTOUPDATER=1`), since it can never win the file replace while multiple sessions share claude.exe. Update Claude Code manually when needed.
- Autonomous bridge (V2) and channel (V3) no longer stall silently when a session's first reply lands before the JSONL watcher attaches — the watcher now starts from a pre-kickoff offset snapshot.
- Manual relay (V1) now returns 409 when either session is already in an active bridge or channel, preventing interleaved writes to the same terminal.
- The Bridge dialog now disables sessions that are already in an active bridge or channel instead of failing after Send.
- `lucide-react` moved from devDependencies to dependencies (production-only installs previously failed to build).

### Internal
- Added ruff lint configuration and cleaned up all Python lint findings; silent exception handlers now log per project convention.
- `npm audit` vulnerabilities resolved (13 → 0, dev-only chains).

## [1.3.1] - 2026-04-12

### Changed
- Removed stale "MCP" references from `pty_manager.py` and `server.py` output-buffer docstrings. The ring buffer and `get_output_buffer()` are still in active use by the REST history/resume endpoint; only the comments referenced the long-retired cockpit MCP server.

## [1.3.0] - 2026-04-10

### Changed
- Reverted to terminal-only UI — removed chat mode components (ChatInput, ChatPane, HistoryPanel)
- History browsing moved into Sidebar with cross-project session scanning
- TerminalPane now handles chat-mode toggle, file drops, and input routing internally
- PTY write chunking reduced from 8KB to 400 bytes to prevent winpty paste truncation
- Inter-chunk sleep reduced from 10ms to 0 (winpty drains fast enough)

### Fixed
- Sidecar crash from invalid regex backreference in session state tracker
- WebSocket pong timeout removed — sessions no longer freeze when app is idle/minimized/locked

## [1.2.0] - 2026-04-07

### Fixed
- History panel workdir fallback and session state tracking
- Bypass history restore on session resume
- Removed broken remote control button from chat header
- Fixed system tag hiding in chat view
- XML tag stripping for remote control commands

### Added
- Documented known issues with `/remote-control` and `/rc` in chat mode

## [1.1.0] - 2026-03-30

### Removed
- **Orchestrator layer** — `cockpit_mcp.py`, `workspace_manager.py`, `workspace_watcher.py`, `WorkspacePanel.jsx`, `HubView.jsx`, all `/api/workspaces/*` endpoints, orchestrator session type, hub mode
- `marked` and `watchdog` dependencies

### Added
- Chat UI foundation — JSONL-powered conversation view with markdown rendering
- History panel for browsing past Claude Code sessions
- Tool call grouping and message bubble components
- Remote control button in chat header
- Consecutive tool-only assistant message merging

### Changed
- PyInstaller spec updated to remove `cockpit_mcp.py` reference

## [1.0.0] - 2026-03-29

### Fixed
- **MCP server not starting in desktop app** — `cockpit_mcp.py` was missing from the PyInstaller bundle `datas`, so the generated MCP config referenced a non-existent file in the `_MEIPASS` directory. Claude CLI would silently fail to start the MCP server.
- MCP config now copies the script to the temp config directory instead of referencing the `_MEIPASS` path, making it robust across dev and bundled modes.

### Changed
- New app branding: neon eye/code-bracket logo replaces hexagon icon across all locations (Tauri icons, favicon, TopBar)
- Ctrl+C now copies selected text to clipboard instead of sending interrupt; Ctrl+C without selection still sends `\x03`
- Ctrl+V / Ctrl+Shift+V paste from clipboard into terminal
- Idle session timeout disabled by default (`IDLE_TIMEOUT=0`) — sessions no longer self-close after 2 hours

### Removed
- Token/cost display removed from status bar (regex-based parsing was unreliable — matched arbitrary numbers/dollar amounts in terminal output)

### Fixed
- PTY write/read operations now have timeout protection (5s write, 10s read) to prevent session lockups from zombie processes
- Failed PTY writes mark session as dead immediately instead of silently failing
- Pane drag-and-drop reordering broken by file-drop handler calling `stopPropagation()` on all drags — now only intercepts actual file drops, letting pane-swap events bubble to the parent wrapper

## [0.2.18-alpha] - 2026-03-24

### Added
- Linux and macOS PTY support via `unix_pty.py` (`UnixPtyProcess` implementing the `PtyProcess` ABC using `ptyprocess`)
- `get_backend()` now routes to `UnixPtyProcess` for `linux` and `darwin` platforms
- Platform-aware working directory picker (`/api/browse` returns `["/"]` root on Linux/macOS)
- 38 new tests for backend factory routing, ABC compliance, and non-blocking read contract

### Changed
- PATH construction in `create_terminal()` is now platform-aware (`os.pathsep` throughout; Linux/macOS prepends `~/.local/bin` and `/usr/local/bin`)
- MCP config path validation accepts POSIX absolute paths on Linux/macOS (with `shlex.quote` for injection safety)
- `pywinpty` dependency is now Windows-only; `ptyprocess` added for Linux/macOS

## [0.2.0-alpha] - 2026-03-15

### Open Source Release
- Licensed under AGPL-3.0
- Added LICENSE, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md
- Added GitHub issue templates (bug report, feature request) and PR template
- Release artifacts distributed via GitHub Releases (removed from git history)
- Repository cleaned from 164MB to 295KB via git-filter-repo
- Added project management skills: /review-pr, /audit-repo, /triage-issues
- Updated README with download links, platform notice, contributing section
- Added license fields to pyproject.toml, package.json, Cargo.toml

### Auto-Update (Desktop)
- Tauri updater plugin with signed NSIS artifacts
- Checks for updates on startup via GitHub Releases (latest.json)
- In-app toast notification with "Install & Restart" button
- Signing keypair generated, builds produce signed update bundles

### UI
- MCP Servers button in sidebar links to official registry
- Disabled Tauri drag-drop interception so web file drop works in desktop app

### Added (Stability Sprint — 2026-03-14)

- Structured logging (cockpit.server, cockpit.pty loggers)
- Health check endpoint (GET /health)
- Orphaned process cleanup on startup (psutil)
- PID file for crash detection
- Session reconciliation on backend restart
- React ErrorBoundary component
- Toast notification system for API errors
- WebSocket heartbeat (ping/pong every 30s)
- Max session limit (configurable, default 8)
- Idle session timeout (configurable, default 2h)
- Upload directory size limit (200MB)
- Python test suite
- GitHub Actions CI pipeline
- CLAUDE.md project conventions

### Changed
- Replaced all print() with structured logging
- Tightened CORS (explicit methods/headers instead of wildcards)
- Graceful shutdown with upload cleanup and PID file removal
- Version bumped to 0.2.0-alpha

### Fixed
- Bare `except Exception: pass` blocks now log errors
- Stale localStorage sessions after backend crash

### Security
- SECRET_KEY warning on non-localhost with default value
- Tauri CSP (was null, now restrictive)
