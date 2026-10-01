---
name: plexar-studio-workers
description: "Spawn, prompt, watch and close worker sessions as visible Plexar Studio panes. Use only when the user asks to fan work out to Studio workers / sub-sessions, or names this skill. Requires PLEXAR_STUDIO_TOKEN (set only inside a Studio pane)."
---

# Plexar Studio workers

You are running inside a Plexar Studio pane. You can start **workers**: real Claude Code
(or Codex) sessions that appear in Studio's sidebar nested under your session
("Session 3" → "Session 3.1", "3.2", …). The user can click one to watch it, type into
it, or take it over. Use this instead of hidden subagents when the user wants to SEE the
work.

Check first, and stop if it fails:

```bash
test -n "${PLEXAR_STUDIO_TOKEN:-}" && test -n "${PLEXAR_STUDIO_URL:-}"
```

Every call sends your token. Define this once per shell:

```bash
S() { curl -sS -H "X-Plexar-Session-Token: $PLEXAR_STUDIO_TOKEN" -H "Content-Type: application/json" "$@"; }
```

## Rules (enforced by Studio, not advisory)

- Workers cannot spawn workers. Depth is 1.
- At most 8 live workers per session.
- A worker inherits your permission mode and never gets more. If you do not bypass
  permissions, neither does it.
- You can only see, prompt, read and close YOUR workers.

## Spawn

```bash
S -X POST "$PLEXAR_STUDIO_URL/api/agent/spawn" -d '{"name":"reviewer","prompt":"Review the diff on this branch and list only actionable findings."}'
```

Optional fields: `name` (default `<your name>.<n>`), `prompt` (delivered once the
worker's CLI is ready), `cwd` (default: yours), `harness` (`claude-code` | `codex`),
`model`, `effort`. Answer: `{"worker": {"id", "name", "state", ...}, "prompt_queued"}`.
Put JSON in a file and use `-d @file.json` for long prompts.

## Prompt, wait, read

Workers are addressed by id or by exact name.

```bash
S -X POST "$PLEXAR_STUDIO_URL/api/agent/reviewer/prompt" -d '{"text":"Now check the tests too."}'
S "$PLEXAR_STUDIO_URL/api/agent/reviewer/wait?until=settled&timeout_ms=600000"
S "$PLEXAR_STUDIO_URL/api/agent/reviewer/read?lines=80"
```

- `wait` returns `{"state", "timed_out", "saw_activity"}`. `settled` means idle OR
  waiting, after it saw the worker start; `until=waiting` and `until=idle` also exist.
- `state: "waiting"` means the worker is blocked on a question or an approval. **Do not
  answer it yourself.** Read it, then tell the user which worker needs them. Prompting a
  waiting worker is refused with 409.
- `read` returns `latest_assistant` (the clean last answer, Claude Code workers) and
  `screen` (ANSI-stripped output tail, approximate for a full-screen TUI). Prefer
  `latest_assistant`.
- A timed-out wait proves nothing about delivery. Read before you re-prompt.

## List and close

```bash
S "$PLEXAR_STUDIO_URL/api/agent/children"
S -X DELETE "$PLEXAR_STUDIO_URL/api/agent/reviewer"
```

Close workers you no longer need. They count against the user's session limit.
