# Cockpit — Chat surface

> **THIS SURFACE NO LONGER EXISTS IN THIS REPO.** The embedded Chat destination
> was removed entirely on 2026-08-03. This file is retained for ONE reason: it
> is the visual spec `backlog/12` hands to **`plexar-chat`**, the separate
> product. Nothing below describes anything you can open in Plexar Studio, and
> nothing below is a task in this repo.

Implementation handoff. Scope is **only** the Chat destination. Everything else in the app is unchanged.

Canonical design: **6a** (main screen) and **6b** (artifact full screen) in `Cockpit Redesign.dc.html`.
6a is neutral/flat and is what you build. **5a** in the same file is an earlier, higher-colour variant — reference only; do not build it. If you need to check a detail that 6a compresses (the @-picker, the `/` palette, the voice states, the retry menu, the new-chat flow), those anatomy cards are **5b–5f** and are still valid; strip their hue to 6a's rules when you implement them.

Open the file in a browser and measure. Every number below is in the markup.

---

## 1. Tokens

Already in `:root`. Do not add new colours outside this list.

```
--cc-bg:#1a1a1a        app background, transcript column
--cc-bg2:#151515       rails (conversation list, artifacts, nav)
--cc-surface:#212121   cards, composer, user message block
--cc-elev:#262626      selected row, chips, inline code, meter track
--cc-term:#181818      code / diff / command backgrounds
--cc-border:rgba(255,255,255,.08)   all card + control borders
--cc-line:rgba(255,255,255,.06)     internal dividers
--cc-fg:#d7d6d3        primary text, ATTENTION state, primary button fill
--cc-dim:#9a9a97       secondary text, resting icons
--cc-muted:#666664     tertiary text, labels, timestamps
--cc-sans:"IBM Plex Sans", system-ui, sans-serif
```

Artifact type tones — **the only hue in the whole surface.** Low chroma, used on the type icon and the type label only, never as a fill or a card background:

```
--cc-a-diff:#8098b0    DIFF
--cc-a-run:#b58d80     RUN  (also tints a failure count)
--cc-a-code:#b3a47e    SNIPPET
--cc-a-chart:#8ea88c   CHART (also the chart's peak bars)
--cc-a-image:#a390ab   IMAGE (1px border on the thumbnail)
```

### The colour rule

Hierarchy comes from **brightness, not hue**. A thing that needs the user is `--cc-fg`; a thing that is resolved falls to `--cc-dim` then `--cc-muted`. No tinted card backgrounds, no gradients, no glows, no coloured badges, no coloured status dots, no syntax rainbow. Diffs read as two tones plus a gutter bar (`rgba(255,255,255,.05)` + 2px `--cc-fg` left border for added, `rgba(0,0,0,.35)` + 2px `--cc-muted` for removed).

The one deliberate exception is the artifact tones above, because artifact *type* is the one thing users scan for by category rather than by urgency.

---

## 2. Typography

| Use | Family | Size / line-height |
|---|---|---|
| Message prose, names, previews, button labels | `--cc-sans` | 14px / 1.65 (prose), 12.5px (names), 11px (previews) |
| Everything the machine produced — code, diffs, paths, commands, counts, token numbers | JetBrains Mono | 11.5–12px / 1.7 |
| Section labels (`DIFF`, `TODAY`, `PYTHON`) | JetBrains Mono | 9.5px, `letter-spacing:.08–.1em`, uppercase, `--cc-muted` |
| Inline code inside prose | JetBrains Mono 12.5px | `--cc-elev` bg, 1px 5px, radius 4 |

Prose max width **620px** even when the column is wider. Never set prose in mono; never set a path or a command in sans.

---

## 3. Shell

1440×900 reference. Four columns, all full height, borders between.

| Column | Width | Background |
|---|---|---|
| Nav rail | 56 fixed | `--cc-bg2` |
| Conversation list | 272 fixed (collapsible) | `--cc-bg2` |
| Transcript | flex, min 560 | `--cc-bg` |
| Artifacts rail | 288 fixed (collapsible, toggled from the header) | `--cc-bg2` |

Transcript column internals: 52px header / `flex:1 min-height:0 overflow-y:auto` body / composer block. **`min-height:0` on the scrolling body is required** or the composer gets pushed off-screen.

Nav rail: Chat is the 2nd destination, after Work. Items are 38×34 icon-only, 1.8 stroke width, `--cc-muted` at rest, `--cc-elev` + `--cc-border` + `--cc-fg` when active. A 5px `--cc-fg` dot at top-right when any chat needs attention.

