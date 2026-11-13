//! Captures the real hidden WKWebView for local migration checks; never fabricates a UI image.
//! Enabled only by MILAGRE_RUST_SMOKE=1. The callback writes a completion report separately.
use tauri::Manager;

#[derive(Clone, Copy)]
pub enum Kind {
    Default,
    Chat,
    Designs,
    Artifacts,
}
impl Kind {
    pub fn parse(label: Option<&str>) -> Result<Self, String> {
        match label {
            None => Ok(Self::Default),
            Some("chat") => Ok(Self::Chat),
            Some("designs") => Ok(Self::Designs),
            Some("artifacts") => Ok(Self::Artifacts),
            Some(_) => Err("Capture label must be chat, designs or artifacts".into()),
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Default => "ui",
            Self::Chat => "chat",
            Self::Designs => "designs",
            Self::Artifacts => "artifacts",
        }
    }
    pub fn state_path(self) -> String {
        match self {
            Self::Default => "/tmp/milagre-rust-smoke.json".into(),
            _ => format!("/tmp/milagre-rust-{}-state.json", self.label()),
        }
    }
    fn image_path(self) -> String {
        format!("/tmp/milagre-rust-{}.png", self.label())
    }
    fn report_path(self) -> String {
        match self {
            Self::Default => "/tmp/milagre-rust-capture.json".into(),
            _ => format!("/tmp/milagre-rust-capture-{}.json", self.label()),
        }
    }
}

pub async fn snapshot(app: &tauri::AppHandle, kind: Kind) -> Result<serde_json::Value, String> {
    if std::env::var("MILAGRE_RUST_SMOKE").as_deref() != Ok("1") {
        return Err("UI capture is enabled only for local smoke checks".into());
    }
    crate::evidence::write(kind.report_path(), br#"{"pending":true}"#)?;
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    let result: Result<serde_json::Value, String> = async {
        let png = crate::snapshot::png(&window).await?;
        crate::evidence::write(kind.image_path(), &png.bytes)?;
        Ok(serde_json::json!({"ok":true,"label":kind.label(),"path":kind.image_path(),"source":"actual WKWebView content-area snapshot","width":png.width,"height":png.height,"bytes":png.bytes.len()}))
    }.await;
    let report = match &result {
        Ok(value) => value.clone(),
        Err(message) => serde_json::json!({"ok":false,"error":message}),
    };
    crate::evidence::write(kind.report_path(), report.to_string().as_bytes())?;
    result
}
