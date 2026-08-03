"""A GUI terminal's colour must not depend on how the GUI was launched.

MEASURED 2026-08-03, not hypothesised. Len: *"its terminal is colorless."*
`NO_COLOR=1` existed in the PROCESS environment only -- not User, not Machine --
because Studio had been started from an agent shell carrying it, and that shell
had already exited. `pty_manager` copies `os.environ` into the PTY child, so the
Claude Code CLI correctly disabled colour. **Nothing was broken except the
inheritance.** The CLI was right, the app was right, and the terminal was grey.

THE DECISION, stated because the row required one: **STRIP, NOT OVERRIDE.**
Forcing `FORCE_COLOR=1` would override the CLI's own detection in cases that
have nothing to do with this bug -- a redirected stream, a genuinely dumb
terminal. Removing an inherited signal that was never about this app leaves the
CLI free to decide correctly; forcing a value takes that away.

AND THE ESCAPE HATCH IS REAL. A colourless terminal is a legitimate thing to
want. What it must never be is an accident of launch context, so it lives in
settings (`terminal.no_color`) and nowhere else.

WHAT THESE TESTS ASSERT: the env dict the CHILD is given, not what the resolver
computed. That is the same seam (R26) this codebase has now found in a record
writer, a UI flag, a settings card, a chat root -- and in this very variable.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pty_backend  # noqa: E402
import pty_manager  # noqa: E402
import settings_store  # noqa: E402


def _child_env(monkeypatch, *, parent_env: dict, setting: bool | None) -> dict:
    """Build a session and return the env the PTY child was ACTUALLY given."""
    monkeypatch.setattr(os, "environ", dict(parent_env))
    if setting is None:
        monkeypatch.setattr(settings_store, "read_settings", lambda: {})
    else:
        monkeypatch.setattr(settings_store, "read_settings",
                            lambda: {"terminal": {"no_color": setting}})

    seen = {}

    class _FakePty:
        # `backend.spawn(...)` is the call site, so the fake exposes `spawn`.
        @staticmethod
        def spawn(*a, **kw):
            seen["env"] = kw.get("env")
            raise RuntimeError("stop: the env is what we came for")

    monkeypatch.setattr(pty_backend, "get_backend", lambda: _FakePty)
    # The CLI is resolved BEFORE the spawn, so an unresolvable `claude` aborts
    # create_session early and `spawn` is never reached. That made two of these
    # tests pass VACUOUSLY -- "NO_COLOR not in {}" is trivially true about an
    # env that was never built. Caught only because the pairwise test asserts a
    # declared table rather than an absence.
    monkeypatch.setattr(pty_manager, "resolve_claude_cli",
                        lambda path: ("claude", path))
    mgr = pty_manager.PtyManager()
    try:
        mgr.create_terminal(name="t", model="opus", workdir=os.getcwd())
    except Exception:
        pass
    env = seen.get("env")
    assert env is not None, "spawn was never reached -- this test proves nothing"
    return env


# ── The reproduction ───────────────────────────────────────────────────────

def test_an_inherited_NO_COLOR_does_NOT_reach_the_child(monkeypatch):
    """THE REGRESSION, reproduced: a launcher's NO_COLOR greyed the terminal."""
    env = _child_env(monkeypatch,
                     parent_env={"PATH": os.environ.get("PATH", ""), "NO_COLOR": "1"},
                     setting=None)
    assert "NO_COLOR" not in env, (
        "the launcher's NO_COLOR reached the CLI; the terminal will be colourless"
    )


def test_the_setting_puts_it_back(monkeypatch):
    """Intent is honoured even when nothing was inherited."""
    env = _child_env(monkeypatch,
                     parent_env={"PATH": os.environ.get("PATH", "")},
                     setting=True)
    assert env.get("NO_COLOR") == "1"


def test_unreadable_settings_leave_colour_ENABLED(monkeypatch):
    """Fail toward the feature the app exists to provide, not away from it."""
    def boom():
        raise OSError("settings.json is locked")
    monkeypatch.setattr(os, "environ", {"PATH": os.environ.get("PATH", ""), "NO_COLOR": "1"})
    monkeypatch.setattr(settings_store, "read_settings", boom)

    seen = {}

    class _FakePty:
        @staticmethod
        def spawn(*a, **kw):
            seen["env"] = kw.get("env")
            raise RuntimeError("stop")

    monkeypatch.setattr(pty_backend, "get_backend", lambda: _FakePty)
    monkeypatch.setattr(pty_manager, "resolve_claude_cli",
                        lambda path: ("claude", path))
    mgr = pty_manager.PtyManager()
    try:
        mgr.create_terminal(name="t", model="opus", workdir=os.getcwd())
    except Exception:
        pass
    assert seen.get("env") is not None, "spawn was never reached"
    assert "NO_COLOR" not in seen["env"]


