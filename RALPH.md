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

1. `C:\Code\Personal\Plexar-Ralph.md` — the execution board. Your lane is
   **PLEXAR-STUDIO** (rows S0-S5). This is STATE, not history.
2. `C:\Code\Personal\Plexar-Plan.txt` §2 (your section), §5.27 (Len's four
   decisions), §5.24-B (the R-E execution spec — this is your runbook).
3. This repo: `backlog/11` (the split), `backlog/12` (chat extraction),
   `CLAUDE.md`.

## Hard rules

- **Every unit of work runs through `/orch-code-anth`.** Not optional. Invoke it,
  print its SOLO/SWARM verdict and APPLY-TIER line, obey them.
- **Edit only your own lane** on the board (S-rows). Never another lane's rows.
  Never delete a row — mark `❌ dropped` with a one-line reason.
- **A gate you have not run is a status you have not earned.** `✅` only after
  you watched the gate pass. Set `⏳` when you start, with the date.
- Your section of `Plexar-Plan.txt` is §2. Do not write in §3, §4, §5, or §7.
  Genuine disagreement goes in §6, one entry, append-only.
- Stay in your own tree. You may READ the board and the plan at
  `C:\Code\Personal\`.
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

- **GATE 5(c) will FAIL as written.** `~/.plexar/lane-broker/` exists on disk
  (mtime 14:06, 2026-08-02), written by `team/tools/lane-broker/broker.py
  --shadow` — a process rooted in NEITHER your tree nor Plexar-LLM's. The
  "unowned three" is really the unowned five: `lane-policy.json`,
  `plexar-app.key`, `plexar-app.value`, `lane-broker/`, and `logs/`.
- **CLAIM OR DISCLAIM `logs/`** (contains `cockpit.log`). It is in neither
  inventory. The name says cockpit and you are Cockpit, so it is probably yours
  — but §3.14's assertion is exact and will trip on it. Cheap now, a failed
  gate later. Answer it in §2.
- **The WAL is hot**: `plexar.sqlite3-wal` 4.1 MB, `usage.sqlite3-wal` 4.2 MB,
  written seconds before the listing. PRE-2's `PRAGMA wal_checkpoint(TRUNCATE)`
  is load-bearing, not ceremony. Moving a `.sqlite3` without its `-wal`
  silently discards committed transactions and SQLite opens the result without
  complaining.

Report back: rows updated, gates run, gates that failed, `logs/` claimed or
disclaimed, and anything you found that no row covers.
