"""Persistent server-side settings store for user-configurable API keys.

Currently stores a single value -- the OpenRouter API key a desktop-app user
pastes in via the Settings UI -- in a small JSON config file under the user's
home directory (``~/.claude-cockpit/config.json``). This is independent of
``web/.env`` (which is read once via ``load_dotenv()`` in server.py); the UI
key takes precedence, and the env var is the fallback for headless/dev setups.

Nothing in this module ever logs or returns a full key -- see ``mask_key``.
"""

from __future__ import annotations

import app_paths

import json
import logging
import os
import tempfile
from pathlib import Path

logger = logging.getLogger("cockpit.settings")

# Resolved through app_paths like every other store. This module was MISSED in
# the Claude Cockpit -> Plexar move, which is why both directories kept
# existing: the four data stores migrated and settings/config carried on
# writing to the old one, so the migration warning fired on every start and a
# key entered in Settings landed somewhere the rest of the app had left.
CONFIG_DIR = app_paths.data_dir()
CONFIG_FILE = CONFIG_DIR / "config.json"
# Sibling of config.json. config.json holds SECRETS (the OpenRouter key);
# settings.json holds only non-secret user preferences and is safe to export.
# NOTE: every other piece of cockpit state lives under ~/.claude-cockpit/, so
# settings.json lives here too -- not under %APPDATA%.
SETTINGS_FILE = CONFIG_DIR / "settings.json"

_KEY_FIELD = "openrouter_api_key"
_ANTHROPIC_KEY_FIELD = "anthropic_api_key"

# Both provider keys live in config.json (secrets), NEVER in settings.json --
# settings.json is user-exportable by design, so a key must never land there.
_PLEXAR_KEY_FIELD = "plexar_api_key"

_KEY_FIELDS = {
    "openrouter": (_KEY_FIELD, "OPENROUTER_API_KEY"),
    "anthropic": (_ANTHROPIC_KEY_FIELD, "ANTHROPIC_API_KEY"),
    # Plexar-vLLM's app key. It belongs HERE rather than in a .env beside the
    # source, because .env is loaded relative to the working directory and is
    # not bundled -- so it reaches `python server.py` and never reaches the
    # installed desktop app. A credential a packaged user cannot set is not
    # configuration, it is a dead end.
    "plexar": (_PLEXAR_KEY_FIELD, "COCKPIT_PLEXAR_KEY"),
}


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


def get_provider_ui_key(provider: str) -> str | None:
    """Return the UI-supplied key for *provider*, or None if not configured."""
    field, _env = _KEY_FIELDS[provider]
    value = _read_config().get(field)
    return value if isinstance(value, str) and value else None


def set_provider_ui_key(provider: str, key: str) -> None:
    """Persist *key* as the UI-supplied key for *provider* (overwrites any existing value)."""
    field, _env = _KEY_FIELDS[provider]
    data = _read_config()
    data[field] = key
    _write_config(data)


def delete_provider_ui_key(provider: str) -> bool:
    """Remove the UI-supplied key for *provider*.

    Returns True if a key was actually present and removed.
    """
    field, _env = _KEY_FIELDS[provider]
    data = _read_config()
    if not data.get(field):
        return False
    del data[field]
    _write_config(data)
    return True


def resolve_provider_key(provider: str) -> tuple[str | None, str | None]:
    """Resolve the effective key for *provider*.

    Precedence mirrors ``resolve_openrouter_key``: a UI-configured key
    (config.json) always beats the environment variable.

    Returns (key, source) where source is "ui", "env", or (None, None).
    """
    field, env_var = _KEY_FIELDS[provider]
    ui_key = get_provider_ui_key(provider)
    if ui_key:
        return ui_key, "ui"
    env_key = os.environ.get(env_var)
    if env_key:
        return env_key, "env"
    return None, None


