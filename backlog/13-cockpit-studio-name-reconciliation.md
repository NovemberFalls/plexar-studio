# 13 — "Cockpit" vs "Plexar Studio": one product, two names on screen

**Status:** PROPOSAL. Nothing renamed. The inventory below is measured; the
plan is destructive-class and waits on the owner.

**Filed 2026-08-03. Row: S22.**

---

## The finding, which outranks the rename

The owner wrote, of the lane broker:

> *"I dont understand the Lane Broker and why its managed by Cockpit vs Plexar
> Studio, for one."*

He was reasoning about a division of ownership between **two products**. There
is one. This repo is `claude-cockpit`; the product is **Plexar Studio**; they
are the same thing, and the lane broker is managed by it.

He did not misread anything. **The shipped UI told him there were two.** The
window title, the installer, the Sidebar welcome and the crash screen all say
"Plexar Studio". 191 rendered strings across 29 files say "Cockpit". Nothing
anywhere says they are the same product.

That is the expensive part. The prior instances of this failure corrupted a
*label*; this one corrupted his model of **who owns what**, and produced a
design question about a seam that does not exist. A naming inconsistency is
usually cosmetic. This one cost an architectural conversation.

---

## The measured inventory (2026-08-03, `web/frontend/src`, tests excluded)

| | count |
|---|---|
| `Cockpit` in **rendered strings / code** | **191** |
| `Cockpit` in **comments / JSDoc only** | 47 |
| **Total in `src/`** | **238** |
| Files with rendered occurrences | **29** |
| Files where **both names coexist** | **8** |

Rendered occurrences, worst first:

```
34  settings/ProvidersSettings.jsx      7  settings/SpillPolicy.jsx
18  settings/TerminalSettings.jsx       6  settings/SettingsView.jsx
17  settings/ClaudeCliSettings.jsx      6  settings/SpendGuardrails.jsx
14  settings/KeysSettings.jsx           4  engine/EngineLogs.jsx
13  engine/EngineApi.jsx                4  reports/ReportsView.jsx
11  engine/EngineLive.jsx               3  hooks/useLocalModels.js
11  settings/DiagnosticsSettings.jsx    2  engine/EngineRequests.jsx
10  settings/PricingSettings.jsx        2  engine/EngineView.jsx
 8  settings/UpdatesSettings.jsx        2  settings/SessionDefaultsSettings.jsx
 7  engine/EngineModels.jsx             2  settings/ThemeSettings.jsx
                                        2  settings/TokensSettings.jsx
        + 8 files with 1 each (modelCatalog.js, ActivityRail.jsx,
          NewSessionDialog.jsx, OpenRouterModal.jsx, reports/SessionsTable.jsx,
          settings/KeybindingsSettings.jsx, themes/themeData.js,
          utils/keybindings.js)
```

**Both names in one file — the eight places a reader is shown the two-product
model directly:** `App.jsx`, `ActivityRail.jsx`, `engine/EngineApi.jsx`,
`reports/format.js`, `reports/LocalEnginePanel.jsx`, `reports/ReportsView.jsx`,
`settings/UpdatesSettings.jsx`, `themes/themeData.js`.

Settings alone carries **101 of the 191** — over half. It is also the surface
the owner spends the most time in, which is consistent with where the confusion
came from.

### Where "Plexar Studio" already wins

`index.html` `<title>`, `tauri.conf.json` `productName: "Plexar-Studio"` and
window `title: "Plexar Studio"`, `Sidebar.jsx` welcome, `ErrorBoundary.jsx`
crash copy, `App.jsx` / `PopoutTerminal.jsx` document titles,
`UpdatesSettings.jsx` app label. **The chrome says Studio; the content says
Cockpit.** That is exactly the shape that produces "Cockpit *vs* Studio".

### Where "cockpit" is NOT a product name and must not be swept

These are identifiers, not prose. A blind rename breaks running installs:

