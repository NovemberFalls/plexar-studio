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
| Voice | **BLOCKED — see §B** |

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

## B. Voice — the blocking finding

The brief asks for barge-in conversational voice using newscast's voices.
Newscast uses **Chatterbox TTS on CUDA** (`newscast/tts.py`, `device: cuda`),
loaded lazily, rendering whole segments to WAV.

**Two problems, and the second is the hard one.**

### 1. Chatterbox is a batch renderer, not a conversational engine

It generates a full utterance per call. Barge-in needs first-audio latency in
the low hundreds of milliseconds and the ability to *stop mid-sentence*.
Sentence-at-a-time streaming can approximate it, but this is a real
architectural gap, not a config flag.

### 2. THE GPU IS ALREADY COMMITTED

Per `plexar-vllm/docs/15` §7, the live vLLM instance runs
`gpu_memory_utilization: 0.79`, `max_num_seqs: 1`, on the 3090 that also drives
a display. A conversational voice loop wants **three** models resident —
STT (Whisper), VAD, and TTS — on that same card, while the LLM answering you
holds 79% of it and serializes at one sequence.

So voice is not "add a library". It is a capacity decision:

- **(a) Share the card** — accept that speaking and thinking contend, and that
  a second consumer already serializes behind the first at `max_num_seqs: 1`.
- **(b) CPU voice** — Whisper.cpp + Piper both run acceptably on CPU. Piper is
  fast and tiny, but **cannot clone the newscast voices**, so the "double dip"
  is lost. Voice identity would be Piper's own set.
- **(c) Second GPU / the dedicated rig** in `plexar-vllm/docs/11-rig-build.md`.

**(b) is the only option that works today without degrading Plexar**, and it
costs the exact feature that motivated reusing newscast. That trade is the
owner's call, not mine — I have not picked one.

### The 5-second pause rule is the easy part

Silero VAD gives reliable speech/silence boundaries; a 5s silence timer as
"continue" cue is a small state machine on top. It is not the risk here.

---

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
4. **Name collision** — `plexar` is already a *provider id* inside Cockpit. If
   the app is also Plexar, "the Plexar provider" becomes ambiguous in code and
   in conversation. Decide whether the provider gets renamed (e.g. to the
   engine's own name) before the app takes the name.

**Recommended order:** decide (4) first — it is free now and expensive later —
then do (1)+(2) as one cosmetic pass, and treat (3) as its own change with a
directory migration and a deliberate updater story.

---

## Suggested sequence

1. Decide the HTML-sandbox and xlsx-parser questions (§A) — blocks artifacts.
2. Decide the voice capacity trade (§B) — blocks all voice work.
3. Decide the `plexar` name collision (§C.4) — free today.
4. Build Chat UI: rail destination, list, composer, history, context limits.
5. Artifacts.
6. Voice, per the decision in (2).
7. Rename, in the three tiers.
