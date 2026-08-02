# Plexar Studio

*(formerly Claude Cockpit)*

A clean, focused multi-session [Claude Code](https://docs.anthropic.com/en/docs/claude-code) manager. Run up to 8 Claude Code terminals side by side in a single window, organized by project, with a native desktop app and 20 themes.

[![Plexar Studio — click to watch demo](screenshot.svg)](https://github.com/NovemberFalls/claude-cockpit/releases/download/v1.3.3/demo.mp4)

> ▶ [Watch the demo video](https://github.com/NovemberFalls/claude-cockpit/releases/download/v1.3.3/demo.mp4)

---

## A Note on Orchestrator Mode

Previous versions (then Claude Cockpit) included an **Orchestrator Mode** — one Claude session controlling others via MCP, with a file-based workspace system for agent-to-agent communication.

**That feature has been removed in v1.1.0.**

The orchestrator concept is architecturally sound, and the approach (MCP tools, file-based briefs, structured agent hierarchies) is the right direction. The problem is with the current implementation's design foundation — specifically, routing all inter-agent communication through a browser-facing FastAPI server adds latency, PTY buffer constraints, and tight coupling that make the system fragile at scale.

I'm re-evaluating the orchestrator approach before committing to a new implementation. When it returns, it will be built on a stronger foundation. Until then, Cockpit does one thing and does it well: manage multiple Claude Code shells cleanly.

---

## What Is This?

Plexar Studio lets you:

- Run **up to 8 Claude Code sessions** simultaneously, view 1, 2, or 4 at a time in split panes
- Organize sessions by **project folder** with live git branch and dirty status
- Choose from **20 themes** (dark and light variants)
- **Drag and drop files** into any session
- Resume previous Claude sessions
- Pick your Claude model (Sonnet, Opus, Haiku — including 1M context variants)
- **Bypass permissions** per-session for fully autonomous operation

It works by wrapping the `claude` CLI in a web-based terminal emulator (xterm.js), managed through a FastAPI backend that handles PTY (pseudo-terminal) connections.

---

## Prerequisites

> **Platform:** The pre-built desktop app targets **Windows 10/11**. Running from source works on **Linux and macOS**.

| Requirement | How to check | How to install |
|-------------|-------------|----------------|
| **Python 3.11+** | `python --version` | [python.org/downloads](https://www.python.org/downloads/) |
| **Node.js 18+** | `node --version` | [nodejs.org](https://nodejs.org/) |
| **Claude CLI** | `claude --version` | `npm install -g @anthropic-ai/claude-code` |

Claude CLI must be logged in and working. Run `claude` in your terminal first to verify.

---

## Quick Start (Development)

### 1. Clone the repo

```bash
git clone https://github.com/NovemberFalls/claude-cockpit.git
cd claude-cockpit
```

### 2. Install Python dependencies

```bash
pip install -r web/requirements.txt
```

> Dependencies are platform-aware: `pywinpty` installs on Windows, `ptyprocess` on Linux/macOS.

### 3. Install frontend dependencies

```bash
cd web/frontend
npm install
cd ../..
```

### 4. Start the backend server

```bash
cd web
python server.py
```

Starts the API server on **http://localhost:8420**.

### 5. Start the frontend dev server (separate terminal)

```bash
cd web/frontend
npm run dev
```

Starts the Vite dev server on **http://localhost:5174**.

### 6. Open the app

Go to **http://localhost:5174**. Click **+** in the sidebar to create your first Claude session.

---

## Download

Pre-built executables are available on the [GitHub Releases](https://github.com/NovemberFalls/claude-cockpit/releases) page.

### Desktop App (Windows)

1. Download **`Plexar Studio_x64-setup.exe`** from the latest release
2. Run the installer (no admin required — installs to your user folder)
3. Launch "Plexar Studio" from Start Menu or Desktop
4. The app opens in its own native window — no browser needed

The desktop app bundles the server internally and starts it automatically.

> **Auto-Update:** The desktop app checks for updates on startup. When a new version is available, you'll see an **Install & Restart** button.

---

## Building the Desktop App Yourself

Requires [Rust](https://rustup.rs/).

```bash
# 1. Build the React frontend
cd web/frontend
npm run build

# 2. Build the PyInstaller sidecar
cd ..
python -m PyInstaller --clean --noconfirm cockpit-server.spec

# 3. Copy sidecar to Tauri binaries
cp dist/claude-cockpit.exe frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe

# 4. Build the Tauri app
cd frontend
npx tauri build
```

Output: `web/frontend/src-tauri/target/release/bundle/nsis/Plexar Studio_<version>_x64-setup.exe`

---

## How to Use the App

### Creating a Session

1. Click **+** in the sidebar (or `Ctrl+Shift+N`)
2. Pick a **working directory** — the project folder Claude will work in
3. Optionally give the session a name
4. Toggle **Bypass permissions** if you want Claude to operate without approval prompts
5. Click **Open Session**

### Layouts

Use the layout buttons in the status bar (bottom right):

- **Single** — one pane, full screen
- **Split** — two panes side by side
- **Quad** — four panes in a 2×2 grid

Keyboard shortcuts: `Ctrl+Shift+!` (1), `Ctrl+Shift+@` (2), `Ctrl+Shift+$` (4).

**Rearranging panes:** Drag a pane's header to swap it with another. Drag a session from the sidebar into any pane to place it there.

### Sidebar

- Sessions are grouped by working directory, with git branch/dirty indicator
- Right-click any location for options: new session here, expand subfolders, toggle bypass, remove
- Double-click a folder to open a new session in it instantly

### Themes

Click the palette icon in the top bar to pick from 20 themes:

Tokyo Night, Nord, Dracula, Gruvbox, One Dark, Solarized, Synthwave, Monokai, Catppuccin, GitHub — each in dark and light variants.

### File Upload

Drag and drop files directly onto any terminal pane. Supported: code files, images, PDFs, JSON, CSV, and more (up to 50 MB each).

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+N` | New session |
| `Ctrl+Shift+B` | Toggle sidebar |
| `Ctrl+Shift+Enter` | Broadcast mode (send to all sessions) |
| `Ctrl+Shift+!` | Single pane layout |
| `Ctrl+Shift+@` | Split layout |
| `Ctrl+Shift+$` | Quad layout |
| `Ctrl+1–4` | Focus pane 1–4 |
| `Ctrl+=` / `Ctrl+-` | Zoom in / out |

---

## MCP Servers

Claude sessions inside Cockpit automatically use any [MCP servers](https://modelcontextprotocol.io/) configured in your Claude Code setup (`~/.claude/settings.json`). No additional setup needed inside the app.

### Finding MCP Servers

- **[Official MCP Registry](https://registry.modelcontextprotocol.io/)** — the canonical directory
- **[MCP Server Repository](https://github.com/modelcontextprotocol/servers)** — reference implementations

### Example Configuration

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-filesystem"]
    }
  }
}
```

---

## Configuration

Copy `web/.env.example` to `web/.env`:

```env
HOST=127.0.0.1
PORT=8420
MAX_SESSIONS=8
IDLE_TIMEOUT=0
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `127.0.0.1` | Bind address. The server has no authentication — it binds localhost only by default. Set to `0.0.0.0` to allow access from other devices on your network (a startup warning is logged). |
| `PORT` | `8420` | Server port |
| `MAX_SESSIONS` | `8` | Maximum concurrent sessions |
| `IDLE_TIMEOUT` | `0` | Kill idle sessions after N seconds (0 = disabled) |
| `NO_BROWSER` | `0` | Set to `1` to suppress auto-opening browser |

---

## Project Structure

```
claude-cockpit/
├── web/
│   ├── server.py           # FastAPI backend (REST + WebSocket)
│   ├── pty_manager.py      # PTY session manager
│   ├── pty_backend.py      # PTY backend abstraction + factory
│   ├── conpty.py           # Windows ConPTY ctypes wrapper
│   ├── unix_pty.py         # Linux/macOS PTY backend
│   ├── logging_config.py   # Structured logging
│   ├── tests/              # Python test suite
│   ├── requirements.txt    # Python dependencies
│   ├── cockpit-server.spec # PyInstaller build config
│   └── frontend/
│       ├── src/
│       │   ├── App.jsx              # Main app component
│       │   ├── components/          # UI components
│       │   ├── __tests__/           # Frontend tests
│       │   ├── themes/themeData.js  # 20 theme definitions
│       │   └── hooks/useTheme.jsx   # Theme provider
│       ├── src-tauri/               # Tauri desktop wrapper
│       └── package.json
├── .github/workflows/       # CI/CD (GitHub Actions)
├── CONTRIBUTING.md
└── README.md
```

---

## Testing

### Backend

```bash
cd web && python -m pytest tests/ -v
```

### Frontend

```bash
cd web/frontend && npm test
```

Tests run automatically on push and PR via GitHub Actions.

---

## Troubleshooting

**"Could not find the `claude` CLI"** — Cockpit searches your `PATH` first, then the standard install locations (`~/.local/bin`, the npm global dir, `%LOCALAPPDATA%\Programs\claude`, `/usr/local/bin`, Homebrew). Three causes, in order of likelihood:

1. **Not installed.** Get it from [claude.com/download](https://claude.com/download) or `npm install -g @anthropic-ai/claude-code`, then verify with `claude --version`.
2. **Installed, but Cockpit's `PATH` is stale.** This is the common one: if Cockpit was already running when you installed Claude Code — or was launched from Explorer or a long-lived shell whose `PATH` predates the install — it inherited the old environment. **Fully quit and relaunch Cockpit.** The fallback probe usually covers this automatically; when it does, `cockpit.pty` logs a warning saying so.
3. **Installed somewhere nonstandard.** Set `CLAUDE_CLI_PATH` to the full path of the executable before launching Cockpit:

   ```bash
   # Windows (PowerShell)
   $env:CLAUDE_CLI_PATH = 'C:\path\to\claude.exe'
   # macOS / Linux
   export CLAUDE_CLI_PATH=/path/to/claude
   ```

The error message itself lists every directory that was searched — read it before guessing.

**Port 8420 already in use** — `PORT=9000 python server.py`

**"[Session ended]" immediately** — Claude CLI isn't authenticated. Run `claude` manually in that directory first.

**Antivirus blocks the exe** — PyInstaller executables are sometimes flagged. Add an exception for `claude-cockpit.exe` or `Plexar Studio`.

---

## Support

Since v1.3.9, the app includes a **Support** link at the bottom of the sidebar (under MCP Servers). It opens the [BITS service desk](https://desk.boord-its.com) in your default browser, where you can get help or report a problem. You can also [open an issue on GitHub](https://github.com/NovemberFalls/claude-cockpit/issues).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.11+, FastAPI, Uvicorn, pywinpty / ptyprocess |
| Frontend | React 19, Vite 8, xterm.js, Tailwind CSS |
| Desktop | Tauri 2 (Rust + WebView2) |
| Packaging | PyInstaller (server exe), NSIS (installer) |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Privacy

Plexar Studio runs entirely on your machine. No data is collected, transmitted, or stored externally. Your sessions, code, and conversations never leave your computer.

---

## License

Plexar Studio is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Copyright (c) 2026 NovemberFalls
