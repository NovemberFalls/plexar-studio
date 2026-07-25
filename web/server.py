"""FastAPI web server for Claude Cockpit -- PTY-bridged interactive terminals."""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time as _time
import uuid
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.requests import Request
from starlette.responses import Response, StreamingResponse

load_dotenv()

import logging_config  # noqa: E402 -- deliberately imported after load_dotenv() so logging is configured before any other cockpit module is imported
logging_config.setup()
logger = logging.getLogger("cockpit.server")

from pty_manager import ClaudeCliNotFound, pty_manager  # noqa: E402 -- must follow load_dotenv(): reads MAX_SESSIONS/IDLE_TIMEOUT from os.environ at module scope
from bridge_manager import bridge_manager, channel_manager, cleanup_relay_dir  # noqa: E402 -- grouped with pty_manager import for consistent post-setup() init order
# _wait_for_idle_simple / _wrap are underscore-prefixed (bridge_manager treats
# them as internal helpers), but they are exactly the typing-quiet + idle gate
# and bracketed-paste injection mechanics the CLI-actions routes below need
# (PATCH rename sync, POST command). Reusing them here avoids re-implementing
# proven injection machinery — see bridge_manager.py's V1 manual relay for the
# same pattern.
from bridge_manager import _wait_for_idle_simple, _wrap  # noqa: E402
import settings_store  # noqa: E402 -- grouped with the other local-module imports above for consistency; has no load_dotenv() ordering dependency of its own
from usage_tracker import usage_tracker  # noqa: E402 -- grouped with the other local-module imports above

START_TIME = _time.time()


# NOTE on definition order: `lifespan` must exist before the `FastAPI(...)`
# call below since it is passed in as a constructor argument. Its BODY,
# however, references module-level names defined further down this file
# (PID_FILE, UPLOAD_DIR) — that is safe because Python resolves names inside
# a function body lazily, at call time, not at definition time. uvicorn only
# invokes this context manager after the entire module has finished
# importing (from main()), by which point every module-level name below is
# already bound.
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle, replacing the deprecated
    ``@app.on_event("startup"/"shutdown")`` decorators.
    """
    # ---- Startup ----
    # 1. Clean up orphaned processes from previous crashes
    pty_manager.cleanup_orphans()

    # 2. PID file for crash detection
    try:
        import psutil
        if PID_FILE.exists():
            old_pid = int(PID_FILE.read_text().strip())
            if psutil.pid_exists(old_pid):
                logger.warning("Another cockpit instance may be running (PID %d)", old_pid)
            else:
                logger.info("Previous instance (PID %d) crashed — cleaned up", old_pid)
    except Exception:
        logger.debug("Crash-detection PID check failed — continuing startup", exc_info=True)
    PID_FILE.write_text(str(os.getpid()))

    # 3. Start idle session cleanup loop (tracked for graceful shutdown)
    async def idle_cleanup_loop():
        loop = asyncio.get_event_loop()
        try:
            while True:
                await asyncio.sleep(60)
                # Run in executor: cleanup_idle_sessions uses time.sleep(0.1)
                # for the two-pass CPU check — keeps the event loop unblocked.
                await loop.run_in_executor(None, pty_manager.cleanup_idle_sessions)
        except asyncio.CancelledError:
            pass
    app.state.idle_cleanup_task = asyncio.create_task(idle_cleanup_loop())

    # 3b. Start background usage-ingestion loop: every 5s, ingest each running
    # session's JSONL into the persistent usage SQLite store (survives JSONL
    # deletion). sqlite3 is synchronous, so ingestion runs in the default
    # executor to avoid blocking the event loop.
    async def usage_ingest_loop():
        loop = asyncio.get_event_loop()
        try:
            while True:
                await asyncio.sleep(5)
                for session in list(pty_manager.sessions.values()):
                    if not session.alive:
                        continue
                    try:
                        jsonl_path = pty_manager._get_jsonl_path(session)
                        if not jsonl_path:
                            continue
                        await loop.run_in_executor(
                            None, usage_tracker.ingest_jsonl, session.id, jsonl_path
                        )
                    except Exception:
                        logger.error(
                            "Usage ingestion failed for session %s", session.id, exc_info=True
                        )
        except asyncio.CancelledError:
            pass
    app.state.usage_ingest_task = asyncio.create_task(usage_ingest_loop())

    # 4. Start background state ticker — calls tick() on every live session
    # every ~1s so SessionStateTracker.state is authoritative independent of
    # frontend polling.  The bridge idle gate depends on this for correctness.
    pty_manager.start_state_ticker()

    # 5. Managed lane broker: Cockpit owns the broker unless an external one
    # already answers (or COCKPIT_MANAGED_BROKER=0). Best-effort — a broker
    # failure must never block Cockpit startup.
    # Apply any browser-configured local provider endpoints BEFORE the managed
    # broker starts, so a configured endpoint is live from boot. Defensive — a
    # bad config file must never block startup.
    try:
        apply_persisted_endpoints()
    except Exception:
        logger.error("Applying persisted provider endpoints failed", exc_info=True)

    try:
        await start_managed_broker()
    except Exception:
        logger.error("Managed broker startup failed", exc_info=True)

    # Managed vLLM: opt-in coexisting local provider, same best-effort posture.
    try:
        await start_managed_vllm()
    except Exception:
        logger.error("Managed vLLM startup failed", exc_info=True)

    # vLLM metrics sampler: persists vLLM's reset-prone counters to a crude
    # on-disk dataset so lifetime usage survives container restarts. Best-effort.
    app.state.vllm_sampler_task = asyncio.create_task(_vllm_sampler_loop())

    logger.info("Startup complete (PID %d)", os.getpid())

    yield

    # ---- Shutdown ----
    # Cancel idle cleanup loop
    cleanup_task = getattr(app.state, "idle_cleanup_task", None)
    if cleanup_task:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass

    # Cancel usage ingestion loop
    usage_task = getattr(app.state, "usage_ingest_task", None)
    if usage_task:
        usage_task.cancel()
        try:
            await usage_task
        except asyncio.CancelledError:
            pass
    usage_tracker.close()

    # Cancel the vLLM metrics sampler
    vllm_sampler = getattr(app.state, "vllm_sampler_task", None)
    if vllm_sampler:
        vllm_sampler.cancel()
        try:
            await vllm_sampler
        except asyncio.CancelledError:
            pass

    # Stop the background state ticker
    await pty_manager.stop_state_ticker()

    # Stop the managed lane broker (no-op when external/disabled)
    await stop_managed_broker()
    await stop_managed_vllm()

    logger.info("Shutdown: terminating %d session(s)...", len(pty_manager.sessions))
    pty_manager.shutdown()
    logger.info("Shutdown: cleaning upload dir...")
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)
    logger.info("Shutdown: cleaning relay dir...")
    cleanup_relay_dir()
    PID_FILE.unlink(missing_ok=True)
    logger.info("Shutdown complete")


app = FastAPI(
    title="Claude Cockpit Web",
    description="Multi-session Claude CLI terminal manager",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS: allow Tauri webview origins + Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "tauri://localhost",
        "https://tauri.localhost",
        "http://localhost:5174",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)

# Detect PyInstaller bundle for static file path
if getattr(sys, "_MEIPASS", None):
    FRONTEND_DIST = Path(sys._MEIPASS) / "frontend_dist"
else:
    FRONTEND_DIST = Path(__file__).parent / "frontend" / "dist"

# Session-scoped temp directory for file uploads
UPLOAD_DIR = Path(tempfile.mkdtemp(prefix="cockpit_uploads_"))

MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB
MAX_UPLOAD_DIR_SIZE = 200 * 1024 * 1024  # 200MB total
_upload_dir_size = 0  # Running total of bytes in UPLOAD_DIR
# Lock serialises the quota-check-then-write sequence in upload_files().
# Without this, concurrent async requests can both read a stale _upload_dir_size,
# both pass the quota check, and together exceed MAX_UPLOAD_DIR_SIZE.
_upload_lock = asyncio.Lock()

# PID file for crash detection
PID_FILE = Path(__file__).parent / ".cockpit.pid"

ALLOWED_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg",
    ".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml",
    ".py", ".js", ".ts", ".tsx", ".jsx", ".rs", ".go", ".java",
    ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".sh",
    ".bash", ".zsh", ".sql", ".html", ".css", ".scss", ".toml",
    ".ini", ".cfg", ".env", ".lua", ".kt", ".swift", ".r",
    ".pdf",
}


# ── Health Check ──────────────────────────────────────────


@app.get("/health")
async def health():
    """Health check endpoint for monitoring."""
    return JSONResponse({
        "status": "ok",
        "sessions": len(pty_manager.sessions),
        "uptime_seconds": int(_time.time() - START_TIME),
    })


# ── Model catalog (live from Anthropic /v1/models) ───────
#
# The model picker must reflect what the account can ACTUALLY run, not a
# hardcoded list that drifts every time Anthropic ships a model (Opus 5 caught
# us out). We read the session's Claude Code OAuth token from the credentials
# file and ask Anthropic's /v1/models directly. The token NEVER leaves the
# server — only {id, display_name} pairs reach the browser. On any failure
# (offline, token expired/rotated) we serve the last good cache, then a static
# fallback, so the picker is never empty.
_MODELS_CACHE: dict = {"data": None, "ts": 0.0}
_MODELS_TTL = 600.0  # 10 min — models change on the order of weeks
_CREDENTIALS_PATH = Path.home() / ".claude" / ".credentials.json"
_ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models?limit=100"

# Last resort only — mirrors the frontend FALLBACK_MODEL_GROUPS. Never reached
# while the credentials file + network are healthy.
_FALLBACK_MODELS = [
    {"id": "claude-opus-5", "display_name": "Claude Opus 5"},
    {"id": "claude-sonnet-5", "display_name": "Claude Sonnet 5"},
    {"id": "claude-fable-5", "display_name": "Claude Fable 5"},
    {"id": "claude-opus-4-8", "display_name": "Claude Opus 4.8"},
    {"id": "claude-haiku-4-5-20251001", "display_name": "Claude Haiku 4.5"},
]


def _read_oauth_token() -> str | None:
    """Read the Claude Code OAuth access token from the credentials file.

    Returns None if the file is missing/unreadable or has no token — callers
    then serve the cache/fallback. The token is a secret: never logged, never
    returned to the browser. Kept a free function so tests can monkeypatch it.
    """
    try:
        data = json.loads(_CREDENTIALS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    tok = data.get("claudeAiOauth", {}).get("accessToken")
    return tok if isinstance(tok, str) and tok else None


def _fetch_models_blocking() -> list[dict] | None:
    """GET Anthropic /v1/models with the OAuth bearer, newest-first.

    Blocking (urllib) — run via ``asyncio.to_thread`` so it never blocks the
    loop, matching the broker-proxy helpers. Returns [{id, display_name}] or
    None on any transport/auth/parse failure (caller serves cache/fallback).
    """
    import urllib.error
    import urllib.request

    token = _read_oauth_token()
    if not token:
        return None
    req = urllib.request.Request(
        _ANTHROPIC_MODELS_URL,
        headers={
            "authorization": f"Bearer {token}",
            "anthropic-version": "2023-06-01",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        return None
    out = []
    for m in payload.get("data", []):
        mid = m.get("id")
        if isinstance(mid, str) and mid.startswith("claude-"):
            out.append({"id": mid, "display_name": m.get("display_name") or mid})
    return out or None


@app.get("/api/models")
async def get_models():
    """Live Anthropic model catalog for the picker.

    ``source``: "live" (fresh or within-TTL cache), "stale" (old cache after a
    failed refresh), or "fallback" (static list — nothing else available).
    """
    now = _time.monotonic()
    cached = _MODELS_CACHE["data"]
    if cached and now - _MODELS_CACHE["ts"] < _MODELS_TTL:
        return {"models": cached, "source": "live"}
    live = await asyncio.to_thread(_fetch_models_blocking)
    if live:
        _MODELS_CACHE["data"] = live
        _MODELS_CACHE["ts"] = now
        return {"models": live, "source": "live"}
    if cached:
        return {"models": cached, "source": "stale"}
    return {"models": _FALLBACK_MODELS, "source": "fallback"}


# ── Routes ───────────────────────────────────────────────


@app.get("/")
async def index():
    # Serve React frontend dist if available (production build)
    if FRONTEND_DIST.is_dir() and (FRONTEND_DIST / "index.html").exists():
        # Never cache index.html — it references versioned asset hashes that change
        # on every build.  If WebView2 (or a browser) caches this, users see stale
        # JS/CSS after an update because the old index.html still points to the old
        # hashed asset filenames.
        return FileResponse(
            FRONTEND_DIST / "index.html",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
        )
    return HTMLResponse("Frontend not built. Run: cd web/frontend && npm run build", 404)


@app.get("/api/me")
async def me():
    """Always authenticated in local mode."""
    return {"authenticated": True, "mode": "local", "email": "local@localhost", "name": "Local User"}


# ── File Upload ──────────────────────────────────────────


@app.post("/api/upload")
async def upload_files(request: Request, files: list[UploadFile] = File(...)):
    """Accept multipart file uploads, save to temp dir, return paths."""
    global _upload_dir_size
    saved_paths: list[str] = []
    errors: list[str] = []

    for upload in files:
        ext = Path(upload.filename or "").suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            errors.append(f"Rejected '{upload.filename}': unsupported file type '{ext}'")
            continue

        content = await upload.read()
        file_size = len(content)

        if file_size > MAX_FILE_SIZE:
            errors.append(f"Rejected '{upload.filename}': exceeds 50MB limit")
            continue

        # Security: strip directory components from the user-supplied filename.
        # upload.filename comes from the multipart Content-Disposition header and
        # is fully attacker-controlled.  A value like "../../etc/cron.d/evil"
        # would cause pathlib to resolve the destination outside UPLOAD_DIR.
        # Path.name returns only the final component ("evil"), neutralising the
        # traversal.  The `or "upload"` fallback handles the edge case where the
        # filename is *only* directory separators (e.g. "../../"), which yields
        # an empty string after .name.
        stripped_name = Path(upload.filename or "").name or "upload"

        # Lock the quota-check-and-write as an atomic unit.  Without this,
        # two concurrent requests could both read the same _upload_dir_size,
        # both pass the check, and together exceed the 200MB limit.
        async with _upload_lock:
            if _upload_dir_size + file_size > MAX_UPLOAD_DIR_SIZE:
                errors.append(f"Rejected '{upload.filename}': upload directory full (200MB limit)")
                continue

            safe_name = f"{uuid.uuid4().hex[:8]}_{stripped_name}"
            dest = UPLOAD_DIR / safe_name
            dest.write_bytes(content)
            _upload_dir_size += file_size

        saved_paths.append(str(dest))

    result: dict = {"paths": saved_paths}
    if errors:
        result["errors"] = errors
    return JSONResponse(result)


@app.delete("/api/upload")
async def clear_upload_dir(keep: int = 10):
    """Delete old uploads, keeping the *keep* most-recently-modified files."""
    global _upload_dir_size
    files = sorted(UPLOAD_DIR.iterdir(), key=lambda p: p.stat().st_mtime)
    to_delete = files[:-keep] if keep > 0 else files
    deleted = 0
    async with _upload_lock:
        for f in to_delete:
            try:
                f.unlink()
                deleted += 1
            except OSError:
                logger.debug("Failed to delete upload file %s during cleanup", f, exc_info=True)
        _upload_dir_size = sum(f.stat().st_size for f in UPLOAD_DIR.iterdir())
    return JSONResponse({"deleted": deleted, "kept": len(files) - deleted, "quota_bytes": _upload_dir_size})


# ── Directory Browse ─────────────────────────────────────


@app.get("/api/browse")
async def browse_directories(path: str = ""):
    """List subdirectories of the given path for folder autocomplete."""
    if not path:
        if sys.platform == "win32":
            # Return drive roots on Windows
            import string
            drives = []
            for letter in string.ascii_uppercase:
                drive = f"{letter}:\\"
                if os.path.isdir(drive):
                    drives.append(drive)
            return JSONResponse({"dirs": drives, "parent": ""})
        else:
            return JSONResponse({"dirs": ["/"], "parent": ""})

    target = Path(path)
    if not target.is_dir():
        # Try parent if path is partial (e.g. "C:\Cod" -> list "C:\" filtered to "Cod*")
        parent = target.parent
        prefix = target.name.lower()
        if parent.is_dir():
            try:
                dirs = sorted(
                    [
                        str(p)
                        for p in parent.iterdir()
                        if p.is_dir()
                        and p.name.lower().startswith(prefix)
                        and not p.name.startswith(".")
                    ]
                )[:20]
                return JSONResponse({"dirs": dirs, "parent": str(parent)})
            except PermissionError:
                return JSONResponse({"dirs": [], "parent": str(parent)})
        return JSONResponse({"dirs": [], "parent": ""})

    try:
        dirs = sorted(
            [
                str(p)
                for p in target.iterdir()
                if p.is_dir() and not p.name.startswith(".")
            ]
        )[:50]
        return JSONResponse({"dirs": dirs, "parent": str(target)})
    except PermissionError:
        return JSONResponse({"dirs": [], "parent": str(target)})


# ── Git Status ────────────────────────────────────────────


@app.get("/api/git/status")
async def git_status(path: str):
    """Get git branch and dirty state for a directory."""
    target = Path(path)
    if not target.is_dir():
        return JSONResponse({"git": False})

    try:
        branch_result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=str(target), capture_output=True, text=True, timeout=5,
        )
        if branch_result.returncode != 0:
            return JSONResponse({"git": False})

        branch = branch_result.stdout.strip()

        status_result = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(target), capture_output=True, text=True, timeout=5,
        )
        lines = [line for line in status_result.stdout.strip().split("\n") if line.strip()]
        dirty = len(lines) > 0

        return JSONResponse({
            "git": True,
            "branch": branch,
            "dirty": dirty,
            "files_changed": len(lines),
        })
    except Exception:
        logger.debug("Git status failed for %s", path, exc_info=True)
        return JSONResponse({"git": False})


# ── Terminal Output Buffer ────────────────────────────────


@app.get("/api/terminals/{terminal_id}/output")
async def get_terminal_output(terminal_id: str, since: int = 0):
    """Return ANSI-stripped terminal output.

    Args:
        since: Return only lines at index >= since (0 = all lines).
               Use the returned total_lines value as the next since cursor.
    """
    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)
    all_lines = pty_manager.get_output_buffer(terminal_id)
    total = len(all_lines)
    sliced = all_lines[since:] if since > 0 else all_lines
    activity_state = session.tracker.state
    return JSONResponse({
        "terminal_id": terminal_id,
        "lines": sliced,
        "total_lines": total,
        "activity_state": activity_state,
        "context_percent": session.tracker.context_percent,
    })


# ── Background PTY Reader ─────────────────────────────────


async def _session_reader(terminal_id: str):
    """Drain PTY output for a session — feeds state tracker and queues data for WebSocket consumers.

    Runs as a background task for every session. Without this, sessions with no
    active WebSocket connection (e.g. detached/background terminals) have their
    PTY output buffer fill up, stalling or killing the underlying Claude process.
    """
    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return
    while session.alive:
        data = await pty_manager.read_pty(terminal_id)
        if data:
            session.tracker.feed(data)
            session.last_output_time = _time.monotonic()
            if session.tracker.effort:
                session.effort = session.tracker.effort
            if "\ufffd" in data:
                logger.debug(
                    "PTY replacement chars in terminal %s: %r",
                    terminal_id,
                    data[max(0, data.index("\ufffd") - 20): data.index("\ufffd") + 20],
                )
            try:
                session.output_queue.put_nowait(data)
            except asyncio.QueueFull:
                pass  # WebSocket consumer is slow — data is already in ring buffer
        else:
            if not session.alive:
                break
            await asyncio.sleep(0.01)


# ── Terminal Input ────────────────────────────────────────


@app.post("/api/terminals/{terminal_id}/input")
async def send_terminal_input(terminal_id: str, request: Request):
    """Send text input to a terminal's PTY."""
    body = await request.json()
    text = body.get("text", "")
    if not text:
        return JSONResponse({"error": "No text provided"}, status_code=400)
    if pty_manager.write_pty(terminal_id, text):
        return JSONResponse({"status": "sent"})
    return JSONResponse({"error": "Terminal not found or dead"}, status_code=404)


