mod capture;
mod content;
mod downloads;
mod evidence;
#[cfg(feature = "app-fixture")]
#[allow(dead_code)]
mod fixture_launch;
mod images;
mod lifecycle;
mod native;
mod navigation;
mod shortcuts;
mod snapshot;
mod transport;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

#[tauri::command]
async fn daemon(
    transport: tauri::State<'_, transport::Transport>,
    method: String,
    args: Value,
) -> Result<Value, Value> {
    transport.call(method, args).await
}
#[tauri::command]
async fn native_call(app: tauri::AppHandle, method: String, args: Value) -> Result<Value, Value> {
    native::invoke(app, method, args).await
}
#[tauri::command]
fn preferences_read(prefs: tauri::State<'_, native::Preferences>) -> Result<Value, Value> {
    prefs.read()
}
#[tauri::command]
fn preferences_write(
    prefs: tauri::State<'_, native::Preferences>,
    key: String,
    value: Value,
) -> Result<(), Value> {
    prefs.write(key, value)
}
#[tauri::command]
async fn smoke_result(
    app: tauri::AppHandle,
    value: String,
    label: Option<String>,
) -> Result<Value, String> {
    if std::env::var("MILAGRE_RUST_SMOKE").as_deref() != Ok("1") {
        return Err("UI capture is enabled only for local smoke checks".into());
    }
    let kind = capture::Kind::parse(label.as_deref())?;
    evidence::write(kind.state_path(), value.as_bytes())?;
    capture::snapshot(&app, kind).await
}

// Smoke inputs are task-owned local JSON, never JavaScript or a remote command.
fn smoke_config(name: &str) -> Result<Option<Value>, String> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let Ok(path) = std::env::var(name) else {
        return Ok(None);
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|error| format!("{name}: {error}"))?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.len() > 1024 * 1024
    {
        return Err(format!(
            "{name} must be an owned regular JSON file with one link, at most 1 MiB"
        ));
    }
    let mut text = String::new();
    file.take(1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    if text.len() > 1024 * 1024 {
        return Err(format!("{name} exceeds 1 MiB"));
    }
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|error| format!("{name}: {error}"))
}
fn main() {
    let shell = match lifecycle::acquire() {
        Ok(shell) => shell,
        Err(error) => {
            eprintln!("{error}");
            return;
        }
    };
    let background = std::env::var("MILAGRE_BACKGROUND").as_deref() == Ok("1");
    let flags = tauri_plugin_window_state::StateFlags::SIZE
        | tauri_plugin_window_state::StateFlags::POSITION
        | tauri_plugin_window_state::StateFlags::MAXIMIZED;
    let builder = native::install(content::install(tauri::Builder::default())).plugin(
        tauri_plugin_window_state::Builder::default()
            .with_state_flags(flags)
            .with_filter(move |_| !background)
            .build(),
    );
    builder
        .manage(shell)
        .on_page_load(|webview, payload| {
            if payload.url().scheme() == "tauri"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                content::clear_previews(webview.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon,
            native_call,
            preferences_read,
            preferences_write,
            smoke_result
        ])
        .setup(|app| {
            app.manage(
                native::Preferences::new().map_err(|e| std::io::Error::other(e.to_string()))?,
            );
            native::start_notifications(app.handle());
            app.manage(transport::start(app.handle().clone()));
            let background = std::env::var("MILAGRE_BACKGROUND").as_deref() == Ok("1");
            if background {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                .on_navigation(|url| url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .build()?;
            navigation::install(&app.get_webview_window("main").unwrap())
                .map_err(std::io::Error::other)?;
            lifecycle::install(app.handle())?;
            shortcuts::install(app.handle()).map_err(std::io::Error::other)?;
            if !background {
                app.get_webview_window("main").unwrap().show()?;
            }
            if std::env::var("MILAGRE_RUST_SMOKE").as_deref() == Ok("1") {
                let live_config = smoke_config("MILAGRE_RUST_LIVE_CHAT_PROBE").map_err(std::io::Error::other)?;
                let capture_plan = smoke_config("MILAGRE_RUST_CAPTURE_PLAN").map_err(std::io::Error::other)?;
                let window = app.get_webview_window("main").unwrap();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    let _ = window.eval(format!("window.__rustWorkflowBackground={background};"));
                    let _ = window.eval(include_str!("../content-smoke.js"));
                    let _ = window.eval(include_str!("../renderer/workflows-smoke.js"));
                    let _ = window.eval(include_str!("../renderer/smoke.js"));
                    if let Some(config) = live_config {
                        let script = format!(
                            "window.__rustLiveChatProbe={};{}",
                            config,
                            include_str!("../renderer/live-chat-smoke.js")
                        );
                        let _ = window.eval(script);
                    }
                    if let Some(plan) = capture_plan {
                        let script = format!(
                            "window.__rustCapturePlan={};window.__rustPrepareComparison=()=>(\n{}\n);{}",
                            plan,
                            include_str!("../perf/prepare-capture.js").trim().trim_end_matches(';'),
                            include_str!("../perf/capture-rust.js")
                        );
                        let _ = window.eval(script);
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            lifecycle::window_event(window, event);
            if let tauri::WindowEvent::Focused(focused) = event {
                let _ = window.emit(
                    "native-event",
                    json!({"channel":"app:focus","payload":focused}),
                );
                if let Some(transport) = window.try_state::<transport::Transport>() {
                    let transport = transport.inner().clone();
                    let focused = *focused;
                    tauri::async_runtime::spawn(async move {
                        let _ = transport
                            .internal_call("daemon:focus".into(), json!([{"focused":focused}]))
                            .await;
                    });
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Milagre Rust failed")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                lifecycle::reopen(app);
            }
        });
}
