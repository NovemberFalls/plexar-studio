"""Why a chat could not reach a path — the typed reason, designed before the gate.

DEC-35: a group is a project is a folder, and *"never outside, its blocked, each
group is locked to its scope."* This module is the CONTRACT between the
enforcement that refuses and the UI that explains. It contains no enforcement
and no rendering; it exists so that neither has to guess what the other meant.

── WHY A TYPE AND NOT A BOOLEAN ────────────────────────────────────────────
A boolean collapses six outcomes into one, and **the collapse that matters is
`missing` folding into `outside`**: a file that is genuinely inside the folder
and simply does not exist would be explained to the user as a scope refusal.
They copy the file in, it still fails, and the app is now a liar. That is the
costliest failure in this design, which is why the type is designed BEFORE the
enforcement rather than extracted from it afterwards.

── THE SIX STATES, AND WHAT EACH ONE IS *NOT* ─────────────────────────────
  outside         the path resolves outside the boundary. A correct refusal.
  symlink_escape  the path is INSIDE the folder and points outside. The file is
                  visibly present and still refused -- without explicit wording
                  this is indistinguishable from a bug.
  missing         inside the boundary, simply not there. **ORDINARY.** Not a
                  security event, no scope wording, no boundary path, no
                  remedy. It is just a file that isn't there.
  denied          inside the boundary, the OS said no. Permissions, a lock, a
                  read-only volume. The boundary held; something else refused.
  root_gone       the project's folder itself is missing. Not the chat's fault
                  and not fixable by changing the request.
  unknown         **THE FAIL-CLOSED DEFAULT.** See below.

── R19: THIS SET IS CLOSED, WHICH MAKES IT WIDENING-SHAPED ────────────────
An unrecognised kind must fail closed to its OWN state and must never silently
render as `outside`. Two different failures wearing one label is how a wrong
explanation gets shipped with confidence -- and `outside` is the worst possible
default because it is the one that accuses the boundary of doing something it
did not do.

── WHAT THE MEASUREMENT SAID ABOUT `symlink_escape` ON WINDOWS ────────────
Measured 2026-08-03 against a real junction, because the designer flagged this
as possibly undetectable:

  Path.is_symlink()                      -> **False**   (does NOT see junctions)
  os.path.islink()                       -> **False**
  lstat().st_file_attributes & 0x400     -> True        (reparse-point bit)
  os.path.realpath() + containment check -> **catches the escape**

**So it IS detectable -- but not by the obvious means.** An implementation
reaching for `is_symlink()` would silently miss junctions, and a junction is the
one an UNPRIVILEGED user can create: `New-Item -ItemType SymbolicLink` failed
without Developer Mode or admin, while `-ItemType Junction` succeeded. The
enforcement must resolve with `realpath()` and compare containment; the reparse
bit is a usable secondary signal for telling `symlink_escape` apart from a
plain `outside`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

#: Every kind the enforcement may produce. CLOSED SET -- see the module note.
KINDS = ("outside", "symlink_escape", "missing", "denied", "root_gone", "unknown")

#: The kinds that are a scope decision. `missing` and `denied` are deliberately
#: NOT here: the boundary held or was never involved, and describing them in
#: scope language is the collapse this module exists to prevent.
SCOPE_KINDS = ("outside", "symlink_escape")

VERBS = ("read", "write")


@dataclass(frozen=True)
class Refusal:
    """One refusal, fully explained, produced by the enforcement.

    Frozen because a refusal is a RECORD of something that already happened.
    A caller that could mutate `kind` after the fact would be re-deciding a
    question the enforcement already answered.
    """

    kind: str
    verb: str
    requested_path: str
    #: The project folder this chat is locked to. **None for `missing` and
    #: `denied`** -- naming a boundary that was not the reason invites the UI
    #: to explain it as one.
    boundary_path: Optional[str] = None
    #: The OS's own words, passed through and NEVER rewritten. A provider
    #: publishes its condition; a consumer does not restate it.
    os_reason: Optional[str] = None

    def __post_init__(self) -> None:
        # FAIL CLOSED, and to `unknown` rather than to `outside`. An
        # unrecognised kind is a bug in the enforcement, and rendering it as a
        # scope refusal would blame the boundary for it.
        if self.kind not in KINDS:
            object.__setattr__(self, "kind", "unknown")
        if self.verb not in VERBS:
            object.__setattr__(self, "verb", "read")

        if self.kind in ("missing", "denied"):
            object.__setattr__(self, "boundary_path", None)

    @property
    def is_scope(self) -> bool:
        """True only when the BOUNDARY is the reason.

        The UI keys its amber treatment on this. `missing` is ordinary and must
        not get it: a correct refusal and a file that isn't there should not
        look alike, or the user learns to retry both.
        """
        return self.kind in SCOPE_KINDS


# ── Constructors, so a caller never types a kind string ────────────────────
# Every one of these is a named decision. A caller assembling `Refusal(kind=...)`
# by hand is one typo from `unknown`, and the point of a closed set is that the
# set is closed at the call site too.

def outside(verb: str, requested_path: str, boundary_path: str) -> Refusal:
    return Refusal("outside", verb, requested_path, boundary_path)


def symlink_escape(verb: str, requested_path: str, boundary_path: str,
                   resolved_to: Optional[str] = None) -> Refusal:
    """Inside the folder, resolving outside it.

    `resolved_to` rides in `os_reason` because it IS the explanation: the user
    can see the file, so the only thing that makes the refusal legible is where
    it actually points.
    """
    return Refusal("symlink_escape", verb, requested_path, boundary_path,
                   os_reason=(f"resolves to {resolved_to}" if resolved_to else None))


def missing(verb: str, requested_path: str) -> Refusal:
    """Inside the boundary, not there. ORDINARY -- no boundary, no scope."""
    return Refusal("missing", verb, requested_path)


def denied(verb: str, requested_path: str, os_reason: Optional[str] = None) -> Refusal:
    """Inside the boundary; the OS refused. The boundary is not the reason."""
    return Refusal("denied", verb, requested_path, os_reason=os_reason)


def root_gone(verb: str, requested_path: str, boundary_path: str) -> Refusal:
    """The project's folder itself is gone. Not fixable by changing the path."""
    return Refusal("root_gone", verb, requested_path, boundary_path)


def unknown(verb: str, requested_path: str, os_reason: Optional[str] = None) -> Refusal:
    """The enforcement hit something it does not have a name for.

    Exists so that "we do not know" is a state the UI can render honestly,
    rather than a gap someone fills with the nearest plausible label.
    """
    return Refusal("unknown", verb, requested_path, os_reason=os_reason)
