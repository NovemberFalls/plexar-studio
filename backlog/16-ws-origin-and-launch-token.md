# 16 — The WebSocket has no Origin check, and `bypassPermissions` is settable over the wire

**Status:** PLAN WITH ROLLBACK. **NOTHING IS APPLIED.** No production file is modified by
this row. `server.py`, `pty_manager.py` and every runtime path are untouched.
**Auth-touching work is destructive-interlock work: Len approves it, not the lane and not
the coordinator.**

**Lane:** PLEXAR-STUDIO · branch `lane/studio` · **row S14** (new; C-form, gate below).
**Against:** Studio **1.31.0**, verified RUNNING on `127.0.0.1:8420` while this was
written (`/api/version` → `{"app":"1.31.0","cli":"2.1.221"}`, `/health` → 3 live
sessions, uptime 4036s).

---

## 1 · The finding: CONFIRMED, with three corrections and one escalation

The coordinator's transcription was re-verified line by line at source rather than
restated (R5 — consumers restating instead of reading is this program's recurring
defect). **Every line the coordinator quoted is correct.** Verified:

| Claim | Verdict | Evidence |
|---|---|---|
| `POST /api/terminals` at `server.py` ~898-940 | **CORRECT** | decorator `server.py:899`, handler `:900` |
| `body = await request.json()` ignores Content-Type | **CORRECT** | `server.py:902` |
| `workdir = body.get("workdir", str(Path.cwd()))` | **CORRECT**, verbatim | `server.py:904` |
| `bypass_permissions = body.get("bypassPermissions", False)` | **CORRECT**, verbatim | `server.py:910` |
| `pty_manager.py:982 effective_bypass = bypass_permissions or permission_mode == "bypassPermissions"` | **CORRECT**, verbatim | `pty_manager.py:982` |
| `pty_manager.py:984 cmd += " --dangerously-skip-permissions"` | **CORRECT**, verbatim | `pty_manager.py:983-984` |
| WS route at `server.py` ~1257 | **CORRECT** | `server.py:1257` |
| `session = get_terminal(...)` then `await websocket.accept()`, no Origin check, no token | **CORRECT** | `server.py:1260-1261` |
| `grep -c "Origin" server.py -> 0` | **CORRECT** | 0 case-sensitive. Case-**in**sensitive gives 4: `:239` a comment, `:242` `allow_origins=[...]`, `:522`/`:534` unrelated prose about serving uploads. **None is a check.** |

**PROVED AT THE WIRE, read-only, changing nothing** (both probes were chosen so the
handler cannot mutate state):

```
POST /api/terminals/zzzzzzzz/input   Content-Type: text/plain   Origin: https://evil.example
  -> 404 {"error":"Terminal not found or dead"}
     A 404 means the handler RAN and performed the lookup. There is no origin gate in front of it.

GET /ws/terminal/deadbeef  (raw handshake, nonexistent id)
  Origin: https://evil.example -> HTTP/1.1 101 Switching Protocols
  Origin: (absent)             -> HTTP/1.1 101 Switching Protocols
  Origin: null                 -> HTTP/1.1 101 Switching Protocols
```

The upgrade **completes** in all three cases; the `4004` close arrives afterwards as a
WebSocket frame. There is no Origin check to fail.

### Correction 1 — "enumerates/guesses the terminal id" is the weak link, and the chain does not need it

`pty_manager.py:691` — `terminal_id = uuid.uuid4().hex[:8]`. **32 bits from a CSPRNG.**
The attacker's blind `POST /api/terminals` succeeds but the *response is unreadable*
(CORS), so the id must be found some other way. The WS gives a clean, free, readable
oracle — `101` then close `4004` for a miss, `101` and silence for a hit, and a page may
read a cross-origin WebSocket's close code because WebSockets are not subject to CORS at
all. But 2^32 with a browser's per-host handshake cap is **days, not a drive-by.**

**So the chain as written overclaims one link — and it does not matter, because there is a
shorter path the audit did not name.**

### Correction 2 (ESCALATION) — DNS rebinding removes the guess entirely, and defeats an Origin-vs-Host equality check

