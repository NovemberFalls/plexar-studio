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

  ; VERIFY, don't assume. Every kill above ends in 2>nul, so a process that
  ; survived them -- classically one started "Run as administrator", which this
  ; per-user installer is not permitted to terminate -- used to be invisible: the
  ; install went on, could not replace the locked exe, and the user relaunched
  ; into the OLD server and the old version number with no error anywhere
  ; (2026-09-22, a user stuck on 2.1.34 through two "successful" installs).
  ; Now a survivor stops the install with a plain explanation and a Retry.
  !insertmacro PLEXAR_VERIFY_STOPPED
!macroend

; Leaves "1" on $R9 if any Plexar Studio server process is still running.
!macro PLEXAR_ANY_RUNNING
  StrCpy $R9 "0"
  nsExec::ExecToStack 'cmd /c tasklist /nh /fi "IMAGENAME eq plexar-studio-server.exe" | find /i "plexar-studio-server.exe"'
  Pop $R8  ; exit code: 0 = find matched = something is running
  Pop $R7
  StrCmp $R8 "0" 0 +2
    StrCpy $R9 "1"
!macroend

!macro PLEXAR_VERIFY_STOPPED
  plexar_verify_loop:
    !insertmacro PLEXAR_ANY_RUNNING
    StrCmp $R9 "0" plexar_verify_done
    ; One more attempt before bothering the user.
    nsExec::ExecToLog 'cmd /c taskkill /f /t /im plexar-studio-server.exe 2>nul'
    Sleep 1500
    !insertmacro PLEXAR_ANY_RUNNING
    StrCmp $R9 "0" plexar_verify_done
    ; /SD IDCANCEL: in a silent install there is nobody to click Retry, and
    ; ABORTING is the honest outcome -- a half-install that relaunches into the
    ; old server is exactly the failure this check exists to end.
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Plexar Studio is still running in the background and could not be closed automatically.$\r$\n$\r$\nThis usually means it was started with 'Run as administrator'.$\r$\n$\r$\nOpen Task Manager, end every 'plexar-studio-server.exe' on the Details tab, then click Retry." /SD IDCANCEL IDRETRY plexar_verify_loop
    Abort "Plexar Studio is still running; the update was not installed."
  plexar_verify_done:
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro PLEXAR_STOP_ALL
!macroend

; Uninstall removes the same files, so it meets the same locks.
!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro PLEXAR_STOP_ALL
!macroend
