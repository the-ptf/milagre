//! Off-default production renderer with one owned persistent Rust Chat backend.
#[cfg(feature = "chat-native-smoke")]
#[path = "../chat_smoke.rs"]
mod chat_smoke;
#[path = "../content.rs"]
#[allow(dead_code)]
mod content;
#[cfg(feature = "chat-native-smoke")]
#[path = "../evidence.rs"]
mod evidence;
#[path = "../fixture_launch.rs"]
#[allow(dead_code)]
mod fixture_launch;
#[cfg(target_os = "macos")]
#[path = "../native_quit.rs"]
mod native_quit;
#[path = "../navigation.rs"]
mod navigation;
#[path = "../preview_launch.rs"]
mod preview_launch;
#[path = "../shortcuts.rs"]
mod shortcuts;
#[cfg(feature = "chat-native-smoke")]
#[path = "../snapshot.rs"]
mod snapshot;
#[path = "../transport.rs"]
#[allow(dead_code)]
mod transport;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
struct Quit(AtomicBool);

/// Only a typed cleanup-in-progress reply is retryable. Each attempt keeps the
/// same retained child/context; after Stop acknowledgement it only waits for exit.
/// Admit retries for 12s. The existing attempt has two bounded 10s waits, so the
/// entire task takes at most 32s, without abandoning an in-flight cleanup call.
fn settle_quit(
    mut attempt: impl FnMut() -> Result<(), Value>,
    mut elapsed: impl FnMut() -> Duration,
    mut wait: impl FnMut(Duration),
) -> Result<(), Value> {
    let limit = Duration::from_secs(12);
    loop {
        match attempt() {
            Err(error) if error["code"] == "QUIT_PENDING" => {
                let remaining = limit.saturating_sub(elapsed());
                if remaining.is_zero() {
                    return Err(error);
                }
                wait(remaining.min(Duration::from_millis(200)));
                if elapsed() >= limit {
                    return Err(error);
                }
            }
            outcome => return outcome,
        }
    }
}

