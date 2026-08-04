# 17 — Rip out the sidecar's HTTP listener and move Studio onto Tauri IPC

**Status:** BACKLOG ITEM. **NOTHING IS APPLIED AND NOTHING IS PROPOSED FOR APPLICATION IN
THIS ROW.** No production file is modified, no build is produced. **1.31.0 stands as the
current build and Len is using it.** This document exists so the work is costed before it
is started, not after.

**Lane:** PLEXAR-STUDIO · row **S16** (new) · would execute on its own branch (§4).
**Measured against:** the tree at `lane/studio`, `server.py` at 6,301 lines, Studio 1.31.0.

**Relationship to row 16 (`backlog/16-ws-origin-and-launch-token.md`):** row 16 is the
**interim** — an Origin/Host check and a launch token. **Len declined it:** *"Honestly I
would ignore this for right now then."* Row 16 stays on disk unedited as the record of the
option that was considered and not taken. This row is the other answer to the same finding
and it is not a refinement of row 16 — it is the alternative to it.

---

## 1 · WHY

Studio's backend answers **104 routes and authenticates none of them** (row 16 §2,
enumerated from the decorators, re-verified for this row). It answers them on a TCP
listener at `127.0.0.1:8420`, and **any web page the user visits can open a TCP connection
to loopback** — a browser is not prevented from talking to localhost, only (sometimes,
partially) from reading the reply. Row 16's fix guards that door: check the `Origin`, check
the `Host`, hand out a launch token. **Removing the listener means there is no door.** The
distinction is the entire point of this row: an origin check is a *defence* against a class
of attack, and the class stays alive — every future route inherits the requirement to be
guarded, every future guard can be written wrong, and the guard itself was the thing found
missing in the first place. With no listener there is **no Origin check to get wrong, no
launch token to leak, no CSRF, and no DNS rebinding**, because rebinding is an attack on
*name resolution reaching a listener* and there is nothing at the other end of the name.
This **seals the class rather than defending against it.** That is the reason to do it, and
it is the only reason — nothing here makes Studio faster, smaller or easier to work on.

**Framing correction, recorded because the earlier version of this analysis got it wrong.**
The HTTP surface is **not** vestigial plumbing left behind by the remote-access relay. That
relay was **torn out once, long ago**, and `bridge_manager.py` (1,676 lines) is a **later
feature** — a peer bridge between two *local* PTY sessions — not a remnant of it. The
correct account is simpler and worse: **Studio was built as a web application with a
desktop shell wrapped around it.** The proof is one line of config —
`src-tauri/tauri.conf.json` → `"frontendDist": "http://localhost:8420"`. The shipped
desktop app does not load bundled assets; **it navigates its webview at the server's own
HTTP origin.** The listener is not a leftover, it is the app's delivery mechanism, and that
is why removing it is a rearchitecture and not a deletion.

---

## 2 · THE INVENTORY, MEASURED

Enumerated from the decorators in `web/server.py` and the two mounted routers, then each
route classified by **what its client actually is**, because that — not the HTTP verb — is
what decides whether an IPC command can replace it.

**104 routes total.** 98 in `server.py` (65 GET, 21 POST, 7 DELETE, 3 PUT, 1 PATCH,
1 WEBSOCKET) + 6 in the routers (`vllm_shim.py` 4, `lmstudio_proxy.py` 2). This reproduces
row 16's count exactly.

