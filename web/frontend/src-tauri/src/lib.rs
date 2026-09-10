use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;
mod clipboard;

/// Note: orphan cleanup is handled by the Python sidecar on startup.
/// It only kills processes whose PIDs were tracked in .cockpit-child-pids,
/// never random Claude sessions running in other terminals.

const SERVER_ADDR: &str = "127.0.0.1:8420";

/// True only when the sidecar ANSWERS an HTTP request.
///
/// A bare `TcpStream::connect` was not enough: the listening socket accepts as
/// soon as it is bound, which is strictly earlier than uvicorn serving routes,
/// so "connected" could still mean "not yet answering".
///
/// Written against std rather than pulling in an HTTP crate for one probe.
/// `Host` carries the port; `origin_guard._split_host` strips it and accepts
/// 127.0.0.1 as loopback, and an ABSENT Origin is allowed on HTTP (it is the
/// same-origin shape) -- so this request satisfies both of the guard's clauses.
fn server_responds() -> bool {
    use std::io::{Read, Write};

    let Ok(mut stream) = std::net::TcpStream::connect(SERVER_ADDR) else {
        return false;
    };
    let t = std::time::Duration::from_millis(1500);
    let _ = stream.set_read_timeout(Some(t));
    let _ = stream.set_write_timeout(Some(t));

    // CRLF explicitly, and as escapes rather than a multi-line literal: HTTP
    // line endings are CRLF, and a Rust multi-line string would embed the
    // source file's own newlines (LF here) into the request instead.
    let req = b"GET /api/version HTTP/1.1\r\nHost: 127.0.0.1:8420\r\nConnection: close\r\n\r\n";
    if stream.write_all(req).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    match stream.read(&mut buf) {
        Ok(n) => buf[..n].starts_with(b"HTTP/1.1 200"),
        Err(_) => false,
    }
}

/// A sidecar that stayed up this long is a HEALTHY run, not a crash loop
/// member. The restart budget counts CONSECUTIVE rapid failures; without this
/// reset the budget was for the LIFETIME of the app, so a server that ran fine
/// for six hours and then died was counted as the fourth crash and never
/// restarted. An external kill (Task Manager) burned a restart too.
const HEALTHY_RUN_SECS: u64 = 60;

/// Consecutive rapid failures tolerated before we stop and TELL the user.
const MAX_CONSECUTIVE_RESTARTS: u32 = 3;

/// Backoff between consecutive attempts: 2s, 4s, 8s. A flat retry into a port
/// that is still releasing is what the 2.1.7 bind-loop looked like.
fn backoff_for(attempts: u32) -> std::time::Duration {
    std::time::Duration::from_secs(2u64 << attempts.min(2))
}

/// The live sidecar's process handle, so a watchdog can kill a HUNG one.
///
/// The handle used to be dropped on the floor (`let (mut rx, _child) = ...`),
/// which meant nothing in the app could end a sidecar that had stopped
/// answering. Dropping a `CommandChild` does not kill the process.
type ChildSlot = Arc<Mutex<Option<tauri_plugin_shell::process::CommandChild>>>;

/// Append one line to `~/.plexar-studio/logs/supervisor.log`, and to stderr.
///
/// ══ STDERR IS NOT A LOG IN A PACKAGED BUILD ═════════════════════════════
/// The first watchdog wrote every decision with `eprintln!`, which in an NSIS
/// build goes nowhere. When it then failed to recover a hang there was no way
/// to tell whether it had fired, killed the wrong thing, or never run — the
/// same trap this file already documents for the give-up dialog ("in a
/// packaged NSIS build nobody sees stderr") and which I walked into anyway.
///
/// This is deliberately NOT the Python sidecar's `cockpit.log`: the whole
/// point is to record what happened while the sidecar was unable to write
/// anything. Best effort — a supervisor that panics on a full disk is worse
/// than one that loses a line.
fn supervisor_log(line: &str) {
    eprintln!("[tauri] {}", line);
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
    else {
        return;
    };
    let dir = std::path::PathBuf::from(home).join(".plexar-studio").join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("supervisor.log"))
    {
        let _ = writeln!(f, "{} {}", now_stamp(), line);
    }
}

/// A sortable local timestamp without pulling in a date crate.
fn now_stamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Seconds since epoch is unambiguous and needs no timezone handling; the
    // lines it labels are read next to cockpit.log, which carries wall clock.
    format!("[epoch {}]", secs)
}

