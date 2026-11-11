//! Separate development shell. Never install or route to the production owner.
#[cfg(feature = "fixture-native-smoke")]
#[path = "../evidence.rs"]
mod evidence;
#[path = "../fixture_launch.rs"]
mod fixture_launch;
#[cfg(feature = "fixture-native-smoke")]
#[path = "../fixture_smoke.rs"]
mod fixture_smoke;
#[path = "../shortcuts.rs"]
mod shortcuts;
#[cfg(feature = "fixture-native-smoke")]
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
use tauri::{Emitter, Manager};
struct Quit(AtomicBool);
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
    #[cfg(feature = "fixture-native-smoke")]
    {
        fixture_smoke::result(app, value).await
    }
    #[cfg(not(feature = "fixture-native-smoke"))]
    {
        let _ = (app, value);
        Err("Fixture capture requires the native smoke build".into())
    }
}
#[tauri::command]
async fn native_call(app: tauri::AppHandle, method: String, args: Value) -> Result<Value, Value> {
    match method.as_str() {
        #[cfg(feature = "fixture-native-smoke")]
        "fixture:smoke-context" => app
            .state::<fixture_smoke::Smoke>()
            .context(app.state::<Arc<fixture_launch::LaunchContext>>().project()),
        "app:launch-arguments" => Ok(json!([
            "--milagre-window-controls=leading",
            "--milagre-opened-projects-before=1"
        ])),
        "app:version" => Ok(json!("0.1.0-rust-scripted-fixture")),
        "runtime:connection" => Ok(app.state::<transport::Transport>().connection_state()),
        "app:retry-quit" => {
            request_quit(&app, 0);
            Ok(Value::Null)
        }
        "shortcuts:set" => shortcuts::set(&app, &args[0]),
        "project:open" => {
            let context = app.state::<Arc<fixture_launch::LaunchContext>>();
            if args[0].as_str() != context.project().to_str() {
                return Err(
                    json!({"code":"ISOLATED_SCOPE_ONLY","message":"Only this generated Project is available"}),
                );
            }
            app.state::<transport::Transport>().call(method, args).await
        }
        "window:start-drag" => {
            app.get_webview_window("main")
                .ok_or(json!({"code":"WINDOW_UNAVAILABLE"}))?
                .start_dragging()
                .map_err(|_| json!({"code":"WINDOW_UNAVAILABLE"}))?;
            Ok(Value::Null)
        }
        "window:toggle-maximize" => {
            let w = app
                .get_webview_window("main")
                .ok_or(json!({"code":"WINDOW_UNAVAILABLE"}))?;
            if w.is_maximized().unwrap_or(false) {
                w.unmaximize()
            } else {
                w.maximize()
            }
            .map_err(|_| json!({"code":"WINDOW_UNAVAILABLE"}))?;
            Ok(Value::Null)
        }
        "settings:window-background" => {
            if let Some(color) = args[0]
                .as_str()
                .and_then(|s| s.parse::<tauri::window::Color>().ok())
            {
                if let Some(w) = app.get_webview_window("main") {
                    w.set_background_color(Some(color))
                        .map_err(|_| json!({"code":"WINDOW_UNAVAILABLE"}))?;
                }
            }
            Ok(Value::Null)
        }
        _ => Err(
            json!({"code":"FIXTURE_UNSUPPORTED","message":format!("Native operation is unavailable in the isolated fixture: {method}")}),
        ),
    }
}
fn request_quit(app: &tauri::AppHandle, exit_code: i32) {
    if app.state::<Quit>().0.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    let context = app
        .state::<Arc<fixture_launch::LaunchContext>>()
        .inner()
        .clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || context.request_quit()).await;
        app.state::<Quit>().0.store(false, Ordering::Release);
        match result {
            Ok(Ok(())) => app.exit(exit_code),
            Ok(Err(error)) => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window
                        .set_title("Milagre Rust Fixture (quit pending; Stop Chat and retry)");
                }
                let _ = app.emit(
                    "native-event",
                    json!({"channel":"app:quit-blocked","payload":error}),
                );
            }
            Err(_) => {
                let _=app.emit("native-event",json!({"channel":"app:quit-blocked","payload":{"code":"FIXTURE_QUIT_FAILED","message":"Fixture quit worker failed; cleanup is not confirmed"}}));
            }
        }
    });
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().len() != 1 {
        return Err("Fixture shell accepts no path, profile or executable arguments".into());
    }
    let context = fixture_launch::LaunchContext::spawn_fixed()
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let owned = context.clone();
    let background = std::env::var("MILAGRE_BACKGROUND").as_deref() == Ok("1");
    let app=tauri::Builder::default().manage(context.clone()).manage(Quit(AtomicBool::new(false)))
        .on_page_load(|webview, payload| {
            #[cfg(feature = "fixture-native-smoke")]
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                if let Some(window) = webview.app_handle().get_webview_window("main") {
                    if let Some(smoke) = webview.app_handle().try_state::<fixture_smoke::Smoke>() { smoke.page_loaded(&window, payload.url().as_str()); }
                }
            }
            #[cfg(not(feature = "fixture-native-smoke"))]
            let _ = (webview, payload);
        })
        .invoke_handler(tauri::generate_handler![daemon,native_call,preferences_read,preferences_write,smoke_result])
        .setup(move|app|{
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), Box<dyn std::error::Error>> {
            #[cfg(feature = "fixture-native-smoke")]
            app.manage(fixture_smoke::Smoke::new(&owned).map_err(std::io::Error::other)?);
            app.manage(transport::start_fixture(app.handle().clone(),owned.clone()));
            if background{app.set_activation_policy(tauri::ActivationPolicy::Accessory);}
            let window=tauri::WebviewWindowBuilder::from_config(app.handle(),&app.config().app.windows[0])?
                .incognito(true)
                .on_navigation(|u|u.scheme()=="tauri"&&u.host_str()==Some("localhost"))
                .on_new_window(|_,_|tauri::webview::NewWindowResponse::Deny).build()?;
            shortcuts::install(app.handle()).map_err(std::io::Error::other)?;
            use tauri::menu::{Menu,MenuItem,Submenu,PredefinedMenuItem};
            let quit=MenuItem::with_id(app,"fixture-quit","Quit Milagre Rust Fixture",true,Some("CmdOrCtrl+Q"))?;
            app.set_menu(Menu::with_items(app,&[&Submenu::with_items(app,"Milagre Rust Fixture",true,&[&quit])?,&Submenu::with_items(app,"Edit",true,&[&PredefinedMenuItem::undo(app,None)?,&PredefinedMenuItem::redo(app,None)?,&PredefinedMenuItem::cut(app,None)?,&PredefinedMenuItem::copy(app,None)?,&PredefinedMenuItem::paste(app,None)?,&PredefinedMenuItem::select_all(app,None)?])?])?)?;
            app.on_menu_event(|app,event|if event.id().as_ref()=="fixture-quit"{request_quit(app,0)});
            let handle=app.handle().clone();let visible=window.clone();
            window.with_webview(move|view|unsafe{
                let webview:&objc2_web_kit::WKWebView=&*view.inner().cast();
                let persistent = webview.configuration().websiteDataStore().isPersistent();
                #[cfg(feature = "fixture-native-smoke")]
                handle.state::<fixture_smoke::Smoke>().store(persistent);
                if persistent {
                    let _=handle.emit("native-event",json!({"channel":"app:quit-blocked","payload":{"code":"FIXTURE_WEBKIT_PERSISTENT","message":"Fixture WebKit storage was persistent; refusing to show the window"}}));
                    request_quit(&handle,1);
                }else if !background{let _=visible.show();}
            })?;
            Ok(())
            }));
            if !matches!(outcome, Ok(Ok(()))) {
                // Returning an Err here makes Tauri panic inside App::run. Classify
                // failure here and finish bounded child cleanup before permitting exit.
                shortcuts::uninstall_fixture();
                if owned.abandon_on_shell_failure() {
                    app.handle().exit(1);
                } else {
                    eprintln!("Fixture setup failed; child exit is unknown, shell remains alive and private storage is retained");
                }
            }
            Ok(())
        })
        .on_window_event(|window,event|{
            #[cfg(feature = "fixture-native-smoke")]
            if matches!(event, tauri::WindowEvent::Destroyed) { if let Some(smoke)=window.try_state::<fixture_smoke::Smoke>() { smoke.destroyed(); } }
            if let tauri::WindowEvent::CloseRequested{api,..}=event{
            api.prevent_close();
            if let (Ok(position),Ok(size))=(window.outer_position(),window.inner_size()) {let _=window.state::<Arc<fixture_launch::LaunchContext>>().save_window(&json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height}));}
            request_quit(window.app_handle(),0);
        }})
        .build(tauri::generate_context!("tauri.fixture.conf.json"));
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            if !context.abandon_on_shell_failure() {
                eprintln!(
                    "Fixture build failed; child exit is unknown and private storage is retained"
                );
            }
            return Err(error.into());
        }
    };
    #[cfg(feature = "fixture-native-smoke")]
    fixture_smoke::watchdog(app.handle().clone());
    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            shortcuts::uninstall_fixture();
            let context = app.state::<Arc<fixture_launch::LaunchContext>>();
            if context.clean() {
                let cleanup = context.remove_shell_storage();
                #[cfg(feature = "fixture-native-smoke")]
                if let Some(smoke) = app.try_state::<fixture_smoke::Smoke>() {
                    smoke.exit(&cleanup);
                }
                if let Err(error) = cleanup {
                    eprintln!(
                        "Fixture clean exit could not remove private storage: {}",
                        error["code"]
                    );
                }
            }
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let context = app.state::<Arc<fixture_launch::LaunchContext>>();
            if !context.clean() && !context.failure_exit_allowed() {
                api.prevent_exit();
                request_quit(app, 0);
            }
        }
    });
    // tao may process::exit, so no cleanup relies on reaching this line.
    drop(context);
    Ok(())
}