---

## 4. Conversation list

Header 52px: "Chats", spacer, search icon, `+` icon (`--cc-fg`). No filter chips — search covers it.

Rows are **56px**, 34×34 avatar at radius 9 (`--cc-surface` + `--cc-border`), then three lines:

1. Name (`--cc-sans` 12.5px) + timestamp right-aligned
2. Last message preview, one line, ellipsised
3. Counterpart line, 9.5px `--cc-muted` — `claude-cockpit · main` for an agent, `local · qwen2.5-coder-32b` for a model

Brightness encodes state, per row:

| State | Name | Preview | Extra |
|---|---|---|---|
| Needs you (permission pending / question asked) | `--cc-fg` | `--cc-fg` | 10px `--cc-fg` dot on the avatar's bottom-right, 2px `--cc-bg2` ring |
| Unread | `--cc-fg` | `--cc-dim` | count pill on line 3: `--cc-fg` bg, `--cc-bg` text, 14px tall |
| Working, nothing needed | `--cc-dim` | `--cc-muted` | — |
| Idle / done | `--cc-dim` | `--cc-muted` | — |
| Archived | inherit | inherit | wrapper `opacity:.6` |

Selected row: `--cc-elev` fill, no border, no left bar.

Avatars are **user-defined** — emoji, glyph, or an uploaded image, plus a neutral tint choice. Persist per conversation. The user's own avatar comes from Settings ▸ Profile and appears on every message they send. Default an agent's avatar from the repo name's first glyph if unset; never auto-assign a colour.

Footer 34px: "Prompt library" + `Ctrl+K`.

---

## 5. Transcript header — 52px

30×30 avatar · name (sans 12.5 semibold) · subtitle 10px `--cc-muted`: `claude-cockpit · main · edits files, asks first` (agent) or `local · qwen2.5-coder-32b · talks only` (model). Right: search, artifacts-panel toggle (active = `--cc-elev` + `--cc-fg`), `⋯`.

**The model selector is not in the header.** It lives in the composer (§7).

---

## 6. Transcript body

`gap:18px`, `padding:16px 26px 0`. Day dividers are a centred 9.5px uppercase label between two `--cc-line` hairlines.

### User message
Indented `padding-left:60px`, 12px gap, 32px round avatar on the **right**. Block: `--cc-surface`, 1px `--cc-border`, radius 10, padding 11/14. Attachment chips row first (24px tall, `--cc-border` outline, icon + name), prose below.

### Assistant message
32px avatar at radius 9 in the **left** gutter, content full width, **no background**. `gap:10px` between prose, tool strip, and code blocks.

### Tool-call strip
One bordered group, radius 8, `--cc-line` border, rows 28px, divided by `--cc-line`. Per row: 4px status dot (`--cc-dim` done, `--cc-fg` if it produced an artifact), verb, targets, spacer, duration or `artifact →`. Collapsed by default; expanding reveals the raw call. Reads as a quiet log, never as a set of coloured cards.

### Code block
Radius 8, `--cc-border`, max-width 620. Header 28px: language label, filename, spacer, copy / pin / **maximize** icons at 12px `--cc-muted`. Body `--cc-term`, mono 11.5/1.7. Two-tone syntax only: identifiers `--cc-fg`, keywords `--cc-muted`, everything else `--cc-dim`.

### Permission gate — the most important component here
`--cc-surface`, 1px `--cc-border`, plus **`border-left:2px solid --cc-fg`**. No amber, no glow, no pulse.

Contents in order: shield icon + `PERMISSION NEEDED` (10px, `--cc-fg`) + elapsed hold time · the exact command in a `--cc-term` inset with an edit pencil · one plain sentence naming what it touches · actions.

Actions: **Allow once** (`--cc-fg` fill, `--cc-bg` text, `↵`) · **Always for this chat** (outline) · spacer · **Deny** (outline). Deny opens a one-line reason field that is sent back to the agent as the tool result.

Rules: the gate blocks the turn; it always steals focus; `↵` allows, `Esc` denies; **voice mode is suspended while a gate is open** and resumes after the click. "Always for this chat" is scoped to the conversation and to that exact command shape, and is listed/revocable in the `⋯` menu.

### Streaming message
Same as an assistant message, avatar at `opacity:.5`, text `--cc-muted`, trailing 7×15px `--cc-dim` block caret. Auto-scroll to bottom only when the user is already within ~40px of the bottom.

