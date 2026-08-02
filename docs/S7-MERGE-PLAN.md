# S7 — MERGE PLAN WITH ROLLBACK (DEC-24)

> ## ATTEMPTED AND ABANDONED — 2026-08-02 19:18, inside the R-E window
>
> **The archive is the deliverable and the data was NEVER MERGED.**
> `C:\Code\Personal\backup\s7-ARCHIVE-NEVER-MERGED_2026-08-02_191840\` —
> 18,591,744 B, `integrity_check` ok, sha256 matches source, row counts equal
> source, `README.txt` beside it.
>
> **NOTHING ABOUT THE DATA BLOCKED IT.** Every precondition held: both copies
> `integrity_check` ok, totals re-derived cleanly, and **0 cost/price_source
> disagreements across all 1,581 overlapping rows.**
>
> **TWO CONSECUTIVE HARNESS ERRORS BURNED THE ATTEMPT — both mine, neither a
> merge fault, and the gate never ran once.** Written down so a retry does not
> rediscover them:
>
> 1. **`ATTACH` with a `file:…?mode=ro` URI fails on a connection opened without
>    `uri=True`.** The URI is treated as a literal filename. Use
>    `ATTACH DATABASE ? AS old` with a plain path.
> 2. **`PRAGMA <schema>.query_only=1` is NOT per-schema — it applies to the whole
>    connection**, so it made the merge target read-only and refused the first
>    INSERT. Do not use it to protect an attached source; attach the source
>    read-only via a URI on a `uri=True` connection, or simply never write to it.
>
> **WHY I STOPPED RATHER THAN FIX AND RERUN:** at two failed harness runs I was
> debugging inside a window with both processes stopped and Len waiting, which is
> the exact situation DEC-24's one-attempt time-box exists to prevent. *"No data
> was touched, it is only a PRAGMA, one more run"* is precisely the reasoning the
> time-box was written to defeat.
>
> **RETRY NEEDS NO WINDOW.** Both writers merely have to be down. The design,
> declared totals and gate below are unchanged and were never the problem.


**STATUS: PRESENTED, NOT EXECUTED.** §6 requires this be read before it runs.
Authorised by Len: *"you can merge it in, though if it is painful, we ditch it
and start fresh. I am not married to it."* Time-boxed by DEC-24 to **ONE
ATTEMPT INSIDE THE WINDOW.**

Everything below marked MEASURED was read **from copies taken at 18:56 on
2026-08-02**, never from a live file. Nothing here was inferred from source.

---

## 0 · WHY THE MEASUREMENTS ARE TIMESTAMPED, AND WHY THEY GET RE-TAKEN

Carried from S12's root cause, deliberately: `_app_version`'s comment claimed
package.json was the single source of truth *"so the API can never disagree
with the title bar"* — every clause reasonable, conclusion false, **because the
title bar is baked at BUILD time and the API reads at RUN time.**

> **A STATED INVARIANT THAT HOLDS AT ONE MOMENT AND IS READ AT ANOTHER IS NOT
> AN INVARIANT.**

The merge has the identical hazard. **The live database was still being written
to when these numbers were taken** — `usage_events` in the new store already
runs to `22:19:33Z`, later than the copy. So:

- **Every number in §2 is a PLANNING ESTIMATE with a timestamp, not a target.**
- **In the window, all totals are RE-DERIVED from the frozen copies after the
  processes are stopped and the WAL is checkpointed**, and the gate asserts
  against *those*, not against anything in this document.
- The only figures below that carry into the window unchanged are the
  **structural** ones: schemas, key definitions, and column order.

---

## 1 · WHAT IS BEING MERGED (MEASURED 18:56)

| | OLD `~/.claude-cockpit/usage.sqlite3` | LIVE `~/.plexar/usage.sqlite3` |
|---|---|---|
| size | 18,591,744 B | 3,665,920 B |
| `-wal` | **NONE** | **4,157,112 B** |
| `-shm` | **NONE** | 32,768 B |
| integrity | `ok` | `ok` |
| `user_version` | 0 | 0 |
| `usage_events` | 36,056 | 5,499 |
| `tool_events` | 3,699 | 2,739 |
| `local_runs` | 634 | 236 |

**THE OLD DATABASE HAS NO WAL AND NO SHM — it was cleanly checkpointed when its
writer stopped (mtime 2026-08-01 09:57:56). It is self-contained.** The trap
DEC-24 names is real and it is **entirely on the LIVE side**: 3.5 MB of main
file against a 4.16 MB WAL. Copying the live `.sqlite3` alone would merge into
a near-empty database and report success.

---

## 2 · DECLARED EXPECTED TOTALS (R19 — NOT A FLOOR)

Overlap measured by each table's **real** key:

| table | old | new | overlap | **expected merged total** |
|---|---|---|---|---|
| `usage_events` | 36,056 | 5,499 | **1,581** | **39,974** |
| `tool_events` | 3,699 | 2,739 | **820** | **5,618** |
| `local_runs` | 634 | 236 | **0** | **870** |

**Expected merged cost: `$12,868.6477 + $1,361.5358 − $304.6092 = $13,925.5743`.**

The gate asserts **equality against these three numbers and this sum**
(re-derived in-window), plus **containment of BOTH sources** — every old key
present, every new key present. Never "the total went up." A merge is
result-set-shaped, which is absence-shaped, which is exactly where a pairwise
assertion is blind.

**The overlap is explained rather than merely counted**, which is what makes it
credible: the two stores were written **concurrently** for ~2.7 days.
`usage_events` old runs `2026-06-08 .. 2026-08-01T09:38`; new runs
`2026-07-30T18:57 .. now`. An overlap of exactly zero would have been the
suspicious result.

---

## 3 · THREE SCHEMA FACTS THAT CHANGE THE PLAN

**These correct DEC-24's constraint 4 and my own CLAUDE.md. Stated at their real
severity, not inflated (R14).**

**(a) `tool_events` dedupes on `(uuid, block_index)`, NOT on `uuid` alone.**
DEC-24 and CLAUDE.md both say `uuid` alone. **Wrong at the schema level** — the
PK is composite. *Measured impact today: NIL.* `uuid` is distinct 3,699/3,699
in the old store, and both joins return the identical 820. **So this is a wrong
statement that currently costs nothing** — but deduping on `uuid` alone would
silently DROP multiple tool blocks belonging to one message the moment that
changes, and the merge will use the real PK.

**(b) `local_runs` HAS NO UNIQUE KEY AT ALL, AND NOTHING NAMED IT.** `id
INTEGER PRIMARY KEY` is a rowid alias, assigned on insert. **There is no key to
dedupe on.** DEC-24's constraint 4 enumerates two tables; there are three. This
is the absence-shaped hole in the instruction itself — it lists the tables
someone remembered.
Consequence: **`local_runs` is not idempotent. A merge run twice duplicates all
634 rows, and nothing anywhere would report it.** Mitigations, both used:
the run is ONE attempt by DEC-24's own time-box; and the gate asserts the exact
total 870, so a second application is loud rather than silent.
Evidence the 0-overlap is real and not an artefact of a heuristic: the two
stores' `local_runs` windows are **disjoint** — old ends `2026-08-01T01:54`,
new begins `2026-08-01T09:12`.

**(c) COLUMN ORDER DIFFERS BETWEEN THE TWO `usage_events` TABLES.** Same column
SET, different ORDER:

```
OLD: ... cache_read_tokens, workdir,  cost_usd, price_source
NEW: ... cache_read_tokens, cost_usd, price_source, workdir
```

**`INSERT INTO ... SELECT *` would write `workdir` into `cost_usd`.** Text into
a REAL column, which SQLite accepts without complaint. **Every INSERT in this
plan names its columns explicitly. There is no `SELECT *` anywhere in it.**

---

## 4 · COST IS FROZEN, AND THE EVIDENCE IS UNUSUALLY STRONG

Constraint 5 says a merge must not re-price history. **It does not, and the two
stores already agree that it need not:**

> On all **1,581 overlapping rows, `cost_usd` differs in 0 and `price_source`
> differs in 0.**

Two independently-written stores priced the same events identically. The merge
**copies `cost_usd` and `price_source` verbatim** and computes nothing. The
gate asserts the summed cost equals the declared total above — a recompute
would move it.

**One honest consequence to record rather than discover later:** the old store
is 81% `price_source='backfill'` (29,188 rows) against the new store's 99.8%
`'exact'`. **Post-merge, the backfill population becomes the majority.** That is
correct and it is not a defect — but a consumer that reads a rising `backfill`
share as degradation will be wrong. The label is what makes it inspectable;
this is DEC-5's *"honestly unattributed and LABELLED as such"* applied to price.

---

## 5 · EXECUTION — ONE ATTEMPT, INSIDE THE WINDOW

Runs only with both processes stopped (§5.24-B PRE-1) and after preconditions
(a)–(d).

1. **CHECKPOINT** — `PRAGMA wal_checkpoint(TRUNCATE)` on the live store.
2. **COPY BOTH, WITH `-wal` AND `-shm`, BEFORE ANYTHING IS READ.** Dated
   directory. **Both copies' `integrity_check` must return `ok` before the
   merge is allowed to begin** — a torn copy is caught here, not later.
3. **RE-DERIVE ALL TOTALS FROM THE FROZEN COPIES** (§0). The numbers in §2 are
   superseded by these.
4. **MERGE RUNS COPY→COPY. Nothing live is touched.** `ATTACH` the old copy;
   `INSERT OR IGNORE` with **named columns**, never `*`; `id` never carried
   across for `usage_events`/`local_runs` (rowid collision).
5. **VERIFY THE MERGED COPY** against §6's gate.
6. **ONLY IF THE GATE PASSES**, the merged copy replaces the live file.
7. `~/.claude-cockpit/lane-broker/` is inventoried in the same pass (DEC-22).

---

## 6 · THE GATE — AND ITS FAILURE PATH ASSERTS SOMETHING TOO

Carried from my own `UpdatesSettings.jsx:333` finding, which is R11 in exactly
the place this could repeat it: *the mismatch detector is disabled precisely in
the packaged app where the mismatch happens.* **A merge check that only runs
when the merge went well is that guard.**

**PASS requires ALL of:**
- `integrity_check` = `ok` on the merged copy;
- the three row totals **equal** the re-derived declared numbers (not ≥);
- **containment both ways** — every old key present, every new key present;
- summed `cost_usd` equals the re-derived declared total, to the cent;
- **zero rows where `price_source` changed value** for any pre-existing key;
- spot-check: 20 random old keys byte-identical across all columns.

**FAIL PATH — ASSERTED, NOT ASSUMED:**
- the live file is **provably untouched** — SHA-256 taken before step 4 and
  re-checked, and the merge only ever wrote to a copy;
- the archive exists, is `integrity_check` = `ok`, and its row counts equal the
  pre-merge source counts. **The abandonment path is verified, not trusted.**

---

## 7 · ROLLBACK, AND THE ABANDONMENT PATH

**Rollback is free by construction: the merge never writes to a live file until
step 6.** Any failure before that leaves the live store bit-identical.

After step 6, rollback is restoring the dated copy of the live triplet — main,
`-wal`, `-shm` together.

**IF THE GATE FAILS ON THE ONE ATTEMPT: ABANDON IMMEDIATELY.** No second try,
no debugging inside the window, and **the window is never extended for this
row.** Then:

- **ARCHIVE, NOT DELETE** — `~/.claude-cockpit/usage.sqlite3` (and any `-wal` /
  `-shm`, though it currently has neither) copied to a dated archive directory,
  intact, and its `integrity_check` confirmed there;
- **the archive is the deliverable.** S7 records **what** was archived, **where**,
  **its size**, and **that it was never merged**. An archive nobody can find or
  describe is a deletion with extra steps;
- consistent with DEC-3's ratified posture: *revocation removes access, not
  evidence.*

---

## 8 · WHAT THIS PLAN DOES NOT COVER

- `chat.sqlite3` (4,096 B against a 115,392 B WAL in the old home),
  `pricing.sqlite3`, the vLLM jsonl pair, and `logs/cockpit.log` are **S7 clause
  (iv) inventory items and are NOT merged by this plan.** They are archived with
  the same discipline or carried as separate decisions. **This plan is
  `usage.sqlite3` only** — naming that boundary so a green gate here is not read
  as custody of everything in clause (iv).
