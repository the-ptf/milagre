//! Bounded image input/output storage. Compatible with the Claude ToolImageStore boundary.
//! Matches `image-input.cjs` and `tool-image.cjs` for PNG/JPEG/GIF/WebP. Signature checks are not a
//! complete image decoder. The owner chooses a private directory and retains/serves those files.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;

/// Owner-supplied persistence boundary. Called off the async executor for accepted image results.
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
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(io::Error::other("Image destination is not private"));
        }
    }
    if !metadata.file_type().is_file() {
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
            let mut attempts = 0;
            let (mut file, temporary) = loop {
                attempts += 1;
                if attempts > 128 {
                    return Err(io::Error::other("Image temporary-name budget exhausted"));
                }
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

/// Aggregate limits apply separately to retained inputs and output-save attempts per turn.
pub const MAX_TURN_IMAGE_BYTES: usize = 128 * 1024 * 1024;
pub const MAX_TURN_IMAGES: usize = 32;

#[derive(Clone)]
pub struct ImageStore(pub Arc<dyn ToolImageStore>);
impl std::fmt::Debug for ImageStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ImageStore(<host>)")
    }
}

#[derive(Clone)]
pub struct ImageAttachment {
    mime: String,
    bytes: Vec<u8>,
}
impl std::fmt::Debug for ImageAttachment {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageAttachment").field("mime", &self.mime).field("bytes", &self.bytes.len()).finish()
    }
}
impl ImageAttachment {
    pub fn from_base64(mime: &str, encoded: &str) -> Result<Self, String> {
        Ok(Self { mime: mime.into(), bytes: decode(mime, encoded)? })
    }
    pub fn from_data_url(url: &str) -> Result<Self, String> {
        let (mime, encoded) = data_url(url).ok_or("Unsupported image data URL.")?;
        Self::from_base64(mime, encoded)
    }
}
fn data_url(url: &str) -> Option<(&str, &str)> {
    let (mime, encoded) = url.strip_prefix("data:")?.split_once(";base64,")?;
    Some((mime, encoded))
}

#[derive(Debug)]
struct InputFiles {
    _directory: tempfile::TempDir,
    paths: Vec<String>,
    bytes: usize,
}

/// A private input batch. Clones share ownership, so caller-held clones deliberately keep files
/// alive. The session keeps its own reference through completion, including failed steer fallback.
#[derive(Debug, Clone)]
pub struct PreparedImages {
    files: Arc<InputFiles>,
    input: Vec<Value>,
}
impl PreparedImages {
    /// Blocking host preparation. `parent` must be an owner-controlled scratch directory.
    pub fn create(prompt: &str, images: &[ImageAttachment], parent: &Path) -> Result<Self, String> {
        if !parent.is_absolute() {
            return Err("Image scratch directory must be absolute.".into());
        }
        let bytes = images.iter().try_fold(0usize, |n, image| n.checked_add(image.bytes.len())).ok_or("Input image budget exceeded.")?;
        if images.len() > MAX_TURN_IMAGES || bytes > MAX_TURN_IMAGE_BYTES {
            return Err("Input image budget exceeded.".into());
        }
        let directory = tempfile::Builder::new().prefix("milagre-input-").tempdir_in(parent).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        }
        let mut paths = Vec::new();
        for (index, image) in images.iter().enumerate() {
            let ext = if image.mime == "image/jpeg" { "jpg" } else { &image.mime[6..] };
            let path = directory.path().join(format!("{index}.{ext}"));
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&path).map_err(|e| e.to_string())?;
            file.write_all(&image.bytes).map_err(|e| e.to_string())?;
            paths.push(path.to_str().ok_or("Image paths must be UTF-8.")?.to_string());
        }
        let input = prompt_input(prompt, &paths);
        Ok(Self { files: Arc::new(InputFiles { _directory: directory, paths, bytes }), input })
    }
    pub fn input(&self) -> &[Value] {
        &self.input
    }
    pub fn paths(&self) -> &[String] {
        &self.files.paths
    }
    pub fn byte_len(&self) -> usize {
        self.files.bytes
    }
}

/// Preparation stays off async executor threads. Cancelling this future drops any completed batch;
/// the blocking task owns its temporary directory until it finishes and drops the result.
pub async fn prepare_input_images(prompt: String, images: Vec<ImageAttachment>, parent: PathBuf) -> Result<PreparedImages, String> {
    tokio::task::spawn_blocking(move || PreparedImages::create(&prompt, &images, &parent)).await.map_err(|_| "Image preparation failed.")?
}