`_LOOPBACK_HOSTS` exists at `server.py:6272` and is consulted **only** at `:6285`, to
decide the bind. **No request path anywhere validates the `Host` header.** Verified by
enumeration: `add_middleware` appears exactly once in the whole file (`:240`, CORS), and
`app.middleware` appears zero times.

Under DNS rebinding — attacker domain resolves to their IP, then re-resolves to
`127.0.0.1` — the browser considers the request **same-origin**, so CORS does not apply
at all. The page then **reads** `GET /api/terminals` and gets the ids, the workdirs and
`bypass_permissions` verbatim. The 32-bit guess disappears.

**This is why fix (a) cannot be `Origin == Host`.** Under rebinding, `Origin:
http://evil.example` and `Host: evil.example` are *equal* and an equality check passes.
`csrf.py`'s primary rule is Origin-vs-Host by design (its docstring, lines 44-49) and is
right for its own threat model; **it is not sufficient here, and the difference is stated
in §2 rather than inherited.**

### Correction 3 — a spawn is not required; hijacking an existing terminal is strictly easier

`server.py:1277-1278` implements "latest connection wins" (`session.active_consumer`).
A second WebSocket to a **live** terminal id supersedes the real pane's forwarder. So the
attacker does not need to spawn anything: they take over a terminal Len is already using
— one that, measured live right now, already carries `bypass_permissions: true`.

### What the correction does NOT change

**Loopback is not a trust boundary against a browser.** That framing is exactly right and
is the load-bearing sentence of the whole finding. The corrections make the chain *shorter
and worse*, not longer.

---

## 2 · Blast radius, by enumeration (an inventory produced by grep is a claim — NOTE-45)

Routes were enumerated by parsing every `@app.*` / `@router.*` decorator, then each POST
handler's **body-parsing mode** was classified from its signature, because that is what
decides reachability. Counts are produced by the enumeration, not estimated from it.

**Total: 104 routes.** 98 in `server.py` (65 GET, 21 POST, 7 DELETE, 3 PUT, 1 PATCH,
1 WEBSOCKET) + 6 in the mounted shim routers (`vllm_shim.py` 4, `lmstudio_proxy.py` 2).
The audit's "99" is close; the true figure is 98 in `server.py` alone and 104 with the
routers. **The coordinator's number was low by five and the discrepancy is the routers.**

### How many are unauthenticated? **104 of 104. All of them.**

There is one middleware in the process and it is CORS. There is no `Depends()` security
dependency, no `APIKeyHeader`, no `HTTPBearer`, no token, no session. `_require_provider`
(`:4830`) is a registry lookup, not auth. `GET /api/me` (`:426-429`) **hardcodes**
`{"authenticated": true, "mode": "local"}` — it asserts authentication that does not
exist.

### The subset that actually matters: state-changing AND reachable by a drive-by

CORS is not authentication, but it is *load-bearing* here, and stating so honestly
narrows the set. `DELETE`, `PUT` and `PATCH`, and any `POST` declaring a **typed** body,
require a preflight — and the preflight fails, because the origin is not in the
`allow_origins` list at `:242`. **They are protected by CORS, not by design, and they lose
that protection entirely under the rebinding path in Correction 2.**

What a plain drive-by (no rebinding) can reach is the **CORS simple request**: a `POST`
with `text/plain`, `multipart/form-data`, or no body — which is precisely why "ignores
Content-Type" is the load-bearing phrase in the coordinator's note.

**20 of the 21 `server.py` POST routes are drive-by reachable.** The one exception is
`POST /api/settings/plexar` (`:2546`), and only because it declares `body: dict`, so
FastAPI requires an `application/json` content type and the preflight fails. That is
protection **by accident of a signature**, and it is the proof that the other twenty are
not protected by anything.

