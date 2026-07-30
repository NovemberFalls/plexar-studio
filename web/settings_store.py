"""Persistent server-side settings store for user-configurable API keys.

Currently stores a single value -- the OpenRouter API key a desktop-app user
pastes in via the Settings UI -- in a small JSON config file under the user's
home directory (``~/.claude-cockpit/config.json``). This is independent of
``web/.env`` (which is read once via ``load_dotenv()`` in server.py); the UI
key takes precedence, and the env var is the fallback for headless/dev setups.

Nothing in this module ever logs or returns a full key -- see ``mask_key``.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger("cockpit.settings")

CONFIG_DIR = Path.home() / ".claude-cockpit"
CONFIG_FILE = CONFIG_DIR / "config.json"
# Sibling of config.json. config.json holds SECRETS (the OpenRouter key);
# settings.json holds only non-secret user preferences and is safe to export.
# NOTE: every other piece of cockpit state lives under ~/.claude-cockpit/, so
# settings.json lives here too -- not under %APPDATA%.
SETTINGS_FILE = CONFIG_DIR / "settings.json"

_KEY_FIELD = "openrouter_api_key"


def _read_json_object(path: Path) -> dict:
    """Read *path* as a JSON object, returning {} if missing, empty, or corrupt.

    Never raises: a missing file, empty file, non-object JSON, or invalid
    JSON are all treated identically as "no settings yet" so a damaged
    on-disk file can never crash a settings read.
    """
    if not path.is_file():
        return {}
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        logger.warning("Failed to read config file %s -- treating as empty", path, exc_info=True)
        return {}

    if not raw.strip():
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Config file %s contains invalid JSON -- treating as empty", path, exc_info=True)
        return {}

    if not isinstance(data, dict):
        logger.warning("Config file %s did not contain a JSON object -- treating as empty", path)
        return {}
    return data


def _write_json_object(path: Path, data: dict, *, prefix: str = "config_") -> None:
    """Atomically write *data* to *path*.

    Writes to a temp file in the same directory first, then ``os.replace``s
    it over the real file. os.replace is atomic on both POSIX and Windows, so
    a crash or concurrent read mid-write can never observe a half-written file.
    """
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=prefix, suffix=".json.tmp", dir=str(parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, path)
    except OSError:
        logger.warning("Failed to write config file %s", path, exc_info=True)
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            logger.debug("Failed to clean up temp config file %s", tmp_path, exc_info=True)
        raise


def _read_config() -> dict:
    """Read config.json (the secrets file), returning {} if missing or corrupt."""
    return _read_json_object(CONFIG_FILE)


def _write_config(data: dict) -> None:
    """Atomically write *data* to config.json (the secrets file)."""
    _write_json_object(CONFIG_FILE, data, prefix="config_")


def get_ui_key() -> str | None:
    """Return the UI-supplied OpenRouter key, or None if not configured."""
    value = _read_config().get(_KEY_FIELD)
    return value if isinstance(value, str) and value else None


def set_ui_key(key: str) -> None:
    """Persist *key* as the UI-supplied OpenRouter key (overwrites any existing value)."""
    data = _read_config()
    data[_KEY_FIELD] = key
    _write_config(data)


def delete_ui_key() -> bool:
    """Remove the UI-supplied key, if any.

    Returns:
        True if a key was actually present and removed, False if there was
        nothing to remove.
    """
    data = _read_config()
    if not data.get(_KEY_FIELD):
        return False
    del data[_KEY_FIELD]
    _write_config(data)
    return True


def resolve_openrouter_key() -> tuple[str | None, str | None]:
    """Resolve the effective OpenRouter key.

    UI-configured keys (config.json) always take precedence over the
    environment. server.py calls ``load_dotenv()`` before any other cockpit
    module is imported, so ``web/.env``'s OPENROUTER_API_KEY (if any) is
    already in os.environ by the time this runs.

    Returns:
        (key, source) where source is "ui", "env", or (None, None) if
        neither is configured.
    """
    ui_key = get_ui_key()
    if ui_key:
        return ui_key, "ui"
    env_key = os.environ.get("OPENROUTER_API_KEY")
    if env_key:
        return env_key, "env"
    return None, None


def mask_key(key: str) -> str:
    """Mask *key* for safe display/logging -- the full key must NEVER appear
    in any log line or API response.

    Format: first 8 characters + "…" + last 4 characters (e.g.
    "sk-or-v1…7f3a"). Keys shorter than 14 characters can't be split that
    way without the two halves overlapping (leaking most of the secret), so
    those are masked down to a single "…" instead of any real characters.
    """
    if not key:
        return ""
    if len(key) < 14:
        return "…"
    return f"{key[:8]}…{key[-4:]}"


# ---------------------------------------------------------------------------
# settings.json -- non-secret user preferences
# ---------------------------------------------------------------------------

DEFAULT_SETTINGS = {
    "general": {"autostart_broker": True, "minimize_to_tray": False, "check_updates": True},
    "providers": {
        "lane_broker": {"base_url": "http://127.0.0.1:8431", "autostart": True, "concurrency": 1},
        "lmstudio": {"base_url": "http://127.0.0.1:1234", "cli_path": "", "models_dir": "", "default": True},
        "vllm": {"base_url": "http://127.0.0.1:8001", "managed": False, "launch_command": "", "gpu_util": 0.90},
        "ollama": {"base_url": "http://127.0.0.1:11434", "enabled": False},
        "openrouter": {"enabled": False},
    },
    "claude_cli": {"binary_path": "", "detected_version": None},
    "sessions": {"model": None, "permission_mode": None, "effort": None, "fast": False, "max_sessions": 8},
    "appearance": {
        "theme": None, "accent": None, "glow_enabled": True, "glow_size": 30,
        "token_overrides": {}, "user_palettes": {},
    },
    "data": {"retention_days": 90},
    "system": {"keybindings": {}},
}

# Free-form dict leaves: their *contents* are user-defined (theme tokens,
# palettes, keybindings), so we only validate that they are JSON-serializable
# dicts rather than recursing into them against a default shape.
_FREEFORM_LEAVES = frozenset({"token_overrides", "user_palettes", "keybindings"})

# Dotted key -> (min, max) inclusive numeric bounds.
_NUMERIC_BOUNDS = {
    "providers.lane_broker.concurrency": (1, 8),
    "providers.vllm.gpu_util": (0.05, 1.0),
    "appearance.glow_size": (0, 48),
    "sessions.max_sessions": (1, 16),
    "data.retention_days": (1, 3650),
}


def settings_path() -> str:
    """Absolute path to settings.json, as a string (for display in the UI)."""
    return str(SETTINGS_FILE.resolve() if SETTINGS_FILE.exists() else SETTINGS_FILE.absolute())


def _deep_merge(base: dict, overlay: dict) -> dict:
    """Return a new dict: *base* with *overlay* merged in, overlay winning per-leaf.

    Only dict-vs-dict pairs recurse; any other overlay value replaces the base
    value wholesale (so a free-form dict replacement still works because the
    caller passes the whole dict).
    """
    out = dict(base)
    for key, value in overlay.items():
        current = out.get(key)
        if isinstance(current, dict) and isinstance(value, dict) and key not in _FREEFORM_LEAVES:
            out[key] = _deep_merge(current, value)
        else:
            out[key] = value
    return out


def read_settings() -> dict:
    """Return DEFAULT_SETTINGS deep-merged with settings.json (disk wins per-leaf).

    Never raises. Unknown keys present on disk are preserved so a newer build's
    settings survive a rollback to an older build.
    """
    return _deep_merge(DEFAULT_SETTINGS, _read_json_object(SETTINGS_FILE))


def _is_json_serializable(value) -> bool:
    try:
        json.dumps(value)
    except (TypeError, ValueError):
        return False
    return True


def _same_json_type(default, value) -> bool:
    """True if *value* is type-compatible with *default*.

    bool is checked FIRST because ``isinstance(True, int)`` is True in Python --
    a bool must never satisfy an int default and vice versa. int and float are
    interchangeable for numeric defaults (JSON has one number type, and 1 is a
    perfectly good gpu_util).
    """
    if isinstance(default, bool):
        return isinstance(value, bool)
    if isinstance(default, (int, float)):
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if isinstance(default, str):
        return isinstance(value, str)
    if isinstance(default, dict):
        return isinstance(value, dict)
    if isinstance(default, list):
        return isinstance(value, list)
    return True


def _validate_patch(patch, defaults, prefix: str) -> None:
    """Recursively validate *patch* against *defaults*. Raises ValueError."""
    for key, value in patch.items():
        dotted = f"{prefix}.{key}" if prefix else key
        if not isinstance(key, str):
            raise ValueError(f"setting keys must be strings (near '{prefix or 'root'}')")

        if not _is_json_serializable(value):
            raise ValueError(f"'{dotted}' is not JSON-serializable")

        if key in _FREEFORM_LEAVES:
            if not isinstance(value, dict):
                raise ValueError(f"'{dotted}' must be an object")
            continue

        if isinstance(defaults, dict) and key in defaults:
            default = defaults[key]
            if value is not None and not _same_json_type(default, value):
                raise ValueError(
                    f"'{dotted}' must be {type(default).__name__} or null"
                )
            if dotted in _NUMERIC_BOUNDS and value is not None:
                low, high = _NUMERIC_BOUNDS[dotted]
                if not (low <= value <= high):
                    raise ValueError(f"'{dotted}' must be between {low} and {high}")
            if isinstance(default, dict) and isinstance(value, dict):
                _validate_patch(value, default, dotted)
        elif isinstance(value, dict):
            # No default to compare against (a key this build doesn't know);
            # still recurse so nested non-serializable values are caught.
            _validate_patch(value, {}, dotted)


def update_settings(patch: dict) -> dict:
    """Validate *patch* all-or-nothing, deep-merge it into settings.json, and
    return the new effective settings.

    Raises:
        ValueError: with a message naming the offending dotted key. Nothing is
            written when validation fails -- the on-disk blob is untouched.
    """
    if not isinstance(patch, dict):
        raise ValueError("settings patch must be an object")

    unknown = [k for k in patch if k not in DEFAULT_SETTINGS]
    if unknown:
        raise ValueError(f"unknown settings section '{unknown[0]}'")

    _validate_patch(patch, DEFAULT_SETTINGS, "")

    on_disk = _read_json_object(SETTINGS_FILE)
    merged = _deep_merge(on_disk, patch)
    _write_json_object(SETTINGS_FILE, merged, prefix="settings_")
    return _deep_merge(DEFAULT_SETTINGS, merged)
