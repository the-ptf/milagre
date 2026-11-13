fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "daemon",
            "native_call",
            "preferences_read",
            "preferences_write",
            "smoke_result",
        ]),
    ))
    .expect("build Tauri application");
}
