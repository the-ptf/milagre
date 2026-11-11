//! Captures the real hidden WKWebView for local migration checks; never fabricates a UI image.
//! Enabled only by MILAGRE_RUST_SMOKE=1. The callback writes a completion report separately.
use tauri::Manager;

pub fn snapshot(app: &tauri::AppHandle) -> Result<(), String> {
    if std::env::var("MILAGRE_RUST_SMOKE").as_deref() != Ok("1") {
        return Err("UI capture is enabled only for local smoke checks".into());
    }
    let _ = std::fs::write("/tmp/milagre-rust-capture.json", r#"{"pending":true}"#);
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    window
        .with_webview(|view| {
            use block2::RcBlock;
            use objc2::{AnyThread, MainThreadMarker};
            use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
            use objc2_foundation::{NSDictionary, NSError, NSString};
            use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
            // Tauri guarantees with_webview runs on the platform UI thread, and `inner` is its
            // live WKWebView pointer. Completion owns its arguments for this callback only.
            unsafe {
                let Some(mtm) = MainThreadMarker::new() else {
                    report(Err("Capture callback did not run on the main thread".into()));
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
                        if !png.writeToFile_atomically(
                            &NSString::from_str("/tmp/milagre-rust-ui.png"),
                            true,
                        ) {
                            return Err("Could not write snapshot PNG".into());
                        }
                        Ok(())
                    })();
                    report(result);
                });
                webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &completion);
            }
        })
        .map_err(|error| error.to_string())
}
fn report(result: Result<(), String>) {
    let value = match result {
        Ok(()) => {
            serde_json::json!({"ok":true,"path":"/tmp/milagre-rust-ui.png","source":"actual WKWebView snapshot"})
        }
        Err(message) => serde_json::json!({"ok":false,"error":message}),
    };
    let _ = std::fs::write("/tmp/milagre-rust-capture.json", value.to_string());
}
