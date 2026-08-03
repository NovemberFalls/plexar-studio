"""The typed refusal — gated as a type, before any enforcement exists.

DEC-35 step 4. The contract between the enforcement that refuses and the UI that
explains, designed first precisely because a boolean cannot express the state
that matters most.

── THE COLLAPSE THIS FILE EXISTS TO PREVENT ───────────────────────────────
`missing` folding into `outside`. A file genuinely inside the folder that simply
does not exist, explained to the user as a scope refusal: they copy the file in,
it still fails, **and the app is a liar.** The designer named it the costliest
failure in the design and they are right -- it converts a correct boundary into
one nobody trusts.

So the assertion is not "each kind is correct" but **"`missing` shares no
wording, no flag and no boundary with `outside`"**, which is the shape of the
failure rather than a checklist of the states.
"""

from __future__ import annotations

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import chat_boundary as B  # noqa: E402


# ── R10 / R19: the closed set, declared and mutually distinguishable ───────

def test_the_kind_set_is_DECLARED_and_closed():
    # Declared total, not a floor. A seventh kind added without a decision is a
    # state nothing has reasoned about -- and the UI renders six things.
    assert B.KINDS == ("outside", "symlink_escape", "missing", "denied",
                       "root_gone", "unknown")
    assert len(set(B.KINDS)) == 6


def test_every_kind_is_pairwise_distinguishable():
    """Not "each is correct" -- the failure mode is two becoming equal."""
    made = {
        "outside": B.outside("read", "C:/other/f.txt", "C:/proj"),
        "symlink_escape": B.symlink_escape("read", "C:/proj/link/f.txt", "C:/proj", "C:/other"),
        "missing": B.missing("read", "C:/proj/f.txt"),
        "denied": B.denied("read", "C:/proj/f.txt", "Access is denied"),
        "root_gone": B.root_gone("read", "C:/proj/f.txt", "C:/proj"),
        "unknown": B.unknown("read", "C:/proj/f.txt", "something else"),
    }
    assert set(made) == set(B.KINDS)
    disc = {name: (r.kind, r.is_scope, r.boundary_path is not None)
            for name, r in made.items()}
    for a in made:
        for b in made:
            if a < b:
                assert disc[a] != disc[b], f"{a} and {b} are indistinguishable: {disc[a]}"


# ── THE ONE THAT MATTERS ───────────────────────────────────────────────────

def test_MISSING_shares_nothing_with_OUTSIDE():
    """The collapse that would make the app a liar."""
    m = B.missing("read", "C:/proj/f.txt")
    o = B.outside("read", "C:/other/f.txt", "C:/proj")

    assert m.kind != o.kind
    # `missing` is ORDINARY: not a scope event...
    assert m.is_scope is False
    assert o.is_scope is True
    # ...and carries NO boundary, so the UI cannot render scope wording even by
    # accident. Naming a boundary that was not the reason invites exactly that.
    assert m.boundary_path is None
    assert o.boundary_path == "C:/proj"


def test_a_missing_file_never_acquires_a_boundary_even_if_one_is_passed():
    """Defence in depth: the type refuses, not just the constructor.

    A future caller assembling a Refusal by hand -- or a careless edit to the
    constructor -- must not be able to attach a boundary to an ordinary
    not-found. The invariant lives in the type.
    """
    r = B.Refusal("missing", "read", "C:/proj/f.txt", boundary_path="C:/proj")
    assert r.boundary_path is None
    assert r.is_scope is False


def test_denied_is_not_a_scope_event_either():
    """The boundary held; the OS refused. Explaining it as scope is wrong."""
    d = B.denied("write", "C:/proj/f.txt", "The process cannot access the file")
    assert d.is_scope is False
    assert d.boundary_path is None
    # And the OS's own words survive verbatim -- a provider publishes its
    # condition rather than a consumer restating it.
    assert d.os_reason == "The process cannot access the file"


# ── Fail closed, and to the RIGHT default ──────────────────────────────────

def test_an_unknown_kind_fails_closed_to_unknown_NOT_to_outside():
    """Widening-shaped (R19), and the default is the whole decision.

    `outside` is the worst possible fallback: it accuses the boundary of doing
    something it did not do, and it is the most plausible-looking wrong answer.
    """
    r = B.Refusal("teleported", "read", "C:/proj/f.txt", boundary_path="C:/proj")
    assert r.kind == "unknown"
    assert r.kind != "outside"
    assert r.is_scope is False, "an unrecognised failure must not be styled as a refusal"


def test_an_unknown_verb_fails_closed_to_read():
    # The safer of the two to over-report: claiming a write was refused when it
    # was a read invents an intent the user did not have.
    assert B.Refusal("missing", "teleport", "C:/proj/f.txt").verb == "read"


def test_a_refusal_is_frozen():
    """It is a RECORD of something that already happened."""
    r = B.outside("read", "C:/other/f.txt", "C:/proj")
    with pytest.raises(Exception):
        r.kind = "missing"


# ── symlink_escape carries the thing that makes it legible ────────────────

def test_symlink_escape_says_where_it_actually_points():
    """The file is visibly present. Without this it reads as a bug."""
    r = B.symlink_escape("read", "C:/proj/link/f.txt", "C:/proj", "C:/other")
    assert r.is_scope is True
    assert r.boundary_path == "C:/proj"
    assert "C:/other" in (r.os_reason or ""), "the user can see the file; say where it goes"
    # And it is NOT the same state as a plain outside -- same verdict, different
    # explanation, and the difference is the whole point.
    assert r.kind != B.outside("read", "C:/other/f.txt", "C:/proj").kind


# ── The measured Windows fact this design depends on ──────────────────────

@pytest.mark.skipif(os.name != "nt", reason="junction behaviour is Windows-specific")
def test_is_symlink_does_NOT_see_a_junction_but_realpath_does(tmp_path):
    """MEASURED, and it is why the enforcement must not use `is_symlink()`.

    A junction is the reparse point an UNPRIVILEGED user can create --
    `New-Item -ItemType SymbolicLink` needs Developer Mode or admin, while
    `-ItemType Junction` does not. So the case that actually reaches users is
    exactly the one `is_symlink()` misses.
    """
    import subprocess
    inside = tmp_path / "inside"; inside.mkdir()
    outside = tmp_path / "outside"; outside.mkdir()
    (outside / "secret.txt").write_text("s", encoding="utf-8")
    link = inside / "j"
    r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)],
                       capture_output=True, text=True)
    if r.returncode != 0 or not link.exists():
        pytest.skip("could not create a junction here")

    assert link.is_symlink() is False, "if this ever becomes True, revisit the enforcement"
    assert os.path.islink(link) is False

    # The detector that DOES work: resolve, then containment.
    target = link / "secret.txt"
    real = os.path.realpath(target)
    ins = os.path.realpath(inside)
    assert os.path.commonpath([real, ins]) != ins, "realpath must expose the escape"
