; Stop Plexar Studio before its files are overwritten or removed.
; Must be aggressive: Windows holds exe file locks until process fully exits.
;
; 2026-09-10: `plexar-studio-server.exe` -- the server's name since the rename --
; was MISSING from this list; only the pre-rename names were here. The server
; deliberately outlives the window (that is how sessions survive a window close),
; so it kept its own exe open and installs stopped on "Error opening file for
; writing ... plexar-studio-server.exe". The port-8420 pass below catches only
; the listening process: a PyInstaller onefile runs a bootloader AND a child from
; the same exe, and both hold it. The auto-updater runs this same installer.
;
; Killing by image name is right HERE and wrong elsewhere (R-185): these names
; belong to Plexar Studio alone -- unlike cloudflared.exe, which other products
; share. The WINDOW goes first: its supervisor respawns a dead server within
; seconds, which would hand the file lock straight to a fresh copy. `/t` takes
; the server's own tree (its sessions, its managed connector) so nothing is left
; running headless after the install; Studio restarts what it needs.
!macro PLEXAR_STOP_ALL
  ; First pass: kill by image name (covers both sidecar and Tauri app)
  nsExec::ExecToLog 'cmd /c taskkill /f /im plexar-studio.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im cockpit-server-x86_64-pc-windows-msvc.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im cockpit-server.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im claude-cockpit.exe 2>nul'
  Sleep 500
  nsExec::ExecToLog 'cmd /c taskkill /f /t /im plexar-studio-server.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /t /im plexar-studio-server-x86_64-pc-windows-msvc.exe 2>nul'
  Sleep 500

  ; Second pass: kill anything listening on port 8420 (the sidecar's API port)
  nsExec::ExecToLog 'cmd /c for /f "tokens=5" %a in ('"'"'netstat -ano ^| findstr :8420 ^| findstr LISTENING'"'"') do taskkill /f /pid %a 2>nul'
  Sleep 500

  ; Third pass: one more taskkill in case something respawned
  nsExec::ExecToLog 'cmd /c taskkill /f /im plexar-studio.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im cockpit-server-x86_64-pc-windows-msvc.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /im claude-cockpit.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /t /im plexar-studio-server.exe 2>nul'
  nsExec::ExecToLog 'cmd /c taskkill /f /t /im plexar-studio-server-x86_64-pc-windows-msvc.exe 2>nul'

  ; Wait for file handles to be fully released
  Sleep 2000
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PLEXAR_STOP_ALL
!macroend

; Uninstall removes the same files, so it meets the same locks.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PLEXAR_STOP_ALL
!macroend
