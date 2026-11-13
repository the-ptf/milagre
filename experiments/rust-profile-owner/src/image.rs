//! File-backed project:image. Deliberately never reads ambient gh credentials or contacts GitHub.
use base64::{engine::general_purpose::STANDARD, Engine};
use milagre_owner_store::jsjson;
use serde_json::Value;
use std::{
    ffi::CString,
    fs::File,
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::OpenOptionsExt,
    },
    path::{Component, Path},
};
const MAX: u64 = 5 * 1024 * 1024;
const EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
];
pub fn valid_icon(value: &Value) -> Option<String> {
    let s = value.as_str()?;
    if jsjson::utf16_len(s) > 600_000 {
        return None;
    }
    let (head, body) = s.split_once(";base64,")?;
    if ![
        "data:image/png",
        "data:image/jpeg",
        "data:image/webp",
        "data:image/gif",
    ]
    .contains(&head)
    {
        return None;
    }
    let content = body.trim_end_matches('=');
    if content.is_empty()
        || !content
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
    {
        return None;
    }
    Some(s.into())
}
/// Directory capability captured at owner startup, before any client path is accepted.
pub struct Images {
    root: File,
    path: std::path::PathBuf,
}
fn open_under(root: &File, relative: &Path, directory: bool) -> Option<File> {
    let mut file = root.try_clone().ok()?;
    let components: Vec<_> = relative.components().collect();
    for (i, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return None;
        };
        use std::os::unix::ffi::OsStrExt;
        let name = CString::new(name.as_bytes()).ok()?;
        let is_dir = directory || i + 1 < components.len();
        let fd = unsafe {
            libc::openat(
                file.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY
                    | libc::O_NOFOLLOW
                    | libc::O_NONBLOCK
                    | libc::O_CLOEXEC
                    | if is_dir { libc::O_DIRECTORY } else { 0 },
            )
        };
        if fd < 0 {
            return None;
        }
        file = unsafe { File::from_raw_fd(fd) };
    }
    Some(file)
}
/// Resolve candidate links as Node does, then open under the already-pinned Project descriptor.
fn read(root: &Path, dir: &File, path: &Path) -> Option<Vec<u8>> {
    let real = std::fs::canonicalize(path).ok()?;
    let rel = real.strip_prefix(root).ok()?;
    let file = open_under(dir, rel, false)?;
    let meta = file.metadata().ok()?;
    if !meta.is_file() || meta.len() > MAX {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX).then_some(bytes)
}
impl Images {
    pub fn new(root: &Path) -> Result<Self, String> {
        let path = std::fs::canonicalize(root).map_err(|e| e.to_string())?;
        let root = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&path)
            .map_err(|e| e.to_string())?;
        Ok(Self { root, path })
    }
    pub fn local(&self, project: &Path) -> Option<String> {
        let rel = project.strip_prefix(&self.path).ok()?;
        let dir = open_under(&self.root, rel, true)?;
        let root = project;
        let config = read(root, &dir, &root.join("package.json"))
            .and_then(|b| jsjson::parse_bytes(&b).ok())
            .unwrap_or(Value::Null);
        let mut candidates: Vec<String> = EXTENSIONS
            .iter()
            .map(|(e, _)| format!(".milagre/icon.{e}"))
            .collect();
        for value in [
            &config["build"]["mac"]["icon"],
            &config["build"]["icon"],
            &config["expo"]["icon"],
        ] {
            if let Some(s) = value.as_str() {
                candidates.push(s.into());
            }
        }
        for base in [
            "logo",
            "icon",
            "public/logo",
            "public/icon",
            "app/public/logo",
            "app/public/app-icon",
            "assets/icon",
            "favicon",
            "public/favicon",
            "app/public/favicon",
            "app/favicon",
            "src/app/favicon",
            "static/favicon",
            "app/icon",
            "src/app/icon",
        ] {
            candidates.extend(EXTENSIONS.iter().map(|(ext, _)| format!("{base}.{ext}")));
        }
        for candidate in candidates {
            let file = root.join(candidate);
            let Some(ext) = file.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            let ext = ext.to_lowercase();
            let Some((_, mime)) = EXTENSIONS.iter().find(|(e, _)| *e == ext) else {
                continue;
            };
            if let Some(bytes) = read(root, &dir, &file).filter(|b| !b.is_empty()) {
                return Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)));
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unusable_package_candidate_does_not_hide_later_image() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("package.json"),
            r#"{"build":{"icon":"without-extension"}}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("logo.png"), b"png").unwrap();
        assert_eq!(
            Images::new(dir.path())
                .unwrap()
                .local(&std::fs::canonicalize(dir.path()).unwrap()),
            Some("data:image/png;base64,cG5n".into())
        );
    }
    #[test]
    fn replaced_project_link_is_not_a_new_trusted_root() {
        let copy = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let project = copy.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let images = Images::new(copy.path()).unwrap();
        let project = std::fs::canonicalize(&project).unwrap();
        // Simulate replacement after command isolation validation.
        std::fs::remove_dir(&project).unwrap();
        std::fs::write(outside.path().join("logo.png"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), &project).unwrap();
        assert_eq!(images.local(&project), None);
    }
    #[test]
    fn resolved_inside_alias_uses_pinned_copy_root() {
        let copy = tempfile::tempdir().unwrap();
        let project = copy.path().join("project");
        std::fs::create_dir(&project).unwrap();
        std::fs::write(project.join("logo.png"), b"png").unwrap();
        let alias = copy.path().join("alias");
        std::os::unix::fs::symlink(&project, &alias).unwrap();
        let resolved = std::fs::canonicalize(&alias).unwrap();
        assert_eq!(
            Images::new(copy.path()).unwrap().local(&resolved),
            Some("data:image/png;base64,cG5n".into())
        );
    }
    #[test]
    fn image_symlink_cannot_read_outside_project() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.png"), b"secret").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.png"),
            dir.path().join("logo.png"),
        )
        .unwrap();
        assert_eq!(
            Images::new(dir.path())
                .unwrap()
                .local(&std::fs::canonicalize(dir.path()).unwrap()),
            None
        );
    }
}
