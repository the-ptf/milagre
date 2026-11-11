//! Descriptor-relative operations: no symlink may redirect a store read/write.
use crate::error::{Error, Result};
use std::{
    ffi::{CStr, CString},
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd},
    path::{Component, Path},
};

/// One owning process controls this advisory lock. A fork/dup can retain the
/// open-file description after File::drop, so release explicitly before close.
/// Never unlock from a forked child's destructor: that would release the parent's
/// still-live lease. This guard is deliberately neither Clone nor clonable by API.
pub struct StoreLock {
    file: File,
    owner_pid: libc::pid_t,
}
impl Drop for StoreLock {
    fn drop(&mut self) {
        if unsafe { libc::getpid() } == self.owner_pid {
            // A valid flock-acquired regular-file descriptor supports LOCK_UN.
            // On an unexpected OS failure, File's close remains the fallback;
            // retained duplicates then fail closed instead of admitting a writer.
            let _ = unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
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
        let file = match self.create(".rust-content.lock") {
            Ok(file) => file,
            Err(_) => self.open(".rust-content.lock")?,
        };
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(Error::coded(
                "STORE_OWNED",
                "This isolated Artifact store already has a Rust writer.",
            ));
        }
        Ok(StoreLock {
            file,
            owner_pid: unsafe { libc::getpid() },
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
}
