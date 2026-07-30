# 08 — Large paste stopped working (regression, shipped in 1.12.0)

**Priority: P0.** Introduced today by me, in the build you are running. Everything
else in this backlog is a want; this is a working thing that stopped working.

## Symptom

Owner copied ~50 lines of CLI output, pasted into a terminal, "it didn't work."
Short pastes, `/rename`, and bridge messages all work.

## Why this is almost certainly the chunking change

`write_pty_async` used to slice **every** payload over 200 bytes into 200-byte
chunks with a 10 ms gap between them. That existed for a documented reason — the
comment above `_INTER_CHUNK_DELAY` records that the chunk size was *halved to
200* specifically "to address paste fragmentation on ~400-byte pastes where
ConPTY silently drops bytes." So byte-drop at a few hundred bytes was an
**observed, reproduced failure**, not a theoretical worry.

To fix the bridge (bracketed-paste markers being cut mid-sequence) I raised the
single-write ceiling to 64 KB. A ~4 KB paste that previously went out as ~20
paced chunks now goes out as **one 4 KB write** — precisely the condition the old
code existed to prevent.

The things that still work are consistent with this reading, which is what makes
it more than a guess:

| path | payload | still works? |
|---|---|---|
| `/rename` | ~30 B | yes |
| bridge inline relay | < 2 KB (`_RELAY_INLINE_MAX`) | yes |
| bridge large relay | file handoff → small prompt | yes |
| **user paste** | **KBs, unbounded** | **no** |

Every working path is small. The one broken path is the only one that got
materially bigger.

## Not yet measured

I tried to measure ConPTY's actual drop threshold with a PTY child that counts
received bytes; it hung and I killed it rather than sink more time. So the
**threshold is unknown** — 4 KB fails is inferred, not observed. Whoever picks
this up should get that number first, because it sets the ceiling.

## Proposed fix

The two requirements are not in conflict once the boundaries are escape-aware:

1. Keep `_split_preserving_escapes` (already written and tested) so a boundary
   can never bisect `\x1b[200~` / `\x1b[201~`. This is what fixed the bridge.
2. **Lower `_SINGLE_WRITE_MAX` from 64 KB to whatever ConPTY actually tolerates**
   and let everything above it chunk *with escape-aware boundaries* + the
   inter-chunk delay.

The owner's ask was "no limit other than the harness limit." Worth being straight
about the outcome: ConPTY's input pipe **is** a real limit, not an arbitrary one
Cockpit invented. The 200-byte number was arbitrary; the existence of a ceiling
is not. The honest version of the ask is "no ceiling below what the pipe can
take," which is what the fix above delivers.

## Regression test owed

There is no test covering a large *user* paste end-to-end — the new
`test_pty_escape_chunking.py` covers the splitter's properties in isolation, and
the bridge tests all use small payloads. That gap is why this shipped. A test
that drives a real PTY and asserts the child received every byte is the only kind
that would have caught it.
