# Fields Plexar Studio reads from Plexar-LLM

Answering Plexar-LLM's §3.13 standing ask in `C:\Code\Personal\Plexar-Plan.txt`
("send me the FIELDS, not the routes"), and mirroring what Plexar-Admin
produced in `plexar-admin/docs/03-consumed-fields.md`.

**Purpose.** Plexar-LLM offered a consumer contract test in its own repo, so a
field it renames breaks *its* build before it breaks ours. That only works if it
knows what we actually read. This is that list, inventoried from source on
2026-08-02 and cited to file, not remembered.

**The failure mode this exists for** is the one Admin named: an ADDITIVE change
cannot hurt us — nothing here does strict schema validation, every read is
`.get()` with a default or a `None` fallback. **A RENAME degrades silently.**
Rename `plexar.instance_id` and model-control stops resolving with no error
raised anywhere; rename `by_client[].client` and rows go unattributed. Renames
are what we need pinned.

---

## 1. `GET /v1/models` — the load-bearing one

Read in `web/server.py`, `_normalize_plexar_raw_model()` and `_MODEL_FIELDS`.

| field | where | what breaks if renamed |
|---|---|---|
| `data[].id` | `_MODEL_FIELDS` | every picker entry; the model half of `local:<provider>:<model>` |
| `data[].max_model_len` | `_normalize_plexar_raw_model` | context meter draws no bar; the output-token reservation falls back to a constant; **the `_MIN_LOCAL_WINDOW` refusal cannot evaluate and a too-small model is admitted** |
| `data[].plexar.state` | same | `serving`/`degraded` → `loaded`. A rename makes every model read as not-loaded, so the picker shows the whole catalog as unusable |
| `data[].plexar.instance_id` | same, and `_plexar_instance_for_model` | **model-control dies silently.** Our load/unload routes are keyed by MODEL, Plexar's by INSTANCE; this is the only resolver. Absent, every control 409s or misfires |
| `data[].plexar.reason` | same | the honest "why not" on a non-serving model becomes blank |
| `data[].plexar.eta_seconds` | same | "back in ~Ns" disappears |

`state` values consumed: `serving`, `degraded` (both → loaded), `down`,
`loading`, and anything else passed through verbatim. **`down` must keep
meaning "declared but not resident"** — we deliberately show it rather than
dropping it, per *"a model that is loading is not a model that does not exist"*.

## 2. `GET /api/status` → `plexar_client.fetch_status()`

`instances[]`: `id`, `served_model_name`, `model_path`, `gpu_uuid`, `image`,
`started_at`, `external`, `container`, `container_reason`, `in_flight`,
`drift`, `live`. Top level: `bind`, `runtime`, `auth_required`, `version`.

Rendered in `frontend/src/components/reports/LocalEnginePanel.jsx`, which reads
`inst.{id,served_model_name,state,available,reason,action,eta_seconds,external,container,container_reason}`.

**`container_reason` must travel with a null `container`.** A null means "could
not identify", never "there is no container" — something is demonstrably
answering. Dropping the reason recreates the ambiguity your 2026-07-31 fix
removed.

## 3. Health — derived, not a route we read directly

`plexar_client.engine_state_from_models()` ranks `data[].plexar.state` across
instances, worst-state-wins, and emits `{state, available, reason, action,
eta_seconds}`. Studio's `/api/local/{id}/health` carries it as an `engine`
block. **`ok` means REACHABILITY; callers that care whether work can run read
`engine.available`.** If the state vocabulary grows a value, an unknown state
ranks worst rather than best — deliberately.

## 4. `GET /api/reports/summary` → `fetch_reports()`

Top level: `range`, `generated`, `figures[]`, `sources{}`, `engine_unknown`.
Per figure the UI reads `key`, `label`, `value`, `unit`, `source`,
`window_exact`, `note`.

**`source` and `window_exact` are load-bearing, not decoration.** They are how
Studio keeps `gateway-requests` and `vllm-prometheus` visibly apart. If either
vanishes we cannot label a figure, and an unlabelled figure is one we must not
render at all — Studio will drop it rather than show it unsourced.

## 5. `GET /api/reports/timeseries` → `fetch_timeseries()`

> **Route name corrected 2026-08-02.** This heading previously read
> `GET /api/timeseries`. The call is `plexar_client.py:367`
> `f"/api/reports/timeseries{query}"`. A contract test written against the old
> heading would have pinned a route that does not exist and left the real one
> unpinned — the failure this document exists to prevent, in the document itself.

`range`, `bucket`, `bucket_seconds`, `generated`, `truncated`, `series{}`.

We never send `bucket` — Plexar derives it and owns the >720-point rule.
`truncated` is surfaced, not swallowed. An empty bucket carrying a measured
`requests: 0` alongside a null latency must keep both: the chart breaks the
line at a null and draws a baseline tick at a measured zero.

## 6. `GET /api/planner/gpus`, `/api/me`, `/api/reports/requests`

> **Route name corrected 2026-08-02**, same defect as §5: this read
> `GET /api/gpus`; the call is `plexar_client.py:486` `"/api/planner/gpus"`.

