"""The boundary enforcement — produces the typed refusal, never widens it.

DEC-35 step 4b. `chat_boundary` is the contract; this proves the enforcement
emits it correctly, including the two states the designer flagged as
most-likely-missed.

── THE CHECK ORDER IS THE GUARANTEE ──────────────────────────────────────
`missing` is reached ONLY after containment has already succeeded, so a
not-found can never be described in scope language. That is the structural half
of the promise; `Refusal.__post_init__` stripping the boundary is the other.
Both are asserted here, at the point the value is PRODUCED, because that is
where a regression would actually happen.
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import chat_boundary as B  # noqa: E402
import chat_boundary_check as C  # noqa: E402


@pytest.fixture()
def proj(tmp_path):
    p = tmp_path / "Ninebark"
    p.mkdir()
    (p / "notes.md").write_text("hello", encoding="utf-8")
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.txt").write_text("s", encoding="utf-8")
    return p


# ── Allowed ────────────────────────────────────────────────────────────────

def test_a_file_inside_the_project_is_allowed_for_both_verbs(proj):
    for verb in ("read", "write"):
        assert C.check_path(str(proj / "notes.md"), str(proj), verb) is None


def test_no_boundary_means_no_project_scope(proj):
    """"Not in a project" is an ABSENCE, not a locked scope (DEC-35)."""
    assert C.check_path(str(proj / "notes.md"), None, "read") is None


# ── outside ────────────────────────────────────────────────────────────────

def test_a_path_outside_the_project_is_refused_for_BOTH_verbs(proj, tmp_path):
    # A boundary that stops reads and not writes is not a boundary.
    for verb in ("read", "write"):
        r = C.check_path(str(tmp_path / "outside" / "secret.txt"), str(proj), verb)
        assert r is not None and r.kind == "outside"
        assert r.verb == verb
        assert r.is_scope is True
        assert r.boundary_path == str(proj)


def test_dotdot_traversal_is_decided_on_the_RESOLVED_path(proj, tmp_path):
    """Never on the requested string -- `..` looks inside and is not."""
    sneaky = str(proj / ".." / "outside" / "secret.txt")
    r = C.check_path(sneaky, str(proj), "read")
    assert r is not None and r.kind == "outside"


# ── THE COSTLIEST COLLAPSE, asserted where the value is produced ──────────

def test_MISSING_shares_no_wording_and_no_boundary_with_OUTSIDE(proj, tmp_path):
    """A file inside the folder that is simply not there.

    "The user copies a file in, it still fails, and now the app is a liar."
    Reached only because containment succeeded first -- which is what makes
    "copy it in and it works" true.
    """
    m = C.check_path(str(proj / "nope.txt"), str(proj), "read")
    o = C.check_path(str(tmp_path / "outside" / "secret.txt"), str(proj), "read")

    assert m.kind == "missing"
    assert o.kind == "outside"
    assert m.is_scope is False, "a not-found must not be styled as a refusal"
    assert m.boundary_path is None, "naming a boundary invites scope wording"
    assert (m.kind, m.is_scope, m.boundary_path) != (o.kind, o.is_scope, o.boundary_path)


def test_copying_the_file_in_makes_it_work(proj):
    """The promise `missing` implicitly makes, executed rather than asserted."""
    target = proj / "later.txt"
    assert C.check_path(str(target), str(proj), "read").kind == "missing"
    target.write_text("now here", encoding="utf-8")
    assert C.check_path(str(target), str(proj), "read") is None


# ── root_gone ──────────────────────────────────────────────────────────────

def test_a_deleted_project_folder_is_root_gone_not_outside(proj, tmp_path):
    gone = tmp_path / "Deleted"
    r = C.check_path(str(gone / "notes.md"), str(gone), "read")
    assert r.kind == "root_gone"
    # Not fixable by changing the request, so it must not read as a refusal of
    # the path the user asked for.
    assert r.kind != "outside"
    assert r.kind != "missing"


# ── THE JUNCTION: a real one, not a mock (clause 5) ───────────────────────

@pytest.mark.skipif(os.name != "nt", reason="junctions are Windows-specific")
def test_a_junction_pointing_outside_is_symlink_escape(proj, tmp_path):
    """The file is VISIBLY PRESENT inside the folder and still refused.

    And the detector matters: `is_symlink()` returns False for a junction, and
    a junction is the reparse point an UNPRIVILEGED user can create. An
    implementation asking `is_symlink()` ships a hole any user can open.
    """
    link = proj / "shortcut"
    r = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(tmp_path / "outside")],
                       capture_output=True, text=True)
    if r.returncode != 0 or not link.exists():
        pytest.skip("could not create a junction here")

    # The premise, re-measured in place: the obvious detector is blind.
    assert link.is_symlink() is False

    verdict = C.check_path(str(link / "secret.txt"), str(proj), "read")
    assert verdict is not None, "the junction escaped the boundary undetected"
    assert verdict.kind == "symlink_escape", f"got {verdict.kind}"
    # Told apart from a plain `outside`, because the experiences differ: the
    # user can SEE this file.
    assert verdict.kind != "outside"
    assert verdict.is_scope is True
    assert verdict.boundary_path == str(proj)
    # And it says where it actually points, which is the only thing that makes
    # a visible-but-refused file legible.
    assert "outside" in (verdict.os_reason or "")


# ── R19 / NOTE-41: the fail-closed path gets its OWN arm ─────────────────

def test_an_unresolvable_request_fails_closed_to_unknown_not_outside(proj, monkeypatch):
    """The pairwise arms build valid inputs and never reach this path.

    That is NOTE-41: a pairwise gate proves the declared states differ and
    cannot exercise the default. So the default is tested directly, and the
    assertion is that it is NOT `outside` -- the most plausible-looking wrong
    answer, and the one that accuses the boundary of something it did not do.
    """
    def boom(_p):
        raise OSError("the filename, directory name, or volume label syntax is incorrect")
    monkeypatch.setattr(C.os.path, "realpath", boom)

    r = C.check_path(str(proj / "notes.md"), str(proj), "read")
    assert r is not None
    assert r.kind == "unknown"
    assert r.kind != "outside"
    assert r.is_scope is False
    # The OS's own words survive -- a provider publishes its condition.
    assert "syntax is incorrect" in (r.os_reason or "")


def test_every_kind_the_enforcement_can_emit_is_in_the_declared_set(proj, tmp_path):
    """It produces the contract; it does not widen it."""
    seen = {
        C.check_path(str(tmp_path / "outside" / "s.txt"), str(proj), "read").kind,
        C.check_path(str(proj / "nope.txt"), str(proj), "read").kind,
        C.check_path(str(tmp_path / "Gone" / "x"), str(tmp_path / "Gone"), "read").kind,
    }
    assert seen <= set(B.KINDS)
    assert seen == {"outside", "missing", "root_gone"}


# ── The residual, asserted as documented rather than left implied ─────────

def test_the_TOCTOU_residual_is_written_down():
    """Clause 2: if it cannot be made atomic, SAY SO.

    A guarantee nobody wrote down is one the next reader assumes is stronger
    than it is. This pins the admission itself so it cannot quietly vanish in a
    later edit.
    """
    src = open(C.__file__, encoding="utf-8").read()
    assert "NOT atomic" in src
    assert "TOCTOU" in src
    assert "not a sandbox" in src.lower() or "NOT: a defence" in src
