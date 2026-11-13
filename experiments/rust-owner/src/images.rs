//! Bounded image admission and content addressed storage for explicit image-capable adapters. Saved paths are
//! metadata, never caller read authority. Only the host's selected queued entry reaches `hydrate_queued_images`.

use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};

use base64::Engine;
use rustix::fs::{AtFlags, Mode, OFlags};
use serde_json::{json, Value};

use crate::error::{Result, StoreError};
use crate::jsjson;
use crate::owner::OwnedProject;
use crate::project::sha256_hex;

pub(crate) const MAX_IMAGES: usize = 10;
pub(crate) const MAX_IMAGE_BYTES: usize = 1024 * 1024;
const DIR: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

/// Validated bytes, with no file read authority. Constructed only by the owner's image admission path.
#[derive(Clone, PartialEq, Eq)]
pub struct ImageInput {
    mime: String,
    bytes: Vec<u8>,
}

impl std::fmt::Debug for ImageInput {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("ImageInput")
            .field("mime", &self.mime)
            .field("bytes", &self.bytes.len())
            .finish()
    }
}

impl ImageInput {
    pub fn mime(&self) -> &str {
        &self.mime
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    /// Adapter fixture tests use the same admission, never unchecked bytes. Absent from production builds.
    #[cfg(feature = "test-fixtures")]
    pub fn decode_for_tests(images: &Value) -> Result<Vec<Self>> {
        Self::decode_all(images)
    }

    pub(crate) fn decode_all(images: &Value) -> Result<Vec<Self>> {
        let list = images
            .as_array()
            .ok_or_else(|| StoreError::Invalid("Images must be an array.".into()))?;
        if list.len() > MAX_IMAGES {
            return Err(StoreError::Invalid(
                "This Rust image checkpoint accepts at most 10 images per send.".into(),
            ));
        }
        let mut total = 0usize;
        let mut decoded = Vec::with_capacity(list.len());
        for image in list {
            // Bound allocation before the shared decoder (whose Node-compatible per-image limit is 50 MiB).
            if image
                .get("dataUrl")
                .and_then(Value::as_str)
                .is_some_and(|url| url.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 + 100)
            {
                return Err(budget());
            }
            let (mime, bytes) = OwnedProject::decode_image(image).map_err(StoreError::Invalid)?;
            total = total.checked_add(bytes.len()).ok_or_else(budget)?;
            if total > MAX_IMAGE_BYTES {
                return Err(budget());
            }
            decoded.push(Self { mime, bytes });
        }
        Ok(decoded)
    }

    fn data_url(&self) -> String {
        format!(
            "data:{};base64,{}",
            self.mime,
            base64::engine::general_purpose::STANDARD.encode(&self.bytes)
        )
    }

    fn extension(&self) -> &str {
        match self.mime.as_str() {
            "image/jpeg" => "jpg",
            _ => &self.mime[6..],
        }
    }
}

fn budget() -> StoreError {
    StoreError::Invalid(
        "This Rust image checkpoint accepts at most 1 MiB of decoded images per send.".into(),
    )
}

fn io(error: rustix::io::Errno, action: &'static str, path: &Path) -> StoreError {
    StoreError::io(
        std::io::Error::from_raw_os_error(error.raw_os_error()),
        action,
        path,
    )
}

fn identity(fd: &OwnedFd) -> Result<(u64, u64)> {
    let stat = rustix::fs::fstat(fd).map_err(|e| io(e, "fstat", Path::new("image content")))?;
    Ok((stat.st_dev as u64, stat.st_ino as u64))
}

/// Every operation below is relative to these descriptors. Rechecking the entries rejects directory replacement;
/// even during replacement reads, writes and cleanup cannot follow a substitute path outside the owned Project.
struct ImageDirectory<'a> {
    owner: &'a OwnedProject,
    root: OwnedFd,
    metadata: OwnedFd,
    images: OwnedFd,
    path: PathBuf,
}

impl<'a> ImageDirectory<'a> {
    fn open(owner: &'a OwnedProject, create: bool) -> Result<Self> {
        owner.verify_owned()?;
        let root = rustix::fs::openat(rustix::fs::CWD, owner.root(), DIR, Mode::empty())
            .map_err(|e| io(e, "open", owner.root()))?;
        if identity(&root)? != owner.lock().root().identity() {
            return Err(Self::changed());
        }
        let metadata = rustix::fs::openat(&root, ".milagre", DIR, Mode::empty())
            .map_err(|e| io(e, "open", &owner.root().join(".milagre")))?;
        let path = owner.root().join(".milagre/images");
        if create {
            match rustix::fs::mkdirat(&metadata, "images", Mode::from_raw_mode(0o700)) {
                Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                Err(e) => return Err(io(e, "mkdir", &path)),
            }
        }
        let images = rustix::fs::openat(&metadata, "images", DIR, Mode::empty())
            .map_err(|e| io(e, "open", &path))?;
        let directory = Self {
            owner,
            root,
            metadata,
            images,
            path,
        };
        directory.check()?;
        Ok(directory)
    }

