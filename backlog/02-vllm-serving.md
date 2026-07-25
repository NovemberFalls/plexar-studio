# Backlog 02 — vLLM as second local provider (3090-only)

**Status: BLOCKED on a real ABI mismatch. NOT a quick fix — pursue as its own task.**

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
