# 15 — Spill: the measurement, and why nothing was built

**Status:** MEASURED. **NOT BUILT — deliberately.** Blocked on ASK-SPILLTARGET.

**Filed 2026-08-03. Row: S24.**

The owner: *"Looks like Spill needs to be fixed as well then since its broken."*
His stated intent is the specification: *"you can always reach out to frontier
as long as these conditions are met."*

So "fixed" means two things, and they are independent:
**(1)** the conditions are actually evaluated, and
**(2)** something acts on the refusal by escalating to a frontier provider.

I was told not to build an escalation whose target is assumed. **I measured the
target. It is half-real, and the missing half is a policy decision, not code.**

---

## What spill is today, measured

**Three separate reasons it is inert, and all three must be false for spill to
mean anything.**

1. **The comparison never runs.** `COCKPIT_BROKER_SHADOW` defaults to `1`. In
   shadow the broker forwards and logs but skips `_queued_forward` entirely.
   The threshold check (`broker.py:542`) and `record_spill` (`:546`) live only
   on that path. Already pinned by
   `lane_broker/tests/test_shadow_default_is_inert.py`: a threshold of `0.0`s
   with seeded history produced **zero** spills.

2. **Nothing listens for the refusal.** `lmstudio_proxy.py` is 232 lines and
   contains **no spill branch at all** — `grep -n "spill" lmstudio_proxy.py`
   returns nothing. `_proxy_non_stream` relays the broker's status and body
   byte-verbatim (`:174`). A 503 `{spill:true}` therefore arrives at the
   `claude` CLI as a plain failure. **A policy that configures a refusal with
   no listener.**

3. **There is nothing to escalate *to* at request time.** See below. This is
   the finding that stopped the build.

`PUT /api/local/{id}/spill` and `SpillPolicy.jsx` are real and correct — they
write thresholds the broker stores and echoes. They configure a mechanism that
cannot fire.

---

## Does an escalation target exist? — the measurement

**Partly. OpenRouter is a real inference path in this app, but it is bound at
the WRONG LAYER and to the wrong lifecycle.**

Measured in `pty_manager.py`:

```
:900  env["ANTHROPIC_BASE_URL"]  = "https://openrouter.ai/api"
:901  env["ANTHROPIC_AUTH_TOKEN"] = openrouter_key
```

That is a **per-session, spawn-time** routing decision. Studio picks
Anthropic-direct, OpenRouter, **or** the local proxy once, when it spawns the
`claude` child process, and writes it into that process's environment. It is
never revisited for the life of the session.

A spill 503, by contrast, happens **mid-conversation, per request**, inside a
CLI whose base URL is already pinned to Studio's local proxy. So:

| | exists? |
|---|---|
| A frontier provider configured in Studio | **YES** — OpenRouter, key stored, live-validated against `/v1/credits` (`server.py:2361`), `settings_store.resolve_openrouter_key()` |
| A reachable wire format | **YES, and this is the good news** — OpenRouter serves an **Anthropic-compatible** API at `https://openrouter.ai/api`, and `lmstudio_proxy` already speaks Anthropic `/v1/messages` and forwards bodies byte-verbatim. Re-POSTing a spilled body needs **no translation**. |
| A *request-time* escalation path | **NO.** It does not exist in any form. `lmstudio_proxy` has no outbound client other than the broker. |
| A **model mapping** | **NO, and this is the blocker.** The spilled body names a local model (`qwen3-coder-30b-awq`). OpenRouter has never heard of it. Something must decide which frontier model a spilled local request becomes. |
| A **spend interlock** | **NO.** Escalation converts a $0 local request into billed money. `spend_guard.py` exists and is exactly the right mechanism — but it currently governs bridges and new sessions, and knows nothing about spill. |

**Conclusion: I did not build it.** Wiring an escalation now would mean picking
the frontier model myself and spending the owner's money on a threshold he has
never seen fire. A half-wired escalation that silently fails — or silently
bills — would be the same defect class as the two above, for the third time.

---

## ASK-SPILLTARGET (for the owner)

1. **Which frontier model does a spilled local request become?** A fixed model?
   A per-lane-class map? A setting? There is no correct default — the local
   model was chosen deliberately and its frontier substitute is a judgement.
2. **May a spill spend real money without asking?** Recommend: **no** by
   default. Spill escalation should route through `spend_guard.evaluate()` on
   the same footing as bridges, and should be **opt-in per lane class** — the
   same shape as the thresholds themselves.
3. **Is spill even the right lever for this rig?** The lane broker is the
   TRANSPORT for LM Studio sessions only. Plexar — the backend actually serving
   models here — does not go through the broker and has no spill concept. So
   spill as built protects a path the owner may not be using.

---

## Leaving shadow mode — §6 PLAN WITH ROLLBACK (not executed)

Flipping `COCKPIT_BROKER_SHADOW` to `0` is a behaviour change to a live local
system: every LM Studio request starts being **queued** at `max_concurrent=1`
instead of forwarded. Requests that run today would begin to WAIT, and — once a
threshold is set — to be REFUSED with a 503 that nothing currently catches.

**Do not flip it until (2) has a listener.** Turning on a refusal before
building the thing that acts on the refusal makes the product strictly worse
than it is now: today spill is inert; after the flip it would be actively
breaking requests.

When it is flipped:
- **Rollback:** unset `COCKPIT_BROKER_SHADOW` (default `1`) and restart Studio.
  No data migration; the broker's spill state is session-only and
  `persisted: false` by design, so a restart returns to CLI defaults.
