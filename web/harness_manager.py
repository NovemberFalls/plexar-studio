"""Plexar Harness support: the key, the rig URL, the model catalog, and an ACP
runtime registry (one `HarnessRuntime` per workspace).

Studio's `plexar-harness` PANES are PTY terminals running the `plexar-harness`
CLI (pty_manager.create_terminal, like codex); they read `get_key()` and
`resolve_rig_url()` from here. The ACP side below is used only by the lazy
`/api/harness/models` probe and by the registry's own tests. The harness speaks
ACP over the child's stdio; `plexar_harness_client`
(vendored byte-for-byte, contract v3) is the whole wire. This module owns the
Studio side: the key, the per-workspace runtime registry, the update pump, the
permission round-trip to the browser, per-session labels and idle stop.

Rules that are load-bearing (harness docs/plexar/07-studio-api-contract.md v3):

- The key is ``PLEXAR_HARNESS_KEY`` (never ``PLEXAR_API_KEY``), stored in
  config.json beside the other secrets, NEVER settings.json, never returned or
  logged. It is ALWAYS set in the child env; with no key configured we refuse
  with reason ``key_missing`` and do not spawn -- an unset env would let a key
  from the harness's own credential files leak in.
- ``start()`` and every client call block, so they run in ``asyncio.to_thread``.
- One pump thread per runtime iterates ``runtime.updates()`` in arrival order and
  hands each Update to the loop with ``call_soon_threadsafe``. ``drain()`` is
  never used: it reorders.
- ``on_permission`` runs on the client's own thread. It blocks on a
  ``threading.Event`` for up to 120 s; a timeout or an absent subscriber answers
  ``reject-once`` (fail closed).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlparse

import app_paths
import settings_store
from plexar_harness_client import HarnessError, HarnessRuntime

logger = logging.getLogger("cockpit.harness")

KEY_FIELD = "plexar_harness_key"
PERMISSION_TIMEOUT_S = 120.0
IDLE_STOP_AFTER_S = 600.0
MAX_LIST_PAGES = 10
ALLOWED_OPTIONS = ("allow-once", "reject-once")
MIN_NODE = (22, 19)

FRIENDLY = {
    "key_missing": "No Plexar Harness key is set. Add one in Settings.",
    "key_rejected": "The model server rejected your Plexar Harness key.",
    "rig_unreachable": "The model server did not answer. Check that it is running.",
    "node_too_old": "Node.js 22.19 or newer is required to run the Plexar Harness.",
    "profile_install_failed": "The Plexar Harness could not create its plexar-acp profile.",
    "bad_rig_url": "The Plexar Harness rig URL in Settings is not a valid http(s) address.",
}
DEFAULT_FRIENDLY = "The Plexar Harness could not start."


def friendly(reason: str | None) -> str:
    return FRIENDLY.get(reason or "", DEFAULT_FRIENDLY)


# ---------------------------------------------------------------------------
# Key (config.json, the secrets file) -- same shape as remote_tunnel's token
# ---------------------------------------------------------------------------

def key_source() -> str | None:
    """Where this user's harness key comes from: "settings" (saved in Studio's
    config.json), "environment" (PLEXAR_HARNESS_KEY in Studio's own process env,
    which is the harness's documented variable), or None.

    Both are per OS user. The harness's OWN fallbacks (its stored-credentials file,
    project and harness-home .env) are still never used: Studio always passes the key
    it resolved here, and refuses to start when there is none (DEC-229)."""
    value = settings_store._read_config().get(KEY_FIELD)
    if isinstance(value, str) and value:
        return "settings"
    if os.environ.get("PLEXAR_HARNESS_KEY"):
        return "environment"
    return None


def get_key() -> str | None:
    value = settings_store._read_config().get(KEY_FIELD)
    if isinstance(value, str) and value:
        return value
    return os.environ.get("PLEXAR_HARNESS_KEY") or None


def set_key(key: str) -> None:
    data = settings_store._read_config()
    data[KEY_FIELD] = key
    settings_store._write_config(data)


def clear_key() -> None:
    data = settings_store._read_config()
    if KEY_FIELD in data:
        del data[KEY_FIELD]
        settings_store._write_config(data)


def _harness_settings() -> dict:
    try:
        block = settings_store.read_settings().get("harness") or {}
    except Exception:  # noqa: BLE001 - a damaged settings file must not break the harness
        logger.warning("Could not read harness settings", exc_info=True)
        return {}
    return block if isinstance(block, dict) else {}


def permission_mode() -> str:
    return str(_harness_settings().get("permission_mode") or "workspace-write")


def _valid_http_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.netloc)


def resolve_rig_url(settings: dict) -> tuple[str | None, str]:
    """Rig URL precedence, three tiers:

    1. ``harness.rig_url`` setting, if non-empty -- validated http(s); a set
       but invalid value raises HarnessError(reason="bad_rig_url"), a graceful
       refusal, never an unhandled exception.
    2. else the resolved Plexar provider ``base_url``
       (``settings_store.resolve_plexar_base_url()`` -- the SAME precedence
       server.py's ``_plexar_config`` uses: stored setting -> COCKPIT_PLEXAR_URL
       env -> loopback default), if non-empty.
    3. else ``(None, "harness_default")`` -- PLEXAR_RIG_URL is omitted from the
       runtime env entirely and the harness falls back to its own built-in
       default.

    Returns ``(url_or_None, source)`` where source is
    ``"harness"|"plexar_provider"|"harness_default"``.
    """
    rig_url = str(settings.get("rig_url") or "").strip()
    if rig_url:
        if not _valid_http_url(rig_url):
            raise HarnessError("harness.rig_url setting is not a valid http(s) URL", None, "bad_rig_url")
        return rig_url, "harness"
    provider_url = settings_store.resolve_plexar_base_url()
    if provider_url:
        return provider_url, "plexar_provider"
    return None, "harness_default"


def _build_env(api_key: str, settings: dict) -> tuple[dict[str, str], str]:
    """The runtime child env, plus the rig_url_source that resolved it. See
    `resolve_rig_url` for the precedence. Raises HarnessError(reason=
    "bad_rig_url") the same way `resolve_rig_url` does."""
    env = {
        "PLEXAR_HARNESS_KEY": api_key,
        "DSH_PERMISSION_MODE": str(settings.get("permission_mode") or "workspace-write"),
    }
    rig_url, source = resolve_rig_url(settings)
    if rig_url:
        env["PLEXAR_RIG_URL"] = rig_url
    return env, source


# ---------------------------------------------------------------------------
# Model/effort catalog -- session-observed configOptions, cached in memory and
# persisted to disk. See tests/fixtures/harness_config_options_live.json for
# the real shape captured 2026-09-23 against https://plexar-llm.boord-its.com:
# configOptions is a list of {id, name, category, type, currentValue, options}.
# The "model" entry's `options` is a list of GROUPS ({group, name, options}),
# each group's `options` a list of {value, name} leaves -- `value` is itself a
# JSON-encoded string (e.g. '["plexar","qwen3.8-27b"]') and IS what set_config
# expects as its `value` argument, so it is used verbatim as our model id.
# The "reasoning_effort" entry is FLAT (no groups): a list of {value, name}.
#
# Effort is per-model, and it is derived from the CURRENTLY SELECTED model
# (contract docs/plexar/07-studio-api-contract.md, "Effort is per model"):
# `reasoning_effort` can be entirely absent from a configOptions reply for a
# model that declares no reasoning. There is exactly one model, `qwen3.8-27b`,
# available on the live rig today; only ONE model's efforts have ever been
# observed. `parse_models_from_config_options` therefore applies the single
# observed `reasoning_effort` list (or `None` if absent) to every model in the
# SAME reply -- there is no known shape yet for per-model effort lists among
# several models at once, and none is invented here.
#
# There is deliberately NO rig `/v1/models` HTTP fallback: that endpoint lists
# `plexar-signal` (a classifier, `/v1/evaluate`, never a selectable chat
# model) indistinguishably from `qwen3.8-27b`, and carries no effort data.
# Sources are exactly "session" (in-memory, this process) | "cache" (the last
# session-observed data, persisted to disk, read back after a restart) |
# "none" (never observed, this process or a prior one).
# ---------------------------------------------------------------------------

_config_cache_lock = threading.Lock()
_last_config_options: list[dict] | None = None
_MODELS_CACHE_FILENAME = "harness_models_cache.json"


def _models_cache_path() -> Path:
    return app_paths.data_path(_MODELS_CACHE_FILENAME)


def _write_models_cache(config_options: list[dict]) -> None:
    """Atomic temp-file + rename, same pattern as `write_label`. Best-effort:
    a failed cache write must not break the in-memory session source."""
    path = _models_cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"configOptions": config_options}, fh)
        os.replace(tmp, path)
    except OSError:
        logger.warning("Could not write the harness models cache", exc_info=True)


def _read_models_cache() -> list[dict] | None:
    path = _models_cache_path()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return None
    except (OSError, ValueError):
        logger.warning("Could not read harness models cache at %s", path, exc_info=True)
        return None
    config_options = data.get("configOptions") if isinstance(data, dict) else None
    return config_options if isinstance(config_options, list) else None


def record_config_options(config_options: list[dict] | None) -> None:
    """Cache the most recent configOptions seen from ANY harness session
    (new_session, resume_session, a set_config_option reply, or a
    config_option_update frame). Most recent wins, across the whole process --
    there is one Plexar rig. Also persists to disk so a later process restart
    still has a "cache"-sourced answer instead of "none". Does blocking disk
    I/O -- callers off the update-pump thread must wrap it in
    `asyncio.to_thread`."""
    global _last_config_options, _last_config_at
    if not config_options:
        return
    with _config_cache_lock:
        _last_config_options = config_options
        _last_config_at = time.time()
    _write_models_cache(config_options)


def _flatten_model_leaves(option_entry: dict) -> list[dict]:
    """Flatten the "model" configOption's (possibly grouped) `options` into a
    flat list of {"id": value, "label": name}."""
    leaves: list[dict] = []
    for opt in option_entry.get("options") or []:
        if not isinstance(opt, dict):
            continue
        if "options" in opt:  # a group: {group, name, options: [...]}
            for leaf in opt.get("options") or []:
                if isinstance(leaf, dict) and leaf.get("value"):
                    leaves.append({"id": leaf["value"], "label": leaf.get("name") or leaf["value"]})
        elif opt.get("value"):  # an ungrouped leaf
            leaves.append({"id": opt["value"], "label": opt.get("name") or opt["value"]})
    return leaves


def _flatten_effort_values(option_entry: dict) -> list[str]:
    """`""` ("Provider default") is a REAL value, never dropped -- checked
    with `is not None`/`"value" in opt`, never truthiness."""
    values: list[str] = []
    for opt in option_entry.get("options") or []:
        if isinstance(opt, dict) and "value" in opt and opt["value"] is not None and opt["value"] not in values:
            values.append(opt["value"])
    return values


def parse_models_from_config_options(config_options: list[dict]) -> list[dict]:
    """[{"id", "label", "efforts": [...] | None}]. `efforts: None` means the
    reply carried no `reasoning_effort` entry at all (genuinely unknown for
    this model -- distinct from `efforts: []`, which would mean the entry was
    present but offered nothing, not observed on the live rig to date)."""
    model_entry = next((c for c in config_options if isinstance(c, dict) and c.get("id") == "model"), None)
    effort_entry = next((c for c in config_options if isinstance(c, dict) and c.get("id") == "reasoning_effort"), None)
    models = _flatten_model_leaves(model_entry) if model_entry else []
    efforts = _flatten_effort_values(effort_entry) if effort_entry is not None else None
    return [{"id": m["id"], "label": m["label"], "efforts": list(efforts) if efforts is not None else None}
            for m in models]


# ---------------------------------------------------------------------------
# Lazy models probe. Nothing refreshes the cache now that sessions run in a PTY
# (the `plexar-harness` CLI owns its own ACP), so GET /api/harness/models does
# ONE short-lived probe: a runtime in a throwaway temp dir, new_session, read its
# configOptions, stop. Only when the cache is empty or older than 24 h, never two
# at once (a non-blocking lock: a second caller answers from the cache it has),
# and never at startup -- only when the route is actually asked.
# ---------------------------------------------------------------------------

PROBE_MAX_AGE_S = 24 * 3600.0
_probe_lock = threading.Lock()
_last_config_at: float | None = None
# Read at call time so tests can swap in a fake runtime.
_probe_runtime_factory: Callable[..., Any] = HarnessRuntime


def _cache_observed_at() -> float | None:
    """When the newest cached configOptions were observed: this process's own
    record if any, else the disk cache's mtime, else None (never observed)."""
    with _config_cache_lock:
        if _last_config_options and _last_config_at is not None:
            return _last_config_at
    try:
        return os.path.getmtime(_models_cache_path())
    except FileNotFoundError:
        return None
    except OSError:
        logger.warning("Could not stat the harness models cache", exc_info=True)
        return None


