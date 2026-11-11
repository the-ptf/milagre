use super::{Error, Result};
use std::{
    fs::{self, File, OpenOptions},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
};

pub(super) struct Directory {
    file: File,
    path: PathBuf,
    identity: (u64, u64, u32),
}
impl Directory {
    pub(super) fn open(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(path)
            .map_err(|_| Error::Identity)?;
        let meta = file.metadata().map_err(|_| Error::Identity)?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
            return Err(Error::Identity);
        }
        let pin = Self { file, path: path.to_owned(), identity: (meta.dev(), meta.ino(), meta.mode()) };
        pin.check()?;
        Ok(pin)
    }
    pub(super) fn check(&self) -> Result<()> {
        let held = self.file.metadata().map_err(|_| Error::Identity)?;
        let current = fs::symlink_metadata(&self.path).map_err(|_| Error::Identity)?;
        if !current.is_dir()
            || current.file_type().is_symlink()
            || (held.dev(), held.ino(), held.mode()) != self.identity
            || (current.dev(), current.ino(), current.mode()) != self.identity
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub(super) fn identity(&self) -> (u64, u64) {
        (self.identity.0, self.identity.1)
    }
    pub(super) fn retained_identity(&self) -> Result<(u64, u64)> {
        let meta = self.file.metadata().map_err(|_| Error::Identity)?;
        Ok((meta.dev(), meta.ino()))
    }
    pub(super) fn descriptor_is_directory(&self) -> bool {
        self.file.metadata().is_ok_and(|m| m.is_dir())
            && unsafe { libc::fcntl(self.file.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC != 0
    }
}

pub(super) struct Root {
    pub(super) path: PathBuf,
    pin: Directory,
}
impl Root {
    pub(super) fn create() -> Result<Self> {
        let root = tempfile::Builder::new().prefix("milagre-acp-service-").tempdir_in("/private/tmp").map_err(|_| Error::Storage)?;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).map_err(|_| Error::Storage)?;
        let path = root.keep();
        Self::owned(path).map_err(|_| Error::CleanupUncertain)
    }
    pub(super) fn owned(path: PathBuf) -> Result<Self> {
        Ok(Self { pin: Directory::open(&path)?, path })
    }
    pub(super) fn check(&self) -> Result<()> {
        self.pin.check()
    }
    pub(super) fn identity(&self) -> (u64, u64) {
        self.pin.identity()
    }
    /// Bounded teardown of this generated copy only, after service closure. No symlinks,
    /// hard links, unknown owners, cross-device entries or recursive ambient path input.
    pub(super) fn cleanup(&self) -> Result<()> {
        self.check()?;
        remove(&self.path, self.pin.identity().0, &mut 2048, 0)?;
        Ok(())
    }
}
fn remove(path: &Path, device: u64, remaining: &mut usize, depth: usize) -> Result<()> {
    if *remaining == 0 || depth > 12 {
        return Err(Error::CleanupUncertain);
    }
    *remaining -= 1;
    let meta = fs::symlink_metadata(path).map_err(|_| Error::CleanupUncertain)?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.dev() != device || meta.file_type().is_symlink() {
        return Err(Error::CleanupUncertain);
    }
    if meta.is_dir() {
        let pin = Directory::open(path).map_err(|_| Error::CleanupUncertain)?;
        for entry in fs::read_dir(path).map_err(|_| Error::CleanupUncertain)? {
            pin.check().map_err(|_| Error::CleanupUncertain)?;
            remove(&entry.map_err(|_| Error::CleanupUncertain)?.path(), device, remaining, depth + 1)?;
        }
        pin.check().map_err(|_| Error::CleanupUncertain)?;
        fs::remove_dir(path).map_err(|_| Error::CleanupUncertain)
    } else if meta.is_file() && meta.nlink() == 1 {
        let current = fs::symlink_metadata(path).map_err(|_| Error::CleanupUncertain)?;
        if (meta.dev(), meta.ino()) != (current.dev(), current.ino()) {
            return Err(Error::CleanupUncertain);
        }
        fs::remove_file(path).map_err(|_| Error::CleanupUncertain)
    } else {
        Err(Error::CleanupUncertain)
    }
}
