//! Finder launch for the separately packaged dedicated Rust preview.
//! Explicit CLI arguments retain their existing interpretation. This helper never
//! discovers an account, starts a process, creates data or accepts a socket.
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path},
};

const LIMIT: u64 = 32 * 1024;
fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn private_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o7777 != 0o700
        || fs::canonicalize(path)?.as_os_str() != path.as_os_str()
    {
        return Err(invalid(
            "Preview launch requires an owned private directory",
        ));
    }
    Ok(())
}
#[derive(PartialEq, Eq)]
struct Identity {
    device: u64,
    inode: u64,
    size: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
fn identity(metadata: &fs::Metadata) -> io::Result<Identity> {
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.nlink() != 1
        || metadata.uid() != unsafe { libc::getuid() }
        || metadata.mode() & 0o7777 != 0o600
        || metadata.len() > LIMIT
    {
        return Err(invalid(
            "Preview launch JSON must be an owned single-link 0600 file, at most 32 KiB",
        ));
    }
    Ok(Identity {
        device: metadata.dev(),
        inode: metadata.ino(),
        size: metadata.len(),
        modified: (metadata.mtime(), metadata.mtime_nsec()),
        changed: (metadata.ctime(), metadata.ctime_nsec()),
    })
}
fn read_config(path: &Path) -> io::Result<Vec<u8>> {
    let expected = identity(&fs::symlink_metadata(path)?)?;
    let file: File = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    if identity(&file.metadata()?)? != expected {
        return Err(invalid("Preview launch JSON changed while opening"));
    }
    let mut bytes = Vec::new();
    (&file).take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT
        || identity(&file.metadata()?)? != expected
        || identity(&fs::symlink_metadata(path)?)? != expected
    {
        return Err(invalid("Preview launch JSON changed while reading"));
    }
    Ok(bytes)
}

/// No-args Finder launches use only this bundle's private fixed configuration.
/// The existing LaunchContext remains responsible for runtime/root/peer admission.
pub(crate) fn arguments(explicit: &[String], executable: &Path) -> io::Result<Vec<String>> {
    if !explicit.is_empty() {
        return Ok(explicit.to_vec());
    }
    if !executable.is_absolute()
        || executable
            .file_name()
            .is_none_or(|name| name != "milagre-rust-chat")
    {
        return Err(invalid(
            "Use the packaged Milagre Rust Preview or explicit open/create arguments",
        ));
    }
    let macos = executable
        .parent()
        .ok_or_else(|| invalid("Missing Preview bundle"))?;
    let contents = macos
        .parent()
        .ok_or_else(|| invalid("Missing Preview bundle"))?;
    if macos.file_name().is_none_or(|name| name != "MacOS")
        || contents.file_name().is_none_or(|name| name != "Contents")
    {
        return Err(invalid(
            "Use the packaged Milagre Rust Preview or explicit open/create arguments",
        ));
    }
    let resources = contents.join("Resources");
    private_directory(&resources)?;
    let value: Value =
        serde_json::from_slice(&read_config(&resources.join("preview-launch.json"))?)
            .map_err(|_| invalid("Invalid Preview launch JSON"))?;
    if value.as_object().is_none_or(|object| {
        object.len() != 3
            || object
                .keys()
                .any(|key| !matches!(key.as_str(), "schema" | "kind" | "dataRoot"))
    }) || value["schema"] != 1
        || value["kind"] != "milagre-rust-preview"
    {
        return Err(invalid("Invalid Preview launch JSON schema"));
    }
    let text = value["dataRoot"]
        .as_str()
        .filter(|text| !text.is_empty() && text.len() <= 4096 && !text.contains('\0'))
        .ok_or_else(|| invalid("Preview launch JSON requires an explicit dataRoot"))?;
    let root = Path::new(text);
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err(invalid(
            "Preview dataRoot must be an absolute normalized path",
        ));
    }
    private_directory(root)?;
    Ok(vec!["open".into(), text.into()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::fs::{DirBuilderExt, PermissionsExt},
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    struct Sandbox(PathBuf);
    impl Sandbox {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = fs::canonicalize("/tmp").unwrap().join(format!(
                "milagre-preview-helper-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::DirBuilder::new().mode(0o700).create(&root).unwrap();
            for directory in [
                "Preview.app",
                "Preview.app/Contents",
                "Preview.app/Contents/MacOS",
                "Preview.app/Contents/Resources",
                "data",
            ] {
                fs::DirBuilder::new()
                    .mode(0o700)
                    .create(root.join(directory))
                    .unwrap();
            }
            let this = Self(root);
            this.write(serde_json::json!({"schema":1,"kind":"milagre-rust-preview","dataRoot":this.0.join("data")}));
            this
        }
        fn executable(&self) -> PathBuf {
            self.0.join("Preview.app/Contents/MacOS/milagre-rust-chat")
        }
        fn config(&self) -> PathBuf {
            self.0
                .join("Preview.app/Contents/Resources/preview-launch.json")
        }
        fn write(&self, value: Value) {
            fs::write(self.config(), value.to_string()).unwrap();
            fs::set_permissions(self.config(), fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    #[test]
    fn explicit_arguments_are_unchanged_without_bundle_discovery() {
        let args = vec!["open".into(), "/explicit/root".into()];
        assert_eq!(arguments(&args, Path::new("/nonexistent")).unwrap(), args);
    }
    #[test]
    fn finder_arguments_name_only_the_bundled_existing_root() {
        let sandbox = Sandbox::new();
        assert_eq!(
            arguments(&[], &sandbox.executable()).unwrap(),
            vec![
                "open".to_string(),
                sandbox.0.join("data").to_str().unwrap().to_string()
            ]
        );
        assert!(
            !sandbox.0.join("data/project").exists(),
            "helper never initializes data"
        );
    }
    #[test]
    fn launch_file_refuses_public_symlink_hardlink_large_and_unknown_fields() {
        let sandbox = Sandbox::new();
        fs::set_permissions(sandbox.config(), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(arguments(&[], &sandbox.executable()).is_err());
        fs::set_permissions(sandbox.config(), fs::Permissions::from_mode(0o600)).unwrap();
        let other = sandbox.0.join("retained.json");
        fs::rename(sandbox.config(), &other).unwrap();
        std::os::unix::fs::symlink(&other, sandbox.config()).unwrap();
        assert!(arguments(&[], &sandbox.executable()).is_err());
        fs::remove_file(sandbox.config()).unwrap();
        fs::hard_link(&other, sandbox.config()).unwrap();
        assert!(arguments(&[], &sandbox.executable()).is_err());
        fs::remove_file(sandbox.config()).unwrap();
        fs::rename(other, sandbox.config()).unwrap();
        fs::write(sandbox.config(), vec![b' '; LIMIT as usize + 1]).unwrap();
        assert!(arguments(&[], &sandbox.executable()).is_err());
        sandbox.write(serde_json::json!({"schema":1,"kind":"milagre-rust-preview","dataRoot":sandbox.0.join("data"),"socket":"/arbitrary"}));
        assert!(arguments(&[], &sandbox.executable()).is_err());
    }
    #[test]
    fn launch_refuses_foreign_path_shapes_and_substituted_directories() {
        let sandbox = Sandbox::new();
        for root in [
            "relative",
            "/tmp/../foreign",
            "/tmp/./foreign",
            "/tmp/foreign\0",
        ] {
            sandbox.write(
                serde_json::json!({"schema":1,"kind":"milagre-rust-preview","dataRoot":root}),
            );
            assert!(arguments(&[], &sandbox.executable()).is_err());
        }
        let data = sandbox.0.join("data");
        sandbox
            .write(serde_json::json!({"schema":1,"kind":"milagre-rust-preview","dataRoot":data}));
        fs::rename(&data, sandbox.0.join("retained-data")).unwrap();
        std::os::unix::fs::symlink(sandbox.0.join("retained-data"), &data).unwrap();
        assert!(arguments(&[], &sandbox.executable()).is_err());
    }
}