| Bucket | Count | What conversion means |
|---|---|---|
| **A · Mechanical request/response** | **87** | JSON in, JSON out. `#[tauri::command]` wrapper + one call site change each. Genuinely rote. |
| **B · Served as a URL, not as data** | **9** | `/`, `/assets/{path:path}`, six icon routes, `/api/upload/{name}`. **These are not IPC-shaped at all** — they are what the webview loads. They move to Tauri's asset protocol, not to commands. |
| **C · Streaming** | **1 live, 1 dead** | `/ws/terminal/{id}` — the hard part (below). `/api/terminals/{id}/messages/stream` (SSE, `:1782`) — **measured: zero consumers.** No `EventSource` anywhere in `frontend/src`, no test, no doc. **It is dead and should be deleted rather than ported.** |
| **D · Non-browser client** | **6** | The `/shim/*` routes. **These cannot become IPC — see §2.3.** |
| **E · Download by `<a href download>`** | **1** | `/api/terminals/{id}/export` (`:1879`, `Content-Disposition: attachment`), linked from `PaneActionsMenu.jsx:233`. Becomes a save-dialog + file write, not a command return. |

87 + 9 + 2 + 6 = 104. **Bucket A is 84% of the count and well under half the work.**

### 2.1 · The hard part: `/ws/terminal/{id}`

`server.py:1257`. A bidirectional PTY bridge: terminal bytes out at whatever rate `claude`
produces them, keystrokes and pasted images in, plus `session.active_consumer` semantics
(`:1277-1278`, "latest connection wins"). Two clients: `TerminalPane.jsx:148` and
`PopoutTerminal.jsx:367`.

Tauri's IPC is **request/response commands plus a one-way event channel** — it has no
duplex socket. The replacement is a pair, not a port: a `terminal_write` command for the
inbound direction and emitted events (or a Tauri `Channel`) for the outbound. That is
workable, and three things about it are not free:

- **Backpressure disappears.** A WebSocket has flow control; an event emit does not. A
  session producing a large burst — `cat` of a big file, a long build log — currently
  throttles at the socket. Under events it queues in the webview's message pump. **This
  must be measured against a real burst before the design is accepted, not after.**
- **`active_consumer` has to be re-expressed.** Today "who owns this terminal" is
  identified by which socket connected last. With no socket there is no connection identity
  and the ownership handoff between a pane and its popout needs an explicit token.
- **Reconnect semantics change.** Today a dropped socket reconnects and replays from the
  scrollback buffer. There is no drop to detect when the transport is a function call, so
  the replay path either becomes dead code or becomes a window-lifecycle concern.

### 2.2 · The second hard part: the pop-out windows, and what serves the UI

These are one problem, not two, and `frontendDist` is why.

`App.jsx:1271-1291` opens a pop-out by building **a URL** —
`/?popout=<id>&name=…&model=…` — and handing it either to `new WebviewWindow(label, {url})`
or to `window.open`. `main.jsx:11-13` reads those parameters back out of
`location.search`. **The second webview is loading a page from the server.** Delete the
listener and both paths 404.

So the migration must answer *what serves the UI at all*. Today: `frontendDist:
"http://localhost:8420"`, and `server.py:411` hands back `frontend/dist/index.html`, with
`/assets/{path:path}` (`:6232`) serving the bundle — a build already exists on disk, it is
simply being delivered over HTTP by the process it is talking to. The change is to point
`frontendDist` at the built directory so Tauri serves the bundle over its own asset
protocol, at which point pop-outs address a bundled path rather than a server URL and the
`?popout=` parameters travel as window state instead of as a query string. This is
**mechanically small and behaviourally broad**: it changes the page's origin, which changes
what the CSP in `tauri.conf.json` must allow, and it means `BroadcastChannel`
("cockpit-popout", `App.jsx:1256`) is being relied on between two webviews whose origin
relationship has changed. That needs proving, not assuming.

### 2.3 · The honest answer: **the port does not fully disappear**

`/shim/vllm` and `/shim/lmstudio` (6 routes) exist because **`claude` — a Node CLI running
as a child process — is pointed at them**: `pty_manager.py:924` sets
`env["ANTHROPIC_BASE_URL"] = local_base_url`, and for the vLLM path that value is
`http://127.0.0.1:8420/shim/vllm` (pinned in `tests/test_local_provider.py:175`). **That
client is not a webview and cannot be given an IPC handle.** It speaks HTTP because
`ANTHROPIC_BASE_URL` is a URL, and a Unix socket or a named pipe is not a URL that the
Anthropic SDK will accept. **So the document says it plainly: a listener survives, and any
claim that "there is no more HTTP" would be false.**

