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
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    window
        .with_webview(move |view| {
            use block2::RcBlock;
            use objc2::{AnyThread, MainThreadMarker};
            use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
            use objc2_foundation::{NSDictionary, NSError};
            use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
            // Tauri guarantees with_webview runs on the platform UI thread, and `inner` is its
            // live WKWebView pointer. Completion owns its arguments for this callback only.
            unsafe {
                let Some(mtm) = MainThreadMarker::new() else {
                    let _ =
                        sender.send(Err("Capture callback did not run on the main thread".into()));
                    return;
                };
                let webview: &WKWebView = &*view.inner().cast();
                let config = WKSnapshotConfiguration::new(mtm);
                // Waiting for a screen update can stall a window kept hidden by background mode.
                config.setAfterScreenUpdates(false);
                let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let result = (|| {
                        if !error.is_null() {
                            return Err(format!(
                                "WebKit snapshot failed: {}",
                                (*error).localizedDescription()
                            ));
                        }
                        let image = image.as_ref().ok_or("WebKit returned no snapshot")?;
                        let tiff = image
                            .TIFFRepresentation()
                            .ok_or("Could not encode snapshot TIFF")?;
                        let bitmap =
                            NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                                .ok_or("Could not decode snapshot pixels")?;
                        let png = bitmap
                            .representationUsingType_properties(
                                NSBitmapImageFileType::PNG,
                                &NSDictionary::new(),
                            )
                            .ok_or("Could not encode snapshot PNG")?;
                        crate::evidence::write(kind.image_path(), &png.to_vec())?;
                        Ok(serde_json::json!({
                            "ok":true,"label":kind.label(),"path":kind.image_path(),
                            "source":"actual WKWebView content-area snapshot",
                            "width":bitmap.pixelsWide(),"height":bitmap.pixelsHigh(),
                            "bytes":png.len()
                        }))
                    })();
                    let _ = sender.send(result);
                });
                webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &completion);
            }
        })
        .map_err(|error| error.to_string())?;
    // An invoke resolves only after WebKit encoded and privately wrote the real image.
    // Waiting on a worker leaves the macOS main run loop free to invoke its callback.
    let result = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(25))
            .map_err(|error| format!("WebKit capture did not complete: {error}"))?
    })
    .await
    .map_err(|error| error.to_string())?;
    let report = match &result {
        Ok(value) => value.clone(),
        Err(message) => serde_json::json!({"ok":false,"error":message}),
    };
    crate::evidence::write(kind.report_path(), report.to_string().as_bytes())?;
    result
}
