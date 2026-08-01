# 10 — Chat surface, voice, and the Plexar rename

Opened 2026-07-31. Three programs bundled in one ask; they have different
shapes and should not share a milestone.

**Landed already:** `chat_store.py` + `/api/chat/*` (38 tests). Everything else
below is planned, not built.

---

## A. Chat — status

| Piece | State |
|---|---|
| Store: groups, conversations, messages, attachments | **DONE** — 22 tests |
| REST: `/api/chat/*` incl. export | **DONE** — 16 tests |
| Rail destination + conversation list + composer | NOT STARTED |
| Artifact rendering (md, html, csv, xlsx) | NOT STARTED |
| Upload / large paste wiring | NOT STARTED (store side is done) |
| Context-limit display | NOT STARTED |
| Voice: stack decision + packaging constraint | **DECIDED** — see §B |
| Voice: service module + state machine | IN PROGRESS |
| Voice: latency probe on this machine | OWED — see §B |

### Decisions already made in the store, so the UI does not re-litigate them

- **Ordering is `seq`, never timestamp.** Two messages land in the same
  millisecond routinely. A chat that renders in a different order on reload is
  broken in a way users do not forgive.
- **Deleting a group NEVER deletes conversations.** A group is a shelf, not a
  container; the chats re-parent to the root and the response says how many
  moved. Deleting a *conversation* does cascade, because it genuinely contains
  its messages.
- **`group_id: null` means "move to root"** and is only applied when the key is
  present. Otherwise moving a chat out of a group is inexpressible.
- **Content is verbatim.** Oversized is a loud `413`, never a trim.
- **Attachments store a path, not bytes.**

### Artifact rendering — the one real dependency question

`md` and `csv` are self-contained. **`xlsx` is not** — it needs a parser
(SheetJS or similar), and `html` needs a sandboxing decision. Cockpit currently
ships no third-party renderer, and an artifact pane that executes arbitrary
model-authored HTML in the app's own origin is a genuine security question, not
a styling one. Proposal: render HTML in a sandboxed iframe with no
same-origin/scripts by default, and treat "run it" as an explicit user action.
**Needs a decision before work starts.**

---

## B. Voice — decided 2026-07-31: Kokoro-first, off the GPU

**Stack:** faster-whisper (STT) · Silero VAD · Plexar-vLLM (LLM) · **Kokoro** (TTS)
· WebSockets + Opus (transport).

### Why not Piper — correcting an earlier recommendation here

This document previously defaulted to Piper. That was the *lighter* option, not
the better one: Piper is fast and tiny but audibly synthetic, which matters a
lot for something you hold a conversation with. **Kokoro (~82M, Apache-2.0) is
the default.** It is still CPU-viable and substantially more natural.

### What Kokoro does NOT change

The original finding stands, and it was never about which TTS engine:

**Neither Kokoro nor Piper can clone a voice from a reference WAV.** The files
in `newscast/voices/*.wav` are Chatterbox voice-CLONING prompts. Kokoro ships a
fixed voicepack set (blendable, not clonable), so "select from the newscast
voices" becomes "select from Kokoro's voices". The double-dip is spent.

That is an accepted trade, not an oversight:

| | clones newscast voices | fights Plexar for the 3090 | barge-in |
|---|---|---|---|
| Chatterbox | **yes** | **yes** — GPU at 0.79 util, max_num_seqs 1 | batch renderer; gap |
| Kokoro | no | **no** — runs off-GPU | streamable |

Kokoro sidesteps the GPU contention by not needing the GPU, which is why it
wins even though it costs the feature that motivated reusing newscast.

### PACKAGING — the constraint that decides the implementation

**The PyInstaller sidecar is 48 MB.** Bundling torch would add roughly 2 GB and
make the installer indefensible. Therefore:

- **onnxruntime only. No torch.** Silero and Kokoro both ship ONNX builds;
  faster-whisper is CTranslate2, not torch.
- **Model weights are downloaded on FIRST USE** into `~/.claude-cockpit/voice/`
  — never shipped in the installer.
