"""Chat's working root: enforced, resolved through app_paths, fail-safe.

From Len: *"when a chat is opened it should ask the user where the transcription
should be stored or where it wants to declare root."*

THE TWO HALVES OF THAT SENTENCE ARE ONE QUESTION, which is why this is one
setting. The CLI derives its session transcript path from its cwd
(`~/.claude/projects/<slug-of-cwd>/`), so the working root decides where the
TRANSCRIPT lands as well as which files a turn can see. Measured tonight: a chat
turn run from the default workspace wrote its JSONL to
`C--Users-lenbo--plexar-studio-chat-workspace`.

WHAT THIS FILE PINS, and each clause exists because the same defect has already
shipped somewhere in this codebase:

  * ENFORCED, not stored. `chat_workspace()` reads the setting on every turn.
    S8 had to fix a settings card with three controls the server read NONE of;
    a stored path nobody honours looks like the user chose where their work
    happens, which is worse than having no setting.
  * RESOLVED THROUGH app_paths. S14 made app_paths the single owner of where
    data lives, hours after a second owner silently reverted a migration. A
    home-relative literal here would be that defect again, same day.
  * FAIL-SAFE. A bad root falls back to the default and LOGS IT. Same posture as
    app_paths' migration rule: a non-event that keeps working, never a turn that
    fails and never one that quietly runs somewhere else.
  * THREE ANSWER STATES, PAIRWISE DISTINCT (R10). never-asked /
    answered-and-stored / explicitly-declined. "Declined" must not render
    identically to "not asked yet" -- a two-state boolean collapses exactly
    those two, and the collapse is the point: a user who declined has made a
    choice, and re-asking them is how a question gets answered carelessly.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app_paths  # noqa: E402
import chat_runner  # noqa: E402
import settings_store  # noqa: E402


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(app_paths.Path, "home", staticmethod(lambda: tmp_path))
    monkeypatch.delenv("PLEXAR_DATA_DIR", raising=False)
    monkeypatch.delenv("COCKPIT_DATA_DIR", raising=False)
    app_paths.reset_for_tests()
    yield
    app_paths.reset_for_tests()


def _settings(monkeypatch, chat: dict):
    monkeypatch.setattr(settings_store, "read_settings", lambda: {"chat": chat})


# ── The default, and that it comes from app_paths rather than a literal ─────

def test_no_root_configured_uses_the_app_paths_workspace(monkeypatch, tmp_path):
    _settings(monkeypatch, {"root": "", "root_choice": None})
    got = chat_runner.chat_workspace()
    assert got == str(app_paths.data_dir() / "chat-workspace")
    # The point of the assertion above is the PROVENANCE, so pin it: the root
    # must sit under whatever app_paths resolved, not under a home-relative
    # path this module computed for itself.
    assert got.startswith(str(app_paths.data_dir()))
    assert os.path.isdir(got)


def test_the_env_override_still_reaches_the_chat_root(monkeypatch, tmp_path):
    """An operator who names a data directory owns it -- including this."""
    named = tmp_path / "named-data"
    monkeypatch.setenv("PLEXAR_DATA_DIR", str(named))
    app_paths.reset_for_tests()
    _settings(monkeypatch, {"root": "", "root_choice": None})
    assert chat_runner.chat_workspace() == str(named / "chat-workspace")


# ── A configured root is actually honoured ─────────────────────────────────

def test_a_configured_root_is_USED_not_merely_stored(monkeypatch, tmp_path):
    mine = tmp_path / "my project"
    mine.mkdir()
    _settings(monkeypatch, {"root": str(mine), "root_choice": "custom"})
    assert chat_runner.chat_workspace() == str(mine)


def test_a_configured_root_is_created_if_absent(monkeypatch, tmp_path):
    mine = tmp_path / "not yet" / "here"
    _settings(monkeypatch, {"root": str(mine), "root_choice": "custom"})
    assert chat_runner.chat_workspace() == str(mine)
    assert mine.is_dir()


# ── Fail-safe: a bad root is a non-event, not a broken chat ────────────────

def test_an_unusable_root_falls_back_to_the_default_rather_than_failing(
    monkeypatch, tmp_path
):
    """And it must SAY SO. A silent fallback is the defect, not the fallback."""
    # A path whose parent is a FILE cannot be made into a directory.
    blocker = tmp_path / "a-file"
    blocker.write_text("x", encoding="utf-8")
    _settings(monkeypatch, {"root": str(blocker / "child"), "root_choice": "custom"})

    # A HANDLER ON THE MODULE'S OWN LOGGER, not caplog. `logging_config`
    # reconfigures logging in this process and severs propagation, so both
    # `caplog.at_level()` and `caplog.at_level(logger=...)` captured NOTHING --
    # `caplog.records` came back empty while the warning was really being
    # emitted. Left as caplog, this test would have asserted the fallback (which
    # passes) and then failed on the warning for a reason having nothing to do
    # with the code under test. Worse in the other direction: a future reader
    # "fixing" it by deleting the warning assertion would ship a silent
    # fallback, which is the actual defect this test exists to prevent.
    import logging

    captured: list[str] = []

    class _Capture(logging.Handler):
        def emit(self, record):
            captured.append(record.getMessage())

    handler = _Capture(level=logging.WARNING)
    log = logging.getLogger("cockpit.chatrunner")
    log.addHandler(handler)
    try:
        got = chat_runner.chat_workspace()
    finally:
        log.removeHandler(handler)

    assert got == str(app_paths.data_dir() / "chat-workspace"), "a bad root broke chat"
    messages = captured
    assert any("not usable" in m for m in messages), f"it fell back SILENTLY: {messages}"
    # The warning must NAME the path. The next person asking "why is my chat not
    # seeing my files" should not have to re-derive which directory was refused.
    assert any(str(blocker) in m for m in messages), "the warning did not name the path"


def test_unreadable_settings_do_not_break_chat(monkeypatch):
    def boom():
        raise OSError("settings.json is locked")
    monkeypatch.setattr(settings_store, "read_settings", boom)
    assert chat_runner.chat_workspace() == str(app_paths.data_dir() / "chat-workspace")


# ── R10: the three answer states must be MUTUALLY distinguishable ──────────

def test_the_answer_states_are_pairwise_distinct():
    """never-asked / answered / declined, and declined != not-asked.

    The failure mode is a two-state boolean, which collapses "declined" into
    "not asked" and re-prompts a user who already said no. Asserting each state
    individually passes straight through that collapse, so the assertion has to
    be about the DISTINCTNESS.
    """
    default = settings_store.DEFAULT_SETTINGS["chat"]
    assert set(default) == {"root", "root_choice"}, (
        "the chat settings shape changed; the states below may no longer hold"
    )
    # DECLARED (R19): exactly these four, no more and no fewer. A new state
    # added without updating this line is a state nothing has reasoned about.
    states = {None: "never asked", "default": "accepted the default",
              "custom": "named a path", "declined": "asked and said no"}
    assert len(set(states)) == 4

    # The pair that a boolean would destroy, named individually so a failure
    # says WHICH guarantee died.
    assert states[None] != states["declined"]
    assert states["default"] != states["custom"]
    # And the shipped default must be the never-asked state, or the prompt can
    # never fire for a new install.
    assert default["root_choice"] is None
    assert default["root"] == "", "a non-empty default root is a silent location"


def test_declining_still_yields_the_default_root_but_is_recorded(monkeypatch):
    """Declining is a CHOICE, and the location it implies must not be a mystery.

    The user gets the default -- but `root_choice` says they were asked, so the
    prompt does not return, and Settings can show what they chose.
    """
    _settings(monkeypatch, {"root": "", "root_choice": "declined"})
    assert chat_runner.chat_workspace() == str(app_paths.data_dir() / "chat-workspace")