---

## 7. Composer

Status row above the box, 22px, 10px text:
`generating · 38 tok/s` · **Interrupt** pill (`Esc`) · **Steer without stopping** pill · spacer · `context ▁▁▁ 34.2k / 200k` with a 70×4 `--cc-elev` track and a `--cc-dim` fill.

Only two engine facts are allowed in Chat: **context remaining** and **tok/s**. No spill, no queue depth, no lane class, no cost-per-token. (Cost appears once, in the retry-with menu, because that is a decision.)

Box: radius 12, `--cc-surface`, `--cc-border`.

1. Attachment chip row, 25px chips with an `×`
2. Text area, sans 14/1.6, min-height 36
3. Bottom bar 44px: `@` · paperclip · image · `/` icons (26px, `--cc-dim`) — spacer — **model selector** — **Hold to talk** — **send** (30px circle, `--cc-fg` fill, `--cc-bg` arrow)

**Model selector** sits immediately left of Hold to talk: a 28px outlined control reading `Sonnet 4.5 │ Ask ⌃`, opening upward. It carries the model *and* the permission mode, because those are the two things you change per-message. Switching mid-conversation is allowed and is recorded as a system line in the transcript.

`@` opens a fuzzy picker over the session's working dir — files, folders, and symbols, each showing an estimated token cost; folders warn above ~20k. `/` opens commands and the user's saved prompts in one list. Paste inserts images; drag-drop anywhere over the transcript shows a dashed drop zone and copies out-of-repo files into `.cockpit/attachments/`. Terminal output and other conversations' transcripts attach as chips too. See 5b.

### Voice
Hands-free. Push-to-talk on hold, latch on click. Loop: **listening** (live interim transcript, silence 1.5s arms a countdown ring, speaking again cancels it) → **sent** → **speaking back** (progress bar, "Talk over it" barge-in, code blocks are never read aloud — the TTS says "see artifact 3" instead) → back to listening. Transcription is local; nothing leaves the machine. Permission gates always break the loop. `Esc` ends voice. See 5c — implement its behaviour with 6a's palette.

---

## 8. Artifacts rail

Header 52px: "Artifacts", count, then **maximize** / **download** / collapse icons.

Cards: radius 9, 1px `--cc-border`, padding 10/11, `margin-bottom:8px`. Anatomy:

1. Type icon + type label in that type's tone (§1) — spacer — **maximize** + **download**, 12px, `--cc-muted`
2. Title (path, command, or filename), 11.5px
3. Meta, 10px `--cc-muted` — `+18 −4 · just now`, `41 passed · 2 failed · 3.4s`, `pasted · 1440×620`
4. Actions, only on the newest/actionable card: **Review** (`--cc-fg` fill) + **Revert** (outline)

Only the active card gets `--cc-surface`; the rest are transparent with a border.

Five types: **DIFF** (a file edit — Review / Revert), **RUN** (a command and its output), **SNIPPET** (pinned code — Copy / Re-run), **CHART** (bars in `--cc-a-chart`, peak at full brightness), **IMAGE** (38×28 thumb with a `--cc-a-image` hairline).

Footer: "Download all" · "Open folder".

**Every artifact is maximizable and downloadable — no exceptions.** Icons are `i-maximize` (corner brackets) and `i-download` (arrow into tray). Do not use a floppy glyph for download or a mirror glyph for expand.

---

## 9. Artifact full screen — 6b

Overlay, 840×520 at reference size, scaling to the window.

Header 46px: back chevron · title · meta · view toggle **Split / Unified / Whole file** · **Download** (with a text label) · maximize · close.

