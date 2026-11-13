use super::Error;
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::{
        fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        io::{AsRawFd, FromRawFd},
    },
    path::{Path, PathBuf},
    time::Instant,
};

pub(super) const ARTIFACT_LIMIT: u64 = 64 * 1024 * 1024;
const COPY_CHUNK: usize = 32 * 1024;
const BINARY: &str = "native-acp-copy-fixture";

#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
    links: u64,
    len: u64,
    modified: (i64, i64),
    changed: (i64, i64),
}
impl Identity {
    fn of(meta: &fs::Metadata) -> Self {
        Self {
            dev: meta.dev(),
            ino: meta.ino(),
            uid: meta.uid(),
            mode: meta.mode(),
            links: meta.nlink(),
            len: meta.len(),
            modified: (meta.mtime(), meta.mtime_nsec()),
            changed: (meta.ctime(), meta.ctime_nsec()),
        }
    }
    fn directory_eq(self, other: Self) -> bool {
        self.dev == other.dev && self.ino == other.ino && self.uid == other.uid && self.mode == other.mode
    }
}
pub(super) struct Pin {
    pub(super) file: File,
    pub(super) path: PathBuf,
    identity: Identity,
    directory: bool,
}
impl Pin {
    fn open(path: PathBuf, directory: bool) -> Result<Self, Error> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | if directory { libc::O_DIRECTORY } else { 0 })
            .open(&path)
            .map_err(|_| Error::Identity)?;
        Self::from(file, path, directory)
    }
    fn from(file: File, path: PathBuf, directory: bool) -> Result<Self, Error> {
        let meta = file.metadata().map_err(|_| Error::Identity)?;
        if meta.uid() != unsafe { libc::geteuid() }
            || (if directory { !meta.is_dir() } else { !meta.is_file() || meta.nlink() != 1 })
            || meta.mode() & 0o022 != 0
        {
            return Err(Error::Identity);
        }
        let pin = Self { file, path, identity: Identity::of(&meta), directory };
        pin.check()?;
        Ok(pin)
    }
    pub(super) fn check(&self) -> Result<(), Error> {
        let fd = Identity::of(&self.file.metadata().map_err(|_| Error::Identity)?);
        let meta = fs::symlink_metadata(&self.path).map_err(|_| Error::Identity)?;
        if meta.file_type().is_symlink() {
            return Err(Error::Identity);
        }
        let path = Identity::of(&meta);
        let same = |id| if self.directory { self.identity.directory_eq(id) } else { self.identity == id };
        if !same(fd) || !same(path) {
            return Err(Error::Identity);
        }
        Ok(())
    }
    pub(super) fn dev_ino(&self) -> (u64, u64) {
        (self.identity.dev, self.identity.ino)
    }
}

