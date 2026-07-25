# Backlog 02 — vLLM as second local provider (3090-only)

**Status: RESOLVED via Docker — vLLM SERVES. Benchmark done (2026-07-25). Verdict: on the
shared 3090 the 27B is strictly SLOWER than LM Studio; do NOT adopt vLLM+27B for the lane.**

## RESULT (2026-07-25) — Docker sidestep worked; benchmark settles it
The native venv ABI hell (below) was sidestepped exactly as recommended: the official
`vllm/vllm-openai` image serves the downloaded 27B on the 3090.

- **Docker path works.** Enabled Docker Desktop WSL integration for Ubuntu (settings
  `EnableIntegrationWithDefaultWslDistro=true`, `IntegratedWslDistros=["Ubuntu"]`) so the
  ext4 model path bind-mounts natively (no 9p). WSL2 GPU pin quirk: `--gpus device=UUID`
  does NOT filter (dxg exposes all GPUs; nvidia-smi lists both) — pin the CUDA process
  with `-e CUDA_DEVICE_ORDER=PCI_BUS_ID -e CUDA_VISIBLE_DEVICES=<3090 UUID>`. vLLM obeys it.
- **Serve cmd that fit:** `--model /model --served-model-name qwen3.6-27b --max-model-len 2048
  --gpu-memory-utilization 0.93 --enforce-eager --ipc=host -p 18000:8000`. Weights 19.2GB,
  peak activation 1.89GB, KV cache only **0.69GB → 4,778 tokens (2.33x concurrency)**.
  0.95 util OOMs (needs 22.8GB, only 22.76 free); 0.88 gives zero KV blocks. 0.93 is the
  needle. Boot/profile ~186s.
- **Throughput (vs LM Studio ~26 tok/s single-stream baseline):**
  - single-stream: **9.5 tok/s** (2.7x SLOWER than LM Studio)
  - concurrency=2: 19.3 tok/s aggregate — still slower
  - concurrency=4: 18.1 tok/s aggregate — still slower
- **Why vLLM loses here:** the 20GB weights force `--enforce-eager` (no VRAM for CUDA
  graphs) and a 0.69GB KV cache, capping concurrency at 2.33x. vLLM's only edge is batched
  throughput — and the 27B leaves no room to deliver it. The 1-deep local lanes wouldn't
  use batching anyway.
- **Recommendation:** if a vLLM lane is still wanted, serve a **7B/14B AWQ** (drop
  `--enforce-eager`, real KV headroom) and re-benchmark — that is the only config where
  vLLM could plausibly beat LM Studio. Otherwise LM Studio remains the better local backend
  on this hardware. Container was stopped/removed after the test (freed the 3090 for LM Studio).

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