# ── Terminal Management (REST) ───────────────────────────


@app.post("/api/terminals")
async def create_terminal(request: Request):
    """Create a new interactive Claude CLI terminal session."""
    body = await request.json()
    name = body.get("name", "")
    workdir = body.get("workdir", str(Path.cwd()))
    model = body.get("model", "sonnet")
    provider = body.get("provider", "anthropic")
    provider_model = body.get("providerModel", "")
    resume_id = body.get("resume_session_id", "")
    continue_last = body.get("continue", False)
    bypass_permissions = body.get("bypassPermissions", False)
    permission_mode = body.get("permissionMode", "default")
    effort = body.get("effort", "")
    fast = body.get("fast", False)
    cols = body.get("cols", 120)
    rows = body.get("rows", 30)

    try:
        session = pty_manager.create_terminal(
            name=name,
            workdir=workdir,
            model=model,
            provider=provider,
            provider_model=provider_model,
            resume_session_id=resume_id,
            continue_last=continue_last,
            bypass_permissions=bypass_permissions,
            permission_mode=permission_mode,
            effort=effort,
            fast=fast,
            cols=cols,
            rows=rows,
        )
        # Post-spawn health check: give Claude CLI time to initialize Node.js.
        # The 1.5s wait also ensures the fast-mode --settings file has been read
        # by the process before we clean it up below.
        await asyncio.sleep(1.5)
        if not session.pty.isalive():
            exit_code = getattr(session.pty, "exitstatus", "?")
            logger.error("Session %s died on spawn (exit: %s)", session.id, exit_code)
            pty_manager.kill_terminal(session.id)
            return JSONResponse(
                {"error": "Claude process exited immediately after spawn. "
                          "Ensure 'claude' CLI is installed and authenticated."},
                status_code=500,
            )

        # Clean up the fast-mode temp settings file now that the process has had
        # 1.5s to read it on startup.  Best-effort: failure is non-fatal.
        fast_settings_path = getattr(session, "_fast_settings_path", None)
        if fast_settings_path:
            try:
                os.unlink(fast_settings_path)
            except Exception:
                logger.debug("Fast mode: failed to remove temp settings file %s", fast_settings_path, exc_info=True)

        logger.info("Session %s alive after spawn", session.id)
        asyncio.create_task(_session_reader(session.id))
        return JSONResponse({
            "id": session.id,
            "name": session.name,
            "model": session.model,
            "provider": session.provider,
            "created_at": session.created_at,
        })
    except ClaudeCliNotFound as e:
        # resolve_claude_cli() already probed every standard install location
        # and built an actionable message (install link + CLAUDE_CLI_PATH
        # escape hatch + what was searched) — surface it verbatim rather than
        # flattening it to "not found".
        logger.error("Claude CLI not found: %s", e)
        return JSONResponse({"error": str(e)}, status_code=500)
    except FileNotFoundError as e:
        logger.error("Spawn failed — executable not found", exc_info=True)
        return JSONResponse(
            {"error": f"Could not start the session: {e}"},
            status_code=500,
        )
    except Exception as e:
        return JSONResponse(
            {"error": f"Failed to spawn terminal: {str(e)}"},
            status_code=500,
        )


@app.get("/api/terminals")
async def list_terminals():
    """List all active terminal sessions."""
    return JSONResponse({"terminals": pty_manager.list_terminals()})


@app.delete("/api/terminals/{terminal_id}")
async def delete_terminal(terminal_id: str):
    """Kill a terminal session."""
    if pty_manager.kill_terminal(terminal_id):
        return JSONResponse({"status": "killed", "id": terminal_id})
    return JSONResponse({"error": "Terminal not found"}, status_code=404)


# ── Per-Session CLI Actions ──────────────────────────────

# Best-effort cap on how long the Claude-side /rename sync waits for the
# target session to go typing-quiet + idle. This runs synchronously inside
# the PATCH request, so it must stay short — the Cockpit-side rename has
# already succeeded by this point regardless of the outcome.
_RENAME_SYNC_TIMEOUT = 5.0

# Slash commands the /command route is allowed to inject. Keeps this route
# from becoming an arbitrary-injection surface beyond the existing /input
# route — only a curated set of safe, well-understood commands are allowed.
_ALLOWED_COMMAND_PREFIXES = ("/compact", "/clear", "/rename", "/model", "/fast")

# How long POST /command waits (typing-quiet + idle) before giving up with a
# 409. Short because this is a synchronous user-triggered action — the caller
# is waiting on the HTTP response, unlike the V2/V3 bridge's 5-minute patience.
_COMMAND_GATE_TIMEOUT = 5.0


async def _sync_claude_rename(terminal_id: str, name: str) -> bool:
    """Best-effort: inject ``/rename <name>`` into the live Claude Code session.

    Gated on typing-quiet + idle (capped at _RENAME_SYNC_TIMEOUT) via the same
    helper bridge_manager's V1 manual relay uses. Any failure — gate timeout,
    dead session, or PTY write failure — is swallowed and reported back as
    False. The caller (PATCH /api/terminals/{id}) has already committed the
    Cockpit-side rename by the time this runs, and that must NOT be rolled
    back just because the Claude Code sync didn't land.
    """
    try:
        idle = await _wait_for_idle_simple(terminal_id, timeout=_RENAME_SYNC_TIMEOUT)
        if not idle:
            return False
        return bool(await pty_manager.write_pty_async(terminal_id, _wrap(f"/rename {name}")))
    except Exception:
        logger.warning("Claude rename sync failed for terminal %s", terminal_id, exc_info=True)
        return False


@app.patch("/api/terminals/{terminal_id}")
async def rename_terminal_route(terminal_id: str, request: Request):
    """Rename a Cockpit session, optionally syncing the name into Claude Code.

    Body: {"name": str, "sync_claude": bool=false}
    The Cockpit-side rename always happens first and always succeeds if the
    terminal exists and the name validates — sync_claude failure never rolls
    it back (see _sync_claude_rename).
    """
    body = await request.json()
    name = body.get("name", "")
    sync_claude = bool(body.get("sync_claude", False))

    if not isinstance(name, str) or not name.strip():
        return JSONResponse({"error": "name is required"}, status_code=400)
    name = name.strip()
    if len(name) > 100:
        return JSONResponse({"error": "name must be 100 characters or fewer"}, status_code=400)

    session = pty_manager.rename_terminal(terminal_id, name)
    if session is None:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    claude_synced = False
    if sync_claude:
        claude_synced = await _sync_claude_rename(terminal_id, name)

    return JSONResponse({
        "ok": True,
        "terminal": pty_manager._session_to_dict(session),
        "sync_requested": sync_claude,
        "claude_synced": claude_synced,
    })


@app.post("/api/terminals/{terminal_id}/interrupt")
async def interrupt_terminal(terminal_id: str):
    """Immediately send ESC to interrupt a busy generation — no idle/typing gating.

    Deliberately bypasses _wait_for_idle_simple: the whole point of an
    interrupt is to reach a session that is currently busy.
    """
    session = pty_manager.get_terminal(terminal_id)
    if session is None or not session.alive:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    ok = await pty_manager.write_pty_async(terminal_id, "\x1b")
    if not ok:
        return JSONResponse({"error": "Failed to send interrupt"}, status_code=500)
    return JSONResponse({"ok": True})


@app.post("/api/terminals/{terminal_id}/command")
async def send_terminal_command(terminal_id: str, request: Request):
    """Inject an allowlisted slash command as if typed, gated on typing-quiet + idle.

    Body: {"command": str} — must start with "/", be a single line, and
    start with one of _ALLOWED_COMMAND_PREFIXES.
    """
    body = await request.json()
    command = body.get("command", "")

    if not isinstance(command, str) or not command.startswith("/"):
        return JSONResponse({"error": "command must start with '/'"}, status_code=400)
    if "\n" in command or "\r" in command:
        return JSONResponse({"error": "command must be a single line"}, status_code=400)
    if len(command) > 500:
        return JSONResponse({"error": "command must be 500 characters or fewer"}, status_code=400)
    if not command.startswith(_ALLOWED_COMMAND_PREFIXES):
        return JSONResponse(
            {"error": f"command must start with one of: {', '.join(_ALLOWED_COMMAND_PREFIXES)}"},
            status_code=400,
        )

    session = pty_manager.get_terminal(terminal_id)
    if session is None or not session.alive:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    idle = await _wait_for_idle_simple(terminal_id, timeout=_COMMAND_GATE_TIMEOUT)
    if not idle:
        return JSONResponse({"ok": False, "error": "Session is busy"}, status_code=409)

    ok = await pty_manager.write_pty_async(terminal_id, _wrap(command))
    if not ok:
        return JSONResponse({"ok": False, "error": "PTY write failed"}, status_code=500)
    return JSONResponse({"ok": True})


@app.get("/api/system")
async def system_stats():
    """Return system resource usage: CPU, RAM, and GPU (if available).

    GPU utilization is fetched via nvidia-smi. If nvidia-smi is unavailable
    or times out, gpu_percent is null — this never causes the endpoint to fail.
    All float values are rounded to 1 decimal place.
    """
    import psutil

    cpu = round(psutil.cpu_percent(interval=0.1), 1)

    vm = psutil.virtual_memory()
    ram_percent = round(vm.percent, 1)
    ram_used_gb = round(vm.used / (1024 ** 3), 1)
    ram_total_gb = round(vm.total / (1024 ** 3), 1)

    gpu_percent: float | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            "nvidia-smi",
            "--query-gpu=utilization.gpu",
            "--format=csv,noheader,nounits",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=2.0)
            first_line = stdout.decode("utf-8", errors="replace").strip().splitlines()[0]
            gpu_percent = round(float(first_line), 1)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
        except (ValueError, IndexError):
            logger.debug("GPU query returned unparseable output", exc_info=True)
    except (FileNotFoundError, OSError):
        logger.debug("nvidia-smi not available", exc_info=True)
    except Exception:
        logger.debug("GPU query failed", exc_info=True)

    return JSONResponse({
        "cpu_percent": cpu,
        "ram_percent": ram_percent,
        "ram_used_gb": ram_used_gb,
        "ram_total_gb": ram_total_gb,
        "gpu_percent": gpu_percent,
    })


@app.post("/api/terminals/{terminal_id}/resize")
async def resize_terminal(terminal_id: str, request: Request):
    """Resize a terminal's PTY."""
    body = await request.json()
    cols = body.get("cols", 120)
    rows = body.get("rows", 30)
    if pty_manager.resize_terminal(terminal_id, cols, rows):
        return JSONResponse({"status": "resized", "cols": cols, "rows": rows})
    return JSONResponse({"error": "Terminal not found or dead"}, status_code=404)