/// Descriptor-only input from the private coordinator. Never owns directory deletion.
pub(super) struct Workspace {
    pub(super) project: Pin,
    home: Pin,
    tmp: Pin,
    parent: Pin,
}
impl Workspace {
    #[cfg(test)]
    pub(super) fn descriptors(&self) -> [i32; 4] {
        [&self.project, &self.home, &self.tmp, &self.parent].map(|pin| pin.file.as_raw_fd())
    }
    pub(super) fn from_descriptors(project: File, home: File, tmp: File) -> Result<Self, Error> {
        fn directory(file: File) -> Result<Pin, Error> {
            let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            if flags < 0 || flags & libc::FD_CLOEXEC == 0 {
                return Err(Error::Identity);
            }
            let mut path = [0i8; libc::PATH_MAX as usize];
            if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, path.as_mut_ptr()) } < 0 {
                return Err(Error::Identity);
            }
            let path = unsafe { std::ffi::CStr::from_ptr(path.as_ptr()) };
            use std::os::unix::ffi::OsStrExt;
            Pin::from(file, PathBuf::from(std::ffi::OsStr::from_bytes(path.to_bytes())), true)
        }
        let project = directory(project)?;
        let root = project.path.parent().ok_or(Error::Identity)?.to_owned();
        let workspace = Self { project, home: directory(home)?, tmp: directory(tmp)?, parent: Pin::open(root.clone(), true)? };
        if workspace.project.path.file_name().is_none_or(|name| name != "project")
            || workspace.home.path != root.join("home")
            || workspace.tmp.path != root.join("tmp")
        {
            return Err(Error::Identity);
        }
        workspace.check()?;
        Ok(workspace)
    }
    fn check(&self) -> Result<(), Error> {
        for pin in [&self.parent, &self.project, &self.home, &self.tmp] {
            if fs::canonicalize(&pin.path).map_err(|_| Error::Identity)? != pin.path {
                return Err(Error::Identity);
            }
            pin.check()?;
        }
        Ok(())
    }
}
fn child_file(parent: &File, name: &str, flags: i32, mode: libc::mode_t) -> Result<File, Error> {
    let name = CString::new(name).map_err(|_| Error::Identity)?;
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags | libc::O_NOFOLLOW | libc::O_CLOEXEC, mode as libc::c_uint) };
    if fd < 0 {
        return Err(Error::Identity);
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn mkdir(parent: &File, name: &str) -> Result<(), Error> {
    let name = CString::new(name).map_err(|_| Error::Identity)?;
    if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
        return Err(Error::Identity);
    }
    Ok(())
}
fn remove(parent: &File, name: &str, directory: bool) -> bool {
    let Ok(name) = CString::new(name) else { return false };
    unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), if directory { libc::AT_REMOVEDIR } else { 0 }) == 0 }
}
fn hash(file: &mut File, until: Instant) -> Result<[u8; 32], Error> {
    file.seek(SeekFrom::Start(0)).map_err(|_| Error::Artifact)?;
    let mut total = 0u64;
    let mut hash = Sha256::new();
    let mut chunk = [0; COPY_CHUNK];
    loop {
        if Instant::now() >= until {
            return Err(Error::Deadline);
        }
        let count = file.read(&mut chunk).map_err(|_| Error::Artifact)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > ARTIFACT_LIMIT {
            return Err(Error::Artifact);
        }
        hash.update(&chunk[..count]);
    }
    Ok(hash.finalize().into())
}

// Owns a newly created executable during copy errors. Never unlink a replacement.
struct Draft {
    file: File,
    parent: File,
    committed: bool,
}
impl Draft {
    fn new(parent: &File) -> Result<Self, Error> {
        let retained = parent.try_clone().map_err(|_| Error::Identity)?;
        let file = child_file(parent, BINARY, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL, 0o600)?;
        Ok(Self { file, parent: retained, committed: false })
    }
}
impl Drop for Draft {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let Ok(current) = child_file(&self.parent, BINARY, libc::O_RDONLY, 0) else { return };
        if let (Ok(owned), Ok(path)) = (self.file.metadata(), current.metadata()) {
            if owned.dev() == path.dev() && owned.ino() == path.ino() {
                let _ = remove(&self.parent, BINARY, false);
            }
        }
    }
}