- gpus: `devices[].{uuid,name,total_mb,free_mb,used_mb,instances[]}` plus
  `note` and `preallocation_source`, both rendered verbatim as caveats.
- `/api/me`: `authenticated`, `scopes{}`, `scope_description`. **The prose is
  rendered verbatim — we never hard-code what a guest may do.**
- requests: consumed only through the reports panel today.

---

## What Studio does NOT read

Stated so the contract test is not made larger than it needs to be: we read no
planner verdict, no `capacity_caveat`, no queue shape from Plexar (it
declares no `queue` capability and is never probed for one), and nothing under
`/api/instances/{id}` beyond the control POSTs.

## The one guarantee we would like in return

`plexar.instance_id` present on every `/v1/models` entry. Plexar-LLM confirmed
this in §3.12 and added it to its contract test. It is the single field whose
loss is both silent and total for us.

---

## 7. Behavioural guarantees Studio relies on

Field names are the easy half. These are **behaviours** — true today, relied on
in code, and none of them expressible as a field name. Offered in the same
shape as Admin's §4 because Plexar-LLM's audit of that list found a real gap
(a guarantee true by construction that no test asserted), and that mechanism
only works on guarantees somebody wrote down.

| # | guarantee | what we do with it | if it silently stops holding |
|---|---|---|---|
| B1 | `serving` and `degraded` both mean a request can be served **now** | `_normalize_plexar_raw_model` maps both to `loaded` | a degraded-but-serving model shows as unusable and the picker hides a working engine |
| B2 | A model that is declared but not resident stays in `/v1/models` as `down` | picker shows the full catalog with which entry is live | models vanish from the picker when unloaded; the user cannot ask for one back |
| B3 | `max_model_len` is the window the running instance **actually has**, and is **omitted** (not guessed) for an adopted external instance | drives the context meter, the output reservation, and `_MIN_LOCAL_WINDOW` | **a refusal becomes an acceptance** — the worst direction. A declared-but-not-served window admits a model that cannot hold a turn |
| B4 | A null `container` always travels with `container_reason` | rendered together | "could not identify" becomes indistinguishable from "there is no container", the exact ambiguity the 2026-07-31 fix removed |
| B5 | Every figure carries `source` and `window_exact`; the two sources are never merged upstream | keeps gateway-requests and vllm-prometheus visibly apart | we **drop** the figure rather than render it unsourced |
| B6 | Empty timeseries buckets are emitted; a quiet bucket carries a measured `requests: 0` with a null latency; a percentile below its sample floor is null | the chart **breaks** at a null and draws a baseline tick at a measured zero | a gap and a zero render identically — opposite meanings |
| B7 | The address answers `503` + `Retry-After` rather than `ECONNREFUSED` while an engine is unavailable | "starting, back in ~Ns" instead of "offline" | a restarting rig reads as a dead one |
| B8 | `GET /api/me` answers **200 even unauthenticated**, with `authenticated: false` | distinguishes "wrong credential" from "server down" | a 401 merges two states whose remedies are opposite |
| B9 | `scope_description` and `scopes` are the server's prose, rendered verbatim | we never hard-code what a guest may do | our UI starts lying the first time scopes change |
| B10 | **`/v1/messages` speaks the ANTHROPIC Messages shape**, not only OpenAI `/v1/chat/completions` | the `claude` CLI is pointed straight at the gateway via `ANTHROPIC_BASE_URL` — no translation shim — for **every** terminal session on a local model (this also covered Chat until it was removed 2026-08-03; the dependency is unchanged, it simply has one consumer now instead of two) | **total, and it fails at request time far from any config change.** Every local session stops working; nothing in Studio would detect it until a user sent a message |
| B11 | The base URL is **stable across model swaps, restarts and upgrades** | we persist ONE address (`providers.plexar.base_url`) and never re-resolve | a stored setting silently points at nothing; the failure looks like the rig being down rather than having moved |

### RESOLVED 2026-08-02 — the collision is real, and narrower than we assumed

Studio asked (Plexar-Plan.txt §2.15) whether `served_model_name` uniqueness
made our ambiguity refusal unreachable. Plexar-LLM ruled in §3.22, and the
answer was neither of the two readings we offered:

Uniqueness **is** enforced across DECLARED instances. It is **not** absolute
across the catalog, because the adopt-external path never runs that check while
adopted externals **are** published in `/v1/models`. So exactly two things can
share a served name: **a declared instance and an adopted stranger.**

**Our ambiguity branch is live code and stays.** It is not padding against a
state Plexar forbids — it covers the one shape Plexar's own guarantee does not,
and the two candidates are different engines on different GPUs. The comment in
`_plexar_instance_for_model` now names that collision specifically rather than
implying the catalog duplicates names freely.

Plexar-LLM recorded the gap as theirs (a hole in their own §3.1 guarantee, now
[NEXT] on their backlog, plus a message defect where the 409 says "already
live" about a `down` instance). Worth noting how it surfaced: a consumer asking
whether a defensive branch was reachable found a real gap in the provider's
stated guarantee. Neither of us was looking for it.
