//! Path-free snapshot of the actual WKWebView. Callers own evidence destinations.
pub struct Png {
    pub bytes: Vec<u8>,
    pub width: isize,
    pub height: isize,
}
pub async fn png(window: &tauri::WebviewWindow) -> Result<Png, String> {
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
                        Ok(Png {
                            bytes: png.to_vec(),
                            width: bitmap.pixelsWide(),
                            height: bitmap.pixelsHigh(),
                        })
                    })();
                    let _ = sender.send(result);
                });
                webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &completion);
            }
        })
        .map_err(|error| error.to_string())?;
    // The future resolves only after WebKit encoded the real image. The caller writes it.
    // Waiting on a worker leaves the macOS main run loop free to invoke its callback.
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(std::time::Duration::from_secs(25))
            .map_err(|error| format!("WebKit capture did not complete: {error}"))?
    })
    .await
    .map_err(|error| error.to_string())?
}
