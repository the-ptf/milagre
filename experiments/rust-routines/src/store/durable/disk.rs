//! Descriptor-relative persistence adapted from store/copied/io.rs and writer.rs.
use super::*;
use std::{
    ffi::CString,
    fs::{self, OpenOptions},
    io::Write,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::{FileExt, MetadataExt, OpenOptionsExt},
    },
};
const FILE: &str = "routines.json";
const DIRECTORY: &str = "routines";
const LOCK: &str = ".routine-writer.lock";
const MANIFEST: &str = "rust-chat-runtime.json";

#[derive(Clone, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,
}
fn safe(file: &File, directory: bool) -> Result<Identity> {
    let meta = file.metadata().map_err(|e| io("metadata", e))?;
    if meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
        || if directory {
            !meta.is_dir()
        } else {
            !meta.is_file() || meta.nlink() != 1
        }
    {
        return Err(Error::Ownership);
    }
    Ok(Identity {
        dev: meta.dev(),
        ino: meta.ino(),
        mode: meta.mode() & 0o7777,
        uid: meta.uid(),
    })
}
fn open_at(dir: &File, name: &str, flags: i32, mode: u32) -> Result<File> {
    let name = CString::new(name).map_err(|_| Error::Ownership)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode,
        )
    };
    if fd < 0 {
        return Err(io("openat", std::io::Error::last_os_error()));
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn missing(error: &Error) -> bool {
    matches!(error,Error::Io{source,..} if source.raw_os_error()==Some(libc::ENOENT))
}
fn absent(dir: &File, name: &str) -> Result<bool> {
    match open_at(dir, name, libc::O_RDONLY, 0) {
        Ok(_) => Ok(false),
        Err(error) if missing(&error) => Ok(true),
        Err(error) => Err(error),
    }
}
fn same_at(dir: &File, name: &str, file: &File, directory: bool) -> Result<()> {
    let current = open_at(
        dir,
        name,
        libc::O_RDONLY | if directory { libc::O_DIRECTORY } else { 0 },
        0,
    )?;
    if safe(&current, directory)? != safe(file, directory)? {
        return Err(Error::Ownership);
    }
    Ok(())
}
fn bytes(file: &File, max: usize) -> Result<Vec<u8>> {
    safe(file, false)?;
    let before = file.metadata().map_err(|e| io("stat before read", e))?;
    if before.len() > max as u64 {
        return Err(Error::Invalid(
            "Routine metadata exceeds its byte bound".into(),
        ));
    }
    let mut out = Vec::with_capacity(before.len() as usize);
    let mut block = [0; 8192];
    loop {
        let n = file
            .read_at(&mut block, out.len() as u64)
            .map_err(|e| io("read", e))?;
        if n == 0 {
            break;
        }
        if out.len() + n > max {
            return Err(Error::Invalid(
                "Routine metadata exceeds its byte bound".into(),
            ));
        }
        out.extend_from_slice(&block[..n]);
    }
    let after = file.metadata().map_err(|e| io("stat after read", e))?;
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || before.ctime() != after.ctime()
        || before.ctime_nsec() != after.ctime_nsec()
    {
        return Err(Error::Ownership);
    }
    safe(file, false)?;
    Ok(out)
}
fn flock(file: &File, operation: i32) -> Result<()> {
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), operation) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        if operation & libc::LOCK_NB != 0 && matches!(error.raw_os_error(), Some(libc::EWOULDBLOCK))
        {
            return Err(Error::Busy);
        }
        return Err(io("flock", error));
    }
}
fn make_directory(root: &File) -> Result<File> {
    let name = CString::new(DIRECTORY).unwrap();
    if unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(io("mkdirat", error));
        }
    }
    let file = open_at(root, DIRECTORY, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    safe(&file, true)?;
    root.sync_all()
        .map_err(|e| io("sync routines directory entry", e))?;
    Ok(file)
}
struct Saved {
    file: File,
    bytes: Vec<u8>,
}
struct Stage {
    name: String,
    saved: Saved,
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Fault {
    None,
    BeforeWrite,
    BeforeRename,
    AfterRename,
    BeforeRenameAndCleanup,
}

pub(super) struct Disk {
    pub(super) path: PathBuf,
    root_path: PathBuf,
    root: File,
    root_identity: Identity,
    manifest: Saved,
    directory: File,
    lock: File,
    saved: Option<Saved>,
    stage: Option<Stage>,
    intent: Option<String>,
    pub(super) uncertain: bool,
    closed: bool,
    #[cfg(test)]
    pub(super) fault: Fault,
}
impl Disk {
    pub(super) fn open(root: &Path) -> Result<Self> {
        if !root.is_absolute()
            || root.components().any(|p| {
                matches!(
                    p,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
            || fs::canonicalize(root).map_err(|e| io("canonical root", e))? != root
        {
            return Err(Error::Ownership);
        }
        let mut protected = Vec::new();
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            protected.extend([
                home.join(".milagre"),
                home.join("Library/Application Support/Milagre"),
                home.join(".config/Milagre"),
            ]);
        }
        if let Some(custom) = std::env::var_os("MILAGRE_DATA_DIR") {
            protected.push(PathBuf::from(custom));
        }
        if protected.into_iter().any(|path| {
            let path = fs::canonicalize(&path).unwrap_or(path);
            root.starts_with(&path) || path.starts_with(root)
        }) {
            return Err(Error::Ownership);
        }
        let directory_root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(root)
            .map_err(|e| io("open root", e))?;
        let root_identity = safe(&directory_root, true)?;
        let manifest_file = open_at(&directory_root, MANIFEST, libc::O_RDONLY, 0)?;
        let manifest_bytes = bytes(&manifest_file, 32 * 1024)?;
        let manifest: Value = serde_json::from_slice(&manifest_bytes)
            .map_err(|e| Error::Invalid(format!("Invalid dedicated root manifest: {e}")))?;
        if manifest["schema"] != 1
            || manifest["kind"] != "milagre-rust-chat"
            || manifest["root"].as_str() != root.to_str()
            || !manifest["fixture"].is_boolean()
        {
            return Err(Error::Ownership);
        }
        let directory = make_directory(&directory_root)?;
        flock(&directory, libc::LOCK_EX | libc::LOCK_NB)?;
        let lock = open_at(&directory, LOCK, libc::O_RDWR | libc::O_CREAT, 0o600)?;
        safe(&lock, false)?;
        flock(&lock, libc::LOCK_EX | libc::LOCK_NB)?;
        let saved = match open_at(&directory, FILE, libc::O_RDONLY, 0) {
            Ok(file) => {
                let image = bytes(&file, limits::BYTES)?;
                Some(Saved { file, bytes: image })
            }
            Err(error) if missing(&error) => None,
            Err(error) => return Err(error),
        };
        let disk = Self {
            path: root.join(DIRECTORY),
            root_path: root.to_owned(),
            root: directory_root,
            root_identity,
            manifest: Saved {
                file: manifest_file,
                bytes: manifest_bytes,
            },
            directory,
            lock,
            saved,
            stage: None,
            intent: None,
            uncertain: false,
            closed: false,
            #[cfg(test)]
            fault: Fault::None,
        };
        disk.verify()?;
        Ok(disk)
    }
    pub(super) fn saved_text(&self) -> Result<Option<String>> {
        self.saved
            .as_ref()
            .map(|saved| {
                String::from_utf8(saved.bytes.clone())
                    .map_err(|_| Error::Invalid("Routine file is not UTF-8 JSON".into()))
            })
            .transpose()
    }
    fn verify_base(&self) -> Result<()> {
        if self.closed {
            return Err(Error::Closed);
        }
        let actual = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open(&self.root_path)
            .map_err(|e| io("verify root", e))?;
        if safe(&actual, true)? != self.root_identity
            || safe(&self.root, true)? != self.root_identity
            || fs::canonicalize(&self.root_path).map_err(|e| io("verify canonical root", e))?
                != self.root_path
        {
            return Err(Error::Ownership);
        }
        same_at(&self.root, MANIFEST, &self.manifest.file, false)?;
        if bytes(&self.manifest.file, 32 * 1024)? != self.manifest.bytes {
            return Err(Error::Ownership);
        }
        same_at(&self.root, DIRECTORY, &self.directory, true)?;
        same_at(&self.directory, LOCK, &self.lock, false)?;
        Ok(())
    }
    pub(super) fn verify(&self) -> Result<()> {
        self.verify_base()?;
        match &self.saved {
            Some(saved) => {
                same_at(&self.directory, FILE, &saved.file, false)?;
                if bytes(&saved.file, limits::BYTES)? != saved.bytes {
                    return Err(Error::Ownership);
                }
            }
            None => {
                if !absent(&self.directory, FILE)? {
                    return Err(Error::Ownership);
                }
            }
        }
        Ok(())
    }
    fn cleanup_stage(&mut self, fail: bool) -> Result<()> {
        if fail {
            return Err(io(
                "staging cleanup",
                std::io::Error::from_raw_os_error(libc::EIO),
            ));
        }
        if let Some(stage) = &self.stage {
            same_at(&self.directory, &stage.name, &stage.saved.file, false)?;
            let name = CString::new(stage.name.as_str()).map_err(|_| Error::Ownership)?;
            if unsafe { libc::unlinkat(self.directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                return Err(io("unlink staging", std::io::Error::last_os_error()));
            }
            // Unlink succeeded even if the following directory sync fails.
            // A close retry must not demand the now-absent staging inode again.
            self.stage.take();
            self.directory
                .sync_all()
                .map_err(|e| io("sync staging cleanup", e))?;
        }
        self.stage.take();
        Ok(())
    }
    pub(super) fn persist(&mut self, image: &[u8], owner: &OwnerCheck) -> Result<()> {
        self.verify()?;
        let name = format!("routines.json.{}.tmp", uuid::Uuid::new_v4());
        self.intent = Some(name.clone());
        let file = match open_at(
            &self.directory,
            &name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        ) {
            Ok(file) => file,
            Err(error) => {
                if absent(&self.directory, &name).is_ok_and(|absent| absent) {
                    self.intent.take();
                } else {
                    self.uncertain = true;
                }
                return Err(error);
            }
        };
        self.stage = Some(Stage {
            name,
            saved: Saved {
                file,
                bytes: image.to_vec(),
            },
        });
        self.intent.take();
        #[cfg(test)]
        let fault = std::mem::replace(&mut self.fault, Fault::None);
        let result = (|| {
            safe(
                &self.stage.as_ref().ok_or(Error::Ownership)?.saved.file,
                false,
            )?;
            #[cfg(test)]
            if fault == Fault::BeforeWrite {
                return Err(io(
                    "write staging",
                    std::io::Error::from_raw_os_error(libc::EIO),
                ));
            }
            let stage = self.stage.as_mut().ok_or(Error::Ownership)?;
            stage
                .saved
                .file
                .write_all(image)
                .map_err(|e| io("write staging", e))?;
            stage
                .saved
                .file
                .sync_all()
                .map_err(|e| io("sync staging", e))?;
            #[cfg(test)]
            if matches!(fault, Fault::BeforeRename | Fault::BeforeRenameAndCleanup) {
                return Err(io(
                    "before rename",
                    std::io::Error::from_raw_os_error(libc::EIO),
                ));
            }
            self.verify()?;
            check_owner(owner)?;
            let stage = self.stage.as_ref().ok_or(Error::Ownership)?;
            same_at(&self.directory, &stage.name, &stage.saved.file, false)?;
            let from = CString::new(stage.name.as_str()).map_err(|_| Error::Ownership)?;
            let to = CString::new(FILE).unwrap();
            // Once rename is attempted, errors never imply the old file won.
            self.uncertain = true;
            if unsafe {
                libc::renameat(
                    self.directory.as_raw_fd(),
                    from.as_ptr(),
                    self.directory.as_raw_fd(),
                    to.as_ptr(),
                )
            } != 0
            {
                return Err(io("rename staging", std::io::Error::last_os_error()));
            }
            let stage = self.stage.take().ok_or(Error::Ownership)?;
            self.saved = Some(stage.saved);
            #[cfg(test)]
            if fault == Fault::AfterRename {
                return Err(io(
                    "after rename",
                    std::io::Error::from_raw_os_error(libc::EIO),
                ));
            }
            self.directory
                .sync_all()
                .map_err(|e| io("sync routine directory", e))?;
            self.verify()?;
            check_owner(owner)?;
            self.uncertain = false;
            Ok(())
        })();
        match result {
            Ok(()) => Ok(()),
            Err(error) if self.uncertain => Err(error),
            Err(error) => {
                #[cfg(test)]
                let fail = fault == Fault::BeforeRenameAndCleanup;
                #[cfg(not(test))]
                let fail = false;
                match self.cleanup_stage(fail).and_then(|()| self.verify()) {
                    Ok(()) => Err(error),
                    Err(cleanup) => {
                        self.uncertain = true;
                        Err(Error::Invalid(format!(
                            "{error}; cleanup failed: {cleanup}"
                        )))
                    }
                }
            }
        }
    }
    pub(super) fn close(&mut self) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        self.verify()?;
        if let Some(intent) = &self.intent {
            if !absent(&self.directory, intent)? {
                return Err(Error::Ownership);
            }
            self.intent.take();
        }
        self.cleanup_stage(false)?;
        self.directory.sync_all().map_err(|e| io("sync close", e))?;
        self.verify()?;
        flock(&self.lock, libc::LOCK_UN)?;
        flock(&self.directory, libc::LOCK_UN)?;
        self.closed = true;
        Ok(())
    }
}
