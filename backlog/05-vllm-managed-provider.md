# Backlog 05 — Cockpit-managed vLLM provider (coexist)

## Status: IMPLEMENTED (2026-07-25)

## What shipped

The env-gated managed lifecycle + vllm-local provider entry (models+health), coexisting with lmstudio-local, in web/server.py.

## How to enable

Set `COCKPIT_MANAGED_VLLM=1` (+ set `COCKPIT_VLLM_MODELS_DIR` / `COCKPIT_VLLM_GPU_UUID` for this machine's 3090 as needed), restart Cockpit; the vLLM container comes up on :8001 and the provider appears in ProviderPicker.

## Startup order

Broker (LM Studio front) and managed vLLM both start best-effort in the lifespan; neither blocks Cockpit; vLLM first-boot ~7min (torch.compile + graph capture, cached after).

## SESSION STATE — 2026-07-25 (shipped in v1.6.2, committed)

vLLM is now a fully working first-class local provider AND the live orchestration lane. Landed this session:
- **Managed vLLM lifecycle** (`start/stop_managed_vllm`, opt-in `COCKPIT_MANAGED_VLLM=0`), coexists beside LM Studio, served DIRECT on :8001 (not through the 1-deep broker).
- **Provider-aware connection card** (`LocalBrokerView.jsx`) — vLLM shows offline→connected, auto-flips when it boots.
- **Configurable endpoint** (`POST /api/local/{id}/endpoint`) with SSRF-hardened validation (loopback/private IPs only, no redirects, no persisted-config bypass — zara-reviewed, durable tests).
- **Models-path fix** (`_models_path`): vLLM uses `/v1/models`, LM Studio `/api/v0/models` (the 1.6.0 bug where vLLM read offline).
- **Tool-calling parity** in the managed launcher: `--enable-auto-tool-choice --tool-call-parser qwen3_coder` + 49152 context + GPU pin (verified: vLLM 400s on tool calls without these).
- **Lane wired**: `team/bench/local_lane/local-lanes.json` `gpu-main` → vLLM :8001 (LM Studio preserved as `gpu-lmstudio`). Live-verified: a real agentic worker card ran on vLLM via `local_worker.sh` and completed using the Write tool.
- Measured: vLLM 3.4x single-stream / ~12x batched vs LM Studio on the 30B-a3b MoE.

## NEXT (post-compact — the two remaining pieces)

1. **vLLM `/metrics` adapter** — map vLLM's Prometheus `/metrics` into the broker's runs/TTFT/decode shape, bump the `vllm-local` provider capabilities to include `metrics`, so vLLM shows up in the Routing & Reporting dashboard (today LOCAL SHARE stays 0% there because vLLM traffic doesn't flow through the broker and exposes no broker-shaped metrics). THEN it becomes a visible reporting backend.
2. **Quality crown** — run 30B-a3b vs the crowned 27B through the team arena (champion cells k=2 on WORKHORSE/MUNDANE fixtures). Adopted on speed + arch-fit ahead of this; the profile notes it's uncrowned.

## Other follow-ups
- A "managed by Cockpit" indicator for the vLLM provider in the Connection card.
- Health route `ok` semantics for direct (no-broker) providers (currently `ok=False` for vLLM because it also probes a broker; card uses models-reachability, so cosmetic).
- Level-2 "Cockpit as source of truth": derive the orchestration lane from Cockpit's connected provider instead of a hand-edited `local-lanes.json`.
- Test-hygiene: worker self-checks/probes must isolate the persistence path (they polluted the real `~/.claude-cockpit/provider-endpoints.json` this session; cleaned).