/// How often the watchdog asks the sidecar whether it is still serving.
const HEALTH_POLL_SECS: u64 = 5;

/// Consecutive failed probes before the sidecar is declared hung and killed.
/// 24 x 5s = 2 minutes of total silence.
///
/// RAISED FROM 6 (30 s), 2026-09-10 (R-193). The kill takes EVERY session with
/// it, so a false positive is far worse than a slow recovery. MEASURED on the
/// owner's machine with six live sessions: an OVERLOADED but working sidecar
/// missed up to 4 consecutive probes (~20 s) and then answered, while the one
/// real hang on record (R-188) lasted 51 minutes. At 6 the watchdog sat two
/// probes from destroying a live workspace over load alone. The counter still
/// resets on the first success.
const HEALTH_FAILURES_BEFORE_KILL: u32 = 24;

/// How long a replacement sidecar is given to come up before the watchdog
/// judges it. A cold start extracts a 50MB onefile archive while Defender
/// watches, so this is generous on purpose.
const RECOVERY_GRACE_SECS: u64 = 25;

/// Watch a sidecar that is ALIVE but no longer SERVING, and end it so the
/// existing restart path can run.
///
/// MEASURED 2026-09-09, with py-spy against the live process the owner was
/// about to kill by hand: the sidecar does not crash, it HANGS. The process was
/// alive at 178MB, port 8420 was still LISTENING, TCP connect succeeded in 1ms,
/// and three HTTP probes each timed out at a full 10s. Its event loop was
/// blocked inside `threading.Thread.start()` -- `run_in_threadpool` ->
/// `solve_dependencies` -- waiting on a worker thread that never started.
///
/// THE SUPERVISOR WAS STRUCTURALLY BLIND TO THIS. Every recovery path in this
/// file hangs off `CommandEvent::Terminated`, and a hung process never
/// terminates, so the panes sat on "waiting for connection" forever and the
/// only remedy was Task Manager. The restart budget, the backoff and the
/// give-up dialog were all correct and all unreachable.
///
/// Killing the bootloader is enough and the rest is already built: the Python
/// child deliberately outlives it and keeps holding 8420, so the respawned
/// sidecar's `instance_guard.resolve_port` finds a silent holder, probes it for
/// `HUNG_AFTER_S` (10s), confirms its executable name is in `SIDECAR_NAMES` and
/// terminates it before binding. This adds no new kill path; it reaches the one
/// that already exists.
fn spawn_health_watchdog(
    app: tauri::AppHandle,
    restart_count: Arc<AtomicU32>,
    child_slot: ChildSlot,
) {
    std::thread::spawn(move || {
        supervisor_log("watchdog started");
        let mut consecutive_failures: u32 = 0;
        loop {
            std::thread::sleep(std::time::Duration::from_secs(HEALTH_POLL_SECS));

            if server_responds() {
                if consecutive_failures > 0 {
                    supervisor_log(&format!(
                        "sidecar answered again after {} failed probe(s)",
                        consecutive_failures
                    ));
                }
                consecutive_failures = 0;
                continue;
            }

            consecutive_failures += 1;
            supervisor_log(&format!(
                "no answer from /api/version ({}/{})",
                consecutive_failures, HEALTH_FAILURES_BEFORE_KILL
            ));
            if consecutive_failures < HEALTH_FAILURES_BEFORE_KILL {
                continue;
            }

            // ── 1. End the child we own, if we still own one. ───────────────
            //
            // Best effort and NOT the load-bearing step. This handle is the
            // PyInstaller BOOTLOADER; the process actually hung and holding
            // port 8420 is its Python child, which deliberately outlives it.
            // Killing this does not free the port and does not stop the hang.
            let child = child_slot.lock().ok().and_then(|mut slot| slot.take());
            match child {
                Some(c) => match c.kill() {
                    Ok(()) => supervisor_log("ended the sidecar bootloader we spawned"),
                    Err(e) => supervisor_log(&format!("could not end the bootloader: {}", e)),
                },
                None => supervisor_log("no live bootloader handle to end"),
            }

            // ── 2. SPAWN A FRESH SIDECAR OURSELVES. ────────────────────────
            //
            // THIS is the recovery, and the first watchdog got it wrong by
            // leaving it to `CommandEvent::Terminated`. MEASURED on the
            // owner's 2.1.23 during a real hang: cockpit.log recorded NO
            // "Startup complete" for the 51 minutes the app was wedged and NO
            // `instance_guard` port verdict at any point, so nothing ever
            // respawned and nothing ever reclaimed the port. Recovery that
            // hangs off an event which did not arrive is not recovery.
            //
            // Spawning is SAFE even if the hung process is still holding the
            // port, because the new sidecar arbitrates it with the proven,
            // name-gated logic in `instance_guard.resolve_port`: a silent
            // holder is probed for HUNG_AFTER_S, confirmed to be a Plexar
            // sidecar by executable name, terminated, and the port bound. If
            // the old one turns out to be healthy after all, the newcomer
            // exits 3 and attaches instead. Both outcomes are logged by the
            // Python side, which is what makes the next failure diagnosable.
            //
            // The restart budget is reset first: this is a recovery from a
            // hang, not another member of a crash loop, and a burnt-out budget
            // would make the watchdog fire forever with nothing happening.
            restart_count.store(0, Ordering::SeqCst);
            supervisor_log("spawning a replacement sidecar (instance_guard will arbitrate the port)");
            spawn_sidecar(&app, restart_count.clone(), child_slot.clone());

            // Give the replacement a real chance before judging it, so the
            // next loop does not immediately count a cold start as a failure.
            std::thread::sleep(std::time::Duration::from_secs(RECOVERY_GRACE_SECS));
            supervisor_log(if server_responds() {
                "recovered: the replacement sidecar is serving"
            } else {
                "still not serving after the grace period; will keep watching"
            });
            consecutive_failures = 0;
        }
    });
}

