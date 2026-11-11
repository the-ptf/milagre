//! Fresh synthetic descriptor capability only. No existing path/FD import API.
//! macOS prototype; no production profile or supervisor integration.
pub(crate) mod hydration;
pub(crate) mod snapshot;
use crate::budget::{GlobalBudget, Reservation};
use rand_core::{CryptoRng, RngCore};
use rustix::{
    fs::{self, AtFlags, FileType, FlockOperation, Mode, OFlags},
    process,
};
pub(crate) use snapshot::Snapshot;
use std::{
    fs::File,
    io::{Read, Write},
    sync::{Arc, Mutex},
};
const MARKER: &str = "marker.json";
const LOCK: &str = "writer.lock";
const SNAPSHOT: &str = "authority.json";
const TXN: &str = "transaction";
const DIR_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
const FILE_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoStage {
    Create,
    OpenRoot,
    LockRoot,
    LockFile,
    Validate,
    ReadSnapshot,
    WriteTransaction,
    SyncFile,
    Rename,
    SyncDirectory,
    Unlink,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum StoreFault {
    #[error("writer busy")]
    Busy,
    #[error("unsupported platform")]
    Unsupported,
    #[error("wrong process")]
    WrongProcess,
    #[error("capability identity changed")]
    IdentityChanged,
    #[error("invalid private-file permissions")]
    Permission,
    #[error("invalid store limits")]
    InvalidLimits,
    #[error("invalid snapshot schema")]
    InvalidSchema,
    #[error("store bound exceeded")]
    TooLarge,
    #[error("generation exhausted")]
    Exhausted,
    #[error("unclean or unacknowledged run")]
    DirtyRun,
    #[error("unexpected directory entry")]
    UnexpectedEntry,
    #[error("store IO failure at {stage:?}: {kind:?}")]
    Io {
        stage: IoStage,
        kind: std::io::ErrorKind,
    },
}
fn io(stage: IoStage, e: impl Into<std::io::Error>) -> StoreFault {
    StoreFault::Io {
        stage,
        kind: e.into().kind(),
    }
}
pub type Result<T> = std::result::Result<T, StoreFault>;
#[derive(Clone, Copy)]
pub struct StoreLimits {
    pub snapshot_bytes: usize,
    pub history_slots: usize,
    pub parsed_bytes: usize,
    pub working_bytes: usize,
}
impl Default for StoreLimits {
    fn default() -> Self {
        Self {
            snapshot_bytes: 2 * 1024 * 1024,
            history_slots: 4096,
            parsed_bytes: 3 * 1024 * 1024,
            working_bytes: 12 * 1024 * 1024,
        }
    }
}
impl StoreLimits {
    fn valid(self) -> bool {
        self.snapshot_bytes >= 1024
            && self.snapshot_bytes <= 2 * 1024 * 1024
            && self.history_slots > 0
            && self.history_slots <= 4096
            && self.parsed_bytes >= 640
            && self.parsed_bytes <= 3 * 1024 * 1024
            && self.working_bytes >= self.snapshot_bytes * 2 + self.parsed_bytes * 2 + 64 * 1024
            && self.working_bytes <= 12 * 1024 * 1024
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Identity {
    dev: u64,
    ino: u64,
}
impl Identity {
    fn of(s: &fs::Stat) -> Self {
        Self {
            dev: s.st_dev as u64,
            ino: s.st_ino,
        }
    }
}
fn check(s: &fs::Stat, dir: bool) -> Result<()> {
    let expected = if dir {
        FileType::Directory
    } else {
        FileType::RegularFile
    };
    if FileType::from_raw_mode(s.st_mode) != expected {
        return Err(StoreFault::IdentityChanged);
    }
    if s.st_uid != process::geteuid().as_raw()
        || s.st_mode & 0o7777 != if dir { 0o700 } else { 0o600 }
        || (!dir && s.st_nlink != 1)
    {
        return Err(StoreFault::Permission);
    }
    Ok(())
}
fn stat(fd: &impl std::os::fd::AsFd) -> Result<fs::Stat> {
    fs::fstat(fd).map_err(|e| io(IoStage::Validate, e))
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
    revision: u64,
    boot: u64,
    retired: bool,
}
impl Stamp {
    fn of(s: &Snapshot) -> Self {
        Self {
            revision: s.revision,
            boot: s.boot,
            retired: s.retired,
        }
    }
}
struct Ledger {
    active: bool,
    attempt: u64,
    ack: Option<Stamp>,
    destroyed: bool,
    transaction: Option<Identity>,
}
struct Core {
    root: File,
    parent: File,
    name: String,
    id: [u8; 16],
    root_id: Identity,
    marker_id: Identity,
    lock_id: Identity,
    pid: u32,
    limits: StoreLimits,
    ledger: Mutex<Ledger>,
    global: GlobalBudget,
    _budget: Option<Reservation>,
}
impl Core {
    fn pid(&self) -> Result<()> {
        if self.pid != process::getpid().as_raw_nonzero().get() as u32 {
            Err(StoreFault::WrongProcess)
        } else {
            Ok(())
        }
    }
    fn ledger(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.ledger.lock().unwrap_or_else(|e| e.into_inner())
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        if self.pid != process::getpid().as_raw_nonzero().get() as u32 {
            // Do not release an inherited reservation through a possibly held mutex.
            std::mem::forget(self._budget.take());
        }
    }
}
// Only construction owns this rollback guard. It unlinks matching newly created
// inodes, never follows a changed name and never recursively removes a directory.
struct CreationGuard {
    parent: File,
    root: File,
    name: String,
    id: Identity,
    files: Vec<(&'static str, Identity)>,
    armed: bool,
}
impl Drop for CreationGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        for (name, id) in &self.files {
            if fs::statat(&self.root, *name, AtFlags::SYMLINK_NOFOLLOW)
                .is_ok_and(|s| Identity::of(&s) == *id)
            {
                let _ = fs::unlinkat(&self.root, *name, AtFlags::empty());
            }
        }
        if fs::statat(&self.parent, &self.name, AtFlags::SYMLINK_NOFOLLOW)
            .is_ok_and(|s| Identity::of(&s) == self.id)
        {
            let _ = fs::unlinkat(&self.parent, &self.name, AtFlags::REMOVEDIR);
        }
    }
}
/// No constructor accepts existing data, filenames, descriptors, tokens or keys.
pub struct SyntheticProfile {
    core: Arc<Core>,
    cleanup: Option<Locks>,
    deleted: u8,
    directory_unlinked: bool,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StoreDiagnostics {
    pub profile_id: [u8; 16],
    pub fault: Option<StoreFault>,
    pub revision: Option<u64>,
    pub boot: Option<u64>,
    pub retired: bool,
}
pub struct Released;
pub struct Destroyed;
struct Locks {
    root: File,
    _file: File,
    pid: u32,
}
impl Locks {
    fn acquire(c: &Core) -> Result<Self> {
        c.pid()?;
        let root = File::from(
            fs::openat(&c.root, ".", DIR_FLAGS, Mode::empty())
                .map_err(|e| io(IoStage::OpenRoot, e))?,
        );
        let meta = stat(&root)?;
        check(&meta, true)?;
        if Identity::of(&meta) != c.root_id {
            return Err(StoreFault::IdentityChanged);
        }
        fs::flock(&root, FlockOperation::NonBlockingLockExclusive).map_err(|e| {
            if e == rustix::io::Errno::WOULDBLOCK {
                StoreFault::Busy
            } else {
                io(IoStage::LockRoot, e)
            }
        })?;
        Self::identities(c, &root)?;
        let file = File::from(
            fs::openat(
                &root,
                LOCK,
                OFlags::RDWR | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|e| io(IoStage::LockFile, e))?,
        );
        if Identity::of(&stat(&file)?) != c.lock_id {
            return Err(StoreFault::IdentityChanged);
        }
        fs::flock(&file, FlockOperation::NonBlockingLockExclusive).map_err(|e| {
            if e == rustix::io::Errno::WOULDBLOCK {
                StoreFault::Busy
            } else {
                io(IoStage::LockFile, e)
            }
        })?;
        Ok(Self {
            root,
            _file: file,
            pid: c.pid,
        })
    }
    fn identities(c: &Core, root: &File) -> Result<()> {
        c.pid()?;
        let meta = stat(root)?;
        check(&meta, true)?;
        if Identity::of(&meta) != c.root_id {
            return Err(StoreFault::IdentityChanged);
        }
        for (name, id) in [(MARKER, c.marker_id), (LOCK, c.lock_id)] {
            let m = fs::statat(root, name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|e| io(IoStage::Validate, e))?;
            check(&m, false)?;
            if Identity::of(&m) != id {
                return Err(StoreFault::IdentityChanged);
            }
        }
        Ok(())
    }
    fn validate(&self, c: &Core) -> Result<()> {
        if self.pid != process::getpid().as_raw_nonzero().get() as u32 {
            return Err(StoreFault::WrongProcess);
        }
        Self::identities(c, &self.root)?;
        if Identity::of(&stat(&self._file)?) != c.lock_id {
            return Err(StoreFault::IdentityChanged);
        }
        Ok(())
    }
}
// No explicit unlock: closing an inherited alias must not unlock its parent's flock.
pub(crate) struct CommitReceipt {
    stamp: Stamp,
    profile: [u8; 16],
    attempt: u64,
    running: bool,
}
/// Exclusive store operations cannot run concurrently through shared references.
/// ```compile_fail
/// use milagre_remote::synthetic_store::WriterLease;
/// fn share(w: std::sync::Arc<WriterLease>) { std::thread::spawn(move || w.diagnostics()); }
/// ```
pub struct WriterLease {
    _not_sync: std::marker::PhantomData<std::cell::Cell<()>>,
    core: Arc<Core>,
    locks: Option<Locks>,
    prior: Option<Stamp>,
    attempt: u64,
    finished: bool,
    poisoned: bool,
    #[cfg(test)]
    pub(crate) fail_next: Option<IoStage>,
    last: Option<Stamp>,
}
impl SyntheticProfile {
    pub fn create(limits: StoreLimits, rng: &mut (impl RngCore + CryptoRng)) -> Result<Self> {
        if !cfg!(target_os = "macos") {
            return Err(StoreFault::Unsupported);
        }
        if !limits.valid() {
            return Err(StoreFault::InvalidLimits);
        }
        let global = GlobalBudget::new(256 * 1024 * 1024).map_err(|_| StoreFault::TooLarge)?;
        let budget = global
            .connection(limits.working_bytes)
            .map_err(|_| StoreFault::TooLarge)?
            .reserve(limits.working_bytes)
            .map_err(|_| StoreFault::TooLarge)?;
        let mut id = [0; 16];
        rng.fill_bytes(&mut id);
        let parent = File::from(
            fs::open(
                std::env::temp_dir(),
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|e| io(IoStage::Create, e))?,
        );
        let name = format!("milagre-remote-store-{}", snapshot::hex(&id));
        fs::mkdirat(&parent, &name, Mode::from_raw_mode(0o700))
            .map_err(|e| io(IoStage::Create, e))?;
        let root = File::from(
            fs::openat(&parent, &name, DIR_FLAGS, Mode::empty())
                .map_err(|e| io(IoStage::OpenRoot, e))?,
        );
        let mut rollback = CreationGuard {
            parent: parent.try_clone().map_err(|e| io(IoStage::Create, e))?,
            root: root.try_clone().map_err(|e| io(IoStage::Create, e))?,
            name: name.clone(),
            id: Identity::of(&stat(&root)?),
            files: Vec::new(),
            armed: true,
        };
        let mut marker = new_file(&root, MARKER)?;
        rollback.files.push((MARKER, Identity::of(&stat(&marker)?)));
        marker
            .write_all(marker_bytes(id).as_bytes())
            .map_err(|e| io(IoStage::Create, e))?;
        marker.sync_all().map_err(|e| io(IoStage::SyncFile, e))?;
        let lock = new_file(&root, LOCK)?;
        rollback.files.push((LOCK, Identity::of(&stat(&lock)?)));
        lock.sync_all().map_err(|e| io(IoStage::SyncFile, e))?;
        let (mut secret, mut token) = ([0; 32], [0; 32]);
        rng.fill_bytes(&mut secret);
        rng.fill_bytes(&mut token);
        let snapshot = Snapshot {
            profile: id,
            revision: 1,
            identity: 1,
            boot: 0,
            policy: 0,
            retired: false,
            running: false,
            secret,
            token,
            devices: Vec::new(),
        };
        let mut initial = new_file(&root, SNAPSHOT)?;
        rollback
            .files
            .push((SNAPSHOT, Identity::of(&stat(&initial)?)));
        initial
            .write_all(&snapshot.encode(limits)?)
            .map_err(|e| io(IoStage::WriteTransaction, e))?;
        initial.sync_all().map_err(|e| io(IoStage::SyncFile, e))?;
        root.sync_all().map_err(|e| io(IoStage::SyncDirectory, e))?;
        parent
            .sync_all()
            .map_err(|e| io(IoStage::SyncDirectory, e))?;
        let core = Arc::new(Core {
            root_id: Identity::of(&stat(&root)?),
            marker_id: Identity::of(&stat(&marker)?),
            lock_id: Identity::of(&stat(&lock)?),
            root,
            parent,
            name,
            id,
            pid: process::getpid().as_raw_nonzero().get() as u32,
            limits,
            ledger: Mutex::new(Ledger {
                active: false,
                attempt: 0,
                ack: Some(Stamp::of(&snapshot)),
                destroyed: false,
                transaction: None,
            }),
            global,
            _budget: Some(budget),
        });
        // Refuse a filesystem which does not support the agreed root lock.
        drop(Locks::acquire(&core)?);
        rollback.armed = false;
        Ok(Self {
            core,
            cleanup: None,
            deleted: 0,
            directory_unlinked: false,
        })
    }
    pub fn acquire_writer(&mut self) -> Result<WriterLease> {
        self.core.pid()?;
        if self.cleanup.is_some() {
            return Err(StoreFault::DirtyRun);
        }
        let mut ledger = self.core.ledger();
        if ledger.destroyed {
            return Err(StoreFault::IdentityChanged);
        }
        if ledger.active {
            return Err(StoreFault::Busy);
        }
        let locks = Locks::acquire(&self.core)?;
        let attempt = ledger.attempt.checked_add(1).ok_or(StoreFault::Exhausted)?;
        ledger.attempt = attempt;
        ledger.active = true;
        let prior = ledger.ack.take();
        Ok(WriterLease {
            _not_sync: std::marker::PhantomData,
            core: self.core.clone(),
            locks: Some(locks),
            prior,
            attempt,
            finished: false,
            poisoned: false,
            #[cfg(test)]
            fail_next: None,
            last: prior,
        })
    }
    pub fn destroy(&mut self) -> Result<Destroyed> {
        self.destroy_at(None)
    }
    fn destroy_at(&mut self, fail_after: Option<usize>) -> Result<Destroyed> {
        self.core.pid()?;
        if self.core.ledger().active {
            return Err(StoreFault::Busy);
        }
        if self.core.ledger().destroyed {
            return Err(StoreFault::IdentityChanged);
        }
        if self.cleanup.is_none() {
            self.cleanup = Some(Locks::acquire(&self.core)?);
        }
        let locks = self.cleanup.as_ref().unwrap();
        let root_meta = stat(&locks.root)?;
        check(&root_meta, true)?;
        if Identity::of(&root_meta) != self.core.root_id {
            return Err(StoreFault::IdentityChanged);
        }
        if self.directory_unlinked {
            self.core
                .parent
                .sync_all()
                .map_err(|e| io(IoStage::SyncDirectory, e))?;
            self.core.ledger().destroyed = true;
            self.cleanup.take();
            return Ok(Destroyed);
        }
        let parent_entry = fs::statat(
            &self.core.parent,
            &self.core.name,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|e| io(IoStage::Validate, e))?;
        if Identity::of(&parent_entry) != self.core.root_id {
            return Err(StoreFault::IdentityChanged);
        }
        for (name, mask, id) in [
            (MARKER, 4, self.core.marker_id),
            (LOCK, 8, self.core.lock_id),
        ] {
            if self.deleted & mask == 0 {
                let m = fs::statat(&locks.root, name, AtFlags::SYMLINK_NOFOLLOW)
                    .map_err(|e| io(IoStage::Validate, e))?;
                check(&m, false)?;
                if Identity::of(&m) != id {
                    return Err(StoreFault::IdentityChanged);
                }
            }
        }
        let mut names = Vec::new();
        let mut dir = fs::Dir::read_from(&locks.root).map_err(|e| io(IoStage::Validate, e))?;
        while let Some(entry) = dir.read() {
            let entry = entry.map_err(|e| io(IoStage::Validate, e))?;
            let name = entry.file_name().to_bytes();
            if name == b"." || name == b".." {
                continue;
            }
            if names.len() >= 4 {
                return Err(StoreFault::UnexpectedEntry);
            }
            let known = match name {
                b"marker.json" => MARKER,
                b"writer.lock" => LOCK,
                b"authority.json" => SNAPSHOT,
                b"transaction" => TXN,
                _ => return Err(StoreFault::UnexpectedEntry),
            };
            let mask = match known {
                TXN => 1,
                SNAPSHOT => 2,
                MARKER => 4,
                _ => 8,
            };
            if self.deleted & mask != 0 {
                return Err(StoreFault::UnexpectedEntry);
            }
            let m = fs::statat(&locks.root, known, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|e| io(IoStage::Validate, e))?;
            check(&m, false)?;
            if known == TXN && Some(Identity::of(&m)) != self.core.ledger().transaction {
                return Err(StoreFault::UnexpectedEntry);
            }
            names.push(known);
        }
        // Validate everything before deleting anything; never follow paths or recurse.
        for (i, name) in [TXN, SNAPSHOT, MARKER, LOCK].into_iter().enumerate() {
            if names.contains(&name) {
                fs::unlinkat(&locks.root, name, AtFlags::empty())
                    .map_err(|e| io(IoStage::Unlink, e))?;
                self.deleted |= 1 << i;
                if fail_after == Some(i) {
                    return Err(StoreFault::Io {
                        stage: IoStage::Unlink,
                        kind: std::io::ErrorKind::Other,
                    });
                }
            }
        }
        locks
            .root
            .sync_all()
            .map_err(|e| io(IoStage::SyncDirectory, e))?;
        // Parent spelling must still name our inode; otherwise leave the renamed root.
        let m = fs::statat(
            &self.core.parent,
            &self.core.name,
            AtFlags::SYMLINK_NOFOLLOW,
        )
        .map_err(|e| io(IoStage::Validate, e))?;
        if Identity::of(&m) != self.core.root_id {
            return Err(StoreFault::IdentityChanged);
        }
        fs::unlinkat(&self.core.parent, &self.core.name, AtFlags::REMOVEDIR)
            .map_err(|e| io(IoStage::Unlink, e))?;
        self.directory_unlinked = true;
        self.core
            .parent
            .sync_all()
            .map_err(|e| io(IoStage::SyncDirectory, e))?;
        self.core.ledger().destroyed = true;
        self.cleanup.take();
        Ok(Destroyed)
    }
}
fn new_file(root: &File, name: &str) -> Result<File> {
    Ok(File::from(
        fs::openat(
            root,
            name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        )
        .map_err(|e| io(IoStage::Create, e))?,
    ))
}
fn marker_bytes(id: [u8; 16]) -> String {
    format!(
        "{{\"format\":\"milagre-rust-remote-synthetic\",\"version\":1,\"profile_id\":\"{}\"}}\n",
        snapshot::hex(&id)
    )
}
impl WriterLease {
    fn check(&self) -> Result<&Locks> {
        self.core.pid()?;
        let locks = self.locks.as_ref().ok_or(StoreFault::DirtyRun)?;
        locks.validate(&self.core)?;
        Ok(locks)
    }
    pub fn diagnostics(&self) -> StoreDiagnostics {
        let mut d = StoreDiagnostics {
            profile_id: self.core.id,
            fault: None,
            revision: None,
            boot: None,
            retired: false,
        };
        match self.load() {
            Ok(s) => {
                d.revision = Some(s.revision);
                d.boot = Some(s.boot);
                d.retired = s.retired;
            }
            Err(e) => d.fault = Some(e),
        };
        d
    }
    pub fn release(self) -> Released {
        drop(self);
        Released
    }
    pub(crate) fn load(&self) -> Result<Snapshot> {
        let locks = self.check()?;
        let mut marker = File::from(
            fs::openat(&locks.root, MARKER, FILE_FLAGS, Mode::empty())
                .map_err(|e| io(IoStage::Validate, e))?,
        );
        if Identity::of(&stat(&marker)?) != self.core.marker_id {
            return Err(StoreFault::IdentityChanged);
        }
        let expected = marker_bytes(self.core.id);
        let mut bytes = vec![0; expected.len() + 1];
        let n = marker
            .read(&mut bytes)
            .map_err(|e| io(IoStage::Validate, e))?;
        if n != expected.len() || bytes[..n] != *expected.as_bytes() {
            return Err(StoreFault::IdentityChanged);
        }
        let mut dir = fs::Dir::read_from(&locks.root).map_err(|e| io(IoStage::Validate, e))?;
        while let Some(e) = dir.read() {
            let e = e.map_err(|e| io(IoStage::Validate, e))?;
            if ![
                b".".as_slice(),
                b"..",
                MARKER.as_bytes(),
                LOCK.as_bytes(),
                SNAPSHOT.as_bytes(),
            ]
            .contains(&e.file_name().to_bytes())
            {
                return Err(StoreFault::UnexpectedEntry);
            }
        }
        let mut file = File::from(
            fs::openat(&locks.root, SNAPSHOT, FILE_FLAGS, Mode::empty())
                .map_err(|e| io(IoStage::ReadSnapshot, e))?,
        );
        let m = stat(&file)?;
        check(&m, false)?;
        if m.st_size < 0 || m.st_size as u64 > self.core.limits.snapshot_bytes as u64 {
            return Err(StoreFault::TooLarge);
        }
        let size = m.st_size as usize;
        let mut bytes = Vec::new();
        bytes
            .try_reserve_exact(size)
            .map_err(|_| StoreFault::TooLarge)?;
        if bytes.capacity() > self.core.limits.snapshot_bytes {
            return Err(StoreFault::TooLarge);
        }
        bytes.resize(size, 0);
        file.read_exact(&mut bytes)
            .map_err(|e| io(IoStage::ReadSnapshot, e))?;
        let mut extra = [0];
        if file
            .read(&mut extra)
            .map_err(|e| io(IoStage::ReadSnapshot, e))?
            != 0
        {
            return Err(StoreFault::TooLarge);
        }
        let snapshot = Snapshot::decode(&bytes, self.core.limits)?;
        if snapshot.profile != self.core.id {
            return Err(StoreFault::IdentityChanged);
        }
        if snapshot.running || self.prior != Some(Stamp::of(&snapshot)) {
            return Err(StoreFault::DirtyRun);
        }
        Ok(snapshot)
    }
    pub(crate) fn global(&self) -> GlobalBudget {
        self.core.global.clone()
    }
    pub(crate) fn limits(&self) -> StoreLimits {
        self.core.limits
    }
    pub(crate) fn commit(&mut self, snapshot: &Snapshot) -> Result<CommitReceipt> {
        #[cfg(test)]
        let fail = self.fail_next.take();
        #[cfg(not(test))]
        let fail = None;
        self.commit_at(snapshot, fail)
    }
    fn commit_at(&mut self, snapshot: &Snapshot, fail: Option<IoStage>) -> Result<CommitReceipt> {
        if self.poisoned {
            return Err(StoreFault::DirtyRun);
        }
        let result = self.write_snapshot(snapshot, fail);
        match result {
            Ok(()) => {
                self.last = Some(Stamp::of(snapshot));
                Ok(CommitReceipt {
                    stamp: Stamp::of(snapshot),
                    profile: self.core.id,
                    attempt: self.attempt,
                    running: snapshot.running,
                })
            }
            Err(e) => {
                self.poisoned = true;
                Err(e)
            }
        }
    }
    fn write_snapshot(&self, snapshot: &Snapshot, fail: Option<IoStage>) -> Result<()> {
        let previous = self.last.ok_or(StoreFault::DirtyRun)?;
        if snapshot.revision
            != previous
                .revision
                .checked_add(1)
                .ok_or(StoreFault::Exhausted)?
        {
            return Err(StoreFault::InvalidSchema);
        }
        let locks = self.check()?;
        if snapshot.profile != self.core.id {
            return Err(StoreFault::IdentityChanged);
        }
        let bytes = snapshot.encode(self.core.limits)?;
        let stop = |stage| {
            if fail == Some(stage) {
                Err(StoreFault::Io {
                    stage,
                    kind: std::io::ErrorKind::Other,
                })
            } else {
                Ok(())
            }
        };
        let mut transaction = new_file(&locks.root, TXN)?;
        self.core.ledger().transaction = Some(Identity::of(&stat(&transaction)?));
        stop(IoStage::WriteTransaction)?;
        transaction
            .write_all(&bytes)
            .map_err(|e| io(IoStage::WriteTransaction, e))?;
        stop(IoStage::SyncFile)?;
        transaction
            .sync_all()
            .map_err(|e| io(IoStage::SyncFile, e))?;
        self.check()?;
        stop(IoStage::Rename)?;
        fs::renameat(&locks.root, TXN, &locks.root, SNAPSHOT)
            .map_err(|e| io(IoStage::Rename, e))?;
        self.core.ledger().transaction = None;
        stop(IoStage::SyncDirectory)?;
        locks
            .root
            .sync_all()
            .map_err(|e| io(IoStage::SyncDirectory, e))?;
        Ok(())
    }
    pub(crate) fn acknowledge(
        mut self,
        receipt: CommitReceipt,
    ) -> std::result::Result<(), (StoreFault, Self)> {
        let result = (|| {
            self.check()?;
            if self.poisoned
                || receipt.running
                || receipt.profile != self.core.id
                || receipt.attempt != self.attempt
                || self.last != Some(receipt.stamp)
            {
                return Err(StoreFault::DirtyRun);
            }
            if self.core.ledger().attempt != self.attempt {
                return Err(StoreFault::DirtyRun);
            }
            Ok(())
        })();
        if let Err(e) = result {
            self.poisoned = true;
            return Err((e, self));
        }
        self.locks.take();
        let mut ledger = self.core.ledger();
        ledger.ack = Some(receipt.stamp);
        ledger.active = false;
        self.finished = true;
        Ok(())
    }
}
impl Drop for WriterLease {
    fn drop(&mut self) {
        // Wrong-PID drop never enters inherited Rust locks and never explicitly unlocks.
        if self.core.pid().is_ok() && !self.finished {
            let mut ledger = self.core.ledger();
            ledger.active = false;
            ledger.ack = None;
        }
        self.locks.take();
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests;

// macOS spawn may briefly inherit another test thread's CLOEXEC descriptions
// before exec closes them. Serialize disk/subprocess scenarios, never retry a
// lock assertion or weaken the production nonblocking Busy response.
#[cfg(all(test, target_os = "macos"))]
pub(crate) fn testing_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}