def models_cache_stale(now: float | None = None) -> bool:
    observed = _cache_observed_at()
    if observed is None:
        return True
    return ((now if now is not None else time.time()) - observed) >= PROBE_MAX_AGE_S


def probe_models_if_stale(runtime_factory: Callable[..., Any] | None = None) -> bool:
    """Blocking; call via `asyncio.to_thread`. Returns True when a probe ran and
    recorded configOptions. A missing key, a bad rig URL or a runtime failure is
    logged and skipped: the route then answers from whatever cache exists."""
    if not models_cache_stale():
        return False
    if not _probe_lock.acquire(blocking=False):
        logger.info("A harness models probe is already running; answering from the cache")
        return False
    try:
        if not models_cache_stale():  # another probe finished while we queued
            return False
        api_key = get_key()
        if not api_key:
            logger.info("Harness models probe skipped: no Plexar Harness key")
            return False
        settings = _harness_settings()
        try:
            env, _source = _build_env(api_key, settings)
        except HarnessError:
            logger.warning("Harness models probe skipped: bad rig URL setting", exc_info=True)
            return False
        tmp = tempfile.mkdtemp(prefix="plexar_harness_probe_")
        kwargs: dict[str, Any] = {"workspace": Path(tmp), "env": env,
                                  "on_permission": lambda _params: "reject-once"}
        root = str(settings.get("root") or "").strip()
        if root:
            kwargs["harness_root"] = Path(root)
        runtime = None
        try:
            runtime = (runtime_factory or _probe_runtime_factory)(**kwargs)
            runtime.start()
            res = runtime.new_session() or {}
            config_options = res.get("configOptions") or []
            record_config_options(config_options)
            logger.info("Harness models probe observed %d config option(s)", len(config_options))
            return bool(config_options)
        except Exception:  # noqa: BLE001 - a failed probe must never fail the route
            logger.warning("Harness models probe failed", exc_info=True)
            return False
        finally:
            if runtime is not None:
                try:
                    runtime.stop()
                except Exception:  # noqa: BLE001
                    logger.warning("Stopping the harness models probe runtime failed", exc_info=True)
            shutil.rmtree(tmp, ignore_errors=True)
    finally:
        _probe_lock.release()


