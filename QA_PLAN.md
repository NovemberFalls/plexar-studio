# QA_PLAN — Plexar Studio 1.32.0 (local build, not released)

**Installer:** `C:\Code\Personal\claude-cockpit\releases\Plexar-Studio_1.32.0_x64-setup.exe`
**Branch:** `lane/studio` · **Rollback tag:** `pre-s14-origin-guard`
**Built:** 2026-08-04 · signed · **NOT pushed, NOT released, no `latest.json`.**

Version bumped 1.31.0 → 1.32.0 **for QA identity only** — a same-version respin is
indistinguishable from your running 1.31.0 in the version pill, which makes "am I
testing the new build?" unanswerable. **Confirm the pill reads 1.32.0 before doing
anything else, or every result below is about the wrong binary.**

## What changed (three things, all in this build)

| # | Change | Risk if wrong |
|---|---|---|
| S14 | Origin+Host guard over `/api/*` and the terminal WebSocket | **The app does not work at all** — blank UI, no terminals |
| S17 | PID files port-scoped | An orphaned `claude.exe` survives a crash |
| S18 | `wsDiagnose` tells "origin refused" from "backend down" | A wrong or missing message on disconnect |

**S14 is the one that can break everything.** It refuses HTTP requests whose `Origin`
is not allowlisted and whose `Host` is not loopback. If the packaged app's webview
presents an origin I predicted wrongly, **nothing loads.** That is the single most
important thing this QA is checking, and it is why arm 1 is first.

---

## A · Does it run at all (do these first, stop if any fail)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| A1 | Install and launch the desktop app | Window opens, UI renders, **version pill reads 1.32.0** | **PASS** — pill confirmed 1.32.0 |
| A2 | Create a new session | Terminal spawns, `claude` banner appears | **PASS** — sessions running |
| A3 | Type in it | Keystrokes appear, replies stream back | **PASS** — this session is on 1.32.0 |
| A4 | Open a second session, switch between panes | Both live, output not crossed | ☐ |

**If A1 renders a blank window, or A2 spawns nothing: STOP.** That is the guard
refusing the webview's own origin. Say so and I will fix it — do not work around it.

## B · The guard is actually on (the point of the release)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| B1 | With Studio running, open a browser to `http://127.0.0.1:8420/api/terminals` | JSON loads — **this is EXPECTED and correct**, see note | SKIP — superseded by B2 |
| B2 | In that browser's devtools console on **any other site** (e.g. `example.com`), run:<br>`fetch("http://127.0.0.1:8420/api/terminals").then(r=>console.log(r.status))` | `403` | **PASS** — `403 Forbidden`, measured from `http://127.0.0.1:8787` |
| B3 | Same console:<br>`new WebSocket("ws://127.0.0.1:8420/ws/terminal/deadbeef").onerror = () => console.log("refused")` | logs `refused` (before this build it would connect) | **PASS** — handshake failed, `refused` logged |

**B2 was run in its STRONGEST form and that is worth recording.** The attacking page was
another **loopback** origin (`127.0.0.1:8787`) — same machine, same hostname, differing only
in port. The guard still refused. Note the console shows a CORS error *and* a `403`: the
`403` is the one that matters, because CORS alone would have permitted the request and
merely blocked reading the reply — the session spawn would still have happened.

**Incidental positive twin:** the 8421 server served its own UI with every `/api/*` call
returning `200`, so the guard is not refusing indiscriminately.

**B1 is not a failure.** Typing the address yourself is a top-level navigation, which
sends no `Origin` — the guard allows that by design, because a same-origin fetch from
the real UI looks identical. What is blocked is *another page* making the request,
which is B2/B3. If B1 were blocked, the app itself would not work.

## C · Pop-outs (the arm most likely to break)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| C1 | Pop a session out to its own window | Window opens, terminal renders, output flows | ☐ |
| C2 | Type in the popped-out window | Keystrokes land | ☐ |
| C3 | Reclaim the pop-out back into the grid | Session returns, scrollback intact | ☐ |
| C4 | Close a pop-out with the session still running | Main pane keeps working | ☐ |

## D · Disconnect messages (S18)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| D1 | With a session open, kill the sidecar (Task Manager → `claude-cockpit.exe`, the SERVER one) | Pane says **"Reconnecting…"** then **"Backend down — waiting for recovery"** — NOT the origin message | **DEFERRED — the failure it guards is structurally impossible, see note** |
| D2 | Restart Studio | Panes recover or report the terminal is gone; no silent hang | DEFERRED with D1 |

D1 is the honesty check: a genuinely dead backend must still say "backend down". If it said
"origin refused / reload the app", the diagnosis would be inverted — sending the user to fix
the one thing that is not broken.