What changes is its size and its reachability, and both are worth having:

- **104 routes → 6.** The surviving listener carries the shim routers and nothing else. It
  spawns no processes, writes no credentials, reads no history, and has no `/api/shutdown`.
- **It can be bound on an ephemeral port**, not a fixed 8420 that an attacker's page can
  hardcode.
- **It can carry a per-process bearer token** minted at startup and injected into the child's
  env alongside `ANTHROPIC_BASE_URL` — a secret the child has and a web page structurally
  cannot obtain, because the page no longer has an origin that can read anything from this
  process.
- **Measured, and this is the strongest part: it is not always needed.** `pty_manager.py`
  only points a session at the shim when the session uses a *local* provider; the default
  `anthropic` provider **strips** `ANTHROPIC_BASE_URL` entirely (`:908`, `:949`, asserted in
  `tests/test_local_provider.py:198`). **A Studio with no local-provider session running
  needs no listener at all**, so the shim listener can start on demand and stop when the
  last such session ends. Len's day-to-day use of Studio would then have **no listening TCP
  socket in the process**.

Two smaller routes also deserve a named answer rather than an assumption:
`GET /metrics` (`:6108`, Prometheus text) and `GET /health` (`:303`). Both are consumed by
Studio's own Engine page (`EngineApi.jsx:137-138`, `EngineView.jsx:84,108`), and **a search
for an external scraper found none** — nothing under `ops-mcp` or `infrastructure`
references `:8420`. So both are bucket A, not bucket D. The one non-webview consumer of the
port outside the shim is `src-tauri/src/lib.rs:85`, which does a bare
`TcpStream::connect("127.0.0.1:8420")` as its readiness probe; with no listener that
becomes a readiness handshake over the sidecar's stdio.

### 2.4 · One feature that the migration must decide about, not discover

`EngineApi.jsx` is a **route explorer** — a Settings page whose entire purpose is issuing
raw HTTP requests to catalogued paths and showing the response. It is a UI built on the
assumption that the backend is addressable by path. Under IPC it either gets rewritten
against the command list or it goes. **Naming it here is the point**; it is exactly the kind
of thing found halfway through and turned into an argument for abandoning the migration.

---

## 3 · WHAT IT COSTS AND WHAT IT BREAKS

### Size

Rough, and rough is the honest register — a measured estimate here would be a fabricated
one. Bucket A is 87 near-identical conversions; the cost is in the three named hard parts
(§2.1, §2.2, §2.4) and in the gate. **Weeks, not days; not a quarter.** The single biggest
risk to the estimate is the PTY event path (§2.1), because it is the one item whose design
is not yet known to work.

**What is NOT in the estimate, and the reason matters.** "Rip out the sidecar and convert
to full Tauri" has a maximal reading: delete the Python process and rewrite the backend in
Rust. **That is 17,990 lines of Python** — `server.py` 6,301, `pty_manager.py` 1,784,
`bridge_manager.py` 1,676, `usage_tracker.py` 1,425, a hand-written ConPTY binding
(`conpty.py`, 801), `voice_service.py` 982, and eleven more. **That is not a migration, it
is rewriting the product**, and it would be justified by nothing in §1 — the threat class is
sealed **the moment there is no TCP listener**, and the listener's existence has nothing to
do with the backend's language. **This row therefore scopes "rip out the sidecar" as
removing the sidecar's *HTTP listener and its role as the UI's origin*, keeping the Python
process as a Tauri-managed child that speaks over stdio/pipe.** If Len means the maximal
reading, that is a different and much larger row, and it should be told the number above
first.

### Len's data