def resolve_anthropic_key() -> tuple[str | None, str | None]:
    """Resolve the effective Anthropic key (UI-set beats ANTHROPIC_API_KEY)."""
    return resolve_provider_key("anthropic")


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
        # base_url default was ":8431" until 2026-08-02 -- an address nothing in
        # this program has ever listened on. The broker binds :1235
        # (COCKPIT_BROKER_URL / _LOCAL_BROKER_URL), which the UI already carried
        # in the field's PLACEHOLDER: the correct value was on screen the whole
        # time, greyed out behind a wrong default.
        #
        # NOTE (S8): none of these three keys is read by the server. The truth
        # for base_url is `GET /api/local/status` -> `url`; autostart is
        # governed by COCKPIT_MANAGED_BROKER; concurrency by nothing at all.
        # The card marks all three as not-enforced rather than implying they
        # take effect. Wiring base_url to the EXISTING, working endpoint setter
        # (POST /api/local/{id}/endpoint) is board row S11, not this default.
        "lane_broker": {"base_url": "http://127.0.0.1:1235", "autostart": True, "concurrency": 1},
        "lmstudio": {"base_url": "http://127.0.0.1:1234", "cli_path": "", "models_dir": "", "default": True},
        "vllm": {"base_url": "http://127.0.0.1:8001", "managed": False, "launch_command": "", "gpu_util": 0.90},
        "ollama": {"base_url": "http://127.0.0.1:11434", "enabled": False},
        "openrouter": {"enabled": False},
        # Plexar-vLLM. The URL is NOT a secret and lives here; the key lives in
        # config.json beside the other provider keys. Empty means "fall back to
        # COCKPIT_PLEXAR_URL, then loopback" -- a stored empty string must not
        # beat an env var an operator deliberately set.
        "plexar": {"base_url": ""},
    },
    # Chat's WORKING ROOT -- the directory every chat turn runs in.
    #
    # THIS IS ENFORCED, NOT DECORATIVE. `chat_runner.chat_workspace()` reads it
    # on every turn. Said explicitly because S8 had to fix a settings card with
    # three controls the server read NONE of, and a stored path nobody honours
    # is a worse lie than no setting at all -- it looks like the user chose
    # where their work happens.
    #
    # WHY THE ROOT MATTERS MORE THAN IT LOOKS: the CLI derives its own session
    # transcript path from its cwd (`~/.claude/projects/<slug-of-cwd>/`), so
    # this setting decides where the TRANSCRIPT lands as well as which files a
    # turn can see. That is the connection behind Len's "where the transcription
    # should be stored, or where it wants to declare root" -- they are one
    # question, not two.
    #
    # `root`: "" means the neutral default under app_paths.data_dir(). A path
    #   means that directory. NEVER a literal home-relative default computed
    #   here -- S14 made app_paths the single owner of where data lives and a
    #   second owner is the defect it just closed.
    # `root_choice`: THREE DISTINGUISHABLE STATES, deliberately, because
    #   "declined" must not render identically to "never asked":
    #     None       -- never asked. The prompt should appear.
    #     "default"  -- asked, and the user accepted the neutral workspace.
    #     "custom"   -- asked, and the user named `root`.
    #     "declined" -- asked, and the user dismissed it. Uses the default, and
    #                   we KNOW they were asked, so we do not ask again.
    #   A two-state boolean would collapse the last two, and the collapse is
    #   the whole point: a user who declined has made a choice, and re-asking
    #   them is how a question gets answered carelessly.
    "chat": {"root": "", "root_choice": None},
    "claude_cli": {"binary_path": "", "detected_version": None},
    "sessions": {"model": None, "permission_mode": None, "effort": None, "fast": False, "max_sessions": 8},
    "appearance": {
        "theme": None, "accent": None, "glow_enabled": True, "glow_size": 30,
        "token_overrides": {}, "user_palettes": {},
    },
    "data": {"retention_days": 90},
    # Spend guardrails. These paths are the contract the Settings UI
    # (components/settings/SpendGuardrails.jsx) writes and spend_guard.py reads --
    # do not rename a leaf without changing both sides.
    #
    # Two caps, deliberately asymmetric:
    #   caps.real_usd       -- money actually billed (OpenRouter, direct API).
    #   caps.equivalent_usd -- includes subscription-covered Claude turns, whose
    #                          marginal cost is zero. spend_guard REFUSES to
    #                          enforce a block on this class while
    #                          mode == "subscription", regardless of block.equivalent
    #                          -- the UI interlock is not a security boundary.
    # A cap of null means "no cap"; a cap of 0 is rejected at validation because
    # it is indistinguishable from a mistyped "off" while meaning "block all".
    "spend": {
        "mode": "subscription",           # "subscription" | "api"
        "period": "monthly",              # "daily" | "weekly" | "monthly"
        "monthly_reset_day": 1,           # 1..28 -- a subscription resets on the
                                          # signup anniversary, not the 1st
        "caps": {"real_usd": None, "equivalent_usd": None},
        "alert_at_percent": 80,           # 1..100
        "block": {"real": False, "equivalent": False},
        "enforce_on": {"bridges": True, "new_sessions": False},
    },
    "system": {"keybindings": {}},
    # Voice mode. OFF by default and deliberately so: the ML dependencies are
    # NOT bundled (the sidecar is 48 MB; torch would add ~2 GB), so on a fresh
    # install voice is simply not present. A default of True would advertise a
    # feature whose engine has to be downloaded first.
    #
    # `voice_id` is empty rather than a guessed default -- naming a Kokoro
    # voicepack that may not be on disk would make the UI show a selection the
    # engine cannot honour. Empty means "ask the engine what it has".
    "voice": {
        "enabled": False,
        "voice_id": "",
        # The brief's "pause for about 5 seconds to continue" cue. Tunable
        # because conversational pace is personal: too short cuts people off
        # mid-thought, too long feels unresponsive.
        "silence_continue_seconds": 5.0,
        # Barge-in -- speech while the assistant is talking stops it. This is
        # the whole point of conversational voice, so it defaults ON whenever
        # voice is on at all.
        "barge_in": True,
        "input_device": "",      # "" = system default
        "output_device": "",
    },
    # Terminal (xterm.js) options. These are Cockpit's own -- the `claude` CLI
    # neither sees nor restricts them. NOT yet read by TerminalPane, which still
    # hard-codes its values; the Settings page says so rather than implying they
    # are live. This section exists because `update_settings` rejects an unknown
    # top-level section ALL-OR-NOTHING: without it, saving a terminal edit 400s
    # and silently discards every other page's pending edit in the same patch.
    "terminal": {
        "font_family": "",       # "" = use the mono stack from index.css
        "font_size": 13,
        "scrollback": 10000,
        "cursor_style": "",      # "" = xterm default (bar, per TerminalPane)
        "cursor_blink": True,
    },
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
    "spend.monthly_reset_day": (1, 28),
    "spend.alert_at_percent": (1, 100),
    # Below ~0.5s a natural mid-sentence breath ends the turn; past 30s the
    # "still listening" state is indistinguishable from a hang.
    "voice.silence_continue_seconds": (0.5, 30.0),
    # 8 is the smallest legible mono size; past ~28 a pane holds too few columns
    # to be useful. Scrollback is per-pane and Cockpit runs up to 8 of them, so
    # the ceiling is a memory bound, not a preference.
    "terminal.font_size": (8, 28),
    "terminal.scrollback": (100, 100000),
}

