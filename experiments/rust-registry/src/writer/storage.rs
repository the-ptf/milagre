use super::*;
use std::{
    ffi::CString,
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    sync::Arc,
};
use uuid::Uuid;
const MARKER: &str = "MILAGRE-REGISTRY-COPY";
const LOCK: &str = ".registry-writer.lock";
fn io(e: impl std::fmt::Display) -> WriteError {
    WriteError::refused(e.to_string())
}
fn name(value: &str) -> std::result::Result<CString, WriteError> {
    CString::new(value).map_err(io)
}
fn open(dir: &File, file: &str, flags: i32) -> WResult<File> {
    let file = name(file)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            file.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn regular(file: &File) -> WResult<()> {
    let meta = file.metadata().map_err(io)?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > MAX_FILE {
        return Err(WriteError::refused(
            "Unsafe or oversized registry copy file.",
        ));
    }
    Ok(())
}
fn same(a: &File, b: &File) -> WResult<bool> {
    let a = a.metadata().map_err(io)?;
    let b = b.metadata().map_err(io)?;
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}
fn read(dir: &File, path: &str) -> WResult<Option<Vec<u8>>> {
    let mut file = match open(dir, path, libc::O_RDONLY) {
        Ok(f) => f,
        Err(e) => {
            if unsafe {
                libc::faccessat(
                    dir.as_raw_fd(),
                    name(path)?.as_ptr(),
                    libc::F_OK,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } < 0
                && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
            {
                return Ok(None);
            }
            return Err(e);
        }
    };
    regular(&file)?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(MAX_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(WriteError::refused("Registry copy file limit exceeded."));
    }
    Ok(Some(bytes))
}
fn create(dir: &File, path: &str, bytes: &[u8]) -> WResult<()> {
    let mut file = open(dir, path, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
    file.write_all(bytes).map_err(io)?;
    file.sync_all().map_err(io)
}
fn directory(path: &Path) -> WResult<File> {
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(io)
}
struct CopyRoot {
    isolation: Isolation,
    root: File,
    dir: File,
    path: PathBuf,
    child: String,
    token: String,
    lock_anchor: File,
}
#[derive(Clone)]
pub struct RegistryCopy(Arc<CopyRoot>);
#[derive(Default)]
pub struct Seeds {
    pub registry: Option<Vec<u8>>,
    pub recent: Option<Vec<u8>>,
}
impl RegistryCopy {
    /// Fresh descriptor-relative child of an existing Isolation. Never adopts an
    /// existing profile or reads a seed from an arbitrary path.
    pub fn create(isolation: Isolation, seeds: Seeds) -> WResult<Self> {
        for bytes in [&seeds.registry, &seeds.recent].into_iter().flatten() {
            if bytes.len() as u64 > MAX_FILE {
                return Err(WriteError::refused("Registry seed limit exceeded."));
            }
        }
        let root = directory(isolation.root())?;
        let token = Uuid::new_v4().to_string();
        let child = format!("registry-copy-{token}");
        if unsafe { libc::mkdirat(root.as_raw_fd(), name(&child)?.as_ptr(), 0o700) } != 0 {
            return Err(io(std::io::Error::last_os_error()));
        }
        let dir = open(&root, &child, libc::O_RDONLY | libc::O_DIRECTORY)?;
        create(&dir, MARKER, token.as_bytes())?;
        create(&dir, LOCK, b"")?;
        let lock_anchor = open(&dir, LOCK, libc::O_RDONLY)?;
        for (path, bytes) in [
            ("project-registry.json", seeds.registry),
            ("recent-projects.json", seeds.recent),
        ] {
            if let Some(bytes) = bytes {
                create(&dir, path, &bytes)?;
            }
        }
        dir.sync_all().map_err(io)?;
        let path = isolation.root().join(&child);
        Ok(Self(Arc::new(CopyRoot {
            isolation,
            root,
            dir,
            path,
            child,
            token,
            lock_anchor,
        })))
    }
    pub fn path(&self) -> &Path {
        &self.0.path
    }
    fn verify(&self) -> WResult<()> {
        let root = directory(self.0.isolation.root())?;
        if !same(&root, &self.0.root)? {
            return Err(WriteError::refused("Registry isolation identity changed."));
        }
        let dir = open(
            &self.0.root,
            &self.0.child,
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        let lock = open(&self.0.dir, LOCK, libc::O_RDONLY)?;
        if !same(&lock, &self.0.lock_anchor)? {
            return Err(WriteError::refused("Registry copy lock identity changed."));
        }
        if !same(&dir, &self.0.dir)?
            || read(&dir, MARKER)?.as_deref() != Some(self.0.token.as_bytes())
        {
            return Err(WriteError::refused("Registry copy identity changed."));
        }
        Ok(())
    }
    pub fn reader(&self, active: Active) -> WResult<Registry> {
        self.verify()?;
        Registry::open(self.0.isolation.clone(), &self.0.path, active).map_err(WriteError::refused)
    }
    pub(crate) fn acquire(&self, active: Active) -> WResult<Store> {
        self.verify()?;
        active().map_err(WriteError::refused)?;
        let dir = open(
            &self.0.root,
            &self.0.child,
            libc::O_RDONLY | libc::O_DIRECTORY,
        )?;
        if unsafe { libc::flock(dir.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(WriteError::refused("Registry copy already has a writer."));
        }
        let mut lock = open(&self.0.dir, LOCK, libc::O_RDWR)?;
        regular(&lock)?;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(WriteError::refused("Registry copy already has a writer."));
        }
        self.verify()?;
        active().map_err(WriteError::refused)?;
        if !same(&dir, &self.0.dir)? || !same(&lock, &self.0.lock_anchor)? {
            return Err(WriteError::refused(
                "Registry copy identity changed before acquisition.",
            ));
        }
        let token = Uuid::new_v4().to_string();
        lock.set_len(0).map_err(io)?;
        lock.write_all(token.as_bytes()).map_err(io)?;
        lock.sync_all().map_err(io)?;
        let store = Store {
            copy: self.clone(),
            _dir_lock: dir,
            lock,
            token,
            active,
        };
        store.verify()?;
        Ok(store)
    }
}
pub(crate) struct Store {
    copy: RegistryCopy,
    _dir_lock: File,
    lock: File,
    token: String,
    active: Active,
}
impl Store {
    pub fn verify(&self) -> WResult<()> {
        (self.active)().map_err(WriteError::refused)?;
        self.copy.verify()?;
        let current = open(&self.copy.0.dir, LOCK, libc::O_RDONLY)?;
        if !same(&current, &self.lock)?
            || read(&self.copy.0.dir, LOCK)?.as_deref() != Some(self.token.as_bytes())
        {
            return Err(WriteError::refused("Registry writer ownership changed."));
        }
        Ok(())
    }
    pub fn read(&self, path: &str) -> WResult<Option<Vec<u8>>> {
        self.verify()?;
        read(&self.copy.0.dir, path)
    }
    pub fn replace(
        &self,
        path: &str,
        expected: Option<&[u8]>,
        bytes: &[u8],
        fault: Fault,
    ) -> WResult<()> {
        self.verify()?;
        if self.read(path)?.as_deref() != expected {
            return Err(WriteError::refused("Registry changed before commit."));
        }
        if bytes.len() as u64 > MAX_FILE {
            return Err(WriteError::refused("Registry output limit exceeded."));
        }
        if fault == Fault::BeforeStage {
            return Err(WriteError::refused("Injected failure before staging."));
        }
        let temp = format!(".registry-{}-{}.tmp", self.copy.0.token, Uuid::new_v4());
        let result = (|| {
            create(&self.copy.0.dir, &temp, bytes)?;
            self.verify()?;
            if fault == Fault::BeforeRename {
                return Err(WriteError::refused("Injected failure before rename."));
            }
            if self.read(path)?.as_deref() != expected {
                return Err(WriteError::refused("Registry changed before rename."));
            }
            if unsafe {
                libc::renameat(
                    self.copy.0.dir.as_raw_fd(),
                    name(&temp)?.as_ptr(),
                    self.copy.0.dir.as_raw_fd(),
                    name(path)?.as_ptr(),
                )
            } != 0
            {
                return Err(io(std::io::Error::last_os_error()));
            }
            if fault == Fault::AfterRename {
                return Err(WriteError::uncertain(
                    "Registry rename committed; durability is uncertain. Do not replay.",
                ));
            }
            self.copy.0.dir.sync_all().map_err(|_| {
                WriteError::uncertain(
                    "Registry rename committed; directory sync failed. Do not replay.",
                )
            })?;
            Ok(())
        })();
        // Only this operation's unpredictable staging name, against its pinned dir.
        // A changed ownership token forbids cleanup too; reopening does not delete
        // arbitrary crash leftovers or adopt staging data as a committed registry.
        if self.verify().is_ok() {
            let _ =
                unsafe { libc::unlinkat(self.copy.0.dir.as_raw_fd(), name(&temp)?.as_ptr(), 0) };
        }
        result
    }
}
