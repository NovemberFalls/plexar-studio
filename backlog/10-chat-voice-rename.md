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

---

## D. Chat's model backend — PROVEN 2026-08-01: route through the harness

Question raised: *"if users send artifacts through the harness, does Claude Code
also give us its tools and abilities?"*

**Yes, and it changes three decisions at once.** Verified live, not assumed:

```
claude -p "Read probe.csv and reply with only the total of the numbers" \
       --output-format json --allowedTools Read
  -> exit 0, result "10", is_error false, session_id present
```

It read a file off disk with its own `Read` tool and did the arithmetic. That
is the full Claude Code toolset — Read, Write, Edit, Bash, WebFetch, agents —
available to Chat by driving the CLI headlessly rather than calling a model API.

### What this settles

1. **The xlsx parser question (§A) largely dissolves.** We do not need SheetJS
   to interpret a spreadsheet: hand the model the PATH and it reads the file
   with its own tools. `chat_store` already stores attachments as paths, not
   bytes, which is exactly the shape this wants. A renderer is then only needed
   for *display*, not comprehension — a much smaller decision.
2. **NO API KEY IS NEEDED.** The probe ran with no `ANTHROPIC_API_KEY` in the
   environment; the CLI used the existing subscription OAuth in
   `~/.claude/.credentials.json`. Chat inherits the user's own auth, the same
   credential Cockpit already reads for the usage pill. The "get the right API
   key" problem does not apply on this path at all.
3. **Cost is reported per turn** (`total_cost_usd`), so Chat can feed the same
   spend/reporting surfaces Cockpit already has. Note under a subscription that
   figure is API-EQUIVALENT, not money billed — `spend_guard`'s existing
   real-vs-equivalent split already draws that line correctly.

### The flags that matter

- `-p` non-interactive, `--output-format json` (or `stream-json` +
  `--include-partial-messages` for token-by-token streaming into the UI).
- `--session-id` / `--resume` for continuity, so a Chat conversation maps onto
  a real harness session rather than re-sending history every turn.
- `--allowedTools` is the permission surface. **This is the security decision
  that replaces the HTML-sandbox one**: a chat that can run `Bash` is a chat
  that can do anything the user can. Chat should start with a READ-ONLY tool
  set and require an explicit opt-in per conversation for anything that writes.

### Gotcha found while probing

`--allowedTools` is variadic (`<tools...>`), so it swallows a following
positional prompt and the CLI then fails with *"Input must be provided either
through stdin or as a prompt argument"*. The prompt must come BEFORE it, or be
passed on stdin. Whoever builds the spawn path should pass the prompt on stdin
and keep argv flag-only — it also avoids every quoting problem with a
multi-thousand-line paste.

### Consequence for §B (voice)

The voice loop's LLM leg can be the same harness call, which means voice
inherits tools too. It also means the "which model" question is answered by the
user's own `claude` config rather than by a second setting in Cockpit.

---

## E. Threat model — TWO different ones, and conflating them is the risk

Raised 2026-08-01: *"vLLM lives in Docker, so even if my uncle uses it, it
shouldn't be able to do anything to my main PC."*

**Correct for the engine, and it does not cover the dangerous path.**

| | who | where code runs | risk |
|---|---|---|---|
| **1. Remote guest → Plexar-vLLM** | uncle, via the tunnel | inside the container | LOW. Inference only; no tools. Container escape is the only path, and the gateway exposes no filesystem. The instinct is right. |
| **2. Local user → Chat → harness** | the Cockpit owner | **the host machine, NOT Docker** | HIGH if unguarded. |

Path 2 is the one that needs rails. `claude -p` executes its tools **on the
machine running Cockpit** — Docker is nowhere in that path. `Bash` there is
real local execution with the user's own privileges. The model being
containerised says nothing about where the *harness* runs.

Note also each install is local to its user: Plexar-vLLM is a hosted MODEL, but
the Cockpit/Plexar app runs in the user's own environment. So "we" are not
exposed by a guest — the user is exposed by their own chat.

### Rails (not built)

- Chat starts with a **read-only tool set**; anything that writes or executes
  requires explicit per-conversation opt-in, stored on the conversation.
- `--allowedTools` is the enforcement point, and it is server-side: a UI
  toggle alone is not a boundary.
- `--add-dir` scopes filesystem reach to the conversation's workdir rather
  than the whole disk.
- **No micro-VM today**, so running model-authored code to observe it means
  running it in the user's real environment. Until that changes, "audit, do not
  execute" is the honest default and the UI must not imply a sandbox exists.

---

## F. Chat — three requirements captured 2026-08-01 (not built)

1. **A collapsible Inspector inside Chat**, mirroring the session Inspector:
   model, context %, input/output tokens, cache read/write, API-equivalent
   cost, and per-conversation controls. The data already exists — `usage_tracker`
   and the `total_cost_usd` the harness returns per turn. Under a subscription
   that figure is API-EQUIVALENT, not money billed; `spend_guard`'s existing
   real-vs-equivalent split already draws that line and Chat must not re-draw it.