| Route | line | mode | effect if triggered blind |
|---|---|---|---|
| `POST /api/terminals` | 899 | `request.json()` | **PROCESS SPAWN** — `claude --dangerously-skip-permissions` in an attacker-chosen `workdir` |
| `POST /api/terminals/{id}/input` | 884 | `request.json()` | writes arbitrary text into a live PTY |
| `POST /api/terminals/{id}/command` | 1102 | `request.json()` | injects a slash command (allowlisted prefixes — the one narrowing guard in the set) |
| `POST /api/terminals/{id}/interrupt` | 1085 | no body | ESC into any session |
| `POST /api/terminals/{id}/resize` | 1243 | `request.json()` | reshapes a live pane |
| `POST /api/bridge/manual` / `auto` / `channel` | 1586/1622/1692 | `request.json()` | **starts autonomous multi-session relays** |
| `POST /api/open-url` | 2021 | `request.json()` | opens attacker URL in the default browser (http/https only) |
| `POST /api/settings/anthropic` | 2496 | `request.json()` | **overwrites the stored Anthropic key** |
| `POST /api/settings/openrouter` | 2422 | `request.json()` | **overwrites the stored OpenRouter key** |
| `POST /api/local/{id}/endpoint` | 4977 | `request.json()` | repoints a provider (SSRF-guarded to RFC-1918/loopback — the guard holds) |
| `POST /api/local/{id}/restart` | 5684 | `request.json()` | restarts a managed vLLM container |
| `POST /api/local/{id}/models/{m}/load` / `unload` | 5606/5638 | no body | moves the GPU |
| `POST /api/upload` | 435 | multipart | writes files (extension + size capped) |
| `POST /api/settings/reveal`, `/api/logs/reveal` | 2672/2995 | no body | **spawns `explorer`** |
| `POST /api/pricing/refresh` | 5978 | no body | outbound fetch |
| `POST /api/shutdown` | 6262 | no body | **`SIGTERM`s the server** — kills every live terminal |
| `WS /ws/terminal/{id}` | 1257 | n/a | **not subject to CORS at all**: read output, write input, supersede the real pane |
| 6 shim POSTs (`/v1/messages`, `/s/{sid}/v1/messages`, `count_tokens`) | — | `request.body()` | drive the inference path, spend money |

**Process-spawning: three.** `POST /api/terminals` (`claude`), and `POST
/api/settings/reveal` + `POST /api/logs/reveal` (both `subprocess.Popen(["explorer", …])`
— argv list, never `shell=True`, and the path is server-derived, so they are noise, not
a vector). **The one that matters is `POST /api/terminals`.**

The 65 GETs are all **triggerable** blind and none is **readable** blind — until
rebinding, at which point all 65 become readable, including `GET /api/terminals` (ids,
workdirs, bypass state), `GET /api/browse` (filesystem), `GET /api/history` (**1631
sessions**, measured live) and `GET /api/terminals/{id}/output`. `GET
/api/settings/anthropic` returns only `masked` — that one is fine.

---

## 3 · Fix (a) — an Origin/Host check on the WebSocket

### What is allowed, and why

Measured, not assumed. The legitimate origins are determined by how the app is actually
served:

- `src-tauri/tauri.conf.json` → `"frontendDist": "http://localhost:8420"`. **The shipped
  desktop app navigates the webview to the server's own origin.** So production sends
  `Origin: http://localhost:8420`. The `tauri://localhost` entries in the CORS list at
  `:243-244` are vestigial — they would apply to a bundled-asset frontend, which this is
  not.
- `TerminalPane.jsx:148` → `` `${proto}//${location.host}/ws/terminal/${id}` `` — always
  same-origin with whatever served the page.
- Dev: `vite.config.js` proxies `/ws` to `ws://localhost:8420` with `changeOrigin`
  **unset** (default `false`), so the server sees `Origin: http://localhost:5174` **and**
  `Host: localhost:5174`.
- `PopoutTerminal.jsx:365-367` — when `location.hostname === "localhost"` it connects
  **directly** to `ws://localhost:8420`, bypassing the proxy. In dev that is `Origin:
  http://localhost:5174` against `Host: localhost:8420`. **This is the one legitimate
  genuinely-cross-origin caller in the codebase**, and any check that omits it breaks the
  popout in dev.

**The rule, in order:**

