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
| A1 | Install and launch the desktop app | Window opens, UI renders, **version pill reads 1.32.0** | ☐ |
| A2 | Create a new session | Terminal spawns, `claude` banner appears | ☐ |
| A3 | Type in it | Keystrokes appear, replies stream back | ☐ |
| A4 | Open a second session, switch between panes | Both live, output not crossed | ☐ |

**If A1 renders a blank window, or A2 spawns nothing: STOP.** That is the guard
refusing the webview's own origin. Say so and I will fix it — do not work around it.

## B · The guard is actually on (the point of the release)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| B1 | With Studio running, open a browser to `http://127.0.0.1:8420/api/terminals` | JSON loads — **this is EXPECTED and correct**, see note | ☐ |
| B2 | In that browser's devtools console on **any other site** (e.g. `example.com`), run:<br>`fetch("http://127.0.0.1:8420/api/terminals").then(r=>console.log(r.status))` | `403` | ☐ |
| B3 | Same console:<br>`new WebSocket("ws://127.0.0.1:8420/ws/terminal/deadbeef").onerror = () => console.log("refused")` | logs `refused` (before this build it would connect) | ☐ |

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
| D1 | With a session open, kill the sidecar (Task Manager → `claude-cockpit.exe`, the SERVER one) | Pane says **"Reconnecting…"** then **"Backend down — waiting for recovery"** — NOT the origin message | ☐ |
| D2 | Restart Studio | Panes recover or report the terminal is gone; no silent hang | ☐ |

D1 is the honesty check: a genuinely dead backend must still say "backend down". If it
says "origin refused / reload the app", the diagnosis is inverted.

## E · Second-instance safety (S17 — the bug that killed sessions)

| # | Step | PASS looks like | Status |
|---|---|---|---|
| E1 | With Studio running **and a live session**, start a second server on another port:<br>`cd web && PORT=8421 python server.py` | **Your live session in the desktop app KEEPS RUNNING** | ☐ |
| E2 | Stop the 8421 server | Desktop app unaffected | ☐ |
| E3 | `ls web/.cockpit-child-pids-*` | Two files, one per port | ☐ |

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

## Reporting results

Mark each ☐ as PASS / FAIL / SKIP with a note. Hand the file back and `/qa-update` will
process failures into fixes. **A FAIL in section A or E is a stop-ship; everything else
is triage.**
