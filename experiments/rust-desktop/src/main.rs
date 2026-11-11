mod capture;
mod content;
mod native;
mod navigation;
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
fn smoke_result(app: tauri::AppHandle, value: String) {
    if std::env::var("MILAGRE_RUST_SMOKE").as_deref() == Ok("1") {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open("/tmp/milagre-rust-smoke.json")
        {
            let _ = file.write_all(value.as_bytes());
        }
        let _ = capture::snapshot(&app);
    }
}
fn main() {
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
            if !background {
                app.get_webview_window("main").unwrap().show()?;
            }
            if std::env::var("MILAGRE_RUST_SMOKE").as_deref() == Ok("1") {
                let window = app.get_webview_window("main").unwrap();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(15));
                    let _ = window.eval(include_str!("../content-smoke.js"));
                    let _ = window.eval(include_str!("../renderer/smoke.js"));
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
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
        .run(tauri::generate_context!())
        .expect("Milagre Rust failed");
}
