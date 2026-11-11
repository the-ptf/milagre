//! Read tool images: validate returned bytes and persist them by SHA-256, never read the source path.
//! Matches `image-input.cjs` and `tool-image.cjs` for PNG/JPEG/GIF/WebP. Signature checks are not a
//! complete image decoder. The owner chooses a private directory and retains/serves those files.
use crate::text::Obj;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;

/// Owner-supplied persistence boundary. Called only for matched, successful, non-replay Read results.
/// Returning an error skips only that image; the tool row and valid sibling images remain visible.
pub trait ToolImageStore: Send + Sync {
    fn save(&self, mime: &str, base64: &str) -> Result<PathBuf, String>;
}

/// Files named exactly as Node: `<sha256>.<png|jpg|gif|webp>`, with mode 0600 on Unix.
/// Unlike Node, existing files are never overwritten. Publication is atomic, so another reader
/// never sees a partial image. Existing symlinks, non-files and corrupt hash entries are refused.
#[derive(Debug, Clone)]
pub struct FileImageStore {
    directory: PathBuf,
}
impl FileImageStore {
    /// The directory must be controlled by the owner. No filesystem access until the first save.
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self { directory: directory.into() }
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }
}
fn invalid(message: &str) -> String {
    message.into()
}
fn decode(mime: &str, encoded: &str) -> Result<Vec<u8>, String> {
    if encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err(invalid("Image exceeds 50 MiB."));
    }
    if !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime) {
        return Err(invalid("Unsupported image type."));
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| invalid("Invalid image data."))?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES || STANDARD.encode(&bytes) != encoded {
        return Err(invalid("Invalid image data."));
    }
    let valid = match mime {
        "image/png" => bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]),
        "image/jpeg" => bytes.starts_with(&[255, 216, 255]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid {
        return Err(invalid("The returned file is not a valid supported image."));
    }
    Ok(bytes)
}
fn same_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if !fs::symlink_metadata(path)?.file_type().is_file() {
        return Err(io::Error::other("Image destination is not a regular file"));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path)?;
    if file.metadata()?.len() != bytes.len() as u64 {
        return Err(io::Error::other("Image destination contains different bytes"));
    }
    let mut existing = Vec::new();
    file.take(bytes.len() as u64 + 1).read_to_end(&mut existing)?;
    if existing != bytes {
        return Err(io::Error::other("Image destination contains different bytes"));
    }
    Ok(())
}
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
impl ToolImageStore for FileImageStore {
    fn save(&self, mime: &str, encoded: &str) -> Result<PathBuf, String> {
        let bytes = decode(mime, encoded)?;
        let ext = if mime == "image/jpeg" { "jpg" } else { &mime[6..] };
        let hash = format!("{:x}", Sha256::digest(&bytes));
        let destination = self.directory.join(format!("{hash}.{ext}"));
        let persist = || -> io::Result<()> {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(&self.directory)?;
            if !fs::symlink_metadata(&self.directory)?.file_type().is_dir() {
                return Err(io::Error::other("Image directory is not a directory"));
            }
            match fs::symlink_metadata(&destination) {
                Ok(_) => return same_file(&destination, &bytes),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let (mut file, temporary) = loop {
                let path = self.directory.join(format!(".image-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                match options.open(&path) {
                    Ok(file) => break (file, TempFile(path)),
                    Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(e) => return Err(e),
                }
            };
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            match fs::hard_link(&temporary.0, &destination) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => same_file(&destination, &bytes),
                Err(e) => Err(e),
            }
        };
        persist().map_err(|e| e.to_string())?;
        Ok(destination)
    }
}

pub(crate) fn read_images(call: &Value, result: &Value, store: &dyn ToolImageStore) -> Vec<Value> {
    if call["name"] != "Read" || crate::events::truthy(result.get("is_error")) {
        return vec![];
    }
    let Some(blocks) = result["content"].as_array() else {
        return vec![];
    };
    let mut events = vec![];
    for (index, block) in blocks.iter().enumerate() {
        if block["type"] != "image" || block["source"]["type"] != "base64" {
            continue;
        }
        let (Some(data), Some(mime)) = (block["source"]["data"].as_str(), block["source"]["media_type"].as_str()) else {
            continue;
        };
        let Ok(file) = store.save(mime, data) else {
            continue;
        };
        let id = format!("{}:image:{index}", call["id"].as_str().unwrap_or_default());
        let step = Obj::new()
            .set("id", id.clone())
            .set("kind", "image")
            .set("title", "Viewed an image")
            .set("imageOrigin", "viewed")
            .opt("sourceFile", call["input"]["file_path"].as_str())
            .set("file", file.to_string_lossy().as_ref())
            .build();
        events.push(json!({"type":"step-started","step":step}));
        events.push(json!({"type":"step-completed","id":id,"status":"done","file":file}));
    }
    events
}
