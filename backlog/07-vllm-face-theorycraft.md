# 07 — The vLLM Face: theorycraft

**Status:** THEORYCRAFT. No code. Cockpit is ON HOLD at 1.12.0 while this is designed.
**Home:** this doc lives in Cockpit's backlog because that is where the conversation
happened. It should MOVE to the new tool's repo (or `team/local-rig/`) once that exists —
it is not Cockpit work.

**Origin:** owner call, 2026-07-30. Cockpit stops managing engines. Model lifecycle,
VRAM, and GPU-side reporting become a separate tool whose entire job is being the face
of vLLM. Cockpit becomes a consumer that points at a URL, OpenRouter-style.

---

## 1. The one-sentence job

**Own the vLLM process, and publish an address that never changes.**

Everything else — the VRAM planner, the reporting, the load UX — follows from taking
those two responsibilities seriously. If the tool does only those two things well it has
already justified existing.

## 2. Non-negotiables (owner-stated)

1. A true face for vLLM — this is the tool's whole purpose, not a side panel.
2. Reporting is **persistent** and survives container restarts.
3. Failure has an explicit, visible mode. Never a zero that reads like data.
4. The connection URL handed to consumers must be **smooth** — internal, external,
   whatever is needed, without the user hunting for it.

## 3. The stable-address trick (the core idea)

The naive design: the tool starts a container on some port, the user reads the URL off a
screen and pastes it into Cockpit. This works exactly until the model changes — which is
precisely how `gpu-main` served `qwen3-30b-instruct` for 21 hours against three sources
declaring `qwen3-coder-30b-awq`.

Instead: **the tool fronts vLLM with its own gateway on a fixed bind.**

```
consumer  ──►  face gateway (fixed :PORT)  ──►  vLLM container (ephemeral port)
                     │                                  ▲
                     └── control plane ─────────────────┘
                         (start / stop / swap model)
```

Consequences, all of them good:

- Cockpit configures `http://127.0.0.1:PORT/v1` **once, forever.** Model swaps, restarts,
  crashes, and version upgrades are invisible to it.
- `/v1/models` through the gateway is always the truth about what is live. There is no
  declared-vs-served gap because the declaration and the serving are the same component.
  **The drift incident becomes structurally impossible**, not merely detected.
- During a model swap the gateway answers `503` + `Retry-After` + a body naming what is
  loading and the ETA, instead of `ECONNREFUSED`. A consumer sees "loading", not "dead".
  This alone is most of the UX win.
- Metering has exactly one choke point.

### INVARIANT: the gateway must not queue

vLLM's throughput comes from continuous batching. Putting a `max_concurrent=1` front on
it serialises exactly the thing that makes it fast — this mistake has already been made
once in this stack, which is why Cockpit's `vllm-local` provider is served *direct* and
not behind the lane broker.

The gateway is a **transparent streaming pass-through**: no queue, no buffering, no
concurrency cap, SSE forwarded chunk-for-chunk. It exists for *stable addressing and
metering only*. Any feature that wants to hold a request must be opt-in and off by
default.

### Internal vs external, and what "smooth" means

Reachability is a matrix, not a single string. The tool should surface, per class, a
one-click-copy URL plus an honest verdict:

| class | bind | notes on this machine |
|---|---|---|
| loopback | `127.0.0.1:PORT` | the default; same-machine consumers |
| WSL boundary | — | container lives in WSL; Windows→WSL localhost forwarding usually works but is the known sharp edge |
| LAN | `0.0.0.0:PORT` | rig used from another machine; needs an auth decision |
| tunnel | tailscale / cloudflared | out of scope v1, but do not design it out |

**"Smooth" has a specific technical meaning: the test must run from the consumer's
side, not the server's.** Cockpit's current `Test` button probes from the Cockpit server
process, which proves nothing about whether *your laptop* can reach the rig. The face
should offer a copyable one-liner (`curl <url>/v1/models`) for the remote case and be
explicit that a green light on the server does not certify a remote consumer.

Binding beyond loopback flips on an auth requirement. A bare vLLM on `0.0.0.0` is an
unauthenticated inference endpoint and, more importantly, an unauthenticated *arbitrary
prompt* endpoint on your GPU. v1 default: loopback only, with LAN behind an explicit
toggle that forces an API key.

## 4. Model lifecycle — the hard constraint, and making it bearable

**One vLLM process serves one model, chosen at launch. There is no hot-swap API.** A
"switch models" is: drain, stop container, start new container, wait. First boot is
~7 min (torch.compile + CUDA graph capture); cached after, but still tens of seconds.

This is the tool's central UX problem. What makes it bearable:

- **Show the cost before committing.** "Cold start, ~7 min" vs "cached, ~40 s", derived
  from whether the compile cache for that model+config exists.
- **Drain, don't kill.** In-flight requests finish (bounded), new ones get the 503+ETA.
- **The gateway holds the address**, so consumers never see a connection error — they see
  a loading state. This is the difference between "the rig is switching models" and "my
  tooling is broken".
- **Swap as an explicit, logged, undoable act** with the previous config one click away.

### Multi-model, and the "can it cluster?" question

vLLM does tensor/pipeline parallelism to serve **one** model across GPUs. It does not
serve several models from one process. So multi-model = multiple containers on multiple
ports.

**But the gateway solves this without vLLM's help:** run N containers, route by the
`model` field in the request body. From the consumer's perspective a single endpoint
lists N models in `/v1/models` and serves all of them — which is exactly the OpenRouter
shape. Whether N > 1 is *possible* is then purely a VRAM question, which the planner
below answers.

Note this is the payoff of the endpoint design: Cockpit needs **zero** changes when this
lands. It already just points at a URL and reads `/v1/models`.

