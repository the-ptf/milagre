//! Saves renderer-created downloads through an explicit, parented native dialog.
//! The renderer supplies bytes, never a local path or a remote URL to fetch.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const MAX_DOWNLOAD_BYTES: usize = 64 * 1024 * 1024;
const MAX_ENCODED_BYTES: usize = MAX_DOWNLOAD_BYTES.div_ceil(3) * 4;
type Reply = Result<Value, Value>;

fn error(message: &str) -> Value {
    json!({"code":"DOWNLOAD_ERROR","message":message})
}

fn filename(value: &str) -> Result<String, Value> {
    // A download name is a suggestion, never an authority to choose a path. Match
    // browser basename behavior for either separator, then reject hidden controls.
    let name = value.rsplit(['/', '\\']).next().unwrap_or("").trim();
    if name.is_empty()
        || [".", ".."].contains(&name)
        || name.len() > 240
        || name
            .chars()
            .any(|character| character.is_control() || character == ':')
    {
        return Err(error("Choose a valid download filename."));
    }
    Ok(name.to_owned())
}

struct Download {
    name: String,
    bytes: Vec<u8>,
}

fn decode(input: &Value) -> Result<Download, Value> {
    let name = filename(input["name"].as_str().unwrap_or(""))?;
    let size = input["size"]
        .as_u64()
        .ok_or_else(|| error("Invalid download size."))?;
    let encoded = input["base64"]
        .as_str()
        .ok_or_else(|| error("Download data is missing."))?;
    if size > MAX_DOWNLOAD_BYTES as u64 || encoded.len() > MAX_ENCODED_BYTES {
        return Err(error(
            "Downloads larger than 64 MiB are not supported in this Rust build.",
        ));
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| error("Couldn't read the download data."))?;
    if bytes.len() as u64 != size || bytes.len() > MAX_DOWNLOAD_BYTES {
        return Err(error("Download data does not match its declared size."));
    }
    Ok(Download { name, bytes })
}

async fn save(app: &AppHandle, download: Download) -> Reply {
    // Background verification must never open a dialog or write a download.
    if std::env::var("MILAGRE_BACKGROUND").as_deref() == Ok("1") {
        return Ok(Value::Null);
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| error("Open Milagre Rust to save a download."))?;
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("Save File")
        .set_file_name(&download.name);
    if let Ok(directory) = app.path().download_dir() {
        dialog = dialog.set_directory(directory);
    }
    let Some(destination) = dialog.save_file().await else {
        return Ok(Value::Null);
    };
    let path = destination.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, download.bytes)
            .map_err(|cause| error(&format!("Couldn't save the download: {cause}")))?;
        Ok(json!(path.to_string_lossy()))
    })
    .await
    .map_err(|cause| error(&cause.to_string()))?
}

pub async fn invoke(app: &AppHandle, method: &str, args: &Value) -> Option<Reply> {
    if method != "download:save" {
        return None;
    }
    let input = args[0].clone();
    Some(
        match tauri::async_runtime::spawn_blocking(move || decode(&input)).await {
            Ok(Ok(download)) => save(app, download).await,
            Ok(Err(error)) => Err(error),
            Err(cause) => Err(error(&cause.to_string())),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_are_basename_suggestions() {
        assert_eq!(
            filename("../../designs.milagre-design-page.json").unwrap(),
            "designs.milagre-design-page.json"
        );
        assert_eq!(
            filename("C:\\Users\\Downloads\\design.png").unwrap(),
            "design.png"
        );
        assert_eq!(
            filename(" Design revisão.svg ").unwrap(),
            "Design revisão.svg"
        );
        for invalid in [
            "",
            ".",
            "..",
            "folder/",
            "bad\nname.png",
            "bad\0name.png",
            "file:stream",
            &"a".repeat(241),
        ] {
            assert!(filename(invalid).is_err(), "accepted {invalid:?}");
        }
    }

    #[test]
    fn download_bytes_are_bounded_and_match_declared_size() {
        let valid = json!({"name":"design.svg","size":4,"base64":"PHN2Zw=="});
        let download = decode(&valid).unwrap();
        assert_eq!(download.name, "design.svg");
        assert_eq!(download.bytes, b"<svg");
        assert!(decode(&json!({"name":"empty.txt","size":0,"base64":""}))
            .unwrap()
            .bytes
            .is_empty());
        for invalid in [
            json!({"name":"design.svg","size":5,"base64":"PHN2Zw=="}),
            json!({"name":"design.svg","size":4,"base64":"%%%"}),
            json!({"name":"design.svg","size":-1,"base64":""}),
            json!({"name":"design.svg","size":MAX_DOWNLOAD_BYTES+1,"base64":""}),
            json!({"name":"design.svg","size":0,"url":"file:///etc/passwd"}),
        ] {
            assert!(decode(&invalid).is_err());
        }
    }
}