**Not run, deliberately: the owner had live work and the arm cannot invert.** The refused
message is gated on `verdict !== WS_REFUSED → return` (`TerminalPane.jsx:208`,
`PopoutTerminal.jsx:407`), and `WS_REFUSED` is returned **only** by an affirmative `403` from
`/api/version`. A dead backend makes that probe throw → `WS_BACKEND_DOWN`; anything
ambiguous → `WS_UNKNOWN`. Both fall through untouched to the pre-existing
"Reconnecting… / Backend down" path. The new message therefore requires positive evidence,
and the old behaviour is the default in every other case. **Reading the branch proves more
than running one case would**: the inverted state is unreachable rather than merely unobserved.

What stays unproven is only the POSITIVE direction — that a genuinely refused pane visibly
prints the message in the packaged app. Its 6 unit arms pass; the cost of being wrong is a
missing sentence during an outage the user can already see. Worth folding into the next QA
pass on a scratch instance, not worth killing live sessions for.

## E · Second-instance safety (S17 — the bug that killed sessions)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| E1 | With Studio running **and a live session**, start a second server on another port (PowerShell):<br>`cd C:\Code\Personal\claude-cockpit\web`<br>`$env:PORT="8421"; python server.py` | **Your live session in the desktop app KEEPS RUNNING** | ☐ |
| E2 | Stop the 8421 server | Desktop app unaffected | **PASS** |
| E3 | `ls web/.cockpit-child-pids-*` | Two files, one per port | **PASS, with a correction to the expectation** — see note |

E1 **PASS**: the 8421 server started cleanly (PID 56700) and the live desktop sessions kept
running. This is the regression that used to kill work.

**E3's stated expectation was wrong and the real result is better.** Only
`.cockpit-child-pids-8420` exists — 8421 never wrote one **because it spawned no sessions**,
and a file is created on first child. The load-bearing observation is a different one: the
legacy unsuffixed `.cockpit-child-pids` was left **untouched** by the 8421 run, which is
exactly the designed refusal (a non-default port must never adopt PIDs whose writer may
still be running). Both files hold PID `99999`, which is dead **test-fixture residue** that
leaked into the repo directory — harmless, but its own cleanup item.

Also observed: the desktop app writes no `.cockpit-8420.pid` into `web/`, because the
PyInstaller sidecar resolves its paths relative to its own bundle. So the desktop sessions
were never in that second server's reach at all — E1 passed on its merits, but the blast
radius was smaller than the arm assumed.

**E1 is the regression test for a bug that used to kill your work.** Before this build,
starting that second server would have terminated the live session's `claude.exe`.
Use a scratch session, not one you care about — this is the arm most worth distrusting.

## F · Nothing else regressed (spot checks)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| F1 | Reports page loads, shows usage | Figures render, no error banner | ☐ |
| F2 | Engine page loads | Provider status renders | ☐ |
| F3 | Settings opens, change + save one value | Saves, persists across restart | ☐ |
| F4 | Drag a file onto a terminal | Uploads, path injected | ☐ |
| F5 | Paste an image into a terminal | Uploads, path injected | ☐ |
| F6 | Start a peer bridge between two sessions | Message relays and the peer replies | ☐ |

---

## Known-and-accepted in this build (do NOT file these)

- **`GET /metrics` and `/health` from an external scraper would now 403** if it sends an
  `Origin`. Measured: nothing external scrapes them. Only relevant if you point something
  new at them.
- **A dev Vite server on a port other than 5174** will be refused. Set
  `COCKPIT_DEV_ORIGINS` if you move it. Default 5174 works with no config.
- **`bypassPermissions` still travels in the request body.** Unchanged this build, by your
  ruling. See the note below.

## Still open (not in this build)

1. **`bypassPermissions` de-wiring.** Deferred, and my earlier description of it was wrong:
   `NewSessionDialog.jsx:294` keeps a `manualBypassOverride` latch, so bypass **is** a
   per-session decision today, not only a per-folder one. Any redesign must keep the
   one-off path or it removes a real capability.
2. **`TerminalPane`/`PopoutTerminal` duplication** — 14 repeated blocks, pre-existing.
3. **Row 16 launch token** — not built, and that row's own §5 argues against it.
4. **Row 17** (remove the HTTP listener entirely) — costed, unstarted.

## Verdict — 2026-08-04

**No stop-ship.** Both stop-ship sections cleared: A (the app runs, pill confirms 1.32.0) and
E (a second server on 8421 did NOT kill the live sessions — the regression this build exists
for). B passed in its strongest form. The guard's own defect class — refusing the app itself
— is disproven by the app working, and the opposite class — refusing nobody — is disproven by
the measured `403`.

Not yet exercised: A4, C (pop-outs), D (deferred, see note), F (regression spot checks).
None of them touch the guard's decision path; they are surface this change did not modify.

## Reporting results

Mark each ☐ as PASS / FAIL / SKIP with a note. Hand the file back and `/qa-update` will
process failures into fixes. **A FAIL in section A or E is a stop-ship; everything else
is triage.**