#[tauri::command]
async fn daemon(
    transport: tauri::State<'_, transport::Transport>,
    method: String,
    args: Value,
) -> Result<Value, Value> {
    transport.call(method, args).await
}
#[tauri::command]
fn preferences_read(
    context: tauri::State<'_, Arc<fixture_launch::LaunchContext>>,
) -> Result<Value, Value> {
    context.preferences()
}
#[tauri::command]
fn preferences_write(
    context: tauri::State<'_, Arc<fixture_launch::LaunchContext>>,
    key: String,
    value: Value,
) -> Result<(), Value> {
    context.write_preference(key, value)
}
#[tauri::command]
async fn smoke_result(app: tauri::AppHandle, value: String) -> Result<Value, String> {
    #[cfg(feature = "chat-native-smoke")]
    {
        chat_smoke::result(app, value).await
    }
    #[cfg(not(feature = "chat-native-smoke"))]
    {
        let _ = (app, value);
        Err("Build chat-native-smoke for the explicit native probe".into())
    }
}
#[tauri::command]
async fn native_call(app: tauri::AppHandle, method: String, args: Value) -> Result<Value, Value> {
    if let Some(result) = content::invoke_chat(&app, &method, &args).await {
        return result;
    }
    match method.as_str() {
        "app:launch-arguments" => Ok(json!([
            "--milagre-window-controls=leading",
            "--milagre-opened-projects-before=1"
        ])),
        "app:version" => Ok(json!("0.1.0-rust-chat")),
        "runtime:connection" => Ok(app.state::<transport::Transport>().connection_state()),
        "app:retry-quit" => {
            request_quit(&app, 0);
            Ok(Value::Null)
        }
        "shortcuts:set" => shortcuts::set(&app, &args[0]),
        "project:open" => {
            if args[0].as_str()
                != app
                    .state::<Arc<fixture_launch::LaunchContext>>()
                    .project()
                    .to_str()
            {
                return Err(
                    json!({"code":"ISOLATED_SCOPE_ONLY","message":"Open this runtime's dedicated Project"}),
                );
            }
            app.state::<transport::Transport>().call(method, args).await
        }
        #[cfg(feature = "chat-native-smoke")]
        "chat-desktop:smoke-context" => app
            .state::<chat_smoke::Smoke>()
            .context(app.state::<Arc<fixture_launch::LaunchContext>>().project()),
        #[cfg(feature = "chat-native-smoke")]
        "chat-desktop:smoke-progress" => app.state::<chat_smoke::Smoke>().progress(&args[0]),
        "window:start-drag" => {
            app.get_webview_window("main")
                .ok_or(json!({"code":"WINDOW_UNAVAILABLE"}))?
                .start_dragging()
                .map_err(|_| json!({"code":"WINDOW_UNAVAILABLE"}))?;
            Ok(Value::Null)
        }
        "window:toggle-maximize" => {
            let window = app
                .get_webview_window("main")
                .ok_or(json!({"code":"WINDOW_UNAVAILABLE"}))?;
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|_| json!({"code":"WINDOW_UNAVAILABLE"}))?;
            Ok(Value::Null)
        }
        "settings:window-background" => {
            if let Some(color) = args[0]
                .as_str()
                .and_then(|s| s.parse::<tauri::window::Color>().ok())
            {
                if let Some(window) = app.get_webview_window("main") {
                    window
                        .set_background_color(Some(color))
                        .map_err(|_| json!({"code":"WINDOW_UNAVAILABLE"}))?;
                }
            }
            Ok(Value::Null)
        }
        _ => Err(
            json!({"code":"CHAT_DESKTOP_UNSUPPORTED","message":format!("This dedicated Chat window does not provide {method}")}),
        ),
    }
}
fn request_quit(app: &tauri::AppHandle, code: i32) {
    if app.state::<Quit>().0.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    let context = app
        .state::<Arc<fixture_launch::LaunchContext>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let started = Instant::now();
            settle_quit(
                || context.request_quit(),
                || started.elapsed(),
                std::thread::sleep,
            )
        })
        .await;
        app.state::<Quit>().0.store(false, Ordering::Release);
        match result {
            Ok(Ok(())) => app.exit(code),
            result => {
                let error = match result {
                    Ok(Err(error)) => error,
                    _ => json!({"code":"CHAT_QUIT_FAILED","message":"Cleanup is not confirmed"}),
                };
                if let Some(window) = app.get_webview_window("main") {
                    let _ =
                        window.set_title("Milagre Rust Chat (quit pending; Stop Chat and retry)");
                }
                let _ = app.emit(
                    "native-event",
                    json!({"channel":"app:quit-blocked","payload":error}),
                );
            }
        }
    });
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "chat-native-smoke")]
    let smoke_plan = chat_smoke::plan().map_err(std::io::Error::other)?;
    let explicit = std::env::args().skip(1).collect::<Vec<_>>();
    let arguments = preview_launch::arguments(&explicit, &std::env::current_exe()?)?;
    let context = fixture_launch::LaunchContext::spawn_chat(&arguments)
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let owned = context.clone();
    let background = std::env::var("MILAGRE_BACKGROUND").as_deref() == Ok("1");
    println!("{}", json!({"chatDesktop":context.smoke_identity()}));
    let app = content::install_chat_artifacts(tauri::Builder::default(), context.project().to_string_lossy().into_owned()).manage(context.clone()).manage(Quit(AtomicBool::new(false)))
        .invoke_handler(tauri::generate_handler![daemon,native_call,preferences_read,preferences_write,smoke_result])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && payload.url().scheme() == "tauri" && payload.url().host_str() == Some("localhost")
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started) { content::clear_previews(webview.app_handle()); }
            #[cfg(feature = "chat-native-smoke")]
            if webview.label() == "main" && payload.url().scheme() == "tauri" && payload.url().host_str() == Some("localhost")
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(smoke) = webview.app_handle().try_state::<chat_smoke::Smoke>() {
                    if let Some(window) = webview.app_handle().get_webview_window("main") { smoke.page_loaded(&window); }
                }
            }
            #[cfg(not(feature = "chat-native-smoke"))]
            let _ = (webview, payload);
        })
        .setup(move |app| {
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), Box<dyn std::error::Error>> {
                #[cfg(feature = "chat-native-smoke")]
                if let Some(plan) = smoke_plan {
                    app.manage(chat_smoke::Smoke::new(&owned, plan).map_err(std::io::Error::other)?);
                    chat_smoke::watchdog(app.handle().clone());
                }
                app.manage(transport::start_chat(app.handle().clone(), owned.clone()));
                if background { app.set_activation_policy(tauri::ActivationPolicy::Accessory); }
                let window_builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                    .initialization_script(include_str!("../../renderer/fixture-network-policy.js"));
                #[cfg(feature = "chat-native-smoke")]
                let window_builder = window_builder.initialization_script(include_str!("../../renderer/fixture-reduced-motion.js"));
                let window = window_builder
                    .incognito(true)
                    .on_navigation(|url| url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny).build()?;
                navigation::install(&window).map_err(std::io::Error::other)?;
                shortcuts::install(app.handle()).map_err(std::io::Error::other)?;
                #[cfg(target_os = "macos")]
                {
                    let handle = app.handle().clone();
                    native_quit::install(move || request_quit(&handle, 0)).map_err(std::io::Error::other)?;
                }
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
                let quit = MenuItem::with_id(app, "chat-quit", "Quit Milagre Rust Chat", true, Some("CmdOrCtrl+Q"))?;
                app.set_menu(Menu::with_items(app, &[&Submenu::with_items(app,"Milagre Rust Chat",true,&[&quit])?, &Submenu::with_items(app,"Edit",true,&[&PredefinedMenuItem::undo(app,None)?,&PredefinedMenuItem::redo(app,None)?,&PredefinedMenuItem::cut(app,None)?,&PredefinedMenuItem::copy(app,None)?,&PredefinedMenuItem::paste(app,None)?,&PredefinedMenuItem::select_all(app,None)?])?])?)?;
                app.on_menu_event(|app, event| if event.id().as_ref() == "chat-quit" { request_quit(app, 0); });
                let handle = app.handle().clone(); let visible = window.clone();
                window.with_webview(move |view| unsafe {
                    let webview: &objc2_web_kit::WKWebView = &*view.inner().cast();
                    let persistent = webview.configuration().websiteDataStore().isPersistent();
                    #[cfg(feature = "chat-native-smoke")]
                    if let Some(smoke) = handle.try_state::<chat_smoke::Smoke>() { smoke.store(persistent); }
                    if persistent { request_quit(&handle, 1); } else if !background { let _ = visible.show(); }
                })?;
                Ok(())
            }));
            if !matches!(outcome, Ok(Ok(()))) {
                shortcuts::uninstall_fixture();
                if owned.abandon_on_shell_failure() { app.handle().exit(1); }
                else { eprintln!("Chat window setup failed; exact child cleanup remains unconfirmed and storage is retained"); }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); request_quit(window.app_handle(), 0); }
        })
        .build(tauri::generate_context!("tauri.chat.conf.json"));
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            let _ = context.abandon_on_shell_failure();
            return Err(error.into());
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { ref api, .. } = event {
            let context = app.state::<Arc<fixture_launch::LaunchContext>>();
            if !context.clean() && !context.failure_exit_allowed() {
                api.prevent_exit();
                request_quit(app, 0);
            }
        }
        if let tauri::RunEvent::Exit = event {
            #[cfg(target_os = "macos")]
            native_quit::uninstall();
            shortcuts::uninstall_fixture();
            let context = app.state::<Arc<fixture_launch::LaunchContext>>();
            if context.clean() {
                let cleanup = context.remove_shell_storage();
                #[cfg(feature = "chat-native-smoke")]
                if let Some(smoke) = app.try_state::<chat_smoke::Smoke>() {
                    smoke.exit(&cleanup);
                }
                if let Err(error) = cleanup {
                    eprintln!("Chat shell cleanup failed: {}", error["code"]);
                }
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod quit_tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn pending_retries_until_exact_cleanup_succeeds() {
        let now = Cell::new(Duration::ZERO);
        let attempts = Cell::new(0);
        let result = settle_quit(
            || {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 3 {
                    Err(json!({"code":"QUIT_PENDING"}))
                } else {
                    Ok(())
                }
            },
            || now.get(),
            |delay| now.set(now.get() + delay),
        );
        assert_eq!(result, Ok(()));
        assert_eq!(attempts.get(), 3);
        assert_eq!(now.get(), Duration::from_millis(400));
    }

    #[test]
    fn other_errors_and_cleanup_deadline_are_not_retried_forever() {
        for error in [
            json!({"code":"SAVE_FAILED","message":"original cause"}),
            json!({"message":"QUIT_PENDING"}),
        ] {
            assert_eq!(
                settle_quit(
                    || Err(error.clone()),
                    || Duration::ZERO,
                    |_| panic!("permanent failure must not wait")
                ),
                Err(error)
            );
        }
        let now = Cell::new(Duration::ZERO);
        let attempts = Cell::new(0);
        let pending = json!({"code":"QUIT_PENDING","message":"captured worker remains"});
        let result = settle_quit(
            || {
                attempts.set(attempts.get() + 1);
                Err(pending.clone())
            },
            || now.get(),
            |delay| now.set(now.get() + delay),
        );
        assert_eq!(result, Err(pending));
        assert_eq!(now.get(), Duration::from_secs(12));
        assert_eq!(attempts.get(), 60);
    }
}