2. **Forced compaction at 85–90% of context** — a summary + highlight reel,
   written to a folder keyed by `session_id`. Two rules worth fixing now:
   compaction is LOSSY, so the full transcript must survive alongside the
   summary (never replaced by it); and the threshold must key off the model's
   real context window, not a constant, or it fires at the wrong point on every
   model but one.
3. **User-chosen chat storage** — local via a system picker, or object storage
   by URL (R2 / S3 / B2). `chat_store` is SQLite-on-disk today. Remote storage
   is a genuinely different design (latency, conflict, partial writes), so the
   honest first step is local-path choice plus EXPORT to object storage, not
   pretending SQLite can live on S3.

---

## G. Chat design 6a — handoff received 2026-08-01

Spec copied into the repo as `backlog/CHAT-design-6a.md` (it arrived in
Downloads, which is not a durable home for a binding contract).

**6a is NEUTRAL and is what gets built. 5a is reference only.** The difference
is not taste — it is a rule: *hierarchy comes from BRIGHTNESS, not hue.* A thing
that needs the user is `--cc-fg`; a resolved thing falls to `--cc-dim` then
`--cc-muted`. Concretely, 5a's glowing amber permission gate, blue primary
buttons, coloured badges/pills, coloured filter chips, multi-hue chart bars and
syntax rainbow are all OUT.

The single exception is the five artifact TYPE tones, on a type icon and its
label only — never a fill, a card background or a status colour — because type
is the one thing scanned by category rather than urgency.

### Landed

- Five artifact tones added to `index.css` (`--cc-a-diff|run|code|chart|image`).
  Every other token the spec names already existed.
- Four-column shell: 272 list · flexible transcript (min 560) · 288 artifacts
  rail, collapsible from the header. `minHeight: 0` on the scrolling body,
  which the spec flags as required — without it a long thread pushes the
  composer off-screen.
- Conversation list at 56px rows, three lines, brightness-encoded state.
- Transcript at `gap:18px`, `padding:16px 26px 0`, prose measure 620px.
- Composer per §7, and **the model selector moved OUT of the header into the
  bottom bar** — model and permission mode are the two things changed
  per-message.
- Send is a 30px circle with an arrow, so its tests query the accessible name
  rather than button text.

### NOT built — build order 5–12

Streaming (deltas, caret, auto-scroll rule, Interrupt), tool-call strip,
**permission gate** (§6, the most important component in the spec), artifact
full screen 6b, message actions (edit & re-run with its consequence warning,
retry-with, fork), `@` and `/` pickers, drag-drop, voice, agent registration.

All of those depend on a model actually replying, which is still the gating
piece. The surfaces say so rather than rendering convincing empty furniture.

### Two spec details worth not losing

- **Only two engine facts are allowed in Chat**: context remaining and tok/s.
  No spill, queue depth, lane class or cost — those live in Engine and
  Settings. Cost appears exactly once, in the retry-with menu, because there it
  is a decision.
- **Edit & re-run must show its consequence before committing** ("discards 6
  later messages and 2 artifacts") with a Fork-instead escape. Never destroy
  history silently — the same rule the group-delete behaviour already follows.

---

## H. Secrets hygiene — audit + history rewrite, 2026-08-01

Raised when it became clear this repo is public and will be pushed.

### What was actually leaked

**No key material, ever.** Verified with `git log --all -S` rather than by
reading diffs: every `plx_` token in history is a test placeholder
(`plx_whatever`, `plx_secret_value`). `web/.env` is gitignored and untracked,
and the live key lives in `config.json` in the user data dir — outside the repo
entirely.

**The private rig hostname WAS leaked**, in three places, all from this session:
one commit message and one test file (added in one commit, removed in another).
On a public repo a diff publishes as surely as a message does, so both had to go.

### The fix

`git filter-branch` over the last three commits with a `--msg-filter` and a
`--tree-filter`, `--prune-empty`. The scrub commit became empty and was pruned,
which is correct — it existed only to undo a change that no longer happened.

Two properties that made this cheap, and both were checked BEFORE touching
anything:

- the affected commits were **local only** — `git branch -r --contains` was
  empty, so the leak never reached origin;
- the remote tip is still an **ancestor** of the rewritten HEAD, so the push is
  an ordinary fast-forward. **No force push, and no rewriting of anything
  anyone else has.**

### Rules going forward

- **Never put a real hostname, port mapping or serial in a test fixture.** RFC
  2606 reserves `.test` / `.example` for this. The assertions were about scheme
  handling and trailing-slash normalisation; the host was never the point.
- **Loopback defaults stay in source.** `127.0.0.1:8760` is localhost, is
  overridable, and a default pointing nowhere makes a fresh install fail with
  no explanation. That is not a leak.
- **Commit messages are published too.** Diagnostic output pasted into a
  message is as public as code.

### Still open

`config.json` holds the Plexar key in **plaintext on disk**. That is a real
weakness, just a different one from git. The right home is the OS keychain
(DPAPI on Windows), not AWS Secrets Manager: this is a desktop app talking to a
service on the user's own machine, so there is no server-side identity to
authenticate to AWS *with* — you would need a credential to fetch the
credential. Secrets Manager is right for the rig side, not the client.
