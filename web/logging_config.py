"""Logging configuration for Claude Cockpit.

Two sinks, both fed by the same formatter:

  * stderr  -- the original behaviour, kept unchanged (dev console, sidecar
    stdout capture by Tauri).
  * ``~/.claude-cockpit/logs/cockpit.log`` -- a size-bounded rotating file so
    the Diagnostics page's claim that logs live on disk is actually true, and
    so a user can send a log after the fact.

The file sink is best-effort: an unwritable log directory degrades to
stderr-only logging rather than preventing the server from starting.
"""

from __future__ import annotations

import app_paths

import logging
import logging.handlers
import os
import sys
from pathlib import Path

# Rotation budget: 2 MiB per file x (1 active + 3 backups) = 8 MiB hard ceiling.
#
# Why these numbers: cockpit is a long-running desktop app, so an unbounded log
# is a real disk-leak risk. 2 MiB holds roughly 15-20k formatted lines, which
# comfortably covers a full day of INFO-level session/bridge/broker chatter --
# i.e. a user can reproduce a bug and still find the start of it in the active
# file. Three backups keep a few days of history for "it broke yesterday"
# reports without ever exceeding 8 MiB, which is small enough to attach to a
# support ticket and small enough that nobody notices it.
LOG_MAX_BYTES = 2 * 1024 * 1024
LOG_BACKUP_COUNT = 3

# Override exists for tests and for packaging environments with a different
# writable location. Read at call time (not import) so monkeypatching works.
_LOG_DIR_ENV = "COCKPIT_LOG_DIR"
_LOG_FILENAME = "cockpit.log"

# Marks the handlers this module installed, so repeated setup() calls replace
# them instead of stacking duplicate stderr writers and duplicate open file
# handles (the test suite imports several modules that each call setup()).
_HANDLER_TAG = "_cockpit_managed"

# Set by setup(); None when the file sink could not be created.
_file_handler: logging.handlers.RotatingFileHandler | None = None


def log_dir() -> Path:
    """Directory the rotating log file lives in."""
    override = os.environ.get(_LOG_DIR_ENV, "").strip()
    if override:
        return Path(override)
    return app_paths.data_path("logs")


def log_file_path() -> str:
    """Absolute path of the active log file (whether or not it exists yet)."""
    return str(log_dir() / _LOG_FILENAME)


def file_logging_active() -> bool:
    """True when the rotating file handler was successfully installed."""
    return _file_handler is not None


def rotation_config() -> dict:
    """The bounded-rotation parameters, for the Diagnostics page."""
    return {
        "max_bytes": LOG_MAX_BYTES,
        "backup_count": LOG_BACKUP_COUNT,
        "max_total_bytes": LOG_MAX_BYTES * (LOG_BACKUP_COUNT + 1),
    }


def _formatter() -> logging.Formatter:
    return logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def _make_file_handler(formatter: logging.Formatter):
    """Build the rotating file handler, or None if the path is unusable.

    Never raises: logging to a file is a convenience, and a read-only home
    directory must not stop the server from booting.
    """
    path = log_dir() / _LOG_FILENAME
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            str(path),
            maxBytes=LOG_MAX_BYTES,
            backupCount=LOG_BACKUP_COUNT,
            encoding="utf-8",
            delay=True,
        )
    except (OSError, ValueError):
        # Deliberately not logging via the cockpit logger here -- it has no
        # handlers yet at this point in setup().
        logging.getLogger(__name__).warning(
            "Could not open log file %s -- continuing with stderr logging only",
            path, exc_info=True,
        )
        return None
    handler.setFormatter(formatter)
    return handler


def setup(level: str = "INFO"):
    """Configure structured logging for all cockpit modules."""
    global _file_handler

    log_level = getattr(logging, level.upper(), logging.INFO)
    formatter = _formatter()

    root = logging.getLogger("cockpit")

    # Drop any handler a previous setup() call installed (and close its file
    # descriptor) so re-configuration cannot leak handles or double-log.
    for existing in list(root.handlers):
        if getattr(existing, _HANDLER_TAG, False):
            root.removeHandler(existing)
            try:
                existing.close()
            except (OSError, ValueError):
                logging.getLogger(__name__).debug(
                    "Failed to close previous log handler", exc_info=True,
                )
    _file_handler = None

    stream_handler = logging.StreamHandler(sys.stderr)
    stream_handler.setFormatter(formatter)
    setattr(stream_handler, _HANDLER_TAG, True)
    root.addHandler(stream_handler)

    file_handler = _make_file_handler(formatter)
    if file_handler is not None:
        setattr(file_handler, _HANDLER_TAG, True)
        root.addHandler(file_handler)
        _file_handler = file_handler

    root.setLevel(log_level)
    root.propagate = False

    return root


def current_level() -> str:
    """Effective level name of the ``cockpit`` logger tree."""
    return logging.getLevelName(logging.getLogger("cockpit").getEffectiveLevel())