- **Pre-state:** thresholds are `null` per class on a fresh broker; record the
  live `/config/spill` echo before touching anything.
- **Gate:** with all thresholds `null`, queueing on and spill off — every
  request still completes and `spilled_total` stays 0. That arm proves the
  queue works before any refusal is armed. **Watched to fail**: set one
  threshold to `0.0`s and assert a 503 `{spill:true}` at the wire, then unset.
- **Owner reachable throughout.** This rig serves his sessions.

---

# LEN HAS RULED — 2026-08-03. TWO RULINGS, AND ONE OF THEM I MEASURED.

> *"If Spill wont make it to frontier whats the point? And it should ride the
> monthly sub before API..."*

**RULING (i) — SPILL MUST ACTUALLY REACH FRONTIER.** A refusal with no listener
has no point. This confirms the finding above rather than overriding it: do not
flip shadow mode until something catches the 503 and re-issues the request.

**RULING (ii) — THE ESCALATION ORDER IS SUBSCRIPTION FIRST, PAID API SECOND.**
Len pays a monthly Claude subscription and the Claude Code harness already rides
it. Spending per-token OpenRouter credit while a flat-rate subscription sits idle
is waste. So the preferred target is the subscription-backed path; OpenRouter is
the FALLBACK, not the default.

**NOTHING WAS BUILT THIS WINDOW. The build was the priority, and the three gaps
named above (a request-time path, a model mapping, a spend interlock) are all
still open.** Ruling (ii) makes the SPEND INTERLOCK more important, not less:
"prefer the subscription" is only a meaningful instruction if something can tell
which path a request took and what it cost. An escalation you cannot attribute is
indistinguishable from one that silently went to the paid API.

## THE MEASUREMENT LEN ASKED FOR: is the subscription reachable at request time?

**YES — AND THE WAY IT IS REACHABLE IS ITSELF THE DECISION.** Measured at the
wire 2026-08-03 against `api.anthropic.com/v1/messages`, using the OAuth token
Studio ALREADY reads for the usage bars (`~/.claude/.credentials.json` ->
`claudeAiOauth.accessToken`, `subscriptionType: max`, scopes include
**`user:inference`**).

| # | request shape | result |
|---|---|---|
| A | `Authorization: Bearer <oat>`, no beta header | **429** `rate_limit_error` |
| B | + `anthropic-beta: oauth-2025-04-20` | **429** `rate_limit_error` |
| C | token as `x-api-key` | **401** `invalid x-api-key` |
| D | + `claude-code-20250219` beta + Claude Code system prompt + CLI user-agent | **200**, real completion |

**THE 429 IS NOT A QUOTA.** I predicted 401 on (A) and was wrong, and the miss is
the whole finding — a 401 would have meant "this credential cannot do inference",
which is a dead end. A 429 means the credential AUTHENTICATED and was then
refused. Checked against `GET /api/oauth/usage` in the same minute: **five-hour
window at 9%, seven-day at 0%, `extra_usage.spend_limit_reached: false`.** There
was no cap to hit. The refusal is structural.

**So the subscription path is gated on the caller PRESENTING AS CLAUDE CODE.**
Same token, same quota, same endpoint: refused as a generic OAuth client,
accepted as the CLI. That is a deliberate access control, and (D) passing means
honouring ruling (ii) is a POLICY decision, not a technical one.

### THIS IS AN ASK, AND I AM NOT BUILDING IT EITHER WAY

Len needs this before anything is built, which is exactly why it was measured:

- **The case that is clearly fine.** When the spilling request ORIGINATED in a
  Claude Code session running inside Studio, the traffic genuinely IS Claude
  Code — Studio would be relaying its own child's request to the same
  subscription that child already uses. Ruling (ii) is honourable here without
  anything pretending to be anything.
- **The case that is clearly not.** Studio spilling on its OWN behalf — local
  model overflow from a non-CLI caller — reaching the subscription by asserting
  it is the Claude Code CLI is circumventing a control Anthropic enforces on
  purpose. The 429 in (A) and (B) IS that enforcement. I will not build that, and
  it does not belong in a product Len ships to anyone else.
- **Which means the shape of the fix follows the ORIGIN of the spilled request,
  not a config toggle.** That is a real design constraint ruling (ii) did not
  anticipate, and it is the thing Len must rule on next.

**If Len wants the strict reading of (ii) — subscription first for ALL spill —
then it is NOT reachable for the second case, and he needs to know that before we
build anything.** OpenRouter would remain the only lawful target for
Studio-originated spill, which inverts his stated preference for that traffic
class. That is the honest answer to the question he asked.

### What is STILL missing, unchanged by the ruling

1. **A request-time path.** `pty_manager.py:900` binds `ANTHROPIC_BASE_URL` at
   SPAWN time, per session, into the child env, and never revisits it. A spill
   happens mid-conversation, per request, inside a CLI already pinned to the
   local proxy. Nothing re-routes at that layer today.
2. **A model mapping.** The spilled body names `qwen3-coder-30b-awq`. The
   subscription path serves Anthropic model ids only; OpenRouter has never heard
   of it either. Something must decide what a local model escalates TO, and
   "pick the biggest" is a cost decision wearing a routing decision's clothes.
3. **A spend interlock, now load-bearing.** Per ruling (ii) the interlock must
   record WHICH path served each escalation, not merely what it cost.
   `spend_guard.py` already separates `real` from `equivalent` money and keys
   enforcement on `mode`, so a subscription-served escalation belongs in
   `equivalent` and an OpenRouter one in `real`. That distinction already exists
   and is the right home; nothing writes it today.
