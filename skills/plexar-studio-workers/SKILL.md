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
Studio pane · `3` a wait timed out, stalled, or did not match.

## Rules (enforced by Studio, not advisory)

- Workers cannot spawn workers. At most 8 live workers per session.
- A worker inherits your permission mode and never gets more.
- You control only YOUR workers. `peers` shows the user's other sessions read-only.
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

Close workers you no longer need: they count against the user's session limit. Closing a
worktree worker leaves the worktree and branch on disk for the user to merge or remove.
