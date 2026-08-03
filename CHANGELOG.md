# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [Unreleased]

### Removed
- **Chat, entirely.** The embedded Chat destination is gone: `components/chat/` (14 components), `chat_runner.py`, `chat_store.py`, `chat_boundary.py`, `chat_boundary_check.py`, every `/api/chat/*` route, the `chat` rail destination, the `chat.{root, root_choice}` settings keys, and 28 test modules. This is a removal, not a deprecation — no flag and no stub. Chat ran the same `claude` CLI that Studio's terminals run, with a read-only tool set, so it was a strictly weaker version of the surface next to it; the interaction belongs to `plexar-chat`, a separate product with a separate trust model.
- `resolve_chat_model_env` and the picker's `local:<provider>:<model>` id scheme, which existed only to route a Chat turn to a local engine. Terminals are unaffected — `pty_manager` has always used its own `<provider>::<model>` scheme and calls the shared local resolvers directly.

### Preserved deliberately
- **No user data was deleted.** `~/.plexar-studio/chat.sqlite3` and `chat-workspace/` are left exactly where they are. Removing a feature must not remove the record of what was said.
- `app_paths.STUDIO_MARKERS` still names `chat.sqlite3` and `chat-workspace`. Those strings are how the data-directory resolver recognises an existing Studio install; removing them would change which directory a machine's usage and pricing history resolves to.
- The app-wide ban on `window.prompt`/`confirm`/`alert` and its structural test, extracted to `__tests__/NoNativeDialogs.test.jsx`. The rule was pinned in a chat test file but was never chat's.
- `voice_service.py`, `/api/voice/*` and the `voice.*` settings keys — a separate subsystem chat merely called. It now has **no UI renderer**; it is backend-only until something surfaces it.

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
