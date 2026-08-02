# Continuation prompt — PLEXAR-STUDIO context

Hand this to the Studio worker at the start of a ralph loop. It is written to
be read cold, by someone with no memory of 2026-08-02.

---

## 1. Who you are

You are the **Plexar-Studio** context. Your root is `C:\Code\Personal\claude-cockpit`.

Studio is the **desktop app a developer opens** — multi-session `claude`
terminals, panes, bridges, usage/pricing/spend, and a Chat surface. It is a
single-operator download bound to loopback. It is **not** the platform, not the
rig, and not the hosted chat.

Three sibling contexts exist. You never open their trees:

| context | root | is |
|---|---|---|
| **Plexar-LLM** | `C:\Code\Personal\plexar-vllm` | the rig — GPUs, containers, the fixed-bind gateway, identity, keys |
| **Plexar-Admin** | `C:\Code\Personal\plexar-admin` | the operator console — invites, quotas, tenancy, audit |
| **Plexar-Chat** | none yet | the hosted multi-user face. **LAST.** Do not build toward it. |

## 2. The bus

`C:\Code\Personal\Plexar-Plan.txt` is the **asynchronous bus** between contexts
that never read each other's repos. It is operational, not a planning doc.

**Read `§1` (the rules) and `§5.23-B` (the working mode) before writing a line.**
The rules that get broken first:

- **RULE 1 — write ONLY in `§2`.** Not even a typo fix elsewhere.
- **RULE 2 — disagree in `§6`, never by editing.**
- **RULE 3 — append, don't rewrite.** Supersede with
  `[SUPERSEDED <date>: was "...", changed because ...]`.
- **RULE 5 — claims about another context carry a citation or the word
  `ASSUMPTION` in caps.**
- **RULE 7 — this file plans, it does not authorise.** Len executes.
- **One live session per context.** Two Admin sessions collided three times in
  one afternoon.

**Append via a script, not by hand.** Anchor on the `§3` banner so text lands at
the end of `§2`, assert the anchor is unique, and refuse if your marker already
exists. Working scripts are in this session's scratchpad; the pattern is:
read → assert anchor → splice → write → print a verification line.

## 3. Your backlog — the only list that matters

**`§2.20`** of the plan, in Admin's `§5.23-C` form. Eight items. `§2.6`, `§2.13`
and `§2.18` are **superseded as a backlog** and remain only as reasoning.
`§2.21` promotes one item to `[NOW]`.

Four `[NOW]` items, all currently **blocked on Len**, not on engineering:

1. **Move Studio's state out of `~/.plexar` → `~/.plexar-studio`** (R-E).
   Design agreed, runbook + rollback in `§5.24-B`, file ownership settled in
   `§2.18`. Needs only authorisation and an operator window with both processes
   stopped.
2. **Account for the `~/.claude-cockpit` leftovers** in that migration — the
   data still sits in a third directory.
3. **Ship a build.** Unbuilt since `b63ddd1`; every fix since is invisible.
4. **Studio holds its own named key** — sharing the rig's credential is a live
   violation of `INVARIANT-ATTRIBUTED`.

## 4. Working mode while ralphing

- **When you complete an item, record it in `§2`** — what changed, and what is
  now true for the others. The entry exists so a blocked context learns it is
  unblocked without being told.
- **Say so before starting an item another context waits on.**
- **Stale belief is the characteristic failure, not disagreement.** Studio sat
  blocked on two asks `§3.12` had already answered. **Re-read before declaring
  yourself blocked.**
- The plan is ~340 KB. Grep it; don't read it linearly.

## 5. Gates — the part a loop will get wrong

**A green suite is not a gate.** Two of the four Studio defects found on
2026-08-02 had passing tests over them the whole time:

- `_HARNESS_PREAMBLE_TOKENS` was wrong by 2.6× **in the direction that admits a
  model too small to answer** — it was read off a *failing* request, which
  reports the limit, not your payload. **Measure on success.**
- Six `~/.claude-cockpit` literals kept an abandoned directory alive and
  actively written to, while `app_paths` existed specifically to remove them.
  Found by following path **helpers**, not by grepping filenames — a filename
  grep is false-negative-prone wherever a path is computed.

So: when a `§2.20` gate says **ALREADY WATCHED FAIL**, reproduce that failure
before claiming the item. And prefer verifying against the **live rig** over
trusting a document — every significant finding today came from running the
thing, and three came from a context auditing a claim it did not own.

## 6. House rules that are not negotiable

- **`null` is "not reported", never `0`. Unreachable is never zero. `401` ≠
  `403`.** A limit we do not know draws **no bar** rather than an invented
  denominator.
- **No credential or base URL ever reaches the browser.**
- **Cost is frozen at ingest; prices are append-only.** No `UPDATE`, no `DELETE`
  in `pricing_store.py`.
- **Studio is loopback-only. `[NEVER]` authentication, multi-tenancy or public
  exposure, at any invite count** — its Chat runs the `claude` CLI as the host
  user, and a neutral cwd plus `--add-dir` does **not** confine it (verified
  live). The fix for a shared deployment is Plexar-Chat, not a hardened Studio.
- **`chat_runner` and `GET /api/upload/{name}` must never be lifted into Chat.**
  See `backlog/12`.

## 7. Plans of record in this repo

- `backlog/11` — the product split, the two trust models, engine-agnostic Plexar
- `backlog/12` — the Chat extraction brief, written to be read cold
- `docs/consumed-fields.md` — what Studio reads from Plexar-LLM: field groups
  plus **eleven behavioural guarantees**. Plexar-LLM pins these in *its* repo;
  `B9` already came back unpinned and was fixed (`ebb818e`).
- `CLAUDE.md` — repo conventions

## 8. Gate commands

```
cd web && python -m pytest tests/ -q          # 1291 passing
cd web/frontend && npm test -- --run          # 1170 passing
cd web/frontend && npm run lint
```

## 9. Open items belonging to Len, not to you

Do not start these; do not wait silently on them either — if one blocks you,
say so in `§2`.

1. Authorise R-E and hold the operator window.
2. Whether Studio must be useful on a machine with **no rig installed** — this
   decides whether the managed-vLLM launcher and vendored lane broker die.
3. The ML dependency size for voice (~200 MB of weights against a 48 MB
   sidecar).
4. `backup/pre-hostname-scrub` still holds pre-scrub history; delete it after
   verifying the rewrite, before any `git push --all`.

---

**Last verified state, 2026-08-02:** a local model answers through Studio's Chat
end to end (`local:plexar-vllm:qwen3-30b-instruct` → context 29,273 tokens
against a 57,344 window). Backend 1291 green, frontend 1170 green, lint clean.
`productName` is `Plexar-Studio` — **hyphen, never a space**: GitHub rewrites a
space in an asset filename to a dot and silently 404s every updater URL.
