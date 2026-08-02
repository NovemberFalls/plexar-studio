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
| Plexar-vLLM | **Plexar Engine** — the serving layer |

Two problems solved at once: the platform/app collision (which is what made an
assistant in this very session mis-assign "Plexar" to the provider), and the
engine name in a product that is about to stop being vLLM-only (§B).

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

Measured context for whoever picks it up (RTX 3090 + GTX 1070 rig, 2026-08-02):

```
RTX 3090  24576 MB  →  gpu-main  gpu_memory_utilization 0.93  = 22856 MB preallocated
GTX 1070   8192 MB  →  no instances, 5286 MB free, headless
```

Whisper on the 3090 means dropping the LLM to ~0.85. Whisper on the 1070 means
a non-vLLM engine. There is no third option.

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

Recorded in Plexar's own docs as "not built, do not design against": **no
quotas, no rate limits, no per-model permission, no self-service key minting,
`owner` is all-or-nothing.**

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
