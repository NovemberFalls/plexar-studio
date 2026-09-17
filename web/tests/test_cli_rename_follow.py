"""Studio follows a rename made INSIDE the CLI (SPEC §1).

Two channels: Claude Code's transcript `custom-title` record, and the terminal
title escape (OSC 0/2) which is the only channel Codex offers.
"""

import json
import logging
import os
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("MAX_SESSIONS", "3")

from jsonl_watcher import latest_custom_title  # noqa: E402
from pty_manager import (  # noqa: E402
    PtyManager,
    SessionStateTracker,
    TerminalSession,
    normalize_cli_title,
)


def _line(**obj) -> str:
    return json.dumps(obj) + "\n"


def make_session(terminal_id="t1", harness="claude-code", name="Original"):
    pty = MagicMock()
    pty.isalive.return_value = True
    return TerminalSession(
        id=terminal_id,
        name=name,
        pty=pty,
        created_at="2026-01-01T00:00:00Z",
        model="sonnet",
        harness=harness,
        working_dir="C:\\Code",
    )


class TestLatestCustomTitle:
    def test_last_custom_title_wins(self, tmp_path):
        p = tmp_path / "s.jsonl"
        p.write_text(
            _line(type="custom-title", customTitle="First")
            + _line(type="user", uuid="u1")
            + _line(type="custom-title", customTitle="Second"),
            encoding="utf-8",
        )
        assert latest_custom_title(str(p)) == "Second"

    def test_ai_title_is_not_adopted(self, tmp_path):
        p = tmp_path / "s.jsonl"
        p.write_text(
            _line(type="custom-title", customTitle="Mine")
            + _line(type="ai-title", aiTitle="Robot Chose This"),
            encoding="utf-8",
        )
        assert latest_custom_title(str(p)) == "Mine"

    def test_no_title_returns_none(self, tmp_path):
        p = tmp_path / "s.jsonl"
        p.write_text(_line(type="user", uuid="u1"), encoding="utf-8")
        assert latest_custom_title(str(p)) is None

    def test_missing_file_returns_none(self, tmp_path):
        assert latest_custom_title(str(tmp_path / "nope.jsonl")) is None

    def test_reads_only_the_tail_of_a_large_file(self, tmp_path):
        """A title outside the tail window is not seen; the file is never fully read."""
        p = tmp_path / "big.jsonl"
        filler = _line(type="user", uuid="x" * 200)
        with open(p, "w", encoding="utf-8") as f:
            f.write(_line(type="custom-title", customTitle="TooOld"))
            for _ in range(2000):  # well over the 64 KB tail window
                f.write(filler)
            f.write(_line(type="custom-title", customTitle="Recent"))
        assert p.stat().st_size > 65536
        assert latest_custom_title(str(p)) == "Recent"
        # And with a tiny window the old one is out of reach entirely.
        assert latest_custom_title(str(p), tail_bytes=len(filler) * 3) == "Recent"

    def test_partial_first_line_is_dropped_not_parsed(self, tmp_path):
        p = tmp_path / "s.jsonl"
        p.write_text(
            _line(type="custom-title", customTitle="Truncated")
            + _line(type="custom-title", customTitle="Whole"),
            encoding="utf-8",
        )
        # Window starts mid-file, so the first line is partial.
        size = p.stat().st_size
        assert latest_custom_title(str(p), tail_bytes=size - 10) == "Whole"

    def test_blank_and_overlong_titles(self, tmp_path):
        p = tmp_path / "s.jsonl"
        p.write_text(
            _line(type="custom-title", customTitle="Kept")
            + _line(type="custom-title", customTitle="   "),
            encoding="utf-8",
        )
        assert latest_custom_title(str(p)) == "Kept"

        q = tmp_path / "long.jsonl"
        q.write_text(_line(type="custom-title", customTitle="z" * 500), encoding="utf-8")
        assert latest_custom_title(str(q)) == "z" * 120


class TestTrackerOscTitle:
    def test_bel_terminated_osc_0(self):
        t = SessionStateTracker()
        t.feed("\x1b]0;My Session\x07hello")
        assert t.osc_title == "My Session"

    def test_st_terminated_osc_2(self):
        t = SessionStateTracker()
        t.feed("\x1b]2;Other Session\x1b\\")
        assert t.osc_title == "Other Session"

    def test_last_title_in_chunk_wins(self):
        t = SessionStateTracker()
        t.feed("\x1b]0;A\x07\x1b]2;B\x07")
        assert t.osc_title == "B"

    def test_non_title_osc_is_ignored(self):
        t = SessionStateTracker()
        t.feed("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")
        assert t.osc_title is None

    def test_extraction_does_not_disturb_state_detection(self):
        t = SessionStateTracker()
        t.feed("\x1b]0;Title\x07 1,234 tokens $0.50")
        assert t.osc_title == "Title"
        assert t.total_tokens == 1234
        assert t.total_cost == 0.50
        assert "Title" not in t.buffer  # the escape is stripped from the text buffer