/// The give-up surface. In a packaged NSIS build nobody sees stderr, so a
/// stderr-only message left the panes on "waiting for connection" -- which is
/// the wording for a RECOVERABLE outage -- forever.
///
/// Non-blocking `show` with a callback, deliberately: a blocking dialog called
/// from inside the sidecar event task can deadlock the runtime. The window is
/// NOT closed and the app is NOT auto-quit; the user may need to copy text out
/// of a pane, so quitting stays their explicit choice.
fn report_give_up(app: &tauri::AppHandle, restart_count: Arc<AtomicU32>, child_slot: ChildSlot) {
    let app_handle = app.clone();
    app.dialog()
        .message(
            "The local Plexar Studio server stopped 3 times in a row and the app can no longer \
             reach it. Your sessions are not running.\n\nTry again restarts the server. Quit \
             closes Plexar Studio.",
        )
        .title("Plexar Studio server stopped")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Try again".to_string(),
            "Quit".to_string(),
        ))
        .show(move |try_again| {
            if try_again {
                restart_count.store(0, Ordering::SeqCst);
                supervisor_log("user chose Try again — resetting the restart budget and respawning");
                spawn_sidecar(&app_handle, restart_count, child_slot);
            } else {
                supervisor_log("user chose Quit after the sidecar gave up");
                app_handle.exit(0);
            }
        });
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
    restart_count: Arc<AtomicU32>,
    child_slot: ChildSlot,
) {
    let shell = app.shell();
    let cmd = shell
        .sidecar("plexar-studio-server")
        .expect("failed to find plexar-studio-server sidecar")
        .env("NO_BROWSER", "1");

    let (mut rx, child) = cmd.spawn().expect("failed to spawn plexar-studio-server");

    // Hand the handle to the watchdog. Dropping it (the old `_child`) does not
    // kill the process, it merely makes it unkillable from inside the app.
    if let Ok(mut slot) = child_slot.lock() {
        *slot = Some(child);
    }

    let app_handle = app.clone();
    let rc = restart_count.clone();
    let slot_for_events = child_slot.clone();
    let spawned_at = std::time::Instant::now();

    // Log sidecar output and handle crash recovery
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[server] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(status) => {
                    supervisor_log(&format!("sidecar terminated with {:?}", status));

                    if status.code == Some(3) {
                        supervisor_log("sidecar exited 3: another Plexar Studio already serves 127.0.0.1:8420 — attaching, not restarting");
                        break;
                    }

                    // A healthy run clears the budget BEFORE it is read, so the
                    // counter means "consecutive rapid failures", not "failures
                    // ever". Read the elapsed time from this spawn's own instant.
                    let uptime = spawned_at.elapsed();
                    if uptime.as_secs() >= HEALTHY_RUN_SECS {
                        rc.store(0, Ordering::SeqCst);
                        supervisor_log(&format!(
                            "sidecar had run {:?} (>= {}s) — fresh failure, restart budget reset",
                            uptime, HEALTHY_RUN_SECS
                        ));
                    }

                    let attempts = rc.fetch_add(1, Ordering::SeqCst);
                    if attempts < MAX_CONSECUTIVE_RESTARTS {
                        let delay = backoff_for(attempts);
                        supervisor_log(&format!(
                            "sidecar exited — restarting in {:?} (attempt {}/{})",
                            delay,
                            attempts + 1,
                            MAX_CONSECUTIVE_RESTARTS
                        ));

                        // Orphan cleanup is handled by the Python sidecar on restart
                        // (only kills tracked cockpit-spawned processes, not user sessions)

                        // Wait before restart to let port free up. On the BLOCKING
                        // pool, not here: this task runs on tauri::async_runtime,
                        // and a std::thread::sleep in it parks an async worker for
                        // the whole backoff. Tauri re-exports no timer
                        // (async_runtime.rs:13-20) and a direct tokio dependency is
                        // not worth version-aligning for one sleep.
                        let _ = tauri::async_runtime::spawn_blocking(move || {
                            std::thread::sleep(delay)
                        })
                        .await;

                        // Respawn
                        spawn_sidecar(&app_handle, rc, slot_for_events);
                    } else {
                        supervisor_log("sidecar exited 3 times in a row — giving up and telling the user");
                        report_give_up(&app_handle, rc, slot_for_events);
                    }
                    break;
                }
                CommandEvent::Error(err) => {
                    eprintln!("[server] error: {}", err);
                }
                _ => {}
            }
        }
    });
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![clipboard::read_clipboard_image])
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let restart_count = Arc::new(AtomicU32::new(0));
            let child_slot: ChildSlot = Arc::new(Mutex::new(None));
            let restart_count_for_watchdog = restart_count.clone();

            // Spawn the sidecar and monitor it
            spawn_sidecar(&app.handle(), restart_count, child_slot.clone());

            // Wait for the server to answer BEFORE the window exists.
            //
            // THIS USED TO DO NOTHING, and the comment above it said the
            // opposite of what happened. Tauri builds every window whose
            // config has `create: true` in `app.rs::setup`, and only THEN
            // calls this hook -- window creation at app.rs:2374, this closure
            // at app.rs:2380. So the webview had already navigated to
            // `frontendDist` (http://localhost:8420) and already been refused
            // by the time the wait started. Measured: the sidecar needs ~2.0s
            // warm (longer cold, while Defender scans the 50MB onefile
            // extraction) and the webview navigates at ~0ms, so it lost the
            // race on essentially every launch. The user saw WebView2's own
            // "server could not be reached" page and had to hit Refresh.
            //
            // The recovery logic was in the worst possible place: App.jsx's
            // health-check polling lives INSIDE the page that failed to load,
            // so nothing ever retried -- the retrier never ran.
            //
            // The fix is ordering, not duration: `create: false` in
            // tauri.conf.json keeps Tauri's loop from building the window
            // (it filters on exactly that flag), and we build it below, after
            // the server answers.
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(30);
            let mut ready = false;
            while start.elapsed() <= timeout {
                if server_responds() {
                    ready = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            // Start the watchdog AFTER the readiness wait, so a slow cold
            // start is never mistaken for a hang. It runs for the life of the
            // app, which is the point: every other recovery path in this file
            // hangs off process termination, and a hung sidecar never
            // terminates.
            spawn_health_watchdog(app.handle().clone(), restart_count_for_watchdog, child_slot.clone());

            if ready {
                supervisor_log(&format!("server ready in {:?}", start.elapsed()));
            } else {
                // Build the window anyway rather than leaving no window at
                // all: a silent no-window launch is harder to diagnose than
                // the error page, and this is the same outcome as before the
                // fix -- not a new failure surface. 30s is 15x the measured
                // warm boot, so reaching it means something is actually wrong.
                supervisor_log(&format!(
                    "server did not answer within {:?} — opening the window anyway",
                    timeout
                ));
            }

            // Now create the window. NOT filtered on `cfg.create`: that flag
            // is how we told Tauri's own loop to skip these, so filtering on
            // it here would skip them a second time and open nothing.
            let handle = app.handle().clone();
            let windows = handle.config().app.windows.clone();
            for cfg in &windows {
                tauri::WebviewWindowBuilder::from_config(&handle, cfg)?.build()?;
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
