//! Descriptor-relative operations: no symlink may redirect a store read/write.
use crate::error::{Error, Result};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    path::{Component, Path},
    sync::atomic::{AtomicI32, AtomicU64, Ordering},
};

/// Fixed-size process-local observations, not a claim that a store is unlocked.
/// Any recorded failure means explicit release was uncertain. File close still
/// runs, but another inherited descriptor may keep that lease alive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockReleaseDiagnostics {
    pub failures: u64,
    pub last_os_error: Option<i32>,
}
struct ReleaseCounters {
    failures: AtomicU64,
    last_os_error: AtomicI32,
}
static RELEASE_COUNTERS: ReleaseCounters = ReleaseCounters {
    failures: AtomicU64::new(0),
    last_os_error: AtomicI32::new(0),
};
impl ReleaseCounters {
    fn failed(&self, error: &std::io::Error) {
        self.last_os_error
            .store(error.raw_os_error().unwrap_or(0), Ordering::Relaxed);
        let _ = self
            .failures
            .try_update(Ordering::Release, Ordering::Relaxed, |count| {
                Some(count.saturating_add(1))
            });
    }
    fn snapshot(&self) -> LockReleaseDiagnostics {
        let failures = self.failures.load(Ordering::Acquire);
        let errno = self.last_os_error.load(Ordering::Relaxed);
        LockReleaseDiagnostics {
            failures,
            last_os_error: (errno != 0).then_some(errno),
        }
    }
}
/// Non-destructive process-local diagnostic. Constant memory, saturating count,
/// no paths, callbacks, logging, allocation or mutex in a store's destructor.
/// The count and last errno are separate observations, not a transactional or
/// store-specific record when several guards fail concurrently.
pub fn lock_release_diagnostics() -> LockReleaseDiagnostics {
    RELEASE_COUNTERS.snapshot()
}
type Flock = fn(libc::c_int, libc::c_int) -> std::io::Result<()>;
fn system_flock(fd: libc::c_int, operation: libc::c_int) -> std::io::Result<()> {
    if unsafe { libc::flock(fd, operation) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
fn acquire_error(error: std::io::Error) -> Error {
    match error.raw_os_error() {
        Some(errno) if errno == libc::EWOULDBLOCK || errno == libc::EAGAIN => Error::coded(
            "STORE_OWNED",
            "This isolated Artifact store already has a Rust writer.",
        ),
        Some(libc::EINTR) => Error::coded(
            "LOCK_INTERRUPTED",
            "Content-store lock acquisition was interrupted; ownership was not acquired.",
        ),
        _ => error.into(),
    }
}

/// One owning process controls this advisory lock. A fork/dup can retain the
/// open-file description after File::drop, so release explicitly before close.
/// Never unlock from a forked child's destructor: that would release the parent's
/// still-live lease. This guard is deliberately neither Clone nor clonable by API.
pub struct StoreLock {
    file: File,
    owner_pid: libc::pid_t,
    unlock: Flock,
}
impl Drop for StoreLock {
    fn drop(&mut self) {
        if unsafe { libc::getpid() } == self.owner_pid {
            if let Err(error) = (self.unlock)(self.file.as_raw_fd(), libc::LOCK_UN) {
                RELEASE_COUNTERS.failed(&error);
            }
        }
    }
}

pub struct Dir(File);
fn name(value: &str) -> Result<CString> {
    if value.is_empty() || value == "." || value == ".." || value.contains('/') {
        return Err(Error::new("Invalid store path."));
    }
    CString::new(value).map_err(|_| Error::new("Invalid store path."))
}
impl Dir {
    pub fn open_absolute(path: &Path) -> Result<Self> {
        if !path.is_absolute() {
            return Err(Error::new("Store root must be absolute."));
        }
        let root = CString::new("/").unwrap();
        let fd = unsafe {
            libc::open(
                root.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut dir = Self(unsafe { File::from_raw_fd(fd) });
        for component in path.components() {
            if let Component::Normal(part) = component {
                dir = dir.child(
                    part.to_str()
                        .ok_or_else(|| Error::new("Store paths must be UTF-8."))?,
                    false,
                )?;
            } else if !matches!(component, Component::RootDir) {
                return Err(Error::new("Invalid store root."));
            }
        }
        Ok(dir)
    }
    pub fn child(&self, part: &str, create: bool) -> Result<Self> {
        let part = name(part)?;
        if create && unsafe { libc::mkdirat(self.0.as_raw_fd(), part.as_ptr(), 0o700) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(error.into());
            }
        }
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                part.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(unsafe { File::from_raw_fd(fd) }))
    }
    pub fn open(&self, part: &str) -> Result<File> {
        let part = name(part)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                part.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let metadata = file.metadata()?;
        if !metadata.is_file() || std::os::unix::fs::MetadataExt::nlink(&metadata) != 1 {
            return Err(Error::coded(
                "UNSAFE_FILE",
                "Only regular files with one link belong in the Artifact store.",
            ));
        }
        Ok(file)
    }
    pub fn create(&self, part: &str) -> Result<File> {
        let part = name(part)?;
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                part.as_ptr(),
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }
    pub fn read(&self, part: &str, limit: usize) -> Result<Vec<u8>> {
        let file = self.open(part)?;
        if file.metadata()?.len() > limit as u64 {
            return Err(Error::coded(
                "INVALID_CONTENT_STORAGE",
                "Stored content exceeds its read limit.",
            ));
        }
        let mut bytes = Vec::new();
        file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(Error::coded(
                "INVALID_CONTENT_STORAGE",
                "Stored content exceeds its read limit.",
            ));
        }
        Ok(bytes)
    }
    pub fn rename(&self, old: &str, to: &Dir, new: &str) -> Result<()> {
        let (old, new) = (name(old)?, name(new)?);
        if unsafe {
            libc::renameat(
                self.0.as_raw_fd(),
                old.as_ptr(),
                to.0.as_raw_fd(),
                new.as_ptr(),
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    pub fn remove(&self, part: &str) -> Result<()> {
        let part = name(part)?;
        if unsafe { libc::unlinkat(self.0.as_raw_fd(), part.as_ptr(), 0) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
        }
        Ok(())
    }
    pub fn atomic(
        &self,
        part: &str,
        bytes: &[u8],
        before_commit: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        let temporary = format!(
            "{}.{}.tmp",
            part,
            milagre_owner_store::ownership::random_uuid()
        );
        let result = (|| {
            let mut file = self.create(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            before_commit()?;
            self.rename(&temporary, self, part)?;
            // Rename is the commit. A platform that cannot fsync a directory must
            // not turn a committed metadata update into a rollback of its HTML.
            let _ = self.0.sync_all();
            Ok(())
        })();
        let _ = self.remove(&temporary);
        result
    }
    pub fn entries(&self) -> Result<Vec<String>> {
        // Reopen "." instead of dup: dup would share a consumed directory offset.
        let dot = CString::new(".").unwrap();
        let fd = unsafe {
            libc::openat(
                self.0.as_raw_fd(),
                dot.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        let directory = unsafe { libc::fdopendir(fd) };
        if directory.is_null() {
            unsafe { libc::close(fd) };
            return Err(std::io::Error::last_os_error().into());
        }
        let mut entries = Vec::new();
        // fdopendir owns this descriptor; each name is copied before readdir.
        loop {
            let entry = unsafe { libc::readdir(directory) };
            if entry.is_null() {
                break;
            }
            let part = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            if part != "." && part != ".." {
                entries.push(part);
            }
        }
        unsafe { libc::closedir(directory) };
        entries.sort();
        Ok(entries)
    }
    pub fn lock(&self) -> Result<StoreLock> {
        self.lock_using(system_flock)
    }
    fn lock_using(&self, acquire: Flock) -> Result<StoreLock> {
        let file = match self.create(".rust-content.lock") {
            Ok(file) => file,
            Err(_) => self.open(".rust-content.lock")?,
        };
        acquire(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB).map_err(acquire_error)?;
        Ok(StoreLock {
            file,
            owner_pid: unsafe { libc::getpid() },
            unlock: system_flock,
        })
    }
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    #[test]
    fn owner_drop_releases_lock_while_a_duplicated_descriptor_remains_open() {
        let temp = tempfile::tempdir().unwrap();
        let path = std::fs::canonicalize(temp.path()).unwrap();
        let root = Dir::open_absolute(&path).unwrap();
        let owner = root.lock().unwrap();
        let inherited = owner.file.try_clone().unwrap();
        for file in [&owner.file, &inherited] {
            let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0);
        }
        assert_eq!(root.lock().err().unwrap().code, "STORE_OWNED");
        drop(owner);
        let successor = root
            .lock()
            .expect("Owner release must not wait for an inherited fd to close");
        assert_eq!(root.lock().err().unwrap().code, "STORE_OWNED");
        drop(inherited);
        assert_eq!(root.lock().err().unwrap().code, "STORE_OWNED");
        drop(successor);
        root.lock().unwrap();
    }
    #[test]
    fn interrupted_and_failed_acquisition_are_not_reported_as_contention_or_retried() {
        use std::sync::atomic::AtomicUsize;
        static CALLS: AtomicUsize = AtomicUsize::new(0);
        fn interrupted(_: i32, _: i32) -> std::io::Result<()> {
            CALLS.fetch_add(1, Ordering::Relaxed);
            Err(std::io::Error::from_raw_os_error(libc::EINTR))
        }
        fn io_error(_: i32, _: i32) -> std::io::Result<()> {
            Err(std::io::Error::from_raw_os_error(libc::EIO))
        }
        let temp = tempfile::tempdir().unwrap();
        let root = Dir::open_absolute(&std::fs::canonicalize(temp.path()).unwrap()).unwrap();
        assert_eq!(
            root.lock_using(interrupted).err().unwrap().code,
            "LOCK_INTERRUPTED"
        );
        assert_eq!(CALLS.load(Ordering::Relaxed), 1);
        assert_eq!(root.lock_using(io_error).err().unwrap().code, "IO_ERROR");
        assert_eq!(
            acquire_error(std::io::Error::from_raw_os_error(libc::EWOULDBLOCK)).code,
            "STORE_OWNED"
        );
        let owner = root.lock().unwrap();
        assert_eq!(root.lock().err().unwrap().code, "STORE_OWNED");
        drop(owner);
        root.lock().unwrap();
    }

    #[test]
    fn failed_unlock_is_observable_and_does_not_claim_the_inherited_lease_released() {
        fn interrupted(_: i32, _: i32) -> std::io::Result<()> {
            Err(std::io::Error::from_raw_os_error(libc::EINTR))
        }
        fn io_error(_: i32, _: i32) -> std::io::Result<()> {
            Err(std::io::Error::from_raw_os_error(libc::EIO))
        }
        let temp = tempfile::tempdir().unwrap();
        let root = Dir::open_absolute(&std::fs::canonicalize(temp.path()).unwrap()).unwrap();
        for (fault, errno) in [
            (interrupted as Flock, libc::EINTR),
            (io_error as Flock, libc::EIO),
        ] {
            let before = lock_release_diagnostics().failures;
            let mut owner = root.lock().unwrap();
            let inherited = owner.file.try_clone().unwrap();
            owner.unlock = fault;
            drop(owner);
            let diagnostic = lock_release_diagnostics();
            assert!(diagnostic.failures > before);
            assert_eq!(diagnostic.last_os_error, Some(errno));
            assert_eq!(root.lock().err().unwrap().code, "STORE_OWNED");
            drop(inherited);
            root.lock().unwrap();
        }
        let bounded = ReleaseCounters {
            failures: AtomicU64::new(u64::MAX - 1),
            last_os_error: AtomicI32::new(0),
        };
        bounded.failed(&std::io::Error::from_raw_os_error(libc::EIO));
        bounded.failed(&std::io::Error::from_raw_os_error(libc::EINTR));
        assert_eq!(
            bounded.snapshot(),
            LockReleaseDiagnostics {
                failures: u64::MAX,
                last_os_error: Some(libc::EINTR)
            }
        );
    }
}
