# lane-broker

Queue-owning API gateway in front of the local LM Studio inference server.
LM Studio (`127.0.0.1:1234`) serves **one request at a time** (measured law:
`max_concurrent=1` — parallel decode loses on one GPU; the broker enforces
this, never work around it). Its internal queue is invisible; the broker makes
it explicit: priority, position and ETA.

Single file, Python 3.12, **stdlib only** — nothing to install.

## What it does

- Listens on `127.0.0.1:1235`; accepts OpenAI (`/v1/chat/completions`,
  `/v1/completions`, `/v1/models`) and Anthropic (`/v1/messages`) shapes.
- Holds an explicit priority queue and forwards **exactly one** request at a
  time upstream. Everything else (e.g. `GET /v1/models`) passes through
  immediately.
- Relays responses **byte-verbatim** — no body translation or re-encoding,
  ever (a prior middlebox, LiteLLM, silently dropped tool-call arguments in
  translation; that failure mode is disqualifying here). Chunked SSE streams
  pass through untouched.
- Priority via `X-Lane-Class: interactive|worker|batch` (default `worker`).
  `interactive > worker > batch`, FIFO within class. Reordering happens in
  the **queue only** — an in-flight request is never cancelled.
- Logs every attempt (completed **and** errored/transport-failed) to
  `jobs.jsonl` (ts, class, prompt_chars, wall_ms, model, client_id,
  `X-Trace-Id`/`X-Trace-Parent` if present, plus v2 `status`, `error_kind`,
  `http_status`, `ttft_ms`, `queue_wait_ms`) and keeps a rolling median wall per
  prompt-size bucket (`<4K`, `4-16K`, `16-48K`, `>48K` chars) for ETA.
- **No local refusal.** Spill — a per-class predicted-wait threshold above which
  the broker answered `503 {"spill":true}` — was REMOVED 2026-08-03 on the
  owner's ruling. A request that would have been refused now queues and waits;
  **there is no depth limit and no wait ceiling**, and the client's timeout is
  the only backpressure. Removed with it: `/config/spill`, `/spills`,
  `spills.jsonl`, `--spill-interactive`, `--spill-worker`.
  The client decides what to do; the broker never calls Anthropic itself and
  never sees API keys.

## Start it

Foreground (Git Bash or PowerShell):

```sh
python tools/lane-broker/broker.py                 # queue mode
python tools/lane-broker/broker.py --shadow        # observe+log only — safe first deploy
```

Flags: `--port 1235` · `--upstream http://127.0.0.1:1234` · `--shadow` ·
`--log-file <path>`.

Persistent on Windows (no install, survives closing the terminal):

```powershell
Start-Process -WindowStyle Hidden python -ArgumentList "C:\Code\Personal\team\tools\lane-broker\broker.py"
```

or as a scheduled task that starts at logon:

```powershell
schtasks /Create /TN lane-broker /SC ONLOGON /TR "pythonw C:\Code\Personal\team\tools\lane-broker\broker.py"
```

Stop it: `taskkill /F /IM pythonw.exe` (or find the PID via
`netstat -ano | findstr :1235`).

## Point clients at it

- Claude Code / Anthropic SDK: `ANTHROPIC_BASE_URL=http://127.0.0.1:1235`
- OpenAI SDK: `base_url="http://127.0.0.1:1235/v1"`
- Tag each client's lane: header `X-Lane-Class: interactive` (sessions),
  `worker` (agent workers), `batch` (the podcast pipeline). Untagged = worker.
- Optional: `X-Client-Id`, `X-Trace-Id`, `X-Trace-Parent` for the job log.

## Watch the queue

- `GET http://127.0.0.1:1235/queue` — JSON: in-flight job (class, elapsed,
  predicted remaining), queued jobs in dispatch order (class, position,
  predicted wall), `estimated_clear_seconds`, and (v2, additive)
  `predicted_wait_s_by_class {interactive, worker, batch}` — the per-class
  predicted wait a new job would see right now. It is a REPORTED number and
  nothing compares it to anything: the per-class threshold that used to do so
  went with spill (2026-08-03). `estimated_clear_seconds` and every existing
  field are unchanged.
