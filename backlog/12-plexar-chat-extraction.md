# 12 — Plexar Chat: the extraction brief

Opened 2026-08-02. **This is a build prompt for a SEPARATE product**, written
while the reasoning behind it is still fresh. Hand this to whoever stands up
`plexar-chat.boord-its.com`; it is designed to be read cold.

Companion to `backlog/11` (the product split) and `backlog/CHAT-design-6a.md`
(the visual spec). Read §C of 11 before anything here.

---

## 0. The one-paragraph version

Plexar Studio has a working Chat surface. It cannot be exposed to the internet
in its current form, and the reason is not a missing feature — it is that its
replies are produced by running the `claude` CLI on the host with the operator's
own privileges. Plexar Chat reuses the **UI and the storage shape** and replaces
the **execution model** entirely: HTTP to Plexar-LLM, no subprocess, no host
filesystem, real identity. Everything below exists to make that boundary
concrete enough that nobody accidentally rebuilds the unsafe version.

---

## 1. What may be lifted verbatim

These carry no trust assumptions and should be copied, not rewritten:

| Piece | Path (Studio) | Notes |
|---|---|---|
| Visual spec | `backlog/CHAT-design-6a.md` | 6a is the build target. 5a is reference only. |
| Four-column shell | `components/chat/ChatView.jsx` | Layout, `minHeight: 0` rule, header/composer structure. |
| Message rendering | `components/chat/ChatMessage.jsx` | **Keep the rule that HTML is never executed.** |
| Attachment chip | `components/chat/AttachmentChip.jsx` | Middle-truncation, icon fallback on image error. |
| Context meter | `components/chat/contextMeter.js` | Null-limit-draws-no-bar is the whole point; keep it. |
| Model picker + re-inject warning | `components/chat/ChatModelPicker.jsx` | Switching model re-sends the thread — say so. |
| Store schema | `chat_store.py` | `seq` ordering, verbatim content, group-delete re-parents. |
| Streak | `components/chat/ChatStreak.jsx`, `streak.js` | Pure presentation. |

Storage shape ports directly; **storage backend does not** — see §4.

---

## 2. What must NOT be lifted, and why

### `chat_runner.py` — the whole module

It spawns `claude` as a subprocess on the host. Verified live 2026-08-02: a
neutral working directory plus `--add-dir` does **not** confine the read-only
tool set. Asked for a file outside both the chat workspace and the upload dir:

```
prompt : read C:\\Code\\Personal\\claude-cockpit\\CLAUDE.md
RESULT : is_error = False
done   : "# Claude Cockpit"
```

It reads anything the host user can read. In Studio that is correct — the
operator IS the user. In a public product it is total exfiltration of the
server's disk to any visitor.

**Do not port it and disable tools.** `allow_write` / `allow_exec` already exist
in that module and default off; a flag is one config mistake, or one future
feature that forgets it, away from arbitrary execution. The separation must be
**structural** — a different code path that has no subprocess in it at all.

### `GET /api/upload/{name}`

Serves uploaded bytes back for thumbnails. In Studio it is loopback-only and
the sandbox is the whole defence. Public, it needs per-conversation ownership:
today knowing a filename is sufficient authorisation, and there is no
authorisation layer to consult. Rebuild with an ownership check, not a rename.

### Anything that assumes a single user

`localStorage`-scoped selections, the shared temp upload dir, the single SQLite
file, `settings.json`. All correct for one operator; all wrong for N visitors.

---

## 3. The execution model to build instead

```
browser ──HTTPS──> plexar-chat ──HTTP──> Plexar-LLM /v1/messages
                        │
                        └── no subprocess, no host FS, no CLI
```

- **Model access goes through Plexar-LLM only.** It already speaks Anthropic
  `/v1/messages` and OpenAI `/v1/chat/completions`, carries named keys with
  scopes, and attributes usage per identity. That is the whole reason the split
  makes sense — do not add a second path to a model from this product.
- **Tools: none, initially.** Say so in the UI rather than rendering disabled
  furniture (Studio's convention — a control that does nothing is worse than an
  absent one, because the user spends time deciding whether they did it wrong).