class TestRefreshCliTitle:
    def setup_method(self):
        self.mgr = PtyManager()

    def _write_title(self, tmp_path, title):
        p = tmp_path / "s.jsonl"
        p.write_text(_line(type="custom-title", customTitle=title), encoding="utf-8")
        return str(p)

    def test_adopts_custom_title(self, tmp_path, monkeypatch):
        s = make_session()
        path = self._write_title(tmp_path, "Renamed In CLI")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: path)
        assert self.mgr._refresh_cli_title(s) == "Renamed In CLI"
        assert s.name == "Renamed In CLI"
        assert s.cli_title == "Renamed In CLI"
        assert s.name_source == "cli"

    def test_throttled_to_once_per_five_seconds(self, tmp_path, monkeypatch):
        s = make_session()
        path = self._write_title(tmp_path, "First CLI Name")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: path)
        assert self.mgr._refresh_cli_title(s) == "First CLI Name"

        self._write_title(tmp_path, "Second CLI Name")
        assert self.mgr._refresh_cli_title(s) is None  # inside the throttle window
        assert s.name == "First CLI Name"

        s._cli_title_checked -= 10.0  # pretend 10s elapsed
        assert self.mgr._refresh_cli_title(s) == "Second CLI Name"
        assert s.name == "Second CLI Name"

    def test_unchanged_title_does_not_relog(self, tmp_path, monkeypatch, caplog):
        s = make_session()
        path = self._write_title(tmp_path, "Stable")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: path)
        # cockpit.* loggers do not propagate to root, so attach caplog's handler
        # to the logger under test directly rather than relying on propagation.
        logger = logging.getLogger("cockpit.pty")
        # Another module's logging_config.setup() can leave this logger above
        # INFO when the whole suite runs; the assertion below counts INFO lines,
        # so pin the level here rather than depending on test order.
        caplog.set_level(logging.INFO, logger="cockpit.pty")
        logger.addHandler(caplog.handler)
        try:
            assert self.mgr._refresh_cli_title(s) == "Stable"
            s._cli_title_checked -= 10.0
            assert self.mgr._refresh_cli_title(s) is None
        finally:
            logger.removeHandler(caplog.handler)
        # Whether cockpit.pty propagates depends on test order (logging_config.setup
        # turns it off). When it does, the SAME record reaches caplog twice: via
        # the handler attached above and via the root. Count records, not arrivals.
        renames = {id(r) for r in caplog.records if "renamed by the CLI" in r.getMessage()}
        assert len(renames) == 1

    @pytest.mark.parametrize("binary", ["claude", "Codex", "CLAUDE"])
    def test_never_adopts_the_binary_name(self, binary, monkeypatch):
        s = make_session(harness="codex")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        s.tracker.osc_title = binary
        assert self.mgr._refresh_cli_title(s) is None
        assert s.name == "Original"
        assert s.name_source == "studio"

    def test_osc_channel_seeds_first_title_without_adopting(self, monkeypatch):
        """The first OSC title a CLI emits is its startup default, not a rename."""
        s = make_session(harness="codex")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        s.tracker.feed("\x1b]0;Codex Work\x07")
        assert self.mgr._refresh_cli_title(s) is None
        assert s.name == "Original"
        assert s.name_source == "studio"
        assert s.cli_title == "Codex Work"  # seeded

    def test_osc_channel_adopts_on_change_after_seed(self, monkeypatch):
        s = make_session(harness="codex")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        s.tracker.feed("\x1b]0;Codex Work\x07")
        assert self.mgr._refresh_cli_title(s) is None  # seed
        s._cli_title_checked -= 10.0
        s.tracker.feed("\x1b]0;Renamed Codex Session\x07")
        assert self.mgr._refresh_cli_title(s) == "Renamed Codex Session"
        assert s.name == "Renamed Codex Session"
        assert s.name_source == "cli"

    def test_osc_channel_desktop_rename_survives_unchanged_title(self, monkeypatch):
        """A desktop rename is not clobbered while the CLI's title hasn't moved."""
        s = make_session(harness="codex")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        s.tracker.feed("\x1b]0;Codex Work\x07")
        assert self.mgr._refresh_cli_title(s) is None  # seed
        s.name = "Desktop Given Name"
        s.name_source = "studio"
        s._cli_title_checked -= 10.0
        # Same title still, no change -> nothing adopts.
        s.tracker.feed("\x1b]0;Codex Work\x07")
        assert self.mgr._refresh_cli_title(s) is None
        assert s.name == "Desktop Given Name"
        assert s.name_source == "studio"

    def test_desktop_rename_then_newer_cli_rename_wins(self, tmp_path, monkeypatch):
        s = make_session()
        path = self._write_title(tmp_path, "CLI One")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: path)
        self.mgr.sessions[s.id] = s
        assert self.mgr._refresh_cli_title(s) == "CLI One"

        self.mgr.rename_terminal(s.id, "Desktop Name")
        assert s.name == "Desktop Name"
        assert s.name_source == "studio"
        assert s.cli_title == "CLI One"  # not cleared

        self._write_title(tmp_path, "CLI Two")
        s._cli_title_checked -= 10.0
        assert self.mgr._refresh_cli_title(s) == "CLI Two"
        assert s.name == "CLI Two"
        assert s.name_source == "cli"

    def test_same_title_as_current_name_is_not_adopted(self, monkeypatch):
        # cli_title is None on a fresh session, so this is a SEED (never an
        # adoption) regardless of whether it happens to match the name already.
        s = make_session(name="Already This")
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        s.tracker.osc_title = "Already This"
        assert self.mgr._refresh_cli_title(s) is None
        assert s.name_source == "studio"
        assert s.name == "Already This"

    def test_refresh_cli_titles_skips_dead_and_survives_errors(self, monkeypatch):
        alive = make_session("a")
        dead = make_session("d")
        dead.alive = False
        self.mgr.sessions = {"a": alive, "d": dead}

        seen = []

        def fake(sess):
            seen.append(sess.id)
            raise RuntimeError("boom")

        monkeypatch.setattr(self.mgr, "_refresh_cli_title", fake)
        self.mgr.refresh_cli_titles()  # must not raise
        assert seen == ["a"]

    def test_session_dict_carries_name_source_and_cli_title(self, monkeypatch):
        s = make_session()
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        s.tracker.osc_title = "From The CLI"
        self.mgr._refresh_cli_title(s)  # seed
        s._cli_title_checked -= 10.0
        s.tracker.osc_title = "From The CLI Renamed"
        self.mgr._refresh_cli_title(s)  # change -> adopt
        self.mgr.sessions[s.id] = s
        row = self.mgr._session_to_dict(s)
        assert row["name"] == "From The CLI Renamed"
        assert row["name_source"] == "cli"
        assert row["cli_title"] == "From The CLI Renamed"


