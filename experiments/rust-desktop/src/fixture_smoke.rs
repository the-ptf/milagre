//! Fixed native smoke sequence. Evidence lives outside the disposable shell profile.
use crate::fixture_launch::LaunchContext;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
};
use tauri::Manager;

pub struct Smoke {
    root: PathBuf,
    nonce: String,
    phase: AtomicU8,
    store: AtomicU8,
    submitted: AtomicBool,
    report: Mutex<Value>,
}
fn scenario() -> &'static str {
    if cfg!(feature = "fixture-content-smoke") {
        "content"
    } else if cfg!(feature = "fixture-send-smoke") {
        "send"
    } else {
        "storage"
    }
}
impl Smoke {
    pub fn new(context: &LaunchContext) -> Result<Self, String> {
        let temp = tempfile::Builder::new()
            .prefix("milagre-fixture-evidence-")
            .tempdir_in(fs::canonicalize("/tmp").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let root = temp.keep();
        let nonce = root.file_name().unwrap().to_string_lossy().into_owned();
        let report = json!({"schemaVersion":1,"scenario":scenario(),"source":"actual background WKWebView, production renderer, isolated scripted Rust owner","identity":context.smoke_identity(),"evidenceRoot":root,"passed":false,"cookies":"not tested","nativeDeallocation":"not observed","stages":[]});
        let value = Self {
            root,
            nonce,
            phase: AtomicU8::new(0),
            store: AtomicU8::new(0),
            submitted: AtomicBool::new(false),
            report: Mutex::new(report),
        };
        value.write()?;
        let line=json!({"fixtureSmoke":value.report.lock().map_err(|_|"Smoke lock poisoned")?["identity"],"evidenceRoot":value.root}).to_string()+"\n";
        std::io::stdout()
            .write_all(line.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(value)
    }
    fn write(&self) -> Result<(), String> {
        let report = self.report.lock().map_err(|_| "Smoke lock poisoned")?;
        let bytes = serde_json::to_vec_pretty(&*report).map_err(|e| e.to_string())?;
        if bytes.len() > 256 * 1024 {
            return Err("Smoke report exceeds 256 KiB".into());
        }
        crate::evidence::write(self.root.join("report.json"), &bytes)
    }
    pub fn store(&self, persistent: bool) {
        self.store
            .store(if persistent { 2 } else { 1 }, Ordering::Release);
        if let Ok(mut report) = self.report.lock() {
            report["isPersistent"] = json!(persistent);
        }
        let _ = self.write();
    }
    pub fn context(&self, project: &std::path::Path) -> Result<Value, Value> {
        if self.store.load(Ordering::Acquire) != 1 {
            return Err(
                json!({"code":"SMOKE_STORE_NOT_READY","message":"Nonpersistent native store not confirmed"}),
            );
        }
        Ok(
            json!({"phase":self.phase.load(Ordering::Acquire),"nonce":self.nonce,"project":project,"scenario":scenario()}),
        )
    }
    pub fn page_loaded(&self, window: &tauri::WebviewWindow, url: &str) {
        if let Ok(mut report) = self.report.lock() {
            report["lastPageLoaded"] = json!(url);
        }
        let _ = self.write();
        if self.phase.load(Ordering::Acquire) < 2 {
            #[cfg(feature = "fixture-send-smoke")]
            let _ = window.eval(include_str!("../renderer/fixture-send-smoke.js"));
            #[cfg(feature = "fixture-content-smoke")]
            let _ = window.eval(include_str!("../renderer/fixture-content-smoke.js"));
            let evaluated = window.eval(include_str!("../renderer/fixture-native-smoke.js"));
            if let Ok(mut report) = self.report.lock() {
                report["probeEvaluation"] = match evaluated {
                    Ok(()) => json!({"ok":true}),
                    Err(e) => json!({"ok":false,"error":e.to_string()}),
                };
            }
            let _ = self.write();
        }
    }
    pub fn exit(&self, cleanup: &Result<(), Value>) {
        if let Ok(mut report) = self.report.lock() {
            report["exitCleanup"] = match cleanup {
                Ok(()) => json!({"ok":true}),
                Err(e) => json!({"ok":false,"error":e}),
            };
        }
        let _ = self.write();
    }
    pub fn destroyed(&self) {
        if let Ok(mut report) = self.report.lock() {
            report["windowDestroyed"] = json!(true);
        }
        let _ = self.write();
    }
}
pub async fn result(app: tauri::AppHandle, value: String) -> Result<Value, String> {
    if value.len() > 64 * 1024 {
        return Err("Fixture smoke payload exceeds 64 KiB".into());
    }
    let result: Value = serde_json::from_str(&value).map_err(|e| e.to_string())?;
    let smoke = app.state::<Smoke>();
    let phase = smoke.phase.load(Ordering::Acquire);
    if phase >= 2 || result["phase"].as_u64() != Some(phase.into()) {
        return Err("Unexpected fixture smoke phase".into());
    }
    if smoke.submitted.swap(true, Ordering::AcqRel) {
        return Err("Fixture smoke phase already submitted".into());
    }
    let scenario_ok = if cfg!(feature = "fixture-send-smoke") {
        if phase == 0 {
            result["send"]["stage"] == "complete"
        } else {
            result["send"]["reloadSurvived"] == true
        }
    } else {
        true
    };
    let content_ok =
        !cfg!(feature = "fixture-content-smoke") || result["content"]["stage"] == "complete";
    let passed = result["passed"] == true
        && smoke.store.load(Ordering::Acquire) == 1
        && scenario_ok
        && content_ok;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window missing")?;
    let mut stage = result;
    stage["nativeDocumentProbe"] = document_probe(&window).await;
    match crate::snapshot::png(&window).await {
        Ok(png) if png.bytes.len() <= 32 * 1024 * 1024 => {
            let filename = if phase == 0 {
                "before-reload.png"
            } else {
                "after-reload.png"
            };
            crate::evidence::write(smoke.root.join(filename), &png.bytes)?;
            stage["capture"] = json!({"file":filename,"width":png.width,"height":png.height,"bytes":png.bytes.len(),"source":"native WKWebView content-area PNG"});
        }
        Ok(_) => stage["captureError"] = json!("PNG exceeds 32 MiB"),
        Err(e) => stage["captureError"] = json!(e),
    }
    let passed = passed && stage.get("captureError").is_none();
    {
        let mut report = smoke.report.lock().map_err(|_| "Smoke lock poisoned")?;
        report["stages"].as_array_mut().unwrap().push(stage);
        report["passed"] = json!(passed && phase == 1);
    }
    smoke.write()?;
    if passed && phase == 0 {
        smoke.phase.store(1, Ordering::Release);
        smoke.submitted.store(false, Ordering::Release);
        window
            .eval("location.reload()")
            .map_err(|e| e.to_string())?;
        return Ok(json!({"reloading":true}));
    }
    smoke.phase.store(2, Ordering::Release);
    let context = app.state::<Arc<LaunchContext>>().inner().clone();
    let quit = tauri::async_runtime::spawn_blocking(move || context.request_quit())
        .await
        .map_err(|e| e.to_string())?;
    {
        let mut report = smoke.report.lock().map_err(|_| "Smoke lock poisoned")?;
        report["ownerStop"] = match &quit {
            Ok(()) => json!({"ok":true}),
            Err(e) => json!({"ok":false,"error":e}),
        };
        if quit.is_err() {
            report["passed"] = json!(false);
        }
    }
    smoke.write()?;
    if quit.is_ok() {
        app.exit(if passed { 0 } else { 1 });
    }
    Ok(json!({"passed":passed,"quit":quit.is_ok()}))
}

pub fn watchdog(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(40);
        let _ = tauri::async_runtime::spawn_blocking(|| {
            std::thread::sleep(std::time::Duration::from_secs(3))
        })
        .await;
        if let Some(window) = app.get_webview_window("main") {
            let probe = document_probe(&window).await;
            let smoke = app.state::<Smoke>();
            if let Ok(mut report) = smoke.report.lock() {
                report["startupDocumentProbe"] = probe;
            }
            let _ = smoke.write();
        }
        let _ = tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(deadline.saturating_duration_since(std::time::Instant::now()))
        })
        .await;
        let phase = app.state::<Smoke>().phase.load(Ordering::Acquire);
        if phase < 2 {
            let _ = result(app, json!({"phase":phase,"passed":false,"error":"Native smoke exceeded its fixed 40-second deadline"}).to_string()).await;
        }
    });
}