    fn changed() -> StoreError {
        StoreError::Invalid("The owned image content directory changed.".into())
    }

    fn check(&self) -> Result<()> {
        self.owner.verify_owned()?;
        if identity(&self.root)? != self.owner.lock().root().identity() {
            return Err(Self::changed());
        }
        let metadata = rustix::fs::openat(&self.root, ".milagre", DIR, Mode::empty())
            .map_err(|_| Self::changed())?;
        let images = rustix::fs::openat(&metadata, "images", DIR, Mode::empty())
            .map_err(|_| Self::changed())?;
        if identity(&metadata)? != identity(&self.metadata)?
            || identity(&images)? != identity(&self.images)?
        {
            return Err(Self::changed());
        }
        Ok(())
    }

    fn read(&self, name: &str, budget_left: usize) -> Result<Vec<u8>> {
        self.check()?;
        let path = self.path.join(name);
        let fd = rustix::fs::openat(
            &self.images,
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|e| io(e, "open", &path))?;
        let stat = rustix::fs::fstat(&fd).map_err(|e| io(e, "fstat", &path))?;
        if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::RegularFile
            || stat.st_nlink != 1
            || stat.st_size <= 0
        {
            return Err(StoreError::Invalid(
                "A queued image isn't a plain, single-link file of its Project.".into(),
            ));
        }
        if stat.st_size as u64 > budget_left as u64 {
            return Err(budget());
        }
        let mut bytes = Vec::new();
        std::fs::File::from(fd)
            .take(budget_left as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| StoreError::io(e, "read", &path))?;
        if bytes.len() > budget_left {
            return Err(budget());
        }
        self.check()?;
        let digest = name.split_once('.').map(|(digest, _)| digest).unwrap_or("");
        if sha256_hex(&bytes) != digest {
            return Err(StoreError::ContentMismatch(path));
        }
        Ok(bytes)
    }

    fn write_with(
        &self,
        image: &ImageInput,
        write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
    ) -> Result<PathBuf> {
        self.check()?;
        let name = format!("{}.{}", sha256_hex(&image.bytes), image.extension());
        let temporary = format!(".{name}.{}.tmp", crate::ownership::random_uuid());
        let path = self.path.join(&temporary);
        let fd = rustix::fs::openat(
            &self.images,
            temporary.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|e| io(e, "open", &path))?;
        let created = identity(&fd)?;
        let mut file = std::fs::File::from(fd);
        let outcome = (|| {
            write(&mut file).map_err(|e| StoreError::io(e, "write", &path))?;
            self.check()?;
            match rustix::fs::linkat(
                &self.images,
                temporary.as_str(),
                &self.images,
                name.as_str(),
                AtFlags::empty(),
            ) {
                Ok(()) => Ok(()),
                Err(rustix::io::Errno::EXIST) => self.read(&name, MAX_IMAGE_BYTES).map(|_| ()),
                Err(e) => Err(io(e, "link", &self.path.join(&name))),
            }
        })();
        // A partial write or failed link still attempts cleanup through the held directory, after checking the
        // temporary entry's identity. This is not an atomic conditional unlink against a hostile concurrent writer.
        let cleanup =
            rustix::fs::statat(&self.images, temporary.as_str(), AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|e| io(e, "stat", &path))
                .and_then(|stat| {
                    // Native stat field widths differ across supported Unix targets.
                    #[allow(clippy::unnecessary_cast)]
                    let observed = (stat.st_dev as u64, stat.st_ino as u64);
                    if observed != created {
                        return Err(Self::changed());
                    }
                    rustix::fs::unlinkat(&self.images, temporary.as_str(), AtFlags::empty())
                        .map_err(|e| io(e, "unlink", &path))
                });
        match (outcome, cleanup) {
            (Err(error), Err(cleanup)) => {
                return Err(StoreError::Invalid(format!(
                    "{error}; temporary image cleanup also failed: {cleanup}"
                )))
            }
            (Err(error), _) | (_, Err(error)) => return Err(error),
            _ => {}
        }
        self.check()?;
        Ok(self.path.join(name))
    }
}

impl OwnedProject {
    pub(crate) fn store_send_images(
        &self,
        images: &Value,
        decoded: &[ImageInput],
    ) -> Result<Value> {
        if decoded.is_empty() {
            return Ok(json!([]));
        }
        let directory = ImageDirectory::open(self, true)?;
        let mut stored = Vec::with_capacity(decoded.len());
        for (original, image) in images
            .as_array()
            .expect("validated list")
            .iter()
            .zip(decoded)
        {
            let path = directory.write_with(image, |file| file.write_all(image.bytes()))?;
            let mut metadata = original.as_object().cloned().unwrap_or_default();
            metadata.shift_remove("dataUrl");
            let uploaded = metadata.shift_remove("path");
            let source = original
                .get("sourcePath")
                .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                .cloned()
                .or(uploaded);
            metadata.insert(
                "path".into(),
                json!(jsjson::js_string(&path.to_string_lossy())),
            );
            if jsjson::truthy(source.as_ref()) {
                metadata.insert("sourcePath".into(), source.unwrap());
            }
            stored.push(Value::Object(metadata));
        }
        directory.check()?;
        Ok(Value::Array(stored))
    }