# ── R10 / R19: the states are pairwise distinct with declared outcomes ─────

def test_the_four_launch_states_are_pairwise_distinct(monkeypatch):
    """Declared outcome per state, then every pair compared.

    The failure mode is two states becoming EQUAL -- specifically "the user
    asked for no colour" and "a shell happened to carry NO_COLOR", which are
    the same env var meaning opposite things. If those collapse, the app either
    ignores a real preference or reinstates the bug.
    """
    base = {"PATH": os.environ.get("PATH", "")}
    inherited = {**base, "NO_COLOR": "1"}

    outcomes = {
        "clean-launch, no setting":
            "NO_COLOR" in _child_env(monkeypatch, parent_env=base, setting=False),
        "inherited, no setting":
            "NO_COLOR" in _child_env(monkeypatch, parent_env=inherited, setting=False),
        "clean-launch, setting on":
            "NO_COLOR" in _child_env(monkeypatch, parent_env=base, setting=True),
        "inherited, setting on":
            "NO_COLOR" in _child_env(monkeypatch, parent_env=inherited, setting=True),
    }

    # DECLARED (R19), not discovered. The whole table, so a change to any cell
    # is a decision someone has to make rather than a result they can absorb.
    assert outcomes == {
        "clean-launch, no setting": False,
        "inherited, no setting": False,      # <- the fix
        "clean-launch, setting on": True,
        "inherited, setting on": True,
    }

    # The pair that carries the meaning: same variable in the parent, opposite
    # results, decided ONLY by whether the user asked for it.
    assert outcomes["inherited, no setting"] != outcomes["inherited, setting on"], (
        "the setting no longer distinguishes intent from inherited noise"
    )
    # And launch context must not change the answer when intent is fixed.
    assert outcomes["clean-launch, no setting"] == outcomes["inherited, no setting"], (
        "the terminal's colour still depends on which shell launched the GUI"
    )
    assert outcomes["clean-launch, setting on"] == outcomes["inherited, setting on"]


def test_stripping_NO_COLOR_does_not_disturb_the_rest_of_the_env(monkeypatch):
    """A targeted strip, not a sweep -- the child still needs PATH and friends."""
    parent = {"PATH": "/usr/bin", "HOME": "/home/x", "NO_COLOR": "1", "TERM": "xterm"}
    env = _child_env(monkeypatch, parent_env=parent, setting=None)
    # PATH is deliberately EXTENDED by pty_manager (system dirs prepended so a
    # spawn does not fail on a stripped PATH), so this asserts the parent's
    # entry SURVIVES rather than that the value is untouched. Asserting
    # equality here would be a test of pty_manager's PATH policy wearing the
    # label of a NO_COLOR test.
    assert "/usr/bin" in env.get("PATH", "")
    assert env.get("HOME") == "/home/x"
    assert env.get("TERM") == "xterm", "TERM is not ours to remove"

# ── The defect the stubbed tests above could NOT see ───────────────────────

def test_no_color_is_actually_reachable_in_DEFAULT_SETTINGS():
    """THE ONE THAT WOULD HAVE CAUGHT IT.

    Every test above monkeypatches `read_settings`, so none of them ever touch
    `DEFAULT_SETTINGS` -- and `DEFAULT_SETTINGS` carried TWO `"terminal"` dict
    literals. Python keeps the last, so `no_color` was silently discarded and
    the escape hatch did not exist. The suite was green because it stubbed the
    exact thing that was broken.

    Found only by reading the live app's `/api/settings` after an install.
    """
    t = settings_store.DEFAULT_SETTINGS.get("terminal") or {}
    assert "no_color" in t, (
        "terminal.no_color is unreachable -- a duplicate 'terminal' key in "
        "DEFAULT_SETTINGS would silently drop it"
    )
    assert t["no_color"] is False, "colour must be ON unless the user asks otherwise"


def test_DEFAULT_SETTINGS_has_no_duplicate_top_level_keys():
    """A dict literal with a repeated key is legal Python and silently lossy.

    Structural, not a list of remembered keys: any future duplicate is caught,
    not just this one.
    """
    import ast
    import pathlib
    src = pathlib.Path(settings_store.__file__).read_text(encoding="utf-8")
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        if not any(getattr(t, "id", None) == "DEFAULT_SETTINGS" for t in node.targets):
            continue
        keys = [k.value for k in node.value.keys if isinstance(k, ast.Constant)]
        dupes = {k for k in keys if keys.count(k) > 1}
        assert not dupes, f"DEFAULT_SETTINGS has duplicate keys: {sorted(dupes)}"
        return
    raise AssertionError("DEFAULT_SETTINGS assignment not found")