def list_models() -> dict:
    """{"models": [...], "source": "session"|"cache"|"none"}. The Plexar key
    never appears in the result or in a log line from this function. No rig
    HTTP fallback -- see the module comment above `_config_cache_lock`."""
    with _config_cache_lock:
        cached = _last_config_options
    if cached:
        return {"models": parse_models_from_config_options(cached), "source": "session"}
    disk = _read_models_cache()
    if disk:
        return {"models": parse_models_from_config_options(disk), "source": "cache"}
    return {"models": [], "source": "none"}


# ---------------------------------------------------------------------------
# Labels (~/.plexar-studio/harness_labels.json, {session_id: label})
# ---------------------------------------------------------------------------

_labels_lock = threading.Lock()


def _labels_path() -> Path:
    return app_paths.data_path("harness_labels.json")


def read_labels() -> dict[str, str]:
    path = _labels_path()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("Could not read harness labels at %s", path, exc_info=True)
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}


def write_label(session_id: str, label: str | None) -> None:
    with _labels_lock:
        labels = read_labels()
        if label:
            labels[session_id] = label
        else:
            labels.pop(session_id, None)
        path = _labels_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(labels, fh, indent=2)
        os.replace(tmp, path)


# Known sessions (~/.plexar-studio/harness_sessions.json, {session_id: workspace})
#
# Listing must NEVER start a runtime. The sidebar asks for every saved location at
# once, and a runtime per ask launched 71 node processes at startup (2.1.41 owner QA:
# no session of any kind could launch until they idled out). A workspace with no live
# runtime is answered from this record of the sessions Studio itself created or
# resumed there. Sessions made outside Studio appear once a runtime for that folder runs.

