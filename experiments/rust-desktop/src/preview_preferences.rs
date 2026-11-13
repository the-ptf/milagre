//! Private Tauri preferences within an already admitted dedicated Chat root.
//! Never used by fixtures or the ordinary installed Rust/Electron applications.
use serde_json::{Map, Value};
use std::{
    ffi::CString,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const NAME: &str = "native-tauri-preferences.json";
const MANIFEST: &str = "rust-chat-runtime.json";
const LOCK: &str = ".native-tauri-preferences.lock";
const LIMIT: u64 = 1024 * 1024;
type Pin = (u64, u64, u32, u32, u64, u64, i64, i64, i64, i64);
fn invalid() -> io::Error {
    io::Error::other("Dedicated Tauri preferences identity invalid or changed")
}
fn pin(m: &Metadata) -> io::Result<Pin> {
    if !m.is_file()
        || m.uid() != unsafe { libc::getuid() }
        || m.mode() & 0o7777 != 0o600
        || m.nlink() != 1
        || m.len() > LIMIT
    {
        return Err(invalid());
    }
    Ok((
        m.dev(),
        m.ino(),
        m.mode(),
        m.uid(),
        m.nlink(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
fn at(dir: &File, name: &str, flags: i32) -> io::Result<File> {
    let name = CString::new(name).map_err(|_| invalid())?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn current(dir: &File, name: &str) -> io::Result<Option<Pin>> {
    match at(dir, name, libc::O_RDONLY) {
        Ok(file) => Ok(Some(pin(&file.metadata()?)?)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
pub(super) struct Store {
    root: PathBuf,
    directory: File,
    identity: (u64, u64, u32, u32),
    lock: File,
    lock_pin: Pin,
    saved: Option<Pin>,
    manifest: Pin,
    uncertain: bool,
}
impl Store {
    // The caller supplies only the dedicated root admitted by its retained child.
    pub(super) fn open(root: &Path) -> io::Result<(Self, Map<String, Value>)> {
        let m = fs::symlink_metadata(root)?;
        if !m.is_dir()
            || m.uid() != unsafe { libc::getuid() }
            || m.mode() & 0o7777 != 0o700
            || fs::canonicalize(root)? != root
        {
            return Err(invalid());
        }
        let directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)?;
        let identity = (m.dev(), m.ino(), m.mode(), m.uid());
        let held = directory.metadata()?;
        if (held.dev(), held.ino(), held.mode(), held.uid()) != identity
            || fs::canonicalize(root)? != root
        {
            return Err(invalid());
        }
        let lock = at(&directory, LOCK, libc::O_RDWR | libc::O_CREAT)?;
        let lock_pin = pin(&lock.metadata()?)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let manifest = current(&directory, MANIFEST)?.ok_or_else(invalid)?;
        let saved = current(&directory, NAME)?;
        let store = Self {
            root: root.into(),
            directory,
            identity,
            lock,
            lock_pin,
            saved,
            manifest,
            uncertain: false,
        };
        store.check()?;
        let values = if saved.is_some() {
            let mut file = at(&store.directory, NAME, libc::O_RDONLY)?;
            if Some(pin(&file.metadata()?)?) != saved {
                return Err(invalid());
            }
            let mut bytes = Vec::new();
            (&mut file).take(LIMIT + 1).read_to_end(&mut bytes)?;
            let map: Map<String, Value> = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
            if map.iter().any(|(k, v)| !valid(k, v)) {
                return Err(invalid());
            }
            if Some(pin(&file.metadata()?)?) != saved {
                return Err(invalid());
            }
            store.check()?;
            map
        } else {
            Map::new()
        };
        Ok((store, values))
    }
    pub(super) fn check(&self) -> io::Result<()> {
        if self.uncertain {
            return Err(invalid());
        }
        let m = fs::symlink_metadata(&self.root)?;
        let held = self.directory.metadata()?;
        if !m.is_dir()
            || (m.dev(), m.ino(), m.mode(), m.uid()) != self.identity
            || (held.dev(), held.ino(), held.mode(), held.uid()) != self.identity
            || fs::canonicalize(&self.root)? != self.root
            || pin(&self.lock.metadata()?)? != self.lock_pin
            || current(&self.directory, LOCK)? != Some(self.lock_pin)
            || current(&self.directory, NAME)? != self.saved
            || current(&self.directory, MANIFEST)? != Some(self.manifest)
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub(super) fn save_authorized(
        &mut self,
        bytes: &[u8],
        mut authority: impl FnMut() -> io::Result<()>,
    ) -> io::Result<()> {
        authority()?;
        self.save_with(bytes, |_| authority())
    }
    fn save_with(
        &mut self,
        bytes: &[u8],
        mut boundary: impl FnMut(bool) -> io::Result<()>,
    ) -> io::Result<()> {
        if bytes.len() as u64 > LIMIT {
            return Err(invalid());
        }
        self.check()?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temp = format!(
            ".native-tauri-preferences-{}-{}.tmp",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let mut file = at(
            &self.directory,
            &temp,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )?;
        let mut renamed = false;
        let result = (|| {
            file.write_all(bytes)?;
            file.sync_all()?;
            let next_pin = pin(&file.metadata()?)?;
            boundary(false)?;
            self.check()?;
            if pin(&file.metadata()?)? != next_pin
                || current(&self.directory, &temp)? != Some(next_pin)
            {
                return Err(invalid());
            }
            let from = CString::new(temp.as_str()).unwrap();
            let to = CString::new(NAME).unwrap();
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    from.as_ptr(),
                    self.directory.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(io::Error::last_os_error());
            }
            renamed = true;
            self.saved = Some(next_pin);
            self.directory.sync_all()?;
            // Rename can change ctime; obtain the retained inode's final pin.
            self.saved = Some(pin(&file.metadata()?)?);
            self.check()?;
            boundary(true)
        })();
        if renamed && result.is_err() {
            self.uncertain = true;
        }
        if !renamed {
            let name = CString::new(temp).unwrap();
            // Remove only the staging inode still held by this call.
            if let (Ok(Some(named)), Ok(held)) = (
                current(&self.directory, name.to_str().unwrap()),
                file.metadata().and_then(|metadata| pin(&metadata)),
            ) {
                if named == held {
                    unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) };
                }
            }
        }
        result
    }
}
fn valid(key: &str, value: &Value) -> bool {
    (key.starts_with("milagre-") || key.starts_with("milagre.") || key.starts_with("milagre:"))
        && (value.is_string() || value.is_null())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        let path = fs::canonicalize(dir.path()).unwrap();
        let manifest = at(
            &File::open(&path).unwrap(),
            MANIFEST,
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        )
        .unwrap();
        (&manifest)
            .write_all(b"synthetic dedicated manifest")
            .unwrap();
        (dir, path)
    }
    fn save(store: &mut Store, bytes: &[u8]) -> io::Result<()> {
        store.save_authorized(bytes, || Ok(()))
    }
    #[test]
    fn saves_and_reopens_exact_private_preferences_without_inheriting_other_files() {
        let (_dir, path) = root();
        let (mut store, map) = Store::open(&path).unwrap();
        assert!(map.is_empty());
        let bytes = br#"{"milagre-theme":"dark","milagre:model":null}"#;
        save(&mut store, bytes).unwrap();
        assert_eq!(fs::read(path.join(NAME)).unwrap(), bytes);
        assert_eq!(fs::metadata(path.join(NAME)).unwrap().mode() & 0o777, 0o600);
        assert!(Store::open(&path).is_err());
        drop(store);
        let (_store, map) = Store::open(&path).unwrap();
        assert_eq!(map["milagre-theme"], "dark");
        assert_eq!(map["milagre:model"], Value::Null);
    }
    #[test]
    fn malformed_nonmap_or_foreign_values_refuse_without_rewriting() {
        for bytes in [
            b"{".as_slice(),
            b"[]",
            br#"{"foreign":"x"}"#,
            br#"{"milagre-theme":4}"#,
        ] {
            let (_dir, path) = root();
            fs::write(path.join(NAME), bytes).unwrap();
            fs::set_permissions(path.join(NAME), fs::Permissions::from_mode(0o600)).unwrap();
            assert!(Store::open(&path).is_err());
            assert_eq!(fs::read(path.join(NAME)).unwrap(), bytes);
        }
    }
    #[test]
    fn replaced_root_cannot_receive_preferences() {
        let (_dir, path) = root();
        let (mut store, _) = Store::open(&path).unwrap();
        let moved = path.with_extension("held");
        fs::rename(&path, &moved).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(save(&mut store, br#"{"milagre-theme":"dark"}"#).is_err());
        assert!(fs::read_dir(&path).unwrap().next().is_none());
        fs::remove_dir_all(moved).unwrap();
    }
    #[test]
    fn symlink_and_replaced_file_or_manifest_refuse() {
        let (_dir, path) = root();
        symlink(path.join(MANIFEST), path.join(NAME)).unwrap();
        assert!(Store::open(&path).is_err());
        fs::remove_file(path.join(NAME)).unwrap();
        let (mut store, _) = Store::open(&path).unwrap();
        save(&mut store, br#"{"milagre-theme":"dark"}"#).unwrap();
        fs::rename(path.join(NAME), path.join("old")).unwrap();
        fs::copy(path.join("old"), path.join(NAME)).unwrap();
        assert!(store.check().is_err());
        assert!(save(&mut store, b"{}").is_err());
        drop(store);
        let (mut store, _) = Store::open(&path).unwrap();
        fs::rename(path.join(MANIFEST), path.join("old-manifest")).unwrap();
        fs::copy(path.join("old-manifest"), path.join(MANIFEST)).unwrap();
        assert!(save(&mut store, b"{}").is_err());
    }
    #[test]
    fn foreign_modes_hardlinks_and_oversize_files_fail_closed() {
        let (_dir, path) = root();
        let (mut store, _) = Store::open(&path).unwrap();
        assert!(save(&mut store, &vec![b' '; LIMIT as usize + 1]).is_err());
        save(&mut store, b"{}").unwrap();
        drop(store);
        fs::set_permissions(path.join(NAME), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Store::open(&path).is_err());
        fs::set_permissions(path.join(NAME), fs::Permissions::from_mode(0o600)).unwrap();
        fs::hard_link(path.join(NAME), path.join("foreign-link")).unwrap();
        assert!(Store::open(&path).is_err());
        fs::remove_file(path.join("foreign-link")).unwrap();
        let file = OpenOptions::new()
            .write(true)
            .open(path.join(NAME))
            .unwrap();
        file.set_len(LIMIT + 1).unwrap();
        assert!(Store::open(&path).is_err());
    }
    #[test]
    fn replaced_staging_inode_never_replaces_canonical_or_gets_deleted() {
        let (_dir, path) = root();
        let (mut store, _) = Store::open(&path).unwrap();
        save(&mut store, b"{}").unwrap();
        let mut staged = None;
        let result = store.save_with(br#"{"milagre-theme":"dark"}"#, |renamed| {
            assert!(!renamed);
            let temp = fs::read_dir(&path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|name| name.extension().is_some_and(|ext| ext == "tmp"))
                .unwrap();
            fs::rename(&temp, path.join("retained-stage"))?;
            fs::write(&temp, b"foreign replacement")?;
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o600))?;
            staged = Some(temp);
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(path.join(NAME)).unwrap(), b"{}");
        assert_eq!(fs::read(staged.unwrap()).unwrap(), b"foreign replacement");
        store.check().unwrap();
    }
    #[test]
    fn invalid_held_and_named_staging_pins_never_authorize_cleanup() {
        let (_dir, path) = root();
        let (mut store, _) = Store::open(&path).unwrap();
        save(&mut store, b"{}").unwrap();
        let mut staged = None;
        let result = store.save_with(br#"{"milagre-theme":"dark"}"#, |renamed| {
            assert!(!renamed);
            let temp = fs::read_dir(&path)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .find(|name| name.extension().is_some_and(|ext| ext == "tmp"))
                .unwrap();
            // Both pathname and held-file validation now fail. This must never
            // collapse into None == None and authorize an unlink.
            fs::set_permissions(&temp, fs::Permissions::from_mode(0o644))?;
            staged = Some(temp);
            Ok(())
        });
        assert!(result.is_err());
        assert_eq!(fs::read(path.join(NAME)).unwrap(), b"{}");
        assert!(staged.unwrap().exists());
        store.check().unwrap();
    }
    #[test]
    fn failed_pre_rename_write_retains_previous_bytes_and_allows_retry() {
        let (_dir, path) = root();
        let (mut store, _) = Store::open(&path).unwrap();
        save(&mut store, b"{}").unwrap();
        assert!(store
            .save_with(br#"{"milagre-theme":"dark"}"#, |_| Err(io::Error::other(
                "injected pre-rename fault"
            )))
            .is_err());
        assert_eq!(fs::read(path.join(NAME)).unwrap(), b"{}");
        assert!(!fs::read_dir(&path).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        save(&mut store, br#"{"milagre-theme":"light"}"#).unwrap();
    }
    #[test]
    fn post_rename_failure_is_not_acknowledged_and_fences_until_reopen() {
        let (_dir, path) = root();
        let (mut store, _) = Store::open(&path).unwrap();
        save(&mut store, b"{}").unwrap();
        let candidate = br#"{"milagre-theme":"dark"}"#;
        assert!(store
            .save_with(candidate, |renamed| if renamed {
                Err(io::Error::other("injected post-rename acceptance fault"))
            } else {
                Ok(())
            })
            .is_err());
        assert_eq!(fs::read(path.join(NAME)).unwrap(), candidate);
        assert!(store.check().is_err());
        assert!(save(&mut store, b"{}").is_err());
        drop(store);
        assert_eq!(Store::open(&path).unwrap().1["milagre-theme"], "dark");
    }
    #[test]
    fn lost_child_authority_before_or_after_rename_never_acknowledged() {
        for fail_at in [0, 1, 2] {
            let (_dir, path) = root();
            let (mut store, _) = Store::open(&path).unwrap();
            let mut calls = 0;
            let result = store.save_authorized(b"{}", || {
                let current = calls;
                calls += 1;
                if current == fail_at {
                    Err(io::Error::other("child exited"))
                } else {
                    Ok(())
                }
            });
            assert!(result.is_err());
            assert_eq!(path.join(NAME).exists(), fail_at == 2);
            if fail_at == 2 {
                assert!(store.check().is_err());
            }
        }
    }
}
