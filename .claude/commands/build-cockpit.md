# Build Claude Cockpit

Build the full Claude Cockpit desktop app (Tauri + PyInstaller sidecar) locally.

## Steps

1. **Build React frontend**:
   ```
   cd /c/Code/Personal/claude-cockpit/web/frontend && npm run build
   ```

2. **Build PyInstaller sidecar**:
   ```
   cd /c/Code/Personal/claude-cockpit/web && python -m PyInstaller --clean --noconfirm cockpit-server.spec
   ```

3. **Copy sidecar to Tauri binaries** (with Rust target triple):
   ```
   cp /c/Code/Personal/claude-cockpit/web/dist/claude-cockpit.exe /c/Code/Personal/claude-cockpit/web/frontend/src-tauri/binaries/cockpit-server-x86_64-pc-windows-msvc.exe
   ```
   **CRITICAL:** Always copy the FRESH PyInstaller exe here BEFORE building Tauri, or the desktop app will bundle a stale server.

4. **Build Tauri app** (requires signing env vars for auto-update):
   ```
   export TAURI_SIGNING_PRIVATE_KEY="$(cat C:/Code/.tauri/claude-cockpit.key)"
   export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="<password>"
   cd /c/Code/Personal/claude-cockpit/web/frontend && npx @tauri-apps/cli build
   ```

5. **Copy installer and updater zip to local releases** (gitignored):
   ```
   mkdir -p /c/Code/Personal/claude-cockpit/releases
   cp "/c/Code/Personal/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.exe" /c/Code/Personal/claude-cockpit/releases/
   cp "/c/Code/Personal/claude-cockpit/web/frontend/src-tauri/target/release/bundle/nsis/Claude Cockpit_"*"_x64-setup.nsis.zip" /c/Code/Personal/claude-cockpit/releases/
   ```
   Note: Tauri does NOT generate `latest.json`. That's handled by `/push-cockpit` when uploading to GitHub Releases.

6. **Clear the vite cache** (heavy Tauri/PyInstaller builds corrupt it — the next
   vitest run then dies with a bogus `expect is not defined` cascade at ~73 tests):
   ```
   rm -rf /c/Code/Personal/claude-cockpit/web/frontend/node_modules/.vite
   ```

7. **Notify user** — "Build complete. Artifacts ready at `C:\Code\Personal\claude-cockpit\releases\`."

## Important

- **Build order matters:** Frontend → PyInstaller → copy sidecar → Tauri. Skipping the sidecar copy = broken desktop app.
- The full build takes a few minutes (Rust compilation is the slowest part).
- If the Vite build fails, fix errors before proceeding.
- If PyInstaller fails, ensure `pywinpty` and other dependencies are installed.
- Release artifacts are NOT committed to git — they are distributed via GitHub Releases.
- Use `/push-cockpit` to build, commit, push, and upload to GitHub Releases in one shot.
