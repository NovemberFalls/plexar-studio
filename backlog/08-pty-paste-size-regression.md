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

## RESOLVED (pending owner confirmation) — the pacing was load-bearing

Owner ran the decisive test: copied ~50 lines, pasted into **Notepad** — the
full text was there, so the CLIPBOARD AND THE COPY ARE FINE. The same paste into
a Cockpit terminal delivered only the final ~4 lines.

**The head was lost and the tail survived.** That is not truncation-on-write
(which keeps the head and loses the tail); it is a receiver whose buffer was
overrun and kept only what arrived last.

Which makes the cause mine, and it is not the one this file originally proposed.
Raising `_SINGLE_WRITE_MAX` to 64 KB did not merely remove an arbitrary cut — it
removed the **pacing**. The old path wrote 200 bytes at a time with
`_INTER_CHUNK_DELAY` (10 ms) between writes, and that delay is what kept ConPTY's
input buffer from being written faster than claude.exe drains it. A ~4 KB paste
went out as one burst, ConPTY kept the tail, and every layer reported success —
`conpty.write()` returned the full byte count, `WriteFile` never failed, no log
line anywhere.

The escape-splitting diagnosis for the bridge was right; the remedy was wrong.
The bridge is fixed by `_split_preserving_escapes` (boundaries cannot bisect a
marker), NOT by the absence of boundaries. With that in place the pacing comes
back at its previously-proven size and both properties hold at once.

Fix: `_SINGLE_WRITE_MAX` and `_CHUNK_SIZE` back to 200, escape-aware boundaries
retained. A 4 KB paste is ~20 chunks ≈ 200 ms.

**If this ceiling is ever raised again, the test is not "does the bridge work"
— it is "does a multi-KB paste arrive COMPLETE, head included."**

## Original proposed fix (superseded — kept for the reasoning)

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

## Diagnosis is now possible (it was not before)

While chasing the separate `[Session ended]` bug it turned out that
`_write_pty_sync`'s failure path logged at **DEBUG** — invisible at the shipped
INFO level. So if the paste failure went through a write error, it left no trace
at all, which is why the log looked clean. That path now logs at WARNING with
the exception, and partial writes / the safety valve already logged. **Retry the
paste on the next build and read the log**: it will now say whether the write
raised, wrote partially, tripped the 50-retry valve, or reported success (which
would mean ConPTY accepted the bytes and dropped them silently — the original
hypothesis, and the only one that leaves no log line).

## Regression test owed

There is no test covering a large *user* paste end-to-end — the new
`test_pty_escape_chunking.py` covers the splitter's properties in isolation, and
the bridge tests all use small payloads. That gap is why this shipped. A test
that drives a real PTY and asserts the child received every byte is the only kind
that would have caught it.