# ── WebSocket Terminal Bridge ────────────────────────────


@app.websocket("/ws/terminal/{terminal_id}")
async def websocket_terminal(websocket: WebSocket, terminal_id: str):
    """Bridge xterm.js <-> PTY via WebSocket."""
    session = pty_manager.get_terminal(terminal_id)
    await websocket.accept()

    if not session:
        await websocket.close(code=4004, reason="Terminal not found")
        return

    # Bump the generation counter and capture this connection's generation value.
    # If another WS connects to the same terminal later it will bump again, making
    # this forwarder's my_generation stale — the check in pty_to_ws() will stop it.
    # Safe without a lock: all WS handlers run on the single asyncio event loop.
    session.active_consumer += 1
    my_generation = session.active_consumer

    async def pty_to_ws():
        """Forward PTY output to WebSocket (reads from session queue; background reader drains PTY).

        Only the forwarder whose my_generation matches session.active_consumer is the active
        consumer. If a newer WS connects, active_consumer is bumped and this forwarder stops
        draining — "latest connection wins" — preventing split-stream corruption.
        """
        while session.alive and session.active_consumer == my_generation:
            try:
                try:
                    data = await asyncio.wait_for(session.output_queue.get(), timeout=0.5)
                except asyncio.TimeoutError:
                    continue
                # Re-check generation after get() returns — another WS may have connected
                # in the brief window between the get() call and now. If superseded, do NOT
                # send: put the item back so the new consumer receives it intact.
                if session.active_consumer != my_generation:
                    try:
                        session.output_queue.put_nowait(data)
                    except asyncio.QueueFull:
                        pass  # Queue full: one item lost is acceptable on supersession
                    logger.debug(
                        "PTY->WS forwarder for terminal %s superseded (gen %d → %d); stopping.",
                        terminal_id, my_generation, session.active_consumer,
                    )
                    break
                await websocket.send_text(data)
                await asyncio.sleep(0)
            except (WebSocketDisconnect, RuntimeError, ConnectionError):
                break
            except Exception as e:
                logger.debug("PTY->WS forward error: %s", e)
                await asyncio.sleep(0.05)

        # Only send the drain + "[Session ended]" banner when the session actually died.
        # A superseded forwarder (session still alive, just displaced) must NOT send the
        # banner — that would falsely signal session death to an active popout window.
        if not session.alive:
            # Drain any buffered data before the "Session ended" banner
            while not session.output_queue.empty():
                try:
                    data = session.output_queue.get_nowait()
                    await websocket.send_text(data)
                except Exception:
                    break

            try:
                await websocket.send_text("\r\n\x1b[33m[Session ended]\x1b[0m\r\n")
            except Exception:
                logger.debug("Failed to send [Session ended] banner for terminal %s", terminal_id, exc_info=True)

    async def heartbeat():
        """Send periodic ping to keep the connection alive."""
        while True:
            await asyncio.sleep(30)
            try:
                await websocket.send_text('{"type":"ping"}')
            except Exception:
                break

    reader_task = asyncio.create_task(pty_to_ws())
    heartbeat_task = asyncio.create_task(heartbeat())

    try:
        while True:
            msg = await websocket.receive()

            if msg.get("type") == "websocket.disconnect":
                break

            text = msg.get("text")
            if text:
                if text.startswith("{"):
                    try:
                        ctrl = json.loads(text)
                        if ctrl.get("type") == "resize":
                            pty_manager.resize_terminal(
                                terminal_id,
                                ctrl.get("cols", 120),
                                ctrl.get("rows", 30),
                            )
                            continue
                        if ctrl.get("type") == "pong":
                            continue
                    except json.JSONDecodeError:
                        logger.debug("Malformed WS control message for terminal %s: %r", terminal_id, text)
                session = pty_manager.get_terminal(terminal_id)
                if session is not None:
                    session.last_user_input_time = _time.monotonic()
                await pty_manager.write_pty_async(terminal_id, text)

            data = msg.get("bytes")
            if data:
                session = pty_manager.get_terminal(terminal_id)
                if session is not None:
                    session.last_user_input_time = _time.monotonic()
                await pty_manager.write_pty_async(terminal_id, data.decode("utf-8", errors="replace"))

    except WebSocketDisconnect:
        logger.debug("WS client disconnected for terminal %s", terminal_id)
    except Exception:
        logger.warning("WS handler error for terminal %s", terminal_id, exc_info=True)
    finally:
        reader_task.cancel()
        heartbeat_task.cancel()
        try:
            await reader_task
        except asyncio.CancelledError:
            pass
        try:
            await heartbeat_task
        except asyncio.CancelledError:
            pass


# ── Bridge / Peer Coordination ────────────────────────────


@app.get("/api/terminals/{terminal_id}/latest-assistant")
async def get_latest_assistant(terminal_id: str):
    """Return the text content of the most recent assistant turn from this session's JSONL."""
    from jsonl_watcher import read_all_messages

    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return JSONResponse({"text": None, "reason": "no JSONL yet"})

    messages = read_all_messages(jsonl_path)
    for entry in reversed(messages):
        if entry.get("type") != "assistant":
            continue
        text_parts = [
            b.get("text", "")
            for b in entry.get("content", [])
            if isinstance(b, dict) and b.get("type") == "text"
        ]
        joined = "\n".join(p for p in text_parts if p).strip()
        if joined:
            return JSONResponse({
                "text": joined,
                "message_id": entry.get("id"),
                "timestamp": entry.get("timestamp"),
            })
    return JSONResponse({"text": None, "reason": "no assistant message found"})


@app.get("/api/terminals/{terminal_id}/workflows")
def get_workflows(terminal_id: str):
    """Return recent Workflow tool invocations from this session's JSONL.

    For each `tool_use` whose name is "Workflow", pairs it with its matching
    `tool_result` (if present) and reports `status` as "in_progress" or "completed".
    Used by the per-pane WorkflowsPanel in the frontend.
    """
    from jsonl_watcher import read_all_messages

    session = pty_manager.get_terminal(terminal_id)
    if session is None:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)
    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return {"workflows": []}

    messages = read_all_messages(jsonl_path)
    # Build map of tool_use_id -> tool_result entry for status pairing
    tool_results: dict[str, dict] = {}
    for m in messages:
        if m.get("type") == "tool_result":
            for block in m.get("content", []):
                tuid = block.get("tool_use_id")
                if tuid:
                    tool_results[tuid] = {
                        "completed_at": m.get("timestamp"),
                        "is_error": block.get("is_error", False),
                    }

    workflows: list[dict] = []
    for m in messages:
        if m.get("type") != "assistant":
            continue
        for block in m.get("content", []):
            if block.get("type") != "tool_use":
                continue
            if block.get("tool_name") != "Workflow":
                continue
            tool_id = block.get("tool_id", "")
            inp = block.get("input", {}) or {}
            # `script` may be huge — _summarize_tool_input already truncates to 200 chars.
            # We only surface the script meta-fields; the raw script body is not shown.
            result = tool_results.get(tool_id)
            workflows.append({
                "tool_id": tool_id,
                "name": inp.get("name") or inp.get("title") or "workflow",
                "description": inp.get("description") or "",
                "args": inp.get("args"),
                "script_preview": (inp.get("script") if isinstance(inp.get("script"), str) else None),
                "script_path": inp.get("scriptPath"),
                "started_at": m.get("timestamp"),
                "completed_at": result["completed_at"] if result else None,
                "is_error": result["is_error"] if result else False,
                "status": "completed" if result else "in_progress",
            })

    # Most recent first
    workflows.sort(key=lambda w: w.get("started_at") or "", reverse=True)
    # Cap to 20 most recent — keeps the response small for polling
    return {"workflows": workflows[:20]}


@app.get("/api/terminals/{terminal_id}/usage")
def get_terminal_usage(terminal_id: str):
    """Return persistent token/cost usage for a session, merged with its live effort level.

    Usage totals come from the SQLite-backed usage_tracker (survives JSONL
    deletion); effort is read from the live in-memory session (parsed from
    PTY output — see SessionStateTracker._EFFORT_RE).
    """
    session = pty_manager.get_terminal(terminal_id)
    if session is None:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)
    summary = usage_tracker.session_summary(terminal_id)
    summary["effort"] = session.effort or None
    return summary


@app.get("/api/usage/daily")
def get_daily_usage(day: str | None = None):
    """Return the daily cost/token rollup, optionally for a specific ``day`` (YYYY-MM-DD)."""
    return usage_tracker.daily_summary(day)


@app.post("/api/bridge/manual")
async def bridge_manual(request: Request):
    """One-shot relay: inject a message from one session's latest output into another session."""
    body = await request.json()
    from_id = body.get("from_terminal_id", "")
    to_id = body.get("to_terminal_id", "")
    message = body.get("message", "")
    prefix = body.get("prefix")  # optional attribution prefix, may be None
    if not from_id or not to_id or not message:
        return JSONResponse(
            {"ok": False, "error": "from_terminal_id, to_terminal_id, message required"},
            status_code=400,
        )
    if from_id == to_id:
        return JSONResponse(
            {"ok": False, "error": "Cannot bridge a session to itself"},
            status_code=400,
        )
    # Guard: refuse if either session is already enrolled in an active auto
    # bridge or channel. A manual relay writing into a session whose PTY is
    # already being driven by an active V2/V3 relay task would interleave
    # writes to the same input buffer and produce corrupt, unpredictable
    # output — same rationale as the guard on /api/bridge/auto.
    active = [b for b in bridge_manager.list_active() if b.get("state") == "active"]
    busy_ids = {b["from_id"] for b in active} | {b["to_id"] for b in active}
    busy_ids |= channel_manager.member_ids()
    if from_id in busy_ids or to_id in busy_ids:
        return JSONResponse(
            {"ok": False, "error": "One or both sessions already in an active bridge or channel"},
            status_code=409,
        )
    result = await bridge_manager.start_manual(from_id, to_id, message, prefix)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


@app.post("/api/bridge/auto")
async def bridge_auto(request: Request):
    """Start an autonomous two-session bridge with a shared kickoff prompt."""
    body = await request.json()
    from_id = body.get("from_terminal_id", "")
    to_id = body.get("to_terminal_id", "")
    kickoff = body.get("kickoff_prompt", "")
    try:
        max_turns = int(body.get("max_turns", 4))
    except (TypeError, ValueError):
        return JSONResponse(
            {"ok": False, "error": "max_turns must be an integer"},
            status_code=400,
        )
    if not from_id or not to_id or not kickoff:
        return JSONResponse(
            {"ok": False, "error": "from_terminal_id, to_terminal_id, kickoff_prompt required"},
            status_code=400,
        )
    if from_id == to_id:
        return JSONResponse(
            {"ok": False, "error": "Cannot bridge a session to itself"},
            status_code=400,
        )
    if not 1 <= max_turns <= 10:
        return JSONResponse(
            {"ok": False, "error": "max_turns must be between 1 and 10"},
            status_code=400,
        )
    # Guard: refuse if either session is already enrolled in an active bridge.
    # Two active bridges on the same session would interleave writes to its PTY
    # input buffer and produce corrupt, unpredictable output.
    active = [b for b in bridge_manager.list_active() if b.get("state") == "active"]
    busy_ids = {b["from_id"] for b in active} | {b["to_id"] for b in active}
    busy_ids |= channel_manager.member_ids()
    if from_id in busy_ids or to_id in busy_ids:
        return JSONResponse(
            {"ok": False, "error": "One or both sessions already in an active bridge or channel"},
            status_code=409,
        )
    result = await bridge_manager.start_auto(from_id, to_id, kickoff, max_turns)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


@app.delete("/api/bridge/{bridge_id}")
async def bridge_stop(bridge_id: str):
    """Stop an active auto bridge by bridge_id."""
    ok = bridge_manager.stop(bridge_id)
    if not ok:
        return JSONResponse({"ok": False, "error": "Bridge not found"}, status_code=404)
    return JSONResponse({"ok": True})


@app.get("/api/bridge")
async def bridge_list():
    """List all known bridges (active and recently ended)."""
    return JSONResponse({"bridges": bridge_manager.list_active()})


@app.post("/api/bridge/channel")
async def channel_start(request: Request):
    """Start an N-session channel: one lead coordinating N workers."""
    body = await request.json()
    lead_id = body.get("lead_id", "")
    worker_ids = body.get("worker_ids", [])
    kickoff = body.get("kickoff_prompt", "")
    try:
        max_turns = int(body.get("max_turns", 6))
    except (TypeError, ValueError):
        return JSONResponse({"ok": False, "error": "max_turns must be an integer"}, status_code=400)

    # Validation
    if not lead_id or not worker_ids or not kickoff:
        return JSONResponse(
            {"ok": False, "error": "lead_id, worker_ids, kickoff_prompt required"},
            status_code=400,
        )
    if not isinstance(worker_ids, list) or not all(isinstance(w, str) for w in worker_ids):
        return JSONResponse({"ok": False, "error": "worker_ids must be a list of strings"}, status_code=400)
    if len(worker_ids) > 7:  # lead + 7 workers = 8 total, matches MAX_SESSIONS default
        return JSONResponse({"ok": False, "error": "Maximum 7 workers per channel"}, status_code=400)
    if not 1 <= max_turns <= 20:
        return JSONResponse({"ok": False, "error": "max_turns must be between 1 and 20"}, status_code=400)

    # Conflict guard: reject if any session is in an active 2-session bridge OR active channel
    active_bridges = [b for b in bridge_manager.list_active() if b.get("state") == "active"]
    bridge_busy = {b["from_id"] for b in active_bridges} | {b["to_id"] for b in active_bridges}
    channel_busy = channel_manager.member_ids()
    all_busy = bridge_busy | channel_busy
    all_requested = {lead_id} | set(worker_ids)
    overlap = all_requested & all_busy
    if overlap:
        return JSONResponse(
            {"ok": False, "error": f"Sessions already in an active bridge or channel: {sorted(overlap)}"},
            status_code=409,
        )

    result = await channel_manager.start(lead_id, worker_ids, kickoff, max_turns)
    status = 200 if result.get("ok") else 400
    return JSONResponse(result, status_code=status)


@app.delete("/api/bridge/channel/{channel_id}")
async def channel_stop(channel_id: str):
    """Stop an active channel by channel_id."""
    ok = channel_manager.stop(channel_id)
    if not ok:
        return JSONResponse({"ok": False, "error": "Channel not found"}, status_code=404)
    return JSONResponse({"ok": True})


@app.get("/api/bridge/channel")
async def channel_list():
    """List all known channels (active and recently ended)."""
    return JSONResponse({"channels": channel_manager.list_active()})


# ── JSONL Message Stream (SSE) ───────────────────────────


@app.get("/api/terminals/{terminal_id}/messages")
async def get_terminal_messages(terminal_id: str):
    """Return all parsed messages from a session's JSONL file."""
    from jsonl_watcher import read_all_messages

    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return JSONResponse({"messages": [], "jsonl_path": None})

    messages = read_all_messages(jsonl_path)
    return JSONResponse({
        "messages": messages,
        "jsonl_path": jsonl_path,
        "claude_session_id": session.claude_session_id,
    })


