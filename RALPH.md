# RALPH — PLEXAR-STUDIO lane

You are the **PLEXAR-STUDIO** context. Root: `C:\Code\Personal\claude-cockpit`.
You are an Opus-low orchestrator. A human coordinator (Opus) runs the board.

## ⚠ READ THIS BEFORE ANYTHING ELSE

`claude-cockpit.exe` **is** Plexar Studio — the app. If this session was launched
from inside Cockpit, stopping Studio kills you mid-migration. **Verify you are
running in a plain terminal (Git Bash / Windows Terminal), not inside Cockpit,
before you touch any process.** If you cannot verify it, stop and say so.

Studio also **auto-restarts**: observed 2026-08-02, its PIDs turned over on their
own between two scans seconds apart. A checkpoint you take can be undone by a
respawn. Whatever stops Studio must also keep it stopped for the window.

## Read first, in this order

1. `C:\Code\Personal\plexar-coord\Plexar-Ralph.md` — the execution board. Your
   lane is **PLEXAR-STUDIO** (rows **S0-S13**). This is STATE, not history.
2. `C:\Code\Personal\plexar-coord\Plexar-Watch.md` — the decision record. Read
   every DEC, every R-rule and every NOTE. These are binding rulings.
3. `C:\Code\Personal\plexar-coord\Plexar-Plan.txt` §2 (your section), §5.27
   (Len's four decisions), §5.24-B (the R-E execution spec — this is your
   runbook). ~7,900 lines; do NOT read it whole.
4. This repo: `backlog/11` (the split), `backlog/12` (chat extraction),
   `CLAUDE.md`.

**PATHS CORRECTED 2026-08-02.** The three shared files MOVED from
`C:\Code\Personal\` into `C:\Code\Personal\plexar-coord\`. `MOVED-*` stubs may
still sit at the old paths — they are pointers, not files, so **a write to an
old path is lost.** This brief cited the pre-move paths until now.

## Hard rules

- **Every unit of work runs through `/orch-code-anth`.** Not optional. Invoke it,
  print its SOLO/SWARM verdict and APPLY-TIER line, obey them.
- **Edit only your own lane** on the board (S-rows). Never another lane's rows.
  Never delete a row — mark `❌ dropped` with a one-line reason.
- **A gate you have not run is a status you have not earned.** `✅` only after
  you watched the gate pass. Set `⏳` when you start, with the date.
- Your section of `Plexar-Plan.txt` is §2. Do not write in §3, §4, §5, or §7.
  Genuine disagreement goes in §6, one entry, append-only.
- Stay in your own tree. You may READ the board, the watch file and the plan at
  `C:\Code\Personal\plexar-coord\`. You never COMMIT the three shared files —
  they live outside every repo and a lane branch never contains them.
- R-E is a **destructive-class change** — it touches a credential path on a rig
  published through a live Cloudflare tunnel. It runs as a PLAN WITH ROLLBACK,
  under the coordinator, with Len reachable. Not unilaterally.

## Standing invariants in force (full text in the Plan)

- INVARIANT-ATTRIBUTED — no shared keys; every metric per identity.
- The provider pins what consumers publish. **You read SEVEN of Plexar-LLM's
  routes and have pinned none** (§3.13, still outstanding). Three of the last
  four audits found the "pinned" thing unpinned at the wire.
- No shared mutable resource without a named owner. This is the family's
  characteristic defect and `~/.plexar` is its original instance.
- Measure on success, not on failure.
- A gate must be WATCHED TO FAIL once before it counts.

## Your tasks this session, in order

### S0 — convert your backlog to C-form (do this FIRST)
Your content exists (§2.6, §2.13, §2.18) but it is not in C-form: the gates are
missing. Every S-row must end up with a gate that Plexar-LLM or Admin could run
without asking you what you meant. This is the first item of your reaudit and it
gates everything below.

### The reaudit — verify against source as it is right now
Not against what the backlog says is true. That phrasing is deliberate.

### S2 / S3 — RE-SCOPED, the deletion premise was wrong
Per §5.27 LEN-3, Len ruled: *"Studio (claude cockpit -> Plexar) currently works
without a rig, the rig will add a provider. So Yes, studio works without
Plexar-LLM."* So S2 (managed-vLLM launcher) and S3 (vendored lane broker) do
**NOT** unblock as deletes. Studio stays multi-provider and rig-optional.
The open question you must answer in §2, with a gate, before touching either:
should Studio still MANAGE vLLM containers itself, given §3 has Plexar-LLM
owning containers and the fixed address `127.0.0.1:8760`? Rig-optionality and
container-ownership are two different questions; Len decided only the first.

### R-E (S1) — blocked on the coordinator, not on you
LEN-1 is authorized (§5.27) but preconditions are NOT met. Do not start it
unprompted. Two amendments to §5.24-B found 2026-08-02, before you run GATE 5:

- **GATE 5(c): THE "FIFTH UNOWNED PARTY" CLAIM IS WITHDRAWN. It was WRONG, and
  it was the COORDINATOR'S, not yours.** An earlier version of this brief said
  `~/.plexar/lane-broker/` was written by a process rooted in neither your tree
  nor Plexar-LLM's, making the unowned set five. §2.23-A refuted it by citing
  `server.py` as creating the directory "unconditionally on every start".
  **⚠ THAT REFUTATION IS ITSELF WRONG, AND I WROTE IT. CORRECTED 2026-08-02 BY
  THE R26 RE-AUDIT.** The call is at line **4666**, behind TWO early returns in
  `start_managed_broker`: a running-task check (`:4654`) and **the double-bind
  guard (`:4656-4659`), which returns FALSE and never reaches the line whenever
  something already answers at the broker URL.** Studio creates that directory
  **only when Studio WINS the double-bind.** The coordinator's claim was not
  simply wrong — it described the OTHER BRANCH of a conditional I collapsed.
  R14 in the unusual direction: I understated their finding and overstated my
  correction.
- **`logs/` is CLAIMED by Studio unconditionally. `lane-broker/` IS NOT.**
  MEASURED 2026-08-02: `:1235` is held by `cockpit-server.exe` (PID 19228, new
  install) and no standalone `broker.py --shadow` exists, **so today the
  directory is Studio's and it moves.** That is a fact about right now, not a
  property of the code. **5(c) MUST DETERMINE WHO HOLDS `:1235` IN THE WINDOW
  rather than assume it** — if an external broker holds the port, that
  directory is another party's state and moving it moves something not ours.
- Also measured, covered by no row: **`~/.claude-cockpit/lane-broker/` exists
  too.** Both homes carry it; the abandoned one falls under S7 clause (iv).
- **The unowned set is back to TWO: `plexar-app.key` and `plexar-app.value`** —
  which is the same full-owner credential as S4. Moving those files without
  RE-MINTING the identity moves the problem, it does not solve it.
- **The WAL is hot**: `plexar.sqlite3-wal` 4.1 MB, `usage.sqlite3-wal` 4.2 MB,
  written seconds before the listing. PRE-2's `PRAGMA wal_checkpoint(TRUNCATE)`
  is load-bearing, not ceremony. Moving a `.sqlite3` without its `-wal`
  silently discards committed transactions and SQLite opens the result without
  complaining.

Report back: rows updated, gates run, gates that failed, `logs/` claimed or
disclaimed, and anything you found that no row covers.
