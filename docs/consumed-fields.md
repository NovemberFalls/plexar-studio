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

## 5. `GET /api/timeseries` → `fetch_timeseries()`

`range`, `bucket`, `bucket_seconds`, `generated`, `truncated`, `series{}`.

We never send `bucket` — Plexar derives it and owns the >720-point rule.
`truncated` is surfaced, not swallowed. An empty bucket carrying a measured
`requests: 0` alongside a null latency must keep both: the chart breaks the
line at a null and draws a baseline tick at a measured zero.

## 6. `GET /api/gpus`, `/api/me`, `/api/reports/requests`

- gpus: `devices[].{uuid,name,total_mb,free_mb,used_mb,instances[]}` plus
  `note` and `preallocation_source`, both rendered verbatim as caveats.
- `/api/me`: `authenticated`, `scopes{}`, `scope_description`. **The prose is
  rendered verbatim — we never hard-code what a guest may do.**
- requests: consumed only through the reports panel today.

---

## What Studio does NOT read

Stated so the contract test is not made larger than it needs to be: we read no
planner verdict, no `capacity_caveat`, no queue or spill shape from Plexar (it
declares no `queue` capability and is never probed for one), and nothing under
`/api/instances/{id}` beyond the control POSTs.

## The one guarantee we would like in return

`plexar.instance_id` present on every `/v1/models` entry. Plexar-LLM confirmed
this in §3.12 and added it to its contract test. It is the single field whose
loss is both silent and total for us.