@app.get("/api/terminals/{terminal_id}/messages/stream")
async def stream_terminal_messages(terminal_id: str, from_beginning: str = "true"):
    """SSE stream of new messages from a session's JSONL file.

    Each SSE event is a JSON-encoded message object.
    Keeps streaming until the client disconnects.
    """
    from jsonl_watcher import tail_jsonl

    session = pty_manager.get_terminal(terminal_id)
    if not session:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return JSONResponse({"error": "No JSONL path available"}, status_code=404)

    async def event_generator():
        try:
            async for message in tail_jsonl(
                jsonl_path,
                from_beginning=(from_beginning.lower() == "true"),
            ):
                data = json.dumps(message)
                yield f"data: {data}\n\n"
        except asyncio.CancelledError:
            pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── Markdown Export ───────────────────────────────────────

_EXPORT_FILENAME_UNSAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _sanitize_export_filename(name: str) -> str:
    """Convert a session name into a filesystem-safe ASCII slug for Content-Disposition."""
    ascii_name = name.encode("ascii", "ignore").decode("ascii")
    sanitized = _EXPORT_FILENAME_UNSAFE_RE.sub("-", ascii_name).strip("-")
    return sanitized or "session"


def _extract_markdown_text(message: dict) -> str:
    """Join all text/thinking blocks in a parsed jsonl_watcher message into one string.

    Tool-use/tool-result blocks are intentionally omitted here — the export's
    goal is a readable transcript, not a full tool-call audit trail.
    """
    parts: list[str] = []
    for block in message.get("content", []):
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text = block.get("text", "")
            if text:
                parts.append(text)
    return "\n\n".join(parts).strip()


def _render_markdown_export(session_name: str, model: str, workdir: str, messages: list[dict]) -> str:
    """Render a parsed message list as a Markdown transcript.

    Format: H1 session name, one metadata line, then ``## User`` / ``## Assistant``
    sections in chronological order. Tool-use/tool-result/system noise is skipped
    (thinking/text blocks are all _extract_markdown_text keeps).
    """
    exported_at = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# {session_name}",
        "",
        f"_Model: {model or 'unknown'} · Workdir: {workdir or 'unknown'} · Exported: {exported_at}_",
        "",
    ]
    for message in messages:
        msg_type = message.get("type")
        if msg_type not in ("user", "assistant"):
            continue  # tool_result / system entries are noise for a conversation transcript
        text = _extract_markdown_text(message)
        if not text:
            continue
        heading = "## User" if msg_type == "user" else "## Assistant"
        lines.append(heading)
        lines.append("")
        lines.append(text)
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


