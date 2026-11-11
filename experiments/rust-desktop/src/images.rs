//! Native image actions, preserving the renderer's existing path/data-URL contract.
use base64::{
    alphabet,
    engine::{
        general_purpose::{GeneralPurpose, GeneralPurposeConfig},
        DecodePaddingMode,
    },
    Engine,
};
use regex::Regex;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::{AppHandle, Emitter, Manager};

type Reply = Result<Value, Value>;
const MAX_IMAGE_BYTES: usize = 64 * 1024 * 1024;
const COPY_ID: &str = "milagre-rust.image.copy";
const SAVE_ID: &str = "milagre-rust.image.save";
fn error(message: &str) -> Value {
    json!({"code":"IMAGE_ERROR","message":message})
}
fn background() -> bool {
    std::env::var("MILAGRE_BACKGROUND").as_deref() == Ok("1")
}
fn extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    ["png", "jpg", "jpeg", "webp", "gif"]
        .contains(&ext.as_str())
        .then_some(ext)
}
fn require_image(source: &str) -> Result<PathBuf, Value> {
    let requested = Path::new(source);
    if !requested.is_absolute() || extension(requested).is_none() {
        return Err(error("Not an image file."));
    }
    let real = requested
        .canonicalize()
        .map_err(|_| error("Not an image file."))?;
    if extension(&real).is_none() || !real.is_file() {
        return Err(error("Not an image file."));
    }
    Ok(real)
}
struct ImageSource {
    bytes: Vec<u8>,
    extension: String,
    filename: String,
}
fn image_data(source: &str) -> Result<Option<(String, Vec<u8>)>, Value> {
    static DATA: OnceLock<Regex> = OnceLock::new();
    let pattern = DATA.get_or_init(|| {
        Regex::new(r"^data:image/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$").unwrap()
    });
    if source.len() > MAX_IMAGE_BYTES * 4 / 3 + 128 {
        return Err(error("Image exceeds the 64 MiB limit."));
    }
    let Some(found) = pattern.captures(source) else {
        return Ok(None);
    };
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new()
            .with_decode_padding_mode(DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    );
    let bytes = engine
        .decode(&found[2])
        .map_err(|_| error("Couldn't read the image."))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(error("Image exceeds the 64 MiB limit."));
    }
    let ext = if &found[1] == "jpeg" {
        "jpg"
    } else {
        &found[1]
    };
    Ok(Some((ext.into(), bytes)))
}
fn pasted_filename(name: &str, extension: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or("Pasted image");
    let stem = base.rfind('.').map_or(base, |index| &base[..index]);
    format!(
        "{}.{}",
        if stem.is_empty() {
            "Pasted image"
        } else {
            stem
        },
        extension
    )
}
fn load(source: &str, name: &str) -> Result<ImageSource, Value> {
    if let Some((extension, bytes)) = image_data(source)? {
        return Ok(ImageSource {
            filename: pasted_filename(name, &extension),
            bytes,
            extension,
        });
    }
    let real = require_image(source)?;
    let file = File::open(&real).map_err(|_| error("Couldn't read the image."))?;
    let metadata = file
        .metadata()
        .map_err(|_| error("Couldn't read the image."))?;
    if !metadata.is_file() {
        return Err(error("Not an image file."));
    }
    if metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err(error("Image exceeds the 64 MiB limit."));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error("Couldn't read the image."))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(error("Image exceeds the 64 MiB limit."));
    }
    Ok(ImageSource {
        bytes,
        extension: extension(&real).unwrap(),
        filename: Path::new(source)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    })
}
fn write_copy(path: &Path, image: &ImageSource) -> Reply {
    fs::write(path, &image.bytes)
        .map_err(|cause| error(&format!("Couldn't save the image: {cause}")))?;
    Ok(json!(path.to_string_lossy()))
}
async fn copy(app: &AppHandle, image: ImageSource) -> Reply {
    if background() {
        return Ok(Value::Null);
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
        let result = (|| {
            // Publish PNG explicitly. NSImage's default pasteboard representation is
            // TIFF, which the production attachment composer does not accept.
            let png = png_data(image.bytes)?;
            let pasteboard = NSPasteboard::generalPasteboard();
            pasteboard.clearContents();
            if !pasteboard.setData_forType(Some(&png), unsafe { NSPasteboardTypePNG }) {
                return Err(error("Couldn't copy the image."));
            }
            Ok(Value::Null)
        })();
        let _ = sender.send(result);
    })
    .map_err(|cause| error(&cause.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv()
            .map_err(|_| error("Image clipboard operation ended unexpectedly."))
    })
    .await
    .map_err(|cause| error(&cause.to_string()))??
}
fn png_data(bytes: Vec<u8>) -> Result<objc2::rc::Retained<objc2_foundation::NSData>, Value> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSData, NSDictionary};
    let data = NSData::from_vec(bytes);
    let image = NSImage::initWithData(NSImage::alloc(), &data)
        .filter(|image| image.isValid())
        .ok_or_else(|| error("Couldn't read the image."))?;
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| error("Couldn't read the image."))?;
    let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
        .ok_or_else(|| error("Couldn't read the image."))?;
    // Empty encoding properties are valid for PNG; the returned NSData owns its bytes.
    unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or_else(|| error("Couldn't encode the image as PNG."))
}
async fn save(app: &AppHandle, image: ImageSource) -> Reply {
    if background() {
        return Ok(Value::Null);
    }
    let mut dialog = rfd::AsyncFileDialog::new()
        .set_title("Save Image")
        .set_file_name(&image.filename)
        .add_filter("Image", &[&image.extension]);
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| error("Open Milagre Rust to save an image."))?;
    dialog = dialog.set_parent(&window);
    if let Ok(downloads) = app.path().download_dir() {
        dialog = dialog.set_directory(downloads);
    }
    let Some(destination) = dialog.save_file().await else {
        return Ok(Value::Null);
    };
    let path = destination.path().to_owned();
    tauri::async_runtime::spawn_blocking(move || write_copy(&path, &image))
        .await
        .map_err(|cause| error(&cause.to_string()))?
}
#[derive(Clone)]
struct MenuContext {
    source: String,
    name: String,
}
#[derive(Default)]
struct MenuState {
    context: Option<MenuContext>,
    menu: Option<tauri::menu::Menu<tauri::Wry>>,
}
fn menu_state(app: &AppHandle) -> Arc<Mutex<MenuState>> {
    static STATE: OnceLock<Arc<Mutex<MenuState>>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let state = Arc::new(Mutex::new(MenuState::default()));
            let pending = state.clone();
            app.on_menu_event(move |app, event| {
                let method = match event.id().as_ref() {
                    COPY_ID => "image:copy",
                    SAVE_ID => "image:save",
                    _ => return,
                };
                let context = pending
                    .lock()
                    .ok()
                    .and_then(|mut state| state.context.take());
                let Some(context) = context else { return };
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(cause) = action(&app, method, context.source, context.name).await {
                        let _ = app.emit(
                            "native-event",
                            json!({
                                "channel":"image:error", "payload":cause
                            }),
                        );
                    }
                });
            });
            state
        })
        .clone()
}
fn menu(app: &AppHandle, source: String, name: String) -> Reply {
    if background() {
        return Ok(Value::Null);
    }
    use tauri::menu::{Menu, MenuItem};
    let copy = MenuItem::with_id(app, COPY_ID, "Copy Image", true, None::<&str>)
        .map_err(|e| error(&e.to_string()))?;
    let save = MenuItem::with_id(app, SAVE_ID, "Save Image…", true, None::<&str>)
        .map_err(|e| error(&e.to_string()))?;
    let menu = Menu::with_items(app, &[&copy, &save]).map_err(|e| error(&e.to_string()))?;
    let state = menu_state(app);
    {
        let mut state = state.lock().map_err(|_| error("Image menu unavailable"))?;
        state.context = Some(MenuContext { source, name });
        state.menu = Some(menu.clone());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| error("Open Milagre Rust to use the image menu."))?;
    window
        .popup_menu(&menu)
        .map_err(|e| error(&e.to_string()))?;
    Ok(Value::Null)
}
async fn action(app: &AppHandle, method: &str, source: String, name: String) -> Reply {
    let image = tauri::async_runtime::spawn_blocking(move || load(&source, &name))
        .await
        .map_err(|e| error(&e.to_string()))??;
    match method {
        "image:copy" => copy(app, image).await,
        "image:save" => save(app, image).await,
        _ => Err(error("Unsupported image action.")),
    }
}
pub async fn invoke(app: &AppHandle, method: &str, args: &Value) -> Option<Reply> {
    if !["image:copy", "image:save", "image:menu"].contains(&method) {
        return None;
    }
    let Some(source) = args[0].as_str() else {
        return Some(Err(error("Not an image file.")));
    };
    let name = args[1].as_str().unwrap_or("Pasted image").to_owned();
    Some(if method == "image:menu" {
        menu(app, source.to_owned(), name)
    } else {
        action(app, method, source.to_owned(), name).await
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn directory() -> PathBuf {
        static ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "milagre-image-test-{}-{}",
            std::process::id(),
            ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn data_url_contract_and_filename_match_desktop() {
        let image = load("data:image/png;base64,aGVsbG8=", "../../Attached photo.jpg").unwrap();
        assert_eq!(image.bytes, b"hello");
        assert_eq!(image.extension, "png");
        assert_eq!(image.filename, "Attached photo.png");
        assert_eq!(pasted_filename(".hidden", "jpg"), "Pasted image.jpg");
        assert_eq!(pasted_filename("image", "gif"), "image.gif");
        assert_eq!(
            image_data("data:image/jpeg;base64,YQ").unwrap().unwrap(),
            ("jpg".into(), b"a".to_vec())
        );
        assert!(image_data("data:image/svg+xml;base64,YQ==")
            .unwrap()
            .is_none());
        assert!(image_data("data:text/plain;base64,YQ==").unwrap().is_none());
    }
    #[test]
    fn paths_validate_original_and_canonical_extensions() {
        let dir = directory();
        let image = dir.join("valid.PNG");
        let secret = dir.join("private.txt");
        let link = dir.join("linked.png");
        fs::write(&image, b"bytes").unwrap();
        fs::write(&secret, b"private").unwrap();
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert_eq!(
            require_image(image.to_str().unwrap()).unwrap(),
            image.canonicalize().unwrap()
        );
        assert!(require_image(link.to_str().unwrap()).is_err());
        assert!(require_image(secret.to_str().unwrap()).is_err());
        assert!(require_image("relative.png").is_err());
        let not_file = dir.join("directory.png");
        fs::create_dir(&not_file).unwrap();
        assert!(require_image(not_file.to_str().unwrap()).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn saved_copy_returns_path_and_preserves_original_bytes() {
        let dir = directory();
        let target = dir.join("saved.webp");
        let image = load("data:image/webp;base64,aGVsbG8=", "Pasted image").unwrap();
        assert_eq!(
            write_copy(&target, &image).unwrap(),
            json!(target.to_string_lossy())
        );
        assert_eq!(fs::read(&target).unwrap(), image.bytes);
        fs::remove_dir_all(dir).unwrap();
    }
}
