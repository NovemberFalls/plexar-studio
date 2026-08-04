# Plexar Studio

Multi-session Claude Code manager with a FastAPI backend and React/Vite frontend, packaged via Tauri for desktop distribution. Licensed under AGPL-3.0.

## Project Structure

```
claude-cockpit/
  web/
    server.py          # FastAPI app (port 8420), terminal CRUD, WS + bridge routes
    pty_manager.py     # PTY session manager (cross-platform via pty_backend.py)
    bridge_manager.py  # Peer-bridge: V1 manual relay + V2 autonomous loop between two sessions
    logging_config.py  # Structured logging setup (cockpit.server, cockpit.pty, cockpit.bridge)
    tests/             # Python test suite (pytest + pytest-asyncio)
    frontend/
      src/
        App.jsx        # Root component, all session state, session reconciliation, bridge + workflows polling
        components/    # Sidebar, TerminalPane, TopBar, StatusBar, NewSessionDialog, BridgeModal,
                       # ErrorBoundary, Toast, HexGrid, OnboardingModal, StateIcon, PopoutTerminal,
                       # WorkflowsPanel
        __tests__/     # Frontend tests (vitest)
        hooks/         # useTheme (active)
        themes/        # themeData.js (2 dark palettes + per-token --cc-* overrides)
      src-tauri/       # Tauri desktop wrapper (Rust, NSIS installer)
  # Legacy directories (static/, src/cockpit/) removed in v1.3.0 hygiene sweep
```

## How to Run

**Backend:**
```bash
cd web && python server.py
```
Starts FastAPI on port 8420. Requires Python 3.11+.

**Frontend dev server:**
```bash
cd web/frontend && npm run dev
```
Vite dev server on port 5174, proxies API calls to the backend.

**Tauri desktop (dev):**
```bash
cd web/frontend && npm run tauri:dev
```

## How to Test

**Python backend tests:**
```bash
cd web && python -m pytest tests/ -v
```

**Frontend tests:**
```bash
cd web/frontend && npm test
```

**Lint frontend:**
```bash
cd web/frontend && npm run lint
```

## Conventions

- **CSS hover utilities:** Use CSS hover classes (`hover-bg-surface`, `hover-color-red`, etc.) defined in `index.css` instead of JS `onMouseEnter`/`onMouseLeave` handlers for performance.
- **Python logging:** Use `cockpit.server`, `cockpit.pty`, and other `cockpit.*` loggers via `logging.getLogger()`. No `print()` statements.
- **React components:** Sidebar sub-components (`SessionItem`, `LocationNode`, `LocationContextMenu`) are module-scope, not nested inside parent components. They receive all dependencies via props to avoid React identity/re-render issues.
- **Themes:** `themeData.js` ships **two** palettes, both dark — `va-night` (Visual Assist Night) and `cockpit-blue`. There are no light variants. (This doc previously claimed "20 themes: 10 palettes × dark/light", which was never true; `themeData.test.js` has always asserted exactly 2. The design handoff inherited the wrong number from here.) Theme context comes from the `useTheme` hook; `applyThemeToDOM` is the **single writer** of every `--cc-*` property. Per-token user overrides and named user palettes layer on top — see "Design tokens & overrides" below.
- **Error handling:** No bare `except Exception: pass`. Always log with `exc_info=True`.
- **User errors:** Surface via Toast notifications, not console.log.

## Architecture

- **PTY backend abstraction:** `pty_backend.py` provides `get_backend()` which selects the platform-appropriate PTY implementation: `winpty.PtyProcess` (dev mode on Windows), `conpty.PtyProcess` (bundled/Tauri mode on Windows), or `unix_pty.UnixPtyProcess` (Linux/macOS). `pty_manager.py` calls this factory to spawn `claude --model {model}` processes.
- **SessionStateTracker:** Parses ANSI escape sequences from terminal output to track session activity state (idle, busy, waiting, starting).
- **WebSocket bridge:** `/ws/terminal/{id}` proxies between the browser and ConPTY, with ping/pong heartbeat every 30 seconds.
- **Session model:** `{ id, name, terminalId, model, status, workdir }` -- workdir supported end-to-end from frontend through REST API to ConPTY cwd.
- **Startup cleanup:** Orphaned claude.exe processes killed via psutil, PID file for crash detection, session reconciliation with frontend.
- **Graceful shutdown:** Terminate sessions → cleanup uploads → delete PID → log.

## Featured cell vs focus (3/5/7 layouts)

`featuredIndex` and `focusedIndex` are **separate on purpose**. They used to be one variable, and because `focusedIndex` is set by `onMouseDownCapture`, **clicking into a terminal to type reshuffled the grid** — the owner reported it as "whatever we click becomes the primary". Re-deriving `paneOrder` from `focusedIndex` would silently reintroduce that; a test pins the separation.

- `focusedIndex` — set by click/focus, drives the **Inspector** only ("follows focus"). Unchanged behaviour.
- `featuredIndex` — a **slot** index (not a session), changed only by an explicit act: dropping a pane into the featured cell, or `Make featured` in the pane `Ellipsis` menu (the keyboard-reachable path). Persisted to `cockpit-featured-slot` beside `cockpit-layout`/`cockpit-flip`, since those three together are one "how my grid is arranged" decision — restoring two of the three is a partial restore, which is more confusing than restoring none.
- **Three index spaces, and conflating any two is the trap:** *slot* = position in `activeIds`; *cell* = position in `gridLayout.areas` (`areas[0]` is the big one); `paneOrder` lists **slots in cell order**, so a slot's cell index is `paneOrder.indexOf(slot)` and `paneOrder[0]` is by definition the featured slot. Slot 0 is featured ONLY when `featuredIndex === 0` — the drop-overlay predicate is `cellIndex === 0`, never `idx === 0`, and the tests use `featured = 1` so they cannot pass on that coincidence.
- **A drop writes no featured state.** `swapPanes` moves the session into the target *slot*; when that slot is the featured one the dragged session is now featured and `featuredIndex` never moves. Moving `featuredIndex` to the drop target instead would relocate the big cell and reshuffle every other pane — the bug in a new costume.
- **`paneOrder` is read exactly ONCE in the render body**, for the grid placement style. The loop still iterates fixed slots keyed on `session.id`, so a featured change is CSS-only and cannot remount a terminal (which would drop live scrollback). A refactor to `paneOrder.map(...)` *would* remount; a test counts the occurrences to catch it.
- Closing the featured session leaves the big cell as an empty drop target rather than auto-promoting a neighbour — auto-promotion is a reshuffle the user did not ask for. `removeSession` nulls the slot and never compacts, so slot indices are stable across a close and need no clamp there; a test pins that.

## Drag-and-Drop Architecture

Two independent DnD systems share the same drop targets — be careful not to let one swallow the other:

- **File drops** (`onDrop` / `onDragOver` on the terminal area div in `TerminalPane.jsx`): uploads files via `/api/upload`. Must call `stopPropagation()` to prevent the pane-swap handler in `App.jsx` from also firing.
- **Pane swaps** (`onDrop` / `onDragOver` on the wrapper div in `App.jsx`): swaps `activeIds` array positions via `swapPanes()`. Triggered by dragging a pane header.
- **Session placement** (same wrapper handlers): drags a session from the sidebar into a specific slot via `placeSession()`.

**Critical rule:** The terminal-area file-drop handlers (`handleDrop`, `handleDragOver` in `TerminalPane.jsx`) MUST check whether the drag contains actual files BEFORE calling `stopPropagation()`. If `stopPropagation()` runs unconditionally, pane-swap drags are silently swallowed and the overlay never appears. Check `e.dataTransfer.types.includes("Files")` in `handleDragOver` and `e.dataTransfer.files.length` in `handleDrop` before intercepting.

## Browser-origin guard (`origin_guard.py`) — TWO clauses, neither optional

Studio binds a listener on `127.0.0.1` and authenticates none of its 104 routes.
**Loopback is not a trust boundary against a browser** — any page the user visits can open
a connection to it. `origin_guard` is the guard; it is wired in exactly **two** places
(the `@app.middleware("http")` in `server.py`, and an explicit check in the
`/ws/terminal/{id}` handler) and it enforces two independent clauses:

- **Origin allowlist** — stops the drive-by/CSRF case. A cross-origin `fetch` always
  carries `Origin`; a same-origin one does not, so **absent Origin is ALLOWED on HTTP**.
  CORS never prevented this class: it stops a foreign page *reading* the reply, not
  *causing* the side effect (a process spawn, a credential overwrite, `/api/shutdown`).
- **Loopback `Host` clause** — stops DNS rebinding, and it is the ONLY thing that does.
  Under rebinding the browser believes it is same-origin and therefore **sends no `Origin`
  header at all**, exactly like the real UI. The allowlist cannot see the attack. This was
  measured the hard way: the gate's first draft asserted rebinding with
  `Origin: http://evil.example`, which the allowlist rejects on its own, so deleting the
  Host clause reddened nothing — a watch-to-fail arm that was passing for the wrong reason.
  **An `Origin == Host` equality check also passes rebinding**, since the two agree; that
  is why this is not the shape `csrf.py` uses elsewhere.

