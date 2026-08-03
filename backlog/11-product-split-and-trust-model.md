# 11 — The product split, and the two trust models

Opened 2026-08-02, from an architecture conversation with the owner. Nothing
here is built. This is the theory doc for a change that has to be got right the
first time, because it decides what runs where and who is allowed to reach it.

**The proposal, in the owner's words:** `plexar-chat.boord-its.com` is the face,
Plexar the app is the dev tool, and Plexar-vLLM is "our OpenRouter" — the layer
that governs the cards and from which anything model-shaped is commanded.

That holds. Most of the hard parts already exist on the Engine side: a
fixed-bind gateway, named keys with scopes, `/api/me` identity, per-identity
attribution in reporting, a model catalog carrying a real state envelope. What
follows is what the split *implies* rather than an argument against it.

---

## A. Naming (settled — cheap, not blocked on us)

| Today | Proposed |
|---|---|
| Plexar (platform + the app, ambiguous) | **Plexar** — the platform only |
| Claude Cockpit / Plexar the app | **Plexar Studio** — the dev tool |
| — | **Plexar Chat** — the face |
| Plexar-vLLM | **Plexar-LLM** — the serving layer (owner's pick, 2026-08-02) |

Solves the platform/app collision — which is what made an assistant in this
very session mis-assign "Plexar" to the provider — and drops `vllm` from a
product that is about to stop being vLLM-only (§B).

One caveat recorded and consciously accepted: `-llm` encodes a workload class
the same way `-vllm` encoded an engine, and §B is precisely about that layer
growing speech. If it later serves STT and TTS, the name is narrow again.
Owner's call is `plexar-llm`; noted here so nobody re-derives the objection.

Owner's call, recorded: **renaming a Cloudflare URL is lightweight — the real
blocker is the Google auth migration**, not the DNS or the cert. So sequence the
rename behind the auth cutover, not in front of it.

---

## B. Plexar must become engine-agnostic — THE decision everything else waits on

"Plexar governs the cards, so speech is commanded from Plexar" is right as a
principle and impossible as written, for three separate reasons:

1. **STT is fine.** vLLM serves Whisper natively via
   `/v1/audio/transcriptions`. Multilingual, 99 languages, auto-detect. No
   problem here.
2. **TTS is not a vLLM model type at all.** Kokoro is ONNX; Chatterbox and
   Orpheus are torch. No version of vLLM serves any of them. Something
   non-vLLM has to run on a Plexar-governed card, or TTS lives outside Plexar
   and the "one place commands the cards" premise is already false.
3. **The spare GTX 1070 is unreachable to vLLM.** Compute capability 6.1
   against vLLM's 7.0 floor — it does not degrade, it fails with "no kernel
   image is available for execution on the device." The one idle card in the
   rig is the one card vLLM cannot use.

So the unit of ownership has to become **a card and the process bound to it**,
not "a vLLM instance." vLLM stays the engine for LLM workloads and becomes one
engine *type* among two or three. Concretely, an instance record grows an
`engine` field (`vllm | ctranslate2 | onnx`), and the double-bind / adopt /
drain / report machinery has to stop assuming vLLM semantics.

**This is Plexar's decision, not Studio's**, and it gates §C, the 1070, voice,
and the whole premise. Nothing else in this doc should start first.

Measured 2026-08-02 via Plexar `/api/gpus`:

```
RTX 3090  24576 MB  →  gpu-main  gpu_memory_utilization 0.93  = 22856 MB preallocated
GTX 1070   8192 MB  →  no instances, 5286 MB free
```

**CORRECTED 2026-08-02 (owner directive):** an earlier revision of this
paragraph said the 1070 was not to be planned around. That was wrong. The
standing instruction is:

> Do not put Whisper on the 3090, use what you need from the 1070 that's local.

So the **1070 is the voice card** and the 3090 stays whole for the LLM. This
makes §B's third bullet the operative constraint rather than a footnote: vLLM
cannot address a compute-6.1 card at all, so *the 1070 running Whisper IS the
engine-agnostic decision*, not a preview of it. There is no arrangement in
which Plexar governs that card through vLLM.

Target rig, per the owner: a second 1070 joins a 3090 and an **RTX 6000**.
Mixed-generation cards in one box may need driver work — unverified, flag for
infra.

### B3. Tensor parallelism — the flip condition, and why it probably does not fire

Plexar runs **one model per card**, not tensor-parallel, so inter-GPU bandwidth
barely matters and PCIe lanes are far less critical than spec sheets imply.
Slot spacing, power and total VRAM are the real constraints.

The Plexar side sharpened this to "a 70B at 4-bit needs ~40 GiB, no single
consumer card holds it, so the moment 70B enters the plan tensor-parallel
enters with it, and lanes go from irrelevant to dominant — decide before the
order." The arithmetic is right; **the conclusion does not follow for this
hardware.** An RTX 6000 is 48 GB at minimum, so a 4-bit 70B fits on one card
and one-model-per-card survives it.

Lanes become dominant only if: a model exceeds what a single RTX 6000 holds, or
a 70B must be co-resident with something else on the same card. Worth
confirming the exact RTX 6000 variant before it drives a board decision — this
is the one thing that cannot be retrofitted, so it deserves a real answer
rather than either party's default.

### B1. VAD does not belong on a card at all

Barge-in needs a speech/no-speech decision roughly every 20 ms. A network round
trip per frame defeats it, wherever the GPU is. Silero VAD is ~50 MB with a
WASM build — **it runs in the browser**, and only the endpointed utterance ever
crosses the wire. Any design that routes raw frames to Plexar for VAD is wrong
before it is slow.

### B2. The multilingual asymmetry

Whisper understands 99 languages. Kokoro speaks 8 (en, es, fr, hi, it, ja, pt,
zh). If multilingual is a product requirement rather than a nice-to-have, the
gap is on the **output** side and no STT choice fixes it. Decide whether "we
understand you but cannot answer in your language" is acceptable.

---

## C. Two chat products, two trust models — do NOT unify the backend

> **STATUS 2026-08-03: Studio's Chat was REMOVED ENTIRELY.** This section is
> the reasoning that made the split correct, and the finding below is what
> settled it — so it is kept verbatim rather than deleted. Read the "Studio
> Chat" column as *what we measured before removing it*. The confinement
> finding itself is NOT historical: it is a property of running the `claude`
> CLI as the host user, which every Studio TERMINAL still does.

**The finding this section exists for, verified live on 2026-08-02, not
inferred:** Studio's Chat runs the `claude` CLI headlessly on the server. A
neutral working directory plus `--add-dir` does **not** confine it. Asked to
read a file outside both the chat workspace and the upload directory:

```
prompt : read C:\Code\Personal\claude-cockpit\CLAUDE.md
RESULT : is_error = False
done   : "# Claude Cockpit"
```

The read-only tool set reads **anything the host user can read** — SSH keys,
`.env`, browser profiles. "Read-only" bounds the *kind* of damage (total
exfiltration, no writes), not the *extent*. And Cockpit has **no
authentication anywhere** — zero auth dependencies in the server. The only
control is the loopback bind, which the startup path already warns about:

> the API has no authentication, so it will be reachable by anyone on the LAN
> (filesystem browse/upload, arbitrary process spawn)

That is entirely acceptable for a local dev tool, where the operator IS the
user. It is unshippable as a public face. Therefore:

| | **Studio Chat** (local) | **Plexar Chat** (public) |
|---|---|---|
| Engine path | `claude` CLI subprocess | HTTP to Plexar Engine |
| Tools | real, host filesystem | none, or sandboxed — never host |
| Identity | none; operator is the user | required, per-user |
| Binding | loopback only | internet |
| Storage | local SQLite | multi-tenant, per-identity |

**Share the UI. Never share the execution model.** A single backend with a
"disable tools" flag is the failure mode: one config mistake, or one future
feature that forgets the flag, and the public face inherits host filesystem
access. The separation has to be structural — different code path, not
different settings.

Consequence worth stating plainly: **Plexar Chat cannot do what Studio Chat
does.** No reading your repo, no grepping your disk. If the public face needs
file context, that is a *sandbox* project (container per session, or an
upload-scoped virtual FS) and it is a much larger piece of work than the chat
UI itself. Do not let the UI's similarity disguise that.

### C1. `allow_write` / `allow_exec` are one checkbox from arbitrary execution

`chat_runner` already carries these flags. They default off and there is no UI
to set them — that default is currently the *only* thing keeping Studio Chat
read-only. Whoever builds a permission gate should treat granting them as a
destructive-interlock change (§6 discipline), not a settings toggle.

---

## D. What a public face needs that Plexar deliberately does not have

Confirmed by the owner 2026-08-02: **nothing has quotas, rate limits, or
permissions beyond what is already restricted** — and that existing restriction
layer (named keys, scopes, guest narrowing, 403 on source-2 reports) lives on
the Plexar side and works. So this section is additive to a real foundation,
not a rebuild. Plexar's own docs list the gaps as "not built, do not design
against": no quotas, no rate limits, no per-model permission, no self-service
key minting, `owner` is all-or-nothing.

Every one of those was the right call when the guest list was people the owner
knows personally. A public chat face makes them the first thing a stranger
finds. Specifically:

- **Rate limits + quotas** — without them one visitor can occupy the only GPU
  indefinitely. The lane broker's spill thresholds are about *predicted wait*,
  not entitlement, and do not substitute.
- **Per-model permission** — a key that reaches `/v1/*` currently reaches every
  model on the card. With speech models added, that includes them.
- **Key lifecycle** — minting, rotation, revocation per user, rather than a
  hand-issued `plx_…` per person.

None is hard. All are dramatically cheaper before launch than after, and all
belong to Plexar rather than to either chat surface.

Related and already open: the Plexar key currently sits in `config.json` in
**plaintext** on disk (`backlog/10 §H`). A public deployment multiplies the
number of credentials that problem applies to.

---

## E. Sequencing

1. **§B — engine-agnostic Plexar.** Gates everything. Plexar team's call.
2. **§D — quotas, rate limits, per-model permission.** Independent of §B, and
   the long pole for anything public-facing.
3. **§C — Plexar Chat as a separate backend path.** Needs §B (for speech) and
   §D (for exposure).
4. **§A — the rename**, sequenced *behind* the Google auth migration per the
   owner.

Voice in Studio (`backlog/10 §voice`) is independent of all of this and can
proceed locally on the loopback trust model whenever the dependency-size
question is answered.

---

## F. Owner decisions still outstanding

- Does Plexar become engine-agnostic, or does speech live outside it? (§B)
- Is the Kokoro 8-language ceiling acceptable, or is broader TTS a
  requirement? (§B2)
- Does Plexar Chat need file context at all? If yes, that is a sandbox
  project and should be scoped separately from the chat UI. (§C)
- Is Studio Chat ever exposed beyond loopback? If the answer is "no, ever",
  say so in the docs and stop re-litigating it. (§C)
