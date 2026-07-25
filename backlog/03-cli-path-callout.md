# Backlog 03 — Claude CLI path variable callout

**Status: DONE (uncommitted, on `feat/local-broker-panel`, 2026-07-25).**
Backend fix `9ecfafa` reconciled by hand (3-way apply failed on the dirty shared
tree; hunks are non-overlapping so applied via edits): `resolve_claude_cli()` +
`ClaudeCliNotFound` + `.local\bin` PATH seed in `pty_manager.py`; `ClaudeCliNotFound`
handler in `server.py` surfaces the full actionable message; README troubleshooting
rewritten. UI callout added to `NewSessionDialog.jsx` footer naming `CLAUDE_CLI_PATH`.
The three "places" now: spawn-failure error toast (full message via `App.jsx`
`data.error`), the NewSessionDialog footer hint, and the README. Note: the diff of
`9ecfafa` did NOT touch LocalBrokerView/LocalMetricsPanel — the backlog's collision
worry was stale. Gate: backend 407 pass, eslint 0 errors. (The 3 failing
`LocalBrokerView` tests are the Phase B W6 in-flight work, not this change.)

## The ask (owner)
"There is no call-out for the Claude CLI Path variable here, so we need that in a few places."
When Cockpit can't find the `claude` CLI, the failure is currently opaque. Surface the
CLI path (env var / configured path) in a few visible places + give actionable errors.

## Existing work to reconcile FIRST
Branch `claude/claude-cli-error-15c2ec @ 9ecfafa` — "fix: robust claude CLI discovery
with actionable errors". This is a rescued worktree branch, **off master**, and it
**touches the same 2 files** as `feat/local-broker-panel` (LocalBrokerView.jsx,
LocalMetricsPanel.jsx per the orphan's status). Decide: cherry-pick / merge / rebuild
on top of the current branch. Diff it before doing anything:
`git log -p claude/claude-cli-error-15c2ec -1` and `git diff feat/local-broker-panel..claude/claude-cli-error-15c2ec`.

## Places to surface the CLI path (candidates — confirm against the fix)
- Session spawn error path in `pty_manager.py` (where `claude --model` is launched).
- A visible settings/status line in the UI (Connection card? Onboarding? StatusBar?).
- `NewSessionDialog` pre-flight when no CLI is found.

## Note
The env/path discovery logic lives in `pty_manager.py`. Keep the actionable-error
wording from `9ecfafa` — that was the point of the fix.