- `cockpit-server-x86_64-pc-windows-msvc.exe` — the Tauri sidecar binary name.
- `com.claude-cockpit.app` — the Tauri bundle identifier. **Changing this
  makes every installed copy a different application to Windows and to the
  updater.**
- `Cargo.toml` / `Cargo.lock` `name = "claude-cockpit"`.
- The GitHub repo + releases URL the updater polls.
- `cockpit.server` / `cockpit.pty` / `cockpit.bridge` Python loggers.
- `COCKPIT_*` environment variables (~30), `cockpit-*` localStorage keys
  (`cockpit-local-enabled`, `cockpit-layout`, `cockpit-flip`,
  `cockpit-featured-slot`), `--cc-*` CSS tokens.

---

## Proposal

**The product is Plexar Studio everywhere a human can read it. "Cockpit"
survives only as a repository, package, binary, logger, env-var and
storage-key name — the machine's vocabulary, never the user's.**

Three tiers, in ascending risk. **Tier 3 is the only one that is genuinely
destructive and it is the one I recommend deferring or dropping.**

### Tier 1 — rendered prose (191 sites, 29 files) · REVERSIBLE
Replace the *word* in user-facing strings: `Cockpit` → `Plexar Studio`, and
possessives `Cockpit's` → `Plexar Studio's`. Where the sentence names the
server process rather than the product (`"Cockpit's server answered 500"`),
prefer `"the Studio server"` — the distinction is real and worth keeping.

Risk: text only. No route, key, id or file name moves. A test-suite failure is
the worst outcome and the whole change reverts with one `git revert`.

**Add a guard so it cannot drift back**: a structural test in the
`NoNativeDialogs.test.jsx` shape asserting no `.jsx`/`.js` under `src/` renders
the literal `Cockpit` outside a comment. That is what makes this a fix rather
than a sweep.

### Tier 2 — comments and docs (47 sites + `CLAUDE.md`) · FREE
Cosmetic, but comments are where the next agent forms its model of the product,
and this file exists because a wrong model is expensive. Do it with Tier 1.

### Tier 3 — identifiers · **DESTRUCTIVE, NOT RECOMMENDED NOW**
Bundle id, sidecar binary, Cargo package, env vars, localStorage keys, repo.
Each one is a compatibility break with installed copies, saved settings, and
the updater. **They are invisible to the user, which is the whole point of the
proposal: the user-visible surface is fixable without touching any of them.**
Recommend: do not do Tier 3. If ever done, it is its own plan with its own
migration, not a rider on a copy change.

---

## Rollback

- Tier 1+2 land as ONE commit on `lane/studio`, touching only string literals,
  comments and one new test. `git revert <sha>` restores every byte.
- No data, settings key, route, env var, id or file name is touched, so a
  rollback needs no migration and cannot strand a running install.
- The pre-change tree is `e595c18`. Gate before and after: full frontend suite
  (currently **1149 green**) + `npm run lint`.
- The new anti-drift test is in the same commit, so reverting removes the
  guard with the change rather than leaving a test pinning prose that is gone.

## Gate for the rename commit

1. `grep -c "Cockpit"` over rendered strings in `src/` → **0** (from 191).
2. The anti-drift test **watched to FAIL**: reintroduce one `Cockpit` string →
   red; remove it → green. Without that arm the test could be vacuous.
3. Full frontend suite green, `npm run lint` clean.
4. **Identifier count unchanged**: `com.claude-cockpit.app`, the sidecar name,
   `COCKPIT_*` and `cockpit-*` localStorage keys each still present at their
   current counts. This is the arm that proves Tier 3 did NOT happen by
   accident, and it is the one that protects installed copies.

## Not decided here

Whether the *repo* is renamed, and whether the Engine ▸ API explorer's route
group label `"Cockpit · per-provider"` should read `"Studio · per-provider"` or
name the server rather than the product. Both are the owner's calls.
