# Backlog 04 — 1.4.0 / 1.4.1 version collision (pre-ship)

**Status: RESOLVED (2026-07-25). Version bumped 1.4.1 → 1.5.0 in `web/frontend/package.json` (uncommitted).**

## Correction to original notes
- `releases/` actually contains BOTH 1.4.0 and 1.4.1 built installers — 1.4.1 shipped and matches the installed app.
- Only ONE source of truth: `tauri.conf.json` has `"version": "../package.json"` (it does NOT hardcode), so `package.json` governs the whole desktop app version. `Cargo.toml` is the Rust crate version (sat at 1.3.6 the whole time app shipped 1.4.x — cosmetic, left as-is). `Cargo.lock`/`target/` version hits are regenerated build artifacts.
- **DONE:** bumped `package.json` to `1.5.0`. No other file needed editing. Do not commit/ship until backlogs 01 (reporting) + 03 (CLI path) land — this bump is the last pre-ship step, then `/push-cockpit`.


## The problem
- `releases/` on disk has **1.4.0** artifacts.
- The **installed desktop app is 1.4.1** (a respin that was never fully reconciled here).
- Same-version respins never trigger the auto-updater (known lesson, memory `claude-cockpit`).

## Fix
Bump the version **past 1.4.1** (→ 1.5.0 for the reporting feature, or 1.4.2 if scoped small)
in all sources of truth before building:
- `web/frontend/src-tauri/tauri.conf.json` (version)
- `web/frontend/package.json`
- any `Cargo.toml` version in `src-tauri`
- confirm no other hardcoded version strings (grep `1\.4\.`).

## Ship path
This whole update (reporting view + CLI-path fix) is a **big release**. Build via
`/push-cockpit` (frontend → PyInstaller → copy sidecar to
`src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe` → signed Tauri → latest.json).
Signing key + password in memory `reference_signing_key`. Owner QA's the installed
desktop app only — deliver installer to `C:\Users\lenbo\Downloads`.