- `GET http://127.0.0.1:1235/queue?html=1` — minimal auto-refreshing page.

## Metrics (`/metrics` — Cockpit contract)

`GET http://127.0.0.1:1235/metrics?window=<lifetime|24h|7d|session>` (default
`lifetime`; `?html=1` for a minimal auto-refresh page — same localhost/no-auth
convention as `/queue`). Read-only JSON aggregates:

- `runs_total`, `prompts_total`, `tokens_total {prompt, completion}`,
  `tokens_per_sec {current, avg}`, `run_time_ms {min, max, avg, p50, p95}`
- breakdowns `by_session[]` / `by_agent[]` / `by_lane_class[]` / `by_model[]`,
  each carrying the same counters
- `window_start` + `persisted` — `lifetime`, `24h` and `7d` are recomputed from
  `jobs.jsonl` and survive broker restarts (`persisted: true`); `session`
  means "since this broker process started" (`persisted: false`).

**v2 additive fields** (all additive — no existing field is renamed or
repurposed; `tokens_per_sec` keeps its wall-clock definition below):

- `attempts_total` — every logged attempt (completed + errored + cancelled).
  `runs_total` stays the count of **completed** runs; failure rate is
  `errors_total / attempts_total`.
- `ttft_ms {p50, p95}` — time-to-first-token, wall ms from upstream dispatch to
  the first SSE content frame (OpenAI `choices[].delta.content`, Anthropic
  `content_block_delta`), measured off the byte copy the broker already tees for
  usage. Non-streaming runs record `ttft_ms: null` and are excluded from the
  percentiles.
- `decode_tokens_per_sec {current, avg, p50}` — true decode rate,
  `completion_tokens / ((wall_ms − ttft_ms) / 1000)`. This is **separate from**
  `tokens_per_sec` (which stays the wall-clock floor defined below); only runs
  with a known TTFT contribute.
- `queue_wait_ms {p50, p95}` — per-run enqueue→dispatch wait. Separates "local is
  slow" from "local is queued". Shadow-mode observations record `0` (no queue).
- `errors_total`, `errors_by_kind {}` — counts by `error_kind`
  (`context_overflow | timeout | upstream_5xx | transport | other`).

Every breakdown row (`by_session` / `by_agent` / `by_lane_class` / `by_model`)
also carries `ttft_ms`, `decode_tokens_per_sec`, `queue_wait_ms` and
`errors_total` alongside its existing counters.

**Per-record `jobs.jsonl` fields (v2):** each record now also carries
`status` (`ok | error | cancelled`), `error_kind` (or `null`), `http_status`
(upstream code; `0` = transport failure), `ttft_ms` (or `null` for
non-streaming) and `queue_wait_ms`. Legacy records with no `status` are treated
as completed (`ok`).

**Definitional contract** (agreed wording — derived ratios depend on it):

- **run** = one completion call forwarded to a lane = one `jobs.jsonl` record
- **prompt** = one client dispatch, identified by distinct `X-Trace-Id`; runs
  without a trace id count as one prompt each (so untagged clients see
  runs == prompts)
- **session** = `X-Client-Id` · **agent** = `X-Agent-Id` (both optional headers)

**Tokens/sec caveat:** the broker cannot measure decode speed directly — it
passively reads token usage out of a *copy* of the relayed bytes (OpenAI
`usage`, Anthropic `message_start`/`message_delta` usage, plain JSON or SSE;
the relay itself stays byte-verbatim). `current`/`avg` are
completion-tokens ÷ wall-clock, which includes prompt-processing time — a
floor on true decode speed, not LM Studio's own stats number. Streaming
OpenAI clients that want counted tokens should send
`stream_options: {"include_usage": true}`; runs with no visible usage carry
null token fields and are excluded from the tps average.

## Time series (`/metrics/timeseries` — v2, read-only)

`GET /metrics/timeseries?window=<session|24h|7d|lifetime>&bucket=<5m|1h|1d|Ns>`.
Recomputed from `jobs.jsonl`, so it survives restart and
reports `persisted: true`. Default bucket follows the window (`5m` for session,
`1h` for 24h, `1d` for 7d/lifetime). Response:

```json
{
  "window": "24h", "bucket_s": 3600, "persisted": true, "provider_id": "local",
  "buckets": [
    { "ts": "2026-07-24T13:00:00Z",
      "by_provider": {
        "local": { "runs": int, "tokens": int, "decode_tps_p50": num|null,
                   "ttft_ms_p50": int|null, "queue_wait_ms_p50": int|null,
                   "errors": int } } }
  ]
}
```

The broker fronts a single upstream, so `by_provider` carries one entry keyed on
`COCKPIT_PROVIDER_ID` (env, default `local`) — the shape is N-ready for a later
multi-backend phase. `runs` counts completed runs
in the bucket. Bucket count is capped at 1000.

## Traces (`/traces` and `/trace/{id}` — read-only observability)

Records are sourced from the same in-memory list + `jobs.jsonl` history as `/metrics`.
Runs without a `trace_id` are excluded. Traces group runs by `trace_id`; a ROOT
is a trace_id whose runs' `trace_parent` is empty or references an absent trace_id.

**`GET /traces?limit=N`** (default 20, max 100): Response (newest-first by last run ts):

```json
{
  "traces": [
    {
      "trace_id": "str",
      "agent": "<agent of first run or empty>",
      "runs_total": int,
      "descendant_runs": int,
      "first_ts": "iso",
      "last_ts": "iso",
      "wall_ms_total": int,
      "lane_classes": { "class": count, ... }
    }
  ],
  "count": int
}
```

Descendant runs = all runs of trace_ids reachable downward via `trace_parent` edges
from this root, excluding the root's own runs.

**`GET /trace/{id}`** (404 `{"error":"unknown trace"}` if no run has that trace_id):

Collects the CLOSURE: the root chain's trace_id plus every trace_id reachable
downward via `trace_parent` edges. Response:

```json
{
  "trace_id": "id",
  "nodes": [
    {
      "trace_id": "str",
      "trace_parent": "str|null",
      "agent": "str",
      "client_id": "str",
      "model": "str",
      "lane_class": "str",
      "ts": "iso",
      "wall_ms": int,
      "prompt_chars": int,
      "tokens": { "prompt": int, "completion": int }
    }
  ],
  "edges": [
    ["parent_trace_id", "child_trace_id"],
    ...
  ]
}
```

Nodes are ordered `ts` ascending. Edges enumerate the parent→child relationships
discovered in the trace closure.

Both endpoints: localhost/no-auth only; JSON response (no `?html=1` variant).

## Rollout / local-lanes.json

Deploy in this order:

1. Run `--shadow` for a day; confirm `jobs.jsonl` fills and nothing breaks
   (shadow does not serialize — it only observes and logs).
2. Switch to queue mode; soak with the batch producer running.
3. Once soak-tested, update `bench/local_lane/local-lanes.json` lane
   `endpoint` fields from `http://127.0.0.1:1234` to `http://127.0.0.1:1235`
   (both `gpu-main` and `ram-35b` — same upstream box). **Proposed here, not
   applied** — that file is measurement-certified and stays untouched until
   the owner flips it. `local_worker.sh` then inherits the broker via
   `ENDPOINT` with no other change; workers should export
   `X-Lane-Class: worker` (the launcher can add `--header` or clients set it).

The broker never encourages parallel upstream calls: the 27B runs at
49152 ctx / `--parallel 1` and that load shape is certified.

## Tests

```sh
python -m pytest tools/lane-broker/tests -q
```

Covers: single-flight ordering, priority preemption in queue, ETA math from
seeded history, byte-verbatim chunked-SSE pass-through with
`tool_use` JSON, `/queue` with 3 queued jobs, shadow-mode concurrency +
logging, and a live smoke against real LM Studio (skips cleanly if `:1234`
is down). `tests/test_metrics_v2.py` covers the v2 additive metrics offline
(TTFT null-exclusion, decode math, queue wait, error counting + runs/attempts
split, `by_model`, `/metrics/timeseries` bucketing,
`predicted_wait_s_by_class`).
