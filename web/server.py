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

import pty_manager as pty_manager_module  # noqa: E402 -- module handle for resolve_claude_cli(); see /api/cli
from pty_manager import ClaudeCliNotFound, pty_manager  # noqa: E402 -- must follow load_dotenv(): reads MAX_SESSIONS/IDLE_TIMEOUT from os.environ at module scope
from bridge_manager import bridge_manager, channel_manager, cleanup_relay_dir  # noqa: E402 -- grouped with pty_manager import for consistent post-setup() init order
# _wait_for_idle_simple / _paste_and_submit are underscore-prefixed (bridge_manager treats
# them as internal helpers), but they are exactly the typing-quiet + idle gate
# and bracketed-paste injection mechanics the CLI-actions routes below need
# (PATCH rename sync, POST command). Reusing them here avoids re-implementing
# proven injection machinery — see bridge_manager.py's V1 manual relay for the
# same pattern.
from bridge_manager import _wait_for_idle_simple, _paste_and_submit  # noqa: E402 -- _paste_and_submit, never _wrap: the submit CR must be a separate write or the TUI eats it as pasted content
import anthropic_usage  # noqa: E402 -- grouped with the other local-module imports above
import chat_store  # noqa: E402 -- grouped with the other local-module imports above
import chat_runner  # noqa: E402 -- grouped with the other local-module imports above
import plexar_client  # noqa: E402 -- grouped with the other local-module imports above
import voice_service  # noqa: E402 -- free to import: every ML dependency inside it is lazy
import settings_store  # noqa: E402 -- grouped with the other local-module imports above for consistency; has no load_dotenv() ordering dependency of its own
from usage_tracker import usage_tracker  # noqa: E402 -- grouped with the other local-module imports above
import pricing_store as pricing_store_module  # noqa: E402 -- grouped with the other local-module imports above
from pricing_store import pricing_store  # noqa: E402
import spend_guard  # noqa: E402 -- reads settings_store/usage_tracker lazily; the sole spend-decision module
import context_window  # noqa: E402 -- pure resolver; fed the local /models payload below so local sessions get a real context ring

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
                            None, usage_tracker.ingest_jsonl, session.id, jsonl_path,
                            session.working_dir,
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
        apply_persisted_vllm_models_dir()
    except Exception:
        logger.error("Applying persisted vLLM models dir failed", exc_info=True)

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

    # Fleet history sampler: snapshots ALL providers to a local JSONL time-series
    # so the in-app History view is derived from Cockpit alone (no Prometheus).
    app.state.fleet_history_task = asyncio.create_task(_fleet_history_loop())

    # Daily model-price refresh. Prices are only ever APPENDED (pricing_store),
    # so a refresh updates what NEW events cost and can never re-price history.
    # Best-effort, same posture as the managed broker: never blocks startup,
    # cancelled cleanly on shutdown.
    app.state.pricing_refresh_task = asyncio.create_task(_pricing_refresh_loop())

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

    pricing_task = getattr(app.state, "pricing_refresh_task", None)
    if pricing_task:
        pricing_task.cancel()
        try:
            await pricing_task
        except asyncio.CancelledError:
            pass

    fleet_task = getattr(app.state, "fleet_history_task", None)
    if fleet_task:
        fleet_task.cancel()
        try:
            await fleet_task
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

# Anthropic -> OpenAI translation shim, mounted at /shim/vllm so the `claude`
# CLI can drive a local vLLM server via ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/shim/vllm.
# In-process (no extra sidecar process); see web/vllm_shim.py.
import vllm_shim  # noqa: E402 -- grouped with other post-app-creation setup

app.include_router(vllm_shim.router)

# LM Studio tagging proxy, mounted at /shim/lmstudio -- same session-scoped
# base URL strategy as /shim/vllm above, but a byte-verbatim passthrough
# (the broker already speaks Anthropic /v1/messages) that ADDS
# X-Lane-Class/X-Client-Id/X-Agent-Id headers for broker-side attribution.
# See web/lmstudio_proxy.py.
import lmstudio_proxy  # noqa: E402 -- grouped with other post-app-creation setup

app.include_router(lmstudio_proxy.router)

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


#: What may be served BACK over HTTP for a thumbnail. Deliberately a subset of
#: ALLOWED_EXTENSIONS — see get_uploaded_file. No SVG: it carries script.
_PREVIEWABLE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


@app.get("/api/upload/{name}")
async def get_uploaded_file(name: str):
    """Serve ONE uploaded file back, for attachment thumbnails.

    A chip that says "photo.png" and a chip that shows the photo are different
    products: the second one lets you catch "I attached the wrong screenshot"
    before you send it. That needs the bytes back in the browser, which needs
    this route, which is why it is written carefully rather than mounted as a
    static directory.

    THE RULE: the caller supplies a BARE FILENAME, never a path. `Path(name).name`
    strips any directory component, so "../../../etc/passwd" degrades to
    "passwd" and simply misses. The resolved result is then re-checked against
    UPLOAD_DIR with `is_relative_to` — belt and braces, because a symlink inside
    the upload dir would satisfy the first check and escape on resolve.

    404 for anything not in the directory, deliberately without distinguishing
    "no such file" from "outside the sandbox": a probe should not learn which.
    """
    candidate = Path(name).name
    if not candidate:
        return JSONResponse({"error": "not found"}, status_code=404)

    target = (UPLOAD_DIR / candidate).resolve()
    upload_root = UPLOAD_DIR.resolve()
    if not target.is_relative_to(upload_root) or not target.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)

    # IMAGES ONLY, and narrower than the UPLOAD allow-list on purpose. That
    # list is sized for what the MODEL may read with its own Read tool — .env,
    # .py, .sql, .html — and reading a file off disk in a subprocess is a
    # different act from serving it over HTTP from the app's own origin. This
    # route exists solely to draw a thumbnail, so it serves only what can be a
    # thumbnail. Everything else 404s and reaches the model the way it already
    # does.
    #
    # SVG is excluded despite being an image: it is a script-bearing document,
    # and the one image format where "just render it" is not harmless.
    if target.suffix.lower() not in _PREVIEWABLE_EXTENSIONS:
        return JSONResponse({"error": "not found"}, status_code=404)

    return FileResponse(
        target,
        # Never inline: an SVG or HTML served inline from our own origin would
        # run script in the app's context. A thumbnail <img> renders an
        # attachment download just as happily.
        headers={
            "Content-Disposition": f'attachment; filename="{candidate}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=300",
        },
    )


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


# Directories we deliberately never walk: huge and/or pure noise. They are
# still LISTED (with skipped=true) so the UI can show them greyed out.
_BROWSE_SKIP_DIRS = frozenset({
    "node_modules", ".git", "venv", ".venv", "__pycache__",
    "dist", "build", ".next", "target",
})

# git status --porcelain hard timeout (seconds). A slow repo must degrade to
# dirty=null, never to a false "clean".
_GIT_STATUS_TIMEOUT = 3.0


def _git_branch_from_head(dir_path: str) -> tuple[bool, str | None]:
    """(is_git, branch) for *dir_path*, from a plain read of .git/HEAD.

    No subprocess -- this runs once per row in a 60-folder listing, so a
    `git` fork per entry is off the table. Handles both a .git DIRECTORY and
    a .git FILE (worktrees / submodules use `gitdir: <path>`). A detached HEAD
    yields the 7-char short sha. Returns (git, None) when HEAD is unreadable.
    """
    dot_git = os.path.join(dir_path, ".git")
    try:
        if os.path.isdir(dot_git):
            head_path = os.path.join(dot_git, "HEAD")
        elif os.path.isfile(dot_git):
            with open(dot_git, "r", encoding="utf-8", errors="replace") as f:
                content = f.read().strip()
            if not content.lower().startswith("gitdir:"):
                return True, None
            gitdir = content.split(":", 1)[1].strip()
            if not os.path.isabs(gitdir):
                gitdir = os.path.normpath(os.path.join(dir_path, gitdir))
            head_path = os.path.join(gitdir, "HEAD")
        else:
            return False, None
    except OSError:
        logger.debug("browse: .git probe failed for %s", dir_path, exc_info=True)
        return False, None

    try:
        with open(head_path, "r", encoding="utf-8", errors="replace") as f:
            head = f.read().strip()
    except OSError:
        logger.debug("browse: unreadable HEAD at %s", head_path, exc_info=True)
        return True, None

    if head.startswith("ref:"):
        ref = head.split(":", 1)[1].strip()
        prefix = "refs/heads/"
        return True, (ref[len(prefix):] if ref.startswith(prefix) else ref) or None
    if head:
        return True, head[:7]
    return True, None


def _live_session_count_under(dir_path: str) -> int:
    """Live sessions whose working_dir is at or under *dir_path*."""
    try:
        base = os.path.normcase(os.path.normpath(dir_path))
    except (TypeError, ValueError):
        return 0
    count = 0
    for session in list(pty_manager.sessions.values()):
        wd = getattr(session, "working_dir", "") or ""
        if not wd:
            continue
        try:
            norm = os.path.normcase(os.path.normpath(wd))
        except (TypeError, ValueError):
            continue
        if norm == base or norm.startswith(base + os.sep):
            count += 1
    return count


def _browse_entry(dir_path: str) -> dict:
    """Per-row metadata for one directory. Never raises -- an unreadable
    directory yields nulls for the fields it could not source, so one bad
    folder can never fail the whole listing.

    `dirty` is ALWAYS null here: it needs `git status`, which is far too slow
    to run per row. The UI fetches it for the selected row only, via
    GET /api/browse/git.
    """
    name = os.path.basename(dir_path.rstrip("\\/")) or dir_path
    entry = {
        "name": name, "path": dir_path, "git": False, "branch": None,
        "dirty": None, "session_count": 0, "entry_count": None, "skipped": False,
    }
    if name in _BROWSE_SKIP_DIRS:
        entry["skipped"] = True
        return entry
    try:
        entry["git"], entry["branch"] = _git_branch_from_head(dir_path)
    except Exception:
        logger.debug("browse: git metadata failed for %s", dir_path, exc_info=True)
    try:
        entry["session_count"] = _live_session_count_under(dir_path)
    except Exception:
        logger.debug("browse: session count failed for %s", dir_path, exc_info=True)
    try:
        with os.scandir(dir_path) as it:
            entry["entry_count"] = sum(1 for _ in it)
    except PermissionError:
        logger.debug("browse: permission denied counting %s", dir_path, exc_info=True)
    except OSError:
        logger.debug("browse: scandir failed for %s", dir_path, exc_info=True)
    return entry


def _browse_entries(dirs: list[str]) -> list[dict]:
    """`entries` list parallel to (same order as) *dirs*."""
    return [_browse_entry(d) for d in dirs]


@app.get("/api/browse")
async def browse_directories(path: str = ""):
    """List subdirectories of the given path for folder autocomplete.

    Returns `dirs` (list of absolute path strings -- unchanged legacy shape,
    still consumed by NewSessionDialog) plus a parallel `entries` list carrying
    per-row metadata: git/branch (read straight from .git/HEAD, no subprocess),
    live session_count, entry_count (one scandir; null on PermissionError),
    and skipped=true for heavy dirs we refuse to walk. `dirty` is always null
    in the listing -- use GET /api/browse/git for the selected row.
    """
    if not path:
        if sys.platform == "win32":
            # Return drive roots on Windows
            import string
            drives = []
            for letter in string.ascii_uppercase:
                drive = f"{letter}:\\"
                if os.path.isdir(drive):
                    drives.append(drive)
            return JSONResponse({"dirs": drives, "parent": "", "entries": _browse_entries(drives)})
        else:
            return JSONResponse({"dirs": ["/"], "parent": "", "entries": _browse_entries(["/"])})

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
                return JSONResponse({"dirs": dirs, "parent": str(parent), "entries": _browse_entries(dirs)})
            except PermissionError:
                return JSONResponse({"dirs": [], "parent": str(parent), "entries": []})
        return JSONResponse({"dirs": [], "parent": "", "entries": []})

    try:
        dirs = sorted(
            [
                str(p)
                for p in target.iterdir()
                if p.is_dir() and not p.name.startswith(".")
            ]
        )[:50]
        return JSONResponse({"dirs": dirs, "parent": str(target), "entries": _browse_entries(dirs)})
    except PermissionError:
        return JSONResponse({"dirs": [], "parent": str(target), "entries": []})


@app.get("/api/browse/git")
async def browse_git_detail(path: str):
    """Full git detail for ONE directory (the row the user selected).

    This is the only place a `git status` runs -- deliberately not in the
    listing, where 60 subprocess forks would stall the request. Hard 3s
    timeout; on timeout/failure/absent git, dirty and changed are null rather
    than a misleading false/0. subprocess is invoked with list argv (never
    shell=True).
    """
    target = Path(path)
    if not target.is_dir():
        return JSONResponse({"git": False, "branch": None, "dirty": None, "changed": None})

    is_git, branch = _git_branch_from_head(str(target))
    if not is_git:
        return JSONResponse({"git": False, "branch": None, "dirty": None, "changed": None})

    dirty = None
    changed = None
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            ["git", "status", "--porcelain"],
            cwd=str(target), capture_output=True, text=True,
            timeout=_GIT_STATUS_TIMEOUT,
        )
        if result.returncode == 0:
            lines = [ln for ln in result.stdout.splitlines() if ln.strip()]
            changed = len(lines)
            dirty = changed > 0
        else:
            logger.debug("browse/git: git status rc=%s for %s", result.returncode, path)
    except subprocess.TimeoutExpired:
        logger.debug("browse/git: git status timed out for %s", path, exc_info=True)
    except (OSError, ValueError):
        logger.debug("browse/git: git status failed for %s", path, exc_info=True)

    return JSONResponse({"git": True, "branch": branch, "dirty": dirty, "changed": changed})


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

    # Spend guardrail (spend.enforce_on.new_sessions, default OFF). Cheap to
    # honour here: the check happens BEFORE the spawn, so nothing has to be torn
    # down, and it returns immediately without a DB read when the flag is off.
    # Note this bounds NEW sessions only — an already-running session's
    # interactive typing is never blocked.
    spend = await _spend_refusal("new_sessions")
    if spend is not None:
        return JSONResponse(
            {"error": _spend_error_text(spend), "spend": spend},
            status_code=409,
        )

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
        return bool(await _paste_and_submit(terminal_id, f"/rename {name}"))
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

    ok = await _paste_and_submit(terminal_id, command)
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


def _detect_pty_backend_name() -> str | None:
    """Report which PtyProcess implementation pty_backend.get_backend()
    actually selects on this host, without instantiating it.

    Mirrors the selection logic in pty_backend.get_backend() rather than
    calling it directly, since get_backend() imports (and on Windows dev
    mode, requires) the winpty package as a side effect — we only want to
    know which name it would pick. Returns None if undetermined rather
    than guessing.
    """
    try:
        if sys.platform in ("linux", "darwin"):
            return "unix"
        if sys.platform == "win32":
            return "conpty" if getattr(sys, "_MEIPASS", None) else "winpty"
    except Exception:
        logger.debug("PTY backend detection failed", exc_info=True)
    return None


def _detect_windows_build_number() -> int | None:
    """Return the Windows build number (e.g. 19045) or None off-Windows /
    on failure. Never raises. Uses sys.getwindowsversion() only — no
    shelling out to ver/wmic.
    """
    if sys.platform != "win32":
        return None
    try:
        return sys.getwindowsversion().build
    except Exception:
        logger.debug("Windows build number detection failed", exc_info=True)
        return None


# Computed once at import time — these are OS/process facts that cannot
# change for the lifetime of the process, so there is no need to recompute
# per-request.
_PLATFORM_INFO = {
    "platform": sys.platform,
    "pty_backend": _detect_pty_backend_name(),
    "build_number": _detect_windows_build_number(),
}