**The WebSocket uses a DIFFERENT rule and that difference is deliberate.** A handshake is
not subject to CORS at all, and a browser **always** sends `Origin` on one — so on `/ws/*`
an absent Origin means "not the UI" and is **REFUSED**. The only clients that exist are
xterm.js in `TerminalPane.jsx` and `PopoutTerminal.jsx`; nothing in `tests/` connects.
The check runs **before `accept()` and before the terminal lookup** — completing the
upgrade and closing afterwards hands out a free id oracle (`101`-then-`4004` for a miss vs.
`101`-and-silence for a hit), and `active_consumer`'s "latest connection wins" means a
second socket **supersedes the real pane** on a terminal already in use.

**A refused WebSocket gets an HTTP `403` on the handshake, NOT a `101` then close `4403`**
— measured at the wire, and the opposite of what this section first claimed. Starlette
converts a `close()` before `accept()` into a handshake rejection, so the `4403` code and
its reason are **discarded, never delivered**. That is the stronger outcome and is kept on
purpose: a refused origin never holds a live socket, not even for an instant. **The cost is
real and is not fixed:** a browser reports a failed handshake as `onerror` + `onclose(1006)`,
so the client cannot tell "origin refused" from "server down" and a stale bundle silently
retries instead of saying "reload the app". Surfacing that is a frontend change (probe
`/api/version` on a `1006` and read the `403`) and it is **open work, not shipped**.

- **`Origin: null` is refused, never treated as absent.** A sandboxed iframe or `data:`
  document is a real browser origin that is definitively not ours.
- **`/shim/*` and `/v1/*` get NO exemption, and need none.** The `claude` CLI reaches them
  via `ANTHROPIC_BASE_URL` at `127.0.0.1` with no Origin — it satisfies both clauses
  already. An exemption would be a hole a page could aim at.
- **`localhost` and `127.0.0.1` normalise to one string.** `PopoutTerminal.jsx` connects
  **direct** to `ws://localhost:8420` from a `:5174` dev page — the one legitimately
  cross-origin caller in the codebase, covered by the `COCKPIT_DEV_ORIGINS` default
  (`http://localhost:5174,http://127.0.0.1:5174`). Defaulted, not hardcoded: the Vite port
  drifts, and hardcoding means the next port change is a code change.
- **`HOST=0.0.0.0` stands the Host clause down**, deliberately — binding the LAN is an
  explicit operator choice (`main()` already logs a loud warning) and refusing every
  request would refuse what they just asked for. The Origin allowlist still applies.
- **Tests must present a loopback `base_url`.** `http://test` sends `Host: test` and 403s
  every route; all 44 client constructions use `http://127.0.0.1:8420`.
- Every negative arm in `tests/test_origin_guard.py` has a **positive twin**, and
  `test_allowlist_is_actually_read` exists so a hardcoded refuse-everything build cannot
  pass the gate — the failure shape this repo keeps hitting.

## Key Constraints

- **Windows primary PTY:** ConPTY/winpty backend for Windows; `unix_pty.py` via ptyprocess for Linux/macOS.
- **Max 8 sessions:** Default concurrent session limit is 8, configurable via `MAX_SESSIONS` env var.
- **No idle timeout:** Idle timeout is disabled by default (`IDLE_TIMEOUT=0`). Dead sessions (process exited) are still purged after 30s.
- **PTY timeout protection:** Writes timeout after 5s, reads after 10s — prevents session lockups from zombie processes.
- **Per-session write serialization:** Every `TerminalSession` carries its own `asyncio.Lock`. The entire body of `write_pty_async` runs under `async with session.write_lock:`, so user keystrokes (from the WS handler) and bridge/channel injection (bracketed-paste chunks) never interleave their bytes inside the ConPTY pipe. Different sessions remain fully parallel.
- **Ctrl+C handling:** `TerminalPane.jsx` has a `customKeyEventHandler` — Ctrl+C copies when text is selected, sends `\x03` only when no selection.
- **Ctrl+V / paste handling:** A capture-phase `paste` DOM listener on the terminal container handles paste BEFORE xterm's own listener fires (avoiding double-paste / auto-submit). Image items in `clipboardData.items` are uploaded via `/api/upload` and the returned path is injected via `xterm.paste(path)` (NOT raw `ws.send`) so it is bracketed-paste wrapped — raw injection clobbers in-progress input in interactive prompts. Plain text likewise uses `xterm.paste(text)` so xterm wraps it in bracketed-paste sequences when the PTY is in that mode (Claude Code is, by default). The same image-paste path applies in `PopoutTerminal.jsx`. The `customKeyEventHandler` just returns `false` for Ctrl+V to suppress xterm sending the raw `\x16` character.

## Build & Release