    pub(crate) fn hydrate_queued_images(&self, images: &Value) -> Result<Value> {
        let list = images
            .as_array()
            .ok_or_else(|| StoreError::Invalid("Images must be an array.".into()))?;
        if list.is_empty() {
            return Ok(json!([]));
        }
        if list.len() > MAX_IMAGES {
            return Err(StoreError::Invalid(
                "This Rust image checkpoint accepts at most 10 images per send.".into(),
            ));
        }
        let directory = ImageDirectory::open(self, false)?;
        let mut budget_left = MAX_IMAGE_BYTES;
        let mut hydrated = Vec::with_capacity(list.len());
        for saved in list {
            let path = saved.get("path").and_then(Value::as_str).ok_or_else(|| {
                StoreError::Invalid("A queued image has no owned content path.".into())
            })?;
            let path = jsjson::decode_text_strict(path).map_err(|_| {
                StoreError::Invalid("A queued image path isn't valid UTF-8.".into())
            })?;
            let path = Path::new(&path);
            let name = path.file_name().and_then(|s| s.to_str()).ok_or_else(|| {
                StoreError::Invalid("A queued image has no owned content name.".into())
            })?;
            let (digest, extension) = name.split_once('.').unwrap_or(("", ""));
            let mime = match extension {
                "png" => "image/png",
                "jpg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "",
            };
            if path != directory.path.join(name)
                || digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || mime.is_empty()
            {
                return Err(StoreError::Invalid(
                    "A queued image isn't owned content of this Project.".into(),
                ));
            }
            let bytes = directory.read(name, budget_left)?;
            budget_left -= bytes.len();
            let image = ImageInput {
                mime: mime.into(),
                bytes,
            };
            let mut input = serde_json::Map::new();
            for key in ["id", "name"] {
                if let Some(value) = saved.get(key) {
                    input.insert(key.into(), value.clone());
                }
            }
            input.insert("dataUrl".into(), json!(image.data_url()));
            // Hash integrity alone does not establish a supported image signature.
            OwnedProject::decode_image(&Value::Object(input.clone()))
                .map_err(StoreError::Invalid)?;
            hydrated.push(Value::Object(input));
        }
        directory.check()?;
        Ok(Value::Array(hydrated))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::isolation::{Isolation, Policy};

    fn fixture() -> (tempfile::TempDir, OwnedProject) {
        let temp = tempfile::tempdir().unwrap();
        let isolation = Isolation::create(&temp.path().join("copies"), &Policy::default()).unwrap();
        let project = isolation.project(Path::new("p")).unwrap();
        std::fs::create_dir_all(project.join(".milagre")).unwrap();
        let owner = OwnedProject::open(&isolation, &project, None).unwrap();
        (temp, owner)
    }

    fn image() -> ImageInput {
        ImageInput::decode_all(&json!([{ "dataUrl": "data:image/png;base64,iVBORw0KGgo=" }]))
            .unwrap()
            .remove(0)
    }

    #[test]
    fn failed_partial_write_cleans_temporary_and_retry_succeeds() {
        let (_temp, owner) = fixture();
        let dir = ImageDirectory::open(&owner, true).unwrap();
        let error = dir
            .write_with(&image(), |file| {
                file.write_all(b"partial")?;
                Err(std::io::Error::other("injected write failure"))
            })
            .unwrap_err();
        assert!(error.to_string().contains("injected write failure"));
        assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 0);
        let image = image();
        let path = dir
            .write_with(&image, |file| file.write_all(image.bytes()))
            .unwrap();
        assert_eq!(std::fs::read(path).unwrap(), image.bytes());
        assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 1);
    }

    #[test]
    fn changed_directory_refuses_commit_and_cleans_through_original_descriptor() {
        let (temp, owner) = fixture();
        let dir = ImageDirectory::open(&owner, true).unwrap();
        let moved = temp.path().join("moved");
        let image = image();
        let error = dir
            .write_with(&image, |file| {
                file.write_all(image.bytes())?;
                std::fs::rename(&dir.path, &moved)?;
                std::fs::create_dir(&dir.path)?;
                std::fs::write(dir.path.join("keep"), b"replacement")?;
                Ok(())
            })
            .unwrap_err();
        assert!(error.to_string().contains("directory changed"));
        assert_eq!(std::fs::read_dir(moved).unwrap().count(), 0);
        assert_eq!(
            std::fs::read(dir.path.join("keep")).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn existing_corrupt_content_is_not_replaced_and_failed_link_leaves_no_temporary() {
        let (_temp, owner) = fixture();
        let dir = ImageDirectory::open(&owner, true).unwrap();
        let image = image();
        let path = dir.path.join(format!("{}.png", sha256_hex(image.bytes())));
        std::fs::write(&path, b"corrupted").unwrap();
        assert!(dir
            .write_with(&image, |file| file.write_all(image.bytes()))
            .is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"corrupted");
        assert_eq!(std::fs::read_dir(&dir.path).unwrap().count(), 1);
    }
}
