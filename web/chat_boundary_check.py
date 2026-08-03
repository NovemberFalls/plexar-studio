"""Enforce a chat's project boundary. Produces `chat_boundary.Refusal` or None.

DEC-35 step 4b. The type is the contract; this produces it and does not widen
it. If a case here felt awkward to express in one of the six states, that would
be a signal about THIS file's shape rather than a reason for a seventh.

── THE CHECK ORDER IS THE DESIGN ─────────────────────────────────────────
Each step can only be reached once the ones above it are ruled out, and the
order is what keeps the states from collapsing:

  1. the boundary itself is gone            -> root_gone
  2. resolve the request                    (realpath, NOT the raw string)
  3. resolved path escapes the boundary
       ...and the REQUEST was lexically inside -> symlink_escape
       ...otherwise                             -> outside
  4. inside, but not present                -> missing
  5. inside and present, OS says no         -> denied
  6. otherwise                              -> allowed (None)

`missing` is reached ONLY after containment has already succeeded, so a
not-found can never be described in scope language. That ordering is the
structural half of the guarantee; `Refusal.__post_init__` stripping the
boundary is the other half. Both, deliberately: this is the collapse that would
make the app a liar.

── CONTAINMENT IS DECIDED ON THE RESOLVED PATH ───────────────────────────
Measured, not assumed: `Path.is_symlink()` and `os.path.islink()` BOTH return
False for a Windows junction, and a junction is the reparse point an
unprivileged user can create (`New-Item -ItemType SymbolicLink` needs Developer
Mode or admin; `-ItemType Junction` does not). So the detector that works is
`realpath()` followed by containment. An implementation checking the requested
string, or asking `is_symlink()`, ships a hole any user can open.

── ⚠ THE RESIDUAL, STATED RATHER THAN IMPLIED (clause 2) ─────────────────
**This is NOT atomic and cannot be made atomic in portable Python.** Between
`realpath()` and the caller's open(), a directory component can be replaced
with a reparse point pointing elsewhere -- the classic TOCTOU swap. The window
is small and closing it needs OS-level handle semantics
(`O_NOFOLLOW`/`FILE_FLAG_OPEN_REPARSE_POINT` plus re-validation on the open
handle) that this layer does not have.

**What this check therefore IS: a boundary against a user who moves files
around, symlinks a folder in, or types a path outside the project.** What it is
NOT: a defence against a local attacker racing the process. Studio runs one
user's chats on that user's own machine, so that is the right trade -- but it
is stated here so nobody later reads this as a sandbox.
"""

from __future__ import annotations

import os
from typing import Optional

import chat_boundary as B


def _real(path: str) -> str:
    """`realpath` with symlinks/junctions resolved, normalised for comparison.

    `strict=False` on purpose: a path that does not exist must still resolve so
    that a MISSING file inside the boundary is recognised as missing rather
    than failing the containment check and being reported as a scope refusal.
    """
    return os.path.normcase(os.path.realpath(path))


def _contains(boundary_real: str, candidate_real: str) -> bool:
    """Is *candidate* at or under *boundary*? Both already realpath'd."""
    try:
        return os.path.commonpath([candidate_real, boundary_real]) == boundary_real
    except ValueError:
        # Different drives on Windows -- commonpath raises rather than
        # returning something misleading. A different drive is not contained.
        return False


def check_path(requested_path: str, boundary_path: Optional[str],
               verb: str = "read") -> Optional[B.Refusal]:
    """Return a `Refusal`, or None when the access is permitted.

    `boundary_path` of None means the chat is not in a project and has no
    project boundary -- "not in a project" is an absence, not a locked scope
    (DEC-35). The caller still confines such chats to the default workspace by
    passing that directory as the boundary when it wants confinement.
    """
    if not boundary_path:
        return None

    # BOTH resolutions are guarded, not just the request's. The first draft
    # resolved the boundary OUTSIDE the try and an unresolvable boundary raised
    # straight out of the check instead of failing closed -- found by the
    # fail-closed arm, which is the one a pairwise gate cannot reach (NOTE-41).
    # A boundary check that can THROW is a boundary check that can be bypassed
    # by whatever catches the exception upstream.
    try:
        boundary_real = _real(boundary_path)
    except (OSError, ValueError) as exc:
        return B.unknown(verb, requested_path, os_reason=str(exc))

    if not os.path.isdir(boundary_path):
        # The project's folder itself is gone. Not the chat's fault and not
        # fixable by changing the request, so it must not read as a refusal of
        # the path the user asked for.
        return B.root_gone(verb, requested_path, boundary_path)

    try:
        requested_real = _real(requested_path)
    except (OSError, ValueError) as exc:
        return B.unknown(verb, requested_path, os_reason=str(exc))

    if not _contains(boundary_real, requested_real):
        # ESCAPED. Which of the two ways decides the wording, and the two are
        # genuinely different experiences: one is a path the user typed that
        # points elsewhere; the other is a file they can SEE inside the folder
        # that still refuses. Told apart by whether the request was lexically
        # inside before resolution.
        lexical = os.path.normcase(os.path.abspath(requested_path))
        if _contains(os.path.normcase(os.path.abspath(boundary_path)), lexical):
            return B.symlink_escape(verb, requested_path, boundary_path,
                                    resolved_to=os.path.realpath(requested_path))
        return B.outside(verb, requested_path, boundary_path)

    # ── Inside the boundary from here down. Nothing below may use scope
    #    wording, and nothing below carries a boundary path. ──
    if not os.path.exists(requested_path):
        # ORDINARY. The user copies the file in and it works -- which is only
        # true because this is reached AFTER containment succeeded.
        return B.missing(verb, requested_path)

    need = os.W_OK if verb == "write" else os.R_OK
    if not os.access(requested_path, need):
        return B.denied(verb, requested_path,
                        os_reason=f"the operating system refused {verb} access")

    return None


def assert_allowed(requested_path: str, boundary_path: Optional[str],
                   verb: str = "read") -> None:
    """`check_path`, raised. For call sites that want an exception."""
    refusal = check_path(requested_path, boundary_path, verb)
    if refusal is not None:
        raise BoundaryRefused(refusal)


class BoundaryRefused(Exception):
    """Carries the typed refusal so a handler never has to re-derive it."""

    def __init__(self, refusal: B.Refusal):
        self.refusal = refusal
        super().__init__(f"{refusal.kind}: {refusal.requested_path}")