- **Build order matters:** Frontend → PyInstaller → copy sidecar to `src-tauri/binaries/` → Tauri. A stale sidecar = broken desktop app.
- Release artifacts (exe files) are NOT committed to git — they are distributed via GitHub Releases.
- Use `/push-cockpit` to build, commit source, push, and upload to GitHub Releases.
- Use `/build-cockpit` for local builds only.
- Tauri targets NSIS only (MSI doesn't support alpha pre-release identifiers).
- **Auto-update:** Desktop app checks GitHub Releases for `latest.json` on startup. Tauri does NOT auto-generate `latest.json` — the push skill builds it from the `.nsis.zip.sig` file. Builds must be signed with `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` env vars. Signing key at `C:\Code\.tauri\claude-cockpit.key` (password-protected).
- **CRITICAL build lesson:** Always copy the fresh PyInstaller exe to `src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe` BEFORE building Tauri. A stale sidecar = "Internal Server Error" on desktop launch.
- **Tauri webview:** `dragDropEnabled: false` in tauri.conf.json so the web-native file drop handler works in the desktop app.

## PTY injection — paste and submit are TWO writes

Every programmatic injection (bridge V1/V2/V3, `/rename` sync, `POST /api/terminals/{id}/command`) goes through `bridge_manager._paste_and_submit`. **Never call `_wrap` and append `\r` yourself** — that is the bug this contract exists to prevent.

- **The submit CR must not ride in the paste write.** Claude Code's TUI buffers stdin on `\x1b[200~` and flushes on `\x1b[201~`; a CR arriving in that same read is consumed as *pasted content* (a newline inside a paste inserts a line, it does not submit). Symptom: the message lands in the peer's composer and sits there until a human hits Enter — bridges never advance. `_wrap` therefore returns the bracketed-paste block ONLY, and `_paste_and_submit` writes the bare CR as a second write after `_SUBMIT_DELAY` (1.0s). It returns True only if BOTH writes land; a paste without its submit is a failed relay, not a delivered one.
- **Chunk boundaries must never bisect an escape sequence.** `write_pty_async` used to slice every payload over 200 bytes at blind byte offsets, so a cut could land inside `\x1b[200~`/`\x1b[201~`. A split marker means the receiving TUI never enters paste mode, so every embedded newline submits separately and one message arrives as several mangled fragments. Now: single write up to `_SINGLE_WRITE_MAX` (64KB — every realistic paste and bridge message), and above that `_split_preserving_escapes` walks each boundary back out of any escape it landed in. ConPTY byte-drop protection (chunking + `_INTER_CHUNK_DELAY`) survives as a safety valve for genuinely huge pastes rather than being the normal path.
- **Gotcha in the splitter:** `[` is 0x5B, *inside* the 0x40–0x7E CSI final-byte range. Searching for a terminator from `tail[1:]` makes every CSI sequence look complete the moment its `[` arrives. The terminator scan must start after the `[` introducer.
- Tests pin all of this: `tests/test_pty_escape_chunking.py` (splitter properties) and the `pastes()` / `paste_only()` helpers in `tests/test_bridge_manager.py`, which assert one submit per paste. Bridge test modules zero `_SUBMIT_DELAY` via an autouse fixture — without it the suite pays a real second per injection.

## Anthropic subscription limits (`anthropic_usage.py`)

The 5-hour / weekly utilization bars from `claude /status` ▸ Usage, surfaced in the TopBar `Gauge` pill (`UsageLimitsPill.jsx`). These are **real server-reported percentages**, not an estimate derived from tracked tokens.

- **Source:** `GET https://api.anthropic.com/api/oauth/usage`, Bearer token + `anthropic-beta: oauth-2025-04-20`. The token is the CLI's own, read from `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (override with `COCKPIT_CLAUDE_CREDENTIALS`). **This data is NOT in the session JSONL** — the JSONL carries token counts only, no quota information at all, so do not go looking for it there again.
- **The token never reaches the browser** (same stance as the local-provider registry): `GET /api/anthropic/usage` returns derived percentages and reset timestamps only. Always 200 — an inline panel must not blank on an HTTP error.
- **Never refresh the token.** The credentials file holds a refresh token belonging to the CLI; rotating it invalidates the CLI's copy and logs the user out of their own terminal. On 401 the module reports `reason: "expired"` and tells the user to run any `claude` command.
- **`available: false` + a `reason` is the honesty guard** (`no_credentials` | `expired` | `unreachable` | `bad_response`). The UI renders the reason, **never an empty bar** — a 0% bar and "we could not read your usage" look identical and mean opposite things. Likewise a limit whose upstream `percent` is `null` is **dropped, not coerced to 0**.
- A wrong-shaped 200 is rejected (`bad_response`), mirroring the local-broker service-identity stance. Successes cache 60s; **failures are not cached**, so a transient blip does not pin the panel to "unavailable" for a minute. `?refresh=true` bypasses the cache (the popover does this on open).

## Peer Bridge

Two running cockpit sessions can exchange messages via `bridge_manager.py`:

- **Manual relay (V1):** one-shot. The Bridge icon in any pane header opens `BridgeModal`. Pick another running session, choose "Relay my latest reply" (auto-fetches via `GET /api/terminals/{id}/latest-assistant`) or a custom message + preset chips, click Send. Backend waits for the target to be idle (`_wait_for_idle_simple`; returns `{ok: False, "...busy..."}` if it never settles), then wraps in bracketed paste and injects to the peer's PTY with a `[From session "<name>"]:` prefix.
- **Typing-quiet gate:** both `_wait_for_idle` (V2 / V3) and `_wait_for_idle_simple` (V1) additionally block injection while the target session's user is actively typing. The WS handler stamps `session.last_user_input_time = time.monotonic()` on every keystroke; the gate refuses to advance until at least `_TYPING_QUIET_WINDOW` (1.0s) of typing-quiet has elapsed. Combined with the per-session write lock, this prevents the "bridge stutter" failure mode where bracketed-paste chunks fragment user input mid-burst.
- **Large-message file handoff:** all relay modes route through size-aware injection. Messages larger than `_RELAY_INLINE_MAX` (2048 bytes) are NOT pasted inline — ConPTY's input pipe drops bytes under a large fast burst, truncating the message. Instead `_maybe_file_handoff` writes the full text to a temp relay file (`_RELAY_DIR`, created via `tempfile.mkdtemp(prefix="cockpit_relays_")`) and injects a compact prompt naming the file path; the receiving session reads it. Relay files are GC'd opportunistically after `_RELAY_FILE_MAX_AGE` (10 min) on each new handoff and the whole dir is removed by `cleanup_relay_dir()` on graceful shutdown.
- **Autonomous relay (V2):** the Auto tab in `BridgeModal` labels the initiating session "Lead" and the receiving session "Worker". Shows a neon-red warning panel + a confirm-twice gate. On confirm, both sessions get a framed kickoff prompt, and `bridge_manager` watches each side's JSONL via `tail_jsonl`. Each new assistant turn is auto-relayed to the peer (idle-gated, bracketed-paste wrapped). Bridge ends on: turn cap (`max_turns`, default 4), `BRIDGE-DONE` sentinel in any reply, user clicks Stop, either session dies, or PTY write fails.
- **Channel (V3):** the Channel tab in `BridgeModal` enables hub-topology N-session coordination (1 lead + N workers). User picks a lead (radio) and workers (checkboxes) then provides a kickoff prompt. The lead receives all worker output; the lead's output is broadcast to all workers. `channel_manager` (singleton in `bridge_manager.py`) manages `_ChannelRecord` instances and spawns N+1 relay tasks. Channel ends on: turn cap (`max_turns`, default 6), `BRIDGE-DONE` sentinel from any participant, user Stop, session death, or write failure. Lead pane shows "CHANNEL LEAD · turn X/Y · Stop" overlay (orange glow via `@keyframes channel-active-glow`); worker panes show "CHANNEL WORKER · turn X/Y · Stop".
- **Conflict guard:** `/api/bridge/auto` and `/api/bridge/channel` both return 409 if any requested session is already in an active bridge or active channel (`channel_manager.member_ids()`).
- **Active indicators:** App.jsx polls `GET /api/bridge` and `GET /api/bridge/channel` every 3s. Bridge panes show pulsing red glow; channel panes show pulsing orange glow.
- **Routes:** `GET /api/terminals/{id}/latest-assistant`, `POST /api/bridge/manual`, `POST /api/bridge/auto`, `DELETE /api/bridge/{id}`, `GET /api/bridge`, `POST /api/bridge/channel`, `DELETE /api/bridge/channel/{channel_id}`, `GET /api/bridge/channel`.

## Workflow Status Panel

Cockpit surfaces a per-session view of in-flight Claude Code `Workflow` tool invocations (the harness's dynamic multi-agent runtime). The panel is read-only — Cockpit does not orchestrate workflows; it just observes what's running inside each session.

- **Data source:** `GET /api/terminals/{id}/workflows` reads the session's JSONL via `jsonl_watcher.read_all_messages`, extracts `tool_use` entries whose `tool_name == "Workflow"`, pairs each with its matching `tool_result` (by `tool_use_id`), and returns the 20 most recent — sorted newest first.
- **Response shape (per workflow):** `{tool_id, name, description, args, script_preview, script_path, started_at, completed_at|null, is_error, status: "in_progress"|"completed"}`. The `script_preview` is truncated by `_summarize_tool_input` (max ~200 chars) and is intentionally NOT surfaced in the UI — workflow scripts can carry sensitive prompts.
- **UI:** `WorkflowsPanel.jsx` renders a popover with one row per workflow: status dot (pulsing accent = in progress, green = completed clean, red = completed with error), name, description, and relative time. The popover is opened by a `Workflow` icon in the `TerminalPane` header that is conditionally rendered when `workflowSummary.count > 0`; an inline badge shows `inProgressCount` when nonzero.
- **Polling:** `App.jsx` runs a single shared `setInterval` (3s) that fans out one `fetch` per active session and stores summaries in `workflowsByTerminal`. Errors are silently swallowed — workflow polling is best-effort background work.

## Local Providers

Cockpit surfaces a view of one or more local inference providers (LM Studio, vLLM, Plexar). Providers are registered server-side; the browser never learns their base URLs (SSRF stance). Each provider declares its capabilities (metrics, models, health, ...) and scope (`local` | `remote`).

### THE LANE BROKER IS REMOVED ENTIRELY - 2026-08-04, T11

**Nothing in Studio queues. There is no lane broker, no shadow mode, no queue depth, no traces.** `web/lane_broker/` (the vendored broker), `start/stop_managed_broker`, the service-identity fingerprint, `GET /api/local/status`, `/api/local/{id}/queue`, `/traces`, `/trace/{id}`, `/metrics/timeseries`, the legacy `/api/local/queue`, the `queue`/`traces` capabilities, `cockpit_provider_queue_depth`, the Engine queue table, the Reports > Traces tab and the lane strip's shadow note are all gone. **No flag, no stub, no disabled control.**

**The owner's ruling, verbatim:** *"we need to remove the queue system... lmstudio is the only reason its there and thats bad design. So, that should be both lanebroker and spill entirely ripped out. Poor design suggestion or need on myside built by ignorance for a problem we solved by changing providers."*

**WHY IT WAS THE WRONG SHAPE, MEASURED 2026-08-04.** The broker was a single-flight queue, and a queue is a property of ONE transport rather than a Studio-wide service:

- **vLLM must never be queued in front of.** Measured against the live rig at `127.0.0.1:8760` (`max_num_seqs: 1`): three concurrent 192-token requests returned in 1.27s / 2.50s / 3.73s - a ~1.23s staircase, i.e. served strictly one at a time - with **zero refusals: no 429, no 503, no 529.** A four-way probe at 8 tokens likewise returned 4x200. **vLLM does not push back on concurrency; it accepts everything and silently makes you wait**, so a front-end queue adds a second wait in front of the engine's own and serialises the continuous batching the GPU was bought for. Plexar's own `INVARIANT-NOQUEUE` says the same: every limit is a rejection (429 + `Retry-After`), never a hold.
- **LM Studio was the only genuine case, and it stopped being one.** The broker's docstring asserted `max_concurrent=1 by law`; LM Studio has served requests in parallel since 0.4.0, default 4. **That number was never re-measured after the premise changed** - the defect DEC-36/R38 governs.
- **Neither Ollama nor OpenRouter was ever in the registry.** OpenRouter is a credential/reroute path (`pty_manager` swaps `ANTHROPIC_BASE_URL`); Ollama exists only as unread `settings.json` fields. Neither was ever broker-fronted, so a "Studio-wide" queue never covered them.

**WHAT WAS LOST, STATED PLAINLY:** the broker's own telemetry - `jobs.jsonl`, its `/metrics` aggregate, its trace index, and the `by_session`/`by_agent`/`by_lane_class` breakdowns. **Measured before deleting: that store was empty.** `jobs.jsonl` was absent in both data homes, `/traces` returned `{"count":0}`, and `/metrics?window=lifetime` reported `runs_total: 1` - a single request from a T9 test fixture. **No real run was ever recorded.** Per-run token/cost recording for LM Studio was never the broker's: it lives in `lmstudio_proxy._record_local_run` -> `usage.sqlite3` and is untouched.

**LM Studio traffic now goes DIRECT.** `lmstudio_proxy.py` posts at the provider's `management_url` (`:1234`). The `X-Lane-Class` / `X-Client-Id` / `X-Agent-Id` headers went with the broker - it was their only reader - and attribution is unaffected because it rides the session-scoped URL (`/shim/lmstudio/s/{terminal_id}`), which is what `_record_local_run` keys on.

**`providers.lane_broker.*` (base_url, autostart, concurrency) is STILL IN `settings.json` and in `DEFAULT_SETTINGS`, deliberately left.** Unknown keys survive a read, and removing a persisted setting is a decision about the user's file rather than about this code. Nothing reads them.

### Architecture

- **Provider registry (`server.py`):** Module-level `_PROVIDERS` dict; entries carry `id`, `label`, `kind` (e.g. `lmstudio`), `scope`, `broker_url`, `management_url`, `auth`, and `capabilities` list. Optional env `COCKPIT_PROVIDERS_FILE` (path to JSON `{"providers":[...]}`) replaces the default at startup; on parse failure, logs a warning and keeps the default.
- **Discovery endpoint (`GET /api/local/providers`):** Returns `{"providers":[{id, label, kind, scope, capabilities}]}` — URLs and auth NEVER sent to the browser. `ProviderPicker.jsx` consumes this; persists selection to `localStorage` key `localProviderId`.
- **Provider-keyed routes (`server.py`):** All new endpoints follow the pattern `/api/local/{provider_id}/{endpoint}`. Unknown provider → 404 `{"error":"unknown provider"}`. Missing capability → 404 `{"error":"capability not available"}`. Each provider declares which capabilities it supports.
  - `GET /api/local/{provider_id}/metrics?window=` (cap `metrics`) — window validated against `_LOCAL_METRICS_WINDOWS`
  - `GET /api/local/{provider_id}/models` (cap `models`) — proxies management endpoint; returns `{"reachable":true,"models":[{id, type, arch, quantization, state, max_context_length, loaded_context_length, ...}]}` (missing fields → null); unreachable → 503 `{"reachable":false,"reason":"unreachable"}`. **A REFUSAL IS NOT UNREACHABILITY** (S9, 2026-08-02): `_mgmt_get` raises `HTTPError`, which is a subclass of `Exception`, so a bare `except Exception` reported a rig that was UP and REFUSING THE CREDENTIAL as `reachable:false` — a false claim about machine state, and byte-identical to a dead rig. `401`/`403` now return **200** `{"reachable":true,"authorized":false,"reason":"unauthorized"|"forbidden","action":…}`, other HTTP errors 502 `reason:"refused"`. Three states, never collapsed; pinned by `tests/test_models_auth_states.py`.
  - `GET /api/local/{provider_id}/health` (cap `health`) — management `/models` probe; returns 200 always: `{"broker":{applicable:false, reachable:null}, "provider":{reachable, models_loaded}, "ok":<provider reachable>}`. The `broker` key is KEPT and permanently not-applicable: `applicable:false` already meant "there is no broker here", which is now true everywhere, and dropping the key would be a breaking shape change to say what the shape can already say.
- **Legacy route:** `/api/local/metrics` delegates to the default provider. It now **404s** — the default provider is LM Studio, whose `/metrics` was the broker's aggregate. The route still delegates honestly; the provider behind it simply no longer promises metrics.

### Spill — REMOVED ENTIRELY, 2026-08-03

Spill was one number per lane class: the seconds of predicted wait above which the broker **refused locally** with `503 {spill:true}` so the caller could escalate to a paid frontier API. It is gone — the policy, the comparison in `_queued_forward`, `/config/spill`, `/spills`, `spills.jsonl`, the two `--spill-*` CLI flags, both server proxies, the `spill` capability, `settings/SpillPolicy.jsx` and `settings/DepthWaitPanel.jsx`. **No flag, no stub, no disabled control.**

**The owner's ruling, verbatim: _"let's just remove spill I'll read the rest later."_** He ruled after S27's measurement: the escalation Anthropic's subscription path allows is available only to a caller presenting as Claude Code, so Studio spilling on its own behalf would circumvent a control enforced deliberately. Rather than pick between the two remaining shapes, the feature goes.

**Removing it changed nothing a user could observe except the vanished controls.** Spill was inert three ways — shadow was the shipped default so `_queued_forward` never ran; nothing in Studio ever consumed the 503 (`lmstudio_proxy.py` had no spill branch); and there was no escalation target at request time. **Do not read this removal as a fix. Nobody ever experienced spill working.** (The rest of the broker followed one day later — see the T11 note above.)

Two consequences, both deliberate:

- **A request that would have been refused then WAITED**, with no depth limit and no wait ceiling. **That is moot as of T11:** there is no queue at all, so nothing waits behind anything in Studio. What a busy backend does is now entirely the backend's business — and for vLLM the measured answer is that it queues internally and never refuses.
- **Three surfaces lost a state rather than gaining a fake one.** The lane strip's fill bar, the Engine rail's `pressure` dot and Engine ▸ Live's "Interactive pressure" meter all measured *distance to the spill trigger*. With no trigger there is no fraction, so they were removed rather than re-based on an invented threshold (R38 / DEC-36).

`~/.plexar-studio/lane-broker/spills.jsonl` and `jobs.jsonl` are **left on disk untouched**, the same stance as Chat's data: removing a feature must not remove the record. Nothing reads them; nothing deletes them.

### Managed vLLM provider (coexists with LM Studio)

- Cockpit can own a vLLM container's lifecycle. OPT-IN, default OFF. (It is now the ONLY managed kind: the lane broker was the other one and it is removed.)
- **Ownership precedence** (`_vllm_managed_intent`): `COCKPIT_MANAGED_VLLM` when **explicitly set** wins in BOTH directions (`"0"` is a hard off, `"1"` a hard on); otherwise `settings.json` `providers.vllm.managed`. The module global is now `os.getenv(...)` with **no default**, so "unset" is distinguishable from `"0"` — that distinction is what lets the Settings toggle mean anything. The startup **double-bind verdict overrides both**: if something is already answering the port, Cockpit is not the owner regardless of config, and never starts/stops/restarts a container it did not launch.
- **The settings read is memoized for the process**, deliberately. A live read would let a Settings save flip ownership mid-process, and nothing re-runs `_refresh_vllm_model_control()` on a settings write — so `model-control` would silently disagree with reality and offer a restart for a container Cockpit never started. Ownership can therefore only change at the two moments that already refresh capabilities: import, and the double-bind probe in `start_managed_vllm`.
- **`GET /api/local/vllm/ownership`** (always 200) → `{effective, configured, external, source: "env"|"settings"|"external", pending_restart, requires_restart, env_set, reason}`. `configured` is a LIVE read, `effective` the frozen startup answer, so the UI can distinguish **"saved, restart Cockpit"** from **"an external vLLM holds the port, a restart will not help"** — different situations, different fixes.
- **`providers.vllm.launch_command` is never read.** Cockpit builds its own docker argv from the vLLM env vars. The Settings field says so rather than implying it is the command that runs.
- Upgrade note: a machine with `providers.vllm.managed: true` already in `settings.json` and no env var will now attempt to launch a container on next start. That is the fix, but it is a behaviour change.
- vLLM is served DIRECT on its own port (default `8001` via `COCKPIT_VLLM_PORT`) and never behind a queue — see the T11 note above for the measurement. It coexists beside `lmstudio-local`; the user picks via ProviderPicker.
- `start_managed_vllm()` / `stop_managed_vllm()` in server.py: double-bind guard (if something already answers `/v1/models`, external wins and Cockpit only observes), best-effort (never blocks startup), WSL-wrapped `docker run -d` on Windows, `docker rm -f` on shutdown.
- Env knobs (all read at startup, with defaults): `COCKPIT_MANAGED_VLLM=0`, `COCKPIT_VLLM_PORT=8001`, `COCKPIT_VLLM_MODEL=/models/Qwen3-Coder-30B-A3B-AWQ` (path inside the container), `COCKPIT_VLLM_SERVED_NAME=qwen3-coder-30b-awq`, `COCKPIT_VLLM_IMAGE=vllm/vllm-openai:latest`, `COCKPIT_VLLM_GPU_UUID` (empty→`--gpus all`; set→`--gpus device=<uuid>` PLUS container env `CUDA_DEVICE_ORDER=PCI_BUS_ID`/`CUDA_VISIBLE_DEVICES=<uuid>`, since WSL exposes all GPUs to the container even with `--gpus device=UUID`), `COCKPIT_VLLM_MODELS_DIR` (empty→no bind-mount), `COCKPIT_VLLM_MAX_MODEL_LEN=49152` (worker cards run up to ~55K tokens), `COCKPIT_VLLM_MAX_NUM_SEQS=2` (kept low so CUDA-graph memory fits alongside desktop GPU use — 16 OOMs on a 24GB card), `COCKPIT_VLLM_GPU_UTIL=0.90`, `COCKPIT_VLLM_TOOL_PARSER=qwen3_coder`.
- Managed vLLM is launched with tool-calling enabled (`--enable-auto-tool-choice` / `--tool-call-parser`, default `qwen3_coder`) so the `claude` CLI can drive it agentically — verified live that vLLM 400s on every tool call without these flags — and a 49152-token context window for worker cards.
- Measured rationale: on a 3090, Qwen3-Coder-30B-A3B (MoE) on vLLM beat LM Studio 3.4x single-stream and ~12x batched (see backlog/02-vllm-serving.md). Quality crown pending team bench.

### Service shape validation

LM Studio's dev server answers unknown paths with **"200 anyway" + an error body**, so shape validation is still required: a wrong-shaped 200 from a proxied read returns `502 {reachable: true, compatible: false}`.

**The service-identity FINGERPRINT is gone (T11).** `_detect_service` read `/queue` to answer three questions at once - is the queue empty, is the thing at this address really the lane broker, and does Studio therefore own the port. All three were questions about a broker. With no broker there is no port to own and no service to disambiguate from it; `/health` and `/models` are the surviving checks, and they ask about the backend the user actually selected.

### UI components & polling

- **`ProviderPicker.jsx`:** Dropdown fed by `GET /api/local/providers`; selection persisted to `localStorage`. Remote-scope entries show a small "remote" badge. Renders nothing while list is empty/unfetched.
- **`LocalModelsPanel.jsx`:** List from `/models` — id, quantization, arch, max context, state. Loaded models highlighted. Consumed by `engine/EngineModels.jsx`.
- **Broker metric vocabulary** (still the contract for `/metrics`, even though no component currently renders the definitions — see "Retired surfaces"): run = one completion call; prompt = distinct `X-Trace-Id`; session = `X-Client-Id`; agent = `X-Agent-Id`. tps = completion tokens ÷ wall clock (includes prompt-processing) — a floor on decode speed. The `by_session` / `by_agent` / `by_lane_class` breakdowns are still served by the broker but have **no renderer** since `LocalMetricsPanel` was deleted; do not describe them as a shipped UI feature.
- **`engine/EngineView.jsx` (the real home):** full-page view on the rail's `Cpu` destination — tabs `Live | Models | API`. Engine owns **now**; configuration lives in Settings ▸ Providers and history in Reports. (`Requests` went with the broker in T11: it rendered the queue table and the trace tree, both broker-only. `Logs` moved to Reports in S26.)
- **TopBar `Cpu` indicator (quick glance only):** the live lane readout + tps in the pill, sourced from the ENGINE's own running/waiting counters (never a lane queue — there is none). No config or reporting in the popover. Enablement is `localStorage` flag `cockpit-local-enabled`.
- **Token honesty:** when runs exist but token totals are zero, the Tokens tile reads "not reported" (streaming clients must send `stream_options.include_usage`) instead of a misleading 0.
- **Polling (`App.jsx`):** Controlled by the `localEnabled` gate. Health 3s; metrics 10s (only when the capability exists). Best-effort errors silently render offline state. The 3s **queue** poll and the machine-global `/api/local/status` poll both went with the broker (T11); the health poll that replaced the latter is PER-PROVIDER, which is the more truthful shape — the dot sits beside a provider you chose.
- **`/models` has EXACTLY ONE poller, app-wide — `hooks/useLocalModels.js`.** Do not add another; read the store instead. It was previously fetched by three independent owners (App's busy-marker effect, `EngineView`'s slow poll, and `modelCatalog`'s all-provider registry sweep), which for a 3-provider setup meant 26 requests/min, 4 of them to a provider that could not answer. Now 11/min.
  - Module-scoped store + `useSyncExternalStore`, so one-poller-app-wide is **structural**, not a convention someone has to remember. Entry points: `useLocalModelsPoller` (call ONCE, from App), `useLocalModelsCatalog` (the registry, for `modelCatalog.js`), `useLocalModels(providerId?)` (read-only subscriber, never fetches).
  - One timer, per-provider due times computed from **last-read time** (not a precomputed `dueAt` — a stored due time does not shrink when a period shortens 10s→2s, so the fast cadence never fires and the load spinner hangs). Selected+watched provider: 10s, or 2s while a write is in flight. Others: 20s. **No `models` capability: never asked.**
  - `watching = showLocalBroker || defaultsOpen` — when neither Engine nor the model picker is on screen and no write is in flight, the selected-provider poll stops entirely.
  - A provider that does not advertise `models` renders as **"Does not publish a model list"**, NOT as offline. `/models` returns `404 {"error":"capability not available"}` for those, and reporting that as unreachable is a false claim about a healthy backend.
  - **A provider that is UP but REFUSED the credential stays VISIBLE in the picker** with `UNAUTHORIZED_NOTE` / `FORBIDDEN_NOTE` (`modelCatalog.js`), because `buildLocalGroups` OMITS unreachable providers and omission is exactly what "down" looks like. Two links carry this: `readProvider` must keep the server's body on a non-2xx (it used to substitute a bare `{reachable:false}`, discarding the reason), and the `authorized === false` branch is checked BEFORE the omission rule. 401 and 403 get different notes — telling a user whose key is valid to re-enter it sends them to fix the one thing that is not broken.
  - The busy marker is app-wide, so a load started from Engine ▸ Models lights the TopBar picker's spinner and vice versa. Busy clears when the polled entry reports `state === "loaded"`; the write's own `finally` covers unload.

## JSONL Discovery (usage tracking)

`pty_manager._get_jsonl_path` locates the Claude Code JSONL a session writes to, in three strategies: (1) known `claude_session_id`, with staleness re-lock after in-terminal `/resume`; (2) new-files-since-spawn diff; (3) **resume fallback** — a resumed conversation's JSONL predates spawn, so Strategy 2 never finds it; when the session has produced output, claim the most recently *written* JSONL not claimed by another live session (`_rediscover_jsonl`). Without Strategy 3, resumed sessions kept `claude_session_id=None` and showed `▲0 · $0.00` forever. An idle pane never claims a file (mis-attribution guard, bug #15 family).

## Tool-call tracking (`tool_events`)

Tool calls ARE available in Claude Code's JSONL — `jsonl_watcher.py` parses `tool_use` content blocks. `usage_tracker` originally read `message.usage` and discarded `message.content`, so tool calls were a **storage** gap, not a data gap. Closed 2026-07-30.

- **Table:** `tool_events(uuid, block_index, terminal_id, jsonl_path, ts, model, tool_name, workdir)`, PK `(uuid, block_index)`. One assistant message can carry SEVERAL `tool_use` blocks, which is why `uuid` alone cannot be the key. With `INSERT OR IGNORE`, this is what makes re-ingest **idempotent** — the watcher re-reads from stored offsets routinely, so a non-composite key would silently inflate counts over time and look like real activity.
- **`_parse_line` returns `(usage_row | None, tool_rows)`.** Its old early-return on a missing `message.usage` was silently discarding every tool call on a tool-only turn. Usage and tool extraction are now independent; neither can short-circuit the other. A `tool_use` block with no `name` records `"unknown"` — a call still happened.
- **`/api/usage/report`** carries real `kpis.tool_calls`, `sessions[].tool_calls`, and `by_tool[{tool_name, calls, share}]`.
- **`tool_events_since`** (earliest tool event across the whole store, or `null`) is the honesty guard: tool events only exist from 2026-07-30 on, so a `30d`/`all` range spanning older history legitimately undercounts. The UI must say "recorded since <date>" when that timestamp falls **inside** the selected range, and nothing when the range starts after it. `null` means "not recorded yet", which is NOT the same as "zero tool calls".
- **`previous: {available, kpis}`** is the equal-length preceding window, computed through the same `_window_rows`/`_compute_kpis` path as the current period so the two are comparable. `available: false` for `range=all` and for a genuinely empty prior window — the UI then renders no delta rather than a fabricated one.
- Known asymmetry: `tool_events` dedupes on `uuid` alone while `usage_events` dedupes on `(jsonl_path, message_uuid)`. If a JSONL were copied to a second path, tool calls would dedupe correctly and usage rows would double-count. That is a pre-existing weakness on the usage side.

## Plexar-vLLM (the model side) — `plexar_client.py`

**Naming, settled 2026-07-31, refined 2026-08-02:** **Plexar is the PLATFORM.** This
application is **Plexar Studio**, the dev tool (formerly Claude Cockpit). **Plexar-vLLM
is the MODEL side**, the provider — renaming to **Plexar-LLM**, sequenced behind the
Google auth cutover (see `backlog/11`). A future **Plexar Chat** is a separate product
with a separate trust model; it is NOT this app with tools disabled. The registry id is therefore `plexar-vllm`, not `plexar`; the app does not name a provider after itself. Note two things that deliberately did NOT change: `kind: "plexar"` (the backend family) and the `plexar` key in `/v1/models` entries (Plexar-vLLM's own **wire format** — renaming that would break parsing). A stored `localProviderId` of `plexar` self-heals because `ProviderPicker` falls back to a real provider when the id is unknown; pinned by `ProviderPicker.staleId.test.jsx`, so no migration was needed.

Plexar (`C:/Code/Personal/plexar-vllm`) owns vLLM container lifecycle and publishes a **fixed-bind** OpenAI-compatible gateway (default `127.0.0.1:8760`, override `COCKPIT_PLEXAR_URL`). Cockpit points at one address forever; model swaps and restarts happen behind it.

- **THE GATEWAY BEING UP IS NOT THE ENGINE BEING ABLE TO SERVE.** Plexar answers `200` on `/v1/models` while the engine behind it is restarting or dead — a stable address is the whole product. Judging it by "did the HTTP call succeed" reports a dead engine as healthy, which is what Cockpit used to do. `/api/local/{id}/health` therefore carries an `engine` block (`{serving, total, state, available, reason, action, eta_seconds}`) for Plexar. **`ok` still means REACHABILITY for every provider** — callers that care whether work can run read `engine.available`. Worst state wins across instances.
- **Plexar's model catalog nests its state envelope under a `plexar` key**, not a top-level `state`. `_normalize_plexar_raw_model` maps `serving|degraded` → `loaded` and keeps `reason`/`eta_seconds` for everything else. This also exposed that a plain OpenAI catalog (vLLM direct) has no state field at all and was counting **0 loaded models while serving**.
- **Nothing is broker-probed (T11).** `health` still carries a `broker` key and it is permanently `{applicable: false, reachable: null}` — which is what it always meant for a broker-less backend, now true of every provider. The key is kept rather than dropped: the shape already says "there is no broker here", so removing it would be a breaking change to state something it can already state.
- **Routes:** `GET /api/local/{id}/instances` · `/reports?range=` · `/gpus` · `/timeseries?range=&bucket=&instance_id=`, all capability-gated, all 200-with-envelope (a bad `range`/`bucket` is still a loud **400** — an envelope is for a service that failed, a bad param is the caller's fault).
- **`timeseries` is a SEPARATE capability from `reports`.** `reports` returns window *totals*; a client wanting history could otherwise only diff repeated polls, which is not history and dies on reload. `timeseries` is stored history: `1h|6h|24h|7d|30d|lifetime` — two ranges *wider* than the summary route's set, hence `TIMESERIES_RANGES` rather than reusing `REPORT_RANGES`. **Cockpit never sends `bucket`** — Plexar derives it from the range and owns the rule that 400s rather than truncate a >720-point series; picking one client-side means re-deriving that rule badly.
- **`urllib.error.HTTPError` is a SUBCLASS of `URLError`.** A bare `except URLError` swallowed Plexar's deliberate 400 and reported a live service as `unreachable` — a false claim about a backend that is up and just said no. `_refused()` catches it first, in both `fetch_reports` and `fetch_timeseries`, and preserves Plexar's stated reason.
- Chart rules the panel must honour, because Plexar goes out of its way to make them expressible: **empty buckets are emitted** (a gap and a zero mean different things), a quiet bucket carries a *measured* `requests: 0` alongside a *null* latency, and a percentile below its sample floor is `null`. So a gauge line BREAKS at a null instead of sloping to the axis, while a measured zero still draws a baseline tick. `truncated` means the range is retention-clipped and is surfaced, not swallowed.
- **Two sources, NEVER merged.** `gateway-requests` = what consumers experienced (exact, real windows). `vllm-prometheus` = what the GPU did (cumulative since engine start, so only `lifetime` is exact). Every figure keeps its `source` and `window_exact` labels through Cockpit; `engine_unknown` is passed through because it is *why* a figure is missing. **Cockpit keeps its own reporting** — Plexar's sits beside it in Reports ▸ Local engine, labelled, never combined into one column.
- **`model-control` was re-added 2026-07-31, and its absence before that was correct.** A capability is a PROMISE the route will answer; while Plexar owned lifecycle and exposed no way to drive it, advertising the capability would have put buttons in the UI Cockpit could not honour. Plexar then shipped `POST /api/instances/{id}/unload` (frees the GPU, **keeps** the declaration) and `/load` (restarts it, no config re-supply) — so the capability follows the routes, not the reverse. **Load/unload only: RESTART is still Plexar's**, because Cockpit still does not own those containers, and `DELETE` is deliberately never called — it forgets the instance entirely, and a destructive verb behind a picker toggle is how config gets lost by accident.
- **Cockpit's control routes are keyed by MODEL; Plexar's are keyed by INSTANCE.** `_plexar_instance_for_model` resolves one to the other via `plexar.instance_id` in the `/v1/models` envelope (carried through `_normalize_plexar_raw_model` and `_MODEL_FIELDS`). Plexar's catalog can legitimately list the same served name twice, so **ambiguity is refused with a 409, never resolved by taking the first match** — those are different engines on different GPUs, and guessing is the class of error that made the old container name a lie. A failed control returns **502, never 200**: a toggle that moves while the GPU does nothing is worse than a visible failure.
- An unloaded instance stays in `/v1/models` as `state: down` — *"a model that is loading is not a model that does not exist"*, and the same reasoning covers unloaded. So the picker shows the full catalog with which entry is live, and `down` must not be normalized to "loaded" or dropped.
### Plexar auth — two independent layers (BREAKING for remote, 2026-07-31)

Plexar now gates **`/api/*`**, not just `/v1/*`, whenever it is proxied. Leaving the control plane ungated was defensible while one credential meant one person past the tunnel; the moment named guest keys existed, every guest held the full control plane and could delete instances. **A remote Plexar with no `COCKPIT_PLEXAR_KEY` now 401s.**

**LOOPBACK IS NOT AUTOMATICALLY CREDENTIAL-FREE — corrected 2026-08-02, this doc said it was.** The previous sentence here read *"Local loopback is unchanged and needs no credential — that is the default and the common case."* That is true of only ONE branch of Plexar's rule, and it is not the branch this machine is on. Measured live: `GET 127.0.0.1:8760/v1/models` with no credential → **401 `unauthorized`**.

The rule is `plexar/reach/auth.py:589` — `if loopback and not config.PROXIED:` grants the free pass. Two conditions, and **`PLEXAR_PROXIED` defeats it**:

- **No key configured at all** → open-local, the whole control plane works with no setup. Plexar's startup interlock guarantees this can only coexist with a loopback bind and no proxy, so nothing off-box can reach it.
- **Loopback bind AND not proxied** → free pass.
- **Loopback bind AND proxied** → **gated, deliberately.** Behind a tunnel the connector dials in from this very machine, so the bind is still loopback while the traffic originated on the internet. Exempting it would leave Cloudflare Access as the single layer and fail open on any misconfiguration of it.

This rig is the third case: `GET /api/status` reports `proxied: true`, `auth_required: true`, `public_url: https://plexar-vllm.boord-its.com`. Plexar's own `/api/reach` prints the loopback `verify_command` **with** an `Authorization: Bearer` header — the provider documents the requirement; only this file disagreed.

**Do not hard-code either answer. `GET /api/status` carries `auth_required` and `proxied`** — read them, the same rule as `capacity_caveat` and `scope_description`. A consumer that assumes "loopback means open" is one tunnel away from being wrong, and the tunnel is not a code change on this side.

- **`plexar_client.auth_headers` sends BOTH, and neither substitutes for the other.** A Cloudflare Access service token (`CF-Access-Client-Id`/`-Secret`) gets a request past the tunnel **and no further** — Access is not authentication for Plexar; a service token alone returns 401. The `Authorization: Bearer plx_…` is the identity. Env: `COCKPIT_PLEXAR_KEY`, `COCKPIT_PLEXAR_CF_CLIENT_ID`, `COCKPIT_PLEXAR_CF_CLIENT_SECRET`. **None reach the browser** (same stance as every provider URL); a test asserts the providers list carries no credential key.
- **Half a service token is not sent at all.** A lone id or secret is malformed rather than partial, and yields a 302-to-login HTML page where JSON was expected — which reads as Plexar returning garbage. Both or neither.
- **`401` and `403` are DIFFERENT and must render differently.** 401 = the credential is wrong or missing. 403 = the credential is fine and the route is not yours. Collapsing them into "auth error" tells a guest to re-enter a key that was never the problem. `_refused()` maps them to distinct reasons (`unauthorized` / `forbidden`). Note Plexar deliberately sends **no `WWW-Authenticate`** on 403, so a correctly signed-in browser is not re-prompted.
- **`GET /api/local/{id}/identity`** (capability `identity`) proxies Plexar's `/api/me`, which is **contracted to answer 200 even unauthenticated** — `authenticated: false` is an answer, where a 401 would merge "wrong credential" and "server down", whose remedies are opposite. `scope_description` and the `scopes` map are the server's prose, rendered verbatim: **never hard-code what a guest may do** (it has already changed once — same rule as `capacity_caveat`).
- A guest key reaches `/v1/*`, `/api/me`, `/api/status`, `/api/reach`, `/api/session`, and `/api/reports/requests` narrowed to its own rows. **`/reports/summary`, `/engine` and `/timeseries` are 403 for a guest** — they carry source-2 figures that cannot be narrowed to one identity, because vLLM's counters do not know who called.
- **Attribution moved.** The reports `client` column now comes from the authenticated identity, not the caller-supplied `X-Plexar-Client` header, which is consulted only for unauthenticated loopback. Cockpit's header is therefore **advisory**, and `Reports ▸ Consumers` is trustworthy for the first time.
- Not built, do not design against: no quotas or rate limits, no per-model permission, no self-service key minting, `owner` is all-or-nothing, and Plexar does **not** read the Cloudflare Access JWT (an Access identity is not a Plexar identity — a deliberate seam, so a human authenticates twice).

- **Cockpit writes NO caveat prose about Plexar's data — the payload states its own bias.** Two honesty gaps were raised in 2026-07-31 review and both were fixed on Plexar's side rather than papered over here:
  - **`container` / `container_reason` are safe to surface** (they were not before). An adopted instance used to keep the name Plexar's *own convention* would have given a container it launched (`plexar-vllm-<id>`), applied to one it demonstrably did not — `docker logs` against it fails. Plexar now asks the daemon which container actually publishes the port. **A null is "could not identify", NEVER "there is no container"** — something is demonstrably answering, which is why it was adopted — so `container_reason` must travel with the null and be shown; dropping it recreates the exact ambiguity the fix removed.
  - **Planner verdicts carry `capacity_caveat` + `capacity_caveat_direction`** (`conservative | none | optimistic`, machine-readable so a consumer can gate without parsing English). **Render the field; never hard-code the warning** — the model was recalibrated twice in two days, and copied prose drifts (the same D1 problem that broke Plexar's own lane file). It is `none` under `--enforce-eager` and is never absent, because "no known bias" is itself worth saying. Cockpit surfaces no planner verdict today, so this is a rule for the surface that adds one, not a shipped feature.

### `vllm-local` is retired (2026-07-31) — deregistered, NOT deleted

`vllm-local` pointed direct at `COCKPIT_VLLM_PORT` (`:8001`). That was the old `vllm-bench` container; it is exited, and Plexar publishes its own containers **loopback-only on a port it allocates**, reachable only through the gateway — deliberately, so nothing bypasses the gateway's auth, its request records, or the in-flight accounting a drain waits on. The direct path is therefore not merely unused, it is structurally impossible to recreate for a Plexar-managed engine.

The two were consequently **never two views of one engine** (which would have argued for deduping them): one is the current architecture, the other is what it replaced. Left registered it is a permanently red provider row — and a row that is always red teaches people to ignore red rows, the same argument `format.js`'s honesty rules make.

- `_VLLM_LOCAL_PROVIDER` is a module constant that `_PROVIDERS` merely references, so `_retire_vllm_local_if_unused()` popping the key **cannot destroy the definition**. The managed container, the restart path, `_vllm_metrics` and models-dir all still work — this is a retirement, not a teardown, and the larger question of deleting that machinery is untouched.
- Two ways back, both explicit: managed intent on (`COCKPIT_MANAGED_VLLM=1` / `providers.vllm.managed` — Cockpit launches that container itself, so the provider *must* exist), or **`COCKPIT_VLLM_DIRECT=1`** for an external direct vLLM Cockpit does not own.
- `tests/conftest.py` calls `_register_vllm_local()` for the whole suite: the eight modules covering that machinery test real, reachable behaviour. The retirement itself is pinned by `test_vllm_local_retirement.py`, which restores the registry afterwards. Registration **order** is no longer pinned anywhere — `test_providers_list_shape_no_urls` keys by id.

## Retired surfaces (do not resurrect; know where the behavior went)

### Chat — REMOVED ENTIRELY, 2026-08-03

The embedded Chat destination is gone: `components/chat/` (14 components), `chat_runner.py`, `chat_store.py`, `chat_boundary.py`, `chat_boundary_check.py`, every `/api/chat/*` route, the `chat` rail destination, the `chat.{root, root_choice}` settings keys, and 28 test modules. **This is a removal, not a deprecation** — no flag, no stub, no dead rail entry.

**The reason, in the owner's words:** *"the embedded studio chat was a feature creep... the usage is all test."* Studio is a multi-session Claude Code multiplexer. Chat ran the same `claude` CLI its terminals already run, with a read-only tool set — **a strictly weaker version of the thing beside it**, and it competed with a separate product (`backlog/12`, `plexar-chat`) that owns that interaction properly.

Two things kept deliberately, and neither is an oversight:

- **`app_paths.STUDIO_MARKERS` still names `chat.sqlite3` and `chat-workspace`.** They are how the resolver recognises an existing Studio data directory and declines to adopt the RIG's `~/.plexar/`. Deleting those strings would change which directory a machine with real `usage.sqlite3` and `pricing.sqlite3` history resolves to. They are load-bearing for a module that has nothing to do with chat.
- **`~/.plexar-studio/chat.sqlite3` and `chat-workspace/` are LEFT ON DISK, untouched.** They hold the user's own words. Removing a feature must not remove the record, and a dropped table is a one-way door. Nothing reads them now; nothing deletes them either.

`voice_service.py`, `/api/voice/*` and the `voice.*` settings keys also survive the teardown — they are a separate subsystem that chat merely *called*. **They now have no renderer** (`VoiceButton.jsx` was chat's), so treat voice as backend-only-and-unsurfaced, exactly like the three broker breakdowns below: do not describe it as a shipped UI feature, and decide it on its own merits rather than by inheritance from this deletion.

Also note `/v1/chat/completions` in `engine/EngineApi.jsx` is **not** this Chat — it is OpenAI's wire path on the inference provider.

### Facelift casualties

`LocalBrokerView.jsx`, `LaneQueuePanel.jsx` and `LocalMetricsPanel.jsx` were deleted in the facelift. Their behavior was re-homed: spill thresholds → `settings/SpillPolicy.jsx` (itself removed 2026-08-03 with the feature), live queue → `engine/EngineRequests.jsx` + `engine/EngineLive.jsx`, reporting → `components/reports/` (the past), models folder → `settings/ProvidersSettings.jsx`. **`EngineRequests.jsx` and `TracesPanel.jsx` are themselves gone as of T11** — the queue table and the trace tree both had the lane broker as their only producer, so `EngineLive` is the surviving live surface.

**One documented behavior lost its renderer and has NOT been re-homed** — treat it as open, not as satisfied:
1. The **`stream_options.include_usage` remediation hint** is gone. Reports correctly never renders a null total as `0`, but the *actionable* half — telling a streaming client how to fix zero-token reporting — has no surface.

**Two entries were CLOSED by T11 rather than satisfied, and the difference matters.** The verbatim **broker metric definitions** (run / prompt / session / agent, keyed off `X-Trace-Id`, `X-Client-Id`, `X-Agent-Id`) and the **`by_agent` / `by_session` / `by_lane_class` breakdowns** were both listed here as renderer-less. They are no longer open work: the broker that defined that vocabulary and served those breakdowns is deleted, and the three headers they keyed on are no longer sent. **Do not rebuild them** — there is no producer.

`RoutingReportingView.jsx` and the whole `components/localReporting/` tree were deleted in a follow-up sweep (16 files); `fmtInt` moved into `components/reports/format.js`. Two casualties worth knowing: `assembleReportingMetrics`'s cross-provider local totals no longer exist anywhere (`EngineLive` is single-provider by design), and `/api/reporting/models` now has **no frontend consumer** — it is only listed as a row in the Engine ▸ API explorer. Also note `components/reports/format.js` and `components/engine/ui.jsx` both export a `fmtInt` with **different behavior** (thousands separators + em dash vs. bare rounding) — deliberate, not an accident; do not "helpfully" dedupe them without deciding which rendering each surface should have.

## Pricing — append-only snapshots, cost frozen at ingest

**Cost must NEVER be recomputed from current prices.** It used to be: `_row_cost`/`_pricing_for` ran at *query* time, so any price change silently re-priced all of history. Owner directive: poll daily, never update history.

- **`pricing_store.py`** owns `app_paths.data_path("pricing.sqlite3")` — `~/.plexar-studio/pricing.sqlite3` today. (This said `~/.claude-cockpit/` until 2026-08-02.) `model_prices` is **append-only** — PK `(model, effective_from)`, `INSERT OR IGNORE` only, **no UPDATE or DELETE anywhere in the module**. A price change is a NEW row with a later `effective_from`. That is the whole mechanism: `price_for(model, at)` filtered by `effective_from <= at` over a monotonically-growing table cannot change its answer for a fixed `at`.
- **`refresh_log`** (source, last_attempt, last_success, …) exists because an unchanged daily poll writes **zero** price rows by design — so `MAX(effective_from)` cannot answer "did we poll today" and the poller would re-poll on every startup forever. It holds no rates, so mutating it cannot move a figure.
- **Daily poll:** `GET https://openrouter.ai/api/v1/models`, `COCKPIT_PRICING_REFRESH_HOURS` (default 24), refreshed at startup only if stale. Best-effort, never blocks startup, cancelled on shutdown. Prices are per-**token** strings → per-Mtok floats. **`"0"` is genuinely free; a missing field is `None`/unknown; a negative is OpenRouter's variable-pricing sentinel → `None`.** Collapsing those into `0.0` either fabricates a cost or hides one. `None` and `0.0` are treated as *different* by the change check, so unknown→free appends a row.
- **Seeds are EPOCH-effective** (`pricing_models.json`, and a projection of `usage_tracker.PRICING`). Stamping them "now" would leave every already-ingested event unpriced at $0. **The first OpenRouter snapshot is "now"-effective, deliberately** — we do not know what OpenRouter charged last month, and back-dating manufactures false precision. Pre-existing OpenRouter turns therefore stay `unpriced` (tokens kept, $0).
- **`usage_events.cost_usd` + `price_source`** are written AT INGEST via `price_for(model, event_ts)`. All six read paths (`session_summary`, `daily_summary`, `summary`, `model_report`, `_compute_kpis`, `range_report`) SUM the stored column. `_compute_kpis` was the sharpest one — it feeds current AND prior period, so a re-price leaked into deltas too.
- **`price_source` ∈ `exact | backfill | unpriced`**, surfaced as `cost_basis: {exact, backfilled, unpriced}` on `/api/usage/report`. `backfill` = priced after the fact (the true rate is unknowable from the DB); `unpriced` = $0 **because no price is known, not because the work was free**. The Reports note is conditional on `backfilled|unpriced > 0` and **tones by proportion** — `--cc-waiting` when the whole window is qualified (the headline figure IS an estimate), muted for a slice.
- Routes: `GET /api/pricing`, `POST /api/pricing/refresh`.

## Spend guardrails (`spend_guard.py`)

Display and enforcement are **separate concepts**. Reports always shows API-equivalent cost; enforcement keys on **real** money only.

- **`spend.*` in `settings.json`:** `mode` (`subscription|api`), `period` (`daily|weekly|monthly`), `monthly_reset_day` 1..28, `caps.{real_usd,equivalent_usd}` (`None` = no cap; `0` is **rejected** — it means "block everything" and is indistinguishable from a mistyped off), `alert_at_percent` 1..100, `block.{real,equivalent}` (opt-in, default off), `enforce_on.{bridges,new_sessions}` (true/false).
- **`real` = OpenRouter always + native Anthropic ONLY when `mode == "api"`.** Under a subscription an Anthropic turn is not money billed, so it lands in `equivalent` alone. Flipping the mode changes what the real cap *covers*, not just whether it enforces. Local is $0 and counts toward neither.
- **`monthly` resets on `monthly_reset_day`, not the 1st** — a Claude subscription resets on the signup anniversary while API billing is calendar-month. Day is capped at 28 so February always honours it.
- **Three refusal rules — the point of the module:**
  1. The UI interlock is **not** a security boundary. The server independently refuses an equivalent block whenever `mode == "subscription"`, even if `settings.json` carries `block.equivalent: true` from an API-billing period.
  2. **Never hard-block on a number we made up.** Untrustworthy pricing (no `openrouter` snapshot at all, or a window that is ≤50% `exact`) DOWNGRADES a block to an alert.
  3. A `None` cap never blocks; `block.*` with no cap is incoherent → caveat, no block.
- **INVARIANT:** if a class's `enforcement_available` is `false`, `caveats` contains a line naming that class and the reason. Enforced by a property test over mode × block × cap × trust × spend, because hand-written cases do not catch the next branch added. `enforcement_available` means "a block the user CONFIGURED cannot fire" — it is `True` when the switch is off, so the UI never paints a warning over a setting nobody made. The raw signal is the separate per-class `pricing_trusted`. **The UI must key its NOT-ENFORCING marker off `enforcement_available`, never `pricing_trusted`.**
- **Enforcement points:** bridge/channel start → **409** with the full `evaluate()` payload; each V2/V3 turn boundary → ends via the EXISTING `_end_bridge`/`_end_channel` termination path (never a second teardown, never mid-write); session create when `enforce_on.new_sessions`. **Interactive typing is never blocked, by design.** Guards **fail open** — a transient DB error must not masquerade as a spend cap.
- `GET /api/spend/status` returns `evaluate(now)`, always 200.

## Settings (`settings.json`) — persistence contract

Server-backed store for every tunable value, added in the facelift's Phase 4. **The UI is not allowed to keep a setting only in `localStorage`** — each field maps to one key in `settings.json`.

- **Location:** `app_paths.data_path("settings.json")` — `~/.plexar-studio/settings.json` today, and `~/.claude-cockpit/` until 2026-08-02 (sibling of `config.json`, which keeps holding the OpenRouter key — secrets never enter the settings blob, so an exported settings file is safe to share). The design handoff guesses `%APPDATA%\ClaudeCockpit\`; that is wrong for this repo. `GET /api/settings` reports the real resolved path so the UI displays truth rather than a guess.
- **Routes:** `GET /api/settings` → `{path, settings}` · `PUT /api/settings` takes a **partial nested patch**, validated all-or-nothing (a single bad value → `400` and *nothing* is written) · `POST /api/settings/reveal` opens the containing folder, always `200` (a failed reveal is a UI inconvenience, not a server error).
- **Store:** `settings_store.py` — `DEFAULT_SETTINGS` deep-merged with disk (disk wins per-leaf); unknown keys on disk are preserved through a read so a newer build's keys survive a rollback. Bool is checked *before* int (`isinstance(True, int)` is True in Python); int/float interchange for float defaults. Bounded keys: `concurrency` 1–8, `gpu_util` 0.05–1.0, `glow_size` 0–48, `max_sessions` 1–16, `retention_days` 1–3650.
- **REPLACE-not-merge leaves (the trap):** `appearance.token_overrides`, `appearance.user_palettes`, and `system.keybindings` are replaced **wholesale** by a patch, deliberately — per-leaf merging would make *deleting* an override or a keybinding impossible. `useSettings.buildPatch` therefore **promotes** any dirty path under those prefixes to the entire dict from the draft (`WHOLE_DICT_PATHS` / `wholeDictPrefixFor`). Sending a narrow leaf for one of them silently destroys every sibling. An empty `{}` is meaningful ("clear them all") and is not the same as omitting the key.
- **Dot-keyed dicts:** keybinding names contain dots (`pane.next`), so `"system.keybindings.pane.next"` is ambiguous with a nested object and leaf addressing is fundamentally unsafe there. The hook degrades to a no-op rather than writing a corrupted map. **A Keybindings page MUST write the whole dict:** `setField("system.keybindings", {...get("system.keybindings", {}), "pane.next": v})`. Token overrides (`--cc-*`, no dots) are fine either way.
- **`useSettings` hook:** fetch-once (settings are *intent*, never polled), dotted-path `get`/`setField`/`deleteField`, `Set`-based dirty tracking, prefix-aware `isDirty` (a group reports dirty when any leaf beneath it is), `save()` PUTs only the minimal patch, `revert()`, `reveal()`. On a `400` the server message surfaces and **the draft is kept**.
- **Persisted but not yet enforced:** the server does not read `max_sessions`, `gpu_util`, `concurrency`, or `retention_days` — those remain env-var driven. Cards carrying them say so; do not imply a stored value is live.

- **NO NATIVE BROWSER DIALOGS.** `window.prompt`/`confirm`/`alert` are banned app-wide and a structural test pins their absence across every source file (`__tests__/NoNativeDialogs.test.jsx`). WebView2 prefixes native dialogs with the page ORIGIN, so `window.prompt("Group name")` put **`localhost:8420 says:`** on screen — a desktop app showing the user its own HTTP port, which made a correct feature look like it was writing to a server. The rule survived the surface that produced it: `ChatDialog.jsx` was the in-app replacement and is gone with Chat, so **a UI needing a prompt or a confirm must build one** — and it must do the thing a native prompt structurally cannot: AWAIT its submit, so a failure is rendered and the dialog stays open instead of having already closed.

## Quick Resume Undo

Closing a pane via X kills the backend terminal but the local session record's `claude_session_id` is captured first. App.jsx then shows a 12-second Toast with an "Undo" action that calls `createSession` with `resumeSessionId: <claude_session_id>` (preferred) or `continueSession: true` (fallback when the session never produced a JSONL).

## Community Management

- **Weekly cadence:** Run `/triage-issues` and `/audit-repo` roughly once a week to review PRs, issues, and repo health.
- **PR review:** Always run `/review-pr {number}` before merging any contribution.
- **User context:** The project owner is new to open-source. When presenting PR/issue summaries, explain in plain English what the contributor wants to change and what risks it poses. Avoid git jargon.
