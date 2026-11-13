//! Explicit JSON plan driving production DOM controls. It never accepts JavaScript or a daemon endpoint.
use crate::fixture_launch::LaunchContext;
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::Manager;

pub fn plan() -> Result<Option<Value>, String> {
    let Some(path) = std::env::var_os("MILAGRE_CHAT_SMOKE_CONFIG") else {
        return Ok(None);
    };
    if !Path::new(&path).is_absolute() {
        return Err("Smoke plan path must be absolute".into());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != unsafe { libc::getuid() }
        || meta.mode() & 0o777 != 0o600
        || meta.len() > 32 * 1024
    {
        return Err(
            "Smoke plan must be an owned single-link 0600 JSON file, at most 32 KiB".into(),
        );
    }
    let mut bytes = Vec::new();
    file.take(32 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate(&value)?;
    Ok(Some(value))
}
fn validate(value: &Value) -> Result<(), String> {
    let fields = [
        "mode",
        "sessionId",
        "body",
        "expectedText",
        "permission",
        "content",
        "resumeContent",
    ];
    if value
        .as_object()
        .is_none_or(|v| v.keys().any(|k| !fields.contains(&k.as_str())))
        || value["sessionId"] != 1
        || !matches!(value["mode"].as_str(), Some("observe" | "send" | "content"))
    {
        return Err(
            "Smoke plan requires mode observe/send/content and existing sessionId 1".into(),
        );
    }
    if matches!(value["mode"].as_str(), Some("send" | "content"))
        && value["body"]
            .as_str()
            .is_none_or(|s| s.is_empty() || s.len() > 16 * 1024 || s.contains('\0'))
    {
        return Err("Send requires body of 1..16384 bytes without NUL".into());
    }
    if value["mode"] == "observe"
        && (value.get("body").is_some() || value.get("permission").is_some())
    {
        return Err("Observe cannot request a send or permission answer".into());
    }
    if value
        .get("expectedText")
        .is_some_and(|s| s.as_str().is_none_or(|s| s.is_empty() || s.len() > 8192))
    {
        return Err("Invalid expectedText".into());
    }
    if let Some(permission) = value.get("permission") {
        if permission.as_object().is_none_or(|v| {
            v.len() != 3
                || v.keys()
                    .any(|k| !["tool", "path", "decision"].contains(&k.as_str()))
        }) || permission["tool"] != "Write"
            || !matches!(permission["decision"].as_str(), Some("allow" | "deny"))
            || permission["path"]
                .as_str()
                .is_none_or(|p| p.len() > 4096 || !Path::new(p).is_absolute() || p.contains('\0'))
        {
            return Err("Permission plan requires exact Write path and explicit allow/deny".into());
        }
    }
    if value["mode"] == "content" {
        if value
            .get("resumeContent")
            .is_some_and(|value| !value.is_boolean())
        {
            return Err("resumeContent must be an explicit boolean".into());
        }
        let content = &value["content"];
        let exact = |v: &Value, keys: &[&str]| {
            v.as_object()
                .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
        };
        let text = |v: &Value| {
            v.as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 1024 && !s.contains('\0'))
        };
        let id = |v: &Value| {
            v.as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 96
                    && s.bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        };
        let node = content["design"]["nodeId"].as_str().is_some_and(|s| {
            !s.is_empty()
                && s.len() <= 96
                && s.as_bytes()[0].is_ascii_alphabetic()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        });
        if value.get("permission").is_some()
            || !exact(content, &["html", "design"])
            || !exact(&content["html"], &["id", "marker"])
            || !exact(
                &content["design"],
                &["id", "nodeId", "beforeText", "afterText"],
            )
            || !id(&content["html"]["id"])
            || !id(&content["design"]["id"])
            || content["html"]["id"] == content["design"]["id"]
            || !node
            || !text(&content["html"]["marker"])
            || !text(&content["design"]["beforeText"])
            || !text(&content["design"]["afterText"])
            || content["design"]["beforeText"] == content["design"]["afterText"]
        {
            return Err("Content requires distinct exact HTML/Design IDs, a marker and one explicit text-layer edit; no generic permission override".into());
        }
    } else if value.get("content").is_some() || value.get("resumeContent").is_some() {
        return Err("Content actions require explicit content mode".into());
    }
    Ok(())
}
pub struct Smoke {
    root: PathBuf,
    plan: Value,
    identity: Value,
    phase: AtomicU8,
    store: AtomicU8,
    submitted: AtomicBool,
    html_captured: AtomicU8,
    finished: AtomicBool,
    report: Mutex<Value>,
}
impl Smoke {
    pub fn new(context: &LaunchContext, plan: Value) -> Result<Self, String> {
        if let Some(path) = plan["permission"]["path"].as_str() {
            let path = Path::new(path);
            if !path.starts_with(context.project())
                || path.components().any(|c| {
                    matches!(
                        c,
                        std::path::Component::ParentDir | std::path::Component::CurDir
                    )
                })
            {
                return Err("Permission file must be within this dedicated Project".into());
            }
        }
        let root = tempfile::Builder::new()
            .prefix("milagre-chat-evidence-")
            .tempdir_in(fs::canonicalize("/tmp").map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?
            .keep();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let identity = context.smoke_identity();
        let report = json!({"schemaVersion":1,"source":"actual WKWebView and production React controls, owned configured Rust Chat runtime","identity":identity,"evidenceRoot":root,"mode":plan["mode"],"passed":false,"stages":[]});
        let smoke = Self {
            root,
            plan,
            identity,
            phase: AtomicU8::new(0),
            store: AtomicU8::new(0),
            submitted: AtomicBool::new(false),
            html_captured: AtomicU8::new(0),
            finished: AtomicBool::new(false),
            report: Mutex::new(report),
        };
        smoke.write()?;
        writeln!(
            std::io::stdout(),
            "{}",
            json!({"chatDesktop":smoke.identity,"evidenceRoot":smoke.root})
        )
        .map_err(|e| e.to_string())?;
        Ok(smoke)
    }
    fn write(&self) -> Result<(), String> {
        crate::evidence::write(
            self.root.join("report.json"),
            &serde_json::to_vec_pretty(&*self.report.lock().map_err(|_| "Smoke lock poisoned")?)
                .map_err(|e| e.to_string())?,
        )
    }
    pub fn store(&self, persistent: bool) {
        self.store
            .store(if persistent { 2 } else { 1 }, Ordering::Release);
        self.report.lock().unwrap()["isPersistent"] = json!(persistent);
        let _ = self.write();
    }
    pub fn progress(&self, value: &Value) -> Result<Value, Value> {
        let label = value["label"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or_else(|| json!({"code":"INVALID_SMOKE_PROGRESS"}))?;
        if value["phase"] != self.phase.load(Ordering::Acquire)
            || self.finished.load(Ordering::Acquire)
        {
            return Err(json!({"code":"STALE_SMOKE_PROGRESS"}));
        }
        self.report.lock().unwrap()["progress"] = json!({"phase":value["phase"],"label":label});
        self.write()
            .map_err(|error| json!({"code":"SMOKE_PROGRESS_IO","message":error}))?;
        Ok(Value::Null)
    }
    pub fn context(&self, project: &Path) -> Result<Value, Value> {
        if self.store.load(Ordering::Acquire) != 1 {
            return Err(json!({"code":"SMOKE_STORE_NOT_READY"}));
        }
        Ok(
            json!({"phase":self.phase.load(Ordering::Acquire),"project":project,"model":self.identity["model"],"plan":self.plan}),
        )
    }
    pub fn page_loaded(&self, window: &tauri::WebviewWindow) {
        if !self.finished.load(Ordering::Acquire) {
            let _ = window.eval(include_str!("../renderer/chat-native-smoke.js"));
        }
    }
    pub fn exit(&self, cleanup: &Result<(), Value>) {
        self.report.lock().unwrap()["exit"] = json!({"cleanOwnerExit":true,"shellStorageRemoved":cleanup.is_ok(),"dataRootPreserved":self.identity["dataRoot"].as_str().is_some_and(|p|Path::new(p).is_dir())});
        let _ = self.write();
    }
}
pub async fn result(app: tauri::AppHandle, value: String) -> Result<Value, String> {
    if value.len() > 256 * 1024 {
        return Err("Smoke result exceeds 256 KiB".into());
    }
    let smoke = app.try_state::<Smoke>().ok_or("No explicit smoke plan")?;
    let mut stage: Value = serde_json::from_str(&value).map_err(|e| e.to_string())?;
    let phase = smoke.phase.load(Ordering::Acquire);
    if stage["phase"] != phase || smoke.finished.load(Ordering::Acquire) {
        return Err("Stale smoke result".into());
    }
    if stage.get("checkpoint").is_some() {
        if stage["checkpoint"] != "html"
            || smoke.plan["mode"] != "content"
            || smoke.submitted.load(Ordering::Acquire)
            || smoke.html_captured.fetch_or(1 << phase, Ordering::AcqRel) & (1 << phase) != 0
        {
            return Err("Unknown or duplicate content checkpoint".into());
        }
        let window = app
            .get_webview_window("main")
            .ok_or("Main window unavailable")?;
        let png = crate::snapshot::png(&window).await?;
        if png.bytes.len() > 32 * 1024 * 1024 {
            return Err("PNG exceeds 32 MiB".into());
        }
        let file = if phase == 0 {
            "html-before-reload.png"
        } else {
            "html-after-reload.png"
        };
        crate::evidence::write(smoke.root.join(file), &png.bytes)?;
        let capture =
            json!({"file":file,"width":png.width,"height":png.height,"bytes":png.bytes.len()});
        {
            let mut report = smoke.report.lock().map_err(|_| "Smoke lock poisoned")?;
            if report.get("contentCaptures").is_none() {
                report["contentCaptures"] = json!([]);
            }
            report["contentCaptures"]
                .as_array_mut()
                .unwrap()
                .push(json!({"phase":phase,"capture":capture}));
        }
        smoke.write()?;
        return Ok(json!({"captured":true,"capture":capture}));
    }
    if smoke.submitted.swap(true, Ordering::AcqRel) {
        return Err("Duplicate or stale smoke result".into());
    }
    smoke.report.lock().map_err(|_| "Smoke lock poisoned")?["pendingStage"] = stage.clone();
    smoke.write()?;
    if smoke.plan["mode"] == "content"
        && !smoke.report.lock().map_err(|_| "Smoke lock poisoned")?["contentCaptures"]
            .as_array()
            .is_some_and(|v| v.iter().any(|capture| capture["phase"] == phase))
    {
        stage["passed"] = json!(false);
        stage["missingHtmlCapture"] = json!(true);
        if stage.get("error").is_none() {
            stage["error"] = json!("Missing successful native HTML capture");
        }
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    match crate::snapshot::png(&window).await {
        Ok(png) if png.bytes.len() <= 32 * 1024 * 1024 => {
            let file = if phase == 0 {
                "before-reload.png"
            } else {
                "after-reload.png"
            };
            crate::evidence::write(smoke.root.join(file), &png.bytes)?;
            stage["capture"] =
                json!({"file":file,"width":png.width,"height":png.height,"bytes":png.bytes.len()});
        }
        Ok(_) => stage["captureError"] = json!("PNG exceeds 32 MiB"),
        Err(error) => stage["captureError"] = json!(error),
    }
    let passed = stage["passed"] == true && stage.get("captureError").is_none();
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
    smoke.finished.store(true, Ordering::Release);
    crate::request_quit(&app, if passed { 0 } else { 1 });
    Ok(json!({"passed":passed}))
}
pub fn watchdog(app: tauri::AppHandle) {
    if app.try_state::<Smoke>().is_none() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(180));
        if let Some(smoke) = app.try_state::<Smoke>() {
            if !smoke.finished.swap(true, Ordering::AcqRel) {
                smoke.report.lock().unwrap()["timeout"] = json!(
                    "Native smoke exceeded 180 seconds; requesting owned Quit without resending"
                );
                let _ = smoke.write();
                crate::request_quit(&app, 1);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plans_require_explicit_send_and_exact_permission() {
        assert!(validate(&json!({"mode":"observe","sessionId":1})).is_ok());
        assert!(validate(&json!({"mode":"observe","sessionId":1,"permission":{"tool":"Write","path":"/tmp/x","decision":"allow"}})).is_err());
        assert!(validate(&json!({"mode":"send","sessionId":1,"body":"send","permission":{"tool":"Write","path":"/tmp/x","decision":"allow"}})).is_ok());
        assert!(validate(&json!({"mode":"send","sessionId":1,"body":"send","permission":{"tool":"Write","path":"/tmp/x","decision":"allow-for-chat"}})).is_err());
    }
    #[test]
    fn content_plan_bounds_exact_creation_and_one_changed_text_layer() {
        let plan = json!({"mode":"content","sessionId":1,"body":"Create the requested page and screen","content":{
            "html":{"id":"live-page","marker":"HTML marker"},
            "design":{"id":"live-screen","nodeId":"heading","beforeText":"Original","afterText":"Edited"}
        }});
        assert!(validate(&plan).is_ok());
        for (pointer, replacement) in [
            ("/mode", json!("send")),
            ("/sessionId", json!(2)),
            ("/body", json!("")),
            ("/content/html/id", json!("../page")),
            ("/content/html/id", json!("live-screen")),
            ("/content/html/marker", json!("")),
            ("/content/html/marker", json!("x".repeat(1025))),
            ("/content/design/nodeId", json!("heading\"] button")),
            ("/content/design/beforeText", json!("Edited")),
            ("/content/design/afterText", json!("edited\0text")),
        ] {
            let mut invalid = plan.clone();
            *invalid.pointer_mut(pointer).unwrap() = replacement;
            assert!(validate(&invalid).is_err(), "accepted {pointer}");
        }
        for (field, value) in [
            (
                "permission",
                json!({"tool":"Write","path":"/tmp/file","decision":"allow"}),
            ),
            ("allowAll", json!(true)),
        ] {
            let mut invalid = plan.clone();
            invalid[field] = value;
            assert!(validate(&invalid).is_err());
        }
        let mut invalid = plan;
        invalid["content"]["design"]["from"] = json!("preexisting-copy");
        assert!(validate(&invalid).is_err());
    }
}