1. **`Host` must be a loopback name** — `127.0.0.1`, `localhost`, `::1`, `[::1]`, with or
   without `:8420`. This is the anti-rebinding clause and it is the half `csrf.py` does
   not have. A `Host` of `evil.example` is refused no matter what the Origin says.
2. **`Origin` must be present and must be in the allowlist**: `http://localhost:8420`,
   `http://127.0.0.1:8420` (bind host/port read from config, never hardcoded twice), plus
   `COCKPIT_DEV_ORIGINS` (default `http://localhost:5174,http://127.0.0.1:5174`,
   comma-separated) — the same escape hatch and the same reason as `PLEXAR_DEV_ORIGINS`:
   the Vite port drifts, and hardcoding it means the next port change is a code change.
   `localhost` and `127.0.0.1` are normalised to one string, exactly as `csrf.py:96-98`
   does; they are different strings for the same host and the popout depends on it.
3. **Anything else → refuse the upgrade BEFORE `accept()`.** Close with a distinct code
   (`4403`) and a reason naming the origin, so a broken dev setup is diagnosable and does
   not read as "terminal not found".

### Where I agree with `csrf.py`, and where I differ — deliberately

**Agree, rule 4 (same-origin, loopback names normalised):** adopted verbatim in clause 2.
**Agree, `Origin: null` is refused** (`csrf.py:118-123`) — a sandboxed iframe or `data:`
document is a *browser* origin that is definitively not ours, and treating it as absent is
the mistake. **Agree, rule 1** — this row guards one WS route, not GETs.

**DIFFER on rule 3, and this is the substantive design call.** `csrf.py:33-38` **allows an
absent `Origin`**, and its reasoning is sound *for its surface*: `/api/*` on the rig is
reached by `curl`, SDKs and bench scripts, all of which omit the header, so requiring it
"breaks every scripted caller while adding no security". Note the rule's own justification
is **who reaches this surface** — that is also how rule 2 keeps `/v1/*` out.

Apply that same test to `/ws/terminal/{id}` and it comes out the other way:

- The only client in existence is `xterm.js` in a browser (`TerminalPane.jsx`,
  `PopoutTerminal.jsx`). **Grep of `tests/` for `ws/terminal` returns zero hits** — not
  one test, script or non-browser caller connects to it.
- A browser **always** sends `Origin` on a WebSocket handshake, same-origin included.
- So on this route "absent Origin" does not mean "a legitimate script"; it means
  "not the UI".

**Therefore, for the WebSocket only, an absent Origin is REFUSED.** The coordinator's
warning is right and this is the answer to it: null/absent is not automatically safe here,
because the population of legitimate absent-Origin callers is **empty** — measured, not
assumed. If a future non-browser consumer of this route appears, it gets the launch token
(§3b), not a hole in the origin rule.

**Cost of differing, stated plainly:** anyone driving `/ws/terminal/` from a script today
breaks. Measured: nobody does.

### Scope: the WebSocket route only

This row does **not** add a CSRF middleware over `/api/*`. That is the right eventual
shape and it is a bigger blast radius (20 POST routes, 6 shim routes that SDKs reach, and
the `/shim/*` paths that the `claude` CLI itself drives via `ANTHROPIC_BASE_URL` — a rule
that catches those breaks the harness). **It is row S15, not this one.** The WS is the
route where the browser is the only client and the fix is therefore free of collateral.

---

## 4 · Fix (b) — a launch token

### Design

- **Minted** in `lifespan` startup: `secrets.token_urlsafe(32)`, held in a module global,
  **never written to disk**. Per-process by construction: a restart mints a new one.
- **Delivered** by templating `/` (`server.py:411`) — read `index.html`, inject
  `<meta name="cockpit-launch-token" content="…">`. `/` already sets
  `Cache-Control: no-store, no-cache, must-revalidate` (`:417`), so there is no cache-
  poisoning path and no stale token. **A page that can read the token is already
  same-origin, which means it has already passed the Origin check** — the token is
  therefore *defence in depth behind* fix (a), never a substitute for it.
