# 09 — Reporting & Settings UI backlog

Owner walkthrough of 1.12.0, 2026-07-30. Grouped so these can land as separate
commits rather than one sprawling change. Ordered by importance within groups.

Anything in `08-pty-paste-size-regression.md` comes first — that is a regression,
these are all wants.

---

## Group A — Panels don't use the space they're given

**One complaint, four sightings, and very likely one root cause:** panels have
fixed heights/widths, so they scroll internally while the viewport below them
sits empty. The owner's framing is the spec: *extend to at least the bottom of
the usable area, without making that usable area a scroll.*

This is the highest-value group — it's the whole app's felt quality, and if the
cause really is shared, it is one fix repeated.

### A1. Reports ▸ Sessions — worst offender
`EVERY SESSION IN THIS RANGE` shows ~11 of **78** rows in a fixed box, then ~60%
of the page is empty. The table should grow to the available height.

### A2. Reports ▸ Overview — same, two panels
`SESSIONS IN THIS RANGE` and `WHERE THE SPEND GOES` both scroll internally with
a large empty region beneath. `WHERE THE SPEND GOES` shows 3 models in a
scrollbox tall enough for ~4.

### A3. Settings — content column is not full width
Content is capped around 1045 px on a 3236 px window. On a wide monitor most of
the page is empty. Decide deliberately: a readability max-width is a legitimate
choice, but this one is far below where readability stops improving, and the
owner reads it as broken. Either raise it substantially or make it fluid.

### A4. Settings ▸ Diagnostics & logs — log viewer height
The log pane is a fixed ~380 px box; the page ends around 45% of the window
height. Should fill down to the bottom.

**Do first:** confirm whether A1–A4 share a cause (a common `max-height`/
`max-width` in the panel/card primitives) before fixing them one at a time. If
they do, this is one change plus tests, not four.

---

## Group B — Log viewer affordances

### B1. No "ALL" option on log LOAD
Choices are 200 / 500 / 1000 / 2000 with no ALL. This one is safe to add:
retention is already bounded at 8 MB total (2 MB/file + 3 rotated copies), so
"all" cannot be unbounded. Without it, the panel's own caveat — *"an empty result
means the text is not in this tail; load more lines before concluding it is not
in the log"* — has no final rung to climb to.

---

## Group C — Unbuilt Settings pages: build or remove?

Both render a "not built yet" placeholder. A nav entry that leads to an apology
is worse than no entry — it costs a click to learn nothing. **Each needs a
build-or-delete decision, not a default to building.**

### C1. General & startup — *recommend BUILD*
Holds real settings that currently exist only as environment variables
(`COCKPIT_MANAGED_BROKER`, `COCKPIT_MANAGED_VLLM`, `MAX_SESSIONS`, workspace
root, restore-sessions-on-launch). Those are genuinely unreachable to a desktop
user today, so this page has a job nothing else does.

Caveat: `settings.json` already *persists* `max_sessions` but the server does not
*read* it. Building the UI without closing that loop ships a control that lies.

### C2. Permissions & safety — *recommend REMOVE the nav entry*
Its own placeholder says the functionality "lives in the DEFAULTS pill in the
command bar and the per-session Inspector" — i.e. it is already built, twice.
A third surface for the same two values invites the classic drift bug where two
places disagree. Unless there is a real want here (an allow/deny *policy* the
pill can't express — e.g. forbidding `bypassPermissions` entirely), delete the
row.

---

## Group E — Observability (raised by the "[Session ended]" hunt)

### E1. The test suite writes into the user's real log file
`~/.claude-cockpit/logs/cockpit.log` contains pytest tracebacks — deliberate
error-path tests from `test_pricing_store.py` (including a literal
`RuntimeError("something truly unexpected")`) sitting in the shipped log next to
real events. Anyone reading the log to diagnose a live problem has to first work
out which entries are fake. Tests should log to a tmp path.

### E2. Session lifecycle needs a real audit trail
Owner's words: *"if you are unable to track this we need a better built in audit
log."* Correct. The `[Session ended]` bug logged at DEBUG, so the one code path
that killed sessions was invisible at the shipped INFO level — the log looked
clean while sessions were dying. That path is now WARNING, but the general point
stands: **every transition of `session.alive` should be logged with its cause.**
Right now several sites flip it with no record at all.


## Group D — Strategic, plan before touching

Not actionable yet; recorded so they aren't rediscovered.

### D1. Engine's future
The owner is building **plexar-vllm**, a dedicated face for vLLM. If engine
management moves there, Cockpit's Engine section may shrink to a status readout
or disappear. **Do not invest in Engine UI until this is decided** — Group A
deliberately does not touch Engine for that reason.

Related, already recorded: `07-vllm-face-theorycraft.md` says harvest before
deleting anything, particularly `_vllm_sampler_loop`'s reset-detect-and-bank
logic.

### D2. Rename everything to Plexar
A product-wide rename touching the app name, the NSIS bundle identifier, the
updater endpoint, `~/.claude-cockpit/` on disk, `cockpit.*` loggers, the
`COCKPIT_*` env vars, and the GitHub repo.

**Sequencing matters more than the work:** the bundle identifier and the data
directory are the two that break existing installs — a changed identifier makes
the updater treat it as a different app, and a changed data dir orphans usage
history, pricing, and settings. Plan a migration for both, and do the rename at a
quiet point, **not** interleaved with feature work. The owner's instinct to do
this "once we stop making changes" is the right call.

---

## Suggested order

1. `08` — paste regression (P0, shipped bug)
2. **A** — panel sizing (one root cause, biggest felt improvement)
3. **B1** — log ALL (small, self-contained)
4. **C2** — delete the Permissions & safety row (a deletion, near-zero risk)
5. **C1** — build General & startup, including making `max_sessions` actually read
6. **D** — only after the plexar-vllm split is decided