Body: 168px artifact list on the left (`↑↓` steps through all 12, current row `--cc-elev`, each row's icon in its type tone) and the payload filling the rest. Diffs render side-by-side with line numbers and the two-tone gutter treatment.

Footer 46px: **Keep** (`--cc-fg` fill) · **Revert on disk** · **Open in editor** · spacer · a hint that Download offers the patch, the file, or both.

Download behaviour per type: DIFF → `.patch` or the file; RUN → `.txt` of the full output; SNIPPET → the file with the right extension; CHART → PNG or the underlying CSV; IMAGE → the original.

---

## 10. Message actions

Hover toolbar floats at a message's top-right: 3px-padded `--cc-elev` group, 28×26 buttons — copy · edit · **re-run** · fork · read aloud · pin · `⋯`.

**Edit & re-run** turns the message into an editable field and shows the consequence before committing: *"Re-running discards 6 later messages and 2 artifacts. The file edits already on disk stay."* with a **Fork instead** escape. Never destroy history silently.

**Retry with…** lists models with the fact that decides the choice — `current`, `~$0.28`, `48 t/s · free`, `not loaded`. Answers land side by side so the user keeps the better one.

**Fork** copies everything above into a new chat and offers three destinations: same session new thread · new git worktree on a branch · open as a Workspace pane.

**Pin** promotes a message into persistent context; pinned items are listed and removable from the `⋯` menu and count against the context meter.

---

## 11. Keyboard

```
Ctrl+K        command palette / prompt library
↵             send · allow a pending permission
Shift+↵       newline
Esc           interrupt generation · deny a permission · end voice
@ / /         file picker · command palette (from an empty-ish composer)
Ctrl+↑/↓      previous / next conversation
⌘/Ctrl+F      search within this conversation
↑↓            step artifacts (when the full-screen view is open)
Space         hold-to-talk (when the composer is not focused)
```

---

## 12. Data shapes

```ts
type Conversation = {
  id: string
  title: string
  avatar: { kind: 'emoji' | 'glyph' | 'image'; value: string; tint?: string }
  counterpart:
    | { kind: 'agent'; repo: string; branch: string; cwd: string; permissionMode: 'ask' | 'auto' | 'plan' }
    | { kind: 'model'; provider: 'lmstudio' | 'vllm' | 'ollama'; model: string }
  model: string                  // may differ from counterpart.model after a mid-chat swap
  pinned: boolean
  archived: boolean
  attention: 'none' | 'unread' | 'needs_you'
  unreadCount: number
  lastMessagePreview: string
  updatedAt: string
  contextUsed: number
  contextLimit: number
}

type Message = {
  id: string
  role: 'user' | 'assistant' | 'system'
  createdAt: string
  blocks: Block[]
  attachments?: Attachment[]
  pinned?: boolean
  editedFrom?: string
}

type Block =
  | { kind: 'prose'; markdown: string }
  | { kind: 'code'; language: string; filename?: string; source: string }
  | { kind: 'tools'; calls: ToolCall[] }
  | { kind: 'permission'; request: PermissionRequest }

type ToolCall = {
  id: string; verb: string; targets: string[]
  durationMs?: number; artifactId?: string
  status: 'running' | 'ok' | 'error'
}

type PermissionRequest = {
  id: string
  command: string
  rationale: string
  touches: string[]
  askedAt: string
  resolution?: { decision: 'once' | 'always' | 'deny'; reason?: string }
}

type Artifact = {
  id: string
  type: 'diff' | 'run' | 'snippet' | 'chart' | 'image'
  title: string
  meta: string
  messageId: string
  createdAt: string
  pinned: boolean
  payload: unknown            // patch text, output text, source, series, or a file ref
  reverted?: boolean
  staged?: boolean
}

type Attachment = {
  kind: 'file' | 'folder' | 'image' | 'terminal' | 'transcript'
  label: string
  path?: string
  estimatedTokens?: number
}
```

Streaming: token deltas, tool-call lifecycle, artifact creation, and permission requests all arrive on one ordered event stream per conversation so the transcript never has to reconcile out-of-order state.

---

## 13. Build order

1. Shell — four columns, collapsible rails, nav rail with Chat active.
2. Conversation list with the five brightness states. Static fixtures.
3. Transcript with user / assistant / prose / code blocks. Get the sans-vs-mono split and the 620px measure right before anything else.
4. Composer, including the bottom-bar model selector. Send a real message.
5. Streaming — deltas, caret, auto-scroll rule, Interrupt.
6. Tool strip and artifacts rail, with maximize + download stubbed.
7. **Permission gate.** Full loop including deny-with-reason and "always for this chat" scoping.
8. Artifact full screen (6b) and real downloads per type.
9. Message actions — edit & re-run with its consequence warning, retry-with, fork.
10. `@` and `/` pickers, attachments, drag-drop, paste.
11. Voice, last. Its state machine depends on 7 (gates suspend it) and 5 (barge-in interrupts).
12. Agent registration / new-chat flow with avatar and name (see 5f).

---

## 14. Non-goals

No spill, queue-depth, lane, or shadow-mode language anywhere in Chat — that lives in Engine and Settings. No message reactions. No threading inside a conversation (fork instead). No group chats. No hue beyond the five artifact tones. No cost readout except in the retry-with menu.
