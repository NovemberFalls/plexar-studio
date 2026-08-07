# Plexar Studio 2.0.0 — launch copy

Drafts for the 2.0.0 announcement. Written 2026-08-07, unposted.
Release: https://github.com/NovemberFalls/plexar-studio/releases/tag/v2.0.0

**Before posting, see "Things to fix first" at the bottom.** Two claims in the
README are wrong and one of them will be the first thing a commenter checks.

---

## Reddit — r/ClaudeAI

Longer form. Reddit rewards a builder talking plainly about their own thing and
punishes anything that reads like a press release, so this leads with the
mechanics and puts the link at the end.

**Title:**

> I built a multi-session manager for Claude Code — 8 terminals in one window, sessions that can hand work to each other. Open source, v2.0 just shipped.

**Body:**

I use Claude Code all day and kept ending up with six terminal tabs, no idea
which one was waiting on me, and no sense of what any of it was costing. So I
built the thing I wanted. It's called Plexar Studio, it's AGPL-3.0, and 2.0
went out today.

The design bet is **depth over width**. It is not a generic "AI IDE" — it is a
manager for Claude Code specifically, and almost every feature exists because
running several sessions at once has problems that running one doesn't:

- **Up to 8 sessions in a grid**, 1/2/3/5/7-pane layouts, drag panes to rearrange.
  Each session remembers its working directory and shows live git branch + dirty
  state.
- **Live state per pane** — idle / busy / waiting-on-you, parsed off the terminal
  stream. The point is knowing at a glance which of the six needs you.
- **Sessions can talk to each other.** Relay one session's last reply into
  another, or start an autonomous loop between two, or a "channel" with one lead
  and N workers. It waits for the receiving session to be idle and for you to
  stop typing before it injects anything, which took considerably more care than
  I expected.
- **Cost and token tracking** per session, per model, per tool. Prices are
  snapshotted daily and cost is frozen at ingest — history never silently
  re-prices when a model's rate changes. Spend caps can warn or block, and they
  refuse to hard-block on a number the app isn't confident in.
- **Provider layer is open.** Claude Code is the focus, but the backend isn't
  locked to one endpoint — you can pair a local engine (vLLM, LM Studio) or
  OpenRouter alongside it and pick per session. Claude Code is model-agnostic
  under the hood; Studio just makes the swap a dropdown.
- Desktop app for Windows (Tauri), or run it from source on macOS/Linux.

**On the rebrand:** it used to be Claude Cockpit. It's now Plexar Studio —
partly because "Claude X" is a name I don't have any business squatting on, and
partly because the provider work made it not-only-Claude.

**On why 2.0 and not 2.x**, since I think this is the more interesting story:
the desktop window is a thin webview over the app's own local server, which
means the UI you see is the copy frozen into the server binary, not the one
sitting in the build folder. For two releases my build ran those two steps in
the wrong order, so the app shipped the *previous* version's interface while
every version check I had passed — because all of them were checking things
that genuinely did agree. The only symptom was a version number in the corner
disagreeing with the one the server reported, and the corner was right.

So 2.0 is the first build in a while where the interface is actually the
current one. There's now a check that pulls the bundle back out of the binary
and compares bytes, because a timestamp check would have gone green on exactly
the broken build.

Also in 2.0: the local server used to authenticate none of its routes, on the
theory that binding to loopback was enough. It isn't — any page you visit can
reach a loopback port. There's now an origin guard on every route and on the
terminal WebSocket.

Happy to answer anything. Bug reports and PRs welcome; I'm still fairly new to
running an open-source project, so be gentle about the process stuff.

Repo + Windows installer: https://github.com/NovemberFalls/plexar-studio

---

## X / Twitter

### Option A — single post

> Plexar Studio 2.0 is out. Open-source (AGPL) multi-session manager for Claude
> Code: 8 terminals in one window, live idle/busy state per pane, sessions that
> can hand work to each other, real cost tracking.
>
> Focused on Claude Code — but the provider layer is open, so a local vLLM or LM
> Studio engine can sit beside it.
>
> https://github.com/NovemberFalls/plexar-studio

### Option B — thread (better reach; the bug story is the hook)

**1/**
> Shipped Plexar Studio 2.0 today — open-source manager for running many Claude
> Code sessions at once.
>
> It's 2.0 because of a bug that's worth describing, since I suspect other
> people ship it without knowing. 🧵

**2/**
> The desktop window is a thin webview over the app's own local server. So the
> UI a user sees is the copy frozen into the *server binary* — not the one in
> the build folder.
>
> Build those two steps in the wrong order and you ship last release's
> interface.

**3/**
> Which I did. Twice.
>
> Every version check passed. They compared the manifest, the lockfiles, the
> build folder — all of which genuinely agreed on the new version. None of them
> was the bundle that actually gets served.

**4/**
> The only symptom: a version number in the corner disagreeing with the one the
> server reported.
>
> The corner was right.

**5/**
> Fix is a check that pulls the bundle back out of the binary and compares
> bytes.
>
> Not timestamps — rebuilding the binary makes it *newer* than the build folder
> while still carrying stale contents. A timestamp check goes green on exactly
> the broken build.

**6/**
> Anyway: 2.0 is the first build in a while where the interface is the current
> one.
>
> 8 sessions in a grid, live idle/busy per pane, sessions that relay work to
> each other, per-model cost tracking, open provider layer for local engines.
>
> https://github.com/NovemberFalls/plexar-studio

---

## Things to fix first

1. **The README says "20 themes". There are 2.** Both dark (`va-night`,
   `cockpit-blue`); `themeData.test.js` has always asserted exactly 2. A
   commenter will open the repo and count. Fix the README before posting — I
   kept the claim out of both drafts.
2. **The README's demo video and screenshot links point at the old
   `claude-cockpit` repo and a v1.3.3 asset.** GitHub redirects renamed repos so
   they resolve, but the launch post is the wrong moment for a viewer to land on
   the old name. Worth re-pointing at `plexar-studio`, and the demo is many
   versions stale regardless — it's a good thing to replace with the new video.
3. **The README still leads with the removed Orchestrator Mode**, which is the
   second thing a visitor reads. That was current context in 1.1.0; today it
   spends the top of the page explaining an absence.

## Notes for the video

The two things that don't come across in text and would land on camera:

- Six panes, and the state dots changing as sessions go idle → busy → waiting.
  Static screenshots can't show the thing the app is actually for.
- A bridge running: one session finishing a reply and it appearing in another's
  prompt without you touching anything. This is the feature people won't believe
  from a bullet point.

Worth saying out loud on camera that it's Claude Code underneath and Studio
doesn't wrap or intercept the model — people assume a manager like this is a
proxy, and it isn't.