- **Header, not URL.** A token in a WebSocket URL lands in access logs, in
  `logging_config` output, in crash dumps and in any proxy in the path. But **the browser
  `WebSocket` constructor cannot set headers.** The honest resolution is the
  **`Sec-WebSocket-Protocol`** subprotocol field: the client passes the token as a
  subprotocol, the server matches it and echoes the selected value. It is a header, it is
  never in the URL, and it is the standard workaround. It is also *slightly* abusive of
  the field, and that should be recorded rather than hidden.
- **Lifetime:** the process. No expiry, no rotation. An expiring token on a harness Len
  leaves open for days would drop his terminals on a timer, which is a worse failure than
  the one being fixed.
- **On restart:** the token changes, so every open WebSocket's *next reconnect* fails
  auth. **But the terminals are already gone** — the PTY sessions are children of the
  server process and `lifespan` terminates them on shutdown. So "what happens to an open
  terminal when the server restarts" has the same answer with the token as without it:
  the terminal did not survive the restart in the first place. **The token adds no new
  failure mode here.** What it does add is that a stale browser tab must reload rather
  than reconnect — and it must show *that*, not "terminal not found".

### THE HARDER QUESTION: does `bypassPermissions` belong on the wire at all?

**No. Recommendation: remove it from the request body.** It is the severity multiplier and
it is the cheapest thing to take away.

The measurement first, because the answer turns on it. The legitimate UI **does** use it —
`GET /api/terminals` on the live 1.31.0 right now shows `"bypass_permissions": true` on
Session 1. So "nobody uses it, delete it" is false and would be a real regression.

But **look at where the value comes from**: `App.jsx:460` —
`savedLocations.find(l => l.path === dir)?.bypassPermissions`. It is a **per-directory
trust setting**, chosen once per saved location, then replayed into every create for that
directory (`:485`, `:530`, `:602-603`, `:1929`). It is not a per-request decision at all.
**And `savedLocations` lives in `localStorage`** (`loadSavedLocations`, `App.jsx:243`) —
which the project's own settings contract forbids: *"The UI is not allowed to keep a
setting only in `localStorage` — each field maps to one key in `settings.json`."*

So the right shape is already written down in this repo, and it happens to close the hole:

> **Move the per-directory bypass decision into `settings.json`** as a server-held list of
> trusted workdirs. `POST /api/terminals` stops reading `bypassPermissions` from the body
> and instead *derives* it: `effective_bypass = workdir in settings.trusted_workdirs`. The
> flag becomes a **property of a directory the user configured**, not a field a JSON body
> asserts.

**Why this is better than any token scheme, on its merits:**

- A token protects the *route*. This removes the *capability* from the route. A drive-by
  that somehow gets past the Origin check still cannot obtain
  `--dangerously-skip-permissions` in a directory Len never marked trusted — it can only
  spawn a **permission-prompting** `claude`, which is a session that asks before it acts.
- It is a **smaller** change than a token: no minting, no delivery, no subprotocol, no
  dev-mode carve-out.
- It fixes the `localStorage` contract violation as a side effect, and it makes the
  setting survive a browser-data clear, which today it does not.
- The residual `permissionMode: "bypassPermissions"` path (`pty_manager.py:982`) must be
  closed in the same change or the fix is cosmetic — **that string is a second door to the
  same flag**, and a fix that shuts one is the class of defect this program keeps finding.

**Cost, stated:** the "new session here with bypass" flow must round-trip a settings write
the first time a directory is marked trusted. That is one `PUT /api/settings` on a toggle
the user already clicks deliberately.

**Priority, if only one thing ships:** fix (a). It closes the whole class. **If two: (a)
and the `bypassPermissions` de-wiring.** The launch token is third — it is the one whose
value is mostly *depth*, and the one with the most ways to break Len's dev loop.

---

## 5 · What breaks for Len — the part that decides shippability

Len is using 1.31.0 as his working harness: **3 live terminals right now**, one of them
the session this plan was written in, and **1631 sessions of history** (`GET /api/history`,
measured — note the brief said 78; the true figure is 1631, and this row does not know
what the 78 counted).

