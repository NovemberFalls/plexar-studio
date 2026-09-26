# Plexar Studio

A desktop workspace for Claude Code and Codex CLI sessions. Run terminals side by side or in a scrolling layout grouped by project, with saved conversation history, session state, token usage and API-equivalent cost estimates. Native desktop app for Windows; runs from source on macOS and Linux.

**AGPL-3.0** · [Latest release](https://github.com/NovemberFalls/plexar-studio/releases/latest)

**2.1.29:** Codex conversation history shows the commands Codex ran and their output, and a busy or stalled server no longer disconnects your terminals. See the [release notes](CHANGELOG.md#2129---2026-09-13).

> **See it in action:** [watch the demo on X](https://x.com/Falls_November/status/2085765847985819687/video/1) for how Studio looks today and how to use it.

---

## What Is This?

Studio runs the `claude` and `codex` CLIs in terminal emulators (xterm.js), driven by a local FastAPI server that owns their pseudo-terminals. Each pane runs the selected CLI with its own session and working directory.

Plexar Studio keeps multiple CLI sessions organized while preserving the tools and authentication each CLI already uses.

- **Grid and scrolling layouts.** Choose 1–8 grid panes, or scroll through sessions grouped by folder. The concurrent-session limit defaults to 8 and can be configured separately; settings support up to 64, subject to your machine's resources.
- **Live per-pane state** — idle / busy / waiting-on-you, parsed off the terminal stream. The point is knowing at a glance which pane needs you.
- **Sessions grouped by project folder**, with live git branch and dirty status.
- **Session-to-session relay** — hand one session's reply to another, run an autonomous loop between two, or open a channel with one lead and N workers.
- **Codex conversation history through normal scrolling**, backed by saved native messages rather than terminal redraws.
- **Usage and context at a glance**, including Codex's context ring, observed effort, token totals, focused-session quota and API-equivalent estimates. Unknown data stays labelled as unknown.
- **Reports and spend guardrails** for recorded usage, with per-session, model and tool breakdowns.
- **Provider selection** — native Claude and Codex, configured OpenRouter models, and local engines through Claude Code.
- Drag-and-drop file upload, clipboard image paste, pop-out terminals into their own windows, session resume, per-session permission bypass.

---

## Download

Grab the Windows installer from [the latest release](https://github.com/NovemberFalls/plexar-studio/releases/latest):

1. Download **`Plexar-Studio_<version>_x64-setup.exe`**
2. Run it — no admin required, installs to your user folder
3. Launch **Plexar Studio** from the Start Menu

The desktop app bundles the server and starts it automatically; no browser needed. It checks for updates on launch and offers **Install & Restart** when one is available.

> **Antivirus:** PyInstaller executables are sometimes flagged heuristically. Add an exception for `Plexar Studio` if that happens.

### Plexar Mobile (Android)

Use your Studio sessions from your phone. The same release carries the Android app:

- **`Plexar-Mobile_<version>_android-arm64.apk`** for almost every current Android phone
- **`Plexar-Mobile_<version>_android-armv7.apk`** for older 32-bit phones

Install the APK (allow installs from your browser when Android asks), then turn on **Settings ▸ Remote** in Studio and scan the pairing code with the app. Remote access is off until you enable it.

---

## Prerequisites

Install and authenticate at least one supported CLI for both desktop and source use. The desktop installer bundles Python and the Studio server; source development also needs Python and Node.js.

| Requirement | Check with | Install from |
|---|---|---|
| **Claude CLI** | `claude --version` | [claude.com/download](https://claude.com/download) or `npm install -g @anthropic-ai/claude-code` |
| **Codex CLI** | `codex --version` | [OpenAI Codex](https://github.com/openai/codex) |
| **Python 3.11+** | `python --version` | [python.org](https://www.python.org/downloads/) |
| **Node.js 20.19+ or 22.12+** | `node --version` | [nodejs.org](https://nodejs.org/) |

Run `claude` or `codex` in a terminal once to confirm authentication before starting Studio. Both CLIs run natively on Windows here; WSL is not required. Studio deliberately disables Claude's auto-updater inside sessions. Finish those sessions before updating the CLI separately, then use **Re-check** in CLI settings.

---

## Quick Start (from source)

Run these commands in PowerShell:

```powershell
git clone https://github.com/NovemberFalls/plexar-studio.git
cd plexar-studio

python -m pip install -r web/requirements.txt
npm --prefix web/frontend ci
python web/server.py                       # API on http://localhost:8420
```

In a second terminal, from the repository root:

```powershell
npm --prefix web/frontend run dev          # Vite on http://localhost:5174
```

Open **http://localhost:5174** and click **+** in the Projects drawer to create your first session.

---

## Using It

### Sessions

Click **+** (or `Ctrl+Shift+N`), choose Claude Code or Codex, pick a working directory and a compatible model, and open. **Bypass permissions** is a per-session toggle; review it before enabling it.

The model picker follows the selected CLI. Existing sessions retain their CLI and native conversation identity when restored, including native Codex resumes. The active-session view distinguishes unavailable or last-known conversation data instead of assigning another session's messages or usage to it.

Closing a pane kills the terminal but shows a 12-second **Undo** that resumes the same conversation.

### Codex history

Scroll upward in a Codex pane to reach saved user and assistant messages automatically. Continue upward to load older messages. Scroll down past the newest saved messages, press Escape, or choose **Back to live terminal** to return. **Conversation history** remains available as a direct entry point.

This works in docked and popout panes and leaves the CLI running. Saved messages come from Codex's native conversation record; they are separate from raw terminal output and do not include every tool display. Terminal reconnects also replay a bounded 8 MiB output buffer. Truncated or unavailable history is labelled; restarting the backend does not preserve that in-memory raw-output buffer.

While saved history loads, the live terminal stays visible. Reopening uses cached messages while checking the current conversation; failed or timed-out requests offer **Refresh**. If you keep typing during the request, **Show saved messages** lets you open the result when ready without losing input focus.

### Layouts

`Ctrl+Shift+1` through `Ctrl+Shift+8` set how many panes are visible. `Ctrl+1`–`Ctrl+8` focus a pane.

- **3, 5 and 7** have a large featured cell. Which pane is featured only changes when you say so — via **Make featured** in the pane menu, or by dropping a pane into the big cell. Clicking into a terminal to type never reshuffles the grid.
- **Drag a pane header** onto another to swap them. **Drag a session from the sidebar** into any pane to place it there.
- **Pop out** any pane into its own OS window.
- In **scrolling layout**, click a project folder to jump to it. The folder highlight follows scrolling, and pane dragging stays within its folder. Switching layouts keeps terminal instances mounted.

### Sessions that talk to each other

The **Bridge** icon in any pane header opens three modes:

- **Relay** — one-shot. Send this session's latest reply, or a custom message, to another session.
- **Auto** — an autonomous loop between two sessions (a lead and a worker), bounded by a turn cap and stopped by a `BRIDGE-DONE` sentinel, by you, or by either session dying.
- **Channel** — hub topology: one lead, N workers. The lead sees all worker output; its own output broadcasts to every worker.

Delivery waits for the receiving session to be idle *and* for you to stop typing in it, so an injected message can never fragment what you're in the middle of writing. Large messages are handed off via a temp file rather than pasted, because a terminal input pipe drops bytes under a big fast burst.

Auto and Channel show a warning and a confirm-twice gate before starting. Panes in an active bridge glow.

### Cost, usage and reports

**Reports** (chart icon in the rail) covers spend by session, model, day and tool.

Prices are snapshotted daily from OpenRouter and **cost is frozen at ingest** — history never silently re-prices when a model's rate changes. Figures that were priced after the fact, or that have no known price, are labelled as such rather than being folded into a number that looks exact.

**Spend guardrails** (Settings ▸ Spend) can warn or block at a cap, with real and API-equivalent spend tracked separately — under a subscription, an Anthropic turn is not money billed, and the caps reflect that. Blocks apply to bridges and new sessions; **interactive typing is never blocked**. If the underlying pricing isn't trustworthy enough to hard-block on, a block downgrades to an alert and says so.

Subscription limits follow the focused session: Claude account utilization or the quota windows observed in that Codex session. Codex headers show the current context ring separately from cumulative tokens. API-equivalent estimates are not subscription charges and exclude tools, Fast mode and regional price adjustments; unsupported pricing remains unknown.

Reports tables and the Diagnostics log viewer fill the available space. Diagnostics offers **ALL** to read retained logs, including rotated files, within the retention limit.

### Engine (local and alternate providers)

**Engine** (CPU icon) shows what your selected inference provider is doing right now — live requests, loaded models, and an API explorer. Providers are registered server-side and **their URLs and credentials never reach the browser**.

Studio can optionally own a local vLLM container's lifecycle (off by default), or simply observe an engine you run yourself. LM Studio and OpenRouter are also supported. Claude Code is model-agnostic underneath; Studio makes the swap a dropdown.

### Files, clipboard, search

Drag files onto any pane to upload (up to 50 MB each: code, images, PDFs, JSON, CSV, …) — the path is pasted into the prompt. `Ctrl+V` pastes text, or uploads a clipboard image and pastes its path. `Ctrl+Shift+V` and `Alt+V` also request clipboard paste, with a native Windows image fallback when browser clipboard access is unavailable. Paste failures are shown in a notification; reconnect or session changes require pasting again in the intended pane. Pasting an image does not submit the prompt. `Ctrl+Shift+F` searches terminal scrollback.

### Tasks (Plexar Framework preview)

The **Tasks** view is a window onto Plexar Framework, our task framework for queuing and
running agent work across repos. The framework is still being built and isn't public yet, so
for most people Tasks will say it isn't running. We'll open-source it when it's ready.

### Keyboard shortcuts

The full, verified list is in **Settings ▸ Keybindings** — it is generated from the code that actually handles the keys, so it does not drift. Highlights:

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+N` | New session |
| `Ctrl+Shift+E` | Toggle the Projects drawer (`Ctrl+Shift+B` also works) |
| `Ctrl+Shift+1`–`8` | Show 1–8 panes |
| `Ctrl+1`–`8` | Focus pane 1–8 |
| `Ctrl+Shift+F` | Search in the focused terminal |
| `Ctrl+C` | Copy selection, or interrupt when nothing is selected |
| `Ctrl+V` / `Ctrl+Shift+V` / `Alt+V` | Paste clipboard text or image |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Terminal zoom in / out / reset |

Remapping is not wired yet. `Ctrl+K` opens the Projects drawer and focuses its filter; the command palette itself is not built.

### Themes

Two dark palettes ship: **VA Night** and **Plexar Studio Blue**. Settings ▸ Appearance also lets you override individual design tokens and save named palettes of your own.

---

## MCP Servers

Sessions use the [MCP servers](https://modelcontextprotocol.io/) configured for their selected CLI. Configure Claude Code and Codex through their respective CLI settings.

Find servers via the [official registry](https://registry.modelcontextprotocol.io/) or the [reference implementations](https://github.com/modelcontextprotocol/servers).

---

## Configuration

Most settings live in the app (**Settings**, gear icon) and persist to `~/.plexar-studio/settings.json`. The path is shown in the UI.

A few are environment variables, set in `web/.env` (copy `web/.env.example`):

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. See the security note below before changing this. |
| `PORT` | `8420` | Server port |
| `MAX_SESSIONS` | settings value, else `8` | Overrides the concurrent-session limit at server startup |
| `IDLE_TIMEOUT` | `0` | Kill idle sessions after N seconds (0 = disabled) |
| `NO_BROWSER` | `0` | `1` suppresses auto-opening a browser |
| `CLAUDE_CLI_PATH` | — | Full path to the `claude` executable, if it isn't discoverable |
| `CODEX_CLI_PATH` | — | Full path to the `codex` executable, if it isn't discoverable |
| `OPENROUTER_API_KEY` | — | Enables OpenRouter models |
| `COCKPIT_PRICING_REFRESH_HOURS` | `24` | How often to poll for model prices |

Provider and local-engine variables (`COCKPIT_PLEXAR_*`, `COCKPIT_VLLM_*`, `COCKPIT_LMSTUDIO_URL`, …) are read at startup in `web/server.py`, each with a default.

### Security note on `HOST`

The server has **no authentication**. It binds loopback only, and every route plus the terminal WebSocket is protected by a browser-origin guard — an origin allowlist *and* a loopback `Host` check, because loopback alone is not a trust boundary against a browser you happen to be using.

Setting `HOST=0.0.0.0` exposes it to your network and stands the `Host` check down deliberately (a loud warning is logged at startup). Do that only on a network you control.

---

## HTTP API (FastAPI)

The desktop app is a window over a local [FastAPI](https://fastapi.tiangolo.com/) server, so
everything the UI does can also be scripted. While Studio is running, open
**<http://127.0.0.1:8420/docs>** for interactive docs of every route, grouped by area
(Terminals, History, Bridges, Settings, Usage and cost, and so on). The raw schema is at
`/openapi.json`, which you can feed to any OpenAPI client generator.

```bash
# List sessions
curl http://127.0.0.1:8420/api/terminals

# Start a Claude Code session in a folder
curl -X POST http://127.0.0.1:8420/api/terminals   -H "Content-Type: application/json"   -d '{"name": "api-demo", "workdir": "C:/Code/my-project", "harness": "claude-code"}'

# Run a slash command in a session
curl -X POST http://127.0.0.1:8420/api/terminals/<id>/command   -H "Content-Type: application/json" -d '{"command": "/status"}'
```

Terminal I/O streams over `WS /ws/terminal/{id}`: raw keystrokes in, terminal output out.

The same security rules apply as for the app: the API has **no authentication**, it answers
only on loopback, and a browser-origin guard refuses cross-origin and DNS-rebinding requests
(a WebSocket handshake must carry this server's `Origin`). Scripts on the same machine are
trusted. Do not expose the port to a network. Plexar Mobile uses a separate, token-protected
surface under `/remote/v1`, which is off unless you enable Remote in Settings.

---

## Building the Desktop App Yourself

Requires [Rust](https://rustup.rs/).

Build the frontend before the server executable. The desktop window loads the UI embedded in `plexar-studio-server.exe`, so compiling the server first can package an older interface. The verification step checks the embedded UI against the current frontend build.

From the repository root in PowerShell:

```powershell
# 1. Build the React frontend — FIRST
npm --prefix web/frontend run build

# 2. Build the PyInstaller sidecar
Push-Location web
python -m PyInstaller --clean --noconfirm cockpit-server.spec

# 3. Verify the sidecar carries the CURRENT frontend — stop-ship if this fails
python verify_sidecar_bundle.py

# 4. Stage the sidecar and build the desktop app
Copy-Item -LiteralPath dist/plexar-studio-server.exe -Destination frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
Pop-Location
Push-Location web/frontend
npx tauri build
Pop-Location
```

Output: `web/frontend/src-tauri/target/release/bundle/nsis/Plexar-Studio_<version>_x64-setup.exe`

Step 3 compares bytes, not timestamps — rebuilding the sidecar makes it *newer* than `dist/` while still carrying stale contents, so an mtime check goes green on exactly the broken build.

The application executable is `plexar-studio.exe`; PyInstaller produces `plexar-studio-server.exe`. The internal sidecar bundle name `cockpit-server` and application identifier `com.claude-cockpit.app` remain unchanged for upgrade compatibility, as do existing storage and environment-variable keys. This preserves installed-app identity and saved preferences. Release updater archives use Tauri update signatures; those signatures are separate from Windows Authenticode signing of executables.

Maintainers: see [Releasing Plexar Studio](RELEASING.md) for signing, manifest verification and publishing.

---

## Project Structure

```
plexar-studio/
├── web/
│   ├── server.py                 # FastAPI backend (REST + WebSocket)
│   ├── pty_manager.py            # PTY session manager
│   ├── pty_backend.py            # Backend abstraction + platform factory
│   ├── conpty.py / unix_pty.py   # Windows ConPTY / POSIX PTY backends
│   ├── origin_guard.py           # Browser-origin + loopback Host guard
│   ├── bridge_manager.py         # Session-to-session relay, auto loop, channel
│   ├── usage_tracker.py          # Token + tool-call ingest (SQLite)
│   ├── pricing_store.py          # Append-only price snapshots
│   ├── spend_guard.py            # Spend caps and enforcement
│   ├── jsonl_watcher.py          # Reads Claude Code session transcripts
│   ├── verify_sidecar_bundle.py  # Build guard (see above)
│   ├── cockpit-server.spec       # PyInstaller config
│   ├── tests/                    # pytest suite
│   └── frontend/
│       ├── src/
│       │   ├── App.jsx           # Root component, session + layout state
│       │   ├── components/       # Panes, shell, engine, reports, settings
│       │   ├── hooks/ utils/     # Theme, settings, local models, keybindings
│       │   ├── themes/           # Palette + design-token definitions
│       │   └── __tests__/        # vitest suite
│       └── src-tauri/            # Tauri desktop wrapper (Rust, NSIS)
└── .github/workflows/            # CI
```

Many modules carry a long docstring explaining *why* they are shaped the way they are — usually because the obvious alternative was tried and broke something. `origin_guard.py`, `verify_sidecar_bundle.py`, `pricing_store.py` and `utils/keybindings.js` are good places to start before changing anything near them.

---

## Testing

From the repository root:

```powershell
Push-Location web
python -m pytest tests/ -v
Pop-Location
npm --prefix web/frontend test
npm --prefix web/frontend run lint
```

Both suites run on push and PR via GitHub Actions.

---

## Troubleshooting

**"Could not find the `claude` CLI"** — Studio searches `PATH` first, then standard install locations (`~/.local/bin`, the npm global dir, `%LOCALAPPDATA%\Programs\claude`, `/usr/local/bin`, Homebrew). In order of likelihood:

1. **Not installed.** Install it and verify with `claude --version`.
2. **Studio's `PATH` is stale.** The common case: Studio was already running, or was launched from Explorer or a long-lived shell whose `PATH` predates the install. **Fully quit and relaunch.**
3. **Installed somewhere nonstandard.** Set `CLAUDE_CLI_PATH` to the full path before launching.

The error message lists every directory that was searched — read it before guessing.

**"[Session ended]" immediately** — inspect Diagnostics and run the selected `claude` or `codex` CLI manually in the same working directory to see its startup error. Confirm authentication and executable selection.

**Port 8420 already in use** — stop the conflicting development server, or set `$env:PORT="9000"` before `python web/server.py`. If using Vite, update its development proxy to the same port.

**A pane says the backend is down and never recovers** — if it instead says the origin was refused, that is the origin guard, and reloading the app fixes it. The two are distinguished deliberately, because waiting fixes one and never fixes the other.

---

## Privacy

Studio stores its own settings and records locally (`~/.plexar-studio/`) and reads native CLI conversation records from their local storage. The selected CLI sends prompts and code to its configured provider as part of normal operation. Studio does not operate a hosted session service.

For accuracy, Studio does make a small number of outbound requests, all of which you can see in the source:

- **openrouter.ai** — daily model *price list* poll for reference cost estimates. No usage data is sent by that poll.
- **api.anthropic.com** — reads your subscription utilization, using the Claude CLI's own stored token. Read-only; Studio never refreshes or rotates that token.
- **github.com** — the desktop app's update check on launch.
- Any **provider you configure yourself** (a local engine, OpenRouter) receives the traffic you direct to it. Nothing is sent to a provider you have not selected.

No telemetry, no analytics, no account.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Python 3.11+, FastAPI, Uvicorn, pywinpty / ptyprocess |
| Frontend | React 19, Vite 8, xterm.js, Tailwind CSS |
| Desktop | Tauri 2 (Rust + WebView2) |
| Storage | SQLite (usage, pricing) |
| Packaging | PyInstaller (server), NSIS (installer) |

---

## Support & Contributing

Open an [issue on GitHub](https://github.com/NovemberFalls/plexar-studio/issues), or use the **Support** link at the bottom of the sidebar, which opens the [BITS service desk](https://desk.boord-its.com).

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## History

Earlier versions (as Claude Cockpit) included an **Orchestrator Mode**: one Claude session directing others via MCP and a file-based workspace. It was removed in v1.1.0 — routing agent-to-agent communication through a browser-facing HTTP server added latency and coupling that made it fragile. The idea returned in a better shape as the session **Bridge** and **Channel** features described above, which talk to PTYs directly.

---

## License

Plexar Studio is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Copyright (c) 2026 NovemberFalls