## 5. The VRAM planner — highest value per line of code

The single most useful thing this tool can do, and it is mostly arithmetic:

> Pick a model and a context length. Before waiting 7 minutes, be told whether it fits.

Inputs: model weights size on disk (quant-aware), `max_model_len`, `max_num_seqs`,
dtype, KV geometry from the model config (layers, kv_heads, head_dim — GQA and MoE both
change this materially), and free VRAM right now.

```
KV bytes/token ≈ 2 (K+V) × layers × kv_heads × head_dim × dtype_bytes
KV budget      ≈ KV bytes/token × max_model_len × max_num_seqs
total          ≈ weights + KV budget + activation/graph overhead
```

Against that: `gpu_memory_utilization` is a fraction of **total** VRAM and vLLM
**preallocates** it. On a card also driving a display you cannot take it all — the
existing `0.90` / `max_num_seqs=2` values in Cockpit are empirical scars from OOMing a
24 GB card at 16 seqs. The planner should surface desktop headroom as a first-class
input rather than leaving it as tribal knowledge.

Outputs worth rendering: what fits, what does not and by how much, and the *tradeoff
curve* — "drop to 32k context and you get 4 concurrent seqs" is the decision the user is
actually trying to make.

This also retroactively catches the class of bug behind today's incident: the profile
declares `W5_class: 55000` against a 49152 window. A planner refuses that at declaration
time instead of at runtime.

## 6. Reporting — persistent, and honest about failure

**Harvest from Cockpit before deleting** (`web/server.py`):

- `_parse_prometheus`, `_hist_quantile`, `_vllm_metrics` — scrape + reshape
- `_vllm_sampler_loop` and the **restart-survival persistence**: vLLM's counters zero on
  every container restart, so the sampler detects the drop, *banks* pre-restart totals
  into `carried`, and reads report `carried + live`. Lifetime never dips. This is the
  hard-won, non-obvious part and it is exactly what "persistent reporting" means here.
- The honesty markers: `window_exact` true only for `lifetime`; `by_session`/`by_agent`
  empty because vLLM tags by `model_name` only; `/metrics/timeseries` returning an honest
  `supported: false` rather than a misleading 503.

**Change from Cockpit's version: SQLite, not JSONL.** Cockpit stored samples in
`vllm-metrics.jsonl` because it was "crude, DB-free". This tool's whole point is
reporting, so it needs queryability from day one.

**Two independent data sources, do not conflate them:**

1. **Gateway request records** — per-request latency, TTFT, tokens, model, status,
   concurrency, client identity. Backend-agnostic, exact, and ours.
2. **vLLM Prometheus** — GPU-side: KV cache utilisation, running/waiting queue,
   preemptions, throughput. vLLM's own view.

The gateway view is authoritative on "what did consumers experience". Prometheus is
authoritative on "what was the GPU doing". Reporting that mixes them without labelling
which is which will produce numbers nobody can defend.

**Failure modes must be enumerated, never inferred from a zero.** Carry over the
`available: false` + `reason` stance already load-bearing in Cockpit:

`down` · `starting` (with ETA) · `serving` · `draining` · `unreachable` · `degraded`
(serving but preempting / KV thrashing) · `oom` · `image_missing` · `model_missing`

Each with a reason string and a suggested action. **A 0 tok/s chart and "we cannot reach
the engine" look identical and mean opposite things** — that principle is what the whole
honesty layer in Cockpit exists to enforce, and it transfers directly.

Known asterisk that follows us: streaming clients must send `stream_options.include_usage`
or token counts are absent. Cockpit never renders that as `0`, but the *remediation hint*
lost its home in the facelift. This tool is the right place for it.

## 7. Scope fence for v1

**In:** container lifecycle (start/stop/swap/restart), the gateway, reachability surface,
the VRAM planner, request + Prometheus reporting with persistence, failure states,
config presets.

**Out of v1:** chat UI (consumers do that), model *downloading* from HF (v1 assumes
models on disk — downloading is a real feature but it is a different problem), multi-GPU
topology management, tunnels, cost accounting (Cockpit owns that).

**Never:** queueing in the gateway path.

## 8. Shape

- **Runs as a service, not an app.** It owns a container and should survive login/logout
  and start with the machine. Cockpit is a thing you open; this is infrastructure.
- **Backend:** Python + FastAPI. The harvest is Python, and the idioms (structured
  logging, shape validation, honesty markers) transfer wholesale.
- **Gateway:** `httpx` streaming → `StreamingResponse`, no buffering. Getting SSE
  pass-through right is the one genuinely delicate piece of engineering.
- **Store:** SQLite.
- **Container control:** docker; WSL-wrapped on Windows, native on Linux. Cockpit's
  `start_managed_vllm` already has the argv builder, GPU-UUID pinning (including the
  `CUDA_DEVICE_ORDER`/`CUDA_VISIBLE_DEVICES` container env, because WSL exposes all GPUs
  to the container even with `--gpus device=UUID`), and the double-bind guard. Harvest it.
- **Frontend:** its own, but reusing Cockpit's `--cc-*` token vocabulary keeps the family
  resemblance cheap.

## 9. What Cockpit does when this lands

One endpoint entry pointing at the gateway. That is the whole integration. Then Cockpit's
Phase 3 deletion (managed vLLM lifecycle, `lms` CLI paths, model-control, the per-backend
settings cards) can proceed with no blind window, because the face is already reporting.

**Sequencing constraint, restated because it is the thing most likely to be got wrong:**
harvest → build the face → *then* delete from Cockpit. The GPU scraper must outlive the
management layer, or there is a period with no GPU visibility at all.