# Dotted key -> allowed values. A value outside the set is rejected rather than
# stored: spend_guard branches on these strings, and an unknown mode would make
# the "never block equivalent under a subscription" refusal undecidable.
_ENUM_VALUES = {
    "spend.mode": ("subscription", "api"),
    "spend.period": ("daily", "weekly", "monthly"),
}

# Dotted keys whose value must be null (= no cap) or a number STRICTLY greater
# than zero. Zero is rejected on purpose: a $0 cap means "block everything", and
# accepting it would turn a slipped keystroke into a total work stoppage. "Off"
# already has an unambiguous representation -- null.
_POSITIVE_OR_NULL_LEAVES = frozenset({
    "spend.caps.real_usd",
    "spend.caps.equivalent_usd",
})


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
            if dotted in _ENUM_VALUES and value is not None:
                allowed = _ENUM_VALUES[dotted]
                if value not in allowed:
                    raise ValueError(
                        f"'{dotted}' must be one of {', '.join(allowed)}"
                    )
            if dotted in _POSITIVE_OR_NULL_LEAVES and value is not None:
                # The default for these leaves is None, so _same_json_type above
                # accepts anything -- the type check has to happen here.
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError(f"'{dotted}' must be a number or null")
                if value <= 0:
                    raise ValueError(
                        f"'{dotted}' must be greater than 0, or null for no cap"
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
