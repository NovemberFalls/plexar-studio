# Plexar Studio

*(formerly Claude Cockpit)*

A focused multi-session manager for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Run up to 8 Claude Code terminals side by side in one window, organized by project, with live per-session state, session-to-session relays, and real cost tracking. Native desktop app for Windows; runs from source on macOS and Linux.

**AGPL-3.0** · [Latest release](https://github.com/NovemberFalls/plexar-studio/releases/latest)

[![Plexar Studio](screenshot.svg)](https://github.com/NovemberFalls/plexar-studio/releases/latest)

> **Demo video:** the [v1.3.3 demo](https://github.com/NovemberFalls/plexar-studio/releases/download/v1.3.3/demo.mp4) still shows the general idea, but the interface has changed considerably since. A current walkthrough is in progress.

---

## What Is This?

Studio wraps the `claude` CLI in a terminal emulator (xterm.js) driven by a local FastAPI server that owns the PTYs. **It does not proxy, wrap, or intercept the model** — each pane is a real `claude` process with a real pseudo-terminal, and everything Claude Code can do on its own it can do here.

The design bet is **depth over width**. This is not a general AI IDE; it is a manager for Claude Code, and nearly every feature exists because running several sessions at once has problems that running one does not.

- **Up to 8 concurrent sessions**, in 1–8 pane layouts. The 3, 5 and 7-pane layouts have a featured cell you assign explicitly.
- **Live per-pane state** — idle / busy / waiting-on-you, parsed off the terminal stream. The point is knowing at a glance which pane needs you.
- **Sessions grouped by project folder**, with live git branch and dirty status.
- **Session-to-session relay** — hand one session's reply to another, run an autonomous loop between two, or open a channel with one lead and N workers.
- **Cost and token tracking** per session, per model, and per tool, with spend guardrails.
- **Open provider layer** — Claude Code is the focus, but you can pair a local engine (vLLM, LM Studio) or OpenRouter alongside it and choose per session.
- Drag-and-drop file upload, clipboard image paste, pop-out terminals into their own windows, session resume, per-session permission bypass.

---

## Download

Grab the Windows installer from [the latest release](https://github.com/NovemberFalls/plexar-studio/releases/latest):

1. Download **`Plexar-Studio_<version>_x64-setup.exe`**
2. Run it — no admin required, installs to your user folder
3. Launch **Plexar Studio** from the Start Menu

The desktop app bundles the server and starts it automatically; no browser needed. It checks for updates on launch and offers **Install & Restart** when one is available.

> **Antivirus:** PyInstaller executables are sometimes flagged heuristically. Add an exception for `Plexar Studio` if that happens.

---

## Prerequisites

Only needed to run from source. The desktop installer bundles Python and the server.

| Requirement | Check with | Install from |
|---|---|---|
| **Claude CLI** | `claude --version` | [claude.com/download](https://claude.com/download) or `npm install -g @anthropic-ai/claude-code` |
| **Python 3.11+** | `python --version` | [python.org](https://www.python.org/downloads/) |
| **Node.js 18+** | `node --version` | [nodejs.org](https://nodejs.org/) |

The Claude CLI must be logged in. Run `claude` in a terminal once to confirm before starting Studio.

---

## Quick Start (from source)

```bash
git clone https://github.com/NovemberFalls/plexar-studio.git
cd plexar-studio

pip install -r web/requirements.txt        # pywinpty on Windows, ptyprocess elsewhere
cd web/frontend && npm install && cd ../..

cd web && python server.py                 # API on http://localhost:8420
```

In a second terminal:

```bash
cd web/frontend && npm run dev             # Vite on http://localhost:5174
```

Open **http://localhost:5174** and click **+** in the Projects drawer to create your first session.

---

## Using It

### Sessions

Click **+** (or `Ctrl+Shift+N`), pick a working directory, optionally name it, choose a model, and open. **Bypass permissions** is a per-session toggle — it launches Claude Code without approval prompts, so use it deliberately.

Models offered: Opus 5 / 4.8, Sonnet 5, Haiku 4.5, Fable 5 (including 1M-context variants), plus any local or OpenRouter model you have configured.

Closing a pane kills the terminal but shows a 12-second **Undo** that resumes the same conversation.

### Layouts

`Ctrl+Shift+1` through `Ctrl+Shift+8` set how many panes are visible. `Ctrl+1`–`Ctrl+8` focus a pane.

- **3, 5 and 7** have a large featured cell. Which pane is featured only changes when you say so — via **Make featured** in the pane menu, or by dropping a pane into the big cell. Clicking into a terminal to type never reshuffles the grid.
- **Drag a pane header** onto another to swap them. **Drag a session from the sidebar** into any pane to place it there.
- **Pop out** any pane into its own OS window.

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

The top bar also shows your Anthropic 5-hour and weekly utilization, read from the same source as `claude /status`.

### Engine (local and alternate providers)

**Engine** (CPU icon) shows what your selected inference provider is doing right now — live requests, loaded models, and an API explorer. Providers are registered server-side and **their URLs and credentials never reach the browser**.

Studio can optionally own a local vLLM container's lifecycle (off by default), or simply observe an engine you run yourself. LM Studio and OpenRouter are also supported. Claude Code is model-agnostic underneath; Studio makes the swap a dropdown.

### Files, clipboard, search

Drag files onto any pane to upload (up to 50 MB each: code, images, PDFs, JSON, CSV, …) — the path is pasted into the prompt. `Ctrl+V` pastes text, or uploads a clipboard image and pastes its path. `Ctrl+Shift+F` searches terminal scrollback.

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
| `Ctrl+V` / `Alt+V` | Paste text / paste clipboard image |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Terminal zoom in / out / reset |

Remapping is not wired yet. `Ctrl+K` opens the Projects drawer and focuses its filter; the command palette itself is not built.

### Themes

Two dark palettes ship: **VA Night** and **Cockpit Blue**. Settings ▸ Appearance also lets you override individual design tokens and save named palettes of your own.

---

## MCP Servers

Sessions inside Studio automatically use whatever [MCP servers](https://modelcontextprotocol.io/) your Claude Code setup already has (`~/.claude/settings.json`). Nothing to configure in the app.

Find servers via the [official registry](https://registry.modelcontextprotocol.io/) or the [reference implementations](https://github.com/modelcontextprotocol/servers).

---

## Configuration

Most settings live in the app (**Settings**, gear icon) and persist to `~/.plexar-studio/settings.json`. The path is shown in the UI.

A few are environment variables, set in `web/.env` (copy `web/.env.example`):

| Variable | Default | Description |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. See the security note below before changing this. |
| `PORT` | `8420` | Server port |
| `MAX_SESSIONS` | `8` | Maximum concurrent sessions |
| `IDLE_TIMEOUT` | `0` | Kill idle sessions after N seconds (0 = disabled) |
| `NO_BROWSER` | `0` | `1` suppresses auto-opening a browser |
| `CLAUDE_CLI_PATH` | — | Full path to the `claude` executable, if it isn't discoverable |
| `OPENROUTER_API_KEY` | — | Enables OpenRouter models |
| `COCKPIT_PRICING_REFRESH_HOURS` | `24` | How often to poll for model prices |

Provider and local-engine variables (`COCKPIT_PLEXAR_*`, `COCKPIT_VLLM_*`, `COCKPIT_LMSTUDIO_URL`, …) are read at startup in `web/server.py`, each with a default.

### Security note on `HOST`

The server has **no authentication**. It binds loopback only, and every route plus the terminal WebSocket is protected by a browser-origin guard — an origin allowlist *and* a loopback `Host` check, because loopback alone is not a trust boundary against a browser you happen to be using.

Setting `HOST=0.0.0.0` exposes it to your network and stands the `Host` check down deliberately (a loud warning is logged at startup). Do that only on a network you control.

---

## Building the Desktop App Yourself

Requires [Rust](https://rustup.rs/).

**The order of these steps is load-bearing.** The desktop window is a thin webview over the sidecar's HTTP server, so the UI a user sees is the copy frozen into `cockpit-server.exe` — *not* `frontend/dist` on disk. Build the sidecar before the frontend and the app ships the previous release's interface while every version check passes. That shipped twice; hence step 3.

```bash
# 1. Build the React frontend — FIRST
cd web/frontend && npm run build

# 2. Build the PyInstaller sidecar
cd .. && python -m PyInstaller --clean --noconfirm cockpit-server.spec

# 3. Verify the sidecar carries the CURRENT frontend — stop-ship if this fails
python verify_sidecar_bundle.py

# 4. Stage the sidecar and build the desktop app
cp dist/claude-cockpit.exe frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
cd frontend && npx tauri build
```

Output: `web/frontend/src-tauri/target/release/bundle/nsis/Plexar-Studio_<version>_x64-setup.exe`

Step 3 compares bytes, not timestamps — rebuilding the sidecar makes it *newer* than `dist/` while still carrying stale contents, so an mtime check goes green on exactly the broken build.

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

```bash
cd web && python -m pytest tests/ -v      # backend
cd web/frontend && npm test               # frontend
cd web/frontend && npm run lint
```

Both suites run on push and PR via GitHub Actions.

---

## Troubleshooting

**"Could not find the `claude` CLI"** — Studio searches `PATH` first, then standard install locations (`~/.local/bin`, the npm global dir, `%LOCALAPPDATA%\Programs\claude`, `/usr/local/bin`, Homebrew). In order of likelihood:

1. **Not installed.** Install it and verify with `claude --version`.
2. **Studio's `PATH` is stale.** The common case: Studio was already running, or was launched from Explorer or a long-lived shell whose `PATH` predates the install. **Fully quit and relaunch.**
3. **Installed somewhere nonstandard.** Set `CLAUDE_CLI_PATH` to the full path before launching.

The error message lists every directory that was searched — read it before guessing.

**"[Session ended]" immediately** — the Claude CLI isn't authenticated. Run `claude` manually in that directory first.

**Port 8420 already in use** — `PORT=9000 python server.py`.

**A pane says the backend is down and never recovers** — if it instead says the origin was refused, that is the origin guard, and reloading the app fixes it. The two are distinguished deliberately, because waiting fixes one and never fixes the other.

---

## Privacy

**Your sessions, code, and conversations stay on your machine.** Studio stores everything locally (`~/.plexar-studio/`), and terminal traffic never leaves the process — Studio is not a proxy, and it does not send your prompts or output anywhere.

For accuracy, Studio does make a small number of outbound requests, all of which you can see in the source:

- **openrouter.ai** — daily model *price list* poll, so cost figures are real. No usage data is sent.
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