@app.get("/api/platform")
async def get_platform():
    """Expose OS/PTY-backend facts the frontend needs to correctly configure
    xterm.js's windowsPty option (backend + buildNumber). Without this,
    xterm re-reflows lines ConPTY has already reflowed, producing
    duplicated/stale row fragments (e.g. a duplicated final markdown-table
    row). Contains no sensitive data — no paths, no software versions
    beyond the OS build. No auth required.
    """
    return JSONResponse(_PLATFORM_INFO)


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

    # Re-derive liveness from the process before forwarding. If a transient I/O
    # error previously flagged this session dead while claude.exe kept running,
    # the forwarder below would exit instantly and re-send "[Session ended]" on
    # every reconnect — a pane that could never recover. See resync_alive.
    pty_manager.resync_alive(terminal_id)

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
                            resized = pty_manager.resize_terminal(
                                terminal_id,
                                ctrl.get("cols", 120),
                                ctrl.get("rows", 30),
                            )
                            if not resized:
                                # Contract: on a failed resize the client has
                                # already optimistically cached the requested
                                # dims, so PTY size and xterm size would
                                # silently diverge forever. Tell the client
                                # to drop its cached dims and retry on the
                                # next resize event. Non-fatal — do not
                                # close the socket.
                                logger.debug(
                                    "Resize failed for terminal %s (cols=%s rows=%s)",
                                    terminal_id, ctrl.get("cols"), ctrl.get("rows"),
                                )
                                try:
                                    await websocket.send_text('{"type":"resize_failed"}')
                                except Exception:
                                    logger.debug(
                                        "Failed to send resize_failed notice for terminal %s",
                                        terminal_id, exc_info=True,
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


# ── Spend guardrails ─────────────────────────────────────
#
# spend_guard owns every decision; these are only the enforcement points.
# Interactive typing is NEVER blocked — out of scope by design.


async def _spend_refusal(scope: str):
    """The spend_guard payload if *scope* must be refused, else None.

    Async gotcha: the guard does synchronous sqlite reads (usage + pricing DBs),
    so it runs in a worker thread rather than on the event loop that also serves
    every terminal WebSocket. Both stores are opened check_same_thread=False and
    serialise their own statements, so the hop is safe.
    """
    return await asyncio.to_thread(spend_guard.check_start, scope)


def _spend_error_text(spend: dict) -> str:
    """A one-line human reason for a spend refusal, taken from the payload."""
    reasons = spend.get("reasons") or []
    if reasons:
        return "Spend cap reached: " + "; ".join(str(r) for r in reasons)
    return "Spend cap reached"


@app.get("/api/spend/status")
async def get_spend_status():
    """Current spend posture: window, per-class spend vs cap, and whether
    Cockpit is blocking.

    ALWAYS 200. This is a status read the Settings page renders inline; failing
    it would blank the panel and teach the user to ignore it. spend_guard.evaluate
    never raises and reports its own gaps via ``caveats``.
    """
    return JSONResponse(await asyncio.to_thread(spend_guard.evaluate))


@app.get("/api/anthropic/usage")
async def get_anthropic_usage(refresh: bool = False):
    """Real subscription utilization — the 5-hour / weekly bars from `/status`.

    ALWAYS 200, like /api/spend/status: this feeds an inline panel, and an HTTP
    error would blank it. ``available: false`` plus a ``reason`` is how the
    unavailable cases are reported, so the UI can say *why* (expired login vs.
    no subscription vs. offline) instead of showing an empty bar.

    The OAuth token stays server-side — only derived percentages and reset
    timestamps cross to the browser.
    """
    return JSONResponse(await anthropic_usage.fetch_usage(force=refresh))


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
    # Spend guardrail: an autonomous bridge runs unattended and max_turns bounds
    # turns, not dollars. Refuse with the same 409 conflict idiom the guards above
    # use, and hand back the whole evaluate() payload so the UI can name the exact
    # cap that tripped instead of guessing.
    spend = await _spend_refusal("bridges")
    if spend is not None:
        return JSONResponse(
            {"ok": False, "error": _spend_error_text(spend), "spend": spend},
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

    # Spend guardrail — same refusal as /api/bridge/auto (see there).
    spend = await _spend_refusal("bridges")
    if spend is not None:
        return JSONResponse(
            {"ok": False, "error": _spend_error_text(spend), "spend": spend},
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


# ── Settings: Anthropic API Key ──────────────────────────
#
# Deliberately the same shape as the OpenRouter routes above (GET/POST/DELETE,
# {configured, source, masked}) so the Settings UI can reuse one card. The key
# is stored in config.json alongside the OpenRouter key -- NEVER settings.json,
# which is an exportable, shareable blob.
#
# Unlike OpenRouter there is no save-time live validation: Anthropic has no
# free "who am I" endpoint that is safe to call unconditionally, and a
# validation probe that costs the user money on every save is worse than a
# late failure. Format is checked instead.


@app.get("/api/settings/anthropic")
async def get_anthropic_settings():
    """Report whether an Anthropic key is configured, and from where."""
    key, source = settings_store.resolve_anthropic_key()
    return JSONResponse({
        "configured": key is not None,
        "source": source,
        "masked": settings_store.mask_key(key) if key else None,
    })


@app.post("/api/settings/anthropic")
async def set_anthropic_settings(request: Request):
    """Persist a user-supplied Anthropic API key. Body: {"key": str}."""
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return JSONResponse({"ok": False, "error": "body must be valid JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "error": "body must be a JSON object"}, status_code=400)

    key = body.get("key", "")
    if not isinstance(key, str):
        return JSONResponse({"ok": False, "error": "key must be a string"}, status_code=400)
    key = key.strip()
    if not key:
        return JSONResponse({"ok": False, "error": "key must not be empty"}, status_code=400)
    if any(ch.isspace() for ch in key):
        return JSONResponse({"ok": False, "error": "key must not contain whitespace"}, status_code=400)

    settings_store.set_provider_ui_key("anthropic", key)
    masked = settings_store.mask_key(key)
    logger.info("Anthropic API key saved (masked: %s)", masked)
    return JSONResponse({"ok": True, "configured": True, "source": "ui", "masked": masked})


@app.get("/api/settings/plexar")
async def get_plexar_settings():
    """Where Plexar-vLLM is and whether a credential is configured.

    The key itself is NEVER returned — only a mask and its source, the same
    stance as every other provider key. `authenticated` is deliberately absent:
    whether the key WORKS is what /api/local/plexar-vllm/identity answers, and
    conflating "configured" with "accepted" is how a rejected key reads as a
    missing one.
    """
    url, _auth = _plexar_config()
    key, source = settings_store.resolve_provider_key("plexar")
    return JSONResponse({
        "base_url": url,
        "configured": bool(key),
        "source": source,
        "masked": settings_store.mask_key(key) if key else None,
        # Cloudflare Access is being retired; the tunnel stays. Reported so the
        # UI can say whether the legacy pair is still in play rather than
        # guessing from the URL.
        "cf_configured": bool(os.getenv("COCKPIT_PLEXAR_CF_CLIENT_ID")
                              and os.getenv("COCKPIT_PLEXAR_CF_CLIENT_SECRET")),
    })


@app.post("/api/settings/plexar")
async def set_plexar_settings(body: dict):
    """Set the Plexar URL and/or key. Either may be sent alone."""
    if "key" in body:
        key = body.get("key")
        if not isinstance(key, str) or not key.strip():
            return JSONResponse({"ok": False, "error": "key must not be empty"},
                                status_code=400)
        key = key.strip()
        if any(ch.isspace() for ch in key):
            return JSONResponse({"ok": False, "error": "key must not contain whitespace"},
                                status_code=400)
        settings_store.set_provider_ui_key("plexar", key)
        logger.info("Plexar key saved (masked: %s)", settings_store.mask_key(key))

    if "base_url" in body:
        url = body.get("base_url")
        if not isinstance(url, str):
            return JSONResponse({"ok": False, "error": "base_url must be a string"},
                                status_code=400)
        url = url.strip().rstrip("/")
        # An empty string is MEANINGFUL: it clears the override and falls back
        # to the environment, then loopback. Refusing it would make the stored
        # value impossible to undo from the UI.
        if url and not url.startswith(("http://", "https://")):
            return JSONResponse({"ok": False, "error": "base_url must start with http:// or https://"},
                                status_code=400)
        settings_store.update_settings({"providers": {"plexar": {"base_url": url}}})

    url, _auth = _plexar_config()
    key, source = settings_store.resolve_provider_key("plexar")
    return JSONResponse({
        "ok": True, "base_url": url, "configured": bool(key), "source": source,
        "masked": settings_store.mask_key(key) if key else None,
    })


@app.delete("/api/settings/plexar")
async def delete_plexar_key():
    """Remove the UI-configured Plexar key.

    A key from COCKPIT_PLEXAR_KEY cannot be removed here — the server does not
    own the caller's environment. Saying so beats reporting success and leaving
    the key in force.
    """
    settings_store.delete_provider_ui_key("plexar")
    key, source = settings_store.resolve_provider_key("plexar")
    if source == "env":
        return JSONResponse({
            "ok": False, "configured": True, "source": "env",
            "masked": settings_store.mask_key(key),
            "error": ("This key comes from the COCKPIT_PLEXAR_KEY environment "
                      "variable, which Cockpit cannot unset."),
        })
    return JSONResponse({"ok": True, "configured": False, "source": None})


@app.delete("/api/settings/anthropic")
async def delete_anthropic_settings():
    """Remove the UI-configured Anthropic key.

    A key that came from ANTHROPIC_API_KEY cannot be removed from here -- the
    server does not own the caller's environment. Saying so beats reporting
    success and leaving the key in force.
    """
    removed = settings_store.delete_provider_ui_key("anthropic")
    key, source = settings_store.resolve_anthropic_key()
    if source == "env":
        return JSONResponse({
            "ok": False,
            "configured": True,
            "source": "env",
            "masked": settings_store.mask_key(key),
            "error": (
                "This key comes from the ANTHROPIC_API_KEY environment variable, "
                "which Cockpit cannot unset. Remove it from your environment (or "
                "web/.env) and restart Cockpit."
            ),
        })
    return JSONResponse({
        "ok": True,
        "removed": removed,
        "configured": key is not None,
        "source": source,
        "masked": settings_store.mask_key(key) if key else None,
    })


@app.get("/api/settings")
async def get_settings():
    """Return the effective settings blob plus the real resolved path of settings.json.

    The path is reported so the Settings UI can show the user where the file
    actually lives instead of guessing.
    """
    return JSONResponse({
        "path": settings_store.settings_path(),
        "settings": settings_store.read_settings(),
    })


@app.put("/api/settings")
async def put_settings(request: Request):
    """Apply a PARTIAL nested settings patch.

    Body is a nested dict containing only the keys to change. Validation is
    all-or-nothing: a single bad value rejects the whole patch with 400 and
    nothing is written.
    """
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return JSONResponse({"error": "body must be valid JSON"}, status_code=400)

    try:
        effective = settings_store.update_settings(body)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    # Log the sections touched, never the values -- settings can carry user
    # palettes and keybindings, and the line should stay short.
    sections = ", ".join(sorted(body)) if isinstance(body, dict) else ""
    logger.info("Settings updated (sections: %s)", sections or "none")
    return JSONResponse({"path": settings_store.settings_path(), "settings": effective})


@app.post("/api/settings/reveal")
async def reveal_settings_file():
    """Best-effort: open the folder containing settings.json in the OS file manager.

    The folder is created first so a reveal on a fresh install (where nothing
    has been saved yet) still works. A failed reveal is a UI inconvenience, not
    a server error, so this always returns 200.
    """
    path = settings_store.settings_path()
    folder = str(Path(path).parent)
    try:
        Path(folder).mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            argv = ["explorer", folder]
        elif sys.platform == "darwin":
            argv = ["open", folder]
        else:
            argv = ["xdg-open", folder]
        # List argv, never shell=True -- the path is server-derived but a shell
        # invocation here would be a needless injection surface.
        subprocess.Popen(argv)
    except (OSError, ValueError) as e:
        logger.warning("Failed to reveal settings folder %s", folder, exc_info=True)
        return JSONResponse({"ok": False, "path": path, "error": str(e)})
    return JSONResponse({"ok": True, "path": path})


# ── Claude CLI info (Settings ▸ Claude CLI) ──────────────
#
# Resolution is NOT re-implemented here. pty_manager.resolve_claude_cli() is
# the single owner of "where is claude" -- the same function the spawn path
# uses -- so this endpoint can never disagree with what a new session will
# actually run. All this route adds is: which mechanism won, the --version
# string, and whether the resolved file is named what we expect.

# The name we expect the resolved executable to have, extension aside. npm
# shims are claude.cmd / claude.ps1 and the native installer produces
# claude.exe / claude, so the STEM is what is meaningful, not the suffix.
_EXPECTED_CLI_NAME = "claude"

# Hard ceiling on `claude --version`. A hung or half-installed binary must not
# hold a request open: 3s is far more than a version print needs.
_CLI_VERSION_TIMEOUT = 3.0

# Version cache, keyed on the resolved path. Held for the LIFETIME OF THE
# PROCESS (no TTL): the binary behind a given path does not change while
# cockpit runs, and a user who upgrades the CLI restarts cockpit anyway. A
# changed resolved path re-probes, since the key no longer matches. Failures
# are cached too -- otherwise a missing/hanging binary would be re-probed (and
# re-timed-out) on every page render.
_cli_version_cache: dict[str, str | None] = {}

# Matches a version number inside whatever the CLI prints, e.g.
# "1.10.1 (Claude Code)". Nothing is returned unless a real version-shaped
# token is present -- an error message is not a version.
_CLI_VERSION_RE = re.compile(r"\d+\.\d+(?:\.\d+)?(?:[-+.\w]*)?")


def _probe_cli_version(path: str) -> str | None:
    """Run ``<path> --version`` and extract the version. None on any failure.

    BLOCKING (subprocess.run) -- callers must use asyncio.to_thread so a slow
    binary cannot stall the event loop. subprocess.run's own timeout kills the
    child, so the thread cannot leak either.
    """
    try:
        proc = subprocess.run(
            [path, "--version"],       # list argv, never shell=True
            capture_output=True,
            timeout=_CLI_VERSION_TIMEOUT,
        )
    except subprocess.TimeoutExpired:
        logger.warning("`%s --version` timed out after %.0fs", path, _CLI_VERSION_TIMEOUT)
        return None
    except (OSError, ValueError, subprocess.SubprocessError):
        logger.warning("Failed to run `%s --version`", path, exc_info=True)
        return None

    if proc.returncode != 0:
        logger.warning("`%s --version` exited %s", path, proc.returncode)
        return None

    raw = (proc.stdout or b"") + b"\n" + (proc.stderr or b"")
    text = raw.decode("utf-8", errors="replace").strip()
    match = _CLI_VERSION_RE.search(text)
    return match.group(0) if match else None


async def _cli_version_for(path: str) -> str | None:
    """Cached version lookup for *path*."""
    if path in _cli_version_cache:
        return _cli_version_cache[path]
    version = await asyncio.to_thread(_probe_cli_version, path)
    _cli_version_cache[path] = version
    return version


@app.get("/api/cli")
async def get_cli_info():
    """Report the resolved Claude CLI: path, how it was found, and its version.

    ``path: null`` + ``source: "not_found"`` is a real, load-bearing state --
    cockpit cannot spawn any session at all -- so it is reported plainly
    rather than as an error.
    """
    override_raw = os.environ.get(pty_manager_module._CLAUDE_CLI_PATH_ENV, "").strip().strip('"')
    override_set = bool(override_raw)

    try:
        path, _effective_path = pty_manager_module.resolve_claude_cli(os.environ.get("PATH", ""))
    except ClaudeCliNotFound:
        # Expected on a machine without Claude Code installed; the payload
        # below is the honest answer, not a failure.
        logger.info("/api/cli: no `claude` executable could be resolved")
        return JSONResponse({
            "path": None,
            "source": "not_found",
            "version": None,
            "expected_name": _EXPECTED_CLI_NAME,
            "name_matches": False,
            "override_env": pty_manager_module._CLAUDE_CLI_PATH_ENV,
            "override_set": override_set,
        })
    except OSError:
        logger.warning("/api/cli: CLI resolution raised unexpectedly", exc_info=True)
        return JSONResponse({
            "path": None,
            "source": "not_found",
            "version": None,
            "expected_name": _EXPECTED_CLI_NAME,
            "name_matches": False,
            "override_env": pty_manager_module._CLAUDE_CLI_PATH_ENV,
            "override_set": override_set,
        })

    version = await _cli_version_for(path)
    return JSONResponse({
        "path": path,
        # The override is the ONLY branch in resolve_claude_cli that returns
        # without searching, so an override that is set and resolved is "env";
        # everything else (PATH hit or install-dir probe) is "search".
        "source": "env" if override_set else "search",
        "version": version,
        "expected_name": _EXPECTED_CLI_NAME,
        "name_matches": Path(path).stem.lower() == _EXPECTED_CLI_NAME,
        "override_env": pty_manager_module._CLAUDE_CLI_PATH_ENV,
        "override_set": override_set,
    })


# ── Version info (Settings ▸ Updates) ────────────────────
#
# READ-ONLY. The actual update check is Tauri's updater plugin in the frontend
# (it owns signature verification against latest.json); nothing here contacts
# GitHub.

# frontend/package.json is the single source of truth for the app version --
# vite.config.js injects it as VITE_APP_VERSION and tauri.conf.json reads
# "../package.json", so reading the same file means the API can never disagree
# with the number in the title bar or the installer.
def _app_version() -> str | None:
    candidates = [Path(__file__).parent / "frontend" / "package.json"]
    if getattr(sys, "_MEIPASS", None):
        # PyInstaller bundle layouts, in case package.json is added to the
        # spec's datas. Absent it, we return null rather than a guess.
        candidates.insert(0, Path(sys._MEIPASS) / "package.json")
        candidates.insert(1, Path(sys._MEIPASS) / "frontend_dist" / "package.json")
    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            data = json.loads(candidate.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, ValueError):
            logger.warning("Could not read app version from %s", candidate, exc_info=True)
            continue
        version = data.get("version") if isinstance(data, dict) else None
        if isinstance(version, str) and version:
            return version
    return None


@app.get("/api/version")
async def get_version_info():
    """App / CLI / Python / platform versions. Never 500s; unknowns are null."""
    cli_version = None
    try:
        path, _effective = pty_manager_module.resolve_claude_cli(os.environ.get("PATH", ""))
    except (ClaudeCliNotFound, OSError):
        path = None
    if path:
        cli_version = await _cli_version_for(path)

    return JSONResponse({
        "app": _app_version(),
        "cli": cli_version,
        "python": ".".join(str(p) for p in sys.version_info[:3]),
        "platform": sys.platform,
    })


# ── Logs (Settings ▸ Diagnostics) ────────────────────────

_LOG_LINES_DEFAULT = 500
_LOG_LINES_MAX = 2000
_LOG_LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")

# Redaction applied to EVERY line handed to the browser. The log viewer's
# output ends up in screenshots the owner pastes into chats, so a secret that
# was mis-logged upstream must not become a second leak here. Patterns:
#   1. provider keys with a known prefix (sk-ant-…, sk-or-…, sk-proj-…, plain
#      sk-… followed by 16+ key characters) -- the prefix is kept so the line
#      still says WHICH kind of key it was;
#   2. Authorization: Bearer <token> -- the token, not the header.
_REDACTIONS = (
    (re.compile(r"\b(sk-(?:ant|or|proj|live|test)-)[A-Za-z0-9_\-]{6,}"), r"\1<redacted>"),
    (re.compile(r"\b(sk-)[A-Za-z0-9_\-]{16,}"), r"\1<redacted>"),
    (re.compile(r"(?i)\b(bearer\s+)[A-Za-z0-9._\-]{12,}"), r"\1<redacted>"),
)


def _redact(line: str) -> str:
    """Replace secret-shaped substrings in *line* with a marker."""
    for pattern, replacement in _REDACTIONS:
        line = pattern.sub(replacement, line)
    return line


def _tail_file(path: Path, lines: int) -> tuple[list[str], bool, int]:
    """Return (last *lines* lines, truncated, size_bytes) for *path*.

    Reads BACKWARDS in 64 KiB blocks from the end of the file, so tailing a
    multi-megabyte log costs a couple of reads instead of loading the whole
    file. A missing/unreadable file is a clean empty result, never an error.
    """
    block = 64 * 1024
    try:
        size = path.stat().st_size
    except OSError:
        return [], False, 0

    chunks: list[bytes] = []
    newlines = 0
    reached_start = False
    try:
        with path.open("rb") as f:
            pos = size
            while pos > 0 and newlines <= lines:
                read_size = min(block, pos)
                pos -= read_size
                f.seek(pos)
                data = f.read(read_size)
                chunks.insert(0, data)
                newlines += data.count(b"\n")
            reached_start = pos == 0
    except OSError:
        logger.warning("Failed to tail log file %s", path, exc_info=True)
        return [], False, size

    text = b"".join(chunks).decode("utf-8", errors="replace")
    region = text.splitlines()
    # The first line of the read region may be a partial line unless we
    # reached byte 0 -- drop it rather than show half a message.
    if not reached_start and region:
        region = region[1:]
    truncated = not reached_start or len(region) > lines
    return [_redact(line) for line in region[-lines:]], truncated, size


@app.get("/api/logs")
async def get_logs(lines: str | None = None):
    """Return the tail of the cockpit log file, secret-redacted.

    ``lines`` is taken as a raw string and parsed here (rather than declared
    ``int``) so junk input falls back to the default instead of producing
    FastAPI's 422 -- a log viewer should always render something.
    """
    try:
        count = _LOG_LINES_DEFAULT if lines is None else int(lines)
    except (TypeError, ValueError):
        count = _LOG_LINES_DEFAULT
    count = max(1, min(_LOG_LINES_MAX, count))

    path = logging_config.log_file_path()
    tail, truncated, size = await asyncio.to_thread(_tail_file, Path(path), count)
    return JSONResponse({
        "path": path,
        "lines": tail,
        "truncated": truncated,
        "size_bytes": size,
        "rotation": logging_config.rotation_config(),
        "file_logging": logging_config.file_logging_active(),
    })


@app.get("/api/logs/level")
async def get_log_level():
    """Current level of the ``cockpit`` logger tree, plus the accepted values."""
    return JSONResponse({"level": logging_config.current_level(), "levels": list(_LOG_LEVELS)})


@app.put("/api/logs/level")
async def put_log_level(request: Request):
    """Set the runtime level for the ``cockpit`` logger tree. Body: {"level": str}."""
    try:
        body = await request.json()
    except (json.JSONDecodeError, ValueError):
        return JSONResponse({"error": "body must be valid JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)

    level = body.get("level")
    if not isinstance(level, str) or level.upper() not in _LOG_LEVELS:
        return JSONResponse(
            {"error": f"level must be one of {', '.join(_LOG_LEVELS)}"},
            status_code=400,
        )

    level = level.upper()
    logging.getLogger("cockpit").setLevel(getattr(logging, level))
    logger.info("Log level set to %s", level)
    return JSONResponse({"ok": True, "level": logging_config.current_level()})


@app.post("/api/logs/reveal")
async def reveal_log_folder():
    """Best-effort: open the log folder in the OS file manager. Always 200."""
    path = logging_config.log_file_path()
    folder = str(Path(path).parent)
    try:
        Path(folder).mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            argv = ["explorer", folder]
        elif sys.platform == "darwin":
            argv = ["open", folder]
        else:
            argv = ["xdg-open", folder]
        # List argv, never shell=True.
        subprocess.Popen(argv)
    except (OSError, ValueError) as e:
        logger.warning("Failed to reveal log folder %s", folder, exc_info=True)
        return JSONResponse({"ok": False, "path": path, "error": str(e)})
    return JSONResponse({"ok": True, "path": path})


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

# Raw COCKPIT_MANAGED_VLLM, or None when the operator did NOT set it. The
# "unset" case has to stay distinguishable from an explicit "0", because the
# stored setting (providers.vllm.managed) is only consulted when no env var
# speaks — see _vllm_managed_intent below.
COCKPIT_MANAGED_VLLM = os.getenv("COCKPIT_MANAGED_VLLM")
COCKPIT_VLLM_PORT = os.getenv("COCKPIT_VLLM_PORT", "8001")
COCKPIT_VLLM_MODEL = os.getenv("COCKPIT_VLLM_MODEL", "/models/Qwen3-Coder-30B-A3B-AWQ")
COCKPIT_VLLM_SERVED_NAME = os.getenv("COCKPIT_VLLM_SERVED_NAME", "qwen3-coder-30b-awq")
COCKPIT_VLLM_IMAGE = os.getenv("COCKPIT_VLLM_IMAGE", "vllm/vllm-openai:latest")
COCKPIT_VLLM_GPU_UUID = os.getenv("COCKPIT_VLLM_GPU_UUID", "")
COCKPIT_VLLM_MODELS_DIR = os.getenv("COCKPIT_VLLM_MODELS_DIR", "")
# Runtime-settable mirror of COCKPIT_VLLM_MODELS_DIR — seeded from the env var
# above, but overridable at runtime via PUT /api/local/{id}/models-dir and
# persisted to survive restart (see _load_vllm_models_dir/_save_vllm_models_dir
# below). This is the HOST path Cockpit scans on disk. The vLLM container only
# ever sees it bind-mounted at /models (see _vllm_docker_argv), so any model id
# reported for restart purposes must be expressed as "/models/<name>" — the
# CONTAINER path — while the host path stays around for display only.
_vllm_models_dir = COCKPIT_VLLM_MODELS_DIR
# SCAN path above (what Python enumerates -- see _scan_vllm_models_dir).
# MOUNT path below (what docker's -v receives -- see _vllm_docker_argv). On
# POSIX these are always identical; on Windows+WSL they diverge (see
# _derive_models_dir_paths). RAW below is the exact string the user typed,
# kept for display/persistence/re-derivation at startup.
_vllm_models_dir_mount = COCKPIT_VLLM_MODELS_DIR
_vllm_models_dir_raw = COCKPIT_VLLM_MODELS_DIR
COCKPIT_VLLM_MAX_MODEL_LEN = os.getenv("COCKPIT_VLLM_MAX_MODEL_LEN", "49152")
COCKPIT_VLLM_MAX_NUM_SEQS = os.getenv("COCKPIT_VLLM_MAX_NUM_SEQS", "2")
COCKPIT_VLLM_GPU_UTIL = os.getenv("COCKPIT_VLLM_GPU_UTIL", "0.90")
COCKPIT_VLLM_TOOL_PARSER = os.getenv("COCKPIT_VLLM_TOOL_PARSER", "qwen3_coder")
_VLLM_URL = "http://127.0.0.1:" + COCKPIT_VLLM_PORT

# The direct-to-vLLM provider, kept as a named constant rather than inlined
# below because it can be DEREGISTERED at startup (see
# _retire_vllm_local_if_unused) and re-registered by anyone who declares a
# direct vLLM. Popping it out of _PROVIDERS must not destroy its definition.
_VLLM_LOCAL_PROVIDER = {
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
    "capabilities": ["models", "health", "metrics", "model-discovery"],
}

_PROVIDERS = {
    "lmstudio-local": {
        "id": "lmstudio-local", "label": "LM Studio (local)", "kind": "lmstudio",
        "scope": "local",
        "broker_url": os.getenv("COCKPIT_BROKER_URL", "http://127.0.0.1:1235").rstrip("/"),
        "management_url": os.getenv("COCKPIT_LMSTUDIO_URL", "http://127.0.0.1:1234").rstrip("/"),
        "auth": {"type": "none"},
        "capabilities": ["queue", "metrics", "spill", "models", "traces", "health"],
    },
    "vllm-local": _VLLM_LOCAL_PROVIDER,
    "plexar-vllm": {
        "id": "plexar-vllm", "label": "Plexar-vLLM", "kind": "plexar",
        "scope": "local",
        # Plexar is a FIXED-BIND gateway in front of one or more vLLM
        # containers: the address never changes, model swaps and restarts
        # happen behind it, and a not-ready engine answers 503 + Retry-After
        # rather than ECONNREFUSED. So there is exactly one URL here and
        # Cockpit needs no changes when it goes multi-model — it just points at
        # the address and reads /v1/models.
        #
        # broker_url is set to the same address only because the field is
        # required by the registry shape; Plexar has NO broker in front of it
        # and must never be queue-probed (see get_provider_health). That is
        # what omitting the "queue" capability means.
        "broker_url": os.getenv("COCKPIT_PLEXAR_URL", "http://127.0.0.1:8760").rstrip("/"),
        "management_url": os.getenv("COCKPIT_PLEXAR_URL", "http://127.0.0.1:8760").rstrip("/"),
        # TWO INDEPENDENT credential layers, and neither substitutes for the
        # other (see plexar_client.auth_headers):
        #   * Cloudflare Access service token — gets past the tunnel, and no
        #     further. NOT authentication for Plexar.
        #   * Plexar bearer — the actual identity.
        # Both are empty for the local-loopback case, which needs no credential
        # at all and is the default. As of 2026-07-31 a REMOTE Plexar gates
        # /api/* too, not just /v1/*: leaving the control plane open meant every
        # tunnel guest could delete instances. So a remote target without
        # COCKPIT_PLEXAR_KEY now 401s, and that is the breaking change.
        # Like every other provider secret, these never reach the browser.
        "auth": {
            "type": "bearer",
            "bearer": os.getenv("COCKPIT_PLEXAR_KEY", ""),
            "cf_client_id": os.getenv("COCKPIT_PLEXAR_CF_CLIENT_ID", ""),
            "cf_client_secret": os.getenv("COCKPIT_PLEXAR_CF_CLIENT_SECRET", ""),
        },
        # "model-control" was correctly ABSENT while Plexar owned lifecycle and
        # exposed no way to drive it -- offering a button Cockpit could not
        # honour is the false-advertising bug the vLLM entry documents. Plexar
        # added POST /api/instances/{id}/{load,unload} on 2026-07-31, so the
        # capability is now a promise Cockpit can actually keep. Note this is
        # load/unload only: RESTART stays Plexar's, because Cockpit still does
        # not own those containers.
        # "instances" / "reports" / "gpus" are Plexar-shaped reads that no other
        # provider serves. Cockpit KEEPS its own reporting; these are a second
        # source beside it, never a replacement -- and every Plexar figure
        # carries its own source label so the two are never silently merged.
        # "timeseries" is bucketed HISTORY, which "reports" (window totals)
        # structurally cannot provide -- so it is a separate promise, not an
        # implied part of the reporting one.
        "capabilities": ["models", "health", "instances", "reports", "gpus",
                         "timeseries", "model-control", "identity"],
    },
}
_DEFAULT_PROVIDER = "lmstudio-local"

# A capability is a PROMISE that the matching route will accept the call. Both
# model-control providers therefore advertise it conditionally:
#
#   LM Studio — load/unload runs through its `lms` CLI. No CLI on PATH (common
#   in a packaged sidecar) → no "model-control", so the UI hides the buttons
#   instead of offering a control that would always fail.
#
#   vLLM — there is no hot-swap API (one model per process, fixed by --model at
#   launch), so the only mechanism is restarting the process. Cockpit can only
#   do that for a container IT owns, i.e. the configured intent is on
#   (COCKPIT_MANAGED_VLLM=1, else settings.json providers.vllm.managed) AND the
#   double-bind guard did not hand ownership to an external process. When vLLM
#   is external (the default — neither source opts in), advertising
#   "model-control" was unconditional false advertising: the UI showed a
#   Restart/Swap button and the route answered 409 every single time.
_LMS_CLI = shutil.which("lms")
if _LMS_CLI:
    _PROVIDERS["lmstudio-local"]["capabilities"].append("model-control")


# Memoized providers.vllm.managed, resolved from settings.json AT MOST ONCE per
# process. The memo is not an optimisation, it is the semantics: the container
# is launched during startup, so the only honest moment to read the stored
# intent is startup. Re-reading it live would let a Settings save flip
# _vllm_is_managed() mid-process, which would (a) make the "model-control"
# capability list disagree with reality — nothing re-runs
# _refresh_vllm_model_control() on a settings write — and (b) advertise a
# restart for a container Cockpit never started. Freezing it keeps effective
# ownership changeable at exactly two moments, both of which already refresh the
# capability list: import and the startup double-bind probe.
#
# None = not resolved yet. _reset_vllm_managed_cache() exists for tests.
_VLLM_MANAGED_SETTING: bool | None = None


def _reset_vllm_managed_cache() -> None:
    """Drop the memoized settings.json intent (tests; never called at runtime)."""
    global _VLLM_MANAGED_SETTING
    _VLLM_MANAGED_SETTING = None


def _vllm_managed_setting(*, live: bool = False) -> bool:
    """providers.vllm.managed from settings.json.

    Read LAZILY (never at import of settings_store's data) and memoized, so the
    file is touched once. `live=True` bypasses the memo — used only by the
    ownership surface, which has to be able to say "you changed this and it has
    not taken effect yet".
    """
    global _VLLM_MANAGED_SETTING
    if live or _VLLM_MANAGED_SETTING is None:
        try:
            value = bool(
                settings_store.read_settings()
                .get("providers", {})
                .get("vllm", {})
                .get("managed", False)
            )
        except Exception:
            logger.warning("Could not read providers.vllm.managed; assuming off", exc_info=True)
            value = False
        if live:
            return value
        _VLLM_MANAGED_SETTING = value
    return _VLLM_MANAGED_SETTING


def _vllm_managed_intent(*, live: bool = False) -> bool:
    """The CONFIGURED intent to have Cockpit own vLLM — precedence, in order:

      1. COCKPIT_MANAGED_VLLM, when explicitly set (any non-empty value): it
         wins outright. An operator who exports the variable means it, and it is
         what CI/headless runs use — so "0" in the env is a hard off even with
         the toggle on, and "1" is a hard on even with the toggle off.
      2. Otherwise providers.vllm.managed from settings.json (the Settings ▸
         Providers ▸ vLLM toggle).

    Intent only. Whether Cockpit ACTUALLY owns the process is _vllm_is_managed(),
    which additionally defers to an external server holding the port.
    """
    if COCKPIT_MANAGED_VLLM:
        return COCKPIT_MANAGED_VLLM == "1"
    return _vllm_managed_setting(live=live)


def _vllm_is_managed() -> bool:
    """True when Cockpit owns the vLLM process's lifecycle.

    Two conditions, both required:
      * the configured intent is on — _vllm_managed_intent(): COCKPIT_MANAGED_VLLM
        when explicitly set, else settings.json's providers.vllm.managed. Both
        are read through module state so tests, the capability refresh and the
        restart route all see the same answer.
      * the startup double-bind guard did not find something already answering
        on the vLLM port. `start_managed_vllm` records that verdict in
        _MANAGED_VLLM["external"]; with the intent on but an external server
        already up, Cockpit is a pure observer and must not claim otherwise.
        This guard overrides BOTH config sources — it is the only one that
        reflects what is actually running.

    Single source of truth for the "model-control" capability, the `managed`
    flag on GET /api/local/providers, and the restart route's refusal.
    """
    if not _vllm_managed_intent():
        return False
    return not _MANAGED_VLLM.get("external", False)


def _vllm_ownership() -> dict:
    """Who owns vLLM right now, and whether the user is waiting on a restart.

    Three states the UI must be able to tell apart:
      * external — something else answers on the vLLM port. Turning the toggle
        on changes NOTHING until that process stops; a Cockpit restart will not
        help, so pending_restart is False.
      * pending_restart — the configured intent (live from env/settings.json)
        disagrees with what this process resolved at startup. The container is
        launched during startup, so the save is real but dormant.
      * settled — configured and effective agree.
    """
    external = bool(_MANAGED_VLLM.get("external", False))
    effective = _vllm_is_managed()
    configured = _vllm_managed_intent(live=True)
    source = "external" if external else ("env" if COCKPIT_MANAGED_VLLM else "settings")
    pending = (not external) and (configured != effective)
    if external:
        reason = (
            "An external vLLM is already answering on this port, so Cockpit defers to it "
            "and will keep doing so until that process stops. Restarting Cockpit will not "
            "change this."
        )
    elif pending and configured:
        reason = (
            "Saved. Cockpit starts the vLLM container during startup, so this takes effect "
            "the next time Cockpit restarts."
        )
    elif pending:
        reason = (
            "Saved. Cockpit still owns the container it started; it is released the next "
            "time Cockpit restarts."
        )
    elif effective:
        reason = "Cockpit owns this vLLM container."
    else:
        reason = "vLLM is external — start and stop it where you started it."
    return {
        "effective": effective,
        "configured": configured,
        "external": external,
        "source": source,
        "pending_restart": pending,
        "requires_restart": pending,
        "env_set": bool(COCKPIT_MANAGED_VLLM),
        "reason": reason,
    }


@app.get("/api/local/vllm/ownership")
async def get_vllm_ownership():
    """Ownership of the local vLLM process — see _vllm_ownership. Always 200."""
    return JSONResponse(_vllm_ownership())


# ── Retiring `vllm-local` (2026-07-31) ───────────────────
#
# `vllm-local` points DIRECT at a vLLM container on COCKPIT_VLLM_PORT. Plexar
# now owns vLLM lifecycle and publishes its containers loopback-only on a port
# it allocates itself, reachable ONLY through its gateway — deliberately, so
# nothing can bypass the gateway's auth, its request records, or the in-flight
# accounting a drain waits on. So for a Plexar-managed engine the direct path
# is not merely unused, it is structurally impossible to recreate.
#
# `vllm-local` and `plexar` are therefore NOT two views of one engine (which
# would argue for deduping them). One is the current architecture and the other
# is the thing it replaced. Left registered, it is a permanently unreachable
# provider row — and a red row that is always red teaches people to ignore red
# rows, which is the same argument the reporting honesty rules make.
#
# It is DEREGISTERED, not deleted: the managed-container lifecycle, the
# Prometheus adapter and the restart path all still work, and anyone genuinely
# running a direct vLLM keeps them by declaring so. Two ways back:
#   * managed intent on (COCKPIT_MANAGED_VLLM=1 / providers.vllm.managed) —
#     Cockpit launches that container itself, so the provider MUST exist;
#   * COCKPIT_VLLM_DIRECT=1 — an external direct vLLM that Cockpit does not own.
# Deleting the machinery outright is a separate, larger decision and is not
# taken here.
COCKPIT_VLLM_DIRECT = os.getenv("COCKPIT_VLLM_DIRECT", "")


def _register_vllm_local() -> None:
    """Put the direct-vLLM provider back. Idempotent."""
    _PROVIDERS.setdefault("vllm-local", _VLLM_LOCAL_PROVIDER)


def _retire_vllm_local_if_unused() -> None:
    """Drop the direct-vLLM provider unless someone actually declared one."""
    if COCKPIT_VLLM_DIRECT == "1" or _vllm_managed_intent():
        return _register_vllm_local()
    if _PROVIDERS.pop("vllm-local", None) is not None:
        logger.info(
            "vllm-local not registered: no direct vLLM declared "
            "(set COCKPIT_VLLM_DIRECT=1 to keep it). Plexar serves vLLM."
        )


_retire_vllm_local_if_unused()


def _refresh_vllm_model_control() -> None:
    """Sync vllm-local's "model-control" capability with _vllm_is_managed().

    Called at import and again after the managed-vLLM start attempt, because
    the double-bind guard can only resolve ownership once it has probed the
    port. Idempotent.
    """
    provider = _PROVIDERS.get("vllm-local")
    if provider is None:
        return
    caps = provider["capabilities"]
    if _vllm_is_managed():
        if "model-control" not in caps:
            caps.append("model-control")
    elif "model-control" in caps:
        caps.remove("model-control")

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


# ── Configurable vLLM models directory (persisted) ────────
#
# Operator-facing config, same trust level as COCKPIT_PROVIDERS_FILE, but the
# HTTP setter still validates every path from the browser (see
# set_vllm_models_dir) since it drives a filesystem scan. Persisted beside the
# provider-endpoints file above.
_VLLM_MODELS_DIR_FILE = os.path.join(
    os.path.expanduser("~"), ".claude-cockpit", "vllm-models-dir.json"
)
_VLLM_MODELS_DIR_MAX_LEN = 4096


def _load_vllm_models_dir() -> str:
    """Read the persisted host models-dir path. Returns "" on missing/parse error."""
    try:
        with open(_VLLM_MODELS_DIR_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        path = data.get("path") if isinstance(data, dict) else None
        return path if isinstance(path, str) else ""
    except FileNotFoundError:
        logger.debug("No vllm-models-dir.json at %s", _VLLM_MODELS_DIR_FILE)
        return ""
    except Exception:
        logger.warning(
            "Failed to read %s; ignoring persisted models dir",
            _VLLM_MODELS_DIR_FILE,
            exc_info=True,
        )
        return ""


def _save_vllm_models_dir(path: str) -> None:
    """Best-effort write of the models-dir path. Never raises."""
    try:
        os.makedirs(os.path.dirname(_VLLM_MODELS_DIR_FILE), exist_ok=True)
        with open(_VLLM_MODELS_DIR_FILE, "w", encoding="utf-8") as f:
            json.dump({"path": path}, f, indent=2)
    except Exception:
        logger.error(
            "Failed to persist vLLM models dir to %s",
            _VLLM_MODELS_DIR_FILE,
            exc_info=True,
        )


def apply_persisted_vllm_models_dir() -> None:
    """Override _vllm_models_dir from the persisted config at startup.

    Re-validates the persisted path the same way the PUT route does — a bad or
    stale config file must never block startup, and a path that has since
    disappeared/changed type on disk must not be silently trusted.
    """
    global _vllm_models_dir, _vllm_models_dir_mount, _vllm_models_dir_raw

    persisted = _load_vllm_models_dir()
    if not persisted:
        return
    ok, _error, mount_path, scan_path = _validate_models_dir(persisted)
    if not ok:
        logger.warning("ignoring unsafe/stale persisted vLLM models dir: %s", persisted)
        return
    _vllm_models_dir = scan_path
    _vllm_models_dir_mount = mount_path
    _vllm_models_dir_raw = persisted
    logger.info(
        "Applied persisted vLLM models dir: raw=%s mount=%s scan=%s",
        persisted, mount_path, scan_path,
    )


_QUANT_HINTS = ("awq", "gptq", "int4", "int8", "fp8", "q4", "q8")


def _sniff_quantization(name: str) -> str | None:
    """Best-effort quantization guess from a model directory name. None if unknown."""
    lowered = name.lower()
    for hint in _QUANT_HINTS:
        if hint in lowered:
            return hint
    return None


_WSL_DISTRO_CACHE: dict[str, str | None] = {}


def _detect_wsl_distro() -> str | None:
    """Best-effort default WSL distro name via `wsl -l -q`, cached after the
    first call (successful or not -- a failure here is almost certainly
    environmental, i.e. WSL not installed, and retrying every request just
    adds latency).

    Returns None on any failure (WSL missing, timeout, unparsable output);
    callers must degrade gracefully rather than rejecting the models-dir path
    outright -- the docker bind-mount may still work even if Cockpit can't
    enumerate it from Windows.
    """
    if "name" in _WSL_DISTRO_CACHE:
        return _WSL_DISTRO_CACHE["name"]
    name = None
    try:
        result = subprocess.run(
            ["wsl", "-l", "-q"], capture_output=True, timeout=5,
        )
        raw = result.stdout or b""
        for encoding in ("utf-16-le", "utf-8"):
            try:
                text = raw.decode(encoding)
            except Exception:
                continue
            lines = [ln.strip().strip("\x00") for ln in text.splitlines()]
            lines = [ln for ln in lines if ln]
            if lines:
                name = lines[0]
                break
    except Exception:
        logger.debug("WSL distro detection failed", exc_info=True)
        name = None
    _WSL_DISTRO_CACHE["name"] = name
    return name


def _derive_models_dir_paths(raw_path: str) -> tuple[str, str]:
    """Return (mount_path, scan_path) for a models-dir input.

    docker (via _vllm_docker_argv) runs INSIDE WSL on Windows, so the bind
    mount source must be a WSL/Linux-style path; Python (running natively on
    Windows) needs a Windows-visible path to enumerate. On POSIX platforms
    there is no split -- both are the raw path, unchanged from before.

    Two accepted input shapes on Windows:
      - WSL/POSIX-style ("/home/lenbo/models"): this already IS the mount
        path docker needs. The scan path is derived as the UNC form
        \\\\wsl$\\<distro>\\home\\lenbo\\models (verified listable from
        Windows Explorer/Python) using the default WSL distro name.
      - Windows-style ("C:\\models"): this already IS the scan path. The
        mount path is derived as /mnt/c/models (lowercase drive letter),
        the standard WSL mapping into a Windows drive.
    """
    if sys.platform != "win32":
        return raw_path, raw_path

    if raw_path.startswith("/"):
        mount_path = raw_path
        distro = _detect_wsl_distro()
        if distro is None:
            scan_path = ""  # undeterminable -- caller treats as unscannable
        else:
            scan_path = f"\\\\wsl$\\{distro}" + raw_path.replace("/", "\\")
        return mount_path, scan_path

    # Windows-style: "C:\models\sub" -> "/mnt/c/models/sub"
    drive, _, rest = raw_path.partition(":")
    mount_path = "/mnt/" + drive.lower() + rest.replace("\\", "/")
    return mount_path, raw_path


def _validate_models_dir(raw_path: str) -> tuple[bool, str | None, str | None, str | None]:
    """Validate a browser-supplied filesystem path for the vLLM models dir.

    Returns (ok, error_message, mount_path, scan_path). This is a filesystem
    path coming straight from the browser, so it is validated defensively
    even though it is operator-facing config:
      - must be a non-empty string, under _VLLM_MODELS_DIR_MAX_LEN chars
      - must not contain a NUL byte
      - must be an ABSOLUTE path (WSL/POSIX-style OR Windows-style on
        win32; POSIX-absolute only on POSIX platforms)
      - the SCAN path (see _derive_models_dir_paths) is resolved
        (Path.resolve()) and re-checked as an existing directory -- closes
        off traversal games where the pre-resolve string looks fine but
        resolves somewhere else entirely. EXCEPTION: a WSL-style path whose
        distro can't be detected is accepted anyway with an empty scan path
        -- the mount may still be valid even though Cockpit can't verify it.
    """
    if not isinstance(raw_path, str) or not raw_path:
        return False, "path must be a non-empty string", None, None
    if len(raw_path) > _VLLM_MODELS_DIR_MAX_LEN:
        return False, f"path must be at most {_VLLM_MODELS_DIR_MAX_LEN} characters", None, None
    if "\x00" in raw_path:
        return False, "path must not contain a NUL byte", None, None

    if sys.platform == "win32":
        is_wsl_style = raw_path.startswith("/")
        is_windows_style = Path(raw_path).is_absolute()  # drive-letter or UNC
        if not (is_wsl_style or is_windows_style):
            return False, "path must be absolute", None, None

        mount_path, scan_path = _derive_models_dir_paths(raw_path)

        if is_wsl_style and not scan_path:
            return True, None, mount_path, ""

        try:
            resolved = Path(scan_path).resolve(strict=False)
        except Exception:
            logger.debug("Failed to resolve models dir %r", scan_path, exc_info=True)
            return False, "path could not be resolved", None, None
        if not resolved.is_dir():
            return False, "path does not exist or is not a directory", None, None
        # For WSL-style input, mount_path is kept exactly as typed (it's
        # already docker-ready); only the scan side gets resolved. For
        # Windows-style input, mount_path was derived from the raw string,
        # and the scan side is the resolved Windows path.
        return True, None, mount_path, str(resolved)

    # POSIX: no WSL split -- mount and scan are the same resolved path,
    # exactly the pre-existing behavior.
    p = Path(raw_path)
    if not p.is_absolute():
        return False, "path must be absolute", None, None
    try:
        resolved = p.resolve(strict=False)
    except Exception:
        logger.debug("Failed to resolve models dir %r", raw_path, exc_info=True)
        return False, "path could not be resolved", None, None
    if not resolved.is_dir():
        return False, "path does not exist or is not a directory", None, None
    return True, None, str(resolved), str(resolved)


def _scan_vllm_models_dir() -> list[dict]:
    """Best-effort scan of _vllm_models_dir's immediate subdirectories.

    Each entry that looks like a model directory (contains config.json, or --
    failing that -- is simply any subdirectory) becomes a disk-only catalog
    entry. Never raises; an unreadable/unset dir yields [].

    The "id" is the CONTAINER path ("/models/<name>") since that's what a
    vLLM --model restart arg needs (see _vllm_docker_argv's bind mount); the
    "host_path" is the real path on disk, kept around for display only.
    """
    if not _vllm_models_dir:
        return []
    try:
        base = Path(_vllm_models_dir)
        if not base.is_dir():
            return []
        entries = []
        for child in sorted(base.iterdir()):
            if not child.is_dir():
                continue
            entries.append({
                "id": f"/models/{child.name}",
                "name": child.name,
                "host_path": str(child),
                "state": "available",
                "quantization": _sniff_quantization(child.name),
                "arch": None,
                "max_context_length": None,
                # Disk-scanned entries already ARE the container path (the
                # scanner computes it as "/models/<name>") -- same value as
                # "id", included for shape consistency with served entries.
                "container_path": f"/models/{child.name}",
            })
        return entries
    except Exception:
        logger.debug("Failed to scan vLLM models dir %s", _vllm_models_dir, exc_info=True)
        return []


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


def _provider_managed(p: dict) -> bool:
    """True when Cockpit owns this provider's service lifecycle.

    Resolved from the SAME determination each subsystem already uses, never a
    second guess:
      * broker-fronted providers (the vendored lane broker, i.e. a local
        provider whose broker_url is the configured broker URL) →
        _broker_is_managed(), the same call GET /api/local/status reports.
      * vLLM → _vllm_is_managed(), the same call that gates the
        "model-control" capability and the restart route's refusal.
    Everything else (remote scope, a provider from COCKPIT_PROVIDERS_FILE
    pointing at somebody else's server) is external by definition.

    A boolean only — no URL, no auth. The UI uses it to EXPLAIN ("external
    process — restart it where you started it") instead of guessing.
    """
    if p.get("scope") != "local":
        return False
    if p.get("kind") == "vllm":
        return _vllm_is_managed()
    if p.get("broker_url") == _LOCAL_BROKER_URL:
        return _broker_is_managed()
    return False


@app.get("/api/local/providers")
async def get_local_providers():
    """List registered providers -- full URLs and auth are never sent to the
    browser; local providers carry a display-only host:port endpoint_hint and a
    `managed` boolean saying whether Cockpit owns that service's lifecycle."""
    return JSONResponse({
        "providers": [
            {
                "id": p["id"],
                "label": p["label"],
                "kind": p["kind"],
                "scope": p["scope"],
                "capabilities": p["capabilities"],
                "endpoint_hint": _endpoint_hint(p),
                "managed": _provider_managed(p),
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
    # THE CREDENTIAL BELONGS HERE TOO. This helper predates any authenticated
    # provider and sent only an Accept header, so every route through it
    # (/models, /health) reached an authenticated Plexar anonymously, got a
    # 401, and reported a healthy engine as UNREACHABLE — while /identity,
    # which goes via plexar_client, authenticated fine. The two disagreeing was
    # the symptom.
    #
    # auth_headers is reused rather than reimplemented so the both-or-neither
    # rule for the Cloudflare pair holds on this path as well; a provider with
    # no auth block gets exactly the old headers back.
    req = urllib.request.Request(
        url, headers=plexar_client.auth_headers(provider.get("auth"))
    )
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

    # Live in-engine queue depth + KV headroom (vLLM's own continuous-batching
    # state -- NOT the broker's lane queue). running = decoding now; waiting =
    # admitted-but-parked (no free KV slot). kv_cache_max_concurrency is how many
    # FULL max_model_len contexts the KV can hold at once -- the real swarm limit.
    kv_pct_samples = s.get("vllm:kv_cache_usage_perc", [])
    kv_pct = round(kv_pct_samples[0][1] * 100, 1) if kv_pct_samples else None
    kv_tokens = None
    max_conc = None
    cfg = s.get("vllm:cache_config_info", [])
    if cfg:
        cfg_labels = cfg[0][0]
        _tok = cfg_labels.get("kv_cache_size_tokens", "")
        if _tok.isdigit():
            kv_tokens = int(_tok)
        try:
            max_conc = round(float(cfg_labels.get("kv_cache_max_concurrency")), 2)
        except (TypeError, ValueError):
            max_conc = None
    engine = {
        "running": int(_sum("vllm:num_requests_running")),
        "waiting": int(_sum("vllm:num_requests_waiting")),
        "kv_cache_pct": kv_pct,
        "kv_cache_tokens": kv_tokens,
        "max_concurrency": max_conc,
    }

    # Per-request context sizes (for worker-card tuning): how big are the prompts
    # we actually send (IN) and the completions we actually get (OUT). avg is
    # exact (sum/count); p95 is the histogram's practical-max (coarse at the top
    # bucket, so a floor). model ceiling comes from /v1/models via the caller.
    def _avg(base):
        tot, cnt = _hist_sum_count(s, base)
        return int(round(tot / cnt)) if cnt else None

    def _p95_tokens(base):
        v = _hist_quantile(s, base, 0.95)
        return int(round(v)) if v is not None else None

    context = {
        "in": {"avg": _avg("vllm:request_prompt_tokens"), "p95": _p95_tokens("vllm:request_prompt_tokens")},
        "out": {"avg": _avg("vllm:request_generation_tokens"), "p95": _p95_tokens("vllm:request_generation_tokens")},
        "model_max": None,  # filled by the caller from /v1/models (ceiling)
    }

    return {
        "window": window,
        "engine": engine,
        "context": context,
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


def _vllm_offline_snapshot() -> dict | None:
    """When vLLM is DOWN, build a metrics dict from the persisted rollup alone so
    the backend still appears in reports (marked stale) instead of vanishing —
    the user swaps LM Studio <-> vLLM on one GPU, and the idle one must not drop
    off the report. Returns None when there is no persisted history to show.

    Live-only fields (engine/latency/decode) are null: they're unknown while the
    engine is off. Cumulative counters come from carried + last-seen raw.
    """
    rollup = _load_vllm_rollup()
    eff = _vllm_effective({"runs": 0, "prompt": 0, "completion": 0}, rollup)
    if eff["runs"] <= 0:
        return None
    return {
        "reachable": True, "stale": True, "source": "vllm-persisted",
        "note": "vLLM is offline; showing persisted lifetime totals.",
        "window": "lifetime", "window_exact": True, "persisted": True,
        "runs_total": eff["runs"], "prompts_total": eff["runs"],
        "tokens_total": {"prompt": eff["prompt"], "completion": eff["completion"]},
        "tokens_per_sec": {"current": None, "avg": None},
        "decode_tokens_per_sec": {"current": None, "avg": None, "p50": None},
        "ttft_ms": {"p50": None, "p95": None},
        "queue_wait_ms": {"p50": None, "p95": None},
        "run_time_ms": {"p50": None, "p95": None},
        "engine": None, "context": None,
        "by_session": [], "by_agent": [], "by_lane_class": [],
    }


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


# ── Self-contained fleet history (no Prometheus/Grafana needed) ──
#
# Cockpit is already the metrics hub; it samples EVERY provider to a local JSONL
# time-series so the in-app History view can be derived from Cockpit alone. One
# line per provider per tick. Age-capped so the file can't grow unbounded.

_FLEET_LOG = os.path.join(os.path.expanduser("~"), ".claude-cockpit", "fleet-metrics.jsonl")
_FLEET_INTERVAL = float(os.getenv("COCKPIT_FLEET_SAMPLE_INTERVAL", "60"))
_FLEET_RETENTION_S = float(os.getenv("COCKPIT_FLEET_RETENTION_S", str(45 * 86400)))  # ~45 days
_FLEET_MAX_LINES = 200_000
# History metric key -> record field. Curated set the History view charts.
_FLEET_METRICS = {
    "throughput_tps": "tps",
    "decode_tps": "decode",
    "queue_depth": "queue_depth",
    "running": "running",
    "waiting": "waiting",
    "kv_cache_pct": "kv",
    "ttft_p95_seconds": "ttft_p95",
    "run_time_p95_seconds": "run_time_p95",
    "prompt_tokens_p95": "prompt_p95",
    "completion_tokens_p95": "completion_p95",
    "runs_total": "runs",
}
_FLEET_WINDOW_S = {"session": 3600, "24h": 86400, "7d": 604800, "lifetime": 2592000}


def _fleet_record(provider: dict, snap: dict, ts: int) -> dict:
    """Flatten one provider snapshot into a compact time-series record."""
    m = snap.get("metrics") if isinstance(snap.get("metrics"), dict) else {}
    m = m if (m and m.get("reachable") is not False) else {}
    tps = (m.get("tokens_per_sec") or {})
    dec = (m.get("decode_tokens_per_sec") or {})
    ttft = (m.get("ttft_ms") or {})
    rt = (m.get("run_time_ms") or {})
    eng = (m.get("engine") or {})
    ctx = (m.get("context") or {})
    cin = (ctx.get("in") or {})
    cout = (ctx.get("out") or {})
    q = snap.get("queue") if isinstance(snap.get("queue"), dict) else {}
    qdepth = None
    if q and q.get("reachable") is not False:
        qdepth = (1 if q.get("in_flight") else 0) + (len(q["queued"]) if isinstance(q.get("queued"), list) else 0)

    def _s(v):  # ms -> seconds
        return round(v / 1000, 3) if isinstance(v, (int, float)) else None

    return {
        "ts": ts, "provider": provider["id"], "kind": provider.get("kind", ""),
        "up": bool(snap.get("up")),
        "runs": m.get("runs_total"),
        "tps": tps.get("avg") if tps.get("avg") is not None else tps.get("current"),
        "decode": dec.get("avg") if dec.get("avg") is not None else dec.get("current"),
        "queue_depth": qdepth if qdepth is not None else eng.get("waiting"),
        "running": eng.get("running"),
        "waiting": eng.get("waiting"),
        "kv": eng.get("kv_cache_pct"),
        "ttft_p95": _s(ttft.get("p95")),
        "run_time_p95": _s(rt.get("p95")),
        "prompt_p95": cin.get("p95"),
        "completion_p95": cout.get("p95"),
    }


def _append_fleet_samples(records: list) -> None:
    """Append records + age/size-trim. Best-effort; never raises."""
    try:
        os.makedirs(os.path.dirname(_FLEET_LOG), exist_ok=True)
        with open(_FLEET_LOG, "a", encoding="utf-8") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        _trim_fleet_log()
    except Exception:
        logger.error("Failed to append fleet samples", exc_info=True)


def _trim_fleet_log() -> None:
    """Drop lines older than retention (and hard-cap total lines). Cheap-ish;
    only rewrites when over the line cap or the oldest line is stale."""
    try:
        with open(_FLEET_LOG, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        return
    if not lines:
        return
    cutoff = int(_time.time() - _FLEET_RETENTION_S)
    try:
        first_ts = json.loads(lines[0]).get("ts", 0)
    except Exception:
        first_ts = 0
    if len(lines) <= _FLEET_MAX_LINES and first_ts >= cutoff:
        return
    kept = []
    for ln in lines[-_FLEET_MAX_LINES:]:
        try:
            if json.loads(ln).get("ts", 0) >= cutoff:
                kept.append(ln)
        except Exception:
            continue
    try:
        with open(_FLEET_LOG, "w", encoding="utf-8") as f:
            f.writelines(kept)
    except Exception:
        logger.error("Failed to trim fleet log", exc_info=True)


def _query_fleet_history(metric_field: str, provider: str, span_s: int, max_points: int = 240) -> dict:
    """Read the JSONL, filter to window + provider, return {provider: [[ts,v],...]}
    downsampled to <= max_points per series. Blocking; run via to_thread."""
    since = int(_time.time() - span_s)
    series: dict = {}
    try:
        with open(_FLEET_LOG, "r", encoding="utf-8") as f:
            for ln in f:
                try:
                    r = json.loads(ln)
                except Exception:
                    continue
                if r.get("ts", 0) < since:
                    continue
                if provider != "all" and r.get("provider") != provider:
                    continue
                v = r.get(metric_field)
                if not isinstance(v, (int, float)):
                    continue
                series.setdefault(r.get("provider", "?"), {"kind": r.get("kind", ""), "points": []})
                series[r["provider"]]["points"].append([r["ts"], v])
    except FileNotFoundError:
        return {}
    # downsample each series by striding
    for s in series.values():
        pts = s["points"]
        if len(pts) > max_points:
            stride = len(pts) // max_points + 1
            s["points"] = pts[::stride]
    return series


async def _fleet_history_loop() -> None:
    """Background: every _FLEET_INTERVAL, snapshot ALL providers to the JSONL
    time-series. Best-effort; the loop survives any per-tick failure."""
    while True:
        try:
            await asyncio.sleep(_FLEET_INTERVAL)
            providers = list(_PROVIDERS.values())
            snaps = await asyncio.gather(*[asyncio.to_thread(_provider_snapshot, p) for p in providers])
            ts = int(_time.time())
            records = [_fleet_record(p, s, ts) for p, s in zip(providers, snaps)]
            await asyncio.to_thread(_append_fleet_samples, records)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.debug("Fleet history sample skipped", exc_info=True)


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


def _broker_is_managed() -> bool:
    """True when Cockpit's own in-process broker task is the thing listening.

    The single determination behind both GET /api/local/status's `managed` flag
    and the `managed` flag for broker-fronted providers on
    GET /api/local/providers — the two must never be able to disagree.
    """
    task = _MANAGED_BROKER["task"]
    return task is not None and not task.done()


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
#
# "external": set True by start_managed_vllm's double-bind probe when something
# else already answers on the vLLM port. It starts False (nothing probed yet),
# and _vllm_is_managed() reads it — see that function for why ownership cannot
# be decided from the env var alone.
_MANAGED_VLLM = {"proc": None, "container": "cockpit-vllm", "external": False}

# Now that _MANAGED_VLLM exists, settle vllm-local's "model-control" capability
# for the default (pre-startup) state. start_managed_vllm calls this again once
# the double-bind probe has actually resolved ownership.
_refresh_vllm_model_control()

# The vLLM container bakes its model in as a launch arg (no hot-swap), so the
# active model is a runtime-mutable value seeded from the env default. The
# restart route (POST /api/local/vllm-local/restart) rewrites this after
# validating the incoming string, then stop→start cycles the container.
_vllm_runtime_model = COCKPIT_VLLM_MODEL

# A vLLM --model value becomes a discrete docker arg AND (on Windows) is joined
# into a `bash -lc "<string>"` shell command, so it is the sharp edge. Only
# model-path/tag characters are permitted — no spaces, no shell metacharacters —
# which makes the win32 shell-join inherently injection-safe.
_VLLM_MODEL_RE = re.compile(r"^[A-Za-z0-9._:/\-]{1,256}$")


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
        # MOUNT path (not scan path) -- docker itself runs inside WSL on
        # Windows (see the wrap below), so -v's source must be WSL/Linux-
        # style. See _derive_models_dir_paths.
        mount = f"-v {_vllm_models_dir_mount}:/models" if _vllm_models_dir_mount else ""
        gpu_pin = (
            f"-e CUDA_DEVICE_ORDER=PCI_BUS_ID -e CUDA_VISIBLE_DEVICES={COCKPIT_VLLM_GPU_UUID}"
            if COCKPIT_VLLM_GPU_UUID else ""
        )
        parts = [
            "docker", "run", "-d", "--rm", "--name", _MANAGED_VLLM["container"], "--ipc=host",
            "-p", f"{COCKPIT_VLLM_PORT}:8001", gpus, gpu_pin, mount,
            COCKPIT_VLLM_IMAGE,
            "--model", _vllm_runtime_model,
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

    Opt-in is the SAME determination the rest of the module uses
    (_vllm_managed_intent: env var when set, else settings.json) so the toggle
    the user flipped in Settings is what actually launches the container.
    """
    if not _vllm_managed_intent():
        return False
    if _MANAGED_VLLM["proc"] is not None:
        return True
    try:
        await asyncio.to_thread(_broker_get, "/v1/models", "", _VLLM_URL)
        logger.info("External vLLM already at %s — not spawning managed one", _VLLM_URL)
        # Ownership went to the external process: drop "model-control" so the UI
        # never offers a restart Cockpit is not entitled to perform.
        _MANAGED_VLLM["external"] = True
        _refresh_vllm_model_control()
        return False
    except Exception:
        pass  # nothing listening — ours to run

    _MANAGED_VLLM["external"] = False
    _refresh_vllm_model_control()

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
            _MANAGED_VLLM["container"], COCKPIT_VLLM_IMAGE, _vllm_runtime_model, COCKPIT_VLLM_PORT,
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
    return JSONResponse({**result, "url": _LOCAL_BROKER_URL, "managed": _broker_is_managed()})


# ── Provider-keyed local routes ───────────────────────────
#
# Thin wrappers around the same _broker_get/_broker_put/_mgmt_get machinery
# above, parameterized by a registered provider instead of the hard-coded
# _LOCAL_BROKER_URL. The legacy /api/local/{queue,metrics,spill} routes above
# stay as-is and keep working unchanged -- only the write-refusal/model/health/
# traces routes are new, all provider-keyed by construction.

_MODEL_FIELDS = ("id", "type", "arch", "quantization", "state",
                  "max_context_length", "loaded_context_length", "container_path",
                  # Plexar addresses load/unload by INSTANCE, not by model name:
                  # its catalog can list the same served name more than once.
                  # Null for every other backend.
                  "instance_id")


def _normalize_vllm_raw_model(m: dict) -> dict:
    """Map vLLM's native /v1/models shape onto the common model-fields shape.

    Ground-truth vLLM payload has no state/arch/quantization/max_context_length
    -- only id/root/max_model_len (root is the in-container model path, exactly
    what a restart's --model needs). LM Studio's /api/v0/models genuinely
    provides state/arch/quantization/context fields, so this function is only
    ever applied to vLLM upstream entries -- never touch the LM Studio path.
    """
    out = dict(m)

    # A model returned by vLLM's /v1/models IS being served, by definition --
    # vLLM has no concept of a "known but unloaded" model in that response.
    if out.get("state") is None:
        out["state"] = "loaded"

    max_model_len = m.get("max_model_len")
    if max_model_len is not None:
        # For vLLM the served context IS the loaded context (no separate
        # "loaded vs max" concept like LM Studio) -- but never overwrite a
        # genuine value if one is somehow already present.
        if out.get("max_context_length") is None:
            out["max_context_length"] = max_model_len
        if out.get("loaded_context_length") is None:
            out["loaded_context_length"] = max_model_len

    root = m.get("root")
    out["container_path"] = root

    if out.get("quantization") is None:
        sniff_source = root or m.get("id") or ""
        out["quantization"] = _sniff_quantization(sniff_source) if sniff_source else None

    return out


def _normalize_plexar_raw_model(m: dict) -> dict:
    """Map Plexar's /v1/models shape onto the common model-fields shape.

    Plexar synthesises an OpenAI-shaped catalog and hangs its state envelope
    off a ``plexar`` key rather than a top-level ``state``::

        {"id": "...", "plexar": {"state": "serving", "available": true,
                                 "reason": ..., "eta_seconds": ...}}

    Without this, every Plexar model rendered ``state: null`` — so the UI
    highlighted nothing and the catalog looked empty while an engine was
    actively serving.

    ``serving`` and ``degraded`` both map to "loaded" because both can take a
    request. Anything else (``loading``, ``stopped``, ``failed``) is NOT loaded
    and must not be dressed up as though it were — the point of Plexar's
    envelope is that "not ready" carries a reason instead of masquerading as
    either ready or absent.
    """
    out = dict(m)
    envelope = m.get("plexar")
    if isinstance(envelope, dict):
        state = envelope.get("state")
        out["state"] = "loaded" if state in ("serving", "degraded") else state
        # Keep the envelope's own words — a UI that wants to explain WHY a
        # model is not servable should not have to re-derive it.
        out["reason"] = envelope.get("reason")
        out["eta_seconds"] = envelope.get("eta_seconds")
        # Plexar's load/unload are keyed by INSTANCE, not by model name, and
        # the catalog can carry the same served name twice. Carrying the id
        # through is what lets a picker toggle a row without Cockpit guessing
        # which instance a name meant.
        out["instance_id"] = envelope.get("instance_id")

    if out.get("quantization") is None:
        sniff_source = m.get("id") or ""
        out["quantization"] = _sniff_quantization(sniff_source) if sniff_source else None

    return out


def _plexar_config() -> tuple[str, dict]:
    """Resolve Plexar's URL and auth at CALL time, not at import.

    The key can be set from Settings, and a value read once at import would
    mean a freshly-entered key does nothing until the app is restarted -- which
    reads as "the key does not work". Precedence matches every other provider
    key: a UI-configured value beats the environment variable.
    """
    stored_url = ""
    try:
        stored_url = (settings_store.read_settings()
                      .get("providers", {}).get("plexar", {}).get("base_url") or "")
    except Exception:
        logger.warning("Could not read the stored Plexar URL", exc_info=True)

    url = (stored_url or os.getenv("COCKPIT_PLEXAR_URL")
           or "http://127.0.0.1:8760").rstrip("/")

    key = None
    try:
        key, _source = settings_store.resolve_provider_key("plexar")
    except Exception:
        logger.warning("Could not resolve the Plexar key", exc_info=True)

    return url, {
        "type": "bearer",
        "bearer": key or "",
        # Cloudflare Access is being retired in favour of the tunnel alone. The
        # pair stays supported because half a service token must still never be
        # sent, and a deployment that has not migrated yet keeps working.
        "cf_client_id": os.getenv("COCKPIT_PLEXAR_CF_CLIENT_ID", ""),
        "cf_client_secret": os.getenv("COCKPIT_PLEXAR_CF_CLIENT_SECRET", ""),
    }


def _require_provider(provider_id: str):
    """Look up a provider by id, or None if unknown.

    Plexar's URL and credential are refreshed here rather than baked in at
    import, so this is the ONE place every route picks them up.
    """
    provider = _PROVIDERS.get(provider_id)
    if provider is not None and provider.get("kind") == "plexar":
        url, auth = _plexar_config()
        provider["broker_url"] = url
        provider["management_url"] = url
        provider["auth"] = auth
    return provider


# ── Tier 2: local-provider ANTHROPIC_BASE_URL resolution ──
#
# Seam for pty_manager's provider="local" launch path. The browser only ever
# sends a provider id + model name (never a URL) — same SSRF stance as the
# rest of this registry. pty_manager.create_terminal() lazy-imports this
# module (server.py already imports pty_manager, so importing server from
# pty_manager at module scope would be circular) and calls this function to
# turn a local provider id into the base URL the spawned `claude` CLI's
# ANTHROPIC_BASE_URL should point at. Only scope=="local" providers are
# eligible — a "remote" scoped provider (someone's hosted LM Studio/vLLM) is
# never eligible to become a session's live Anthropic endpoint via this path.
_TERMINAL_ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")


def resolve_local_base_url(provider_id: str, terminal_id: str | None = None) -> str | None:
    """Return the ANTHROPIC_BASE_URL for a local provider id, or None if the
    id is unknown or not local-scoped.

    - "lmstudio-local": previously resolved directly to the broker's
      broker_url (the broker already speaks the Anthropic-compatible
      /v1/messages shape). It now resolves to cockpit's own
      /shim/lmstudio tagging proxy instead -- a byte-verbatim passthrough
      that just ADDS X-Lane-Class/X-Client-Id/X-Agent-Id headers on the way
      out. This indirection exists purely for ATTRIBUTION: the `claude` CLI
      cannot be told to send custom headers, and the broker's by_agent/
      by_session breakdowns are keyed off those headers -- so cockpit tags
      the traffic itself rather than relying on the CLI to.
    - "vllm-local": vLLM is OpenAI-only and would 404 a raw Anthropic call,
      so this points at cockpit's own /shim/vllm translation route instead
      of vLLM's port directly.

    When ``terminal_id`` is given (and passes a strict allowlist regex), the
    returned URL is SESSION-SCOPED via a ``/s/{terminal_id}`` path segment so
    the receiving shim can attribute the call to a specific Cockpit session
    without needing any custom header support from the CLI. An invalid
    terminal_id is never interpolated into the URL -- falls back to the
    un-scoped form instead (same behavior as terminal_id=None).
    """
    provider = _PROVIDERS.get(provider_id)
    if provider is None or provider.get("scope") != "local":
        return None

    scoped_segment = ""
    if terminal_id and _TERMINAL_ID_RE.match(terminal_id):
        scoped_segment = f"/s/{terminal_id}"

    port = int(os.getenv("PORT", "8420"))
    if provider_id == "vllm-local":
        return f"http://127.0.0.1:{port}/shim/vllm{scoped_segment}"
    if provider_id == "lmstudio-local":
        return f"http://127.0.0.1:{port}/shim/lmstudio{scoped_segment}"
    return provider.get("broker_url")


def resolve_local_auth_token(provider_id: str) -> str | None:
    """The credential a session's `claude` CLI must send to a local provider.

    THE BUG THIS CLOSES. Every local provider used to be unauthenticated, so
    pty_manager hard-coded ``ANTHROPIC_AUTH_TOKEN = "local"`` — a dummy that
    exists only because the CLI refuses an empty one. Plexar now gates
    ``/v1/*``, so that dummy is a 401: the picker offered the model, the
    session launched, and every turn failed with a credential error that named
    nothing the user had configured.

    Returns None when the provider genuinely has no credential (LM Studio, the
    lane broker). The caller keeps the dummy in that case — None here means
    "none needed", NOT "we could not find one", and the two must not be
    collapsed or an unauthenticated provider starts sending an empty header.
    """
    provider = _PROVIDERS.get(provider_id)
    if provider is None or provider.get("scope") != "local":
        return None
    # Resolved at call time, not import: a key entered in Settings must work
    # on the next session without restarting the app.
    if provider.get("kind") == "plexar":
        _url, auth = _plexar_config()
        return auth.get("bearer") or None
    return (provider.get("auth") or {}).get("bearer") or None


def resolve_local_output_reservation(provider_id: str, model_id: str) -> int | None:
    """How many tokens the CLI may reserve for OUTPUT on a local model.

    The CLI reserves ~32k for output by default and counts it against the
    window, so a small local window leaves almost nothing for input and the
    server 500s partway through a conversation. A flat 8000 was fine for the
    49152-token vLLM card it was written for; against Plexar's currently
    served window of 12288 it would leave ~4k of usable input.

    So it is DERIVED from the window the provider actually published (via
    context_window, which is fed by GET /api/local/{id}/models) rather than
    assumed: a quarter of the window, floored at 1024 so a tiny window still
    permits a reply. An unknown window returns None and the caller falls back
    to the old constant — we do not invent a window in order to divide it.
    """
    window = context_window.resolve_context_window(model_id, provider="local")
    if not isinstance(window, int) or window <= 0:
        return None
    return max(1024, min(8000, window // 4))


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
        # vLLM offline: serve persisted lifetime so the backend stays in reports
        # (stale) instead of vanishing when the GPU is running the other engine.
        if provider.get("kind") == "vllm":
            snap = await asyncio.to_thread(_vllm_offline_snapshot)
            if snap is not None:
                return JSONResponse(snap)
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


@app.get("/api/local/{provider_id}/models-dir")
async def get_vllm_models_dir(provider_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if provider["scope"] != "local" or provider["kind"] != "vllm":
        return JSONResponse({"error": "models-dir config is vLLM-local-only"}, status_code=404)
    exists = bool(_vllm_models_dir) and Path(_vllm_models_dir).is_dir()
    return JSONResponse({
        "path": _vllm_models_dir_raw or "",
        "mount_path": _vllm_models_dir_mount or "",
        "scan_path": _vllm_models_dir or "",
        "exists": exists,
        "writable_config": True,
        "current_model": _vllm_runtime_model,
    })


@app.put("/api/local/{provider_id}/models-dir")
async def set_vllm_models_dir(provider_id: str, request: Request):
    """Reconfigure the HOST directory Cockpit scans for on-disk vLLM models.

    SECURITY: this is a filesystem path supplied by the browser, so it is
    validated defensively (see _validate_models_dir) even though it is
    operator-facing config at the same trust level as COCKPIT_PROVIDERS_FILE:
    must be absolute, resolve to an existing directory, no NUL bytes, capped
    length. Only vLLM-local supports this (LM Studio's catalog is already
    complete via /api/v0/models).
    """
    global _vllm_models_dir, _vllm_models_dir_mount, _vllm_models_dir_raw

    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if provider["scope"] != "local" or provider["kind"] != "vllm":
        return JSONResponse({"error": "models-dir config is vLLM-local-only"}, status_code=409)

    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "body must be JSON"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "body must be a JSON object"}, status_code=400)

    raw_path = body.get("path")
    ok, error, mount_path, scan_path = _validate_models_dir(raw_path)
    if not ok:
        return JSONResponse({"error": error}, status_code=400)

    _vllm_models_dir = scan_path
    _vllm_models_dir_mount = mount_path
    _vllm_models_dir_raw = raw_path
    # Persist the RAW value as typed -- both mount/scan paths are re-derived
    # from it at startup (see apply_persisted_vllm_models_dir), which also
    # re-runs WSL distro detection rather than trusting a stale cached form.
    _save_vllm_models_dir(raw_path)
    logger.info(
        "Provider %s models dir set: raw=%s mount=%s scan=%s",
        provider_id, raw_path, mount_path, scan_path,
    )
    exists = bool(scan_path) and Path(scan_path).is_dir()
    return JSONResponse({
        "path": raw_path,
        "mount_path": mount_path,
        "scan_path": scan_path,
        "exists": exists,
        "writable_config": True,
        "current_model": _vllm_runtime_model,
    })


@app.get("/api/local/{provider_id}/models")
async def get_provider_models(provider_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "models" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)

    disk_models: list[dict] = []
    if provider.get("kind") == "vllm":
        disk_models = await asyncio.to_thread(_scan_vllm_models_dir)

    try:
        data = await asyncio.to_thread(_mgmt_get, provider, _models_path(provider))
    except Exception:
        logger.debug("Provider %s /models unreachable", provider_id, exc_info=True)
        if disk_models:
            # vLLM offline but its models dir is configured/scannable: still
            # useful to the UI ("load this one"), so this is 200 not 503 --
            # a deliberate shape change from the plain-unreachable case below.
            return JSONResponse({
                "reachable": False,
                "models": disk_models,
                "reason": "server_offline_disk_only",
            })
        return JSONResponse({"reachable": False, "reason": "unreachable"}, status_code=503)

    raw_models = data.get("data") if isinstance(data, dict) else None
    if raw_models is None:
        raw_models = []
    if provider.get("kind") == "vllm":
        raw_models = [
            _normalize_vllm_raw_model(m) if isinstance(m, dict) else m
            for m in raw_models
        ]
    elif provider.get("kind") == "plexar":
        raw_models = [
            _normalize_plexar_raw_model(m) if isinstance(m, dict) else m
            for m in raw_models
        ]
    models = [
        {
            **{field: m.get(field) if isinstance(m, dict) else None for field in _MODEL_FIELDS},
            "name": m.get("name") if isinstance(m, dict) else None,
            "host_path": m.get("host_path") if isinstance(m, dict) else None,
        }
        for m in raw_models
    ]

    if disk_models:
        # De-dup by id -- but a served model's id is typically the plain
        # --served-model-name (e.g. "qwen3-coder-30b-awq"), NOT the container
        # path our disk scan reports ("/models/qwen3-coder-30b-awq"), so also
        # match on the bare directory name to catch that common case.
        served_ids = {m["id"] for m in models}
        for entry in disk_models:
            if entry["id"] in served_ids or entry["name"] in served_ids:
                continue
            models.append({
                **{field: entry.get(field) for field in _MODEL_FIELDS},
                "name": entry.get("name"),
                "host_path": entry.get("host_path"),
            })

    # Feed the resolver the windows this provider just published, so a session
    # running a LOCAL model gets a real context ring instead of an em dash.
    # context_window prefers `loaded_context_length` over `max_context_length`
    # (the running instance's actual window, not its ceiling) and makes no
    # network call of its own -- this is the only place that data arrives.
    try:
        context_window.set_local_model_windows(provider_id, models)
    except Exception:
        logger.debug("Could not record context windows for provider %s", provider_id, exc_info=True)

    return JSONResponse({"reachable": True, "models": models})


def _provider_models_loaded_count(data) -> int:
    """How many of a provider's listed models are actually serving.

    Three catalog dialects, and reading only LM Studio's meant every other
    backend reported "0 models" while happily serving one:

    * **LM Studio** tags each entry ``state: "loaded" | "not-loaded"`` — it
      lists models it *could* load, so the filter is essential.
    * **Plexar** nests the state envelope under a ``plexar`` key
      (``{"plexar": {"state": "serving", "available": true}}``); there is no
      top-level ``state``, so the LM Studio filter matched nothing.
    * **Plain OpenAI-compatible** (vLLM direct) has no state field at all — one
      process serves exactly the model it was launched with, so anything it
      lists IS loaded. Counting 0 there was simply wrong.

    Counting a serving engine as 0 is the same class of error as rendering an
    unreachable backend as 0%: it makes a working system look broken.
    """
    raw_models = data.get("data") if isinstance(data, dict) else None
    if not raw_models:
        return 0

    count = 0
    for m in raw_models:
        if not isinstance(m, dict):
            continue
        plexar = m.get("plexar")
        if isinstance(plexar, dict):
            # Plexar states: only "serving" (and "degraded", still answering)
            # can take a request. loading/stopped/failed cannot.
            if plexar.get("state") in ("serving", "degraded"):
                count += 1
            continue
        if "state" in m:
            if m.get("state") == "loaded":
                count += 1
            continue
        # No state reported anywhere: listed means served.
        count += 1
    return count


@app.get("/api/local/{provider_id}/health")
async def get_provider_health(provider_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "health" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)

    # Only providers actually FRONTED by the lane broker get queue-probed.
    # Probing /queue on a broker-less backend (vLLM direct, Plexar) 404s, and
    # reporting that as `broker.reachable: false` is a false claim about a
    # component that does not exist there — which then dragged `ok` to false
    # for a perfectly healthy engine. The `queue` capability is the signal:
    # it is exactly "there is a broker in front of this".
    has_broker = "queue" in provider["capabilities"]

    async def probe_broker():
        if not has_broker:
            return None  # not applicable — distinct from "unreachable"
        try:
            await asyncio.to_thread(_broker_get, "/queue", "", provider["broker_url"])
            return True
        except Exception:
            return False

    async def probe_provider():
        try:
            data = await asyncio.to_thread(_mgmt_get, provider, _models_path(provider))
            return True, _provider_models_loaded_count(data), data
        except Exception:
            return False, 0, None

    broker_reachable, (provider_reachable, models_loaded, raw) = await asyncio.gather(
        probe_broker(), probe_provider()
    )

    body = {
        # `applicable: false` + `reachable: null` says "no broker here", which
        # is not the same statement as "the broker is down".
        "broker": {"applicable": has_broker, "reachable": broker_reachable},
        "provider": {"reachable": provider_reachable, "models_loaded": models_loaded},
        "ok": bool(provider_reachable and (broker_reachable or not has_broker)),
    }

    # Plexar is a GATEWAY: it answers 200 on /v1/models even while the engine
    # behind it is restarting or dead, because a stable address is the whole
    # product. So `provider.reachable` here means "the gateway answered", NOT
    # "you can send a request" — and reporting only the former would call a
    # dead engine healthy. The envelope says which of serving / loading /
    # unreachable / stopped / failed it actually is, why, and the ETA.
    #
    # `ok` deliberately keeps meaning REACHABILITY across every provider rather
    # than quietly meaning something different for one of them. Callers that
    # care whether work can actually run read `engine.available`.
    if provider.get("kind") == "plexar" and raw is not None:
        body["engine"] = plexar_client.engine_summary(raw)
    elif provider.get("kind") == "plexar":
        body["engine"] = {
            "serving": 0, "total": 0, "state": None, "available": False,
            "reason": "Plexar is not answering on its address.",
            "action": "Start Plexar, or check COCKPIT_PLEXAR_URL.",
            "eta_seconds": None,
        }

    return JSONResponse(body)


# ── Voice (status · voices) ───────────────────────────────
#
# Voice is an OPTIONAL capability. Its ML dependencies are deliberately NOT
# bundled — the sidecar is ~48 MB and torch alone would add ~2 GB — so on a
# fresh install the engine is simply absent. `import voice_service` is free
# (~0.05s, no heavy imports, no network, no disk), which is why it can sit at
# module scope beside everything else.
#
# Both routes ALWAYS return 200. "Voice is not installed" is a normal state to
# report, not an HTTP error: a 503 here would make an inline panel blank out
# rather than explain itself, which is the same stance /api/spend/status and
# /api/anthropic/usage already take.


@app.get("/api/voice/status")
async def get_voice_status():
    """What voice can actually do on this machine, and why not, if not.

    The `reason` is the whole point and the UI must switch on it — the four
    values imply four DIFFERENT user actions:
      not_installed -> pip install; model_missing -> download the weights;
      unsupported   -> this desktop build has no interpreter to install into;
      check_failed  -> we could not determine, which is NOT "it is broken".
    Collapsing them into "voice unavailable" sends people to fix the wrong
    thing.
    """
    return JSONResponse(await asyncio.to_thread(voice_service.availability))


@app.get("/api/voice/voices")
async def get_voice_voices():
    """Available voices, or an empty list WITH the reason it is empty.

    An empty picker with no explanation reads as "this model has no voices",
    which is a different claim from "the voicepack is not downloaded" or "the
    file is corrupt" — and a corrupt pack must not send the user to re-download
    a file they already have.
    """
    return JSONResponse(await asyncio.to_thread(voice_service.list_voices))


# ── Chat (groups · conversations · messages · attachments) ─────
#
# Cockpit's FIRST system of record. Every other store here re-reads something
# that exists elsewhere; this one holds the user's own words, so the failure
# modes that matter are "lost" and "reordered", not "stale".
#
# The routes are thin: validation and shape live in chat_store, because a rule
# enforced in a route is a rule the next caller skips.


def _chat():
    return chat_store.get_store()


@app.get("/api/chat/groups")
async def list_chat_groups():
    return JSONResponse({"groups": await asyncio.to_thread(_chat().list_groups)})


@app.post("/api/chat/groups")
async def create_chat_group(body: dict):
    try:
        group = await asyncio.to_thread(
            _chat().create_group, body.get("name", ""), body.get("parent_id")
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return JSONResponse(group)


@app.patch("/api/chat/groups/{group_id}")
async def rename_chat_group(group_id: str, body: dict):
    try:
        group = await asyncio.to_thread(
            _chat().rename_group, group_id, body.get("name", "")
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    if group is None:
        return JSONResponse({"error": "unknown group"}, status_code=404)
    return JSONResponse(group)


@app.delete("/api/chat/groups/{group_id}")
async def delete_chat_group(group_id: str):
    """Delete a group. Its conversations are RE-PARENTED, never deleted.

    The response reports how many moved so the UI can say so — a silent
    re-home leaves the user hunting for chats they think they lost.
    """
    if await asyncio.to_thread(_chat().get_group, group_id) is None:
        return JSONResponse({"error": "unknown group"}, status_code=404)
    return JSONResponse(await asyncio.to_thread(_chat().delete_group, group_id))


@app.get("/api/chat/conversations")
async def list_chat_conversations(group_id: str = None, include_archived: bool = False):
    """List conversations. `group_id=root` is the ungrouped shelf.

    Omitting group_id means ALL groups, which is a different question from
    "the root" — conflating them makes the root unreachable.
    """
    convs = await asyncio.to_thread(
        _chat().list_conversations, group_id, include_archived
    )
    return JSONResponse({"conversations": convs})


@app.post("/api/chat/conversations")
async def create_chat_conversation(body: dict):
    try:
        conv = await asyncio.to_thread(
            _chat().create_conversation,
            body.get("title", "New chat"), body.get("group_id"),
            body.get("model"), body.get("provider"),
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return JSONResponse(conv)


@app.get("/api/chat/conversations/{conversation_id}")
async def get_chat_conversation(conversation_id: str):
    """A conversation and its full history — the 'serve up their history' ask."""
    store = _chat()
    conv = await asyncio.to_thread(store.get_conversation, conversation_id)
    if conv is None:
        return JSONResponse({"error": "unknown conversation"}, status_code=404)
    return JSONResponse({
        "conversation": conv,
        "messages": await asyncio.to_thread(store.list_messages, conversation_id),
        "attachments": await asyncio.to_thread(store.list_attachments, conversation_id),
    })


@app.patch("/api/chat/conversations/{conversation_id}")
async def update_chat_conversation(conversation_id: str, body: dict):
    """Retitle, archive, re-model, or MOVE a conversation between groups.

    `group_id` is only applied when the key is PRESENT in the body: `null` is a
    meaningful value ("move to the root"), so it cannot double as "unspecified".
    """
    kwargs = {}
    if "title" in body:
        kwargs["title"] = body["title"]
    if "archived" in body:
        kwargs["archived"] = bool(body["archived"])
    if "model" in body:
        kwargs["model"] = body["model"]
    if "group_id" in body:
        kwargs["group_id"] = body["group_id"]
    try:
        conv = await asyncio.to_thread(
            lambda: _chat().update_conversation(conversation_id, **kwargs)
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    if conv is None:
        return JSONResponse({"error": "unknown conversation"}, status_code=404)
    return JSONResponse(conv)


@app.delete("/api/chat/conversations/{conversation_id}")
async def delete_chat_conversation(conversation_id: str):
    """Genuinely destructive — a conversation DOES contain its messages."""
    ok = await asyncio.to_thread(_chat().delete_conversation, conversation_id)
    if not ok:
        return JSONResponse({"error": "unknown conversation"}, status_code=404)
    return JSONResponse({"ok": True, "deleted": conversation_id})


@app.get("/api/chat/conversations/{conversation_id}/export")
async def export_chat_conversation(conversation_id: str):
    """A chat store with no way out is a trap. These are the user's words."""
    out = await asyncio.to_thread(_chat().export_conversation, conversation_id)
    if out is None:
        return JSONResponse({"error": "unknown conversation"}, status_code=404)
    return JSONResponse(out)


@app.post("/api/chat/conversations/{conversation_id}/messages")
async def add_chat_message(conversation_id: str, body: dict):
    """Append one message. Content is stored VERBATIM — never trimmed.

    An oversized paste is a loud 413, not a silent truncation: shortening what
    someone typed and reporting success is the worst outcome available here.
    """
    try:
        msg = await asyncio.to_thread(
            _chat().add_message, conversation_id,
            body.get("role", "user"), body.get("content", ""),
            body.get("model"), body.get("input_tokens"), body.get("output_tokens"),
        )
    except ValueError as exc:
        text = str(exc)
        if "over the" in text:
            return JSONResponse({"error": text}, status_code=413)
        if "unknown conversation" in text:
            return JSONResponse({"error": text}, status_code=404)
        return JSONResponse({"error": text}, status_code=400)
    return JSONResponse(msg)


#: The picker's namespaced id for a local model, "local:<providerId>:<modelId>".
#: The model id may itself contain ":", so only the first two segments split.
_PICKER_LOCAL_RE = re.compile(r"^local:([A-Za-z0-9_\-]+):(.+)$")

#: The harness's own preamble, paid on EVERY turn regardless of how short the
#: message is. Measured on a SUCCESSFUL turn against a live local model
#: (qwen3-30b-instruct at max_model_len 57344, 2026-08-02): a seven-word prompt
#: reported context_tokens 29273.
#:
#: THIS CONSTANT HAS BEEN WRONG TWICE, IN BOTH DIRECTIONS, AND THE METHOD IS
#: THE LESSON:
#:   1. 9289 — read off the prose of a vLLM error, "prompt contains at least
#:      9289 input tokens". A lower bound reported as a total.
#:   2. 11265 — read off the `value=` in a later error and believed to be
#:      exact BECAUSE it was a machine field. It was not. Note the arithmetic:
#:      11265 + 1024 requested output = 12289, exactly one over that model's
#:      12288 limit. The engine reported the SMALLEST prompt that would have
#:      tripped the limit, not the size of the prompt it received. "At least"
#:      meant what it said, and the machine-readable field inherited it.
#:   3. 29273 — measured on a turn that COMPLETED, so nothing about it is
#:      derived from a failure threshold. This is the only sound method: a
#:      failing request tells you about the limit, not about your payload.
#:
#: A chars/4 estimate of the captured request body gave ~29 900, within 3% of
#: the truth. The earlier comment here claimed that heuristic "overstated by
#: 2.6x" and used the failure-derived number to say so — the correction was
#: itself the error.
#:
#: Composition: built-in tool schemas dominate, then the agent-type roster,
#: then the system prompt. `--allowedTools` does NOT shrink it — that flag
#: gates permission and still sends every schema. chat_runner roughly halves
#: the payload with --strict-mcp-config (89 tool schemas -> 31) and a neutral
#: workspace (this repo's CLAUDE.md was otherwise injected every turn).
_HARNESS_PREAMBLE_TOKENS = 29273

#: The smallest local context window Chat will route a turn to: the preamble
#: plus room for an actual exchange. A model below this is not "slow" or
#: "small" — it cannot complete turn one, so saying so up front beats a minute
#: of waiting followed by a 500 from inside the engine.
#:
#: Set to preamble + ~11k of headroom. It was briefly 16384, lowered on the
#: 11265 figure above — which would have ADMITTED a 16k-32k model that cannot
#: hold a single turn, i.e. exactly the quiet overflow this refusal exists to
#: prevent. A threshold is only as good as the measurement under it.
_MIN_LOCAL_WINDOW = 40960


def resolve_chat_model_env(model: str | None) -> tuple[str | None, dict | None, str | None]:
    """Turn a picker model id into ``(cli_model, env_overlay, error)``.

    Chat's picker lists local models because they are genuinely runnable — the
    `claude` CLI drives any Anthropic-compatible endpoint via
    ANTHROPIC_BASE_URL, which is exactly how a terminal session on a local
    provider already works. Without this, a local pick reached the CLI as the
    literal string "local:plexar-vllm:qwen3-coder-30b-awq", which is not a
    model any endpoint knows.

    An unresolvable local id returns an ERROR rather than silently falling back
    to Anthropic. Quietly answering from a different model than the one the
    user selected is the worst outcome here: the reply looks fine, and the
    conversation is attributed to an engine that never saw it.
    """
    if not model:
        return None, None, None
    match = _PICKER_LOCAL_RE.match(model)
    if match is None:
        return model, None, None

    provider_id, model_id = match.group(1), match.group(2)
    base_url = resolve_local_base_url(provider_id)
    if not base_url:
        return None, None, (
            f"{provider_id!r} is not a local provider this build can route to."
        )

    window = context_window.resolve_context_window(model_id, provider="local")
    if isinstance(window, int) and 0 < window < _MIN_LOCAL_WINDOW:
        # MEASURED, not assumed: a bare `claude -p` turn against this model
        # reported "at least 9289 input tokens" before the user's own message
        # was counted. The harness preamble is most of a small window, so a
        # 12288-token engine 500s on turn one no matter how the output
        # reservation is tuned.
        #
        # Refusing here converts that into one sentence naming the number and
        # the fix. The alternative is a 500 from deep inside the engine,
        # arriving after a minute, that reads as the model being broken.
        return None, None, (
            f"{model_id} is served with a {window:,}-token context window. The "
            f"`claude` harness sends about {_HARNESS_PREAMBLE_TOKENS:,} tokens of "
            f"its own before your message, so a turn cannot fit. Restart this "
            f"model with a larger --max-model-len (at least "
            f"{_MIN_LOCAL_WINDOW:,}) to use it from Chat."
        )

    overlay = {
        "ANTHROPIC_BASE_URL": base_url,
        # None means "no credential needed" (LM Studio, the broker), not "not
        # found" — the CLI refuses an empty value, hence the dummy.
        "ANTHROPIC_AUTH_TOKEN": resolve_local_auth_token(provider_id) or "local",
        # REMOVED, not blanked (None deletes — see stream_reply): the CLI reads
        # a present-but-empty value as "an auth source is set". This also means
        # no fallback to a real Anthropic key inherited from this process.
        "ANTHROPIC_API_KEY": None,
        "ANTHROPIC_MODEL": model_id,
        # The CLI's small/fast model is used for background work (titles) and
        # would 404 against a local server that has never heard of it.
        "ANTHROPIC_SMALL_FAST_MODEL": model_id,
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(
            resolve_local_output_reservation(provider_id, model_id) or 8000
        ),
    }
    return model_id, overlay, None


@app.post("/api/chat/conversations/{conversation_id}/respond")
async def respond_in_chat(conversation_id: str, body: dict):
    """Persist the user's message and STREAM a reply back as SSE.

    One route rather than two, deliberately: if the send and the reply were
    separate calls, a failure between them would leave a user message saved
    with nothing ever answering it, and the UI could not tell that apart from
    a slow model.

    The tool allow-list is read from the CONVERSATION, never from the request
    body. A client that could ask for `Bash` by setting a flag would make the
    server-side rail decorative — these tools run on this machine with the
    user's own privileges.
    """
    store = _chat()
    conv = await asyncio.to_thread(store.get_conversation, conversation_id)
    if conv is None:
        return JSONResponse({"error": "unknown conversation"}, status_code=404)

    content = body.get("content") or ""
    if not content.strip():
        return JSONResponse({"error": "content must not be empty"}, status_code=400)

    # Resolved BEFORE the user's message is stored. A model we cannot route to
    # is a refusal, not a turn: persisting the message first would leave it
    # saved with nothing able to answer it, which is the exact failure the
    # one-route-sends-and-replies design exists to prevent.
    cli_model, env_overlay, model_error = resolve_chat_model_env(conv.get("model"))
    if model_error:
        return JSONResponse({"error": model_error}, status_code=400)

    try:
        await asyncio.to_thread(store.add_message, conversation_id, "user", content)
    except ValueError as exc:
        text = str(exc)
        code = 413 if "over the" in text else 400
        return JSONResponse({"error": text}, status_code=code)

    async def events():
        def sse(payload: dict) -> bytes:
            # SSE frames end with a BLANK line; the terminator is built from
            # chr(10) rather than an escape so it survives every layer of
            # tooling that has rewritten this file.
            nl = chr(10)
            return ("data: " + json.dumps(payload) + nl + nl).encode("utf-8")

        parts: list[str] = []
        session_id = conv.get("harness_session_id")
        try:
            async for ev in chat_runner.stream_reply(
                content,
                model=cli_model,
                env_overlay=env_overlay,
                session_id=session_id,
                # Read-only unless this conversation was explicitly opted in.
                # Not yet settable from the UI, which is the honest state: the
                # capability exists and nothing grants it by accident.
                allow_write=False, allow_exec=False, allow_net=False,
                # Turns run in a NEUTRAL workspace (chat_runner.chat_workspace)
                # so this repo's CLAUDE.md is not prepended to every message.
                # Uploaded attachments live outside it, so the upload dir is
                # added explicitly — otherwise the paths folded into the prompt
                # name files the Read tool is not permitted to open, and the
                # attachment silently becomes decoration.
                cwd_scope=str(UPLOAD_DIR),
            ):
                if ev["type"] == "session" and ev.get("session_id"):
                    session_id = ev["session_id"]
                yield sse(ev)

                if ev["type"] == "delta":
                    parts.append(ev["text"])
                elif ev["type"] == "done":
                    text = ev.get("text") or "".join(parts)
                    # Persist only a turn that actually produced something. An
                    # empty assistant row would render as the model replying
                    # with silence.
                    if text.strip():
                        # Token counts ride WITH the message so the context
                        # meter survives a reload — a figure held only in
                        # component state is gone the moment you navigate away.
                        await asyncio.to_thread(
                            store.add_message, conversation_id, "assistant", text,
                            conv.get("model"), ev.get("context_tokens"),
                            ev.get("output_tokens"),
                        )
                    if ev.get("session_id") or session_id:
                        await asyncio.to_thread(
                            store.set_harness_session, conversation_id,
                            ev.get("session_id") or session_id,
                        )
        except Exception as exc:  # pragma: no cover - defensive
            logger.error("chat respond failed", exc_info=True)
            yield sse({"type": "error", "detail": str(exc)})

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        # Buffering an event stream defeats the point of streaming it.
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/chat/harness")
async def get_chat_harness():
    """Whether a reply is possible at all, and why not if not. Always 200."""
    cli = await asyncio.to_thread(chat_runner.resolve_cli)
    return JSONResponse({
        "available": bool(cli),
        "reason": None if cli else "cli_not_found",
        "detail": (
            "Replies run through the local `claude` CLI."
            if cli else
            "The `claude` CLI was not found on PATH, so Chat cannot produce replies."
        ),
        "read_only_tools": list(chat_runner.READ_ONLY_TOOLS),
    })


@app.post("/api/chat/conversations/{conversation_id}/attachments")
async def add_chat_attachment(conversation_id: str, body: dict):
    """Record a file against a conversation. The BYTES are already on disk.

    Upload goes through the existing /api/upload; this records what it was and
    where it went, so a 40 MB workbook does not sit inside a row that every
    conversation read has to pay for.
    """
    try:
        att = await asyncio.to_thread(
            _chat().add_attachment, conversation_id,
            body.get("filename", "file"), body.get("path", ""),
            body.get("kind", "file"), body.get("mime"),
            body.get("size_bytes"), body.get("message_id"),
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=404)
    return JSONResponse(att)


# ── Plexar reads (instances · reports · GPUs) ─────────────
#
# Cockpit KEEPS its own reporting. These are a SECOND source beside it, not a
# replacement: Plexar knows what the GPU did and what consumers experienced at
# the gateway; Cockpit knows sessions, tokens and cost. Every Plexar figure
# arrives carrying its own `source` and `window_exact` labels, and those are
# passed through untouched — merging the two without saying which is which
# produces numbers nobody can defend.
#
# All three ALWAYS return 200 with an availability envelope, like
# /api/spend/status: these feed inline panels, and an HTTP error would blank a
# panel rather than explain itself.


@app.get("/api/local/{provider_id}/instances")
async def get_provider_instances(provider_id: str):
    """Engine instances with their state envelope and live gauges."""
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "instances" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    return JSONResponse(
        await asyncio.to_thread(plexar_client.fetch_status, provider["management_url"], provider.get("auth"))
    )


@app.get("/api/local/{provider_id}/reports")
async def get_provider_reports(provider_id: str, range: str = "lifetime"):
    """Plexar's own reporting summary — both sources, each figure labelled."""
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "reports" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    # A bad range is a real client error and should be loud, not an envelope.
    if range not in plexar_client.REPORT_RANGES:
        return JSONResponse(
            {"error": f"range must be one of {list(plexar_client.REPORT_RANGES)}"},
            status_code=400,
        )
    return JSONResponse(
        await asyncio.to_thread(
            plexar_client.fetch_reports, provider["management_url"], range,
            provider.get("auth"),
        )
    )


@app.get("/api/local/{provider_id}/identity")
async def get_provider_identity(provider_id: str):
    """Who Cockpit authenticates to the provider AS. Always 200.

    Plexar contracts `/api/me` to answer 200 even unauthenticated, precisely so
    a consumer can tell "wrong credential" from "server down" — a 401 here
    would collapse two states with opposite remedies. Cockpit preserves that:
    this route reports the answer, it does not become one.

    The scope prose is Plexar's and is passed through verbatim. Hard-coding
    what a guest may do goes stale the first time the allow-list changes.
    """
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "identity" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    return JSONResponse(
        await asyncio.to_thread(
            plexar_client.fetch_me, provider["management_url"], provider.get("auth")
        )
    )


@app.get("/api/local/{provider_id}/timeseries")
async def get_provider_timeseries(
    provider_id: str,
    range: str = "24h",
    bucket: str = None,
    instance_id: str = None,
):
    """Bucketed engine history — the two sources as separate named series.

    `reports` gives window totals; this gives their shape over time. Both
    series arrive with their own `window_exact` flag and are never summed.
    """
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "timeseries" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    # A bad range/bucket is a genuine client error and stays loud, matching
    # both the sibling /reports route and Plexar's own behaviour.
    if range not in plexar_client.TIMESERIES_RANGES:
        return JSONResponse(
            {"error": f"range must be one of {list(plexar_client.TIMESERIES_RANGES)}"},
            status_code=400,
        )
    if bucket is not None and bucket not in plexar_client.TIMESERIES_BUCKETS:
        return JSONResponse(
            {"error": f"bucket must be one of {list(plexar_client.TIMESERIES_BUCKETS)}"},
            status_code=400,
        )
    return JSONResponse(
        await asyncio.to_thread(
            plexar_client.fetch_timeseries,
            provider["management_url"], range, bucket, instance_id,
            provider.get("auth"),
        )
    )


@app.get("/api/local/{provider_id}/gpus")
async def get_provider_gpus(provider_id: str):
    """Physical GPUs behind the provider: VRAM totals, free, display usage."""
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "gpus" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    return JSONResponse(
        await asyncio.to_thread(plexar_client.fetch_gpus, provider["management_url"], provider.get("auth"))
    )


# ── Model control (load / unload / restart) ───────────────
#
# The only WRITE path on local model state. LM Studio hot-loads/unloads via its
# `lms` CLI; vLLM cannot hot-swap, so its "control" is a validated restart of
# the managed container with a new --model. Progress is not reported by either
# backend, so the UI infers it by polling /models (state=="loaded") and /health.
_LOCAL_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/@\-]{0,255}$")


async def _lms_load_bg(model_id: str) -> None:
    """Fire-and-forget `lms load`; the UI polls /models for state=="loaded".

    Runs as a background task so the HTTP request returns immediately (a load
    can take tens of seconds). Failures are logged, not surfaced synchronously.
    """
    try:
        proc = await asyncio.create_subprocess_exec(
            _LMS_CLI, "load", model_id, "--gpu", "max",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await proc.communicate()
        if proc.returncode != 0:
            logger.error("lms load %s failed rc=%s: %s", model_id, proc.returncode,
                         (err or b"").decode(errors="replace"))
    except Exception:
        logger.error("lms load %s crashed", model_id, exc_info=True)


def _plexar_instance_for_model(provider: dict, model_id: str):
    """Resolve a served model name to the instance that serves it.

    Cockpit's control routes are keyed by MODEL (that is what a picker row
    is); Plexar's are keyed by INSTANCE. Its catalog can legitimately list the
    same served name more than once, so this is a lookup, not a rename.

    Returns ``(instance_id, None)`` or ``(None, JSONResponse)``. **Ambiguity is
    refused, never resolved by picking the first match** — the two candidates
    are different engines on different GPUs, and silently toggling whichever
    happened to sort first is the class of guess that made the old container
    name a lie.
    """
    try:
        catalog = _mgmt_get(provider, "/v1/models")
    except Exception:
        logger.warning("Plexar catalog unreadable during model control", exc_info=True)
        return None, JSONResponse(
            {"error": "Plexar is not answering, so the instance could not be identified."},
            status_code=502,
        )

    entries = catalog.get("data") if isinstance(catalog, dict) else None
    if not isinstance(entries, list):
        return None, JSONResponse({"error": "Plexar catalog was not catalog-shaped."},
                                  status_code=502)

    matches = [
        e for e in entries
        if isinstance(e, dict) and e.get("id") == model_id
        and isinstance(e.get("plexar"), dict) and e["plexar"].get("instance_id")
    ]
    if not matches:
        return None, JSONResponse(
            {"error": f"no Plexar instance serves {model_id!r}"}, status_code=404)
    if len(matches) > 1:
        return None, JSONResponse(
            {"error": (
                f"{len(matches)} instances serve {model_id!r}; Cockpit will not guess "
                "which one to control. Address it by instance in Plexar."
            )},
            status_code=409,
        )
    return matches[0]["plexar"]["instance_id"], None


async def _plexar_control(provider: dict, model_id: str, action: str):
    """Shared body for Plexar's load/unload."""
    instance_id, err = _plexar_instance_for_model(provider, model_id)
    if err is not None:
        return err
    result = await asyncio.to_thread(
        plexar_client.control_instance, provider["management_url"], instance_id, action,
        provider.get("auth"),
    )
    if not result.get("ok"):
        # A write that did not take must not answer 200 — the UI would show a
        # toggle that moved while the GPU did nothing.
        return JSONResponse(
            {"error": result.get("detail") or f"{action} failed", "reason": result.get("reason")},
            status_code=502,
        )
    return JSONResponse(result)


@app.post("/api/local/{provider_id}/models/{model_id:path}/load")
async def load_provider_model(provider_id: str, model_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "model-control" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if provider.get("scope") != "local":
        return JSONResponse({"error": "control not available for remote providers"}, status_code=403)
    if not _LOCAL_MODEL_ID_RE.match(model_id):
        return JSONResponse({"error": "invalid model id"}, status_code=400)
    if provider.get("kind") == "plexar":
        # Plexar keeps an unloaded instance in /v1/models as `state: down`, so
        # this genuinely is a load — not a create.
        return await _plexar_control(provider, model_id, "load")
    if provider.get("kind") == "vllm":
        return JSONResponse(
            {"error": (
                "vLLM cannot hot-load a model — it serves one model per process, fixed "
                "by --model at launch. Use POST /api/local/vllm-local/restart with a "
                "model instead (managed containers only)."
            )},
            status_code=409,
        )
    if not _LMS_CLI:
        return JSONResponse({"error": "lms CLI not available"}, status_code=503)
    if not _LOCAL_MODEL_ID_RE.match(model_id):
        return JSONResponse({"error": "invalid model id"}, status_code=400)
    asyncio.create_task(_lms_load_bg(model_id))
    return JSONResponse({"ok": True, "status": "loading", "model": model_id})


@app.post("/api/local/{provider_id}/models/{model_id:path}/unload")
async def unload_provider_model(provider_id: str, model_id: str):
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if "model-control" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    if provider.get("scope") != "local":
        return JSONResponse({"error": "control not available for remote providers"}, status_code=403)
    if not _LOCAL_MODEL_ID_RE.match(model_id):
        return JSONResponse({"error": "invalid model id"}, status_code=400)
    if provider.get("kind") == "plexar":
        # Frees the GPU but KEEPS the declaration, so the row stays in the
        # picker as `state: down` and can be toggled back on. Deliberately not
        # DELETE, which forgets the instance and its whole config.
        return await _plexar_control(provider, model_id, "unload")
    if provider.get("kind") == "vllm":
        return JSONResponse(
            {"error": (
                "vLLM cannot unload a single model — it serves one model per process. "
                "Stopping the process is the only unload, and Cockpit only does that for "
                "a container it owns (Settings ▸ Providers ▸ vLLM ▸ \"Managed by Cockpit\", "
                "or COCKPIT_MANAGED_VLLM=1)."
            )},
            status_code=409,
        )
    if not _LMS_CLI:
        return JSONResponse({"error": "lms CLI not available"}, status_code=503)
    if not _LOCAL_MODEL_ID_RE.match(model_id):
        return JSONResponse({"error": "invalid model id"}, status_code=400)
    try:
        proc = await asyncio.create_subprocess_exec(
            _LMS_CLI, "unload", model_id,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _out, err = await proc.communicate()
    except Exception:
        logger.error("lms unload %s crashed", model_id, exc_info=True)
        return JSONResponse({"error": "unload failed"}, status_code=502)
    if proc.returncode != 0:
        logger.error("lms unload %s failed rc=%s: %s", model_id, proc.returncode,
                     (err or b"").decode(errors="replace"))
        return JSONResponse({"error": "unload failed"}, status_code=502)
    return JSONResponse({"ok": True})


@app.post("/api/local/{provider_id}/restart")
async def restart_provider_model(provider_id: str, request: Request):
    """Restart the managed vLLM container with a new model (vLLM has no hot-swap).

    Only valid for the managed vLLM provider; an EXTERNAL vLLM (nothing opted in
    — neither COCKPIT_MANAGED_VLLM=1 nor settings.json providers.vllm.managed —
    or the startup double-bind probe found something already serving) is not
    Cockpit's to restart → 409. Killing a container the user started by hand
    would be destructive, so the refusal names the ACTUAL cause (external server,
    save-not-yet-in-effect, or simply off) rather than a single generic line.
    """
    provider = _require_provider(provider_id)
    if provider is None:
        return JSONResponse({"error": "unknown provider"}, status_code=404)
    if provider.get("scope") != "local" or provider.get("kind") != "vllm":
        return JSONResponse({"error": "restart is only supported for the local vLLM provider"}, status_code=409)
    # Ownership is checked BEFORE the capability gate, deliberately: withdrawing
    # "model-control" from an external vLLM is what stops the UI offering the
    # button, but a direct/stale call still deserves the explanation rather than
    # a bare "capability not available".
    if not _vllm_is_managed():
        ownership = _vllm_ownership()
        preamble = (
            "vLLM has no model hot-swap API — one model per process, fixed by "
            "--model at launch — so changing model means restarting the process. "
            "Cockpit can only do that for a container it owns. "
        )
        if ownership["external"]:
            cause = (
                "An external vLLM is already answering on this port, so Cockpit defers to it. "
                "Restart it where you started it, with the new --model."
            )
        elif ownership["pending_restart"]:
            cause = (
                "\"Managed by Cockpit\" is saved but not in effect yet — the container is "
                "started during Cockpit startup, so restart Cockpit first."
            )
        else:
            cause = (
                "This vLLM is external. Turn on Settings ▸ Providers ▸ vLLM ▸ \"Managed by "
                "Cockpit\" (or start Cockpit with COCKPIT_MANAGED_VLLM=1) and restart Cockpit, "
                "or restart vLLM where you started it, with the new --model."
            )
        return JSONResponse(
            {
                "error": preamble + cause,
                "managed": False,
                "env": "COCKPIT_MANAGED_VLLM",
                "ownership": ownership,
            },
            status_code=409,
        )
    # Reachable only if a COCKPIT_PROVIDERS_FILE entry strips the capability
    # while Cockpit still owns the container.
    if "model-control" not in provider["capabilities"]:
        return JSONResponse({"error": "capability not available"}, status_code=404)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "invalid JSON body"}, status_code=400)
    model = (body.get("model") or "").strip() if isinstance(body, dict) else ""
    # Hard validation BEFORE any stop/start — the model becomes a docker --model
    # arg (WSL-shell-joined on Windows); reject anything but model-path chars.
    if not _VLLM_MODEL_RE.match(model):
        return JSONResponse({"error": "invalid model — allowed: letters, digits, . _ : / -"}, status_code=400)
    global _vllm_runtime_model
    _vllm_runtime_model = model
    await stop_managed_vllm()
    await start_managed_vllm()
    return JSONResponse({"ok": True, "status": "restarting", "model": model})


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


_USAGE_REPORT_RANGES = ("24h", "7d", "30d", "all")


@app.get("/api/usage/report")
async def get_usage_report(range: str = "7d"):
    """Everything the Reports page renders, in ONE call (KPIs + day series +
    per-model spend + per-tool calls + sessions table + prior-period KPIs).
    See usage_tracker.range_report for the exact formulas; the important ones:

      * cost is API-EQUIVALENT (list $/1M rates), NOT a subscription bill. It
        is the SUM of per-event costs FROZEN at ingest using the price in
        effect at that event's timestamp -- it is never recomputed from current
        prices, so a vendor price change cannot move a past report.
        Local-provider tokens are costed at $0 and never inflate cost; they are
        counted separately and surface via kpis.local_share.
      * cost_basis = {exact, backfilled, unpriced} counts of API events in the
        range. `backfilled` rows were priced retroactively (they predate
        cost-at-ingest), so the UI must say part of the range was priced after
        the fact rather than implying every figure was locked in at the time.
        `unpriced` rows have no price on file: their tokens count, their cost
        is 0.
      * cache_hit_rate = cache_read / (cache_read + input), 0.0 when the
        denominator is 0.
      * by_day is gap-filled -- every day in the range is present, zeroed
        where there was no activity.
      * kpis.tool_calls / sessions[].tool_calls / by_tool are REAL counts of
        persisted `tool_use` blocks (usage_tracker.tool_events). Rows ingested
        before tool tracking shipped carry no tool events, so
        `tool_events_since` gives the earliest recorded tool event (or null) --
        the UI must label the number "recorded since <date>" rather than
        implying full coverage of the range.
      * previous = {available, kpis} for the immediately preceding window of
        equal length. available is false for range=all (no meaningful prior
        period) and whenever the prior window has no data at all, so the UI
        renders no delta instead of a misleading +100%.

    Live session display names are attached where the terminal is still
    running; historical rows keep name=null.
    """
    if range not in _USAGE_REPORT_RANGES:
        return JSONResponse(
            {"error": f"range must be one of {list(_USAGE_REPORT_RANGES)}"},
            status_code=400,
        )
    try:
        data = usage_tracker.range_report(range)
    except ValueError:
        return JSONResponse(
            {"error": f"range must be one of {list(_USAGE_REPORT_RANGES)}"},
            status_code=400,
        )
    except Exception:
        logger.error("usage_tracker.range_report(%s) failed", range, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)

    # Best-effort name enrichment from the live session registry.
    try:
        live = pty_manager.sessions
        for row in data.get("sessions", []):
            s = live.get(row.get("terminal_id"))
            if s is not None and getattr(s, "name", None):
                row["name"] = s.name
    except Exception:
        logger.debug("usage report: session name enrichment failed", exc_info=True)

    return JSONResponse(data)


@app.get("/api/reporting/models")
async def get_reporting_models(window: str = "lifetime"):
    """Merged per-model usage report across every pipeline Cockpit observes:
    Anthropic + OpenRouter (usage_events, from Claude Code JSONL) and local
    providers (local_runs, from the vLLM/LM Studio tagging shims), with
    per-repo attribution. This is the merge point -- see usage_tracker.model_report.
    """
    if window not in _USAGE_SUMMARY_WINDOWS:
        return JSONResponse(
            {"error": f"window must be one of {list(_USAGE_SUMMARY_WINDOWS)}"},
            status_code=400,
        )
    try:
        data = usage_tracker.model_report(window)
    except ValueError:
        return JSONResponse(
            {"error": f"window must be one of {list(_USAGE_SUMMARY_WINDOWS)}"},
            status_code=400,
        )
    except Exception:
        logger.error("usage_tracker.model_report(%s) failed", window, exc_info=True)
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


# ── Live model prices (append-only snapshots + daily OpenRouter poll) ──
#
# The store is APPEND-ONLY: a price change writes a NEW row with a later
# effective_from and never touches the old one. usage_tracker freezes each
# event's cost at ingest from the rate in effect at that moment, so refreshing
# prices changes what FUTURE turns cost and can never re-price history.

# The loop wakes often but only polls when the cadence
# (COCKPIT_PRICING_REFRESH_HOURS, default 24h) has actually elapsed. Short ticks
# instead of one 24h sleep so a long-running desktop app that was suspended
# mid-sleep still refreshes promptly after waking.
_PRICING_LOOP_TICK_SECONDS = 900


async def _pricing_refresh_loop() -> None:
    """Poll OpenRouter for current prices on a cadence. Best-effort.

    Runs the blocking urllib fetch via ``asyncio.to_thread`` so the event loop
    is never blocked. A network failure logs a warning and changes nothing --
    the loop keeps going, and Cockpit keeps serving with the prices it already
    has.
    """
    try:
        while True:
            try:
                due = await asyncio.to_thread(
                    pricing_store.refresh_due, pricing_store_module.SOURCE_OPENROUTER
                )
                if due:
                    await asyncio.to_thread(pricing_store.refresh_openrouter)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.error("Pricing refresh loop iteration failed", exc_info=True)
            await asyncio.sleep(_PRICING_LOOP_TICK_SECONDS)
    except asyncio.CancelledError:
        pass


def _pricing_payload() -> dict:
    return {
        "models": pricing_store.latest_prices(),
        "last_refresh": {
            "openrouter": pricing_store.last_refresh(pricing_store_module.SOURCE_OPENROUTER),
            "json": pricing_store.last_refresh(pricing_store_module.SOURCE_JSON),
        },
        "next_refresh": pricing_store.next_refresh(pricing_store_module.SOURCE_OPENROUTER),
        "refresh_hours": pricing_store_module.refresh_hours(),
    }


@app.get("/api/pricing")
async def get_pricing():
    """Current effective price per model, plus refresh bookkeeping.

    `models` is the NEWEST snapshot per model (`$/1M tokens`, with null meaning
    "the vendor did not publish this rate" -- distinct from 0.0, which means
    genuinely free). Older snapshots are retained but not returned here; they
    exist so historical costs stay pinned to the rate that was in effect.
    """
    try:
        return JSONResponse(_pricing_payload())
    except Exception:
        logger.error("Failed building pricing payload", exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)


@app.post("/api/pricing/refresh")
async def post_pricing_refresh():
    """Manually poll OpenRouter now, ignoring the cadence.

    Always returns 200 with the refresh outcome (`ok`, `models_seen`,
    `rows_written`, `error`) plus the resulting pricing payload -- a failed poll
    is a reportable result, not a server error, and it leaves prices untouched.
    """
    try:
        result = await asyncio.to_thread(pricing_store.refresh_openrouter)
    except Exception:
        logger.error("Manual pricing refresh failed", exc_info=True)
        result = {"ok": False, "source": pricing_store_module.SOURCE_OPENROUTER,
                  "models_seen": 0, "rows_written": 0, "error": "refresh failed"}
    payload = {"refresh": result}
    try:
        payload.update(_pricing_payload())
    except Exception:
        logger.error("Failed building pricing payload after refresh", exc_info=True)
    return JSONResponse(payload)


# Legacy routes: delegate to the default provider so old clients keep working.


@app.get("/api/local/queue")
async def get_local_queue():
    """Proxy the broker's read-only queue snapshot (GET :broker/queue).

    Returns the broker JSON verbatim on success; 503 {reachable: false} when
    the broker is down/unreachable so the frontend renders a dim 'offline'
    state without console noise.
    """
    return await get_provider_queue(_DEFAULT_PROVIDER)


# ── Unified Prometheus exporter (Cockpit as the fleet metrics hub) ──
#
# vLLM speaks Prometheus natively; LM Studio (behind the broker) does NOT. Since
# Cockpit already holds every provider's stats via its adapters, it re-exports
# them ALL as one Prometheus target at GET /metrics, each series labeled by
# provider — so Prometheus/Grafana see every backend (vLLM + LM Studio + future)
# side by side from a single scrape. Read-only; best-effort per provider.

def _provider_snapshot(provider: dict) -> dict:
    """Blocking: normalized {metrics, queue, up} for one provider (or up:False)."""
    caps = provider.get("capabilities", [])
    out = {"up": False, "metrics": None, "queue": None}
    if "metrics" in caps:
        try:
            if provider.get("kind") == "vllm":
                out["metrics"] = _vllm_metrics(provider["broker_url"], "lifetime")
            else:
                out["metrics"] = _broker_get("/metrics", "window=lifetime", provider["broker_url"])
            out["up"] = True
        except Exception:
            logger.debug("Prometheus export: %s metrics unreachable", provider["id"], exc_info=True)
            # vLLM offline: keep exporting persisted lifetime so the Grafana
            # series stays continuous (up=0 but counters don't drop to nothing).
            if provider.get("kind") == "vllm":
                out["metrics"] = _vllm_offline_snapshot()
    if "queue" in caps:
        try:
            out["queue"] = _broker_get("/queue", "", provider["broker_url"])
            out["up"] = True
        except Exception:
            logger.debug("Prometheus export: %s queue unreachable", provider["id"], exc_info=True)
    if "models" in caps:
        try:
            md = _mgmt_get(provider, _models_path(provider))
            rows = md.get("data") or md.get("models") or []
            ceilings = [m.get("max_model_len") or m.get("max_context_length") for m in rows]
            ceilings = [c for c in ceilings if isinstance(c, (int, float)) and c > 0]
            out["model_max"] = max(ceilings) if ceilings else None
        except Exception:
            logger.debug("Prometheus export: %s models unreachable", provider["id"], exc_info=True)
    return out


def _render_prometheus(pairs: list) -> str:
    """Render (provider, snapshot) pairs as Prometheus text-exposition format.

    Emits a stable ``cockpit_provider_*`` gauge family, each series labeled
    ``provider`` + ``kind``. Null sub-values are skipped (no misleading zeros).
    """
    seen_help: set = set()
    lines: list = []

    def emit(name, help_text, provider, kind, value):
        if value is None:
            return
        try:
            v = float(value)
        except (TypeError, ValueError):
            return
        if name not in seen_help:
            lines.append(f"# HELP {name} {help_text}")
            lines.append(f"# TYPE {name} gauge")
            seen_help.add(name)
        pid = str(provider).replace("\\", "").replace('"', "")
        k = str(kind).replace("\\", "").replace('"', "")
        lines.append(f'{name}{{provider="{pid}",kind="{k}"}} {v}')

    for provider, snap in pairs:
        pid = provider["id"]
        kind = provider.get("kind", "")
        emit("cockpit_provider_up", "1 if the provider answered this scrape", pid, kind, 1 if snap["up"] else 0)
        m = snap.get("metrics")
        if isinstance(m, dict) and m.get("reachable") is not False:
            tt = m.get("tokens_total") or {}
            emit("cockpit_provider_runs_total", "Completed runs (lifetime)", pid, kind, m.get("runs_total"))
            emit("cockpit_provider_prompt_tokens_total", "Prompt tokens (lifetime)", pid, kind, tt.get("prompt"))
            emit("cockpit_provider_completion_tokens_total", "Completion tokens (lifetime)", pid, kind, tt.get("completion"))
            tps = m.get("tokens_per_sec") or {}
            emit("cockpit_provider_tps", "Tokens/sec (completion ÷ wall)", pid, kind, tps.get("avg") if tps.get("avg") is not None else tps.get("current"))
            dec = m.get("decode_tokens_per_sec") or {}
            emit("cockpit_provider_decode_tps", "Per-stream decode tokens/sec", pid, kind, dec.get("avg") if dec.get("avg") is not None else dec.get("current"))
            ttft = m.get("ttft_ms") or {}
            emit("cockpit_provider_ttft_p50_seconds", "Time-to-first-token p50", pid, kind, (ttft.get("p50") / 1000) if isinstance(ttft.get("p50"), (int, float)) else None)
            emit("cockpit_provider_ttft_p95_seconds", "Time-to-first-token p95", pid, kind, (ttft.get("p95") / 1000) if isinstance(ttft.get("p95"), (int, float)) else None)
            rt = m.get("run_time_ms") or {}
            emit("cockpit_provider_run_time_p50_seconds", "Wall time per run p50", pid, kind, (rt.get("p50") / 1000) if isinstance(rt.get("p50"), (int, float)) else None)
            emit("cockpit_provider_run_time_p95_seconds", "Wall time per run p95", pid, kind, (rt.get("p95") / 1000) if isinstance(rt.get("p95"), (int, float)) else None)
            eng = m.get("engine") or {}
            emit("cockpit_provider_running", "Requests decoding now (in-engine)", pid, kind, eng.get("running"))
            emit("cockpit_provider_waiting", "Requests waiting (in-engine)", pid, kind, eng.get("waiting"))
            emit("cockpit_provider_kv_cache_pct", "KV-cache utilization %", pid, kind, eng.get("kv_cache_pct"))
            ctx = m.get("context") or {}
            cin = ctx.get("in") or {}
            cout = ctx.get("out") or {}
            emit("cockpit_provider_req_prompt_tokens_avg", "Avg prompt (input) tokens per request", pid, kind, cin.get("avg"))
            emit("cockpit_provider_req_prompt_tokens_p95", "p95 prompt (input) tokens per request", pid, kind, cin.get("p95"))
            emit("cockpit_provider_req_completion_tokens_avg", "Avg completion (output) tokens per request", pid, kind, cout.get("avg"))
            emit("cockpit_provider_req_completion_tokens_p95", "p95 completion (output) tokens per request", pid, kind, cout.get("p95"))
            emit("cockpit_provider_model_max_tokens", "Model max context window (ceiling)", pid, kind, snap.get("model_max"))
        q = snap.get("queue")
        if isinstance(q, dict) and q.get("reachable") is not False:
            depth = (1 if q.get("in_flight") else 0) + (len(q["queued"]) if isinstance(q.get("queued"), list) else 0)
            emit("cockpit_provider_queue_depth", "Broker queue depth (in-flight + queued)", pid, kind, depth)

    return "\n".join(lines) + "\n"


@app.get("/metrics")
async def prometheus_metrics():
    """Unified Prometheus scrape for ALL registered providers (fleet hub)."""
    providers = list(_PROVIDERS.values())
    snaps = await asyncio.gather(*[asyncio.to_thread(_provider_snapshot, p) for p in providers])
    body = _render_prometheus(list(zip(providers, snaps)))
    return Response(body, media_type="text/plain; version=0.0.4; charset=utf-8")


# ── Time-series history (Prometheus proxy for the in-app History view) ──
#
# Cockpit fronts its own themed History view instead of Grafana. PromQL stays
# SERVER-SIDE (curated named metrics only) — the browser sends a metric key +
# provider + window, never raw PromQL, and never learns the Prometheus URL
# (same SSRF stance as the broker proxy). Read-only.

_PROMETHEUS_URL = os.getenv("COCKPIT_PROMETHEUS_URL", "http://127.0.0.1:9491").rstrip("/")

# metric key -> PromQL template (%s = provider label regex). All are gauges the
# Cockpit exporter emits, so query_range over them is a clean time-series.
_TSDB_METRICS = {
    "throughput_tps": 'cockpit_provider_tps{provider=~"%s"}',
    "decode_tps": 'cockpit_provider_decode_tps{provider=~"%s"}',
    "queue_depth": 'cockpit_provider_queue_depth{provider=~"%s"}',
    "running": 'cockpit_provider_running{provider=~"%s"}',
    "waiting": 'cockpit_provider_waiting{provider=~"%s"}',
    "kv_cache_pct": 'cockpit_provider_kv_cache_pct{provider=~"%s"}',
    "ttft_p95_seconds": 'cockpit_provider_ttft_p95_seconds{provider=~"%s"}',
    "run_time_p95_seconds": 'cockpit_provider_run_time_p95_seconds{provider=~"%s"}',
    "prompt_tokens_p95": 'cockpit_provider_req_prompt_tokens_p95{provider=~"%s"}',
    "completion_tokens_p95": 'cockpit_provider_req_completion_tokens_p95{provider=~"%s"}',
    "runs_total": 'cockpit_provider_runs_total{provider=~"%s"}',
}
# window -> (range seconds, step seconds)
_TSDB_WINDOWS = {
    "session": (3600, 15),
    "24h": (86400, 300),
    "7d": (604800, 3600),
    "lifetime": (2592000, 21600),
}
_TSDB_PROVIDER_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")


@app.get("/api/tsdb/status")
async def tsdb_status():
    """Is the Prometheus history store reachable? (History view gates on this.)"""
    try:
        await asyncio.to_thread(_http_get_text, _PROMETHEUS_URL + "/-/ready")
        return JSONResponse({"reachable": True})
    except Exception:
        return JSONResponse({"reachable": False})


@app.get("/api/tsdb/query_range")
async def tsdb_query_range(metric: str, provider: str = "all", window: str = "24h"):
    """Curated time-series for the in-app History view. Server owns the PromQL."""
    expr = _TSDB_METRICS.get(metric)
    if expr is None:
        return JSONResponse({"error": "unknown metric"}, status_code=404)
    if window not in _TSDB_WINDOWS:
        return JSONResponse({"error": "unknown window"}, status_code=400)
    if provider != "all" and not _TSDB_PROVIDER_RE.match(provider):
        return JSONResponse({"error": "invalid provider"}, status_code=400)
    import urllib.parse
    prov = ".*" if provider == "all" else provider
    span, step = _TSDB_WINDOWS[window]
    now = int(_time.time())
    query = urllib.parse.urlencode({"query": expr % prov, "start": now - span, "end": now, "step": step})
    try:
        data = await asyncio.to_thread(_broker_get, "/api/v1/query_range", query, _PROMETHEUS_URL)
    except Exception:
        logger.debug("TSDB query_range unreachable (metric=%s)", metric, exc_info=True)
        return JSONResponse({"reachable": False}, status_code=503)
    return JSONResponse(data)


# ── In-app history from Cockpit's OWN store (no Prometheus dependency) ──

@app.get("/api/history/status")
async def history_status():
    """History is derived from Cockpit's own JSONL — always 'reachable'; report
    how many samples have accrued so the UI can show an empty-until-warm state."""
    try:
        with open(_FLEET_LOG, "r", encoding="utf-8") as f:
            n = sum(1 for _ in f)
    except FileNotFoundError:
        n = 0
    return JSONResponse({"reachable": True, "samples": n})


@app.get("/api/history/query")
async def history_query(metric: str, provider: str = "all", window: str = "24h"):
    """Curated time-series from Cockpit's fleet log — the self-contained History
    view backend (replaces the Prometheus proxy; no external TSDB needed)."""
    field = _FLEET_METRICS.get(metric)
    if field is None:
        return JSONResponse({"error": "unknown metric"}, status_code=404)
    if window not in _FLEET_WINDOW_S:
        return JSONResponse({"error": "unknown window"}, status_code=400)
    if provider != "all" and not _TSDB_PROVIDER_RE.match(provider):
        return JSONResponse({"error": "invalid provider"}, status_code=400)
    grouped = await asyncio.to_thread(_query_fleet_history, field, provider, _FLEET_WINDOW_S[window])
    series = [{"provider": pid, "kind": g["kind"], "points": g["points"]} for pid, g in grouped.items()]
    return JSONResponse({"reachable": True, "series": series})


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
