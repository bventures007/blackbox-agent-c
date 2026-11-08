//! Blackbox desktop shell. The window first shows the bundled status page (ui/), which follows the
//! supervisor through start-up; once the API is healthy it switches to the Blackbox web UI served by the
//! local API on 127.0.0.1. Closing the window keeps Blackbox running in the tray / menu bar; quitting
//! stops the services and the database.

mod layout;
mod proc;
mod secrets;
mod supervisor;

use std::path::PathBuf;
use std::sync::Arc;

use layout::Layout;
use supervisor::{Phase, Status, Supervisor};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent};

struct AppState(Arc<Supervisor>);

/// URL of the bundled status page (the custom protocol differs per platform).
fn local_page() -> Url {
    let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
    Url::parse(base).expect("static url")
}

fn is_local(url: &Url) -> bool {
    url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost")
}

fn open_external(target: &str) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(target).spawn();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer").arg(target).creation_flags(0x0800_0000).spawn();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
fn get_status(state: tauri::State<AppState>) -> Status {
    state.0.status()
}

#[tauri::command]
async fn confirm_owner_key(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.0.owner_key_saved().map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn reset_access(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sup = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || sup.reset_access())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn retry(state: tauri::State<AppState>) {
    state.0.start();
}

#[tauri::command]
fn open_logs(state: tauri::State<AppState>) {
    open_external(&state.0.layout.process_logs().to_string_lossy());
}

fn runtime_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("BLACKBOX_DESKTOP_RUNTIME") {
        return PathBuf::from(dir);
    }
    app.path().resource_dir().expect("resource dir").join("runtime")
}

fn data_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("BLACKBOX_DESKTOP_DATA") {
        return PathBuf::from(dir);
    }
    app.path().app_local_data_dir().expect("app data dir")
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Blackbox", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "Restart services", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "Open logs folder", true, None::<&str>)?;
    let data = MenuItem::with_id(app, "data", "Open data folder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Blackbox", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep, &restart, &logs, &data, &sep2, &quit])?;
    let mut tray = TrayIconBuilder::with_id("blackbox").tooltip("Blackbox").menu(&menu).show_menu_on_left_click(true);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| {
        let sup = app.state::<AppState>().0.clone();
        match event.id.as_ref() {
            "open" => show_main(app),
            "restart" => {
                show_main(app);
                sup.restart();
            }
            "logs" => open_external(&sup.layout.process_logs().to_string_lossy()),
            "data" => open_external(&sup.layout.data.to_string_lossy()),
            "quit" => app.exit(0),
            _ => {}
        }
    })
    .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_status, confirm_owner_key, reset_access, retry, open_logs])
        .setup(|app| {
            let handle = app.handle().clone();
            let layout = Layout::new(runtime_dir(&handle), data_dir(&handle));
            layout.create_dirs()?;
            let api_port = layout.ports()?.api;
            let sup = Supervisor::new(layout, app.package_info().version.to_string());

            // Only the bundled status page and the local Blackbox API may load in the window;
            // any other link opens in the system browser.
            let api_origin = format!("http://127.0.0.1:{api_port}");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Blackbox")
                .inner_size(1360.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .on_navigation(move |url| {
                    if is_local(url) || url.as_str().starts_with(&format!("{api_origin}/")) {
                        return true;
                    }
                    open_external(url.as_str());
                    false
                })
                .build()?;

            // Leave the Blackbox UI for the status page whenever the services are not usable.
            let nav = handle.clone();
            sup.set_on_change(move |s| {
                if matches!(s.phase, Phase::Ready | Phase::OwnerKey | Phase::OwnerKeyMissing) {
                    return;
                }
                if let Some(w) = nav.get_webview_window("main") {
                    if let Ok(url) = w.url() {
                        if !is_local(&url) {
                            let _ = w.navigate(local_page());
                        }
                    }
                }
            });

            // SIGTERM/SIGINT/SIGHUP (logout, `kill`, Ctrl-C in a terminal) quit like the menu does, so the
            // services and the database are stopped cleanly instead of being left behind.
            #[cfg(unix)]
            {
                use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
                let mut signals = signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP])?;
                let exit = handle.clone();
                std::thread::spawn(move || {
                    if signals.forever().next().is_some() {
                        exit.exit(0);
                    }
                });
            }

            app.manage(AppState(sup.clone()));
            build_tray(&handle)?;
            sup.start();
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps Blackbox running; quit from the tray or the app menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Blackbox desktop app");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::Exit => {
            if let Some(state) = app.try_state::<AppState>() {
                state.0.stop();
            }
        }
        _ => {}
    });
}