async fn document_probe(window: &tauri::WebviewWindow) -> Value {
    let (send, recv) = std::sync::mpsc::sync_channel(1);
    let script = r#"({url:location.href,readyState:document.readyState,title:document.title,tauri:typeof window.__TAURI__,bridge:typeof window.milagre,probeStarted:!!window.__fixtureNativeSmoke,sendProbe:window.__fixtureSendTrace??null,contentProbe:window.__fixtureContentTrace??null,frames:[...document.querySelectorAll("iframe")].map(f=>({src:f.src,title:f.title,sandbox:f.getAttribute("sandbox")})),rootChildren:document.getElementById('root')?.childElementCount,text:document.body?.innerText.slice(0,3000),diagnostics:window.__rustDiagnostics?{ready:window.__rustDiagnostics.ready,errors:window.__rustDiagnostics.errors.slice(-30),calls:window.__rustDiagnostics.calls.slice(-40).map(({method,error,pending})=>({method,error,pending}))}:null})"#;
    if let Err(error) = window.eval_with_callback(script, move |value| {
        let _ = send.send(value);
    }) {
        return json!({"error":error.to_string()});
    }
    match tauri::async_runtime::spawn_blocking(move || {
        recv.recv_timeout(std::time::Duration::from_secs(5))
    })
    .await
    {
        Ok(Ok(value)) => serde_json::from_str(&value)
            .unwrap_or_else(|_| json!({"raw":value.chars().take(8192).collect::<String>()})),
        _ => json!({"error":"Native document probe timed out"}),
    }
}