/// Never recursively deletes. Unknown/replaced entries cause retention, not traversal.
pub(super) struct Storage {
    parent: File,
    pub(super) root: Pin,
    entries: Vec<Pin>,
    removed: bool,
}
impl Storage {
    fn create() -> Result<Self, Error> {
        let parent_path = fs::canonicalize("/tmp").map_err(|_| Error::Identity)?;
        let parent = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_CLOEXEC)
            .open(&parent_path)
            .map_err(|_| Error::Identity)?;
        let root =
            tempfile::Builder::new().prefix("milagre-acp-private-copy-").tempdir_in(&parent_path).map_err(|_| Error::Identity)?.keep();
        let pinned = fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| Error::Identity)
            .and_then(|()| Pin::open(root.clone(), true));
        match pinned {
            Ok(root) => Ok(Self { parent, root, entries: Vec::new(), removed: false }),
            Err(_) => {
                // Creation succeeded but its identity cannot be proved. Retain even
                // this pre-Pin ownership record; the caller must also retain capacity.
                std::mem::forget((parent, root));
                Err(Error::CleanupUncertain)
            }
        }
    }
    fn directory(&mut self, name: &str) -> Result<usize, Error> {
        mkdir(&self.root.file, name)?;
        let pin = Pin::from(child_file(&self.root.file, name, libc::O_RDONLY | libc::O_DIRECTORY, 0)?, self.root.path.join(name), true)?;
        self.entries.push(pin);
        Ok(self.entries.len() - 1)
    }
    pub(super) fn check(&self) -> Result<(), Error> {
        self.root.check()?;
        for entry in &self.entries {
            entry.check()?;
        }
        Ok(())
    }
    pub(super) fn cleanup(&mut self) -> bool {
        if self.removed {
            return true;
        }
        if self.check().is_err() {
            return false;
        }
        // Held descriptors plus checked exact names; no recursion or symlink traversal.
        for entry in self.entries.iter().rev() {
            let Some(name) = entry.path.file_name().and_then(|v| v.to_str()) else { return false };
            if !remove(&self.root.file, name, entry.directory) {
                return false;
            }
        }
        self.entries.clear();
        let Some(name) = self.root.path.file_name().and_then(|v| v.to_str()) else { return false };
        if !remove(&self.parent, name, true) {
            return false;
        }
        self.removed = true;
        true
    }
}
impl Drop for Storage {
    fn drop(&mut self) {
        if !self.removed {
            let _ = self.cleanup();
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CopyStage {
    Chunk,
    WritableClosed,
    Closed,
}
pub(super) struct Prepared {
    source_parent: Pin,
    source: Pin,
    pub(super) storage: Storage,
    executable: usize,
    workspace: usize,
    digest: [u8; 32],
    registered: Option<super::RegisteredWorkspace>,
}
impl Prepared {
    pub(super) fn fixed() -> Result<Self, Error> {
        let exe = std::env::current_exe().map_err(|_| Error::Artifact)?;
        let parent = exe.parent().ok_or(Error::Artifact)?;
        Self::from_parent(fs::canonicalize(parent).map_err(|_| Error::Identity)?)
    }
    fn from_parent(parent: PathBuf) -> Result<Self, Error> {
        let source_parent = Pin::open(parent, true)?;
        let source = Pin::from(child_file(&source_parent.file, BINARY, libc::O_RDONLY, 0)?, source_parent.path.join(BINARY), false)?;
        if source.identity.len == 0 || source.identity.len > ARTIFACT_LIMIT || source.identity.mode & 0o100 == 0 {
            return Err(Error::Artifact);
        }
        Ok(Self { source_parent, source, storage: Storage::create()?, executable: 0, workspace: 0, digest: [0; 32], registered: None })
    }
    pub(super) fn register(&mut self, workspace: Option<super::RegisteredWorkspace>) {
        self.registered = workspace;
    }
    pub(super) fn take_registered(&mut self) -> Option<super::RegisteredWorkspace> {
        self.registered.take()
    }
    pub(super) fn is_registered(&self) -> bool {
        self.registered.is_some()
    }
    pub(super) fn populate(&mut self, until: Instant) -> Result<(), Error> {
        self.populate_with(until, |_, _| {})
    }
    #[cfg(test)]
    pub(super) fn fail_partial_preparation(&mut self, until: Instant) -> Result<(), Error> {
        self.populate_with(until, |pins, stage| {
            if stage != CopyStage::WritableClosed {
                return;
            }
            let root = &pins.storage.root.path;
            fs::rename(root.join(BINARY), root.join("held-original")).unwrap();
            fs::write(root.join(BINARY), b"replacement").unwrap();
            fs::set_permissions(root.join(BINARY), fs::Permissions::from_mode(0o500)).unwrap();
            let entries: Vec<_> = [BINARY, "held-original"]
                .iter()
                .map(|name| {
                    let meta = fs::symlink_metadata(root.join(name)).unwrap();
                    serde_json::json!({ "name": name, "device": meta.dev(), "inode": meta.ino(), "mode": meta.mode() })
                })
                .collect();
            let meta = pins.storage.root.file.metadata().unwrap();
            // This isolated test process intentionally retains ownership through exit.
            // Its trusted parent checker may remove only these exact identities afterward.
            println!(
                "PRIVATE_COPY_RETAINED_MANIFEST {}",
                serde_json::json!({
                    "root": root, "device": meta.dev(), "inode": meta.ino(), "entries": entries
                })
            );
        })
    }
    fn populate_with(&mut self, until: Instant, mut copied: impl FnMut(&mut Self, CopyStage)) -> Result<(), Error> {
        let prepared = self;
        if let Some(workspace) = &prepared.registered {
            workspace.0.check()?;
        } else {
            prepared.workspace = prepared.storage.directory("workspace")?;
            prepared.storage.directory("home")?;
            prepared.storage.directory("tmp")?;
        }
        prepared.digest = hash(&mut prepared.source.file, until)?;
        prepared.source.file.seek(SeekFrom::Start(0)).map_err(|_| Error::Artifact)?;
        let mut draft = Draft::new(&prepared.storage.root.file)?;
        let writer = &mut draft.file;
        let mut total = 0u64;
        let mut chunk = [0; COPY_CHUNK];
        let mut digest = Sha256::new();
        loop {
            if Instant::now() >= until {
                return Err(Error::Deadline);
            }
            let count = prepared.source.file.read(&mut chunk).map_err(|_| Error::Artifact)?;
            if count == 0 {
                break;
            }
            if total == 0 && (count < 4 || !matches!(&chunk[..4], [0xcf, 0xfa, 0xed, 0xfe] | [0xfe, 0xed, 0xfa, 0xcf])) {
                return Err(Error::Artifact);
            }
            total += count as u64;
            if total > ARTIFACT_LIMIT {
                return Err(Error::Artifact);
            }
            writer.write_all(&chunk[..count]).map_err(|_| Error::Artifact)?;
            digest.update(&chunk[..count]);
            copied(prepared, CopyStage::Chunk);
        }
        if total != prepared.source.identity.len || digest.finalize().as_slice() != prepared.digest {
            return Err(Error::Artifact);
        }
        writer.sync_all().map_err(|_| Error::Artifact)?;
        writer.set_permissions(fs::Permissions::from_mode(0o500)).map_err(|_| Error::Identity)?;
        let identity = Identity::of(&writer.metadata().map_err(|_| Error::Identity)?);
        draft.committed = true;
        drop(draft); // No writable executable descriptor survives preparation.
        copied(prepared, CopyStage::WritableClosed);
        let private =
            Pin::from(child_file(&prepared.storage.root.file, BINARY, libc::O_RDONLY, 0)?, prepared.storage.root.path.join(BINARY), false)?;
        if private.identity != identity {
            return Err(Error::Identity);
        }
        prepared.executable = prepared.storage.entries.len();
        prepared.storage.entries.push(private);
        copied(prepared, CopyStage::Closed);
        prepared.check(until)
    }
    #[cfg(test)]
    fn copy(parent: PathBuf, until: Instant, copied: impl FnMut(&mut Self, CopyStage)) -> Result<Self, Error> {
        let mut prepared = Self::from_parent(parent)?;
        if let Err(error) = prepared.populate_with(until, copied) {
            if !prepared.storage.cleanup() {
                std::mem::forget(prepared);
                return Err(Error::CleanupUncertain);
            }
            return Err(error);
        }
        Ok(prepared)
    }
    pub(super) fn check(&mut self, until: Instant) -> Result<(), Error> {
        if let Some(workspace) = &self.registered {
            workspace.0.check()?;
        }
        self.source_parent.check()?;
        self.source.check()?;
        self.storage.check()?;
        if hash(&mut self.source.file, until)? != self.digest
            || hash(&mut self.storage.entries[self.executable].file, until)? != self.digest
        {
            return Err(Error::Artifact);
        }
        self.source.check()?;
        self.source_parent.check()?;
        self.storage.check()?;
        if let Some(workspace) = &self.registered {
            workspace.0.check()?;
        }
        Ok(())
    }
    pub(super) fn executable(&self) -> &Path {
        &self.storage.entries[self.executable].path
    }
    pub(super) fn cwd(&self) -> &Pin {
        self.registered.as_ref().map_or_else(|| &self.storage.entries[self.workspace], |workspace| &workspace.0.project)
    }
    pub(super) fn home(&self) -> PathBuf {
        self.registered.as_ref().map_or_else(|| self.storage.root.path.join("home"), |w| w.0.home.path.clone())
    }
    pub(super) fn tmp(&self) -> PathBuf {
        self.registered.as_ref().map_or_else(|| self.storage.root.path.join("tmp"), |w| w.0.tmp.path.clone())
    }
    pub(super) fn digest(&self) -> String {
        self.digest.iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[cfg(test)]
#[path = "files/tests.rs"]
mod tests;