| Question | Answer |
|---|---|
| **Do his open terminals die?** | **No — if and only if the change is not applied to a running server.** Every fix here is server-side Python. It takes effect on the next start, and **starting a new server is what kills the terminals**, because the PTY children are terminated by `lifespan` shutdown. **The terminals are lost by the RESTART, not by the fix.** |
| **Must he restart?** | **Yes, and that is the whole cost.** There is no hot path. He loses 3 live sessions. Each is recoverable via the existing resume path (`claude_session_id` is recorded per terminal and `POST /api/terminals` accepts `resume_session_id`), but recovery is manual and it is not free. |
| **Does anything in `~/.plexar-studio` change?** | **Fix (a): nothing. Fix (b)/token: nothing.** No schema, no new file, no migration. **Only the `bypassPermissions` de-wiring writes there**, and only additively: a new `trusted_workdirs` key in `settings.json` (87 bytes today). `usage.sqlite3` (21.7 MB + a **4.1 MB hot WAL**), `pricing.sqlite3`, `chat.sqlite3` and `config.json` are all untouched. **Nothing in this row moves a `.sqlite3`, so the WAL hazard from the R-E window does not apply.** |
| **Old frontend → new server?** | **Fix (a): fails SAFELY and unambiguously.** An old bundle still connects same-origin from `http://localhost:8420`, so it **passes** — the Origin rule was written against how the app is already served, precisely so a stale bundle is not collateral. **The token is where it fails**: an old bundle has no `<meta>` tag, sends no subprotocol, and is refused. That must be close code `4403` with a reason saying **"reload the app"** — not `4004` "Terminal not found", which is the confusing failure and is what the current code would produce. **This is the single strongest argument for shipping (a) alone first.** |
| **New frontend → old server?** | Harmless. The extra subprotocol is ignored by a server that does not negotiate it; the `<meta>` tag is absent so the client sends nothing. Degrades to today's behaviour. |
| **Dev loop?** | **`PopoutTerminal.jsx` in dev is the one thing that breaks** if `COCKPIT_DEV_ORIGINS` is omitted — it connects direct to `:8420` with a `:5174` Origin. The main pane goes through the Vite proxy and is unaffected. This must be in the gate, not discovered later. |
| **The `claude` CLI's own traffic?** | **Untouched, and deliberately.** `/shim/vllm` and `/shim/lmstudio` are driven by `claude` via `ANTHROPIC_BASE_URL` — a non-browser client that sends no Origin. Nothing in this row guards `/shim/*` or `/v1/*`. Widening it there would break the harness, which is `csrf.py` rule 2's lesson and it is inherited without change. |

**Verdict on shippability: fix (a) alone is shippable on a Tuesday afternoon** — one
restart, three terminals lost, no data touched, stale bundles keep working. **The token is
not**, because it turns every un-reloaded tab into a failure and the failure is currently
indistinguishable from "your terminal is gone".

---

## 6 · The gate (C-form — runnable by Plexar-LLM or Admin without asking me)

A gate must be **watched to FAIL** once before it counts. Predictions are stated first.

### GATE S14-A — the drive-by is refused

Against a server started from the branch under test, with one terminal created **through
the UI** (so the positive arm has a real target):

| # | Arm | Command | PREDICTED before |PREDICTED after |
|---|---|---|---|---|
| 1 | Foreign Origin, WS | raw handshake, `Origin: https://evil.example`, valid id | `101` | **not `101`** — refused before `accept()`, close `4403` |
| 2 | **Absent** Origin, WS | same, no `Origin` header | `101` | **not `101`** — this is the arm where I differ from `csrf.py`; if it returns `101` the difference was not implemented |
| 3 | `Origin: null`, WS | same, `Origin: null` | `101` | **not `101`** |
| 4 | Foreign Origin, spawn | `POST /api/terminals`, `Content-Type: text/plain`, `Origin: https://evil.example`, `{"workdir":"C:\\","bypassPermissions":true}` | **`200` and a real spawn** | *(a) alone: still 200 — SAY SO, do not claim otherwise.* With the `bypassPermissions` de-wiring: 200 but the argv carries **no** `--dangerously-skip-permissions` |
| 5 | Foreign Host (rebinding surrogate) | `Host: evil.example`, `Origin: http://evil.example`, WS | `101` | **not `101`** — the clause an `Origin == Host` check would pass |

