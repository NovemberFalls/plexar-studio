"""Where this application keeps its data — and the Claude Cockpit -> Plexar move.

ONE resolver, because the old name was hardcoded in eight modules. A rename
spread across eight `Path.home() / ".claude-cockpit"` literals is a rename that
will be half-done forever: the next module added copies whichever literal its
author happened to read.

The migration rule, and it is the whole point of this file
----------------------------------------------------------
**A failed migration must never look like a fresh install.** Losing sight of a
user's settings, usage history, pricing snapshots and chats is the worst
outcome available here, and the way it happens is not a crash — it is a rename
that quietly fails (a file locked by another process, a permissions refusal,
a cross-device path) after which the app cheerfully starts empty and the user
concludes their data is gone.

So: if the move does not succeed, we KEEP USING THE OLD DIRECTORY. A rename
that failed leaves the app exactly as it was, which is a non-event, where
starting fresh is a catastrophe that looks like a feature.

Precedence:
  1. ``PLEXAR_DATA_DIR`` / ``COCKPIT_DATA_DIR`` env override -- used verbatim,
     never migrated. An operator who names a directory owns it.
  2. ``~/.plexar`` if it exists.
  3. ``~/.claude-cockpit`` if it exists -- migrate it, and fall back to it if
     the migration fails.
  4. ``~/.plexar`` (fresh install).

Both env names are honoured deliberately: an existing deployment may already
set ``COCKPIT_DATA_DIR``, and breaking it to make a rename tidy would be
choosing our own consistency over someone's running install.
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
from pathlib import Path

logger = logging.getLogger("cockpit.paths")

NEW_DIR_NAME = ".plexar"
OLD_DIR_NAME = ".claude-cockpit"

#: Dropped in the old location after a successful move, so a user who rolls
#: back to a pre-rename build (which would look in the old path and find
#: nothing) is told where their data went rather than concluding it was lost.
BREADCRUMB = "MOVED-TO-PLEXAR.txt"

_BREADCRUMB_TEXT = (
    "Claude Cockpit is now Plexar.\n\n"
    "Your settings, usage history, pricing snapshots and chats were moved to:\n"
    "    {new}\n\n"
    "Nothing was deleted. If you go back to an older build, it will look in\n"
    "this old folder and appear empty -- your data is in the folder above.\n"
)

_resolved: Path | None = None
_lock = threading.Lock()


def _env_override() -> Path | None:
    for var in ("PLEXAR_DATA_DIR", "COCKPIT_DATA_DIR"):
        val = os.getenv(var)
        if val:
            return Path(val).expanduser()
    return None


def _migrate(old: Path, new: Path) -> Path:
    """Move *old* to *new*. Returns whichever directory is safe to use.

    Never merges into an existing target and never deletes anything. On ANY
    failure the OLD directory is returned, because continuing to use it is
    invisible to the user while starting fresh destroys their sense of where
    their history went.
    """
    try:
        # shutil.move handles the cross-device case that os.rename cannot.
        shutil.move(str(old), str(new))
    except Exception:
        logger.warning(
            "Could not move %s to %s; continuing to use the old location. "
            "No data was lost.", old, new, exc_info=True,
        )
        return old

    logger.info("Migrated application data from %s to %s", old, new)
    try:
        # Re-create the old dir purely to hold the note. Cheap, and it is the
        # only thing standing between a rollback and "my history is gone".
        old.mkdir(parents=True, exist_ok=True)
        (old / BREADCRUMB).write_text(
            _BREADCRUMB_TEXT.format(new=new), encoding="utf-8"
        )
    except Exception:
        # A missing note is a cosmetic loss; the data already moved fine.
        logger.warning("Migrated, but could not write the breadcrumb in %s",
                       old, exc_info=True)
    return new


def _resolve() -> Path:
    override = _env_override()
    if override is not None:
        # Named explicitly: used verbatim, never migrated into or out of.
        override.mkdir(parents=True, exist_ok=True)
        return override

    home = Path.home()
    new, old = home / NEW_DIR_NAME, home / OLD_DIR_NAME

    if new.is_dir():
        if old.is_dir() and not (old / BREADCRUMB).exists():
            # BOTH exist and the old one is not merely our own breadcrumb
            # shell. Merging two live datasets silently is how one overwrites
            # the other; the new location wins and the old is left untouched
            # for the user to reconcile.
            logger.warning(
                "Both %s and %s exist. Using the new location; the old one is "
                "left alone rather than merged.", new, old,
            )
        new.mkdir(parents=True, exist_ok=True)
        return new

    if old.is_dir():
        return _migrate(old, new)

    new.mkdir(parents=True, exist_ok=True)
    return new


def data_dir() -> Path:
    """The resolved application data directory. Memoized for the process.

    Deliberately memoized: the migration must happen at most once per run, and
    a path that could change mid-process would let two modules disagree about
    where the database lives.
    """
    global _resolved
    if _resolved is None:
        with _lock:
            if _resolved is None:
                _resolved = _resolve()
    return _resolved


def data_path(*parts: str) -> Path:
    """A path inside the data directory."""
    return data_dir().joinpath(*parts)


def reset_for_tests() -> None:
    """Drop the memoized resolution. Tests only."""
    global _resolved
    with _lock:
        _resolved = None