- **If tools are ever wanted, that is a sandbox project**, not a chat feature:
  container-per-session or an upload-scoped virtual filesystem. Scope it
  separately and do not let the UI's similarity to Studio disguise the size.
- **Attachments** may be stored and shown, and their *contents* passed into the
  prompt. They must never become a filesystem path handed to a tool — that is
  the Studio pattern and it only works because Studio trusts its operator.

---

## 4. What Plexar Chat needs that neither product has

1. **Identity.** Plexar-LLM has `/api/me`, scopes and named keys — reuse rather
   than invent. Google auth is the chosen direction and is already the blocker
   for the DNS rename, so it lands first anyway.
2. **Multi-tenant storage.** Every `chat_store` query grows an owner. A single
   SQLite file with no owner column is the current shape; that is a schema
   decision to make once, at the start.
3. **Quotas and rate limits.** `backlog/11 §D`. **The sequencing risk called
   out by the Plexar side, recorded verbatim because it is right:** the tunnel
   is what makes anything public, and it goes up before quotas exist. Access is
   then the only thing between a visitor and holding the only GPU indefinitely.
   Acceptable as a deliberate interim; not acceptable as an unnoticed one.
4. **Per-model permission.** A key reaching `/v1/*` currently reaches every
   model on the card, speech models included once they land.

---

## 5. Hard rules — carried from Studio, non-negotiable

These are house style and they are what make the surface trustworthy:

- **A limit we do not know is `null`, and null draws NO BAR.** Never invent a
  denominator; the most reassuring reading must not be the one shown when we
  understand least.
- **An empty state always carries its reason.** "No voices" and "voicepack not
  downloaded" are different claims with different fixes.
- **`unreachable` ≠ `zero`. `401` ≠ `403`.** Collapsing either sends the user
  to fix the wrong thing.
- **A sent message renders from what the SERVER returned**, never optimistic
  local state — the store owns `seq`.
- **A 413 keeps the user's text in the composer**, because nothing was saved.
- **Send-and-reply is ONE call.** Split across two, a failure between them
  leaves a message saved with nothing answering it, and the UI cannot tell that
  apart from a slow model.
- **Never render HTML from a message as markup.**

---

## 6. Known traps, already paid for

Every one of these cost real debugging time in Studio. Do not rediscover them.

- **`--allowedTools` is variadic** — a positional prompt after it is swallowed
  as another tool name. Prompt goes on stdin. (Only relevant if a sandboxed
  CLI ever returns; noted so the lesson is not lost.)
- **`--include-partial-messages` emits deltas AND the complete message.**
  Accumulating both doubles every reply verbatim.
- **`asyncio` `StreamReader` caps lines at 64 KiB** and stream-json is one
  event per line — a tool result carrying a file kills the read. Raise the
  limit explicitly.
- **Context in flight is `input + cache_read + cache_creation`.** Measured on a
  real turn: `input_tokens: 2` while `cache_read: 20592`. Reading input alone
  reports an almost-empty meter on a conversation about to overflow.
- **The harness preamble is ~11 265 tokens** (engine-measured, not chars/4 —
  that heuristic overstated it by 2.6×). Irrelevant to a pure-HTTP product, but
  it is why a 12 288-token local model cannot hold a turn.
- **Escape sequences in source get mangled by tooling.** Studio builds the SSE
  terminator from `chr(10)` / `String.fromCharCode(10)` for this reason.

---

## 7. Open questions for the owner

- Does Plexar Chat need file context at all? If yes, sandbox project (§3).
- Is it invite-only indefinitely, or is self-service signup a goal? Changes the
  answer to §4.1 and §4.3 substantially.
- Does it share a database with Studio, or is it fully separate? Recommended:
  **fully separate.** Shared storage is a shared blast radius, and the trust
  models differ.
- Where does the "console to administer all of this" live (owner, 2026-08-02)?
  It is a **fourth** surface — different audience and trust model from Studio,
  Chat and the Engine — and should not be absorbed into Studio by default.
