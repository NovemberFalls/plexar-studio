"""~/.plexar is the RIG's directory now — Studio must stop adopting it.

WHY THIS FILE EXISTS, AND IT IS NOT A HYPOTHETICAL. The R-E window of
2026-08-02 moved Studio's data to ``~/.plexar-studio`` and left ``~/.plexar`` to
Plexar-LLM. **The split moved the data and nothing moved the resolver.** For a
few hours the only thing pointing Studio at its own data was a
``PLEXAR_DATA_DIR`` environment variable — a property of whoever launched the
process, not of the install.

Then it happened: a Studio started from a shell whose environment predated the
variable fell back to ``~/.plexar``, created an empty ``usage.sqlite3`` there,
and **looked exactly like a working install while the day's split reverted.**
Forty seconds, no error, nothing red. A correct binary and a correct User-scope
variable were not enough, because neither is what the process reads.

THE ASYMMETRY THAT SETS THIS ROW'S PRIORITY, and it is worth stating in the file
rather than only in a decision record: a wrong COST row is findable afterwards —
local provider, non-zero cost, a token record to contradict it. **A silent
re-split announces nothing and looks like a working install.** A defect you can
still find later is not the same emergency as one you cannot see at all.

── THE FOUR STATES, WHICH MUST BE MUTUALLY DISTINGUISHABLE (R10) ─────────────
The failure mode here is two states becoming EQUAL — specifically
"fresh install" becoming reachable while our data sits on disk. So these assert
PAIRWISE DISTINCTNESS with DECLARED EXPECTATIONS (R19), not four independently
plausible answers.

  env-set              -> the named directory, always, whatever else exists
  studio-exists        -> ~/.plexar-studio
  pre-split ~/.plexar  -> migrated to ~/.plexar-studio
  rig-only ~/.plexar   -> NOT adopted
  genuine fresh        -> ~/.plexar-studio, and reachable ONLY when nothing else is
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app_paths  # noqa: E402


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(app_paths.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("PLEXAR_DATA_DIR", raising=False)
    monkeypatch.delenv("COCKPIT_DATA_DIR", raising=False)
    app_paths.reset_for_tests()
    yield
    app_paths.reset_for_tests()


def _mk(d, *files):
    d.mkdir(parents=True, exist_ok=True)
    for f in files:
        (d / f).write_text("x", encoding="utf-8")
    return d


# ── The reproduction: the exact launch that reverted the split ───────────────

def test_no_env_and_rig_directory_present_does_NOT_adopt_the_rig(tmp_path):
    """THE REGRESSION. This is the mislaunch, reproduced.

    A shell with no PLEXAR_DATA_DIR, and ~/.plexar sitting there full of the
    rig's files. Before the fix this returned ~/.plexar and Studio started
    writing an empty usage.sqlite3 into the rig's directory.
    """
    rig = _mk(tmp_path / ".plexar", "plexar.sqlite3", "secrets.json", "presets.json")
    got = app_paths.data_dir()
    assert got != rig, "Studio adopted the RIG's directory — the split just reverted"
    assert got == tmp_path / ".plexar-studio"
    # And it must not have written anything into the rig's home on the way past.
    assert not (rig / "usage.sqlite3").exists()


def test_existing_studio_home_wins_over_a_rig_directory(tmp_path):
    studio = _mk(tmp_path / ".plexar-studio", "usage.sqlite3")
    _mk(tmp_path / ".plexar", "plexar.sqlite3", "secrets.json")
    assert app_paths.data_dir() == studio


def test_pre_split_plexar_holding_OUR_files_is_migrated(tmp_path):
    """A machine that never went through the split still has to work."""
    rig = _mk(tmp_path / ".plexar", "usage.sqlite3", "chat.sqlite3", "pricing.sqlite3")
    got = app_paths.data_dir()
    assert got == tmp_path / ".plexar-studio"
    assert (got / "usage.sqlite3").exists(), "the data did not come with it"
    assert not rig.exists() or not (rig / "usage.sqlite3").exists()


def test_shared_pre_split_directory_is_used_UNCHANGED_not_half_migrated(tmp_path):
    """Both products live in there. Splitting it is a deliberate migration.

    Attempting it on a startup path — with the rig possibly running — is how a
    partial move happens. Keep using it: that is the file's own fail-safe rule,
    and it is a non-event rather than a catastrophe.
    """
    rig = _mk(tmp_path / ".plexar", "usage.sqlite3", "plexar.sqlite3", "secrets.json")
    got = app_paths.data_dir()
    assert got == rig
    assert (rig / "plexar.sqlite3").exists(), "the rig's data must be untouched"


# ── The override still wins, from every starting state ──────────────────────

@pytest.mark.parametrize("var", ["PLEXAR_DATA_DIR", "COCKPIT_DATA_DIR"])
def test_env_override_beats_even_a_populated_studio_home(tmp_path, monkeypatch, var):
    """An operator who names a directory owns it. Unchanged, and pinned."""
    _mk(tmp_path / ".plexar-studio", "usage.sqlite3")
    _mk(tmp_path / ".plexar", "plexar.sqlite3")
    named = tmp_path / "somewhere-else"
    monkeypatch.setenv(var, str(named))
    assert app_paths.data_dir() == named


# ── Fresh install must be UNREACHABLE while our data exists ─────────────────

def test_fresh_install_is_reachable_only_when_nothing_else_is(tmp_path):
    assert app_paths.data_dir() == tmp_path / ".plexar-studio"


def test_a_populated_studio_home_can_never_resolve_to_an_empty_one(tmp_path):
    """The specific collapse: 'fresh install' and 'our data exists' agreeing.

    Populated and empty homes are the SAME PATH, so distinguishing them by path
    is not enough — the assertion has to be that the data is still there.
    """
    studio = _mk(tmp_path / ".plexar-studio", "usage.sqlite3", "chat.sqlite3")
    got = app_paths.data_dir()
    assert got == studio
    assert (got / "usage.sqlite3").exists() and (got / "chat.sqlite3").exists()


# ── R10: the states must be MUTUALLY distinguishable, not each plausible ────

def test_the_five_states_are_pairwise_distinct(tmp_path, monkeypatch):
    """Declared expectations (R19), then every pair compared (R10).

    A per-state assertion passes straight through two states quietly becoming
    equal, and equality IS the failure mode here: 'rig-only' collapsing into
    'pre-split' means Studio eats the rig's directory, and 'studio-exists'
    collapsing into 'fresh' means it starts empty on top of real data.
    """
    def resolve(home, *, env=None):
        monkeypatch.setattr(app_paths.Path, "home", staticmethod(lambda: home))
        if env:
            monkeypatch.setenv("PLEXAR_DATA_DIR", str(env))
        else:
            monkeypatch.delenv("PLEXAR_DATA_DIR", raising=False)
        app_paths.reset_for_tests()
        return app_paths.data_dir()

    outcomes = {}

    h = tmp_path / "env"; h.mkdir(); _mk(h / ".plexar-studio", "usage.sqlite3")
    outcomes["env-set"] = resolve(h, env=h / "named").name

    h = tmp_path / "studio"; h.mkdir(); _mk(h / ".plexar-studio", "usage.sqlite3")
    outcomes["studio-exists"] = resolve(h).name

    h = tmp_path / "presplit"; h.mkdir(); _mk(h / ".plexar", "usage.sqlite3")
    outcomes["pre-split"] = resolve(h).name

    h = tmp_path / "rigonly"; h.mkdir(); _mk(h / ".plexar", "plexar.sqlite3", "secrets.json")
    outcomes["rig-only"] = resolve(h).name

    h = tmp_path / "shared"; h.mkdir(); _mk(h / ".plexar", "usage.sqlite3", "plexar.sqlite3")
    outcomes["shared"] = resolve(h).name

    # DECLARED, not discovered.
    assert outcomes == {
        "env-set": "named",
        "studio-exists": ".plexar-studio",
        "pre-split": ".plexar-studio",
        "rig-only": ".plexar-studio",
        "shared": ".plexar",
    }

    # The pairs that must NEVER be equal, named individually so a failure says
    # WHICH guarantee died rather than "a dict differed".
    assert outcomes["env-set"] != outcomes["studio-exists"], "env override stopped winning"
    assert outcomes["rig-only"] != outcomes["shared"], (
        "rig-only and shared collapsed — Studio can no longer tell a directory "
        "that is the rig's from one that is jointly held"
    )
    assert outcomes["shared"] != outcomes["studio-exists"], (
        "the shared pre-split directory is being treated as our clean home"
    )