class TestNormalizeCliTitle:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("✳ Session 1", "Session 1"),
            ("◑ Claude Code", "Claude Code"),
            ("Hermes?", "Hermes?"),
            ("�\xa0� browser-rpg", None),
            ("claude", None),
            ("Claude", None),
            ("CODEX", None),
            ("✳️  My App (dev)", "My App (dev)"),
        ],
    )
    def test_worked_examples(self, raw, expected):
        assert normalize_cli_title(raw) == expected

    def test_none_input(self):
        assert normalize_cli_title(None) is None

    def test_blank_after_stripping_decoration_is_none(self):
        assert normalize_cli_title("✳   ") is None

    def test_caps_at_120_chars(self):
        assert normalize_cli_title("z" * 500) == "z" * 120

    def test_internal_punctuation_and_emoji_preserved(self):
        assert normalize_cli_title("My-App_v2 (✨ shiny)") == "My-App_v2 (✨ shiny)"


class TestRefreshCliTitleRepair:
    def setup_method(self):
        self.mgr = PtyManager()

    def test_repairs_decorated_name_once(self, monkeypatch):
        s = make_session(name="✳ Session 1")
        s.name_source = "cli"
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        assert self.mgr._refresh_cli_title(s) is None
        assert s.name == "Session 1"

    def test_never_blanks_a_name_it_cannot_normalize(self, monkeypatch):
        s = make_session(name="� garbled")
        s.name_source = "cli"
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        assert self.mgr._refresh_cli_title(s) is None
        assert s.name == "� garbled"  # left alone, never blanked

    def test_does_not_repair_studio_named_sessions(self, monkeypatch):
        s = make_session(name="✳ Studio Given")
        s.name_source = "studio"
        monkeypatch.setattr(self.mgr, "_get_jsonl_path", lambda sess: None)
        assert self.mgr._refresh_cli_title(s) is None
        assert s.name == "✳ Studio Given"  # untouched -- not CLI-sourced
