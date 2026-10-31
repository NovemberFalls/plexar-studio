---
name: plexar-studio-workers
description: "Spawn and drive VISIBLE worker panes in Plexar Studio: Claude Code, Codex, Plexar Harness or a plain shell, optionally on their own git worktree. Use only when the user asks to fan work out to Studio workers / sub-sessions / panes, or names this skill. Requires PLEXAR_STUDIO_TOKEN (set only inside a Studio pane)."
---

# Plexar Studio workers

You are running inside a Plexar Studio pane. You can start **workers**: real sessions
that appear in Studio's sidebar nested under yours ("Session 3" → "Session 3.1", "3.2",
…). The user can click one to watch it, type into it, or take it over. Use workers
instead of hidden subagents when the user wants to SEE the work.

Check first, and stop if it fails:

```bash
test -n "${PLEXAR_STUDIO_TOKEN:-}" && test -n "${PLEXAR_STUDIO_CLI:-}"
```

Every command below is `python "$PLEXAR_STUDIO_CLI" <command>`, written here as `ps`:

```bash
ps() { python "$PLEXAR_STUDIO_CLI" "$@"; }
```

Each prints JSON. Exit codes: `0` ok · `1` refused (the error is printed) · `2` not in a
Studio pane · `3` a wait timed out, stalled, or did not match, a `clear` was not
confirmed, or an approval was denied / expired / failed / is still pending.

## Rules (enforced by Studio, not advisory)

- Workers cannot spawn workers. There is no per-session worker cap.
- A worker inherits your permission mode and never gets more.
- You control only YOUR workers. `peers` shows every other live session read-only,
  including other sessions' workers (`parent_name` says whose). To control one, `adopt`
  it: the USER approves that in the desktop. Never adopt to get around a refusal.
- A name is an address: Studio passes it to Claude Code as `--name`, which is the
  session's SendMessage name. `spawn` refuses a name another live session already has
  (409 with `live_elsewhere`): adopt that session instead of spawning a twin.
- A worker blocked on a question or approval is never prompted (`prompt` → refused).
  Read it and tell the user which worker needs them. Do not answer it yourself.

## Spawn

```bash
ps spawn --name reviewer --prompt "Review the diff on this branch; list only actionable findings."
ps spawn --harness plexar --name px --prompt "..."     # Plexar Harness on the rig
ps spawn --harness codex --model gpt-5.5 --name cx     # another harness needs --model
ps spawn --harness shell --name tests                  # a plain shell for commands
ps spawn --worktree feat/login --name impl --prompt "..."   # own git worktree + branch
```

`--harness`: `claude-code` (default: yours) · `codex` · `plexar` · `shell`.
`--worktree <branch>` creates `<repo>-worktrees/<branch>` next to the repo (a new branch
from HEAD, or the existing branch) and starts the worker there. `--prompt -` reads stdin.
Default name is `<your name>.<n>`. Workers are addressed by name or id.

## Agent workers: prompt, wait, read

```bash
ps prompt reviewer "Now check the tests too."
ps wait reviewer                       # until idle/waiting after it started working
ps wait reviewer --until waiting       # until it asks a question / approval
ps read reviewer --lines 120           # latest_assistant + screen tail
```

- `wait` → `{"state", "timed_out", "saw_activity", "stalled"}`. `stalled: true` means it
  settled without ever starting a turn: the prompt may not have landed. Read before you
  re-prompt; never blindly resend.
- `read` → `latest_assistant` (clean last answer, Claude Code workers) and `screen`
  (output tail, ANSI stripped; `--ansi` keeps colours when they are evidence). For a
  full-screen TUI the screen text is approximate; prefer `latest_assistant`.

## Shell workers: run and wait for output

```bash
ps run tests "npm test"                                  # → {"after": <mark>}
ps wait-output tests --regex "\d+ (passed|failed)" --after <mark> --timeout-ms 600000
ps read tests --lines 200
```

`run` sends one command line plus Enter. `wait-output` searches output already there
first; pass `--after` from `run` to see only what the command produced. `--match` is a
literal substring, `--regex` a Python regex.

## Keys, list, close

```bash
ps keys reviewer esc                  # also: ctrl+c, enter, up, down, tab, y, n, ...
ps list                               # your live workers
ps peers                              # the user's other sessions (read-only)
ps close reviewer
```

## Standing agents: clear, adopt, refresh yourself, events, roster

```bash
ps clear FW-QA --then-prompt "Read OPERATIONS/nodes/QA.md and boot."  # confirmed reset
ps adopt FW-World                 # asks the user; waits up to 10 min for the answer
ps self-refresh --prompt "Read HANDOFF.md and resume."   # asks the user; then END your turn
ps events --follow                # one JSON line per worker event; run it under Monitor
ps roster status --file OPERATIONS/agents.json
ps roster up --file OPERATIONS/agents.json [--only QA,DOCS] [--adopt] [--dry-run]
```

- `clear` sends `/clear` (Codex: `/new`) when the worker is idle and reports
  `confirmed: true` only if the CLI visibly reset. Unconfirmed exits `3`: read the
  worker before you brief it, because it may still hold the old context. Same pane, id,
  name and token after a clear; its SendMessage name does not change.
- `adopt` makes a peer one of your workers (prompt, keys, clear, close) once the user
  allows it. Refused for a session that has workers of its own (depth 1) and for a
  bypass session when you do not bypass. `--wait-s 0` returns the pending request at
  once; `ps approval <id> --wait-s 600` waits later.
- `self-refresh` runs AFTER your current turn ends: write your hand-off file first, file
  the request, tell the user it is waiting for their approval, and end the turn. Your
  workers stay yours (same session id), so the next you finds them in `ps list`.
- `events` reports `idle` (a turn finished), `asking` (blocked on a question/approval),
  `ended` and `gone` for your agent workers. The first call reports workers already
  blocked. Prefer `events --follow` under Monitor to sitting in `wait` on one worker.
- `roster` reads `{"agents": [...]}` rows with `name` (or `session_name`), `harness`,
  `model`, `effort`, `cwd` and `prompt` (or `boot_file`, which becomes "Read <file> and
  follow it as your standing instructions."). Also honours `legacy_names` and
  `spawn: up | on_demand | external`. Per row: `live` (yours), `live_elsewhere` (another
  session's: `--adopt` asks for it), or `down` (`up` spawns it).

Close workers you no longer need: they stay open (and use resources) until closed. Closing a
worktree worker leaves the worktree and branch on disk for the user to merge or remove.