def _known_path() -> Path:
    return app_paths.data_path("harness_sessions.json")


def read_known_sessions() -> dict[str, str]:
    path = _known_path()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        logger.warning("Could not read known harness sessions at %s", path, exc_info=True)
        return {}
    return {str(k): str(v) for k, v in data.items() if isinstance(v, str)} if isinstance(data, dict) else {}


def remember_session(session_id: str, workspace_key: str) -> None:
    with _labels_lock:
        known = read_known_sessions()
        if known.get(session_id) == workspace_key:
            return
        known[session_id] = workspace_key
        path = _known_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(known, fh, indent=2)
        os.replace(tmp, path)


# ---------------------------------------------------------------------------
# Status probes
# ---------------------------------------------------------------------------

def _node_version() -> str | None:
    try:
        out = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=3,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        logger.info("node --version failed", exc_info=True)
        return None
    version = (out.stdout or "").strip()
    return version or None


def node_ok(version: str | None) -> bool:
    m = re.match(r"v?(\d+)\.(\d+)", version or "")
    return bool(m) and (int(m.group(1)), int(m.group(2))) >= MIN_NODE


def normalize_workspace(workspace: str | None) -> str:
    """The registry key. Raises ValueError for a missing/relative/non-directory path."""
    if not workspace or not isinstance(workspace, str) or not os.path.isabs(workspace):
        raise ValueError("workspace must be an absolute path")
    if not os.path.isdir(workspace):
        raise ValueError("workspace is not a directory")
    return os.path.normcase(os.path.abspath(workspace))


