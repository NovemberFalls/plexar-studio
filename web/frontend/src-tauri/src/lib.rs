use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use tauri_plugin_shell::ShellExt;

/// Note: orphan cleanup is handled by the Python sidecar on startup.
/// It only kills processes whose PIDs were tracked in .cockpit-child-pids,
/// never random Claude sessions running in other terminals.

fn spawn_sidecar(
    app: &tauri::AppHandle,
    restart_count: Arc<AtomicU32>,
) {
    let shell = app.shell();
    let cmd = shell
        .sidecar("cockpit-server")
        .expect("failed to find cockpit-server sidecar")
        .env("NO_BROWSER", "1");

    let (mut rx, _child) = cmd.spawn().expect("failed to spawn cockpit-server");

    let app_handle = app.clone();
    let rc = restart_count.clone();

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
                    eprintln!("[server] terminated with {:?}", status);

                    let attempts = rc.fetch_add(1, Ordering::SeqCst);
                    if attempts < 3 {
                        eprintln!(
                            "[tauri] Sidecar crashed — restarting (attempt {}/3)...",
                            attempts + 1
                        );

                        // Orphan cleanup is handled by the Python sidecar on restart
                        // (only kills tracked cockpit-spawned processes, not user sessions)

                        // Wait before restart to let port free up
                        std::thread::sleep(std::time::Duration::from_secs(2));

                        // Respawn
                        spawn_sidecar(&app_handle, rc);
                    } else {
                        eprintln!(
                            "[tauri] Sidecar crashed 3 times — giving up. Restart the app."
                        );
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
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let restart_count = Arc::new(AtomicU32::new(0));

            // Spawn the sidecar and monitor it
            spawn_sidecar(&app.handle(), restart_count);

            // Wait for the server to be ready before the webview loads
            let start = std::time::Instant::now();
            let timeout = std::time::Duration::from_secs(15);
            loop {
                if std::net::TcpStream::connect("127.0.0.1:8420").is_ok() {
                    println!("[tauri] Server is ready");
                    break;
                }
                if start.elapsed() > timeout {
                    eprintln!("[tauri] Warning: server did not start within 15s");
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