**Nothing in `~/.plexar-studio` is migrated, moved or reformatted by this work.** The
1,631 sessions (`GET /api/history`, measured live in row 16) are read from Claude Code's own
JSONL files by `jsonl_watcher.py`; `usage.sqlite3` (21.7 MB, hot WAL), `pricing.sqlite3`,
`chat.sqlite3`, `settings.json` and `config.json` are all read and written by the same
Python process before and after. **This changes the transport, not the storage layer.** The
WAL hazard that made the R-E window delicate does not arise here because no `.sqlite3` is
moved. The one thing that must be explicitly held is that `app_paths.py` keeps resolving to
the same home — a rearchitecture that quietly re-roots the data directory would lose the
history in a way no test in this repo would notice.

**Live terminals do not survive.** They do not survive *any* server restart today — the PTY
children are terminated by `lifespan` shutdown — so this is the existing cost of a deploy,
not a new one. It should still be said out loud because this migration implies many
restarts of the app Len works in.

### Incremental or flag day: **incremental, and it is worth real effort**

A flag day on the application Len uses every day is how this gets abandoned half-finished,
so the question was checked at source rather than answered by preference. **It can be
incremental, and the reason is a measured property of the frontend:** every backend call in
`frontend/src` goes through `fetch("/api/…")` with a literal path, plus exactly **two**
`new WebSocket` sites (`TerminalPane.jsx:148`, `PopoutTerminal.jsx:367`). There is no
scattered client library and no generated SDK.

So the first change on the branch is not a security change at all — it is **one client-side
module that owns every request**, dispatching a path to an IPC command when one is
registered and falling through to `fetch` when one is not. With that in place, the backend
can run **both transports at once**: a route is an IPC command *and* still an HTTP route,
converted one at a time, each conversion independently reviewable and independently
revertible, with the app fully working at every commit.

**The consequence, stated rather than buried: while both transports are live, the class in
§1 is NOT sealed.** The entire security benefit of this row arrives on the **last** commit —
the one that stops binding the general listener. Everything before it is preparation that
buys no safety. That is a real and unattractive property of this plan and it is the honest
counterweight to §1: the work is long and the payoff is at the end. It is recorded here
without re-litigating Len's ruling on the interim.

The flag day is therefore reduced to **one commit** — remove the bind, keep the shim
listener per §2.3 — behind a single gate, on a build already proven to work over IPC.

---

## 4 · THE BRANCH

Len: *"It would be a separate branch etc."*

**Branch: `lane/studio-ipc`**, cut from a tag on `lane/studio` (`pre-s16-ipc`) at the moment
work starts.

`lane/studio` **continues to receive normal work throughout** — fixes, features, releases.
It is Len's shipping line and this row does not pause it.

**A long-lived branch that diverges for weeks is its own failure mode**, and it is the
likeliest way this row dies, so the reconciliation is designed rather than left to
willingness:

1. **The branch's job is the scaffolding, not the 87 conversions.** It carries the client
   dispatch module, the Rust command plumbing, the sidecar stdio channel, the
   `frontendDist` change and the pop-out rework. That is a bounded body of work.
2. **The scaffolding merges back to `lane/studio` as soon as it is inert** — dual-transport
   means the merged state is behaviourally identical to today, so it merges early rather
   than at the end. **After that merge the branch is gone and the 87 route conversions
   happen as ordinary `lane/studio` work**, in slices, alongside everything else. The
   divergent window is short **by construction**, not by discipline.
3. **The final bind-removal commit is its own short-lived branch**, cut when the count of
   unconverted routes reaches zero, with the gate attached.
4. While the branch does exist, it **rebases forward onto `lane/studio` on a fixed cadence**
   and a rebase that cannot be completed in one sitting is the signal that step 2 was left
   too late.
5. **The branch never receives an unrelated fix.** A rearchitecture branch that starts
   collecting bug fixes cannot be abandoned, and being cheaply abandonable is the property
   that makes starting it safe.