@app.get("/api/terminals/{terminal_id}/export")
async def export_terminal_markdown(terminal_id: str):
    """Render a session's conversation as a downloadable Markdown transcript."""
    from jsonl_watcher import read_all_messages

    session = pty_manager.get_terminal(terminal_id)
    if session is None:
        return JSONResponse({"error": "Terminal not found"}, status_code=404)

    jsonl_path = pty_manager._get_jsonl_path(session)
    if not jsonl_path:
        return JSONResponse({"error": "No conversation to export yet"}, status_code=404)

    messages = read_all_messages(jsonl_path)
    markdown = _render_markdown_export(session.name, session.model, session.working_dir, messages)

    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M")
    filename = f"{_sanitize_export_filename(session.name)}-{timestamp}.md"

    return Response(
        content=markdown,
        media_type="text/markdown",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Awareness API ────────────────────────────────────────


def _read_json_file(path: Path) -> dict | list | None:
    try:
        if path.is_file():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.debug("Failed to read JSON: %s", path, exc_info=True)
    return None


def _read_text_file(path: Path, max_bytes: int = 8192) -> str | None:
    try:
        if path.is_file():
            content = path.read_text(encoding="utf-8", errors="replace")
            if len(content) > max_bytes:
                content = content[:max_bytes] + "\n...(truncated)"
            return content
    except Exception:
        logger.debug("Failed to read text: %s", path, exc_info=True)
    return None


def _get_mcp_servers(workdir: str) -> list[dict]:
    servers = []
    home = Path.home()
    user_settings = _read_json_file(home / ".claude" / "settings.json")
    if user_settings and isinstance(user_settings.get("mcpServers"), dict):
        for name, config in user_settings["mcpServers"].items():
            servers.append({"name": name, "source": "user", "command": config.get("command", "")})
    project_mcp = _read_json_file(Path(workdir) / ".mcp.json")
    if project_mcp and isinstance(project_mcp.get("mcpServers"), dict):
        for name, config in project_mcp["mcpServers"].items():
            servers.append({"name": name, "source": "project", "command": config.get("command", "")})
    return servers


def _get_skills(workdir: str) -> list[dict]:
    skills = []
    seen = set()

    def scan_dir(base: Path, source: str):
        if not base.is_dir():
            return
        for f in sorted(base.iterdir()):
            if f.suffix != ".md" or f.name.startswith("."):
                continue
            name = f.stem
            if name in seen:
                continue
            seen.add(name)
            desc = ""
            try:
                content = f.read_text(encoding="utf-8", errors="replace")[:1024]
                for line in content.split("\n"):
                    stripped = line.strip()
                    if stripped.startswith("description:"):
                        desc = stripped[len("description:"):].strip().strip('"').strip("'")
                        break
            except Exception:
                logger.debug("Failed to read skill description: %s", f, exc_info=True)
            skills.append({"name": name, "description": desc, "source": source})

    scan_dir(Path(workdir) / ".claude" / "commands", "project")
    scan_dir(Path.home() / ".claude" / "commands", "user")
    return skills


def _get_memory(workdir: str) -> dict:
    home = Path.home()
    claude_projects = home / ".claude" / "projects"
    if not claude_projects.is_dir():
        return {"index": None, "files": []}

    # Derive project ID from workdir
    project_id = workdir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
    memory_dir = claude_projects / project_id / "memory"

    if not memory_dir.is_dir():
        return {"index": None, "files": []}

    index = _read_text_file(memory_dir / "MEMORY.md", max_bytes=4096)
    files = [{"name": f.stem, "filename": f.name}
             for f in sorted(memory_dir.iterdir())
             if f.suffix == ".md" and f.name != "MEMORY.md"]
    return {"index": index, "files": files, "path": str(memory_dir)}


def _get_claude_md(workdir: str) -> str | None:
    current = Path(workdir)
    for _ in range(10):
        for name in ("CLAUDE.md", ".claude/CLAUDE.md"):
            content = _read_text_file(current / name, max_bytes=4096)
            if content is not None:
                return content
        parent = current.parent
        if parent == current:
            break
        current = parent
    return None


@app.get("/api/awareness")
async def get_awareness(workdir: str = ""):
    """Return Claude Code context awareness for a given working directory."""
    if not workdir:
        return JSONResponse({"error": "workdir parameter required"}, status_code=400)
    return JSONResponse({
        "mcp_servers": _get_mcp_servers(workdir),
        "skills": _get_skills(workdir),
        "memory": _get_memory(workdir),
        "claude_md": _get_claude_md(workdir),
    })


@app.post("/api/open-url")
async def open_url(request: Request):
    """Open a URL in the system's default browser."""
    body = await request.json()
    url = body.get("url", "")
    if not (url.startswith("https://") or url.startswith("http://")):
        return JSONResponse({"error": "Only HTTP/HTTPS URLs allowed"}, 400)
    try:
        webbrowser.open(url)
        return JSONResponse({"ok": True})
    except Exception:
        logger.exception("Failed to open URL: %s", url)
        return JSONResponse({"error": "Failed to open URL"}, 500)


# ── Session History ─────────────────────────────────────

_history_cache: dict[str, tuple[float, list[dict]]] = {}


def _derive_project_id(workdir: str) -> str:
    """Derive the Claude Code project ID from a working directory path.

    Must match the logic in pty_manager.py (line 562).
    """
    return workdir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")


def _read_last_line(filepath: Path) -> str:
    """Efficiently read the last line of a file by seeking backwards from EOF."""
    try:
        with open(filepath, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return ""
            # Seek backwards to find the last newline
            pos = size - 1
            # Skip trailing newline(s)
            while pos > 0:
                f.seek(pos)
                ch = f.read(1)
                if ch != b"\n" and ch != b"\r":
                    break
                pos -= 1
            # Now find the newline before the last line
            while pos > 0:
                f.seek(pos)
                ch = f.read(1)
                if ch == b"\n":
                    break
                pos -= 1
            if pos > 0:
                f.seek(pos + 1)
            else:
                f.seek(0)
            return f.read().decode("utf-8", errors="replace").strip()
    except Exception:
        logger.debug("Failed to read last line of %s", filepath, exc_info=True)
        return ""


_COMMAND_ARGS_RE = re.compile(r"<command-args>([\s\S]*?)</command-args>")
_XML_BLOCK_RE = re.compile(r"<(?:system-reminder|local-command-caveat)[^>]*>[\s\S]*?</(?:system-reminder|local-command-caveat)>")
_XML_SIMPLE_RE = re.compile(r"</?(?:command-message|command-name|command-args|scheduled-task)[^>]*>")


def _clean_first_message(text: str) -> str:
    """Strip Claude Code command/system XML tags from a user message preview."""
    if not text:
        return text
    # Strip block-level tags (system-reminder, local-command-caveat)
    cleaned = _XML_BLOCK_RE.sub("", text)
    # Extract command-args content if present
    m = _COMMAND_ARGS_RE.search(cleaned)
    if m:
        return m.group(1).strip()
    # Strip remaining simple tags
    cleaned = _XML_SIMPLE_RE.sub("", cleaned).strip()
    return cleaned or text


def _scan_session_file(filepath: Path) -> dict | None:
    """Extract metadata from a single JSONL session file.

    Reads the first 20 lines for session info and the last line for
    last_modified timestamp. Returns a session metadata dict or None.
    """
    try:
        file_size = filepath.stat().st_size
        if file_size == 0:
            return None
    except OSError:
        return None

    session_id: str | None = None
    first_user_message: str | None = None
    model: str | None = None
    cwd: str | None = None

    # Read first 20 lines for metadata
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f):
                if i >= 20:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("Skipping malformed JSONL line in %s", filepath, exc_info=True)
                    continue

                if session_id is None:
                    session_id = obj.get("sessionId")

                entry_type = obj.get("type")
                msg = obj.get("message", {})

                if first_user_message is None and entry_type == "user":
                    content = msg.get("content", "")
                    if isinstance(content, str) and content.strip():
                        first_user_message = content.strip()
                    elif isinstance(content, list):
                        # Extract text from content blocks
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                text = block.get("text", "").strip()
                                if text:
                                    first_user_message = text
                                    break

                if model is None and entry_type == "assistant":
                    model = msg.get("model")

                if cwd is None:
                    cwd = obj.get("cwd")
    except Exception:
        logger.debug("Failed to read head of %s", filepath, exc_info=True)
        return None

    if not session_id:
        return None

    # Read last line for timestamp
    last_modified_iso: str | None = None
    last_line = _read_last_line(filepath)
    if last_line:
        try:
            last_obj = json.loads(last_line)
            ts = last_obj.get("timestamp")
            if ts:
                last_modified_iso = ts
        except json.JSONDecodeError:
            logger.debug("Failed to parse last line of %s for timestamp", filepath, exc_info=True)

    if not last_modified_iso:
        # Fall back to file mtime
        mtime = filepath.stat().st_mtime
        last_modified_iso = datetime.datetime.fromtimestamp(
            mtime, tz=datetime.timezone.utc
        ).isoformat()

    # Count lines via file size heuristic (read first 10KB, count lines, extrapolate)
    message_count = 0
    try:
        chunk_size = min(10240, file_size)
        with open(filepath, "r", encoding="utf-8", errors="replace") as f:
            chunk = f.read(chunk_size)
        lines_in_chunk = chunk.count("\n")
        if chunk_size < file_size:
            message_count = int(lines_in_chunk * (file_size / chunk_size))
        else:
            message_count = lines_in_chunk
    except Exception:
        logger.debug("Failed to estimate message count for %s", filepath, exc_info=True)

    # Clean command XML tags from the preview text
    if first_user_message:
        first_user_message = _clean_first_message(first_user_message)

    return {
        "session_id": session_id,
        "first_message": first_user_message or "(no message)",
        "last_modified": last_modified_iso,
        "message_count": message_count,
        "model": model,
        "file_size_kb": round(file_size / 1024, 1),
        "workdir": cwd or "",
    }


def _sort_ts(s: dict) -> float:
    """Sort key for history sessions — converts any timestamp format to epoch seconds."""
    ts = s.get("last_modified", "")
    if not ts:
        return 0.0
    try:
        val = float(ts)
        return val / 1000 if val > 1e12 else val  # ms → s if needed
    except (ValueError, TypeError):
        pass
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _get_all_history_sessions() -> list[dict]:
    """Scan ALL Claude Code project directories and return merged session list."""
    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.is_dir():
        return []

    # Cache the all-sessions result keyed on the projects dir mtime
    try:
        dir_mtime = projects_dir.stat().st_mtime
    except OSError:
        return []

    cache_key = "__all__"
    if cache_key in _history_cache:
        cached_mtime, cached_result = _history_cache[cache_key]
        if cached_mtime == dir_mtime:
            return cached_result

    all_sessions: list[dict] = []
    try:
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            for entry in project_dir.iterdir():
                if entry.suffix != ".jsonl" or not entry.is_file():
                    continue
                meta = _scan_session_file(entry)
                if meta:
                    all_sessions.append(meta)
    except OSError:
        logger.debug("Failed to scan projects dir", exc_info=True)

    all_sessions.sort(key=_sort_ts, reverse=True)
    _history_cache[cache_key] = (dir_mtime, all_sessions)
    return all_sessions


def _get_history_sessions(workdir: str) -> list[dict]:
    """Scan JSONL session files for a project and return metadata list.

    Uses a simple mtime-based cache to avoid rescanning unchanged directories.
    """
    project_id = _derive_project_id(workdir)
    home = Path.home()
    jsonl_dir = home / ".claude" / "projects" / project_id

    if not jsonl_dir.is_dir():
        return []

    try:
        dir_mtime = jsonl_dir.stat().st_mtime
    except OSError:
        return []

    cache_key = project_id
    if cache_key in _history_cache:
        cached_mtime, cached_result = _history_cache[cache_key]
        if cached_mtime == dir_mtime:
            return cached_result

    sessions: list[dict] = []
    try:
        for entry in jsonl_dir.iterdir():
            if entry.suffix != ".jsonl" or not entry.is_file():
                continue
            meta = _scan_session_file(entry)
            if meta:
                # Prefer cwd from the JSONL file; fall back to the requested workdir
                if not meta.get("workdir"):
                    meta["workdir"] = workdir
                sessions.append(meta)
    except OSError:
        logger.debug("Failed to scan JSONL dir: %s", jsonl_dir, exc_info=True)

    sessions.sort(key=_sort_ts, reverse=True)

    _history_cache[cache_key] = (dir_mtime, sessions)
    return sessions


@app.get("/api/history")
async def get_history(workdir: str = ""):
    """Return session metadata. Without workdir, returns ALL sessions across every project."""
    if workdir:
        sessions = _get_history_sessions(workdir)
    else:
        sessions = _get_all_history_sessions()
    return JSONResponse({"sessions": sessions})


@app.get("/api/history/{session_id}/messages")
async def get_history_messages(session_id: str, workdir: str = ""):
    """Return all parsed messages from a specific history session's JSONL file.

    Read-only viewing of past conversation content.
    """
    if not workdir:
        return JSONResponse({"error": "workdir parameter required"}, status_code=400)

    project_id = _derive_project_id(workdir)
    home = Path.home()
    jsonl_path = home / ".claude" / "projects" / project_id / f"{session_id}.jsonl"

    if not jsonl_path.is_file():
        return JSONResponse(
            {"error": f"Session file not found: {session_id}"},
            status_code=404,
        )

    from jsonl_watcher import read_all_messages

    messages = read_all_messages(str(jsonl_path))
    return JSONResponse({"session_id": session_id, "messages": messages})


# ── Settings: OpenRouter API Key ─────────────────────────

# Timeout for the live OpenRouter validation call. Generous (well above a
# normal round-trip) because this runs synchronously inside the POST request
# and a slow/unreachable OpenRouter must not hang the request indefinitely.
_OPENROUTER_VALIDATE_TIMEOUT = 15.0
_OPENROUTER_CREDITS_URL = "https://openrouter.ai/api/v1/credits"


def _validate_openrouter_key(key: str) -> dict:
    """Synchronously validate *key* against OpenRouter's /credits endpoint.

    This is a BLOCKING call (urllib.request) -- the route handler below runs
    it via ``await asyncio.to_thread(...)`` so it never blocks the event
    loop. Kept as a free function (rather than inlined) so tests can
    monkeypatch it directly instead of exercising the real network.

    Returns a dict with:
        status: "ok" | "rejected" | "network_error"
        credits_remaining: float | None (only set when status == "ok")

    The raw key is never included in the return value, and any exception
    logged here only includes the masked form -- never the key itself.
    """
    import urllib.error
    import urllib.request

    req = urllib.request.Request(
        _OPENROUTER_CREDITS_URL,
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_OPENROUTER_VALIDATE_TIMEOUT) as resp:
            status_code = resp.getcode()
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            return {"status": "rejected", "credits_remaining": None}
        logger.warning(
            "OpenRouter credits check returned unexpected HTTP %d for key %s",
            e.code, settings_store.mask_key(key),
        )
        return {"status": "network_error", "credits_remaining": None}
    except (urllib.error.URLError, TimeoutError, OSError, ValueError):
        logger.warning(
            "OpenRouter credits check failed for key %s", settings_store.mask_key(key), exc_info=True,
        )
        return {"status": "network_error", "credits_remaining": None}

    if status_code != 200:
        logger.warning(
            "OpenRouter credits check returned unexpected status %d for key %s",
            status_code, settings_store.mask_key(key),
        )
        return {"status": "network_error", "credits_remaining": None}

    data = payload.get("data", {}) if isinstance(payload, dict) else {}
    total_credits = data.get("total_credits")
    total_usage = data.get("total_usage")
    credits_remaining = None
    if isinstance(total_credits, (int, float)) and isinstance(total_usage, (int, float)):
        credits_remaining = total_credits - total_usage
    return {"status": "ok", "credits_remaining": credits_remaining}


@app.get("/api/settings/openrouter")
async def get_openrouter_settings():
    """Report whether an OpenRouter key is configured, and from where."""
    key, source = settings_store.resolve_openrouter_key()
    return JSONResponse({
        "configured": key is not None,
        "source": source,
        "masked": settings_store.mask_key(key) if key else None,
    })


@app.post("/api/settings/openrouter")
async def set_openrouter_settings(request: Request):
    """Validate and persist a user-supplied OpenRouter API key.

    Body: {"key": str}. The key is live-validated against OpenRouter's
    /credits endpoint before being saved -- an unvalidated key that turns
    out to be wrong would otherwise silently fail later, deep inside a
    session's model calls, with much less context than a save-time 400.
    """
    body = await request.json()
    key = body.get("key", "")

    if not isinstance(key, str):
        return JSONResponse({"ok": False, "error": "key must be a string"}, status_code=400)
    key = key.strip()
    if not key:
        return JSONResponse({"ok": False, "error": "key must not be empty"}, status_code=400)
    if any(ch.isspace() for ch in key):
        return JSONResponse({"ok": False, "error": "key must not contain whitespace"}, status_code=400)

    # Blocking network call -- run off the event loop via to_thread. See
    # _validate_openrouter_key's docstring for why this must never be
    # awaited/called directly on the loop.
    result = await asyncio.to_thread(_validate_openrouter_key, key)

    if result["status"] == "ok":
        settings_store.set_ui_key(key)
        masked = settings_store.mask_key(key)
        logger.info("OpenRouter API key saved (masked: %s)", masked)
        return JSONResponse({
            "ok": True,
            "masked": masked,
            "credits_remaining": result["credits_remaining"],
        })
    if result["status"] == "rejected":
        return JSONResponse({"ok": False, "error": "OpenRouter rejected the key"}, status_code=400)
    return JSONResponse(
        {"ok": False, "error": "Could not reach OpenRouter to validate the key"},
        status_code=502,
    )


@app.delete("/api/settings/openrouter")
async def delete_openrouter_settings():
    """Remove the UI-configured OpenRouter key. The env var (if set) may still provide one."""
    settings_store.delete_ui_key()
    key, source = settings_store.resolve_openrouter_key()
    return JSONResponse({"ok": True, "configured": key is not None, "source": source})


# ── Local model broker (LM Studio lane broker) ───────────

# Base URL of the local-lane broker (queue + metrics). Read-only endpoints.
# The browser NEVER supplies this — proxying an arbitrary client-supplied URL
# would be an SSRF hole, so the base is fixed server-side (env-overridable) and
# only the *validated* window query param is ever forwarded to the broker.
_LOCAL_BROKER_URL = os.getenv("COCKPIT_BROKER_URL", "http://127.0.0.1:1235").rstrip("/")
_LOCAL_BROKER_TIMEOUT = 3.0
# The broker's documented window set (broker-team contract). Never forward an
# unbounded client string through to the broker.
_LOCAL_METRICS_WINDOWS = ("lifetime", "24h", "session")
# Spill config = per-lane-class predicted-wait thresholds in SECONDS (broker
# contract). A value may be null (spill disabled for that class) or 0..86400.
_SPILL_CLASSES = ("interactive", "worker", "batch")
_SPILL_MAX_S = 86400

# ── Provider registry ─────────────────────────────────────
#
# Multiple local/remote inference backends can be registered; the browser only
# ever sees {id,label,kind,scope,capabilities} — broker_url/management_url/auth
# are server-side only (same SSRF stance as _LOCAL_BROKER_URL above).

COCKPIT_MANAGED_VLLM = os.getenv("COCKPIT_MANAGED_VLLM", "0")
COCKPIT_VLLM_PORT = os.getenv("COCKPIT_VLLM_PORT", "8001")
COCKPIT_VLLM_MODEL = os.getenv("COCKPIT_VLLM_MODEL", "/models/Qwen3-Coder-30B-A3B-AWQ")
COCKPIT_VLLM_SERVED_NAME = os.getenv("COCKPIT_VLLM_SERVED_NAME", "qwen3-coder-30b-awq")
COCKPIT_VLLM_IMAGE = os.getenv("COCKPIT_VLLM_IMAGE", "vllm/vllm-openai:latest")
COCKPIT_VLLM_GPU_UUID = os.getenv("COCKPIT_VLLM_GPU_UUID", "")
COCKPIT_VLLM_MODELS_DIR = os.getenv("COCKPIT_VLLM_MODELS_DIR", "")
COCKPIT_VLLM_MAX_MODEL_LEN = os.getenv("COCKPIT_VLLM_MAX_MODEL_LEN", "49152")
COCKPIT_VLLM_MAX_NUM_SEQS = os.getenv("COCKPIT_VLLM_MAX_NUM_SEQS", "2")
COCKPIT_VLLM_GPU_UTIL = os.getenv("COCKPIT_VLLM_GPU_UTIL", "0.90")
COCKPIT_VLLM_TOOL_PARSER = os.getenv("COCKPIT_VLLM_TOOL_PARSER", "qwen3_coder")
_VLLM_URL = "http://127.0.0.1:" + COCKPIT_VLLM_PORT

_PROVIDERS = {
    "lmstudio-local": {
        "id": "lmstudio-local", "label": "LM Studio (local)", "kind": "lmstudio",
        "scope": "local",
        "broker_url": os.getenv("COCKPIT_BROKER_URL", "http://127.0.0.1:1235").rstrip("/"),
        "management_url": os.getenv("COCKPIT_LMSTUDIO_URL", "http://127.0.0.1:1234").rstrip("/"),
        "auth": {"type": "none"},
        "capabilities": ["queue", "metrics", "spill", "models", "traces", "health"],
    },
    "vllm-local": {
        "id": "vllm-local", "label": "vLLM (local)", "kind": "vllm",
        "scope": "local",
        # vLLM does its own continuous batching and must be served DIRECT --
        # not through the broker (max_concurrent=1 would serialize requests
        # and kill vLLM's throughput). Coexists beside the broker-fronted
        # LM Studio provider; the user picks via ProviderPicker.
        "broker_url": _VLLM_URL,
        "management_url": _VLLM_URL,
        "auth": {"type": "none"},
        # vLLM does not serve the broker's queue/spill/traces shapes, but it
        # DOES export a Prometheus /metrics endpoint that _vllm_metrics reshapes
        # into the broker metrics contract (cumulative-since-start; see adapter).
        "capabilities": ["models", "health", "metrics"],
    },
}
_DEFAULT_PROVIDER = "lmstudio-local"

_PROVIDER_REQUIRED_KEYS = ("id", "label", "kind", "scope", "broker_url", "capabilities")


def _is_safe_provider_url(url) -> bool:
    """True when *url* parses to an http(s) scheme with a non-empty netloc.

    Guards the proxy against a malformed/malicious COCKPIT_PROVIDERS_FILE
    pointing broker_url/management_url at file://, gopher://, or other
    schemes urllib would happily "fetch" for us.
    """
    import urllib.parse

    if not isinstance(url, str):
        return False
    parsed = urllib.parse.urlsplit(url)
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def _is_allowed_local_host(host) -> bool:
    """SSRF host allowlist shared by the endpoint setter and the persistence
    loader. True iff *host* is the literal "localhost" OR an IP literal that,
    after rejecting the dangerous ranges (unspecified / link-local / multicast /
    reserved) FIRST, is loopback or private (RFC-1918 / ULA).

    Non-IP, non-"localhost" hostnames are rejected to prevent DNS rebinding.
    Reject-first ordering mirrors set_provider_endpoint exactly — a link-local
    IPv4 also matches is_private in some stdlib versions.
    """
    import ipaddress

    if not isinstance(host, str):
        return False
    if host == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.is_unspecified or ip.is_link_local or ip.is_multicast or ip.is_reserved:
        return False
    return bool(ip.is_loopback or ip.is_private)


def _load_providers_from_file(path: str) -> dict | None:
    """Parse COCKPIT_PROVIDERS_FILE into a {id: provider} map, or None on failure.

    Validated: each entry needs the required keys, and broker_url/
    management_url (when present) must be http(s) URLs with a host — all-or-
    nothing, same as the required-key check. Any parse/validation failure is
    the caller's cue to log a warning and keep the default registry.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        entries = data["providers"]
        providers = {}
        for entry in entries:
            if not all(k in entry for k in _PROVIDER_REQUIRED_KEYS):
                return None
            if not _is_safe_provider_url(entry["broker_url"]):
                return None
            if "management_url" in entry and not _is_safe_provider_url(entry["management_url"]):
                return None
            providers[entry["id"]] = entry
        if not providers:
            return None
        return providers
    except Exception:
        return None


_providers_file = os.getenv("COCKPIT_PROVIDERS_FILE")
if _providers_file:
    _loaded = _load_providers_from_file(_providers_file)
    if _loaded is not None:
        _PROVIDERS = _loaded
        _DEFAULT_PROVIDER = next(iter(_PROVIDERS))
    else:
        logger.warning(
            "COCKPIT_PROVIDERS_FILE=%s failed to parse/validate; keeping default provider registry",
            _providers_file,
        )


# ── Configurable local-provider endpoints (persisted) ────
#
# The browser may reconfigure a LOCAL provider's endpoint (host:port). The
# server proxies to whatever URL is stored, so this is an SSRF surface — the
# setter route (POST /api/local/{id}/endpoint) does the validation. Here we
# only persist/restore the *already-validated* result. Config lives beside the
# managed-broker state at ~/.claude-cockpit/.
_PROVIDER_ENDPOINTS_FILE = os.path.join(
    os.path.expanduser("~"), ".claude-cockpit", "provider-endpoints.json"
)


def _load_provider_endpoints() -> dict:
    """Read the {provider_id: url} map. Returns {} on missing/parse error."""
    try:
        with open(_PROVIDER_ENDPOINTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            logger.warning(
                "provider-endpoints.json is not a JSON object; ignoring"
            )
            return {}
        return data
    except FileNotFoundError:
        logger.debug("No provider-endpoints.json at %s", _PROVIDER_ENDPOINTS_FILE)
        return {}
    except Exception:
        logger.warning(
            "Failed to read %s; ignoring persisted endpoints",
            _PROVIDER_ENDPOINTS_FILE,
            exc_info=True,
        )
        return {}


def _save_provider_endpoints(mapping: dict) -> None:
    """Best-effort write of the {provider_id: url} map. Never raises."""
    try:
        os.makedirs(os.path.dirname(_PROVIDER_ENDPOINTS_FILE), exist_ok=True)
        with open(_PROVIDER_ENDPOINTS_FILE, "w", encoding="utf-8") as f:
            json.dump(mapping, f, indent=2)
    except Exception:
        logger.error(
            "Failed to persist provider endpoints to %s",
            _PROVIDER_ENDPOINTS_FILE,
            exc_info=True,
        )


def apply_persisted_endpoints() -> None:
    """Override management_url/broker_url from the persisted config at startup.

    Only LOCAL providers present in the registry are touched, and only when the
    persisted URL is http(s) AND its host passes the SAME allowlist as the
    endpoint setter (_is_allowed_local_host) — closing the crafted-json /
    arbitrary-host bypass at load. Defensive — a bad config file must never
    block startup.
    """
    import urllib.parse

    mapping = _load_provider_endpoints()
    for provider_id, url in mapping.items():
        provider = _PROVIDERS.get(provider_id)
        if provider is None:
            logger.debug("Persisted endpoint for unknown provider %s ignored", provider_id)
            continue
        if provider.get("scope") != "local":
            logger.debug("Persisted endpoint for non-local provider %s ignored", provider_id)
            continue
        parsed = urllib.parse.urlsplit(url) if isinstance(url, str) else None
        if parsed is None or parsed.scheme not in ("http", "https") or not _is_allowed_local_host(parsed.hostname):
            logger.warning(
                "ignoring unsafe persisted endpoint for %s: %s", provider_id, url
            )
            continue
        provider["management_url"] = url
        provider["broker_url"] = url
        logger.info("Applied persisted endpoint for provider %s: %s", provider_id, url)


def _endpoint_hint(p: dict) -> str | None:
    """Display-only host:port for a LOCAL provider, so the UI can tell the user
    where to boot the service ("vLLM · 127.0.0.1:8001 · offline").

    LOCAL scope only. Returns just the netloc (host:port) -- never the scheme,
    path, query, or auth, which stay server-side (the SSRF stance is about not
    leaking full/controllable URLs, not a bare localhost host:port the user runs
    themselves). Remote providers get None.
    """
    if p.get("scope") != "local":
        return None
    import urllib.parse
    parsed = urllib.parse.urlsplit(p.get("management_url") or p.get("broker_url") or "")
    host = parsed.hostname  # .hostname (not .netloc) drops any user:pass@ userinfo
    if not host:
        return None
    return f"{host}:{parsed.port}" if parsed.port else host


@app.get("/api/local/providers")
async def get_local_providers():
    """List registered providers -- full URLs and auth are never sent to the
    browser; local providers carry a display-only host:port endpoint_hint."""
    return JSONResponse({
        "providers": [
            {
                "id": p["id"],
                "label": p["label"],
                "kind": p["kind"],
                "scope": p["scope"],
                "capabilities": p["capabilities"],
                "endpoint_hint": _endpoint_hint(p),
            }
            for p in _PROVIDERS.values()
        ]
    })


import urllib.request as _urllib_request


class _NoRedirect(_urllib_request.HTTPRedirectHandler):
    """Refuse to follow HTTP 3xx redirects on server-side proxy fetches.

    SSRF hardening: a validated loopback/private endpoint could otherwise 302 us
    to an arbitrary (e.g. cloud-metadata) URL. Returning None makes urllib raise
    the 3xx as an HTTPError, which the fetch helpers' callers already treat as
    unreachable/error — the correct safe outcome.
    """

    def redirect_request(self, *args, **kwargs):
        return None


_NO_REDIRECT_OPENER = _urllib_request.build_opener(_NoRedirect)


def _broker_get(path: str, query: str = "", base_url: str | None = None) -> dict:
    """GET {broker}{path}?{query} and return the parsed JSON.

    ``base_url`` defaults to the legacy ``_LOCAL_BROKER_URL`` so existing
    callers/monkeypatches are unaffected; provider-keyed routes pass the
    registered provider's own ``broker_url``. Blocking (urllib) — callers run
    it via ``asyncio.to_thread`` so it never blocks the event loop. Kept a
    free function so tests can monkeypatch it directly instead of exercising
    a real broker. Raises on any transport/parse error; the route handlers
    translate that into a 503 so the best-effort frontend poller can silently
    swallow an offline broker.
    """
    import urllib.request

    url = f"{base_url or _LOCAL_BROKER_URL}{path}"
    if query:
        url += f"?{query}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with _NO_REDIRECT_OPENER.open(req, timeout=_LOCAL_BROKER_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _broker_put(path: str, body: dict, base_url: str | None = None) -> dict:
    """PUT a JSON body to {broker}{path} and return the parsed JSON echo.

    ``base_url`` defaults to the legacy ``_LOCAL_BROKER_URL`` — see
    ``_broker_get``. Blocking (urllib) — run via ``asyncio.to_thread``. Same
    monkeypatch-friendly free-function shape as ``_broker_get``.
    """
    import urllib.request

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url or _LOCAL_BROKER_URL}{path}",
        data=data,
        method="PUT",
        headers={"Accept": "application/json", "Content-Type": "application/json"},
    )
    with _NO_REDIRECT_OPENER.open(req, timeout=_LOCAL_BROKER_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _models_path(provider: dict) -> str:
    """Return the model-catalog path for *provider*'s management plane.

    LM Studio exposes its richer catalog at /api/v0/models; everything else
    (vLLM and any OpenAI-compatible server) uses the standard /v1/models.
    """
    return "/api/v0/models" if provider.get("kind") == "lmstudio" else "/v1/models"


def _mgmt_get(provider: dict, path: str) -> dict:
    """GET {provider[management_url]}{path} and return the parsed JSON.

    Sibling of ``_broker_get`` for the management-plane URL (e.g. LM Studio's
    REST API) rather than the broker. Same blocking/monkeypatch/timeout shape.
    """
    import urllib.request

    url = f"{provider['management_url']}{path}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with _NO_REDIRECT_OPENER.open(req, timeout=_LOCAL_BROKER_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


# ── vLLM /metrics adapter (Prometheus → broker metrics contract) ──
#
# vLLM has no lane broker in front of it, but it DOES export a Prometheus
# text-exposition /metrics endpoint. This adapter scrapes it and reshapes it
# into the same contract the broker's /metrics returns, so a vLLM provider can
# carry the `metrics` capability and light up the Routing & Reporting dashboard
# exactly like the broker-fronted providers.
#
# HONESTY BOUNDARIES (surfaced in the payload, not hidden):
#   - vLLM counters are cumulative SINCE SERVER START -- there is no 24h/session
#     windowing, so `window_exact` is True only for "lifetime".
#   - by_session/by_agent/by_lane_class are empty: vLLM tags samples by
#     model_name only, not by client/agent/lane class.


def _http_get_text(url: str, timeout: float | None = None) -> str:
    """GET *url* and return the raw response body as text (no JSON parse).

    Used for scraping Prometheus text-exposition endpoints (vLLM /metrics).
    Same no-redirect / blocking / monkeypatch-friendly shape as ``_broker_get``.
    """
    import urllib.request

    req = urllib.request.Request(url, headers={"Accept": "text/plain"})
    with _NO_REDIRECT_OPENER.open(req, timeout=timeout or _LOCAL_BROKER_TIMEOUT) as resp:
        return resp.read().decode("utf-8", "replace")


def _split_labels(label_str: str) -> list:
    """Split a Prometheus label block ``a="1",b="2"`` on commas OUTSIDE quotes.

    Naive ``str.split(",")`` would break on a comma inside a quoted value (e.g.
    a model path); this respects quotes.
    """
    pairs, buf, in_q = [], [], False
    for ch in label_str:
        if ch == '"':
            in_q = not in_q
            buf.append(ch)
        elif ch == "," and not in_q:
            pairs.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if "".join(buf).strip():
        pairs.append("".join(buf))
    return pairs


def _parse_prometheus(text: str) -> dict:
    """Parse Prometheus text-exposition format into {name: [(labels, value), ...]}.

    Minimal and dependency-free: skips ``# HELP``/``# TYPE`` comment lines,
    splits each sample into metric name, optional ``{label="v",...}`` set, and a
    float value. Malformed lines are skipped rather than raising -- a scrape is
    best-effort telemetry.
    """
    out: dict = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "{" in line:
            name, rest = line.split("{", 1)
            label_str, _, val_str = rest.rpartition("}")
        else:
            parts = line.split()
            if len(parts) < 2:
                continue
            name, label_str, val_str = parts[0], "", parts[1]
        name = name.strip()
        val_str = val_str.strip().split()[0] if val_str.strip() else ""
        try:
            value = float(val_str)
        except ValueError:
            continue
        labels = {}
        for pair in _split_labels(label_str):
            if "=" in pair:
                k, v = pair.split("=", 1)
                labels[k.strip()] = v.strip().strip('"')
        out.setdefault(name, []).append((labels, value))
    return out


def _hist_sum_count(samples: dict, base: str) -> tuple:
    """Return (sum, count) totalled across all label sets for a histogram."""
    total = sum(v for _, v in samples.get(base + "_sum", []))
    count = sum(v for _, v in samples.get(base + "_count", []))
    return total, count


def _hist_quantile(samples: dict, base: str, q: float):
    """Approximate the *q*-quantile (0..1) of a Prometheus histogram by linear
    interpolation across cumulative ``_bucket{le=...}`` counts.

    Returns the value in the histogram's native unit (seconds for vLLM latency
    histograms), or None if the histogram is absent/empty. Buckets are summed
    across label sets (vLLM tags by model_name; we aggregate the whole server).
    """
    def _le(x):
        return float("inf") if x in ("+Inf", "Inf") else float(x)

    buckets: dict = {}
    for labels, v in samples.get(base + "_bucket", []):
        le = labels.get("le")
        if le is None:
            continue
        buckets[le] = buckets.get(le, 0.0) + v
    if not buckets:
        return None
    ordered = sorted(buckets.items(), key=lambda kv: _le(kv[0]))
    total = ordered[-1][1]
    if total <= 0:
        return None
    target = q * total
    prev_le, prev_c = 0.0, 0.0
    for le_str, cum in ordered:
        if cum >= target:
            le = _le(le_str)
            if le == float("inf"):
                return prev_le or None
            if cum == prev_c:
                return le
            frac = (target - prev_c) / (cum - prev_c)
            return prev_le + frac * (le - prev_le)
        prev_le, prev_c = _le(le_str), cum
    return None


def _vllm_metrics(base_url: str, window: str) -> dict:
    """Scrape vLLM's Prometheus /metrics and map it into the broker's metrics
    contract shape. Raises on transport error (route handler -> 503)."""
    s = _parse_prometheus(_http_get_text(base_url + "/metrics"))

    def _sum(name):
        return sum(v for _, v in s.get(name, []))

    runs = int(_sum("vllm:request_success_total"))
    pt = int(_sum("vllm:prompt_tokens_total"))
    ct = int(_sum("vllm:generation_tokens_total"))

    # The served model name rides on every counter's labels; surface it so the
    # reporting UI can subtitle the vLLM backend column.
    served_model = None
    for _name in ("vllm:generation_tokens_total", "vllm:prompt_tokens_total", "vllm:request_success_total"):
        for labels, _v in s.get(_name, []):
            if labels.get("model_name"):
                served_model = labels["model_name"]
                break
        if served_model:
            break

    e2e_sum, _e2e_count = _hist_sum_count(s, "vllm:e2e_request_latency_seconds")
    # Per-output-token histogram was renamed across vLLM versions
    # (time_per_output_token_seconds -> request_time_per_output_token_seconds);
    # accept whichever this build exposes.
    tpot_sum, tpot_count = _hist_sum_count(s, "vllm:request_time_per_output_token_seconds")
    if tpot_count == 0:
        tpot_sum, tpot_count = _hist_sum_count(s, "vllm:time_per_output_token_seconds")

    tps_avg = round(ct / e2e_sum, 2) if e2e_sum > 0 and ct else None
    decode_avg = round(tpot_count / tpot_sum, 2) if tpot_sum > 0 else None

    def _ms(name, q):
        v = _hist_quantile(s, name, q)
        return round(v * 1000, 1) if v is not None else None

    return {
        "window": window,
        "window_exact": window == "lifetime",
        "source": "vllm-prometheus",
        "served_model": served_model,
        "note": "vLLM counters are cumulative since server start; time windows are not applied.",
        "persisted": False,
        "runs_total": runs,
        "prompts_total": runs,  # vLLM has no distinct X-Trace-Id / prompt concept
        "tokens_total": {"prompt": pt, "completion": ct},
        "tokens_per_sec": {"current": None, "avg": tps_avg},
        "decode_tokens_per_sec": {"current": None, "avg": decode_avg, "p50": None},
        "ttft_ms": {
            "p50": _ms("vllm:time_to_first_token_seconds", 0.50),
            "p95": _ms("vllm:time_to_first_token_seconds", 0.95),
        },
        "queue_wait_ms": {
            "p50": _ms("vllm:request_queue_time_seconds", 0.50),
            "p95": _ms("vllm:request_queue_time_seconds", 0.95),
        },
        "run_time_ms": {
            "p50": _ms("vllm:e2e_request_latency_seconds", 0.50),
            "p95": _ms("vllm:e2e_request_latency_seconds", 0.95),
        },
        "by_session": [],
        "by_agent": [],
        "by_lane_class": [],
    }


# ── vLLM metrics persistence (crude, DB-free dataset) ─────
#
# vLLM's Prometheus counters reset to zero on every container restart, so a
# restart would otherwise lose all history. Cockpit persists them under
# ~/.claude-cockpit/ as a plain dataset the user can open directly:
#   vllm-metrics.jsonl        -- append-only, one timestamped sample per line
#   vllm-metrics-rollup.json  -- running lifetime total, reset-detected
# The rollup "banks" the last-seen totals whenever a counter drops (= restart),
# so the reported lifetime survives restarts and downtime. Single writer: the
# background sampler loop (via _record_vllm_sample). The /metrics read path only
# OVERLAYS the persisted baseline (read-only) and honors an un-banked reset so
# the number never dips in the window before the next sample.

_VLLM_METRICS_DIR = os.path.join(os.path.expanduser("~"), ".claude-cockpit")
_VLLM_METRICS_LOG = os.path.join(_VLLM_METRICS_DIR, "vllm-metrics.jsonl")
_VLLM_METRICS_ROLLUP = os.path.join(_VLLM_METRICS_DIR, "vllm-metrics-rollup.json")
_VLLM_SAMPLE_INTERVAL = float(os.getenv("COCKPIT_VLLM_SAMPLE_INTERVAL", "60"))
_VLLM_COUNTER_KEYS = ("runs", "prompt", "completion")


def _now_iso() -> str:
    import datetime

    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def _raw_counters(m: dict) -> dict:
    """Extract the three cumulative counters from a live _vllm_metrics dict."""
    tt = m.get("tokens_total") or {}
    return {
        "runs": int(m.get("runs_total") or 0),
        "prompt": int(tt.get("prompt") or 0),
        "completion": int(tt.get("completion") or 0),
    }


def _load_vllm_rollup() -> dict:
    """Read the rollup; a fresh (zeroed) rollup on missing/parse error."""
    try:
        with open(_VLLM_METRICS_ROLLUP, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        pass
    except Exception:
        logger.warning("Failed to read %s; starting fresh", _VLLM_METRICS_ROLLUP, exc_info=True)
    return {"carried": {k: 0 for k in _VLLM_COUNTER_KEYS}, "last_raw": None}


def _save_vllm_rollup(rollup: dict) -> None:
    """Best-effort write of the rollup. Never raises."""
    try:
        os.makedirs(_VLLM_METRICS_DIR, exist_ok=True)
        with open(_VLLM_METRICS_ROLLUP, "w", encoding="utf-8") as f:
            json.dump(rollup, f, indent=2)
    except Exception:
        logger.error("Failed to persist vLLM rollup to %s", _VLLM_METRICS_ROLLUP, exc_info=True)


def _vllm_effective(raw: dict, rollup: dict) -> dict:
    """Effective lifetime counters = live raw + banked carried (+ an un-banked
    pre-reset total, if a restart is visible but the sampler hasn't banked it
    yet). Pure -- shared by the overlay and by tests."""
    carried = {k: int((rollup.get("carried") or {}).get(k, 0)) for k in _VLLM_COUNTER_KEYS}
    last = rollup.get("last_raw") or {}
    reset_pending = bool(last) and any(raw[k] < int(last.get(k, 0)) for k in _VLLM_COUNTER_KEYS)
    add = last if reset_pending else {}
    return {k: raw[k] + carried[k] + int(add.get(k, 0)) for k in _VLLM_COUNTER_KEYS}


def _append_vllm_sample(raw: dict, m: dict, ts: str) -> None:
    """Append one line to the JSONL dataset. Best-effort; never raises."""
    try:
        os.makedirs(_VLLM_METRICS_DIR, exist_ok=True)
        line = {
            "ts": ts,
            "runs": raw["runs"],
            "prompt_tokens": raw["prompt"],
            "completion_tokens": raw["completion"],
            "decode_tps_avg": (m.get("decode_tokens_per_sec") or {}).get("avg"),
            "tps_avg": (m.get("tokens_per_sec") or {}).get("avg"),
        }
        with open(_VLLM_METRICS_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(line) + "\n")
    except Exception:
        logger.error("Failed to append vLLM metrics sample", exc_info=True)


def _record_vllm_sample(m: dict) -> dict:
    """Reset-aware accumulate + append (SINGLE WRITER -- sampler loop only).

    Banks the pre-restart totals into ``carried`` when any counter dropped since
    the last sample, updates ``last_raw``, appends the raw sample to the dataset,
    and returns the new rollup.
    """
    raw = _raw_counters(m)
    rollup = _load_vllm_rollup()
    last = rollup.get("last_raw")
    carried = {k: int((rollup.get("carried") or {}).get(k, 0)) for k in _VLLM_COUNTER_KEYS}
    if last and any(raw[k] < int(last.get(k, 0)) for k in _VLLM_COUNTER_KEYS):
        for k in _VLLM_COUNTER_KEYS:
            carried[k] += int(last.get(k, 0))
        logger.info("vLLM counter reset detected; banked pre-restart totals into rollup")
    rollup = {"carried": carried, "last_raw": raw, "updated": _now_iso()}
    _save_vllm_rollup(rollup)
    _append_vllm_sample(raw, m, rollup["updated"])
    return rollup


def _vllm_apply_persistence(m: dict) -> dict:
    """Overlay the persisted lifetime baseline onto a live-scraped metrics dict
    (read-only on the rollup). Percentiles stay live-session -- only the
    cumulative counters carry across restarts."""
    raw = _raw_counters(m)
    eff = _vllm_effective(raw, _load_vllm_rollup())
    out = dict(m)
    out["runs_total"] = eff["runs"]
    out["prompts_total"] = eff["runs"]
    out["tokens_total"] = {"prompt": eff["prompt"], "completion": eff["completion"]}
    out["persisted"] = True
    out["live_session"] = {
        "runs": raw["runs"],
        "tokens": {"prompt": raw["prompt"], "completion": raw["completion"]},
    }
    return out


def _vllm_metrics_persisted(base_url: str, window: str) -> dict:
    """Live scrape + persisted-baseline overlay, in one blocking call for
    ``asyncio.to_thread``. Raises on transport error (route -> 503)."""
    return _vllm_apply_persistence(_vllm_metrics(base_url, window))


async def _vllm_sampler_loop() -> None:
    """Background sampler: every _VLLM_SAMPLE_INTERVAL, scrape the vLLM provider
    and accumulate+append. Best-effort -- a scrape failure (vLLM down/absent) is
    swallowed so the loop keeps running until shutdown cancels it."""
    provider = _PROVIDERS.get("vllm-local")
    if provider is None:
        return
    while True:
        try:
            await asyncio.sleep(_VLLM_SAMPLE_INTERVAL)
            m = await asyncio.to_thread(_vllm_metrics, provider["broker_url"], "lifetime")
            await asyncio.to_thread(_record_vllm_sample, m)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.debug("vLLM metrics sample skipped (provider unreachable?)", exc_info=True)


# ── Service identity (the middleware layer) ──────────────
#
# LM Studio's dev server answers UNKNOWN paths with "200 anyway" + a non-broker
# body, so a bare 200 proves nothing. Every proxy response is shape-validated
# against the broker contract, and a detection probe fingerprints what is
# actually listening at the configured URL so the UI can say "that's LM Studio,
# not the lane broker" instead of rendering dashes.

# Pinned from broker source (broker.py::_queue_state, confirmed 2026-07-24):
# top level = shadow · in_flight (object|null) · queued (array) ·
# estimated_clear_seconds. Spill counters live on /config/spill, NOT here.
_QUEUE_SHAPE_KEYS = ("shadow", "in_flight", "queued", "estimated_clear_seconds")
_METRICS_SHAPE_KEYS = ("runs_total", "prompts_total", "tokens_total", "tokens_per_sec")
_SPILL_SHAPE_KEYS = ("spill_thresholds_s", "spilled_total", "spilled_by_class")

# Detection is cached so the 3s poller doesn't fire fingerprint probes each tick.
_DETECT_CACHE_TTL = 30.0
_detect_cache: dict = {"result": None, "at": 0.0}


def _looks_like(data, keys) -> bool:
    """True when *data* is a dict carrying at least one contract key."""
    return isinstance(data, dict) and any(k in data for k in keys)


def _detect_service() -> dict:
    """Fingerprint whatever is listening at _LOCAL_BROKER_URL.

    Returns {reachable, compatible, service, detail}. service is one of:
    "lane-broker" | "lmstudio" | "vllm" | "ollama" | "openai-compatible" |
    "unknown" | "offline". Blocking — run via asyncio.to_thread.
    """
    # 1. The real contract: /queue must return a queue-shaped dict.
    try:
        data = _broker_get("/queue")
        if _looks_like(data, _QUEUE_SHAPE_KEYS):
            return {"reachable": True, "compatible": True, "service": "lane-broker",
                    "detail": "lane broker contract verified via /queue"}
    except Exception:
        return {"reachable": False, "compatible": False, "service": "offline",
                "detail": f"nothing answering at {_LOCAL_BROKER_URL}"}

    # Reachable but /queue is not broker-shaped — fingerprint what it really is.
    probes = (
        ("/api/v0/models", "lmstudio", "LM Studio REST API (/api/v0/models)"),
        ("/version", "vllm", "vLLM (/version)"),
        ("/api/version", "ollama", "Ollama (/api/version)"),
        ("/v1/models", "openai-compatible", "OpenAI-compatible server (/v1/models)"),
    )
    for path, service, detail in probes:
        try:
            probe = _broker_get(path)
        except Exception:
            continue
        if isinstance(probe, dict) and (probe.get("data") is not None or probe.get("version") is not None or probe.get("models") is not None):
            return {"reachable": True, "compatible": False, "service": service,
                    "detail": f"detected {detail} — not the lane broker"}
    return {"reachable": True, "compatible": False, "service": "unknown",
            "detail": "service answers but matches no known fingerprint"}


def _cached_detect() -> dict:
    now = _time.monotonic()
    if _detect_cache["result"] is None or now - _detect_cache["at"] > _DETECT_CACHE_TTL:
        _detect_cache["result"] = _detect_service()
        _detect_cache["at"] = now
    return _detect_cache["result"]


# ── Managed lane broker (vendored: web/lane_broker/) ─────
#
# Cockpit OWNS the broker: at startup, if nothing is already answering at the
# broker URL, the vendored broker runs in-process as an asyncio task (pure
# stdlib — no subprocess, so it works inside the PyInstaller sidecar). If an
# external broker is already listening (e.g. a dev instance), external wins
# and Cockpit only proxies — never a double-bind.
_MANAGED_BROKER = {"task": None}


def _broker_port() -> int:
    try:
        return int(_LOCAL_BROKER_URL.rsplit(":", 1)[1])
    except (ValueError, IndexError):
        return 1235


async def start_managed_broker() -> bool:
    """Start the in-process broker unless disabled or an external one answers.

    Returns True when Cockpit's own broker task is running.
    """
    if os.getenv("COCKPIT_MANAGED_BROKER", "1") != "1":
        return False
    if _MANAGED_BROKER["task"] is not None and not _MANAGED_BROKER["task"].done():
        return True
    try:
        await asyncio.to_thread(_broker_get, "/queue")
        logger.info("External lane broker already at %s — not spawning managed one", _LOCAL_BROKER_URL)
        return False
    except Exception:
        pass  # nothing listening — ours to run

    from types import SimpleNamespace
    from lane_broker.broker import amain as broker_amain

    state_dir = os.path.join(os.path.expanduser("~"), ".claude-cockpit", "lane-broker")
    os.makedirs(state_dir, exist_ok=True)
    args = SimpleNamespace(
        port=_broker_port(),
        upstream=os.getenv("COCKPIT_LMSTUDIO_URL", "http://127.0.0.1:1234"),
        # Shadow (observe+log, no queueing) is the safe default — same posture
        # the broker team runs; flip with COCKPIT_BROKER_SHADOW=0.
        shadow=os.getenv("COCKPIT_BROKER_SHADOW", "1") == "1",
        log_file=os.path.join(state_dir, "jobs.jsonl"),
        spill_interactive=30.0,
        spill_worker=300.0,
    )

    async def _run():
        try:
            await broker_amain(args)
        except asyncio.CancelledError:
            raise
        except OSError:
            # Port grabbed between probe and bind — external broker wins.
            logger.info("Managed broker could not bind %s (external instance?)", _LOCAL_BROKER_URL)
        except Exception:
            logger.error("Managed lane broker crashed", exc_info=True)

    _MANAGED_BROKER["task"] = asyncio.create_task(_run())
    logger.info("Managed lane broker starting on %s (shadow=%s, log=%s)",
                _LOCAL_BROKER_URL, args.shadow, args.log_file)
    return True


async def stop_managed_broker() -> None:
    task = _MANAGED_BROKER["task"]
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
    _MANAGED_BROKER["task"] = None


# ── Managed vLLM (coexisting local provider) ──────────────
#
# vLLM does its own continuous batching, so it must be served DIRECT (not
# behind the max_concurrent=1 lane broker, which would serialize requests and
# kill vLLM's throughput). Cockpit optionally owns a vLLM container the same
# way it owns the lane broker: opt-in, double-bind guarded, best-effort, and
# never blocking startup/shutdown.
_MANAGED_VLLM = {"proc": None, "container": "cockpit-vllm"}


def _vllm_docker_argv(action: str = "run") -> list[str]:
    """Build the docker argv (or WSL-wrapped shell string) for run/rm.

    On Windows the Docker CLI lives in WSL, so the command is wrapped as
    ["wsl", "-e", "bash", "-lc", "<docker ... as one shell string>"]; on
    other platforms the argv is returned as-is for direct exec.
    """
    if action == "rm":
        docker_argv = ["docker", "rm", "-f", _MANAGED_VLLM["container"]]
    else:
        gpus = f'--gpus "device={COCKPIT_VLLM_GPU_UUID}"' if COCKPIT_VLLM_GPU_UUID else "--gpus all"
        mount = f"-v {COCKPIT_VLLM_MODELS_DIR}:/models" if COCKPIT_VLLM_MODELS_DIR else ""
        gpu_pin = (
            f"-e CUDA_DEVICE_ORDER=PCI_BUS_ID -e CUDA_VISIBLE_DEVICES={COCKPIT_VLLM_GPU_UUID}"
            if COCKPIT_VLLM_GPU_UUID else ""
        )
        parts = [
            "docker", "run", "-d", "--rm", "--name", _MANAGED_VLLM["container"], "--ipc=host",
            "-p", f"{COCKPIT_VLLM_PORT}:8001", gpus, gpu_pin, mount,
            COCKPIT_VLLM_IMAGE,
            "--model", COCKPIT_VLLM_MODEL,
            "--served-model-name", COCKPIT_VLLM_SERVED_NAME,
            "--quantization", "awq_marlin", "--dtype", "half",
            "--enable-auto-tool-choice", "--tool-call-parser", COCKPIT_VLLM_TOOL_PARSER,
            "--max-model-len", COCKPIT_VLLM_MAX_MODEL_LEN,
            "--gpu-memory-utilization", COCKPIT_VLLM_GPU_UTIL,
            "--max-num-seqs", COCKPIT_VLLM_MAX_NUM_SEQS, "--port", "8001",
        ]
        docker_argv = [p for p in parts if p]

    if sys.platform == "win32":
        shell_str = " ".join(docker_argv)
        return ["wsl", "-e", "bash", "-lc", shell_str]
    return docker_argv


async def start_managed_vllm() -> bool:
    """Launch the managed vLLM container unless disabled or already answering.

    Returns True when Cockpit's own vLLM container is (being) launched.
    """
    if COCKPIT_MANAGED_VLLM != "1":
        return False
    if _MANAGED_VLLM["proc"] is not None:
        return True
    try:
        await asyncio.to_thread(_broker_get, "/v1/models", "", _VLLM_URL)
        logger.info("External vLLM already at %s — not spawning managed one", _VLLM_URL)
        return False
    except Exception:
        pass  # nothing listening — ours to run

    try:
        argv = _vllm_docker_argv("run")
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
        _MANAGED_VLLM["proc"] = proc
        logger.info(
            "Managed vLLM starting: container=%s image=%s model=%s port=%s",
            _MANAGED_VLLM["container"], COCKPIT_VLLM_IMAGE, COCKPIT_VLLM_MODEL, COCKPIT_VLLM_PORT,
        )
        return True
    except Exception:
        logger.error("Managed vLLM startup failed", exc_info=True)
        return False


async def stop_managed_vllm() -> None:
    if _MANAGED_VLLM["proc"] is None:
        return
    try:
        argv = _vllm_docker_argv("rm")
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await proc.communicate()
    except Exception:
        logger.error("Managed vLLM shutdown failed", exc_info=True)
    _MANAGED_VLLM["proc"] = None


@app.get("/api/local/status")
async def get_local_status():
    """Report what is actually connected at the configured broker URL."""
    result = await asyncio.to_thread(_cached_detect)
    managed = _MANAGED_BROKER["task"] is not None and not _MANAGED_BROKER["task"].done()
    return JSONResponse({**result, "url": _LOCAL_BROKER_URL, "managed": managed})


# ── Provider-keyed local routes ───────────────────────────
#
# Thin wrappers around the same _broker_get/_broker_put/_mgmt_get machinery
# above, parameterized by a registered provider instead of the hard-coded
# _LOCAL_BROKER_URL. The legacy /api/local/{queue,metrics,spill} routes above
# stay as-is and keep working unchanged -- only the write-refusal/model/health/
# traces routes are new, all provider-keyed by construction.

_MODEL_FIELDS = ("id", "type", "arch", "quantization", "state",
                  "max_context_length", "loaded_context_length")


def _require_provider(provider_id: str):
    """Look up a provider by id, or None if unknown."""
    return _PROVIDERS.get(provider_id)


@app.get("/api/local/{provider_id}/queue")
async def get_provider_queue(provider_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "queue" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    try:
        data = await asyncio.to_thread(_broker_get, "/queue", "", provider["broker_url"])
    except Exception:
        logger.debug("Provider %s /queue unreachable", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    if not _looks_like(data, _QUEUE_SHAPE_KEYS):
        return JSONResponse({"reachable": True, "compatible": False}, status_code=502)
    return JSONResponse(data)


@app.get("/api/local/{provider_id}/metrics")
async def get_provider_metrics(provider_id: str, window: str = "lifetime"):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "metrics" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if window not in _LOCAL_METRICS_WINDOWS:
        return JSONResponse(
            {"error": f"window must be one of {list(_LOCAL_METRICS_WINDOWS)}"},
            status_code=400,
        )
    try:
        if provider.get("kind") == "vllm":
            data = await asyncio.to_thread(_vllm_metrics_persisted, provider["broker_url"], window)
        else:
            data = await asyncio.to_thread(_broker_get, "/metrics", f"window={window}", provider["broker_url"])
    except Exception:
        logger.debug("Provider %s /metrics unreachable", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    if not _looks_like(data, _METRICS_SHAPE_KEYS):
        return JSONResponse({"reachable": True, "compatible": False}, status_code=502)
    return JSONResponse(data)


@app.get("/api/local/{provider_id}/spill")
async def get_provider_spill(provider_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "spill" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    try:
        data = await asyncio.to_thread(_broker_get, "/config/spill", "", provider["broker_url"])
    except Exception:
        logger.debug("Provider %s GET /config/spill unreachable", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    if not _looks_like(data, _SPILL_SHAPE_KEYS):
        return JSONResponse({"reachable": True, "compatible": False}, status_code=502)
    return JSONResponse(data)


@app.put("/api/local/{provider_id}/spill")
async def set_provider_spill(provider_id: str, request: Request):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "spill" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if provider["scope"] != "local":
        return JSONResponse({"error": "read-only for remote providers"}, status_code=403)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "body must be JSON"}, status_code=400)
    if not isinstance(body, dict) or not body:
        return JSONResponse(
            {"ok": False, "error": "body must be a non-empty {class: seconds|null} map"},
            status_code=400,
        )
    for cls, val in body.items():
        if cls not in _SPILL_CLASSES:
            return JSONResponse(
                {"ok": False, "error": f"unknown lane class '{cls}'; known: {list(_SPILL_CLASSES)}"},
                status_code=400,
            )
        if val is None:
            continue
        if isinstance(val, bool) or not isinstance(val, (int, float)):
            return JSONResponse(
                {"ok": False, "error": f"'{cls}' must be a number of seconds or null"},
                status_code=400,
            )
        if val < 0 or val > _SPILL_MAX_S:
            return JSONResponse(
                {"ok": False, "error": f"'{cls}' seconds must be in 0..{_SPILL_MAX_S}"},
                status_code=400,
            )
    try:
        data = await asyncio.to_thread(_broker_put, "/config/spill", body, provider["broker_url"])
    except Exception:
        logger.debug("Provider %s PUT /config/spill failed", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    if not _looks_like(data, _SPILL_SHAPE_KEYS):
        return JSONResponse({"reachable": True, "compatible": False,
                             "error": "connected service is not the lane broker"},
                            status_code=502)
    return JSONResponse(data)


@app.post("/api/local/{provider_id}/endpoint")
async def set_provider_endpoint(provider_id: str, request: Request):
    """Reconfigure a LOCAL provider's endpoint (host:port).

    SECURITY-CRITICAL: whatever URL is stored here is fetched server-side, so
    this is an SSRF surface. Only loopback / RFC-1918 private IP literals (plus
    the literal "localhost") are accepted; non-IP hostnames are rejected to
    prevent DNS rebinding, and link-local / cloud-metadata / multicast /
    reserved / unspecified / public addresses are rejected explicitly.
    """
    import ipaddress

    provider = _PROVIDERS.get(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if provider["scope"] != "local":
        return JSONResponse({"error": "endpoint config is local-only"}, status_code=403)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "body must be JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)

    host = body.get("host")
    port = body.get("port")
    if not isinstance(host, str) or isinstance(port, bool) or not isinstance(port, int):
        return JSONResponse(
            {"error": "body must carry host (str) and port (int)"}, status_code=400
        )

    # Port range.
    if port < 1 or port > 65535:
        return JSONResponse({"error": "port must be in 1..65535"}, status_code=400)

    host = host.strip()
    if not host:
        return JSONResponse({"error": "host must not be empty"}, status_code=400)

    # Host: accept the literal "localhost"; otherwise require a loopback/private
    # IP literal. The reject-first allowlist lives in _is_allowed_local_host so
    # the persistence loader can apply the SAME decision.
    if not _is_allowed_local_host(host):
        return JSONResponse(
            {"error": "host must be 'localhost' or a loopback/private IP address"},
            status_code=400,
        )

    # Bracket IPv6 literals so the assembled URL is well-formed (the allowlist
    # already gated the host; "localhost"/IPv4 pass through unchanged).
    host_for_url = host
    try:
        if host != "localhost" and ipaddress.ip_address(host).version == 6:
            host_for_url = f"[{host}]"
    except ValueError:
        logger.error("host %r passed allowlist but failed to parse as IP", host, exc_info=True)
        return JSONResponse({"error": "invalid host"}, status_code=400)

    url = f"http://{host_for_url}:{port}"
    provider["management_url"] = url
    provider["broker_url"] = url
    mapping = _load_provider_endpoints()
    mapping[provider_id] = url
    _save_provider_endpoints(mapping)
    logger.info("Provider %s endpoint set to %s", provider_id, url)
    return JSONResponse({"ok": True, "endpoint_hint": f"{host}:{port}"})


@app.get("/api/local/{provider_id}/models")
async def get_provider_models(provider_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "models" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    try:
        data = await asyncio.to_thread(_mgmt_get, provider, _models_path(provider))
    except Exception:
        logger.debug("Provider %s /models unreachable", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    raw_models = data.get("data") if isinstance(data, dict) else None
    if raw_models is None:
        raw_models = []
    models = [
        {field: m.get(field) if isinstance(m, dict) else None for field in _MODEL_FIELDS}
        for m in raw_models
    ]
    return JSONResponse({"reachable": True, "models": models})


def _provider_models_loaded_count(data) -> int:
    raw_models = data.get("data") if isinstance(data, dict) else None
    if not raw_models:
        return 0
    return sum(1 for m in raw_models if isinstance(m, dict) and m.get("state") == "loaded")


@app.get("/api/local/{provider_id}/health")
async def get_provider_health(provider_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "health" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)

    async def probe_broker():
        try:
            await asyncio.to_thread(_broker_get, "/queue", "", provider["broker_url"])
            return True
        except Exception:
            return False

    async def probe_provider():
        try:
            data = await asyncio.to_thread(_mgmt_get, provider, _models_path(provider))
            return True, _provider_models_loaded_count(data)
        except Exception:
            return False, 0

    broker_reachable, (provider_reachable, models_loaded) = await asyncio.gather(
        probe_broker(), probe_provider()
    )
    return JSONResponse({
        "broker": {"reachable": broker_reachable},
        "provider": {"reachable": provider_reachable, "models_loaded": models_loaded},
        "ok": bool(broker_reachable and provider_reachable),
    })


_TRACE_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")


@app.get("/api/local/{provider_id}/traces")
async def get_provider_traces(provider_id: str, limit: int = 20):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "traces" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if limit < 1 or limit > 100:
        limit = max(1, min(100, limit))
    try:
        data = await asyncio.to_thread(_broker_get, "/traces", f"limit={limit}", provider["broker_url"])
    except Exception:
        logger.debug("Provider %s /traces unreachable", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    return JSONResponse(data)


@app.get("/api/local/{provider_id}/trace/{trace_id}")
async def get_provider_trace(provider_id: str, trace_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "traces" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if not _TRACE_ID_RE.match(trace_id):
        return JSONResponse({"error": "invalid trace_id"}, status_code=400)
    try:
        data = await asyncio.to_thread(_broker_get, f"/trace/{trace_id}", "", provider["broker_url"])
    except Exception:
        logger.debug("Provider %s /trace/%s unreachable", provider_id, trace_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    return JSONResponse(data)


@app.get("/api/local/{provider_id}/metrics/timeseries")
async def get_provider_metrics_timeseries(provider_id: str, window: str = "24h", bucket: str = "1h"):
    """Proxy the broker's recomputable timeseries (GET :broker/metrics/timeseries).

    Same window validation as /metrics -- window is never forwarded unvalidated.
    ``bucket`` is passed through as-is; the broker validates bucket sizing per
    its own contract (5m/1h/1d), this proxy does not second-guess it.
    """
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "metrics" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if window not in _LOCAL_METRICS_WINDOWS:
        return JSONResponse(
            {"error": f"window must be one of {list(_LOCAL_METRICS_WINDOWS)}"},
            status_code=400,
        )
    # vLLM's Prometheus counters are cumulative-since-start -- there is no
    # per-bucket history to recompute. Say so honestly instead of proxying a
    # /metrics/timeseries the vLLM server does not serve (which would 503 as if
    # it were merely unreachable).
    if provider.get("kind") == "vllm":
        return JSONResponse(
            {"window": window, "bucket": bucket, "buckets": [], "supported": False,
             "note": "vLLM exposes cumulative counters only; no recomputable timeseries."}
        )
    try:
        data = await asyncio.to_thread(
            _broker_get, "/metrics/timeseries", f"window={window}&bucket={bucket}", provider["broker_url"]
        )
    except Exception:
        logger.debug("Provider %s /metrics/timeseries unreachable", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    return JSONResponse(data)


@app.get("/api/local/{provider_id}/spills")
async def get_provider_spills(provider_id: str, limit: int = 20):
    """Proxy the broker's per-spill-event log (GET :broker/spills?limit=)."""
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "spill" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if limit < 1 or limit > 100:
        limit = max(1, min(100, limit))
    try:
        data = await asyncio.to_thread(_broker_get, "/spills", f"limit={limit}", provider["broker_url"])
    except Exception:
        logger.debug("Provider %s /spills unreachable", provider_id, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    return JSONResponse(data)


# ── API-side usage summary + reference pricing ────────────

_USAGE_SUMMARY_WINDOWS = ("session", "24h", "7d", "lifetime")

# Fallback pricing when web/pricing_models.json (owned by usage_tracker/W3) is
# missing or unreadable -- keeps GET /api/pricing/models always returning 200
# rather than surfacing an em-dash grid. $/1M tokens.
_DEFAULT_PRICING_MODELS = [
    {"id": "claude-sonnet", "label": "Claude Sonnet", "input_per_mtok": 3.0, "output_per_mtok": 15.0, "fetched_at": None},
    {"id": "claude-opus", "label": "Claude Opus", "input_per_mtok": 5.0, "output_per_mtok": 25.0, "fetched_at": None},
    {"id": "claude-haiku", "label": "Claude Haiku", "input_per_mtok": 1.0, "output_per_mtok": 5.0, "fetched_at": None},
    {"id": "fable", "label": "Fable", "input_per_mtok": 10.0, "output_per_mtok": 50.0, "fetched_at": None},
]

_PRICING_MODELS_PATH = os.path.join(os.path.dirname(__file__), "pricing_models.json")


@app.get("/api/usage/summary")
async def get_usage_summary(window: str = "lifetime"):
    """API-side usage comparison data, sourced from usage_tracker (never the broker).

    Shape per the routing/reporting handoff: {runs, tokens{prompt,completion},
    ttft_ms{p50,p95}, wall_ms{p50,p95}, errors_total, cost_usd, by_model:[...]}.
    The API side has no queue -- callers null any field it genuinely cannot
    supply rather than rendering a misleading 0.
    """
    if window not in _USAGE_SUMMARY_WINDOWS:
        return JSONResponse(
            {"error": f"window must be one of {list(_USAGE_SUMMARY_WINDOWS)}"},
            status_code=400,
        )
    try:
        data = usage_tracker.summary(window)
    except Exception:
        logger.debug("usage_tracker.summary(%s) failed", window, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    return JSONResponse(data)


@app.get("/api/pricing/models")
async def get_pricing_models():
    """Reference pricing table for the Ledger's 'avoided cost' math.

    Reads web/pricing_models.json (owned by usage_tracker/W3, a checked-in
    JSON with a fetched_at date, not a live call on render). Falls back to a
    small inline default -- and still returns 200 -- when the file is missing
    or unreadable.
    """
    try:
        with open(_PRICING_MODELS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        models = data["models"] if isinstance(data, dict) else data
        if not isinstance(models, list) or not models:
            raise ValueError("pricing_models.json has no models")
        return JSONResponse(models)
    except Exception:
        logger.debug("pricing_models.json unreadable, falling back to default pricing", exc_info=True)
        return JSONResponse(_DEFAULT_PRICING_MODELS)


# Legacy routes: delegate to the default provider so old clients keep working.


@app.get("/api/local/queue")
async def get_local_queue():
    """Proxy the broker's read-only queue snapshot (GET :broker/queue).

    Returns the broker JSON verbatim on success; 503 {reachable: false} when
    the broker is down/unreachable so the frontend renders a dim 'offline'
    state without console noise.
    """
    return await get_provider_queue(_DEFAULT_PROVIDER)


@app.get("/api/local/metrics")
async def get_local_metrics(window: str = "lifetime"):
    """Proxy the broker's read-only metrics aggregates for a time window.

    ``window`` is validated against the broker's documented set BEFORE
    forwarding — an unbounded client string is never passed to the broker.
    """
    return await get_provider_metrics(_DEFAULT_PROVIDER, window)


@app.get("/api/local/spill")
async def get_local_spill():
    """Proxy the broker's current per-class spill thresholds + spilled counters.

    Broker shape: {spill_thresholds_s: {interactive, worker, batch}, spilled_total,
    spilled_by_class, persisted}. 503 {reachable: false} when the broker is down.
    """
    return await get_provider_spill(_DEFAULT_PROVIDER)


@app.put("/api/local/spill")
@app.post("/api/local/spill")
async def set_local_spill(request: Request):
    """Set per-lane-class spill thresholds (seconds) on the broker.

    Body is a PARTIAL map of {class: seconds|null} — any subset of the known
    lane classes; ``null`` disables spill for that class. Validated all-or-
    nothing BEFORE forwarding (defense in depth — the broker validates too):
    unknown class or out-of-range value → 400 and nothing is forwarded. The
    change is session-only on the broker (not persisted), so it is fully
    reversible. Forwarded to the broker as ``PUT /config/spill``.
    """
    return await set_provider_spill(_DEFAULT_PROVIDER, request)


# ── Static files ─────────────────────────────────────────


# Serve React frontend assets (JS, CSS, images from Vite build)
@app.get("/assets/{path:path}")
async def frontend_assets(path: str):
    if FRONTEND_DIST.is_dir():
        file_path = FRONTEND_DIST / "assets" / path
        if file_path.is_file():
            # Vite content-hashes all asset filenames (e.g. index-Cy6SfuEk.js),
            # so these are safe to cache forever.
            return FileResponse(
                file_path,
                headers={"Cache-Control": "public, max-age=31536000, immutable"},
            )
    return HTMLResponse("Not found", 404)


# Serve frontend root-level static files (favicon, icons, etc.)
@app.get("/favicon.svg")
@app.get("/favicon.png")
@app.get("/icons.svg")
@app.get("/app-icon.png")
@app.get("/icon-192.png")
@app.get("/icon-512.png")
async def frontend_root_files(request: Request):
    if FRONTEND_DIST.is_dir():
        filename = request.url.path.lstrip("/")
        file_path = FRONTEND_DIST / filename
        if file_path.is_file():
            return FileResponse(file_path)
    return HTMLResponse("Not found", 404)


@app.post("/api/shutdown")
async def api_shutdown():
    """Initiate graceful shutdown — called by the auto-updater before replacing the sidecar exe."""
    loop = asyncio.get_event_loop()
    loop.call_later(0.3, lambda: os.kill(os.getpid(), 15))  # SIGTERM after response is sent
    return {"status": "shutting down"}


# Hosts considered loopback-only — anything else means the API (which has no
# authentication) is reachable from other machines on the LAN.
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def main():
    import uvicorn
    port = int(os.getenv("PORT", "8420"))
    # Default to loopback-only. The server has no authentication, so binding
    # 0.0.0.0 by default would expose filesystem browse/upload endpoints and
    # arbitrary process spawn (new PTY sessions run `claude`) to the whole
    # LAN. HOST still overrides for anyone who explicitly wants that.
    host = os.getenv("HOST", "127.0.0.1")
    url = f"http://localhost:{port}"
    logger.info("Claude Cockpit -> %s", url)
    if host not in _LOOPBACK_HOSTS:
        logger.warning(
            "Cockpit is binding to %s, which is NOT loopback-only — the API has "
            "no authentication, so it will be reachable by anyone on the LAN "
            "(filesystem browse/upload, arbitrary process spawn). Set HOST=127.0.0.1 "
            "unless you specifically intend to expose it.",
            host,
        )
    # Auto-open browser unless suppressed
    if os.getenv("NO_BROWSER", "").lower() not in ("1", "true", "yes"):
        import threading
        threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    main()