**Arm 4 is the honesty arm.** Fix (a) does **not** stop the blind spawn — it stops the
attacker from ever *reaching* the spawned terminal. A gate that reported arm 4 green under
fix (a) alone would be lying, and `bypassPermissions` reaching the wire is exactly why the
spawn still matters. **This is why arm 4 has two different predicted-after values, chosen
by which fixes shipped.**

**Arm 4 spawns a real process and MUST be run against a throwaway server on `PORT=8421`,
never against Len's live 8420.** Assert on the argv (`session.pty` command), not on a
side effect.

### GATE S14-B — the legitimate UI still works

| # | Arm | PREDICTED |
|---|---|---|
| 6 | Production shape: page at `http://localhost:8420`, `TerminalPane` WS | connects, output flows, keystrokes land |
| 7 | Same at `http://127.0.0.1:8420` (the normalisation clause) | connects |
| 8 | Dev: Vite `:5174`, main pane via the `/ws` proxy | connects |
| 9 | **Dev: `PopoutTerminal` direct to `:8420` from a `:5174` page** | connects **only** with `COCKPIT_DEV_ORIGINS` set; **this is the arm predicted to fail first** |
| 10 | Stale bundle (no token) against a server with (a) only | connects — proves (a) does not break old frontends |

### WATCH-TO-FAIL (mandatory, before any `✅`)

- Delete the `Host` loopback clause → **arm 5 goes green (`101`) and arms 1-3 stay red.**
  Predicted: **1 failure.** If deleting it reddens nothing, the anti-rebinding half is not
  wired and the check is `Origin == Host` wearing a different name.
- Change "absent Origin is refused" to "allowed" → predicted: **1 failure (arm 2)**. If
  zero, arm 2 is not asserting the state it claims.
- Delete the origin check entirely → predicted: **4 failures (arms 1, 2, 3, 5)**.
- Add `http://evil.example` to `COCKPIT_DEV_ORIGINS` → predicted: **1 failure (arm 1)**.
  This proves the allowlist is *read* rather than the check being hardcoded-refuse-all —
  without it, a build that refuses every WebSocket passes arms 1-3 and 5 perfectly.

**The last one is the guard against the shape this program keeps hitting: a refusal that
passes because it refuses everything.** Arms 6-10 are what stop it, and they must be run
in the same session as 1-5 or the gate has not been run.

---

## 7 · Rollback

**One tag, one reset.**

```
git tag pre-s14-ws-origin lane/studio      # BEFORE any code lands
...
git reset --hard pre-s14-ws-origin         # the entire rollback
```

Nothing else is required, and that is a property of the design, not luck:

- No file in `~/.plexar-studio` is created, moved or migrated by fix (a) or the token.
- No `.sqlite3` and no `-wal` is touched, so nothing can be silently discarded.
- The only persistent artefact in the whole plan is an **additive** `trusted_workdirs` key
  in `settings.json`, and `settings_store` preserves unknown keys through a read — so a
  rolled-back build **ignores it rather than choking on it**, and rolling forward again
  finds it intact.
- The runtime rollback is the same act as the deploy: **restart the server.** It costs the
  live terminals either way, which is stated in §5 rather than discovered.

---

## 8 · Explicitly NOT in this row

**`server.py` is 6301 lines and mixes the terminal/permission subsystem with uploads, git
detection, provider proxies, pricing, spend and system stats. DO NOT REFACTOR IT. DO NOT
PROPOSE REFACTORING IT HERE.** A security fix entangled with a restructure is
unreviewable, and unreviewable is how this got here. **Future row S16.**

**Future row S15:** the CSRF/Origin guard over `/api/*` proper — the other 20 drive-by
POST routes, `POST /api/shutdown` and the two credential-overwrite routes among them. It
is the right eventual shape and it has real collateral (`/shim/*` is driven by the
`claude` CLI, which sends no Origin), so it gets its own row, its own gate and its own
approval.