---

## 5 · EXPLICITLY NOT IN SCOPE

**The `server.py` restructure.** `server.py` is 6,301 lines and mixes the terminal and
permission subsystem with uploads, git detection, provider proxies, pricing, spend and
system stats. It should be split. **It must not be split as part of this migration.** Row 16
§8 already banned entangling a security fix with that restructure, and the ban applies with
more force here, because this row touches every route in the file: a diff that both *moves*
a route between files and *changes its transport* is a diff in which no reviewer can tell a
port from a rewrite. **A rearchitecture entangled with a restructure is unreviewable, and
unreviewable is how the current state arrived.** The restructure stays a separate future
row, executed either wholly before or wholly after this one.

Also out of scope, and named so they are not smuggled in:

- **Rewriting the Python backend in Rust** (§3 — 17,990 lines, and it buys nothing that §1
  asks for).
- **Row 16's Origin check and launch token.** Declined by Len; not to be added "in the
  meantime" while this runs. Row 16 is a record, not a task.
- **The `bypassPermissions` de-wiring** (row 16 §4). It is a good change on its own merits
  — a per-directory trust setting is currently read off the wire and stored in
  `localStorage` against this project's own settings contract — but it is a *behaviour*
  change and belongs in its own row, where it can be reviewed as one.
- **Any change to what is stored, or where.**

---

## 6 · THE GATE — to be written when the row is scheduled, not now

Deliberately not drafted. A gate written weeks before the design it tests is a prediction
about code that does not exist, and this program's rule is that a gate must be **watched to
fail** once before it counts. What can be fixed now are the arms it must contain, so they
are not negotiated away later:

1. **`ss`/`netstat` shows no process-owned listening socket** other than the shim listener,
   with Studio running and at least one terminal live. This is the arm the whole row exists
   for.
2. **`curl http://127.0.0.1:8420/api/terminals` is refused at connect**, not answered — the
   before/after pair, and the "after" must be connection refused rather than a 403, because
   a 403 means a listener.
3. **The shim listener is reachable by the child and not by a page**: `claude` drives a local
   provider successfully, and the same URL without the bearer token is refused.
4. **The PTY burst arm** (§2.1): a session emitting a large continuous output does not lose
   bytes, reorder them, or wedge the webview. Predicted before the design is chosen:
   **this is the arm expected to fail first.**
5. **The pop-out arm** (§2.2): open a pop-out, reclaim it, close it, from a bundled origin.
6. **A watch-to-fail pass**: restore the bind and confirm arms 1 and 2 go red. A gate that
   passes because everything is refused is the failure shape this program keeps hitting.

---

## 7 · SUMMARY FOR THE BOARD

| Question | Answer |
|---|---|
| Does it seal the class? | **Yes** — no listener, no origin check, no token, no CSRF, no rebinding. |
| Does the port disappear entirely? | **No.** `/shim/*` (6 routes) serves the `claude` CLI over `ANTHROPIC_BASE_URL` and must stay HTTP. It shrinks 104 → 6, moves to an ephemeral port with a per-process token, and **can be started on demand** — a session on the default `anthropic` provider needs no listener at all. |
| How many routes convert mechanically? | **87 of 104.** 9 are asset-protocol, 1 is a download, 1 SSE route is **dead and should be deleted**, 6 stay HTTP. |
| What is genuinely hard? | The PTY WebSocket (backpressure, consumer identity, reconnect); the pop-out windows plus `frontendDist`; and the Engine route-explorer page, which is built on paths existing. |
| Incremental? | **Yes**, via one client dispatch module and dual transports — but **the security benefit lands only on the final commit**. |
| Does Len lose data? | **No.** Transport change only; `~/.plexar-studio` and the 1,631 sessions are untouched. |
| Branch | `lane/studio-ipc`, scaffolding only, merged back early; `lane/studio` never pauses. |
