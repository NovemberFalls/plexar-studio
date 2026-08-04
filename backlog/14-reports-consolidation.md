# 14 — Reports belong in one area: the measured map, and what moves

**Status:** PROPOSAL. Nothing moved, nothing renamed. Measured 2026-08-03.

**Filed 2026-08-03. Row: S23.**

The owner:

> *"Lets keep both traces and logs... the naming seems strange and we should
> reconcile the 2... Reports belong in 1 area."*

Three instructions, and they are separable:
1. **Keep both.** No deletions. Traces and Logs are different things.
2. **Reconcile the naming.** Per R38 a name is a decision — proposed here,
   never picked silently.
3. **Consolidate reporting into ONE area.**

---

## 1 · What exists today, measured

Two tab strips, ten tabs, and the reporting concern is split across both.

**`REPORTS_TABS`** (`components/reports/format.js:35`)

| tab | what it actually renders | state |
|---|---|---|
| Overview | KPIs, tokens/day, spend — Studio's own usage store | real |
| Sessions | per-session rows from `usage_events` | real |
| Models | spend by model | real |
| Tools | `by_tool` from `tool_events` | real |
| **Traces** | **nothing — a "not built" stub** (`notBuilt.js`) whose text points at Engine ▸ Requests | **STUB** |
| Local engine | Plexar's own reporting, side by side, labelled | real |

**`ENGINE_TABS`** (`components/engine/ui.jsx:44`)

| tab | what it actually renders | state |
|---|---|---|
| Live | queue depth, tps, engine state — *now* | real |
| Models | catalog + load/unload | real |
| **Requests** | **the REAL trace renderer** (`TracesPanel`, broker trace tree) | real, **empty** |
| API | route explorer | real |
| **Logs** | **nothing — "there is no log endpoint today"** | **STUB** |

### The split IS the confusion

- **"Traces" appears twice and neither instance is what it says.** Reports ▸
  Traces is a stub that points elsewhere. Engine ▸ **Requests** is the actual
  trace renderer, and its name does not contain the word "trace". A reader
  looking for traces finds a placeholder in the place named after them, and
  the real thing under a different name in a different section.
- **Engine ▸ Requests is empty for reasons a reader cannot see** — measured at
  the wire 2026-08-03: `lmstudio-local/traces` → `{"traces":[],"count":0}`
  (the lane broker runs in shadow, so nothing is ever queued and a trace is
  written per queued job); `plexar-vllm/traces` → 404, it does not publish
  traces at all. So "traces" today is a renderer with no recorder.
- **"Logs" has no renderer AND no endpoint.** `EngineLogs.jsx` correctly says
  so. Its lines exist — the `cockpit.*` loggers write them, and Settings ▸
  Diagnostics already reveals the log folder — they simply have no route.
- **Reports ▸ Local engine vs Engine ▸ Live** is the third pair: one is
  Plexar's history, one is Plexar's now, and only the section names distinguish
  them.

The organising rule the app already claims (`EngineView.jsx`, `ReportsView.jsx`)
is sound and is not being followed:

> **Engine owns NOW. Reports owns THE PAST. Settings owns INTENT.**

A trace is a record of a request that already finished. **It is the past.** It
is in Engine because that is where the broker proxy was, not because it belongs
there.

---

## 2 · Proposed map

Applying the rule literally, with no deletions:

| today | proposed | kind of change |
|---|---|---|
| Engine ▸ Requests (`TracesPanel`) | **Reports ▸ Traces** | **MOVE** — replaces the stub with the real renderer |
| Reports ▸ Traces (stub) | *(gone — superseded, not deleted; the panel it pointed at arrives)* | MOVE consequence |
| Engine ▸ Logs (stub) | **Reports ▸ Logs** | **MOVE** |
| Engine ▸ Live | unchanged | — |
| Engine ▸ Models / API | unchanged | — |
| Reports ▸ Overview / Sessions / Models / Tools | unchanged | — |
| Reports ▸ Local engine | unchanged in place; **name is an open question** | RENAME (needs sign-off) |

Result: **Engine = Live · Models · API** (three tabs, all genuinely *now*).
**Reports = Overview · Sessions · Models · Tools · Traces · Logs · Local
engine** (seven, all genuinely *the past*). One area. Nothing deleted.

### Naming — proposed, NOT picked

The owner said the naming is strange and asked that the two be reconciled. The
distinction that makes them different, in one line each:

- **Traces** — *what was asked of the engine.* One row per request, with its
  fan-out, tokens and wall time. Structured, per-request, from the broker.
- **Logs** — *what the software said while doing it.* Free-text lines from the
  `cockpit.*` loggers and the broker, interleaved, chronological.

They answer different questions ("which request was slow" vs "why did startup
fail"), which is why both are kept. **Both tabs should carry that one-line
definition as subtitle prose**, because the names alone have already failed
once.

Open naming questions for the owner — I have a lean on each and will not act
on any of them:

- **"Requests" or "Traces"?** Lean: **Traces**, matching the endpoint
  (`/traces`), the component (`TracesPanel`) and the broker's own vocabulary.
  "Requests" is the name that hid it.
- **"Local engine"** — lean: **"Engine (Plexar)"**, since it is Plexar's
  reporting and "local" is now ambiguous (Plexar is reachable through a tunnel).
- Whether Reports should say **"Studio"** vs **"Plexar"** as the column
  labels — depends on backlog/13.

---

## 3 · Recommended order

**Step 1 — Engine ▸ Logs is the cheap win, and it is a BACKEND row, not a move.**
The log lines exist; there is no route. Ship `GET /api/logs?tail=` (bounded
tail, level filter, no secrets) and give the existing stub something to render.
Doing this FIRST means the consolidation moves a working tab instead of moving
a placeholder — a placeholder that moves is just the Reports ▸ Traces problem
in a new location.

**Step 2 — pure MOVES, no renames.** Relocate the trace renderer and the logs
tab from `ENGINE_TABS` to `REPORTS_TABS`. Components are unchanged; only the
tab strips and the routing ids move. This is the part that may proceed once
the map above is agreed, per the standing instruction.

**Step 3 — renames.** Only after explicit sign-off. `Requests`→`Traces`,
`Local engine`→whatever is chosen. These are user-visible surfaces and R38
applies.

**Not in scope, and it should be said plainly:** none of this makes Engine ▸
Requests non-empty. Traces are empty because the lane broker ships in shadow
mode and Plexar publishes no traces at all. **Moving the panel to Reports moves
an empty panel.** That is a separate row (it is the same shadow-mode finding as
the spill work) and consolidating must not be allowed to look like it fixed it.

## Gate (for step 2, when authorised)

- `ENGINE_TABS` is `[live, models, api]`; `REPORTS_TABS` gains `logs` and its
  `traces` entry resolves to `TracesPanel`, not `NOT_BUILT_TABS`.
- `NOT_BUILT_TABS.traces` is **removed** and the test that holds its pointer to
  account is removed with it — a pointer to a tab that no longer exists is the
  exact defect `notBuilt.js` was written to prevent, and leaving it is how this
  regresses.
- Deep links: `onNavigate("engine", "requests")` must not dead-end. Watched to
  fail — reintroduce the old id and assert the redirect fires.
- Persisted `engineTab` of `"requests"` or `"logs"` in a returning user's state
  must resolve to a real tab rather than a blank strip.
- Full frontend suite green.
