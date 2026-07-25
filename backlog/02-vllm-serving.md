# Backlog 02 — vLLM as second local provider (3090-only)

**Status: RESOLVED (2026-07-25, corrected). vLLM WINS decisively — but ONLY on the right
model. The 27B loses (it's a hybrid Mamba+vision model that cripples vLLM); Qwen3-Coder-30B-A3B
(a dense-attention MoE) runs vLLM's fast path clean and beats LM Studio 3.4x single-stream
and up to ~12x batched. ADOPT vLLM + Qwen3-Coder-30B-A3B-AWQ for the local lane (quality
crown pending team bench).**

## CORRECTED RESULT (2026-07-25) — the model, not the engine, was the variable
The first pass (below) benchmarked the **27B and concluded vLLM loses**. That conclusion was
an artifact of the model: Qwen3.6-27B is a **hybrid Mamba + vision** model. vLLM's memory-
profiling / CUDA-graph fast path HANGS on it, forcing `--enforce-eager` (no graphs) → ~8-9.5
tok/s, and its 20GB weights starve the KV cache. That first pass even predicted the fix
("serve a 7B/14B AWQ, drop --enforce-eager … the only config where vLLM could plausibly beat
LM Studio"). We did exactly that with a dense-attention MoE, and the verdict flips.

### The winning config — Qwen3-Coder-30B-A3B (`qwen3moe`, MoE ~3B active), AWQ INT4
`QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ` (~16GB, 6 shards). Served with vLLM's FAST path
(no `--enforce-eager`): `--quantization awq_marlin --dtype half --max-model-len 16384
--gpu-memory-utilization 0.92 --max-num-seqs 16`. KV cache **5.49GB → 59,984 tokens (3.66x
concurrency at 16K ctx)**. First boot ~7min (torch.compile + graph capture; cached after).
Arch is text-only dense attention → NONE of the 27B's hang. `/v1/messages` (Anthropic API)
is served natively, so `claude` CLI → broker :1235 → vLLM works with no translation shim.

### Measured — same 32 requests, same prompts/tokens, one 3090
| conc | LM Studio (GGUF) wall / agg | vLLM (AWQ fast) wall / agg | vLLM |
|---|---|---|---|
| 1 | 137.7s / 46.5 tok/s | **39.9s / 160.4 tok/s** | **3.4x** |
| 4 | 70.1s / 91.3 | **11.7s / 546** | **6.0x** |
| 8 | 52.1s / 123.0 | **6.6s / 968** | **7.9x** |
| 16 | (parallel=4 cap) | **4.1s / 1558** | — |

- **Single-stream (conc=1): vLLM 3.4x faster** — matters even for the 1-deep worker lane
  (`/orchestrate-anthropic-local` runs workers sequentially → this ~3.4x cuts every wall).
- **Batched: ~12x peak throughput**, near-linear scaling (9.71x at conc16) vs LM Studio
  flattening by conc4 — the win for any throughput-bound lane (e.g. the podcast).
- Surprise: llama.cpp's GGUF MoE path is far less optimized than vLLM's Marlin-AWQ kernels
  on Ampere, so vLLM wins even single-stream (earlier assumption "LM Studio ties single-stream"
  was wrong for MoE).

### The one honest gap
**Quality is NOT yet crowned.** Speed measured; whether 30B-a3b matches the 27B's arena-crowned
coding quality (AWQ vs GGUF quant, dense-27B vs 3B-active-MoE) is the team bench's call
(champion cells k=2 on WORKHORSE/MUNDANE fixtures). Speed adopts it as a candidate; the arena
crowns it.

### KV / context caveat
5.49GB KV → ~60K tokens. Short/medium requests pack 16-way fine; but a real worker card at
22-55K context uses that whole budget → only ~1-2 concurrent long-context workers per card.
Fine for the 1-deep lane; the concurrency win is for short/medium requests. More cards (replicas)
raise the ceiling.

### Adoption lever (broker repoint)
The broker's upstream is one env var: `COCKPIT_LMSTUDIO_URL` (server.py). Set it to the vLLM
port to front vLLM instead of LM Studio; everything downstream (worker dispatch + Cockpit's
provider observation) keeps working. vLLM lifecycle is a Docker container (launch script;
Cockpit-managed vLLM is a follow-up — the in-process managed broker can't host a container).

---
## Original blocker (kept for history — native venv path, now sidestepped)


## What IS solved
- **Driver**: 581.57 / CUDA 13.0 satisfies vLLM's `libcudart.so.13`. (History: 610 branch
  dropped Pascal → stranded the 1070 in device error 31; 581 is the last branch supporting
  BOTH Pascal + Ampere. Do NOT go past 581 while the 1070 drives the 6 monitors. See
  memory `vllm-wsl-state`.)
- **3090-only pinning: works** — `CUDA_DEVICE_ORDER=PCI_BUS_ID CUDA_VISIBLE_DEVICES=<3090 UUID>`;
  every serve attempt grabbed only the 3090, the 1070 stayed out. Requirement met.
- **Model downloaded**: `~/models/Qwen3.6-27B-AWQ-INT4` (~20GB, compressed-tensors INT4).

## The blocker (diagnosed, reproducible across a fresh venv rebuild)
vLLM's engine does `import vllm._C` (cuda.py:21) which links `libcudart.so.13`, but the
installed `vllm==0.25.1` wheel ships `vllm._C_stable_libtorch.abi3.so` instead against
`torch 2.11.0+cu130`. Torch-ABI / vLLM-build mismatch — reinstalling does NOT fix it.

## Recommended next approach — SIDESTEP the venv/pip ABI hell
Run the **official vLLM Docker image** (`vllm/vllm-openai`) with `--gpus '"device=<3090 UUID>"'`.
Self-contained CUDA runtime → avoids the whole torch/vLLM ABI problem. Docker Desktop is installed.
Alternative if a native build is wanted: pin a **known-good vllm+torch pair** (release-qualify first).
Alternative tools worth noting: LM Studio (provider 1) already serves the 27B at 17.5GB fine
(~26 tok/s) — vLLM's only real win here is throughput the 1-deep local lanes don't need.
Other options: TGI (HF, Docker), SGLang, llama.cpp server, Ollama.

## VRAM reality
24GB 3090; ~20GB weights leaves almost no KV headroom (~3GB held by desktop/browser).
Likely need a 7B/14B for the vLLM lane, or a low `--max-model-len`. vLLM + LM Studio
cannot co-reside on the 3090 — one provider at a time (swap the GPU).

## Then: speed test
Once serving, benchmark tps vs LM Studio (~26 tok/s baseline) through the broker with
`x-lane-class` headers. This is the deliverable that's currently blocked.