- **Every ML import is lazy**, inside the function that needs it. Importing the
  voice module must be free and must never touch GPU, network or disk, exactly
  as `newscast/tts.py` loads Chatterbox lazily.
- Voice is therefore an **optional capability**: absent deps is a normal,
  reportable state, not an error, and the UI says so rather than showing a dead
  button.

### The 5-second pause rule is the easy part

Silero VAD gives reliable speech/silence boundaries; a 5s silence timer as the
"continue" cue is a small state machine on top. Barge-in — speech detected
while speaking must cancel playback immediately — is the behaviour that
actually has to be right.

### OWED: a latency probe, before barge-in is called done

Nothing here has been measured on this machine, and "fast on CPU" is a claim
about typical hardware. This CPU is also running Cockpit, the lane broker and
Docker.

The probe must report, on THIS box, with no fabricated figures:

1. **VAD decision latency** — speech onset to detection. Gates barge-in.
2. **STT** — end of speech to final transcript, for a ~5s utterance.
3. **TTS first-audio** — text in to first PCM out. This is what makes a reply
   feel instant; total render time is the wrong number to optimise.
4. **Barge-in stop latency** — speech onset to audio actually silent.
5. Each measured with the LLM idle AND with Plexar-vLLM under load, because
   `max_num_seqs: 1` means a second consumer serialises.

A figure that could not be measured is `null` with a reason — never a zero and
never an estimate presented as a measurement.

### Remote is now real, and brings a caveat

WebSockets + Opus is a *remote* transport choice ("press a button on my phone").
That stopped being hypothetical this week: Plexar-vLLM is reachable through the
Cloudflare tunnel, and Cockpit already runs a WS bridge for terminals. But per
`plexar-vllm/docs/15` §3/§6 there is **no per-user identity and no scoped
authorisation** — a phone client holds a key that can also delete instances,
and the human authenticates twice (Access, then Plexar). Do not design a
multi-user voice client against that yet.

## C. The Plexar rename — plan, not yet started

Logo: `~/Downloads/ChatGPT Image Jul 31, 2026, 07_37_41 AM.png` — a stylised
**P** with a diagonal amber light-bar and a faint grid, on charcoal. Amber/gold
on near-black reads directly onto the existing `--cc-*` dark palettes; it is
close to the channel-active orange already in use, which is worth checking for
collision before adopting it as brand.

**A rename is only cheap where it is cosmetic. Ranked by risk:**

1. **Free** — window title, About, docs prose, README.
2. **Cheap but visible** — logo/icon assets, installer branding strings.
3. **BREAKING, needs a migration** — `~/.claude-cockpit/` (settings, usage,
   pricing, chat DBs), the `cockpit-*` localStorage keys, the Tauri bundle
   identifier `com.claude-cockpit.app`, and the NSIS product name. Changing the
   data directory without a migration silently orphans every user's history;
   changing the bundle identifier makes the installer treat it as a **different
   application**, so the updater will not see it as an upgrade.
4. ~~**Name collision**~~ — **SETTLED 2026-07-31.** Plexar is the PLATFORM
   (this app); Plexar-vLLM is the MODEL side (the provider). The provider id
   moved `plexar` -> `plexar-vllm`; the app keeps the name. Deliberately
   unchanged: `kind: "plexar"` (backend family) and the `plexar` key inside
   `/v1/models` entries (Plexar-vLLM's WIRE FORMAT — renaming it stops the
   envelope parsing). No localStorage migration needed: `ProviderPicker` falls
   back to a real provider on an unknown id, now pinned by a test.

**Remaining order:** (1)+(2) as one cosmetic pass, then (3) as its own change
with a directory migration and a deliberate updater story.

---

## Suggested sequence

1. Decide the HTML-sandbox and xlsx-parser questions (§A) — blocks artifacts.
2. ~~Voice capacity trade~~ — DECIDED (§B): Kokoro, off-GPU, onnxruntime only.
3. ~~`plexar` name collision~~ — SETTLED (§C.4).
4. Build Chat UI: rail destination, list, composer, history, context limits.
5. Artifacts.
6. Voice, per the decision in (2).
7. Rename, in the three tiers.