/// Node promptImageBlocks: mask fenced/inline code, interleave valid prose tokens, append unused
/// attachments. Byte offsets stay aligned with UTF-8 input; code masking does not alter text output.
pub fn prompt_input(prompt: &str, paths: &[String]) -> Vec<Value> {
    if paths.is_empty() {
        return vec![crate::codex::protocol::text_input(prompt)];
    }
    let bytes = prompt.as_bytes();
    let mut prose = bytes.to_vec();
    let mut i = 0;
    while i < bytes.len() {
        let fence = bytes[i..].starts_with(b"```") || bytes[i..].starts_with(b"~~~");
        let end = if fence {
            let marker = &bytes[i..i + 3];
            bytes[i + 3..].windows(3).position(|p| p == marker).map(|n| i + 3 + n + 3).unwrap_or(bytes.len())
        } else if bytes[i] == b'`' {
            let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
            let mut end = i + run;
            while end < bytes.len() && bytes[end] != b'\n' {
                if bytes[end] == b'`' {
                    let closing = bytes[end..].iter().take_while(|b| **b == b'`').count();
                    end += closing;
                    if closing >= run {
                        break;
                    }
                } else {
                    end += 1;
                }
            }
            end
        } else {
            i += 1;
            continue;
        };
        prose[i..end].fill(b' ');
        i = end;
    }
    let mut used = vec![false; paths.len()];
    let mut result = Vec::new();
    let mut cursor = 0;
    let mut at = 0;
    while at < prose.len() {
        if !prose[at..].starts_with(b"[Image #") {
            at += 1;
            continue;
        }
        let start = at + 8;
        let stop = start + prose[start..].iter().take_while(|b| b.is_ascii_digit()).count();
        let number = std::str::from_utf8(&prose[start..stop]).ok().and_then(|s| s.parse::<usize>().ok());
        if prose.get(start) == Some(&b'0') || prose.get(stop) != Some(&b']') || number.is_none_or(|n| n == 0 || n > paths.len()) {
            at += 1;
            continue;
        }
        let number = number.unwrap() - 1;
        if at > cursor {
            result.push(crate::codex::protocol::text_input(&prompt[cursor..at]));
        }
        result.push(crate::codex::protocol::local_image_input(&paths[number]));
        used[number] = true;
        cursor = stop + 1;
        at = cursor;
    }
    if cursor == 0 || cursor < prompt.len() {
        result.push(crate::codex::protocol::text_input(&prompt[cursor..]));
    }
    for (index, path) in paths.iter().enumerate() {
        if !used[index] {
            result.push(crate::codex::protocol::local_image_input(path));
        }
    }
    result
}

#[derive(Debug, Default)]
pub(crate) struct ImageBudget {
    count: usize,
    bytes: usize,
}
impl ImageBudget {
    pub(crate) fn reserve(&mut self, count: usize, bytes: usize) -> bool {
        if count > MAX_TURN_IMAGES.saturating_sub(self.count) || bytes > MAX_TURN_IMAGE_BYTES.saturating_sub(self.bytes) {
            return false;
        }
        self.count += count;
        self.bytes += bytes;
        true
    }
}

