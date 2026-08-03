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

``~/.plexar`` IS NOT OURS ANY MORE (2026-08-02)
----------------------------------------------
Studio moved into ``~/.plexar`` when Cockpit was renamed, and **the rig
(Plexar-LLM) was already there** -- its ``config.py`` claimed that directory
first. Two products, one mutable directory, no owner. The R-E window split them:
Studio's data moved to ``~/.plexar-studio`` and the rig kept ``~/.plexar``.

**The split moved the DATA and, until now, nothing moved the RESOLVER.** For a
few hours the only thing pointing Studio at its own data was a
``PLEXAR_DATA_DIR`` environment variable, which is a property of whoever
launched the process rather than of the install. This was not theoretical: on
2026-08-02 a Studio started from a shell whose environment predated that
variable fell straight back to ``~/.plexar``, recreated an empty
``usage.sqlite3`` there, and **looked exactly like a working install while the
day's split silently reverted.** Forty seconds, no error, no log anyone reads.

So the rule that matters most here is no longer only *"a failed migration must
not look like a fresh install"* -- it is also:

**``~/.plexar`` EXISTING IS NO LONGER A REASON TO USE IT.** That directory now
belongs to another product. Studio adopts it only if it can see its OWN files in
it (a machine that never went through the split), and never merely because it is
there.

Precedence:
  1. ``PLEXAR_DATA_DIR`` / ``COCKPIT_DATA_DIR`` env override -- used verbatim,
     never migrated. An operator who names a directory owns it.
  2. ``~/.plexar-studio`` if it exists -- our home. **Checked before everything
     below, so "fresh install" is unreachable while our data is sitting there.**
  3. ``~/.plexar`` ONLY IF it holds Studio's own files and none of the rig's --
     a pre-split machine. Migrated to ``~/.plexar-studio``.
  4. ``~/.claude-cockpit`` if it exists -- migrate it, and fall back to it if
     the migration fails.
  5. ``~/.plexar-studio`` (genuine fresh install).

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

STUDIO_DIR_NAME = ".plexar-studio"
NEW_DIR_NAME = ".plexar"           # the RIG's directory. Not ours.
OLD_DIR_NAME = ".claude-cockpit"

#: Files only Studio writes. Their presence in ``~/.plexar`` means that
#: directory predates the split and still holds our data.
#: ``config.json`` is deliberately NOT here: the rig may legitimately grow a
#: ``config.json`` of its own shape (Plan §2.8 says so in as many words), so it
#: cannot discriminate. These four can.
STUDIO_MARKERS = ("usage.sqlite3", "chat.sqlite3", "pricing.sqlite3", "chat-workspace")

#: Files only the RIG writes. Their presence means the directory is not ours to
#: take, whatever else is in it.
RIG_MARKERS = ("plexar.sqlite3", "secrets.json", "presets.json", "compile-cache")


def _markers(d: Path, names) -> list[str]:
    """Which of *names* exist in *d*. Returns the hits, so callers can LOG THEM.

    A boolean here would make every "wrong directory" diagnosis start with
    somebody re-running this by hand.
    """
    try:
        return [n for n in names if (d / n).exists()]
    except OSError:
        logger.warning("Could not inspect %s", d, exc_info=True)
        return []

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
        # An operator who names a directory owns it -- this still wins over
        # everything below, including a populated ~/.plexar-studio.
        override.mkdir(parents=True, exist_ok=True)
        return override

    home = Path.home()
    studio = home / STUDIO_DIR_NAME
    rig = home / NEW_DIR_NAME
    old = home / OLD_DIR_NAME

    # 2. Our own home. FIRST, so a genuine-fresh-install can never be reached
    #    while our data is sitting there -- which is precisely how a mislaunched
    #    Studio silently reverted the R-E split.
    if studio.is_dir():
        for other, what in ((old, "pre-rename"), (rig, "the rig's")):
            if other.is_dir() and not (other / BREADCRUMB).exists():
                logger.warning(
                    "Using %s. %s (%s) also exists and is left ALONE, not "
                    "merged -- merging two live datasets is how one silently "
                    "overwrites the other.", studio, other, what,
                )
        studio.mkdir(parents=True, exist_ok=True)
        return studio

    # 3. ~/.plexar is the RIG's directory now. Adopt it ONLY if it visibly
    #    holds our data and none of theirs -- i.e. a machine that never went
    #    through the split. Its mere existence proves nothing about ownership.
    if rig.is_dir():
        ours = _markers(rig, STUDIO_MARKERS)
        theirs = _markers(rig, RIG_MARKERS)
        if ours and not theirs:
            logger.info(
                "%s holds Studio data (%s) and no rig files; migrating to %s",
                rig, ", ".join(ours), studio,
            )
            return _migrate(rig, studio)
        if ours and theirs:
            # The un-split shared directory. Both products are live in there.
            # KEEP USING IT rather than inventing a partial migration at
            # resolve time -- that is the R-E window's job, done deliberately
            # with both processes stopped, not something to attempt on a
            # startup path with the rig possibly running.
            logger.warning(
                "%s holds BOTH Studio data (%s) and rig files (%s). Continuing "
                "to use it unchanged. This is the pre-split shared directory; "
                "splitting it is a deliberate migration, not a startup action.",
                rig, ", ".join(ours), ", ".join(theirs),
            )
            return rig
        logger.info(
            "%s exists but holds no Studio data (rig files: %s); NOT adopting it",
            rig, ", ".join(theirs) or "none",
        )

    # 4. The pre-rename directory.
    if old.is_dir():
        return _migrate(old, studio)

    # 5. Genuine fresh install.
    studio.mkdir(parents=True, exist_ok=True)
    return studio


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