class SessionBusy(Exception):
    pass


class UnknownSession(Exception):
    pass


class _Entry:
    def __init__(self, key: str, workspace: str, runtime: Any, env: dict[str, str] | None = None,
                 rig_url_source: str = "harness_default") -> None:
        self.key = key
        self.workspace = workspace
        self.runtime = runtime
        self.open: set[str] = set()
        self.stopping = False
        self.env = dict(env or {})
        self.rig_url_source = rig_url_source


class HarnessManager:
    def __init__(self, runtime_factory: Callable[..., Any] = HarnessRuntime,
                 permission_timeout: float = PERMISSION_TIMEOUT_S,
                 idle_stop_after: float = IDLE_STOP_AFTER_S) -> None:
        self.runtime_factory = runtime_factory
        self.permission_timeout = permission_timeout
        self.idle_stop_after = idle_stop_after
        self._loop: asyncio.AbstractEventLoop | None = None
        self._runtimes: dict[str, _Entry] = {}
        self._start_locks: dict[str, asyncio.Lock] = {}
        self._subs: dict[str, set[asyncio.Queue]] = {}
        self._idle_timers: dict[str, asyncio.TimerHandle] = {}
        self._session_ws: dict[str, str] = {}
        self._busy: set[str] = set()
        self._tasks: set[asyncio.Task] = set()
        self._permissions: dict[str, dict] = {}
        self._perm_lock = threading.Lock()

    # -- plumbing --------------------------------------------------------------
    def _bind_loop(self) -> asyncio.AbstractEventLoop:
        self._loop = asyncio.get_running_loop()
        return self._loop

    def _broadcast(self, key: str, frame: dict) -> None:
        for q in list(self._subs.get(key, ())):
            q.put_nowait(frame)

    def _threadsafe_broadcast(self, key: str, frame: dict) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._broadcast, key, frame)
        except RuntimeError:
            logger.info("Loop closed; dropped a harness frame", exc_info=True)

    # -- runtimes --------------------------------------------------------------
    def _entry_busy(self, entry: _Entry) -> bool:
        return any(self._session_ws.get(s) == entry.key for s in self._busy)

    async def _restart_if_env_changed(self, entry: _Entry) -> _Entry | None:
        """Returns the entry unchanged (keep using it), or None after stopping
        it (caller falls through and starts a fresh one). A runtime already
        started keeps its existing env even if the setting changes later,
        UNTIL the next ensure_runtime call with no prompt in flight for it."""
        api_key = await asyncio.to_thread(get_key)
        if not api_key:
            return entry
        settings = await asyncio.to_thread(_harness_settings)
        try:
            desired_env, _desired_source = await asyncio.to_thread(_build_env, api_key, settings)
        except HarnessError:
            # A now-bad rig_url setting must not kill a runtime that is
            # already running fine on its old env.
            return entry
        if desired_env == entry.env:
            return entry
        if self._entry_busy(entry):
            return entry
        logger.info("Harness settings changed for %s; restarting the runtime", entry.workspace)
        await self._stop_entry(entry)
        return None

    async def ensure_runtime(self, workspace: str) -> _Entry:
        key = normalize_workspace(workspace)
        self._bind_loop()
        entry = self._runtimes.get(key)
        if entry is not None:
            entry = await self._restart_if_env_changed(entry)
            if entry is not None:
                return entry
        lock = self._start_locks.setdefault(key, asyncio.Lock())
        async with lock:
            entry = self._runtimes.get(key)
            if entry is not None:
                entry = await self._restart_if_env_changed(entry)
                if entry is not None:
                    return entry
            api_key = await asyncio.to_thread(get_key)
            if not api_key:
                raise HarnessError("no PLEXAR_HARNESS_KEY configured", None, "key_missing")
            settings = await asyncio.to_thread(_harness_settings)
            env, rig_url_source = await asyncio.to_thread(_build_env, api_key, settings)
            kwargs: dict[str, Any] = {
                "workspace": Path(workspace),
                "env": env,
                "on_permission": self._permission_handler(key),
            }
            root = str(settings.get("root") or "").strip()
            if root:
                kwargs["harness_root"] = Path(root)
            runtime = self.runtime_factory(**kwargs)
            try:
                await asyncio.to_thread(runtime.start)
            except Exception as exc:
                logger.warning("Harness runtime failed to start for %s (reason=%s)", workspace,
                               getattr(exc, "reason", None), exc_info=True)
                try:
                    await asyncio.to_thread(runtime.stop)
                except Exception:
                    logger.warning("Stopping a failed harness runtime failed", exc_info=True)
                raise
            entry = _Entry(key, workspace, runtime, env, rig_url_source)
            self._runtimes[key] = entry
            threading.Thread(target=self._pump, args=(entry,), name=f"harness-pump-{len(self._runtimes)}",
                             daemon=True).start()
            logger.info("Harness runtime started for %s", workspace)
            self._schedule_idle_check(key)
            return entry

    def _pump(self, entry: _Entry) -> None:
        try:
            for upd in entry.runtime.updates():
                if upd.kind == "config_option_update" and isinstance(upd.payload, dict):
                    record_config_options(upd.payload.get("configOptions"))
                self._threadsafe_broadcast(entry.key, {
                    "type": "update", "session_id": upd.session_id, "kind": upd.kind, "payload": upd.payload,
                })
        except Exception:
            logger.error("Harness update pump crashed", exc_info=True)
        loop = self._loop
        if loop is not None and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._runtime_exited, entry)
            except RuntimeError:
                logger.info("Loop closed before runtime exit was reported", exc_info=True)

    def _runtime_exited(self, entry: _Entry) -> None:
        if self._runtimes.get(entry.key) is entry:
            del self._runtimes[entry.key]
        for sid in [s for s, k in self._session_ws.items() if k == entry.key]:
            self._session_ws.pop(sid, None)
            self._busy.discard(sid)
        if entry.stopping:
            return
        proc = getattr(entry.runtime, "_proc", None)
        exit_code = None
        try:
            exit_code = proc.poll() if proc is not None else None
        except Exception:
            logger.warning("Could not read harness exit code", exc_info=True)
        reason = None
        for line in reversed(list(getattr(entry.runtime, "stderr_tail", []) or [])):
            m = re.match(r"plexar-harness: error (\w+):", line)
            if m:
                reason = m.group(1)
                break
        logger.warning("Harness runtime for %s exited (code=%s reason=%s)", entry.workspace, exit_code, reason)
        self._broadcast(entry.key, {
            "type": "runtime_error", "reason": reason, "exit_code": exit_code,
            "message": friendly(reason) if reason else "The Plexar Harness stopped unexpectedly.",
        })

    async def _stop_entry(self, entry: _Entry) -> None:
        entry.stopping = True
        if self._runtimes.get(entry.key) is entry:
            del self._runtimes[entry.key]
        try:
            await asyncio.to_thread(entry.runtime.stop)
        except Exception:
            logger.warning("Stopping harness runtime for %s failed", entry.workspace, exc_info=True)

    async def stop_all(self) -> None:
        for timer in self._idle_timers.values():
            timer.cancel()
        self._idle_timers.clear()
        for entry in list(self._runtimes.values()):
            await self._stop_entry(entry)
        with self._perm_lock:
            pending = list(self._permissions.values())
            self._permissions.clear()
        for rec in pending:
            rec["event"].set()

    # -- subscribers & idle stop ---------------------------------------------
    def subscribe(self, workspace: str) -> tuple[str, asyncio.Queue]:
        key = normalize_workspace(workspace)
        self._bind_loop()
        q: asyncio.Queue = asyncio.Queue()
        self._subs.setdefault(key, set()).add(q)
        timer = self._idle_timers.pop(key, None)
        if timer:
            timer.cancel()
        return key, q

    def unsubscribe(self, key: str, q: asyncio.Queue) -> None:
        subs = self._subs.get(key)
        if subs:
            subs.discard(q)
            if not subs:
                del self._subs[key]
        self._schedule_idle_check(key)

    def _schedule_idle_check(self, key: str) -> None:
        if self._subs.get(key) or key not in self._runtimes or self._loop is None:
            return
        old = self._idle_timers.pop(key, None)
        if old:
            old.cancel()
        self._idle_timers[key] = self._loop.call_later(self.idle_stop_after, self._idle_fire, key)

    def _idle_fire(self, key: str) -> None:
        self._idle_timers.pop(key, None)
        entry = self._runtimes.get(key)
        if entry is None or self._subs.get(key):
            return
        if any(self._session_ws.get(s) == key for s in self._busy):
            self._schedule_idle_check(key)
            return
        logger.info("Stopping idle harness runtime for %s", entry.workspace)
        task = asyncio.ensure_future(self._stop_entry(entry))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    # -- permissions -----------------------------------------------------------
    def _permission_handler(self, key: str) -> Callable[[dict], str]:
        def handler(params: dict) -> str:
            if not self._subs.get(key):
                logger.info("Harness permission request with no subscriber; rejecting")
                return "reject-once"
            request_id = uuid.uuid4().hex
            rec = {"event": threading.Event(), "choice": None, "key": key}
            with self._perm_lock:
                self._permissions[request_id] = rec
            self._threadsafe_broadcast(key, {
                "type": "permission", "request_id": request_id,
                "session_id": (params or {}).get("sessionId"), "params": params,
            })
            answered = rec["event"].wait(self.permission_timeout)
            with self._perm_lock:
                self._permissions.pop(request_id, None)
            choice = rec["choice"] if answered else None
            return choice if choice in ALLOWED_OPTIONS else "reject-once"
        return handler

    def answer_permission(self, request_id: str, option_id: str) -> bool:
        with self._perm_lock:
            rec = self._permissions.get(request_id)
            if rec is None:
                return False
            rec["choice"] = option_id
        rec["event"].set()
        return True

    # -- sessions --------------------------------------------------------------
    def _entry_for(self, session_id: str) -> _Entry:
        key = self._session_ws.get(session_id)
        entry = self._runtimes.get(key) if key else None
        if entry is None:
            raise UnknownSession(session_id)
        return entry

    async def list_sessions(self, workspace: str) -> list[dict]:
        key = normalize_workspace(workspace)
        entry = self._runtimes.get(key)
        if entry is None:
            # No runtime here: answer from Studio's own record, never spawn one.
            known = await asyncio.to_thread(read_known_sessions)
            labels = await asyncio.to_thread(read_labels)
            return [{
                "session_id": sid, "label": labels.get(sid), "workspace": workspace,
                "open": False, "busy": False,
            } for sid, ws in known.items() if ws == key]
        rows: dict[str, dict] = {}
        cursor = None
        for _ in range(MAX_LIST_PAGES):
            page = await asyncio.to_thread(entry.runtime.list_sessions, cursor) or {}
            for s in page.get("sessions") or []:
                sid = s.get("sessionId")
                if sid and sid not in rows:
                    rows[sid] = s
            cursor = page.get("nextCursor")
            if not cursor:
                break
        order = list(entry.open - rows.keys()) + list(rows.keys())
        labels = await asyncio.to_thread(read_labels)
        return [{
            "session_id": sid, "label": labels.get(sid), "workspace": entry.workspace,
            "open": sid in entry.open, "busy": sid in self._busy,
        } for sid in order]

    async def new_session(self, workspace: str, label: str | None = None) -> dict:
        entry = await self.ensure_runtime(workspace)
        res = await asyncio.to_thread(entry.runtime.new_session) or {}
        sid = res.get("sessionId")
        config_options = res.get("configOptions") or []
        await asyncio.to_thread(record_config_options, config_options)
        if sid:
            entry.open.add(sid)
            self._session_ws[sid] = entry.key
            await asyncio.to_thread(remember_session, sid, entry.key)
            if label:
                await asyncio.to_thread(write_label, sid, label)
        return {"session_id": sid, "config_options": config_options}

    async def resume_session(self, session_id: str, workspace: str) -> dict:
        entry = await self.ensure_runtime(workspace)
        res = await asyncio.to_thread(entry.runtime.resume_session, session_id) or {}
        config_options = res.get("configOptions") or []
        await asyncio.to_thread(record_config_options, config_options)
        entry.open.add(session_id)
        self._session_ws[session_id] = entry.key
        await asyncio.to_thread(remember_session, session_id, entry.key)
        return {"config_options": config_options}

    async def prompt(self, session_id: str, text: str) -> None:
        entry = self._entry_for(session_id)
        if session_id in self._busy:
            raise SessionBusy(session_id)
        self._busy.add(session_id)
        task = asyncio.ensure_future(self._run_turn(entry, session_id, text))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run_turn(self, entry: _Entry, session_id: str, text: str) -> None:
        stop_reason = error = None
        try:
            result = await asyncio.to_thread(entry.runtime.prompt, session_id, text) or {}
            stop_reason = result.get("stopReason")
        except HarnessError as exc:
            error = str(exc)
            logger.warning("Harness turn failed", exc_info=True)
        except Exception as exc:  # noqa: BLE001 - a turn must always end with turn_end
            error = str(exc) or type(exc).__name__
            logger.error("Harness turn crashed", exc_info=True)
        finally:
            self._busy.discard(session_id)
        self._broadcast(entry.key, {"type": "turn_end", "session_id": session_id,
                                    "stop_reason": stop_reason, "error": error})

    async def cancel(self, session_id: str) -> None:
        entry = self._entry_for(session_id)
        await asyncio.to_thread(entry.runtime.cancel, session_id)

    async def close(self, session_id: str) -> None:
        entry = self._entry_for(session_id)
        await asyncio.to_thread(entry.runtime.close_session, session_id)
        entry.open.discard(session_id)
        if session_id not in self._busy:
            self._session_ws.pop(session_id, None)

    async def set_config(self, session_id: str, config_id: str, value: str) -> Any:
        entry = self._entry_for(session_id)
        result = await asyncio.to_thread(entry.runtime.set_option, session_id, config_id, value)
        if isinstance(result, dict) and result.get("configOptions"):
            await asyncio.to_thread(record_config_options, result["configOptions"])
        return result

    # -- status ----------------------------------------------------------------
    async def status(self) -> dict:
        source = await asyncio.to_thread(key_source)
        version = await asyncio.to_thread(_node_version)
        settings = await asyncio.to_thread(_harness_settings)
        try:
            _resolved_rig_url, rig_url_source = await asyncio.to_thread(resolve_rig_url, settings)
        except HarnessError:
            # A bad harness.rig_url setting was still an attempt at tier 1.
            rig_url_source = "harness"
        return {
            "key_set": source is not None,
            "key_source": source,
            "launcher": shutil.which("plexar-harness"),
            "node_version": version,
            "node_ok": node_ok(version),
            "permission_mode": await asyncio.to_thread(permission_mode),
            "rig_url": str(settings.get("rig_url") or ""),
            "rig_url_source": rig_url_source,
        }


harness_manager = HarnessManager()