pub(crate) struct ImageJob {
    pub id: String,
    pub generated: bool,
    mime: String,
    encoded: String,
}
/// Select work before moving it to the blocking pool; cap both attempted files and bytes per turn.
pub(crate) fn image_jobs(item: &Value, budget: &mut ImageBudget) -> Vec<ImageJob> {
    let mut jobs = vec![];
    let id = crate::codex::js::js_string(item.get("id"));
    let mut add = |mime: &str, encoded: &str, id: String, generated: bool| {
        if encoded.is_empty() || encoded.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
            return;
        }
        if !["image/png", "image/jpeg", "image/gif", "image/webp"].contains(&mime) {
            return;
        }
        if !budget.reserve(1, encoded.len().div_ceil(4) * 3) {
            return;
        }
        jobs.push(ImageJob { id, generated, mime: mime.into(), encoded: encoded.into() });
    };
    if item["type"] == "imageGeneration" {
        if !crate::codex::js::truthy(item.get("savedPath")) && item["status"] != "failed" && !crate::codex::js::truthy(item.get("failure"))
        {
            if let Some(encoded) = item["result"].as_str() {
                add("image/png", encoded, id, true);
            }
        }
        return jobs;
    }
    if !matches!(item["type"].as_str(), Some("mcpToolCall" | "dynamicToolCall"))
        || item["status"] != "completed"
        || item["success"] == false
        || crate::codex::js::truthy(item.get("error"))
    {
        return jobs;
    }
    if item["type"] == "mcpToolCall"
        && item["server"] == "milagre"
        && matches!(item["tool"].as_str(), Some("design_show" | "design_apply" | "html_preview"))
    {
        return jobs;
    }
    let blocks = if item["type"] == "mcpToolCall" { item.pointer("/result/content") } else { item.get("contentItems") };
    for (index, block) in blocks.and_then(Value::as_array).into_iter().flatten().enumerate() {
        if !matches!(block["type"].as_str(), Some("image" | "inputImage")) {
            continue;
        }
        let data = if crate::codex::js::truthy(block.get("data")) {
            block["mimeType"].as_str().zip(block["data"].as_str())
        } else {
            let url = if crate::codex::js::truthy(block.get("imageUrl")) { &block["imageUrl"] } else { &block["image_url"] };
            url.as_str().and_then(data_url)
        };
        if let Some((mime, encoded)) = data {
            add(mime, encoded, format!("{id}:image:{index}"), false);
        }
    }
    jobs
}

pub(crate) fn save_jobs(jobs: Vec<ImageJob>, store: &dyn ToolImageStore) -> Vec<(ImageJob, PathBuf)> {
    jobs.into_iter()
        .filter_map(|job| {
            // Validate independently of a custom host store. The store must not fetch arbitrary URLs.
            decode(&job.mime, &job.encoded).ok()?;
            let path = store.save(&job.mime, &job.encoded).ok()?;
            path.to_str()?;
            Some((job, path))
        })
        .collect()
}

pub(crate) fn apply_saved(events: &mut Vec<Value>, saved: Vec<(ImageJob, PathBuf)>) {
    for (job, file) in saved {
        if job.generated {
            for event in events.iter_mut().filter(|e| e["type"] == "step-completed" && e["id"] == job.id) {
                event["file"] = json!(file);
            }
        } else {
            events.push(json!({"type":"step-started","step":{"id":job.id,"kind":"image","title":"Image from tool","file":file}}));
            events.push(json!({"type":"step-completed","id":job.id,"status":"done","file":file}));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_image_traces() {
        let fixture: Value = serde_json::from_str(include_str!("../tests/fixtures/conformance/codex-images.json")).unwrap();
        for case in fixture["inputs"].as_array().unwrap() {
            let paths: Vec<String> = serde_json::from_value(case["paths"].clone()).unwrap();
            assert_eq!(json!(prompt_input(case["prompt"].as_str().unwrap(), &paths)), case["expected"], "prompt: {}", case["prompt"]);
        }
        for case in fixture["validation"].as_array().unwrap() {
            assert_eq!(
                ImageAttachment::from_data_url(case["url"].as_str().unwrap()).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["url"]
            );
        }
        let temp = tempfile::tempdir().unwrap();
        let store = FileImageStore::new(temp.path().join("outputs"));
        for case in fixture["tools"].as_array().unwrap() {
            let jobs = image_jobs(&case["item"], &mut ImageBudget::default());
            let mut saved = save_jobs(jobs, &store);
            for (_, path) in &mut saved {
                *path = Path::new("/images").join(path.file_name().unwrap());
            }
            let mut events = vec![];
            apply_saved(&mut events, saved);
            assert_eq!(json!(events), case["expected"], "item: {}", case["item"]);
        }
    }

    #[test]
    fn output_attempts_and_bytes_are_bounded() {
        let item = json!({"id":"tool","type":"dynamicToolCall","status":"completed","contentItems":[{"type":"image","mimeType":"image/png","data":"iVBORw0KGgo="}]});
        let mut budget = ImageBudget::default();
        for _ in 0..MAX_TURN_IMAGES {
            assert_eq!(image_jobs(&item, &mut budget).len(), 1);
        }
        assert!(image_jobs(&item, &mut budget).is_empty());
        let mut budget = ImageBudget::default();
        assert!(budget.reserve(1, MAX_TURN_IMAGE_BYTES));
        assert!(!budget.reserve(1, 1));
        assert!(!budget.reserve(usize::MAX, usize::MAX));
    }
}
